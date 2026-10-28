export class Inbox<A> implements AsyncIterable<A> {
  private readonly items: Array<A> = []
  private waiting: ((result: IteratorResult<A>) => void) | undefined
  private closed = false

  push(item: A) {
    if (this.closed) return
    const waiting = this.waiting
    this.waiting = undefined
    if (waiting) waiting({ value: item, done: false })
    else this.items.push(item)
  }

  close() {
    this.closed = true
    this.waiting?.({ value: undefined, done: true })
    this.waiting = undefined
  }

  [Symbol.asyncIterator](): AsyncIterator<A> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => (this.waiting = resolve))
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}
