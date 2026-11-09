// The Storage port as the Session consumes it: Effects whose failures are typed. The conformance suite runs storage
// through a Promise adapter, which turns these failures into thrown values, so it cannot show which channel they use.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import {
  CommitRefused,
  type ConversationId,
  type DocumentId,
  type EntryId,
  idFromNumber,
  openSqliteStorage,
  ROOT_CONVERSATION_ID,
  seqFromNumber,
  openSqliteDatabase,
  type SqliteDatabase,
  type SqliteExecutor,
  type SqliteValue,
  SqliteStorage,
  StorageError,
  StorageRequestError,
} from "../src/index.ts"

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const open = (): Promise<SqliteStorage> => {
  const home = mkdtempSync(join(tmpdir(), "nisse-kernel-"))
  homes.push(home)
  return Effect.runPromise(openSqliteStorage(join(home, "kernel.sqlite")))
}

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

  test("storage-port: close waits for a document read underway, and the read completes", async () => {
    const { storage, database, log } = await held()
    const reading = Effect.runPromise(storage.document(DOCUMENT, "current"))
    await database.reached.promise
    const closing = Effect.runPromise(storage.close())
    log.push("released")
    Deferred.doneUnsafe(database.release, Effect.void)
    expect((await reading)?.record.id).toBe(DOCUMENT)
    await closing
    expect(log).toEqual(["released", "closed"])
  })

  test("storage-port: a close whose first caller is interrupted still completes for the next caller", async () => {
    const { storage, database, log } = await held()
    const reading = Effect.runPromise(storage.document(DOCUMENT, "current"))
    await database.reached.promise
    await Effect.runPromise(Fiber.interrupt(Effect.runFork(storage.close())))
    Deferred.doneUnsafe(database.release, Effect.void)
    await reading
    await Effect.runPromise(storage.close())
    expect(log).toEqual(["closed"])
  })
})

const DOCUMENT = idFromNumber<DocumentId>(2)

/**
 * Storage over a database whose next transaction suspends at its first query until `release`, as a database on another
 * runtime may: storage holding one document, and a log of when the database closed.
 */
const held = async () => {
  const real = await Effect.runPromise(openSqliteDatabase(":memory:"))
  const log: string[] = []
  const reached = Promise.withResolvers<void>()
  const release = Deferred.makeUnsafe<void>()
  let armed = false
  const pause = Effect.suspend(() => {
    if (!armed) return Effect.void
    armed = false
    reached.resolve()
    return Deferred.await(release)
  })
  const holding = (executor: SqliteExecutor): SqliteExecutor => ({
    exec: (sql) => Effect.andThen(pause, executor.exec(sql)),
    run: (sql, ...params) => Effect.andThen(pause, executor.run(sql, ...params)),
    runCounted: (sql, ...params) => Effect.andThen(pause, executor.runCounted(sql, ...params)),
    get: <T extends object>(sql: string, ...params: SqliteValue[]) =>
      Effect.andThen(pause, executor.get<T>(sql, ...params)),
    all: <T extends object>(sql: string, ...params: SqliteValue[]) =>
      Effect.andThen(pause, executor.all<T>(sql, ...params)),
  })
  const database: SqliteDatabase = {
    ...holding(real),
    transaction: (body) => real.transaction((transaction) => body(holding(transaction))),
    close: () =>
      Effect.andThen(
        real.close(),
        Effect.sync(() => log.push("closed")),
      ),
  }
  const storage = await Effect.runPromise(SqliteStorage.open(database))
  await Effect.runPromise(
    storage.commit(
      [
        [
          {
            type: "document.create",
            record: { id: DOCUMENT, kind: "note", scope: { kind: "session" } },
            content: { version: 1, kind: "base", value: { text: "kept" } },
          },
        ],
      ],
      () => {},
    ),
  )
  armed = true
  return { storage, database: { reached, release }, log }
}
