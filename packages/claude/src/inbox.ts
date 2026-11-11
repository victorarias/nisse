// The messages a Claude Code process is fed, as the async iterable the SDK reads its prompt from.
export class Inbox<T> implements AsyncIterable<T> {
  readonly #queued: T[] = []
  #waiting: ((result: IteratorResult<T>) => void) | undefined
  #closed = false

  push(item: T): void {
    if (this.#closed) return
    const waiting = this.#waiting
    if (waiting === undefined) return void this.#queued.push(item)
    this.#waiting = undefined
    waiting({ done: false, value: item })
  }

  close(): void {
    this.#closed = true
    const waiting = this.#waiting
    this.#waiting = undefined
    waiting?.({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#queued.shift()
        if (item !== undefined) return Promise.resolve({ done: false, value: item })
        if (this.#closed) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => (this.#waiting = resolve))
      },
    }
  }
}
