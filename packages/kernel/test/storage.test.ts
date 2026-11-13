// The Storage port as the Session consumes it: Effects whose failures are typed. The conformance suite runs storage
// through a Promise adapter, which turns these failures into thrown values, so it cannot show which channel they use.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber, Scheduler } from "effect"
import {
  CommitRefused,
  type ConversationId,
  type EntryId,
  idFromNumber,
  openSqliteDatabase,
  openSqliteStorage,
  ROOT_CONVERSATION_ID,
  seqFromNumber,
  type SqliteDatabase,
  SqliteStorage,
  StorageError,
  StorageRequestError,
} from "../src/index.ts"

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const open = (): Promise<SqliteStorage> => Effect.runPromise(openSqliteStorage(join(home(), "kernel.sqlite")))

const failure = async <A, E>(effect: Effect.Effect<A, E>): Promise<E> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error("expected a typed failure, got a defect or an interruption")
  return error.error
}

describe("Storage port", () => {
  test("storage-port: an invalid read fails only that read, as a typed StorageRequestError", async () => {
    const storage = await open()
    await Effect.runPromise(storage.commit([[{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }]], () => {}))

    const unknown = idFromNumber<ConversationId>(99)
    const invalid = await failure(storage.scanEntries({ conversationId: unknown }, 10, undefined))
    expect(invalid).toBeInstanceOf(StorageRequestError)
    expect(invalid.message).toBe("Unknown conversation: 99")
    const badCursor = await failure(storage.scanTasks({}, 10, { after: "x" }))
    expect(badCursor).toBeInstanceOf(StorageRequestError)

    // The storage still works after both.
    expect(await Effect.runPromise(storage.conversation(ROOT_CONVERSATION_ID))).toEqual({ id: ROOT_CONVERSATION_ID })
    await Effect.runPromise(storage.close())
  })

  test("storage-port: a refused batch is a CommitRefused result, not a failure, and the batches before it are stored", async () => {
    const storage = await open()
    const entry = idFromNumber<EntryId>(2)
    const receipts: number[] = []
    const result = await Effect.runPromise(
      storage.commit(
        [
          [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }],
          [{ type: "entry", value: { id: entry, conversationId: ROOT_CONVERSATION_ID, kind: "note" } }],
          [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }],
        ],
        (index) => receipts.push(index),
      ),
    )
    expect(result.stored).toBe(2)
    expect(result.refused).toBeInstanceOf(CommitRefused)
    expect(result.refused?.message).toBe("ID 1 already belongs to conversation")
    expect(receipts).toEqual([0, 1])
    expect((await Effect.runPromise(storage.entry(entry)))?.commitSeq).toBe(seqFromNumber(2))
    await Effect.runPromise(storage.close())
  })

  test("storage-port: a closed storage fails every call with StorageError, and closing again waits for the same close", async () => {
    const storage = await open()
    const closing = Effect.runPromise(storage.close())
    await Effect.runPromise(storage.close())
    await closing
    const closed = await failure(storage.mintId())
    expect(closed).toBeInstanceOf(StorageError)
    expect(closed.message).toBe("SqliteStorage is closed")
    expect(await failure(storage.task(idFromNumber(5)))).toBeInstanceOf(StorageError)
  })

  test("storage-port: close waits for a read underway, and the read completes", async () => {
    const { storage } = await openOver()
    await Effect.runPromise(storage.commit([[{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }]], () => {}))
    // The scan reads the conversation, then its entries. A fiber that yields every few operations, as a busy runtime
    // does, lets the close in between the two queries; a budget under 3 never gets past its own yield.
    const reading = Effect.runPromise(
      storage
        .scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined)
        .pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 3)),
    )
    const closing = Effect.runPromise(storage.close())
    expect((await reading).items).toEqual([])
    await closing
  })

  test("storage-port: a close whose first caller is interrupted still completes for the next caller", async () => {
    const { storage, hold } = await openOver()
    const release = await hold()
    const reading = Effect.runPromise(storage.task(idFromNumber(7)))
    await Effect.runPromise(Fiber.interrupt(Effect.runFork(storage.close())))
    release()
    expect(await reading).toBeUndefined()
    await Effect.runPromise(storage.close())
  })

  test("storage-port: an open interrupted while it migrates closes the database it was given", async () => {
    const database = await Effect.runPromise(openSqliteDatabase(join(home(), "kernel.sqlite")))
    const release = await holdTransaction(database)
    const opening = Effect.runFork(SqliteStorage.open(database))
    // The interruption waits for the cleanup, and the cleanup for the transaction holding the database.
    const interrupted = Effect.runPromise(Fiber.interrupt(opening))
    release()
    await interrupted
    expect(await failure(database.all("SELECT 1"))).toBeInstanceOf(StorageError)
  })
})

const home = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "sigma-kernel-"))
  homes.push(directory)
  return directory
}

/**
 * Opens a transaction on `database` that stays open until the returned `release` is called. The database runs one
 * call at a time, so every storage query waits for it meanwhile.
 */
const holdTransaction = async (database: SqliteDatabase): Promise<() => void> => {
  const started = Promise.withResolvers<void>()
  const release = Deferred.makeUnsafe<void>()
  void Effect.runPromise(
    database.transaction(() => Effect.andThen(Effect.sync(started.resolve), Deferred.await(release))),
  )
  await started.promise
  return () => Deferred.doneUnsafe(release, Effect.void)
}

/** Storage over a real SQLite database, and a way to hold that database while storage calls are underway. */
const openOver = async () => {
  const database = await Effect.runPromise(openSqliteDatabase(join(home(), "kernel.sqlite")))
  const storage = await Effect.runPromise(SqliteStorage.open(database))
  return { storage, hold: () => holdTransaction(database) }
}
