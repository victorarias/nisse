// The SQLite facade's transactions as the Effect runtime drives them: interruption is something the Promise adapter
// cannot produce.
import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { openSqliteDatabase } from "../src/index.ts"

test("storage-sqlite-facade: an interrupted transaction rolls back and leaves the connection free for the next one", async () => {
  const database = await Effect.runPromise(openSqliteDatabase(":memory:"))
  await Effect.runPromise(database.exec("CREATE TABLE notes (text TEXT)"))
  const started = Promise.withResolvers<void>()
  const fiber = Effect.runFork(
    database.transaction((transaction) =>
      Effect.andThen(
        transaction.run("INSERT INTO notes (text) VALUES ('interrupted')"),
        Effect.andThen(
          Effect.sync(() => started.resolve()),
          Effect.never,
        ),
      ),
    ),
  )
  await started.promise
  await Effect.runPromise(Fiber.interrupt(fiber))

  await Effect.runPromise(
    database.transaction((transaction) => transaction.run("INSERT INTO notes (text) VALUES ('next')")),
  )
  expect(await Effect.runPromise(database.all("SELECT text FROM notes"))).toEqual([{ text: "next" }])
  await Effect.runPromise(database.close())
})

test("storage-sqlite-facade: calls during a suspended transaction wait for it, and never see its writes", async () => {
  const database = await Effect.runPromise(openSqliteDatabase(":memory:"))
  await Effect.runPromise(database.exec("CREATE TABLE notes (text TEXT)"))
  const started = Promise.withResolvers<void>()
  const release = Deferred.makeUnsafe<void>()
  const rolledBack = Effect.runPromiseExit(
    database.transaction((transaction) =>
      transaction
        .run("INSERT INTO notes (text) VALUES ('rolled back')")
        .pipe(
          Effect.andThen(Effect.sync(() => started.resolve())),
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.fail("body failed")),
        ),
    ),
  )
  await started.promise
  const read = Effect.runPromise(database.all("SELECT text FROM notes"))
  const next = Effect.runPromise(
    database.transaction((transaction) => transaction.run("INSERT INTO notes (text) VALUES ('next')")),
  )
  Deferred.doneUnsafe(release, Effect.void)

  expect((await rolledBack)._tag).toBe("Failure")
  expect(await read).toEqual([])
  await next
  expect(await Effect.runPromise(database.all("SELECT text FROM notes"))).toEqual([{ text: "next" }])
  await Effect.runPromise(database.close())
})
