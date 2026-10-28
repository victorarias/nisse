import { Database } from "bun:sqlite"
import { mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"

export interface Home {
  readonly dir: string
  readonly database: string
  readonly socket: string
  readonly lock: string
  readonly log: string
}

export const homeAt = (dir: string): Home => ({
  dir,
  database: join(dir, "nisse.sqlite"),
  socket: join(dir, "nisse.sock"),
  lock: join(dir, "nisse.lock"),
  log: join(dir, "nisse.log"),
})

export const defaultHome = () => homeAt(process.env.NISSE_HOME ?? join(homedir(), ".nisse"))

export class HomeTaken extends Schema.TaggedError<HomeTaken>()("HomeTaken", { dir: Schema.String }) {}

const tryLock = (home: Home) => {
  mkdirSync(home.dir, { recursive: true, mode: 0o700 })
  const lock = new Database(home.lock, { create: true })
  try {
    lock.run("PRAGMA busy_timeout = 0")
    lock.run("PRAGMA locking_mode = EXCLUSIVE")
    lock.run("BEGIN EXCLUSIVE")
    return lock
  } catch {
    lock.close()
    return undefined
  }
}

export const claimHome = (home: Home) =>
  Effect.acquireRelease(
    Effect.suspend(() => {
      const lock = tryLock(home)
      if (!lock) return Effect.fail(new HomeTaken({ dir: home.dir }))
      rmSync(home.socket, { force: true })
      return Effect.succeed(lock)
    }),
    (lock) =>
      Effect.sync(() => {
        rmSync(home.socket, { force: true })
        lock.close()
      }),
  )
