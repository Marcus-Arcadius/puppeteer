import type {Poller} from '../injected/Poller.js';
import {createDeferredPromise} from '../util/DeferredPromise.js';
import {ElementHandle} from './ElementHandle.js';
import {TimeoutError} from './Errors.js';
import {IsolatedWorld} from './IsolatedWorld.js';
import {JSHandle} from './JSHandle.js';
import {HandleFor} from './types.js';

/**
 * @internal
 */
export interface WaitTaskOptions {
  bindings?: Set<(...args: never[]) => unknown>;
  polling: 'raf' | 'mutation' | number;
  root?: ElementHandle<Node>;
  timeout: number;
}

/**
 * @internal
 */
export class WaitTask<T = unknown> {
  #world: IsolatedWorld;
  #bindings: Set<(...args: never[]) => unknown>;
  #polling: 'raf' | 'mutation' | number;
  #root?: ElementHandle<Node>;

  #fn: string;
  #args: unknown[];

  #timeout?: NodeJS.Timeout;

  #result = createDeferredPromise<HandleFor<T>>();

  #poller?: JSHandle<Poller<T>>;

  constructor(
    world: IsolatedWorld,
    options: WaitTaskOptions,
    fn: ((...args: unknown[]) => Promise<T>) | string,
    ...args: unknown[]
  ) {
    this.#world = world;
    this.#bindings = options.bindings ?? new Set();
    this.#polling = options.polling;
    this.#root = options.root;

    switch (typeof fn) {
      case 'string':
        this.#fn = `() => {return (${fn});}`;
        break;
      default:
        this.#fn = fn.toString();
        break;
    }
    this.#args = args;

    this.#world.taskManager.add(this);

    if (options.timeout) {
      this.#timeout = setTimeout(() => {
        this.terminate(
          new TimeoutError(`Waiting failed: ${options.timeout}ms exceeded`)
        );
      }, options.timeout);
    }

    if (this.#bindings.size !== 0) {
      for (const fn of this.#bindings) {
        this.#world._boundFunctions.set(fn.name, fn);
      }
    }

    this.rerun();
  }

  get result(): Promise<HandleFor<T>> {
    return this.#result;
  }

  async rerun(): Promise<void> {
    try {
      if (this.#bindings.size !== 0) {
        const context = await this.#world.executionContext();
        await Promise.all(
          [...this.#bindings].map(async ({name}) => {
            return await this.#world._addBindingToContext(context, name);
          })
        );
      }

      switch (this.#polling) {
        case 'raf':
          this.#poller = await this.#world.evaluateHandle(
            ({RAFPoller, createFunction}, fn, ...args) => {
              const fun = createFunction(fn);
              return new RAFPoller(() => {
                return fun(...args) as Promise<T>;
              });
            },
            await this.#world.puppeteerUtil,
            this.#fn,
            ...this.#args
          );
          break;
        case 'mutation':
          this.#poller = await this.#world.evaluateHandle(
            ({MutationPoller, createFunction}, root, fn, ...args) => {
              const fun = createFunction(fn);
              return new MutationPoller(() => {
                return fun(...args) as Promise<T>;
              }, root || document);
            },
            await this.#world.puppeteerUtil,
            this.#root,
            this.#fn,
            ...this.#args
          );
          break;
        default:
          this.#poller = await this.#world.evaluateHandle(
            ({IntervalPoller, createFunction}, ms, fn, ...args) => {
              const fun = createFunction(fn);
              return new IntervalPoller(() => {
                return fun(...args) as Promise<T>;
              }, ms);
            },
            await this.#world.puppeteerUtil,
            this.#polling,
            this.#fn,
            ...this.#args
          );
          break;
      }

      await this.#poller.evaluate(poller => {
        poller.start();
      });

      const result = await this.#poller.evaluateHandle(poller => {
        return poller.result();
      });
      this.#result.resolve(result);

      await this.terminate();
    } catch (error) {
      const badError = this.getBadError(error);
      if (badError) {
        await this.terminate(badError);
      }
    }
  }

  async terminate(error?: unknown): Promise<void> {
    this.#world.taskManager.delete(this);

    if (this.#timeout) {
      clearTimeout(this.#timeout);
    }

    if (error && !this.#result.finished()) {
      this.#result.reject(error);
    }

    if (this.#poller) {
      try {
        await this.#poller.evaluateHandle(async poller => {
          await poller.stop();
        });
        if (this.#poller) {
          await this.#poller.dispose();
          this.#poller = undefined;
        }
      } catch {
        // Ignore errors since they most likely come from low-level cleanup.
      }
    }
  }

  /**
   * Not all errors lead to termination. They usually imply we need to rerun the task.
   */
  getBadError(error: unknown): unknown {
    if (error instanceof Error) {
      // When frame is detached the task should have been terminated by the IsolatedWorld.
      // This can fail if we were adding this task while the frame was detached,
      // so we terminate here instead.
      if (
        error.message.includes(
          'Execution context is not available in detached frame'
        )
      ) {
        return new Error('Waiting failed: Frame detached');
      }

      // When the page is navigated, the promise is rejected.
      // We will try again in the new execution context.
      if (error.message.includes('Execution context was destroyed')) {
        return;
      }

      // We could have tried to evaluate in a context which was already
      // destroyed.
      if (error.message.includes('Cannot find context with specified id')) {
        return;
      }
    }

    return error;
  }
}

/**
 * @internal
 */
export class TaskManager {
  #tasks: Set<WaitTask> = new Set<WaitTask>();

  add(task: WaitTask<any>): void {
    this.#tasks.add(task);
  }

  delete(task: WaitTask<any>): void {
    this.#tasks.delete(task);
  }

  terminateAll(error?: Error): void {
    for (const task of this.#tasks) {
      task.terminate(error);
    }
    this.#tasks.clear();
  }

  async rerunAll(): Promise<void> {
    await Promise.all(
      [...this.#tasks].map(task => {
        return task.rerun();
      })
    );
  }
}
