import { BrowserRunError } from './types.js';

export type BrowserRunNetworkEvent = 'request' | 'response';

export interface BrowserRunNetworkPage {
  on(event: BrowserRunNetworkEvent, listener: (value: unknown) => void): unknown;
  off(event: BrowserRunNetworkEvent, listener: (value: unknown) => void): unknown;
}

interface PendingWaiter {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface Subscription {
  page: BrowserRunNetworkPage;
  event: BrowserRunNetworkEvent;
  listener: (value: unknown) => void;
  queue: unknown[];
  waiters: PendingWaiter[];
  overflow?: BrowserRunError;
}

export class BrowserRunNetworkSubscriptions {
  readonly #subscriptions = new Map<number, Subscription>();
  #nextId = 1;
  #disposed = false;

  constructor(private readonly maxQueuedEvents = 256) {
    if (!Number.isSafeInteger(maxQueuedEvents) || maxQueuedEvents <= 0) {
      throw new TypeError('maxQueuedEvents must be a positive integer');
    }
  }

  start(page: BrowserRunNetworkPage, event: BrowserRunNetworkEvent): number {
    if (this.#disposed) throw this.#closedError();
    const id = this.#nextId++;
    const subscription: Subscription = {
      page,
      event,
      queue: [],
      waiters: [],
      listener: (value) => {
        const waiter = subscription.waiters.shift();
        if (waiter) waiter.resolve(value);
        else if (subscription.queue.length < this.maxQueuedEvents) {
          subscription.queue.push(value);
        } else {
          subscription.overflow = new BrowserRunError(
            'BROWSER_RUN_OUTPUT_LIMIT',
            `Browser-run network subscription exceeded ${this.maxQueuedEvents} queued events.`,
            'Use a narrower request/response predicate or remove long-lived event listeners.',
          );
          subscription.page.off(subscription.event, subscription.listener);
        }
      },
    };
    this.#subscriptions.set(id, subscription);
    page.on(event, subscription.listener);
    return id;
  }

  next(id: number): Promise<unknown> {
    const subscription = this.#subscriptions.get(id);
    if (!subscription) return Promise.reject(this.#closedError());
    if (subscription.overflow) return Promise.reject(subscription.overflow);
    if (subscription.queue.length > 0) {
      return Promise.resolve(subscription.queue.shift());
    }
    return new Promise((resolve, reject) => {
      subscription.waiters.push({ resolve, reject });
    });
  }

  stop(id: number): void {
    const subscription = this.#subscriptions.get(id);
    if (!subscription) return;
    this.#subscriptions.delete(id);
    subscription.page.off(subscription.event, subscription.listener);
    const error = this.#closedError();
    for (const waiter of subscription.waiters.splice(0)) waiter.reject(error);
    subscription.queue.length = 0;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const id of [...this.#subscriptions.keys()]) this.stop(id);
  }

  #closedError(): BrowserRunError {
    return new BrowserRunError(
      'BROWSER_RUN_CANCELLED',
      'The browser-run network subscription is closed.',
    );
  }
}
