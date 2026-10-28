import type { Database } from "bun:sqlite"

const v1 = [
  `CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    live TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE commits (seq INTEGER PRIMARY KEY, conversation TEXT NOT NULL, body TEXT NOT NULL)`,
  `CREATE INDEX commits_by_conversation ON commits (conversation, seq)`,
  `CREATE TABLE entries (id TEXT PRIMARY KEY, conversation TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL)`,
  `CREATE INDEX entries_by_conversation ON entries (conversation, seq)`,
  `CREATE TABLE submissions (
    id TEXT PRIMARY KEY,
    conversation TEXT NOT NULL,
    request_id TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    placed_seq INTEGER,
    UNIQUE (conversation, request_id)
  )`,
  `CREATE INDEX submissions_waiting ON submissions (conversation) WHERE placed_seq IS NULL`,
]

interface V1Entry {
  id: string
  seq: number
  at: number
  author: unknown
  body: { _tag: string; text?: string; interrupted?: boolean; message?: string; outcome?: string }
}

const splitV1Entry = (entry: V1Entry): Array<V1Entry> => {
  const body = entry.body
  if (body._tag === "answer") {
    const message = body.text ? [{ ...entry, body: { _tag: "message", text: body.text } }] : []
    const outcome = body.interrupted ? "interrupted" : "answered"
    return [...message, { ...entry, id: `${entry.id}-end`, body: { _tag: "run_end", outcome } }]
  }
  if (body._tag === "run_failed") {
    const message = body.message === undefined ? {} : { message: body.message }
    return [{ ...entry, body: { _tag: "run_end", outcome: "failed", ...message } }]
  }
  return [entry]
}

const toV2 = (db: Database) => {
  db.run("ALTER TABLE conversations ADD COLUMN provider TEXT NOT NULL DEFAULT 'script'")
  db.run("ALTER TABLE conversations ADD COLUMN approvals TEXT NOT NULL DEFAULT 'ask'")
  db.run("ALTER TABLE conversations ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")
  db.run("ALTER TABLE conversations ADD COLUMN provider_state TEXT")
  db.run("UPDATE conversations SET live = json_object('text', live, 'output', json('{}'))")
  db.run("ALTER TABLE submissions ADD COLUMN steer INTEGER NOT NULL DEFAULT 0")
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    conversation TEXT NOT NULL,
    call TEXT NOT NULL,
    answered_seq INTEGER
  )`)

  const entries = db.query<{ body: string; conversation: string }, []>("SELECT body, conversation FROM entries").all()
  db.run("DELETE FROM entries")
  for (const row of entries) {
    for (const entry of splitV1Entry(JSON.parse(row.body))) {
      db.run("INSERT INTO entries (id, conversation, seq, body) VALUES (?, ?, ?, ?)", [
        entry.id,
        row.conversation,
        entry.seq,
        JSON.stringify(entry),
      ])
    }
  }

  const commits = db.query<{ seq: number; body: string }, []>("SELECT seq, body FROM commits").all()
  for (const row of commits) {
    const commit = JSON.parse(row.body)
    commit.entries = commit.entries.flatMap(splitV1Entry)
    if (commit.live) {
      commit.live = commit.live._tag === "append" ? [{ _tag: "text", append: commit.live.text }] : [{ _tag: "clear" }]
    }
    if (commit.enqueued) commit.enqueued.steer = false
    db.run("UPDATE commits SET body = ? WHERE seq = ?", [JSON.stringify(commit), row.seq])
  }
}

const migrations: Array<(db: Database) => void> = [
  (db) => {
    for (const statement of v1) db.run(statement)
  },
  toV2,
]

export const migrate = (db: Database) => {
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0
  if (version > migrations.length) {
    throw new Error(`this store is version ${version}, newer than this nisse understands (${migrations.length})`)
  }
  db.transaction(() => {
    for (let next = version; next < migrations.length; next++) migrations[next]!(db)
    db.run(`PRAGMA user_version = ${migrations.length}`)
  })()
}
