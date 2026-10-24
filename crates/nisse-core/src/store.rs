use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use nisse_protocol::{
    Actor, Commit, Conversation, ConversationStatus, ConversationSubmitResult, Entry, Input,
    ModelSelection, Seq, SubmissionStatus, WhenBusy, kinds,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::Value;

use crate::{new_id, now_ms, workspace::AttachedSkill};

const SCHEMA_VERSION: i64 = 5;

/// One SQLite file. Every change goes through `commit`, which is atomic and gets the next `seq`.
pub struct Store {
    db: Connection,
}

pub struct Submission {
    pub id: String,
    pub conversation_id: String,
    pub status: SubmissionStatus,
    pub when_busy: WhenBusy,
    pub input: Input,
    pub skills: Vec<AttachedSkill>,
    pub author: Actor,
}

pub struct NewConversation {
    pub title: Option<String>,
    pub creator: Actor,
    pub cwd: PathBuf,
    pub selection: ModelSelection,
}

pub struct Tx<'a> {
    tx: Transaction<'a>,
    seq: Seq,
    conversation_id: String,
    entries: Vec<Entry>,
    status: Option<ConversationStatus>,
    live: Option<String>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "NORMAL")?;
        Self::migrate(db)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::migrate(Connection::open_in_memory()?)
    }

    fn migrate(db: Connection) -> Result<Self> {
        let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            bail!("store schema {version} is newer than this nisse ({SCHEMA_VERSION})");
        }
        if version < 1 {
            db.execute_batch(
                "BEGIN;
                CREATE TABLE commits (seq INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL);
                CREATE TABLE conversations (
                    id TEXT PRIMARY KEY, title TEXT, creator TEXT NOT NULL,
                    status TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
                CREATE TABLE entries (
                    id TEXT PRIMARY KEY, seq INTEGER NOT NULL, conversation_id TEXT NOT NULL,
                    kind TEXT NOT NULL, author TEXT NOT NULL, data TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL);
                CREATE INDEX entries_by_conversation ON entries (conversation_id, seq);
                CREATE TABLE submissions (
                    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, request_id TEXT NOT NULL,
                    status TEXT NOT NULL, when_busy TEXT NOT NULL, input TEXT NOT NULL,
                    author TEXT NOT NULL, seq INTEGER NOT NULL,
                    UNIQUE (conversation_id, request_id));
                PRAGMA user_version = 1;
                COMMIT;",
            )?;
        }
        if version < 2 {
            db.execute_batch(
                "BEGIN;
                ALTER TABLE conversations ADD COLUMN live TEXT NOT NULL DEFAULT '';
                ALTER TABLE conversations ADD COLUMN provider_state TEXT NOT NULL DEFAULT 'null';
                PRAGMA user_version = 2;
                COMMIT;",
            )?;
        }
        if version < 3 {
            db.execute_batch(
                "BEGIN;
                ALTER TABLE conversations ADD COLUMN cwd TEXT NOT NULL DEFAULT '/';
                ALTER TABLE conversations ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
                ALTER TABLE conversations ADD COLUMN model TEXT;
                PRAGMA user_version = 3;
                COMMIT;",
            )?;
        }
        if version < 4 {
            db.execute_batch(
                "BEGIN;
                ALTER TABLE submissions ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
                PRAGMA user_version = 4;
                COMMIT;",
            )?;
        }
        if version < 5 {
            db.execute_batch(
                "BEGIN;
                ALTER TABLE conversations ADD COLUMN effort TEXT;
                ALTER TABLE conversations ADD COLUMN state_provider TEXT;
                UPDATE conversations SET state_provider = provider;
                CREATE INDEX entries_by_kind ON entries (kind, seq);
                PRAGMA user_version = 5;
                COMMIT;",
            )?;
        }
        Ok(Self { db })
    }

    pub fn commit<T>(
        &mut self,
        conversation_id: &str,
        write: impl FnOnce(&mut Tx<'_>) -> Result<T>,
    ) -> Result<(T, Commit)> {
        let tx = self.db.transaction()?;
        tx.execute("INSERT INTO commits (at_ms) VALUES (?1)", [now_ms()])?;
        let seq = tx.last_insert_rowid() as Seq;
        let mut writer = Tx {
            tx,
            seq,
            conversation_id: conversation_id.to_owned(),
            entries: Vec::new(),
            status: None,
            live: None,
        };
        let value = write(&mut writer)?;
        let Tx {
            tx,
            entries,
            status,
            live,
            ..
        } = writer;
        tx.commit()?;
        Ok((
            value,
            Commit {
                seq,
                conversation_id: conversation_id.to_owned(),
                entries,
                status,
                live,
            },
        ))
    }

    pub fn head(&self) -> Result<Seq> {
        Ok(self
            .db
            .query_row("SELECT COALESCE(MAX(seq), 0) FROM commits", [], |row| {
                row.get(0)
            })?)
    }

    pub fn conversation(&self, id: &str) -> Result<Option<Conversation>> {
        self.db
            .query_row(
                &format!("SELECT {CONVERSATION_COLUMNS} FROM conversations WHERE id = ?1"),
                [id],
                conversation_from_row,
            )
            .optional()?
            .transpose()
    }

    pub fn conversations(&self) -> Result<Vec<Conversation>> {
        let mut statement = self.db.prepare(&format!(
            "SELECT {CONVERSATION_COLUMNS} FROM conversations ORDER BY id DESC"
        ))?;
        let rows = statement.query_map([], conversation_from_row)?;
        rows.map(|row| row?).collect()
    }

    /// The newest model anyone switched a conversation to.
    pub fn last_selection(&self) -> Result<Option<ModelSelection>> {
        let data: Option<String> = self
            .db
            .query_row(
                "SELECT data FROM entries WHERE kind = ?1 ORDER BY seq DESC LIMIT 1",
                [kinds::MODEL],
                |row| row.get(0),
            )
            .optional()?;
        Ok(data.map(|data| serde_json::from_str(&data)).transpose()?)
    }

    pub fn live(&self, conversation_id: &str) -> Result<String> {
        Ok(self.db.query_row(
            "SELECT live FROM conversations WHERE id = ?1",
            [conversation_id],
            |row| row.get(0),
        )?)
    }

    pub fn provider_state(&self, conversation_id: &str) -> Result<Value> {
        let state: String = self.db.query_row(
            "SELECT provider_state FROM conversations WHERE id = ?1",
            [conversation_id],
            |row| row.get(0),
        )?;
        Ok(serde_json::from_str(&state)?)
    }

    pub fn entries(&self, conversation_id: &str, since_seq: Seq) -> Result<Vec<Entry>> {
        entries_since(&self.db, conversation_id, since_seq)
    }

    pub fn submission_by_request(
        &self,
        conversation_id: &str,
        request_id: &str,
    ) -> Result<Option<Submission>> {
        self.submissions_where(BY_REQUEST, params![conversation_id, request_id])
            .map(|mut found| found.pop())
    }

    /// The submission a run is answering, then the queued ones, oldest first.
    pub fn open_submissions(&self, conversation_id: &str) -> Result<Vec<Submission>> {
        self.submissions_where(OPEN_SUBMISSIONS, params![conversation_id])
    }

    pub fn conversations_with_open_submissions(&self) -> Result<Vec<String>> {
        let mut statement = self.db.prepare(
            "SELECT DISTINCT conversation_id FROM submissions WHERE status IN ('placed', 'queued')",
        )?;
        let rows = statement.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn submissions_where(
        &self,
        condition: &str,
        values: impl rusqlite::Params,
    ) -> Result<Vec<Submission>> {
        submissions_where(&self.db, condition, values)
    }
}

impl Tx<'_> {
    pub fn create_conversation(&mut self, start: NewConversation) -> Result<Conversation> {
        let conversation = Conversation {
            id: self.conversation_id.clone(),
            title: start.title,
            creator: start.creator,
            status: ConversationStatus::Idle,
            created_at_ms: now_ms(),
            cwd: start.cwd,
            selection: start.selection,
        };
        self.tx.execute(
            &format!(
                "INSERT INTO conversations ({CONVERSATION_COLUMNS}, state_provider)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?7)"
            ),
            params![
                conversation.id,
                conversation.title,
                serde_json::to_string(&conversation.creator)?,
                to_text(&conversation.status)?,
                conversation.created_at_ms,
                conversation
                    .cwd
                    .to_str()
                    .context("the directory is not UTF-8")?,
                conversation.selection.provider,
                conversation.selection.model,
                conversation.selection.effort,
            ],
        )?;
        self.status = Some(ConversationStatus::Idle);
        Ok(conversation)
    }

    pub fn conversation(&self) -> Result<Conversation> {
        self.tx
            .query_row(
                &format!("SELECT {CONVERSATION_COLUMNS} FROM conversations WHERE id = ?1"),
                [&self.conversation_id],
                conversation_from_row,
            )
            .with_context(|| format!("no conversation {}", self.conversation_id))?
    }

    pub fn set_selection(&mut self, selection: &ModelSelection) -> Result<()> {
        self.tx.execute(
            "UPDATE conversations SET provider = ?1, model = ?2, effort = ?3 WHERE id = ?4",
            params![
                selection.provider,
                selection.model,
                selection.effort,
                self.conversation_id
            ],
        )?;
        Ok(())
    }

    /// Hands the provider state to the conversation's provider, as a run starts, and says
    /// whether another provider held it. A provider keeps its state only while it alone has
    /// answered since it saved it.
    pub fn claim_provider_state(&mut self) -> Result<bool> {
        let changed = self.tx.execute(
            "UPDATE conversations SET provider_state = 'null', state_provider = provider
             WHERE id = ?1 AND state_provider IS NOT provider",
            [&self.conversation_id],
        )?;
        Ok(changed > 0)
    }

    pub fn append(&mut self, kind: &str, author: &Actor, data: Value) -> Result<Entry> {
        let entry = Entry {
            id: new_id(),
            seq: self.seq,
            conversation_id: self.conversation_id.clone(),
            kind: kind.to_owned(),
            author: author.clone(),
            data,
            created_at_ms: now_ms(),
        };
        self.tx.execute(
            "INSERT INTO entries (id, seq, conversation_id, kind, author, data, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                entry.id,
                entry.seq,
                entry.conversation_id,
                entry.kind,
                serde_json::to_string(&entry.author)?,
                serde_json::to_string(&entry.data)?,
                entry.created_at_ms
            ],
        )?;
        self.entries.push(entry.clone());
        Ok(entry)
    }

    pub fn set_status(&mut self, status: ConversationStatus) -> Result<()> {
        self.tx.execute(
            "UPDATE conversations SET status = ?1 WHERE id = ?2",
            params![to_text(&status)?, self.conversation_id],
        )?;
        self.status = Some(status);
        Ok(())
    }

    pub fn set_live(&mut self, text: &str) -> Result<()> {
        self.tx.execute(
            "UPDATE conversations SET live = ?1 WHERE id = ?2",
            params![text, self.conversation_id],
        )?;
        self.live = Some(text.to_owned());
        Ok(())
    }

    /// What a provider keeps to pick a conversation up again, such as Claude's session.
    pub fn set_provider_state(&mut self, state: &Value) -> Result<()> {
        self.tx.execute(
            "UPDATE conversations SET provider_state = ?1 WHERE id = ?2",
            params![serde_json::to_string(state)?, self.conversation_id],
        )?;
        Ok(())
    }

    pub fn open_submissions(&self) -> Result<Vec<Submission>> {
        submissions_where(&self.tx, OPEN_SUBMISSIONS, params![self.conversation_id])
    }

    pub fn submission_by_request(
        &self,
        request_id: &str,
    ) -> Result<Option<ConversationSubmitResult>> {
        Ok(submissions_where(
            &self.tx,
            BY_REQUEST,
            params![self.conversation_id, request_id],
        )?
        .pop()
        .map(|earlier| ConversationSubmitResult {
            submission_id: earlier.id,
            status: earlier.status,
        }))
    }

    pub fn seq(&self) -> Seq {
        self.seq
    }

    /// The conversation's entries after `since_seq`, this commit's own included.
    pub fn entries_since(&self, since_seq: Seq) -> Result<Vec<Entry>> {
        entries_since(&self.tx, &self.conversation_id, since_seq)
    }

    pub fn insert_submission(
        &mut self,
        request_id: &str,
        when_busy: WhenBusy,
        input: &Input,
        skills: &[AttachedSkill],
        author: &Actor,
    ) -> Result<String> {
        let id = new_id();
        self.tx.execute(
            "INSERT INTO submissions (id, conversation_id, request_id, status, when_busy, input, skills, author, seq)
             VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                self.conversation_id,
                request_id,
                to_text(&when_busy)?,
                serde_json::to_string(input)?,
                serde_json::to_string(skills)?,
                serde_json::to_string(author)?,
                self.seq
            ],
        )?;
        Ok(id)
    }

    /// Settles every input the current run placed: the first one and the steers that joined it.
    pub fn settle_placed(&mut self, status: SubmissionStatus) -> Result<()> {
        self.tx.execute(
            "UPDATE submissions SET status = ?1 WHERE conversation_id = ?2 AND status = 'placed'",
            params![to_text(&status)?, self.conversation_id],
        )?;
        Ok(())
    }

    pub fn set_submission_status(&mut self, id: &str, status: SubmissionStatus) -> Result<()> {
        self.tx.execute(
            "UPDATE submissions SET status = ?1 WHERE id = ?2",
            params![to_text(&status)?, id],
        )?;
        Ok(())
    }
}

