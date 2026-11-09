// Adapted from pi-durable at 7d073328e (packages/durable/src/env/node.ts), MIT, see LICENSE.
import { randomUUID } from "node:crypto"
import { constants, type Dir, type Stats } from "node:fs"
import {
  access,
  appendFile,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open as openFile,
  opendir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { StreamDecoder } from "./decode.ts"
import { killProcessTree, resolveTimeoutMs, runProcess, shellConfig } from "./exec.ts"
import {
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  ExecutionError,
  type FileChange,
  FileError,
  type FileInfo,
  type FileKind,
  type FileWatcher,
  type LineScan,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLine,
  type TextLineReader,
  toError,
  type WatchTarget,
} from "./index.ts"
import { LineScanner } from "./line-scan.ts"
import { LocalFileWatcher, type LocalWatchOptions } from "./watch.ts"

export type { LocalWatchOptions } from "./watch.ts"
export { LocalFileWatcher } from "./watch.ts"

/** Largest single read of a `BinaryReader`, so a huge `length` allocates only as much as the file yields. */
const BINARY_READ_CHUNK = 1024 * 1024
const LINE_READ_CHUNK = 64 * 1024

function resolvePath(cwd: string, path: string): string {
  let normalized = path
  if (normalized === "~") {
    normalized = homedir()
  } else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    normalized = join(homedir(), normalized.slice(2))
  } else if (normalized.startsWith("file://")) {
    try {
      normalized = fileURLToPath(normalized)
    } catch {
      // A malformed URL stays an ordinary path, so the operation reports it like any other.
    }
  }
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized)
}

function kindOf(stats: Pick<Stats, "isFile" | "isDirectory" | "isSymbolicLink">): FileKind | undefined {
  if (stats.isFile()) return "file"
  if (stats.isDirectory()) return "directory"
  if (stats.isSymbolicLink()) return "symlink"
  return undefined
}

