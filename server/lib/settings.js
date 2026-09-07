'use strict';
// Key/value settings (spec §4) — JSON values in the settings table.

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value != null ? JSON.parse(row.value) : null;
}

function setSetting(db, key, value, actor = null) {
  db.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(key, JSON.stringify(value), new Date().toISOString(), actor);
}

function deleteSetting(db, key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

module.exports = { getSetting, setSetting, deleteSetting };
