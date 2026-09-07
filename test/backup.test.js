'use strict';
// Nightly backup job (spec §7) — file-backed db, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeConfig } = require('../server/config');
const { openDb, migrate } = require('../server/db');
const { makeCheckinClient } = require('../server/lib/checkin');
const { makeScheduler } = require('../server/lib/scheduler');

test('scheduler: nightly backup into data/backups, once per day, in-memory db skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-bak-'));
  const cfg = makeConfig({ DATA_DIR: dir, DB_PATH: path.join(dir, 'tracker.db') });
  const db = openDb(cfg.dbPath);
  migrate(db);
  const client = makeCheckinClient({ base: '', apiKey: '' });
  const sched = makeScheduler({ cfg, db, client, log: () => {} });
  const nowMs = Date.now();

  let out = await sched.tick(nowMs);
  assert.ok(out.backup, 'first tick backs up');
  assert.ok(fs.existsSync(out.backup));
  const backedUp = openDb(out.backup);
  assert.ok(backedUp.prepare("SELECT name FROM sqlite_master WHERE name = 'completions'").get(), 'backup is a real tracker db');
  backedUp.close();

  out = await sched.tick(nowMs + 3600e3);
  assert.equal(out.backup, undefined, 'not again within 24h');
  out = await sched.tick(nowMs + 25 * 3600e3);
  assert.ok(out.backup, 'due again the next day');

  const mem = openDb(':memory:');
  migrate(mem);
  const memSched = makeScheduler({ cfg, db: mem, client, log: () => {} });
  out = await memSched.tick(nowMs);
  assert.equal(out.backup, undefined, 'in-memory db never backs up');
  mem.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
