// The SQLite facade's transactions as the Effect runtime drives them: interruption is something the Promise adapter
// cannot produce.
import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
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
