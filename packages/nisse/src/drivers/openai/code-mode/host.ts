import type { Subprocess } from "bun"

const MAX_FRAME = 64 * 1024 * 1024
const KEPT_STDERR = 4096

export interface Runtime {
  readonly state: "Yielded" | "Terminated" | "Result"
  readonly cell_id: string
  readonly content_items: ReadonlyArray<{ readonly type?: string; readonly text?: string }>
  readonly error_text?: string | null
}

export interface Delegated {
  readonly cellId: string
  readonly runtimeCallId: string
  readonly tool: string
  readonly input: unknown
  readonly answer: (result: { ok: unknown } | { error: string }) => void
}

type Route = (session: string) => ((call: Delegated) => void) | undefined

type Outcome = { status: "ok"; value: any } | { status: "error"; message: string }

interface Pending {
  readonly response: (outcome: Outcome) => void
  readonly initial?: (outcome: Outcome) => void
  readonly stopped: (error: Error) => void
}

const frame = (message: unknown) => {
  const payload = Buffer.from(JSON.stringify(message))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length)
  return Buffer.concat([header, payload])
}

const runtimeOf = (value: unknown): Runtime => {
  const [state, body] = Object.entries(value as object)[0] ?? []
  if (state !== "Yielded" && state !== "Terminated" && state !== "Result")
    throw new Error(`the code-mode host answered with ${JSON.stringify(value)}`)
  return { ...(body as Omit<Runtime, "state">), state }
}

const settled = (outcome: Outcome) => {
  if (outcome.status === "error") throw new Error(outcome.message)
  return outcome.value
}

class Connection {
  private readonly pending = new Map<number, Pending>()
  private readonly sessions = new Map<string, Promise<void>>()
  private nextId = 1
  private stderr = ""
  private stopped = false

  private constructor(
    private readonly child: Subprocess<"pipe", "pipe", "pipe">,
    private readonly route: Route,
    private readonly gone: () => void,
  ) {}

