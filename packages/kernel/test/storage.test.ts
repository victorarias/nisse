// The Storage port as the Session consumes it: Effects whose failures are typed. The conformance suite runs storage
// through a Promise adapter, which turns these failures into thrown values, so it cannot show which channel they use.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import {
  CommitRefused,
  type ConversationId,
  type EntryId,
  idFromNumber,
  openSqliteStorage,
  ROOT_CONVERSATION_ID,
  seqFromNumber,
  type SqliteStorage,
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
})
