import type { Effect } from "effect"

export type FileKind = "file" | "directory" | "symlink"

export type FileErrorCode =
  | "aborted"
  | "not_found"
  | "permission_denied"
  | "not_directory"
  | "is_directory"
  | "invalid"
  | "not_supported"
  | "unknown"

export class FileError extends Error {
  readonly _tag = "FileError"
  readonly code: FileErrorCode
  readonly path: string | undefined

  constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "FileError"
    this.code = code
    this.path = path
  }
}

export type ExecutionErrorCode =
  | "aborted"
  | "timeout"
  | "shell_unavailable"
  | "spawn_error"
  | "callback_error"
  | "unknown"

export class ExecutionError extends Error {
  readonly _tag = "ExecutionError"
  readonly code: ExecutionErrorCode
  /** Spill file of a command that timed out after its output crossed the spill thresholds. */
  spillPath?: string

  constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "ExecutionError"
    this.code = code
  }
}

export function toError(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === "string") return new Error(error)
  try {
    return new Error(JSON.stringify(error))
  } catch {
    return new Error(String(error))
  }
}

export interface FileInfo {
  name: string
  path: string
  kind: FileKind
  size: number
  mtimeMs: number
}

export interface TextLine {
  text: string
  terminated: boolean
}

export interface TextLineReader {
  readLine(): Effect.Effect<TextLine | undefined, FileError>
  close(): Effect.Effect<void>
}

/** Where lines of a file are, as `BinaryReader.scanLines` found them. */
export interface LineScan {
  /** Newline bytes in the whole file; it has `newlines + 1` lines. */
  newlines: number
  /**
   * Byte range of the selected lines: from the start of the first to the end of the last, without the newline that
   * ends it. A selection past the last line is empty at the end of the file.
   */
  start: number
  end: number
  /** Where the first selected line ends: its newline, or the end of the file. */
  firstLineEnd: number
  /** Where the last selected line starts. */
  lastLineStart: number
  /** UTF-8 byte length of the decoded selection and of its first line. */
  selectedBytes: number
  firstLineBytes: number
}

/** Positional reads from one opened regular file; all calls see the same file even if its path is renamed. */
export interface BinaryReader {
  /** Metadata of the opened file, not of whatever its path names now. */
  info(): Effect.Effect<FileInfo, FileError>
  /** Up to `length` bytes at `offset`; fewer only at end of file. */
  read(offset: number, length: number): Effect.Effect<Uint8Array, FileError>
  /**
   * One pass over the file that locates lines `[startLine, endLine)` (`endLine` absent: to the end), 0-based. Decoded
   * sizes are those of the text `new TextDecoder().decode(file)` would produce for that range.
   */
  scanLines(options: { startLine: number; endLine?: number }): Effect.Effect<LineScan, FileError>
  close(): Effect.Effect<void>
}

/** Pages of one directory's entries. */
export interface DirReader {
  /**
   * Up to `maxEntries` entries in the order the file system returns them, continuing where the previous call stopped.
   * `done` marks the end; it may come with the last entries or with an empty page. An entry that disappears before
   * its metadata is read is skipped, as are entries of unsupported kinds.
   */
  next(maxEntries: number): Effect.Effect<{ entries: FileInfo[]; done: boolean }, FileError>
  close(): Effect.Effect<void>
}

/** A file or directory to watch. It may be missing; creating it is a change. */
export interface WatchTarget {
  path: string
  /** Watch everything below a directory, not only its entries. Symbolic links below it are not followed. */
  recursive?: boolean
  /** Entries below `path` that are neither watched nor reported: names starting with `.`, or these names. */
  exclude?: { hidden?: boolean; names?: readonly string[] }
}

/**
 * - `paths`: something at or below each path may have changed. Calls may be spurious; a change is never missed while
 *   the watcher is healthy.
 * - `overflow`: coverage was uncertain for a while; rescan everything that is watched.
 * - `failed`: the watcher stopped with `error`; no calls follow.
 */
export type FileChange =
  | { readonly kind: "paths"; readonly paths: string[] }
  | { readonly kind: "overflow" }
  | { readonly kind: "failed"; readonly error: FileError }

export interface FileWatcher {
  /** `native`: changes are reported within about two seconds. `polling`: snapshots compared on a timer. */
  readonly mode: "native" | "polling"
  /** Stop watching; no `onChange` call starts after this completes. Idempotent. */
  stop(): Effect.Effect<void>
}

export interface ListFilesOptions {
  /** Include names starting with `.`; default true. Entries named `.git` are never listed. */
  hidden?: boolean
  /** Inside a git work tree, skip what git ignores; default true. */
  gitignore?: boolean
  /** Names of entries to skip with everything below them. */
  exclude?: readonly string[]
  /** Most entries to list; default 50 000. */
  maxEntries?: number
  /** Most bytes of the listing: each entry's UTF-8 path plus two; default 4 MiB, at most 15.9 MiB. */
  maxBytes?: number
  /** Time after which the listing stops; default 10 000 ms. */
  timeoutMs?: number
}

