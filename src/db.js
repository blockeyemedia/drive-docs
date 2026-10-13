const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    progress_json TEXT NOT NULL DEFAULT '{}',
    generated_files_json TEXT NOT NULL DEFAULT '[]',
    error_json TEXT,
    zip_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status, created_at);
`);

module.exports = db;