fn entries_since(db: &Connection, conversation_id: &str, since_seq: Seq) -> Result<Vec<Entry>> {
    let mut statement = db.prepare(
        "SELECT id, seq, conversation_id, kind, author, data, created_at_ms FROM entries
         WHERE conversation_id = ?1 AND seq > ?2 ORDER BY seq, rowid",
    )?;
    let rows = statement.query_map(params![conversation_id, since_seq], |row| {
        Ok((|| {
            Ok(Entry {
                id: row.get(0)?,
                seq: row.get(1)?,
                conversation_id: row.get(2)?,
                kind: row.get(3)?,
                author: serde_json::from_str(&row.get::<_, String>(4)?)?,
                data: serde_json::from_str(&row.get::<_, String>(5)?)?,
                created_at_ms: row.get(6)?,
            })
        })())
    })?;
    rows.map(|row| row?).collect()
}

const CONVERSATION_COLUMNS: &str =
    "id, title, creator, status, created_at_ms, cwd, provider, model, effort";

const BY_REQUEST: &str = "conversation_id = ?1 AND request_id = ?2";

const OPEN_SUBMISSIONS: &str = "conversation_id = ?1 AND status IN ('placed', 'queued')
     ORDER BY status = 'queued', seq";

fn submissions_where(
    db: &Connection,
    condition: &str,
    values: impl rusqlite::Params,
) -> Result<Vec<Submission>> {
    let mut statement = db.prepare(&format!(
        "SELECT id, conversation_id, status, when_busy, input, skills, author FROM submissions WHERE {condition}"
    ))?;
    let rows = statement.query_map(values, |row| {
        Ok((|| {
            Ok(Submission {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                status: from_text(&row.get::<_, String>(2)?)?,
                when_busy: from_text(&row.get::<_, String>(3)?)?,
                input: serde_json::from_str(&row.get::<_, String>(4)?)?,
                skills: serde_json::from_str(&row.get::<_, String>(5)?)?,
                author: serde_json::from_str(&row.get::<_, String>(6)?)?,
            })
        })())
    })?;
    rows.map(|row| row?).collect()
}

fn conversation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<Conversation>> {
    Ok((|| {
        Ok(Conversation {
            id: row.get(0)?,
            title: row.get(1)?,
            creator: serde_json::from_str(&row.get::<_, String>(2)?)?,
            status: from_text(&row.get::<_, String>(3)?)?,
            created_at_ms: row.get(4)?,
            cwd: PathBuf::from(row.get::<_, String>(5)?),
            selection: ModelSelection {
                provider: row.get(6)?,
                model: row.get(7)?,
                effort: row.get(8)?,
            },
        })
    })())
}

fn to_text<T: serde::Serialize>(value: &T) -> Result<String> {
    match serde_json::to_value(value)? {
        Value::String(text) => Ok(text),
        other => bail!("expected a unit variant, got {other}"),
    }
}

fn from_text<T: serde::de::DeserializeOwned>(text: &str) -> Result<T> {
    Ok(serde_json::from_value(Value::String(text.to_owned()))?)
}
