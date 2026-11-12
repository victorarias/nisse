import { Database } from "bun:sqlite"
import { mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Schedule, Schema } from "effect"

export interface Home {
  readonly dir: string
  /** The kernel's database. A `store.sqlite` an earlier nisse left beside it is ignored. */
  readonly database: string
  readonly socket: string
  readonly lock: string
  /** Held by `nisse serve --restart` while it replaces the running server; see `replaceServer`. */
  readonly nextLock: string
  readonly log: string
  readonly extensions: string
}

export const homeAt = (dir: string): Home => ({
  dir,
  database: join(dir, "kernel.sqlite"),
  socket: join(dir, "nisse.sock"),
  lock: join(dir, "nisse.lock"),
  nextLock: join(dir, "nisse.next.lock"),
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

const tryLock = (dir: string, path: string, waitMs: number) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const lock = new Database(path, { create: true })
  try {
    lock.run(`PRAGMA busy_timeout = ${waitMs}`)
    lock.run("PRAGMA locking_mode = EXCLUSIVE")
    lock.run("BEGIN EXCLUSIVE")
    return lock
  } catch {
    lock.close()
    return undefined
  }
}

/** The home's lock; with `giveWay`, refused while a restart replaces the server, as `claimHome` describes. */
const lockHome = (home: Home, giveWay = false) =>
  Effect.acquireRelease(
    Effect.suspend(() => {
      const lock = tryLock(home.dir, home.lock, LOCK_WAIT_MS)
      if (!lock) return Effect.fail(new HomeTaken({ dir: home.dir }))
      if (giveWay && replacing(home)) {
        lock.close()
        return Effect.fail(new HomeTaken({ dir: home.dir }))
      }
      rmSync(home.socket, { force: true })
      return Effect.succeed(lock)
    }),
    (lock) =>
      Effect.sync(() => {
        rmSync(home.socket, { force: true })
        lock.close()
      }),
  )

/** Whether a `nisse serve --restart` is replacing the home's server now. */
const replacing = (home: Home) => {
  const next = tryLock(home.dir, home.nextLock, 0)
  next?.close()
  return next === undefined
}

/**
 * The home, for this process to serve; a server is taken to hold it while a restart replaces the server. The restart is
 * looked for once the home's lock is held: a claim waits up to `LOCK_WAIT_MS` for the lock, and a restart that starts
 * meanwhile releases the home to whoever waits, so a look before the wait would let this process take the home the
 * restart is replacing the server for.
 */
export const claimHome = (home: Home) => lockHome(home, true)

/**
 * How long a restart waits for the server it stopped to let go of the home: past the time its runs take to settle,
 * which `stop` already waited for, and its close.
 */
const REPLACE_WAIT = "30 seconds"

/**
 * The home, taken over from the server that holds it: `stop` stops that server, then this process claims the home once
 * it is let go. A client that loses the stopped server starts a server of its own, and that server would race this one
 * for the home, so the restart holds the home's next lock from before the stop until it holds the home, and a server
 * started meanwhile gives way to it (`claimHome`).
 */
export const replaceServer = <R>(home: Home, stop: Effect.Effect<void, never, R>) =>
  Effect.acquireUseRelease(
    Effect.suspend(() => {
      const next = tryLock(home.dir, home.nextLock, LOCK_WAIT_MS)
      return next ? Effect.succeed(next) : Effect.fail(new HomeTaken({ dir: home.dir }))
    }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis").pipe(Schedule.upTo({ duration: REPLACE_WAIT })) })),
    () =>
      Effect.andThen(
        stop,
        lockHome(home).pipe(
          Effect.retry({ schedule: Schedule.spaced("100 millis").pipe(Schedule.upTo({ duration: REPLACE_WAIT })) }),
        ),
      ),
    (next) => Effect.sync(() => next.close()),
  )
