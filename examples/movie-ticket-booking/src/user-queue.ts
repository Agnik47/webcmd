export class PerUserQueue {
  readonly #tails = new Map<string, Promise<void>>();

  get size(): number {
    return this.#tails.size;
  }

  async run<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.#tails.set(userId, tail);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.#tails.get(userId) === tail) this.#tails.delete(userId);
    }
  }
}
