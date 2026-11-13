import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { createConnection } from "node:net"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Console, Effect, Schedule, Schema } from "effect"

export interface Home {
  readonly dir: string
  /** The kernel's database, marked as sigma's in its header. */
  readonly database: string
  readonly socket: string
  readonly lock: string
  /** Held by `sigma serve --restart` while it replaces the running server; see `replaceServer`. */
  readonly nextLock: string
  readonly log: string
  readonly extensions: string
}

export const homeAt = (dir: string): Home => ({
  dir,
  database: join(dir, "kernel.sqlite"),
  socket: join(dir, "sigma.sock"),
  lock: join(dir, "sigma.lock"),
  nextLock: join(dir, "sigma.next.lock"),
  log: join(dir, "sigma.log"),
  extensions: join(dir, "extensions"),
})

export const defaultHome = () => homeAt(resolve(process.env.SIGMA_HOME ?? join(homedir(), ".sigma")))

export class HomeTaken extends Schema.TaggedError<HomeTaken>()("HomeTaken", { dir: Schema.String }) {}

/** A home another program uses: its database was not written by sigma, or another program serves its socket. */
export class ForeignHome extends Schema.TaggedError<ForeignHome>()("ForeignHome", { reason: Schema.String }) {}

/**
 * Marks `kernel.sqlite` as sigma's in the SQLite header ("SGMA"). Another program can use the same home: the harness attn
 * calls Sigma, a fork of Pi, defaults to `~/.sigma` and `sigma.sock` too, and stores pi-durable's tables, which the
 * kernel would read as its own.
 */
const APPLICATION_ID = 0x53474d41

const elsewhere = "Point SIGMA_HOME at a folder of sigma's own."

/** Marks a new database as sigma's, or refuses one sigma did not write. */
const ownDatabase = (home: Home) =>
  Effect.suspend(() => {
    const created = !existsSync(home.database)
    const database = new Database(home.database, { create: true })
    try {
      if (created) database.run(`PRAGMA application_id = ${APPLICATION_ID}`)
      const { application_id } = database.query("PRAGMA application_id").get() as { application_id: number }
      return application_id === APPLICATION_ID
        ? Effect.void
        : Effect.fail(new ForeignHome({ reason: `${home.database} was not written by sigma. ${elsewhere}` }))
    } finally {
      database.close()
    }
  })

/**
 * Removes the socket a stopped server left behind. A server of this home holds its lock, so with the lock held, a socket
 * that still answers belongs to another program, which would lose its clients if sigma took the path.
 */
const clearSocket = (home: Home) =>
  Effect.flatMap(answers(home.socket), (answered) =>
    answered
      ? Effect.fail(new ForeignHome({ reason: `another program serves ${home.socket}. ${elsewhere}` }))
      : Effect.sync(() => rmSync(home.socket, { force: true })),
  )

/**
 * Whether something listens on the socket at `path`. Only a refused connection says nothing does: a listener that hangs up
 * at once reaches the client as a reset.
 */
const answers = (path: string) =>
  Effect.callback<boolean>((resume) => {
    if (!existsSync(path)) return resume(Effect.succeed(false))
    const socket = createConnection(path)
    const answered = (yes: boolean) => {
      socket.destroy()
      resume(Effect.succeed(yes))
    }
    socket.once("connect", () => answered(true))
    socket.once("error", (error: NodeJS.ErrnoException) => answered(!NOBODY_LISTENS.has(error.code ?? "")))
    return Effect.sync(() => socket.destroy())
  })

const NOBODY_LISTENS = new Set(["ECONNREFUSED", "ENOENT"])

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
    Effect.suspend((): Effect.Effect<Database, HomeTaken | ForeignHome> => {
      const lock = tryLock(home.dir, home.lock, LOCK_WAIT_MS)
      if (!lock) return Effect.fail(new HomeTaken({ dir: home.dir }))
      if (giveWay && replacing(home)) {
        lock.close()
        return Effect.fail(new HomeTaken({ dir: home.dir }))
      }
      return Effect.andThen(clearSocket(home), ownDatabase(home)).pipe(
        Effect.as(lock),
        Effect.tapError(() => Effect.sync(() => lock.close())),
      )
    }),
    (lock) =>
      Effect.sync(() => {
        rmSync(home.socket, { force: true })
        lock.close()
      }),
  )

/** Whether a `sigma serve --restart` is replacing the home's server now. */
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
 * How long a restart waits for the home after its last stop reached a server: past the time that server takes to close,
 * since `stop` already waited for its runs to settle. A restart that reaches no server waits this long from its start.
 */
const REPLACE_WAIT_MS = 30_000

/**
 * The home, taken over from the server that holds it: `stop` stops that server when one answers and says whether it
 * did, then this process claims the home once it is let go. A client that loses the stopped server starts a server of
 * its own, and that server would race this one for the home, so the restart holds the home's next lock from before the
 * stop until it holds the home, and a server started meanwhile gives way to it (`claimHome`). A server that took the
 * home before the restart may start answering only after the first stop, so each attempt on the home stops again.
 */
export const replaceServer = <R>(home: Home, stop: Effect.Effect<boolean, never, R>) =>
  Effect.acquireUseRelease(
    Effect.suspend(() => {
      const next = tryLock(home.dir, home.nextLock, LOCK_WAIT_MS)
      return next ? Effect.succeed(next) : Effect.fail(new HomeTaken({ dir: home.dir }))
    }).pipe(
      Effect.retry({ schedule: Schedule.spaced("100 millis").pipe(Schedule.upTo({ duration: REPLACE_WAIT_MS })) }),
    ),
    () =>
      Effect.suspend(() => {
        let deadline = Date.now() + REPLACE_WAIT_MS
        let waiting = false
        return Effect.flatMap(stop, (stopped) => {
          if (stopped) deadline = Date.now() + REPLACE_WAIT_MS
          return lockHome(home)
        }).pipe(
          Effect.tapError((error) => {
            if (waiting || error._tag !== "HomeTaken") return Effect.void
            waiting = true
            return Console.error(`waiting for the server that holds ${home.dir} to stop`)
          }),
          Effect.retry({
            schedule: Schedule.spaced("100 millis"),
            while: (error) => error._tag === "HomeTaken" && Date.now() < deadline,
          }),
        )
      }),
    (next) => Effect.sync(() => next.close()),
  )
