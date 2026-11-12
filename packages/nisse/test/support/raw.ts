import * as Net from "node:net"

export interface Reply {
  readonly result?: any
  readonly error?: {
    readonly message: string
    readonly data: Array<{ _tag: string; error?: { _tag: string }; defect?: unknown }>
  }
}

export interface Watch<A> {
  readonly id: number
  readonly items: Array<A>
  readonly ended: Promise<Reply>
  readonly until: (predicate: (items: ReadonlyArray<A>) => boolean, ms?: number) => Promise<void>
}

const DEADLINE = 5000

export const deadline = <A>(promise: Promise<A>, ms: number, what: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms)),
  ])

export const errorTag = (reply: Reply) => reply.error?.data.find((failure) => failure._tag === "Fail")?.error?._tag

export class RawClient {
  private buffer = ""
  private nextId = 1
  private readonly pending = new Map<number, (reply: Reply) => void>()
  private readonly chunks = new Map<number, (values: Array<any>) => void>()

  private constructor(
    private readonly socket: Net.Socket,
    private ack: boolean,
  ) {
    socket.setEncoding("utf8")
    socket.on("data", (data: string) => {
      this.buffer += data
      let newline: number
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line) this.receive(JSON.parse(line))
      }
    })
  }

  static connect(path: string, options: { readonly ack?: boolean } = {}) {
    return new Promise<RawClient>((resolve, reject) => {
      const socket = Net.connect(path)
      socket.once("error", reject)
      socket.once("connect", () => resolve(new RawClient(socket, options.ack ?? true)))
    })
  }

  private receive(message: any) {
    if (message.chunk) {
      this.chunks.get(message.id)?.(message.result)
      if (this.ack) this.send({ jsonrpc: "2.0", method: "@effect/rpc/Ack", params: { requestId: message.id } })
      return
    }
    const resolve = this.pending.get(message.id)
    this.pending.delete(message.id)
    this.chunks.delete(message.id)
    resolve?.(message)
  }

  private send(message: unknown) {
    this.socket.write(JSON.stringify(message) + "\n")
  }

  call(method: string, params?: unknown): Promise<Reply> {
    const id = this.nextId++
    const reply = new Promise<Reply>((resolve) => this.pending.set(id, resolve))
    this.send({ jsonrpc: "2.0", id, method, params })
    return deadline(reply, DEADLINE, method)
  }

  watch<A>(method: string, params?: unknown): Watch<A> {
    const id = this.nextId++
    const items: Array<A> = []
    const waiters = new Set<() => void>()
    this.chunks.set(id, (values) => {
      items.push(...values)
      for (const waiter of waiters) waiter()
    })
    const ended = new Promise<Reply>((resolve) => this.pending.set(id, resolve))
    this.send({ jsonrpc: "2.0", id, method, params })
    const until = (predicate: (items: ReadonlyArray<A>) => boolean, ms = DEADLINE) =>
      deadline(
        new Promise<void>((resolve) => {
          const check = () => {
            if (!predicate(items)) return
            waiters.delete(check)
            resolve()
          }
          waiters.add(check)
          check()
        }),
        ms,
        `${method} condition`,
      )
    return { id, items, ended, until }
  }

  resumeAcks(requestId: number) {
    this.ack = true
    this.send({ jsonrpc: "2.0", method: "@effect/rpc/Ack", params: { requestId } })
  }

  close() {
    this.socket.destroy()
  }
}

/**
 * Connects, asks `requests` times for `method`, far more answer than the socket buffers, and hangs up on the first
 * bytes of the answer, so the server is still writing when the client goes. Resolves once the socket has closed.
 */
export const hangUpMidAnswer = async (path: string, method: string, params: unknown, requests = 8) => {
  const socket = Net.connect(path)
  await deadline(new Promise((resolve) => socket.once("connect", resolve)), DEADLINE, "connect")
  const lines = Array.from({ length: requests }, (_, i) =>
    JSON.stringify({ jsonrpc: "2.0", id: i + 1, method, params }),
  )
  socket.write(lines.join("\n") + "\n")
  await deadline(new Promise((resolve) => socket.once("data", resolve)), DEADLINE, `${method} answer`)
  const closed = new Promise((resolve) => socket.once("close", resolve))
  socket.destroy()
  await closed
}
