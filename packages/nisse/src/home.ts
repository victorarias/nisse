import { Database } from "bun:sqlite"
import { mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Schema } from "effect"

export interface Home {
  readonly dir: string
  readonly database: string
  /** The kernel's database, which a server under NISSE_KERNEL=1 uses; it ignores `database`. */
  readonly kernel: string
  readonly socket: string
  readonly lock: string
  readonly log: string
  readonly extensions: string
}

export const homeAt = (dir: string): Home => ({
  dir,
  database: join(dir, "store.sqlite"),
  kernel: join(dir, "kernel.sqlite"),
  socket: join(dir, "nisse.sock"),
  lock: join(dir, "nisse.lock"),
  log: join(dir, "nisse.log"),
  extensions: join(dir, "extensions"),
})

export const defaultHome = () => homeAt(resolve(process.env.NISSE_HOME ?? join(homedir(), ".nisse")))

export class HomeTaken extends Schema.TaggedError<HomeTaken>()("HomeTaken", { dir: Schema.String }) {}

/**
 * How long a claim waits out another process touching the lock. Other servers' claims and their failed attempts touch it
 * for well under 2 ms (measured: max 1.6 ms over 2000 attempts under CPU load), so only a server that holds the home
 * outlasts this wait.
 */
const LOCK_WAIT_MS = 1000

/** The exit code of a server that refuses its home because another server holds it. */
export const HOME_TAKEN_EXIT = 75

const tryLock = (home: Home) => {
  mkdirSync(home.dir, { recursive: true, mode: 0o700 })
  const lock = new Database(home.lock, { create: true })
  try {
    lock.run(`PRAGMA busy_timeout = ${LOCK_WAIT_MS}`)
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