function infoOf(path: string, stats: Stats): FileInfo | undefined {
  const kind = kindOf(stats)
  return kind && { name: basename(path), path, kind, size: stats.size, mtimeMs: stats.mtimeMs }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function toFileError(error: unknown, fallbackPath?: string): FileError {
  if (error instanceof FileError) return error
  const cause = toError(error)
  const nodeError = isNodeError(error) ? error : undefined
  const path = typeof nodeError?.path === "string" ? nodeError.path : fallbackPath
  if (nodeError) {
    const code = (
      {
        ABORT_ERR: "aborted",
        ENOENT: "not_found",
        EACCES: "permission_denied",
        EPERM: "permission_denied",
        ENOTDIR: "not_directory",
        EISDIR: "is_directory",
        EINVAL: "invalid",
      } as const
    )[nodeError.code ?? ""]
    if (code) return new FileError(code, nodeError.message, path, cause)
  }
  return new FileError("unknown", cause.message, path, cause)
}

/**
 * One asynchronous file operation. An interrupt aborts it through `signal` and completes only when the operation has
 * settled, so nothing is left running behind the interrupted fiber (F6's join rule).
 */
const attempt = <A>(path: string | undefined, run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, FileError> =>
  Effect.callback<A, FileError>((resume, signal) => {
    const settled = run(signal).then(
      (value) => resume(Effect.succeed(value)),
      (error: unknown) => resume(Effect.fail(toFileError(error, path))),
    )
    return Effect.promise(() => settled)
  })

/** Acquires a resource so that an interrupt arriving during or right after acquisition cannot leak it. */
const acquire = <R>(open: Effect.Effect<R, FileError>, release: (resource: R) => Promise<unknown>) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.tap(open, (resource) =>
      Effect.onInterrupt(restore(Effect.void), () => Effect.promise(() => release(resource).catch(() => undefined))),
    ),
  )

const closed = (what: string, path: string): FileError => new FileError("invalid", `${what} is closed`, path)

class LocalTextLineReader implements TextLineReader {
  readonly #file: FileHandle
  readonly #path: string
  readonly #decoder = new StreamDecoder()
  readonly #chunk = new Uint8Array(LINE_READ_CHUNK)
  #byteOffset = 0
  #buffered = ""
  #ended = false
  #closed = false

  constructor(file: FileHandle, path: string) {
    this.#file = file
    this.#path = path
  }

  readLine(): Effect.Effect<TextLine | undefined, FileError> {
    const reader = this
    return Effect.gen(function* () {
      if (reader.#closed) return yield* Effect.fail(closed("Text line reader", reader.#path))
      while (true) {
        const newline = reader.#buffered.indexOf("\n")
        if (newline !== -1) {
          const text = reader.#buffered.slice(0, newline)
          reader.#buffered = reader.#buffered.slice(newline + 1)
          return { text, terminated: true }
        }
        if (reader.#ended) {
          if (reader.#buffered.length === 0) return undefined
          const text = reader.#buffered
          reader.#buffered = ""
          return { text, terminated: false }
        }
        // An explicit position lets an interrupted read be repeated without skipping bytes.
        const { bytesRead } = yield* attempt(reader.#path, () =>
          reader.#file.read(reader.#chunk, 0, reader.#chunk.length, reader.#byteOffset),
        )
        reader.#byteOffset += bytesRead
        if (bytesRead === 0) {
          reader.#buffered += reader.#decoder.decode()
          reader.#ended = true
        } else {
          reader.#buffered += reader.#decoder.decode(reader.#chunk.subarray(0, bytesRead))
        }
      }
    })
  }

  close(): Effect.Effect<void> {
    return Effect.promise(async () => {
      if (this.#closed) return
      this.#closed = true
      this.#buffered = ""
      await this.#file.close().catch(() => undefined)
    })
  }
}

class LocalBinaryReader implements BinaryReader {
  readonly #file: FileHandle
  readonly #path: string
  #closed = false

  constructor(file: FileHandle, path: string) {
    this.#file = file
    this.#path = path
  }

  /** Checked when an operation runs, not when its effect is built. */
  #open(): Effect.Effect<void, FileError> {
    return this.#closed ? Effect.fail(closed("Binary reader", this.#path)) : Effect.void
  }

  info(): Effect.Effect<FileInfo, FileError> {
    return Effect.flatMap(
      Effect.suspend(() => this.#open()),
      () =>
        Effect.flatMap(
          attempt(this.#path, () => this.#file.stat()),
          (stats) => {
            const info = infoOf(this.#path, stats)
            return info
              ? Effect.succeed(info)
              : Effect.fail(new FileError("invalid", "Unsupported file type", this.#path))
          },
        ),
    )
  }

  read(offset: number, length: number): Effect.Effect<Uint8Array, FileError> {
    const reader = this
    return Effect.gen(function* () {
      yield* reader.#open()
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
        return yield* Effect.fail(
          new FileError("invalid", "Offset and length must be non-negative safe integers", reader.#path),
        )
      }
      const chunks: Uint8Array[] = []
      let total = 0
      while (total < length) {
        const chunk = new Uint8Array(Math.min(length - total, BINARY_READ_CHUNK))
        const { bytesRead } = yield* attempt(reader.#path, () =>
          reader.#file.read(chunk, 0, chunk.length, offset + total),
        )
        if (bytesRead === 0) break
        chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead))
        total += bytesRead
      }
      if (chunks.length === 1) return chunks[0]!
      const bytes = new Uint8Array(total)
      let position = 0
      for (const chunk of chunks) {
        bytes.set(chunk, position)
        position += chunk.length
      }
      return bytes
    })
  }

  scanLines(options: { startLine: number; endLine?: number }): Effect.Effect<LineScan, FileError> {
    const reader = this
    return Effect.gen(function* () {
      yield* reader.#open()
      let scanner: LineScanner
      try {
        scanner = new LineScanner(options.startLine, options.endLine)
      } catch {
        return yield* Effect.fail(new FileError("invalid", "Invalid line range", reader.#path))
      }
      const chunk = new Uint8Array(LINE_READ_CHUNK)
      for (let position = 0; ; ) {
        const { bytesRead } = yield* attempt(reader.#path, () => reader.#file.read(chunk, 0, chunk.length, position))
        if (bytesRead === 0) return scanner.finish()
        scanner.push(chunk.subarray(0, bytesRead))
        position += bytesRead
      }
    })
  }

  close(): Effect.Effect<void> {
    return Effect.promise(async () => {
      if (this.#closed) return
      this.#closed = true
      await this.#file.close().catch(() => undefined)
    })
  }
}

class LocalDirReader implements DirReader {
  readonly #dir: Dir
  readonly #path: string
  #done = false
  #closed = false

  constructor(dir: Dir, path: string) {
    this.#dir = dir
    this.#path = path
  }

  next(maxEntries: number): Effect.Effect<{ entries: FileInfo[]; done: boolean }, FileError> {
    const reader = this
    return Effect.gen(function* () {
      if (reader.#closed) return yield* Effect.fail(closed("Directory reader", reader.#path))
      if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
        return yield* Effect.fail(new FileError("invalid", "maxEntries must be a positive safe integer", reader.#path))
      }
      const entries: FileInfo[] = []
      while (!reader.#done && entries.length < maxEntries) {
        const entry = yield* attempt(reader.#path, () => reader.#dir.read())
        if (entry === null) {
          reader.#done = true
          break
        }
        const entryPath = resolve(reader.#path, entry.name)
        // Removed between enumeration and lstat: not part of the listing any more.
        const stats = yield* attempt(entryPath, () =>
          lstat(entryPath).catch((error: unknown) => {
            if (isNodeError(error) && error.code === "ENOENT") return undefined
            throw error
          }),
        )
        const info = stats && infoOf(entryPath, stats)
        if (info) entries.push(info)
      }
      return { entries, done: reader.#done }
    })
  }

  close(): Effect.Effect<void> {
    return Effect.promise(async () => {
      if (this.#closed) return
      this.#closed = true
      await this.#dir.close().catch(() => undefined)
    })
  }
}

function symlinkRefused(path: string, cause?: Error): FileError {
  return new FileError("invalid", "Refusing to follow a symbolic link", path, cause)
}

export interface LocalExecutionEnvOptions {
  readonly cwd: string
  readonly shellPath?: string
  readonly shellEnv?: NodeJS.ProcessEnv
  readonly watch?: LocalWatchOptions
}

/** The machine nisse runs on. */
export class LocalExecutionEnv implements ExecutionEnv {
  /** Every local environment sees the same files. */
  readonly id: string = "node:local"
  readonly cwd: string
  readonly #shellPath: string | undefined
  readonly #shellEnv: NodeJS.ProcessEnv | undefined
  readonly #watchOptions: LocalWatchOptions
  readonly #activePids = new Set<number>()

  constructor(options: LocalExecutionEnvOptions) {
    this.cwd = options.cwd
    this.#shellPath = options.shellPath
    this.#shellEnv = options.shellEnv
    this.#watchOptions = options.watch ?? {}
  }

  #resolve(path: string): string {
    return resolvePath(this.cwd, path)
  }

  absolutePath(path: string): Effect.Effect<string, FileError> {
    return Effect.sync(() => this.#resolve(path))
  }

  joinPath(parts: string[]): Effect.Effect<string, FileError> {
    return Effect.sync(() => join(...parts))
  }

  readTextFile(path: string): Effect.Effect<string, FileError> {
    const resolved = this.#resolve(path)
    return attempt(resolved, (signal) => readFile(resolved, { encoding: "utf8", signal }))
  }

  openTextLineReader(path: string): Effect.Effect<TextLineReader, FileError> {
    const resolved = this.#resolve(path)
    return Effect.map(
      acquire(
        attempt(resolved, () => openFile(resolved, "r")),
        (file) => file.close(),
      ),
      (file) => new LocalTextLineReader(file, resolved),
    )
  }

  readTextLines(path: string, options?: { maxLines?: number }): Effect.Effect<string[], FileError> {
    const maxLines = options?.maxLines
    if (maxLines !== undefined && maxLines <= 0) return Effect.succeed([])
    return Effect.acquireUseRelease(
      this.openTextLineReader(path),
      (reader) =>
        Effect.gen(function* () {
          const lines: string[] = []
          while (maxLines === undefined || lines.length < maxLines) {
            const line = yield* reader.readLine()
            if (line === undefined) break
            lines.push(line.text)
          }
          return lines
        }),
      (reader) => reader.close(),
    )
  }

  readBinaryFile(path: string): Effect.Effect<Uint8Array, FileError> {
    const resolved = this.#resolve(path)
    return attempt(resolved, (signal) => readFile(resolved, { signal }))
  }

  openBinaryReader(path: string, options?: { noFollow?: boolean }): Effect.Effect<BinaryReader, FileError> {
    const resolved = this.#resolve(path)
    const noFollow = options?.noFollow === true
    const open = async (): Promise<FileHandle> => {
      let flags = constants.O_RDONLY
      if (process.platform === "win32") {
        // Windows has no O_NOFOLLOW; check the final component before opening (not race-free).
        if (noFollow && (await lstat(resolved)).isSymbolicLink()) throw symlinkRefused(resolved)
      } else {
        // Nonblocking, so opening a FIFO does not wait for a writer.
        flags |= constants.O_NONBLOCK
        if (noFollow) flags |= constants.O_NOFOLLOW
      }
      let file: FileHandle
      try {
        file = await openFile(resolved, flags)
      } catch (error) {
        // O_NOFOLLOW reports a final-component symlink as ELOOP (EMLINK on some BSDs).
        if (noFollow && isNodeError(error) && (error.code === "ELOOP" || error.code === "EMLINK")) {
          throw symlinkRefused(resolved, error)
        }
        throw error
      }
      try {
        const stats = await file.stat()
        if (stats.isDirectory()) {
          throw new FileError("is_directory", "EISDIR: illegal operation on a directory, read", resolved)
        }
        if (!stats.isFile()) throw new FileError("invalid", "Not a regular file", resolved)
        return file
      } catch (error) {
        await file.close().catch(() => undefined)
        throw error
      }
    }
    return Effect.map(
      acquire(attempt(resolved, open), (file) => file.close()),
      (file) => new LocalBinaryReader(file, resolved),
    )
  }

  writeFile(path: string, content: string | Uint8Array): Effect.Effect<void, FileError> {
    const resolved = this.#resolve(path)
    return attempt(resolved, async (signal) => {
      await mkdir(resolve(resolved, ".."), { recursive: true })
      signal.throwIfAborted()
      await writeFile(resolved, content, { signal })
    })
  }

  appendFile(path: string, content: string | Uint8Array): Effect.Effect<void, FileError> {
    const resolved = this.#resolve(path)
    return attempt(resolved, async (signal) => {
      await mkdir(resolve(resolved, ".."), { recursive: true })
      signal.throwIfAborted()
      await appendFile(resolved, content)
    })
  }

  truncateFile(path: string, size: number): Effect.Effect<void, FileError> {
    const resolved = this.#resolve(path)
    if (!Number.isSafeInteger(size) || size < 0) {
      return Effect.fail(new FileError("invalid", "File size must be a non-negative safe integer", resolved))
    }
    return attempt(resolved, async () => {
      const file = await openFile(resolved, "r+")
      try {
        await file.truncate(size)
      } finally {
        await file.close().catch(() => undefined)
      }
    })
  }

  flushFile(path: string): Effect.Effect<void, FileError> {
    const resolved = this.#resolve(path)
    return attempt(resolved, async () => {
      const file = await openFile(resolved, "r+")
      try {
        // POSIX refuses to open a directory for writing; Windows opens it, so check explicitly.
        if ((await file.stat()).isDirectory()) throw new FileError("is_directory", "Is a directory", resolved)
        await file.sync()
      } finally {
        await file.close().catch(() => undefined)
      }
    })
  }

  renameFile(sourcePath: string, destinationPath: string): Effect.Effect<void, FileError> {
    const source = this.#resolve(sourcePath)
    const destination = this.#resolve(destinationPath)
    return attempt(source, () => rename(source, destination))
  }

  fileInfo(path: string): Effect.Effect<FileInfo, FileError> {
    const resolved = this.#resolve(path)
    return Effect.flatMap(
      attempt(resolved, () => lstat(resolved)),
      (stats) => {
        const info = infoOf(resolved, stats)
        return info ? Effect.succeed(info) : Effect.fail(new FileError("invalid", "Unsupported file type", resolved))
      },
    )
  }

  listDir(path: string): Effect.Effect<FileInfo[], FileError> {
    const resolved = this.#resolve(path)
    return attempt(resolved, async (signal) => {
      const entries = await readdir(resolved, { withFileTypes: true })
      const infos: FileInfo[] = []
      for (const entry of entries) {
        signal.throwIfAborted()
        const entryPath = resolve(resolved, entry.name)
        try {
          const info = infoOf(entryPath, await lstat(entryPath))
          if (info) infos.push(info)
        } catch (error) {
          throw toFileError(error, entryPath)
        }
      }
      return infos
    })
  }

  openDirReader(path: string): Effect.Effect<DirReader, FileError> {
    const resolved = this.#resolve(path)
    return Effect.map(
      acquire(
        attempt(resolved, () => opendir(resolved)),
        (dir) => dir.close(),
      ),
      (dir) => new LocalDirReader(dir, resolved),
    )
  }

  watch(
    targets: readonly WatchTarget[],
    onChange: (change: FileChange) => void,
  ): Effect.Effect<FileWatcher, FileError> {
    return acquire(
      attempt(undefined, () =>
        LocalFileWatcher.open(targets, (path) => this.#resolve(path), onChange, this.#watchOptions),
      ),
      (watcher) => watcher.stopNow(),
    )
  }

  canonicalPath(path: string): Effect.Effect<string, FileError> {
    const resolved = this.#resolve(path)
    return attempt(resolved, () => realpath(resolved))
  }

  exists(path: string): Effect.Effect<boolean, FileError> {
    return this.fileInfo(path).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.code === "not_found",
        () => Effect.succeed(false),
      ),
    )
  }

  createDir(path: string, options?: { recursive?: boolean }): Effect.Effect<void, FileError> {
    const resolved = this.#resolve(path)
    return attempt(resolved, async () => {
      await mkdir(resolved, { recursive: options?.recursive ?? true })
    })
  }

  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Effect.Effect<void, FileError> {
    const resolved = this.#resolve(path)
    return attempt(resolved, () =>
      rm(resolved, { recursive: options?.recursive ?? false, force: options?.force ?? false }),
    )
  }

  createTempDir(prefix?: string): Effect.Effect<string, FileError> {
    return attempt(undefined, () => mkdtemp(join(tmpdir(), prefix ?? "tmp-")))
  }

  createTempFile(options?: { prefix?: string; suffix?: string }): Effect.Effect<string, FileError> {
    return Effect.flatMap(this.createTempDir("tmp-"), (dir) => {
      const filePath = join(dir, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`)
      return attempt(filePath, () => writeFile(filePath, "")).pipe(Effect.as(filePath))
    })
  }

  exec(
    command: string | readonly string[],
    options?: ShellExecOptions,
  ): Effect.Effect<ShellExecResult, ExecutionError> {
    const env = this
    return Effect.gen(function* () {
      const timeoutMs = resolveTimeoutMs(options?.timeout)
      if (timeoutMs instanceof ExecutionError) return yield* Effect.fail(timeoutMs)
      const cwd = options?.cwd ? env.#resolve(options.cwd) : env.cwd

      // A string runs through the shell; an argv array runs its program directly, without shell parsing.
      let program: string
      let args: readonly string[]
      let stdinCommand: string | undefined
      if (typeof command === "string") {
        const shell = yield* Effect.promise(() => shellConfig(env.#shellPath))
        if (shell instanceof ExecutionError) return yield* Effect.fail(shell)
        const fromStdin = shell.commandTransport === "stdin"
        program = shell.shell
        args = fromStdin ? shell.args : [...shell.args, command]
        stdinCommand = fromStdin ? command : undefined
      } else {
        const [first, ...rest] = command
        if (first === undefined)
          return yield* Effect.fail(new ExecutionError("spawn_error", "Empty argv: no program to run"))
        program = first
        args = rest
      }

      const missingCwd = yield* Effect.promise(() =>
        access(cwd, constants.F_OK).then(
          () => undefined,
          (error: unknown) => toError(error),
        ),
      )
      if (missingCwd) {
        return yield* Effect.fail(
          new ExecutionError(
            "spawn_error",
            `Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
            missingCwd,
          ),
        )
      }

      return yield* runProcess({
        program,
        args,
        stdinCommand,
        cwd,
        env: options?.inheritEnv === false ? { ...options.env } : { ...process.env, ...env.#shellEnv, ...options?.env },
        timeoutMs,
        options,
        createSpillFile: () => env.createTempFile({ prefix: "pi-output-", suffix: ".log" }),
        started: (pid) => env.#activePids.add(pid),
        ended: (pid) => env.#activePids.delete(pid),
      })
    })
  }

  cleanup(): Effect.Effect<void> {
    return Effect.sync(() => {
      for (const pid of this.#activePids) killProcessTree(pid)
      this.#activePids.clear()
    })
  }
}
