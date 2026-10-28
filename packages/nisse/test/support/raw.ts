import type { Delivery } from "@nisse/protocol"
import * as Net from "node:net"

export interface Reply {
  readonly result?: any
  readonly error?: { readonly message: string; readonly data: Array<{ _tag: string; error?: { _tag: string } }> }
}

export interface Subscription {
  readonly id: number
  readonly deliveries: Array<Delivery>
  readonly ended: Promise<Reply>
  readonly until: (predicate: (deliveries: ReadonlyArray<Delivery>) => boolean, ms?: number) => Promise<void>
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
  private readonly chunks = new Map<number, (values: Array<Delivery>) => void>()

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

  subscribe(params: unknown): Subscription {
    const id = this.nextId++
    const deliveries: Array<Delivery> = []
    const waiters = new Set<() => void>()
    this.chunks.set(id, (values) => {
      deliveries.push(...values)
      for (const waiter of waiters) waiter()
    })
    const ended = new Promise<Reply>((resolve) => this.pending.set(id, resolve))
    this.send({ jsonrpc: "2.0", id, method: "conversation/subscribe", params })
    const until = (predicate: (deliveries: ReadonlyArray<Delivery>) => boolean, ms = DEADLINE) =>
      deadline(
        new Promise<void>((resolve) => {
          const check = () => {
            if (!predicate(deliveries)) return
            waiters.delete(check)
            resolve()
          }
          waiters.add(check)
          check()
        }),
        ms,
        "subscription condition",
      )
    return { id, deliveries, ended, until }
  }

  resumeAcks(requestId: number) {
    this.ack = true
    this.send({ jsonrpc: "2.0", method: "@effect/rpc/Ack", params: { requestId } })
  }

  close() {
    this.socket.destroy()
  }
}

export const entriesOf = (deliveries: ReadonlyArray<Delivery>) => deliveries.flatMap((delivery) => delivery.entries)

export const bodies = (deliveries: ReadonlyArray<Delivery>) => entriesOf(deliveries).map((entry) => entry.body)

export const statusOf = (deliveries: ReadonlyArray<Delivery>) =>
  deliveries.findLast((delivery) => delivery.status)?.status
