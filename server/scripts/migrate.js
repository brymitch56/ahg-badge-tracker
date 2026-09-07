#!/usr/bin/env node
'use strict';
// Apply pending migrations and exit. Safe to run any time; idempotent.
const { makeConfig } = require('../config');
const { openDb, migrate } = require('../db');
const cfg = makeConfig();
const db = openDb(cfg.dbPath);
const applied = migrate(db);
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
console.log(`db: ${cfg.dbPath}`);
db.close();
