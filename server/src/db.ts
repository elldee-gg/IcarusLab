import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  quota_bytes INTEGER NOT NULL,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  color_mode TEXT NOT NULL DEFAULT 'system',
  aesthetic TEXT NOT NULL DEFAULT 'winvista',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  role TEXT NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS server_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  mime TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_version INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared', 'public')),
  public_token TEXT UNIQUE,
  deleted_at INTEGER,
  restore_parent_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id),
  FOREIGN KEY (parent_id) REFERENCES nodes(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS nodes_name_live
  ON nodes(owner_id, ifnull(parent_id, ''), name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(owner_id, parent_id, deleted_at);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(name, node_id UNINDEXED);

CREATE TABLE IF NOT EXISTS shares (
  node_id TEXT NOT NULL,
  grantee_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
  PRIMARY KEY (node_id, grantee_id),
  FOREIGN KEY (node_id) REFERENCES nodes(id),
  FOREIGN KEY (grantee_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS shares_grantee ON shares(grantee_id);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  mime TEXT,
  total_bytes INTEGER NOT NULL,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  result_node_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_chunks (
  upload_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  PRIMARY KEY (upload_id, idx)
);

CREATE TABLE IF NOT EXISTS admin_notifications (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  all_day INTEGER NOT NULL DEFAULT 0,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS events_owner_time ON events(owner_id, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS event_guests (
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'yes', 'no', 'maybe')),
  PRIMARY KEY (event_id, user_id),
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS event_guests_user ON event_guests(user_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  due_day TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS tasks_owner_day ON tasks(owner_id, due_day);

CREATE TABLE IF NOT EXISTS task_shares (
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (task_id, user_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS task_shares_user ON task_shares(user_id);

CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY,
  destination TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT,
  bytes_copied INTEGER NOT NULL DEFAULT 0
);
`;

export function openDatabase(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  ensureColumn(db, 'users', 'color_mode', "TEXT NOT NULL DEFAULT 'system'");
  ensureColumn(db, 'users', 'aesthetic', "TEXT NOT NULL DEFAULT 'winvista'");
  return db;
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function metaGet(db: DatabaseSync, key: string) {
  const row = db.prepare('SELECT value FROM server_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function metaSet(db: DatabaseSync, key: string, value: string) {
  db.prepare('INSERT INTO server_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already be closed.
    }
    throw error;
  }
}
