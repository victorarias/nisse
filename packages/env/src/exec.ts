// Adapted from pi-durable at 7d073328e (packages/durable/src/env/node.ts), MIT, see LICENSE.
import { type ChildProcess, spawn } from "node:child_process"
import { constants, createWriteStream, type WriteStream } from "node:fs"
import { access } from "node:fs/promises"
import { constants as osConstants } from "node:os"
import { join, win32 } from "node:path"
import { Effect } from "effect"
import { StreamDecoder } from "./decode.ts"
import {
  ExecutionError,
  type FileError,
  type ShellExecOptions,
  type ShellExecResult,
  type ShellOutputInfo,
  toError,
} from "./index.ts"

const MAX_TIMEOUT_MS = 2_147_483_647
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000
const EXIT_STDIO_GRACE_MS = 100
const SPILL_HIGH_WATER_MARK = 1024 * 1024
/** How long `which bash` may take. */
const BASH_LOOKUP_MS = 5000

export interface ShellConfig {
  readonly shell: string
  readonly args: readonly string[]
  readonly commandTransport?: "argv" | "stdin"
}

/** Seconds to milliseconds, or the failure that names the limit. */
export function resolveTimeoutMs(timeout: number | undefined): number | undefined | ExecutionError {
  if (timeout === undefined) return undefined
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds")
  }
  const timeoutMs = timeout * 1000
  if (timeoutMs > MAX_TIMEOUT_MS) {
    return new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`)
  }
  return timeoutMs
}

async function pathExists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(
    () => true,
    () => false,
  )
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      const child = spawn(
        join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
        ["/F", "/T", "/PID", String(pid)],
        { stdio: "ignore", detached: true, windowsHide: true },
      )
      // A failed spawn emits "error" asynchronously; without a listener it would crash the process.
      child.once("error", () => {})
    } catch {
      // Already gone.
    }
    return
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Already gone.
    }
  }
}

export { killProcessTree }

function runCommand(command: string, args: string[]): Promise<{ stdout: string; status: number | null }> {
  return new Promise((resolve) => {
    let stdout = ""
    let child: ChildProcess
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
    } catch {
      resolve({ stdout: "", status: null })
      return
    }
    const timeout = setTimeout(() => {
      if (child.pid) killProcessTree(child.pid)
    }, BASH_LOOKUP_MS)
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.on("error", () => {
      clearTimeout(timeout)
      resolve({ stdout: "", status: null })
    })
    child.on("close", (status) => {
      clearTimeout(timeout)
      resolve({ stdout, status })
    })
  })
}

async function findBashOnPath(): Promise<string | null> {
  const result =
    process.platform === "win32" ? await runCommand("where", ["bash.exe"]) : await runCommand("which", ["bash"])
  if (result.status !== 0 || !result.stdout) return null
  const firstMatch = result.stdout.trim().split(/\r?\n/)[0]
  return firstMatch && (await pathExists(firstMatch)) ? firstMatch : null
}

function isLegacyWslBashPath(path: string): boolean {
  const normalized = win32.normalize(path).toLowerCase()
  const systemRoot = process.env.SystemRoot
  if (systemRoot) {
    if (!/^[a-z]:[\\/]/i.test(systemRoot)) return false
    return ["System32", "Sysnative"].some(
      (directory) => normalized === win32.join(systemRoot, directory, "bash.exe").toLowerCase(),
    )
  }
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized)
}

function bashConfig(shell: string): ShellConfig {
  return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] }
}

export async function shellConfig(customShellPath: string | undefined): Promise<ShellConfig | ExecutionError> {
  if (customShellPath) {
    if (await pathExists(customShellPath)) return bashConfig(customShellPath)
    return new ExecutionError("shell_unavailable", `Custom shell path not found: ${customShellPath}`)
  }
  if (process.platform === "win32") {
    const candidates: string[] = []
    if (process.env.ProgramFiles) candidates.push(`${process.env.ProgramFiles}\\Git\\bin\\bash.exe`)
    const programFilesX86 = process.env["ProgramFiles(x86)"]
    if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`)
    for (const candidate of candidates) if (await pathExists(candidate)) return bashConfig(candidate)
    const onPath = await findBashOnPath()
    if (onPath) return bashConfig(onPath)
    return new ExecutionError(
      "shell_unavailable",
      `No bash shell found. Searched Git Bash in:\n${candidates.map((path) => `  ${path}`).join("\n")}`,
    )
  }
  if (await pathExists("/bin/bash")) return bashConfig("/bin/bash")
  const onPath = await findBashOnPath()
  return onPath ? bashConfig(onPath) : { shell: "sh", args: ["-c"] }
}

export interface ProcessRequest {
  readonly program: string
  readonly args: readonly string[]
  readonly stdinCommand: string | undefined
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number | undefined
  readonly options: ShellExecOptions | undefined
  readonly createSpillFile: () => Effect.Effect<string, FileError>
  readonly started: (pid: number) => void
  readonly ended: (pid: number) => void
}