  static async start(program: string, route: Route, gone: () => void) {
    let child: Subprocess<"pipe", "pipe", "pipe">
    try {
      child = Bun.spawn([program, "--listen", "stdio"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    } catch (error) {
      throw new Error(`could not start ${program}: ${error instanceof Error ? error.message : String(error)}`)
    }
    child.unref()
    const connection = new Connection(child, route, gone)
    void connection.keepStderr()
    const ready = Promise.withResolvers<void>()
    void connection.read((message) => {
      if (message.type === "connection/ready") ready.resolve()
      else if (message.type === "connection/rejected")
        ready.reject(new Error(`the code-mode host turned nisse down: ${JSON.stringify(message.reason)}`))
    }, ready)
    connection.write({
      type: "connection/hello",
      supportedVersions: [1],
      requiredCapabilities: [],
      optionalCapabilities: [],
    })
    try {
      await ready.promise
    } catch (error) {
      connection.stop()
      throw error
    }
    return connection
  }

  stop() {
    if (!this.stopped) this.child.kill()
    this.halt()
  }

  session(id: string) {
    let opened = this.sessions.get(id)
    if (!opened) {
      opened = this.operation({ method: "session/open", sessionId: id }).then(() => undefined)
      this.sessions.set(id, opened)
      opened.catch(() => this.sessions.delete(id))
    }
    return opened
  }

  execute(session: string, request: unknown, started: (cellId: string) => void) {
    return new Promise<Runtime>((resolve, reject) => {
      this.send(
        { method: "session/execute", sessionId: session, request },
        {
          response: (outcome) => {
            if (outcome.status === "error") reject(new Error(outcome.message))
            else if (typeof outcome.value?.cellId === "string") started(outcome.value.cellId)
          },
          initial: (outcome) => {
            try {
              resolve(runtimeOf(settled(outcome)))
            } catch (error) {
              reject(error)
            }
          },
          stopped: reject,
        },
      )
    })
  }

  wait(session: string, cellId: string, yieldTimeMs: number) {
    return this.waited({
      method: "session/wait",
      sessionId: session,
      request: { cell_id: cellId, yield_time_ms: yieldTimeMs },
    })
  }

  terminate(session: string, cellId: string) {
    return this.waited({ method: "session/terminate", sessionId: session, cellId })
  }

  private async waited(request: unknown) {
    const completed = await this.operation(request)
    const [runtime] = Object.values(completed?.outcome ?? {})
    if (runtime === undefined) throw new Error("the code-mode host's answer has no outcome")
    return runtimeOf(runtime)
  }

  private operation(request: unknown) {
    return new Promise<any>((resolve, reject) =>
      this.send(request, {
        response: (outcome) => {
          try {
            resolve(settled(outcome))
          } catch (error) {
            reject(error)
          }
        },
        stopped: reject,
      }),
    )
  }

  private send(request: unknown, pending: Pending) {
    if (this.stopped) return pending.stopped(this.stoppedError())
    const id = this.nextId++
    this.pending.set(id, pending)
    this.write({ type: "operation/request", id, request })
  }

  private write(message: unknown) {
    if (this.stopped) return
    try {
      this.child.stdin.write(frame(message))
      this.child.stdin.flush()
    } catch {
      this.halt()
    }
  }

  private answer(id: number, result: { ok: unknown } | { error: string }) {
    this.write({
      type: "delegate/response",
      id,
      result:
        "ok" in result
          ? { status: "ok", value: { type: "tool/result", result: result.ok } }
          : { status: "error", message: result.error },
    })
  }

  private delegate(message: any) {
    const answer = (result: { ok: unknown } | { error: string }) => this.answer(message.id, result)
    const request = message.request
    if (request?.type !== "tool/invoke") return answer({ error: "Nisse does not support this helper" })
    const route = this.route(String(message.sessionId))
    if (!route) return answer({ error: "the run that started this script has ended" })
    const invocation = request.invocation ?? {}
    route({
      cellId: String(invocation.cell_id ?? ""),
      runtimeCallId: String(invocation.runtime_tool_call_id ?? ""),
      tool: String(invocation.tool_name?.name ?? ""),
      input: invocation.input ?? null,
      answer,
    })
  }

  private dispatch(message: any) {
    switch (message.type) {
      case "operation/response": {
        const waiting = this.pending.get(message.id)
        if (!waiting?.initial || message.result?.status === "error") this.pending.delete(message.id)
        waiting?.response(message.result)
        break
      }
      case "execute/initialResponse":
        this.pending.get(message.id)?.initial?.(message.result)
        this.pending.delete(message.id)
        break
      case "delegate/request":
        this.delegate(message)
        break
    }
  }

  private async read(handshake: (message: any) => void, ready: PromiseWithResolvers<void>) {
    let buffered = Buffer.alloc(0)
    let shaken = false
    try {
      for await (const chunk of this.child.stdout) {
        buffered = Buffer.concat([buffered, chunk])
        while (buffered.length >= 4) {
          const length = buffered.readUInt32LE(0)
          if (length > MAX_FRAME) throw new Error(`the code-mode host sent a ${length}-byte frame`)
          if (buffered.length < 4 + length) break
          const message = JSON.parse(buffered.subarray(4, 4 + length).toString())
          buffered = buffered.subarray(4 + length)
          if (shaken) this.dispatch(message)
          else {
            shaken = true
            handshake(message)
          }
        }
      }
    } catch {}
    ready.reject(new Error(`the code-mode host did not answer its handshake${this.lastWords()}`))
    this.halt()
  }

  private async keepStderr() {
    const decoder = new TextDecoder()
    try {
      for await (const chunk of this.child.stderr) {
        this.stderr = (this.stderr + decoder.decode(chunk, { stream: true })).slice(-KEPT_STDERR)
      }
    } catch {}
  }

  private halt() {
    if (this.stopped && this.pending.size === 0) return
    this.stopped = true
    this.gone()
    const error = this.stoppedError()
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const waiting of pending) waiting.stopped(error)
  }

  private lastWords() {
    const last = this.stderr.trim().split("\n").at(-1) ?? ""
    return last === "" ? "" : `: ${last}`
  }

  private stoppedError() {
    return new Error(`the code-mode host stopped${this.lastWords()}`)
  }
}

export type HostConnection = Pick<Connection, "execute" | "wait" | "terminate">

export class Host {
  private connection: Promise<Connection> | undefined
  private readonly routes = new Map<string, (call: Delegated) => void>()
  private active = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly idleMs: number) {}

  beginRun(conversation: string, route: (call: Delegated) => void) {
    this.active += 1
    clearTimeout(this.idleTimer)
    this.routes.set(conversation, route)
  }

  endRun(conversation: string) {
    this.routes.delete(conversation)
    this.active -= 1
    if (this.active > 0) return
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs)
    this.idleTimer.unref()
  }

  async session(program: string, conversation: string): Promise<HostConnection> {
    if (!this.connection) {
      let starting: Promise<Connection> | undefined
      starting = Connection.start(
        program,
        (session) => this.routes.get(session),
        () => this.forget(starting),
      )
      this.connection = starting
      starting.catch(() => this.forget(starting))
    }
    const connection = await this.connection
    await connection.session(conversation)
    return connection
  }

  private forget(connection: Promise<Connection> | undefined) {
    if (this.connection === connection) this.connection = undefined
  }

  stop() {
    clearTimeout(this.idleTimer)
    const connection = this.connection
    this.connection = undefined
    void connection?.then((running) => running.stop()).catch(() => undefined)
  }
}
