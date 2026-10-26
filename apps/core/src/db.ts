import Database from "better-sqlite3";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  request_id      TEXT NOT NULL UNIQUE,
  user_message    TEXT NOT NULL,
  status          TEXT NOT NULL,
  used_tool       TEXT,
  result_message  TEXT,
  error_code      TEXT,
  error_message   TEXT,
  attachments     TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_conversation ON tasks(conversation_id);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS messages (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  attachments     TEXT NOT NULL DEFAULT '[]',
  task_id         TEXT REFERENCES tasks(id),
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id);

-- One write action per task in v0.1.
CREATE TABLE IF NOT EXISTS actions (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  idempotency_key   TEXT NOT NULL UNIQUE,
  tool              TEXT NOT NULL,
  operation         TEXT NOT NULL,
  description       TEXT NOT NULL,
  risk_level        TEXT NOT NULL,
  affected_resource TEXT NOT NULL,
  destination       TEXT,
  input             TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  decision          TEXT CHECK (decision IN ('APPROVE', 'REJECT', 'EXPIRED')),
  decided_at        TEXT,
  verified          INTEGER
);

-- Execution reservation: the UNIQUE key guarantees a write runs at most once.
CREATE TABLE IF NOT EXISTS executions (
  idempotency_key TEXT PRIMARY KEY,
  action_id       TEXT NOT NULL UNIQUE REFERENCES actions(id),
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  reserved_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  event     TEXT NOT NULL,
  task_id   TEXT,
  action_id TEXT,
  detail    TEXT
);
CREATE INDEX IF NOT EXISTS audit_task ON audit_log(task_id);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`;

/**
 * v0.2 columns, added to existing databases in place. CREATE TABLE IF NOT EXISTS only
 * helps fresh files, so older files get the same columns through guarded ALTERs.
 */
function ensureColumn(db: DB, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  // v0.2: per-task model usage and cost (null until measured/priced).
  ensureColumn(db, "tasks", "input_tokens", "input_tokens INTEGER");
  ensureColumn(db, "tasks", "output_tokens", "output_tokens INTEGER");
  ensureColumn(db, "tasks", "cost_usd", "cost_usd REAL");
  return db;
}