type Outcome = ShellExecResult | ExecutionError
type SpillChunk = Uint8Array

/** One spawned command: its output, its spill, its timeout, and how it ends. `done` never rejects. */
class ProcessRun {
  readonly done: Promise<Outcome>
  #finish: (outcome: Outcome) => void = () => {}
  #settled = false
  #child: ChildProcess | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #timedOut = false
  #interrupted = false
  #callbackError: ExecutionError | undefined
  #spillError: ExecutionError | undefined
  #spillPath: string | undefined
  #spillStream: WriteStream | undefined
  #spillStart: Promise<void> | undefined
  #spillBackpressured = false
  readonly #spillQueue: SpillChunk[] = []
  readonly #spillPrefix: SpillChunk[] = []
  #seenBytes = 0
  #seenNewlines = 0
  readonly #request: ProcessRequest
  readonly #decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() }

  constructor(request: ProcessRequest) {
    this.#request = request
    this.done = new Promise((resolve) => {
      this.#finish = resolve
    })
    this.#start()
  }

  /** Kill the command because the caller no longer wants it. */
  interrupt(): void {
    this.#interrupted = true
    this.#kill()
  }

  #kill(): void {
    if (this.#child?.pid) killProcessTree(this.#child.pid)
  }

  #settle(outcome: Outcome): void {
    if (this.#settled) return
    this.#settled = true
    clearTimeout(this.#timer)
    if (this.#child?.pid) this.#request.ended(this.#child.pid)
    this.#finish(outcome)
  }

  #start(): void {
    const { program, args, stdinCommand, cwd, env, timeoutMs } = this.#request
    let child: ChildProcess
    try {
      child = spawn(program, [...args], {
        cwd,
        detached: process.platform !== "win32",
        env,
        stdio: [stdinCommand === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (error) {
      const cause = toError(error)
      this.#settle(new ExecutionError("spawn_error", cause.message, cause))
      return
    }
    this.#child = child
    if (child.pid) this.#request.started(child.pid)
    if (stdinCommand !== undefined) {
      child.stdin?.on("error", () => {})
      child.stdin?.end(stdinCommand)
    }
    if (timeoutMs !== undefined) {
      this.#timer = setTimeout(() => {
        this.#timedOut = true
        this.#kill()
      }, timeoutMs)
    }
    child.stdout?.on("data", (chunk: Uint8Array) => this.#receive("stdout", chunk))
    child.stderr?.on("data", (chunk: Uint8Array) => this.#receive("stderr", chunk))
    waitForChild(child, () => this.#spillIsDraining()).then(
      (exit) => void this.#exited(exit),
      (error: Error) => this.#settle(new ExecutionError("spawn_error", error.message, error)),
    )
  }

  async #exited({ code, signal }: { code: number | null; signal: NodeJS.Signals | null }): Promise<void> {
    await this.#finishSpill()
    this.#emit("stdout", this.#decoders.stdout.decode())
    this.#emit("stderr", this.#decoders.stderr.decode())
    if (this.#callbackError) return this.#settle(this.#callbackError)
    if (this.#timedOut || this.#interrupted) {
      const error = this.#timedOut
        ? new ExecutionError("timeout", `timeout:${this.#request.options?.timeout}`)
        : new ExecutionError("aborted", "aborted")
      if (this.#spillPath !== undefined) error.spillPath = this.#spillPath
      return this.#settle(error)
    }
    if (this.#spillError) return this.#settle(this.#spillError)
    // A process killed by a signal has no exit code; 128 + signal number keeps it from looking like success.
    const exitCode = code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1)
    this.#settle(this.#spillPath === undefined ? { exitCode } : { exitCode, spillPath: this.#spillPath })
  }

  #emit(stream: ShellOutputInfo["stream"], text: string): void {
    const onOutput = this.#request.options?.onOutput
    if (this.#settled || text === "" || onOutput === undefined || this.#callbackError !== undefined) return
    try {
      onOutput(text, { stream })
    } catch (error) {
      const cause = toError(error)
      this.#callbackError = new ExecutionError("callback_error", cause.message, cause)
      this.#kill()
    }
  }

  #receive(stream: ShellOutputInfo["stream"], chunk: Uint8Array): void {
    this.#emit(stream, this.#decoders[stream].decode(chunk))
    const spill = this.#request.options?.spill
    if (spill === undefined || chunk.length === 0) return
    if (this.#spillStart !== undefined) return this.#startSpill(chunk)
    this.#seenBytes += chunk.length
    for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, index + 1)) this.#seenNewlines++
    const lines = this.#seenNewlines + (chunk[chunk.length - 1] === 0x0a ? 0 : 1)
    if (this.#seenBytes <= spill.afterBytes && lines <= spill.afterLines) {
      this.#spillPrefix.push(chunk)
      return
    }
    for (const prefix of this.#spillPrefix) this.#startSpill(prefix)
    this.#spillPrefix.length = 0
    this.#startSpill(chunk)
  }

  #pause(): void {
    this.#child?.stdout?.pause()
    this.#child?.stderr?.pause()
  }

  #resume(): void {
    if (this.#callbackError || this.#spillError || this.#timedOut || this.#interrupted || this.#spillBackpressured)
      return
    this.#child?.stdout?.resume()
    this.#child?.stderr?.resume()
  }

  #failSpill(error: unknown): void {
    if (this.#spillError !== undefined) return
    const cause = toError(error)
    this.#spillError = new ExecutionError(
      "unknown",
      `Failed to preserve complete shell output: ${cause.message}`,
      cause,
    )
    this.#spillBackpressured = false
    this.#kill()
  }

  #writeSpill(chunk: SpillChunk): void {
    const stream = this.#spillStream
    if (stream === undefined || chunk.length === 0) return
    if (stream.write(chunk) || this.#spillBackpressured) return
    this.#spillBackpressured = true
    this.#pause()
    stream.once("drain", () => {
      this.#spillBackpressured = false
      this.#resume()
    })
  }

  #startSpill(chunk: SpillChunk): void {
    if (this.#spillStream !== undefined) return this.#writeSpill(chunk)
    this.#spillQueue.push(chunk)
    if (this.#spillStart !== undefined) return
    this.#pause()
    this.#spillStart = Effect.runPromise(this.#request.createSpillFile())
      .then((path) => {
        this.#spillPath = path
        this.#request.options?.onSpill?.(path)
        this.#spillStream = createWriteStream(path, { flags: "a", highWaterMark: SPILL_HIGH_WATER_MARK })
        this.#spillStream.on("error", (error) => this.#failSpill(error))
        for (const queued of this.#spillQueue) this.#writeSpill(queued)
        this.#spillQueue.length = 0
      })
      .catch((error: unknown) => this.#failSpill(error))
      .finally(() => this.#resume())
  }

  #spillIsDraining(): boolean {
    return (
      this.#spillError === undefined &&
      this.#spillStart !== undefined &&
      (this.#spillStream === undefined || this.#spillBackpressured)
    )
  }

  async #finishSpill(): Promise<void> {
    await this.#spillStart
    const stream = this.#spillStream
    if (stream === undefined || this.#spillError !== undefined || stream.destroyed) return
    await new Promise<void>((resolve) => {
      stream.once("error", () => resolve())
      stream.once("finish", resolve)
      stream.end()
    })
  }
}

/** Settles when the child exited and its output ended, or shortly after exit when a descendant keeps its stdio open. */
function waitForChild(
  child: ChildProcess,
  spillIsDraining: () => boolean,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let settled = false
    let exited = false
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let stdoutEnded = child.stdout === null
    let stderrEnded = child.stderr === null

    const cleanup = (): void => {
      clearTimeout(graceTimer)
      child.removeListener("error", onError)
      child.removeListener("exit", onExit)
      child.removeListener("close", onClose)
      child.stdout?.removeListener("end", onStdoutEnd)
      child.stderr?.removeListener("end", onStderrEnd)
      child.stdout?.removeListener("data", onData)
      child.stderr?.removeListener("data", onData)
    }
    const finalize = (): void => {
      if (settled) return
      settled = true
      cleanup()
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({ code: exitCode, signal: exitSignal })
    }
    const finalizeIfDrained = (): void => {
      if (exited && stdoutEnded && stderrEnded) finalize()
    }
    const armGrace = (): void => {
      clearTimeout(graceTimer)
      graceTimer = setTimeout(() => {
        if (spillIsDraining()) armGrace()
        else finalize()
      }, EXIT_STDIO_GRACE_MS)
    }
    const onData = (): void => {
      if (exited && !settled) armGrace()
    }
    const onStdoutEnd = (): void => {
      stdoutEnded = true
      finalizeIfDrained()
    }
    const onStderrEnd = (): void => {
      stderrEnded = true
      finalizeIfDrained()
    }
    const onError = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      exited = true
      exitCode = code
      exitSignal = signal
      finalizeIfDrained()
      if (!settled) armGrace()
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      exitCode = code
      exitSignal = signal
      finalize()
    }

    child.stdout?.once("end", onStdoutEnd)
    child.stderr?.once("end", onStderrEnd)
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.once("error", onError)
    child.once("exit", onExit)
    child.once("close", onClose)
  })
}

/** Runs one process to its end. Interrupting kills it and completes only once it is gone (the join rule). */
export const runProcess = (request: ProcessRequest): Effect.Effect<ShellExecResult, ExecutionError> =>
  Effect.callback<ShellExecResult, ExecutionError>((resume) => {
    const run = new ProcessRun(request)
    void run.done.then((outcome) =>
      resume(outcome instanceof ExecutionError ? Effect.fail(outcome) : Effect.succeed(outcome)),
    )
    return Effect.promise(() => {
      run.interrupt()
      return run.done
    }).pipe(Effect.asVoid)
  })
