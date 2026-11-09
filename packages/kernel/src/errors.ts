import { Data } from "effect"

/** The message of a thrown value, without throwing itself: `String()` throws for values such as `Object.create(null)`. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return Object.prototype.toString.call(error)
  }
}

/**
 * A storage call failed, and whether it took effect is unknown: the database failed, its data is corrupt, or the
 * storage is closed. Final for the Session (spec 10.1). `cause` is what failed, as the driver threw it.
 */
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly message: string
  readonly cause: unknown
}> {
  static of(cause: unknown): StorageError {
    return new StorageError({ message: errorMessage(cause), cause })
  }

  /** A failure storage itself detects, such as corrupt data. */
  static because(message: string): StorageError {
    return StorageError.of(new Error(message))
  }
}

/**
 * A read was invalid, such as an unknown conversation or a cursor from another scan, and had no durable effect. Unlike
 * a `StorageError`, it fails only that read (spec 10.1).
 */
export class StorageRequestError extends Data.TaggedError("StorageRequestError")<{ readonly message: string }> {}

/**
 * Storage's own checks refused a batch of a commit: an ID that already belongs to another record, an invalid document
 * action, or a copy whose source cannot be used. The batches before it are stored.
 */
export class CommitRefused extends Data.TaggedError("CommitRefused")<{
  readonly message: string
  readonly cause?: unknown
}> {}
