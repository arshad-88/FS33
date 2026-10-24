'use strict';
/* SQLite storage. Schema is created idempotently on boot (no migration tool needed yet). */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  phone           TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL DEFAULT '',
  alerts_family   INTEGER NOT NULL DEFAULT 1,
  share_location  INTEGER NOT NULL DEFAULT 1,
  helper_opt_in   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  last_seen_at    TEXT
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id          TEXT PRIMARY KEY,
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_challenges (phone, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS family_requests (
  id            TEXT PRIMARY KEY,
  from_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  to_phone      TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'request',
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TEXT NOT NULL,
  responded_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_family_pending
  ON family_requests (from_user_id, to_phone) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_family_to_user ON family_requests (to_user_id, status);

CREATE TABLE IF NOT EXISTS connections (
  id         TEXT PRIMARY KEY,
  user_a     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  removed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_pair ON connections (user_a, user_b);
CREATE INDEX IF NOT EXISTS idx_connection_b ON connections (user_b);

CREATE TABLE IF NOT EXISTS emergencies (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT,
  state           TEXT NOT NULL,
  lat             REAL,
  lng             REAL,
  accuracy_m      REAL,
  location_age_seconds INTEGER,
  note            TEXT,
  helper_id       TEXT,
  family_notified INTEGER NOT NULL DEFAULT 0,
  nearby_state    TEXT NOT NULL DEFAULT 'disabled',
  nearby_candidates INTEGER NOT NULL DEFAULT 0,
  nearby_notified INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  cancelled_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_emergency_idem
  ON emergencies (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_emergency_user ON emergencies (user_id, created_at);

CREATE TABLE IF NOT EXISTS helper_assignments (
  id           TEXT PRIMARY KEY,
  emergency_id TEXT NOT NULL REFERENCES emergencies(id) ON DELETE CASCADE,
  helper_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending',
  distance_m   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  responded_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assignment_pair ON helper_assignments (emergency_id, helper_id);
CREATE INDEX IF NOT EXISTS idx_assignment_helper ON helper_assignments (helper_id, status);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  emergency_id TEXT,
  kind        TEXT NOT NULL,
  channel     TEXT NOT NULL,
  provider    TEXT NOT NULL,
  status      TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_user ON notifications (user_id);

CREATE TABLE IF NOT EXISTS devices (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  platform   TEXT NOT NULL DEFAULT 'android',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blocks (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_block_pair ON blocks (user_id, blocked_user_id);

CREATE TABLE IF NOT EXISTS reports (
  id             TEXT PRIMARY KEY,
  reporter_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id TEXT,
  assignment_id  TEXT,
  reason         TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports (target_user_id);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  actor_id   TEXT,
  kind       TEXT NOT NULL,
  target_id  TEXT,
  meta       TEXT
);

CREATE TABLE IF NOT EXISTS alert_logs (
  id           TEXT PRIMARY KEY,
  emergency_id TEXT NOT NULL REFERENCES emergencies(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL,
  detail       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_logs_emergency ON alert_logs (emergency_id);
`);

/*
 * Migrations. Safe to run on every boot: a family pair must be unique only
 * among *active* connections so people can reconnect after removing a member.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS helper_locations (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  accuracy_m REAL,
  updated_at TEXT NOT NULL
);
DROP INDEX IF EXISTS idx_connection_pair;
CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_active_pair
  ON connections (user_a, user_b) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS scan_cache (
  key        TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

/*
 * Column/table renames for databases created by earlier builds. Each step is
 * guarded so this block is a no-op on a fresh database and cannot run twice.
 */
function columnsOf(table) {
  return db.prepare('PRAGMA table_info(' + table + ')').all().map((column) => column.name);
}
function tableNames() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
}

if (columnsOf('emergencies').includes('location_age_s')) {
  db.exec('ALTER TABLE emergencies RENAME COLUMN location_age_s TO location_age_seconds');
}
if (!columnsOf('emergencies').includes('helper_id')) {
  db.exec('ALTER TABLE emergencies ADD COLUMN helper_id TEXT');
}

if (tableNames().includes('assignments')) {
  if (!tableNames().includes('helper_assignments')) {
    db.exec('ALTER TABLE assignments RENAME TO helper_assignments');
  } else {
    db.exec(`
      INSERT INTO helper_assignments (id, emergency_id, helper_id, status, distance_m, created_at, responded_at)
      SELECT id, emergency_id, helper_id, status, distance_m, created_at, responded_at FROM assignments
      WHERE id NOT IN (SELECT id FROM helper_assignments);
      DROP TABLE assignments;
    `);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assignment_pair ON helper_assignments (emergency_id, helper_id);
    CREATE INDEX IF NOT EXISTS idx_assignment_helper ON helper_assignments (helper_id, status);
  `);
}

if (columnsOf('reports').includes('user_id') && !columnsOf('reports').includes('reporter_id')) {
  db.exec('ALTER TABLE reports RENAME COLUMN user_id TO reporter_id');
}
if (!columnsOf('reports').includes('target_user_id')) {
  db.exec('ALTER TABLE reports ADD COLUMN target_user_id TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_reports_target ON reports (target_user_id);');
// devices is read by user_id on every push fan-out (providers.pushToUser) and
// deleted by user_id on logout, so the lookup needs its own index alongside the
// UNIQUE(token) constraint. IF NOT EXISTS makes it a no-op on existing databases.
db.exec('CREATE INDEX IF NOT EXISTS idx_device_user ON devices (user_id);');

/*
 * Transactions. node:sqlite has no `db.transaction()` helper (that is the
 * better-sqlite3 API), yet the route modules need one for the single-claim
 * helper race. This is the single implementation: BEGIN IMMEDIATE, commit on
 * return, roll back on throw, and join the outer transaction instead of
 * nesting (SQLite has no nested BEGIN).
 */
let transactionDepth = 0;

function transaction(fn) {
  return function runTransaction(...args) {
    if (transactionDepth > 0) return fn(...args);
    db.exec('BEGIN IMMEDIATE');
    transactionDepth += 1;
    try {
      const result = fn(...args);
      transactionDepth -= 1;
      db.exec('COMMIT');
      return result;
    } catch (err) {
      transactionDepth -= 1;
      try {
        db.exec('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[familyshield] rollback failed:', rollbackErr.message);
      }
      throw err;
    }
  };
}

db.transaction = transaction;

function audit(actorId, kind, targetId, meta) {
  db.prepare('INSERT INTO events (id, at, actor_id, kind, target_id, meta) VALUES (?,?,?,?,?,?)').run(
    require('node:crypto').randomUUID(),
    new Date().toISOString(),
    actorId || null,
    kind,
    targetId || null,
    meta ? JSON.stringify(meta) : null
  );
}

module.exports = { db, audit, transaction };
