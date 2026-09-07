'use strict';
// SQLite via better-sqlite3 (same as the check-in app). Migrations are
// numbered .sql files in server/migrations/, applied in order, recorded in
// schema_migrations. Never edit an applied migration — add a new file.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}-.*\.sql$/.test(f)).sort();
  const run = db.transaction((name, sql) => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
  });
  const done = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    run(f, fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    done.push(f);
  }
  return done;
}

module.exports = { openDb, migrate };