export interface FileListEntry {
  /** Relative to the listed directory, with `/` separators on every system. */
  path: string
  kind: FileKind
}

export interface FileListing {
  /** Depth first, parents before their entries, siblings in byte order of their names. */
  entries: FileListEntry[]
  truncated: boolean
}

/** Files of one namespace. Interrupting an operation stops it; an operation that started writing may have written. */
export interface FileSystem {
  /** Equal ids see the same files at the same paths, whatever their `cwd`. */
  readonly id: string
  readonly cwd: string
  absolutePath(path: string): Effect.Effect<string, FileError>
  joinPath(parts: string[]): Effect.Effect<string, FileError>
  readTextFile(path: string): Effect.Effect<string, FileError>
  openTextLineReader(path: string): Effect.Effect<TextLineReader, FileError>
  readTextLines(path: string, options?: { maxLines?: number }): Effect.Effect<string[], FileError>
  readBinaryFile(path: string): Effect.Effect<Uint8Array, FileError>
  /**
   * Open a regular file for bounded positional reads. A directory fails with `is_directory`, other non-regular files
   * with `invalid`. With `noFollow`, a symbolic link as the final path component fails with `invalid`.
   */
  openBinaryReader(path: string, options?: { noFollow?: boolean }): Effect.Effect<BinaryReader, FileError>
  writeFile(path: string, content: string | Uint8Array): Effect.Effect<void, FileError>
  appendFile(path: string, content: string | Uint8Array): Effect.Effect<void, FileError>
  /** Truncate or extend a file to exactly `size` bytes. */
  truncateFile(path: string, size: number): Effect.Effect<void, FileError>
  /** Flush file contents and the metadata needed to retrieve them. */
  flushFile(path: string): Effect.Effect<void, FileError>
  renameFile(sourcePath: string, destinationPath: string): Effect.Effect<void, FileError>
  fileInfo(path: string): Effect.Effect<FileInfo, FileError>
  listDir(path: string): Effect.Effect<FileInfo[], FileError>
  /** Optional: everything below a directory. `not_supported` tells callers to fall back to their own walk. */
  listFiles?(path: string, options?: ListFilesOptions): Effect.Effect<FileListing, FileError>
  openDirReader(path: string): Effect.Effect<DirReader, FileError>
  /** When the returned watcher exists, coverage is established: a watch before a load cannot miss a change during it. */
  watch(targets: readonly WatchTarget[], onChange: (change: FileChange) => void): Effect.Effect<FileWatcher, FileError>
  canonicalPath(path: string): Effect.Effect<string, FileError>
  exists(path: string): Effect.Effect<boolean, FileError>
  createDir(path: string, options?: { recursive?: boolean }): Effect.Effect<void, FileError>
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Effect.Effect<void, FileError>
  createTempDir(prefix?: string): Effect.Effect<string, FileError>
  createTempFile(options?: { prefix?: string; suffix?: string }): Effect.Effect<string, FileError>
}

/** Spill the complete output to a temporary file once it exceeds either threshold. */
export interface ShellSpillOptions {
  afterBytes: number
  /** Complete or partial lines. */
  afterLines: number
}

export interface ShellExecResult {
  exitCode: number
  /** Temporary file holding the complete raw output, when the spill thresholds were exceeded. */
  spillPath?: string
}

/** The tail of the combined output a caller keeps, so an environment on a slow link may omit the rest. */
export interface ShellOutputWindow {
  maxBytes: number
  maxLines: number
  minIntervalMs: number
  bytesPerSecond: number
}

/** Output omitted before a chunk, in the shape `OutputBuffer.push()` accepts. */
export interface ShellOutputSkip {
  bytes: number
  newlines: number
  endsWithNewline: boolean
}

export interface ShellOutputInfo {
  stream: "stdout" | "stderr"
  /** Output omitted immediately before this chunk, only with `window`. */
  skipped?: ShellOutputSkip
}

export interface ShellExecOptions {
  cwd?: string
  env?: Record<string, string>
  inheritEnv?: boolean
  /** Seconds. */
  timeout?: number
  /** Every decoded chunk as it arrives, with its stream. Throwing fails the command with `callback_error`. */
  onOutput?: (text: string, info: ShellOutputInfo) => void
  spill?: ShellSpillOptions
  /** Called when a spill file exists, so a caller interrupted before the command returns still knows where it is. */
  onSpill?: (path: string) => void
  window?: ShellOutputWindow
}

export interface Shell {
  /**
   * Run a command. A string runs through the environment's shell. An array runs `command[0]` directly with the rest as
   * its arguments. Interrupting kills this command's processes and completes once they are gone.
   */
  exec(command: string | readonly string[], options?: ShellExecOptions): Effect.Effect<ShellExecResult, ExecutionError>
  /** Kill every command this environment still runs; for its owner's shutdown, never for one request. */
  cleanup(): Effect.Effect<void>
}

export interface ExecutionEnv extends FileSystem, Shell {}

export { rangeDecoder, StreamDecoder, startsWithBom } from "./decode.ts"
export { LineScanner } from "./line-scan.ts"
