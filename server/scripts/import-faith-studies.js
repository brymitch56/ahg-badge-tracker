#!/usr/bin/env node
'use strict';
// Load Faith Award study steps from data/faith-studies/*.json (or --dir
// <path>) into the tracker database. Insert-only — a study already loaded is
// kept as it is. Same code path as POST /api/v1/admin/faith/studies/import.
const { makeConfig } = require('../config');
const { openDb, migrate } = require('../db');
const { importStudiesFromDir } = require('../lib/faith');

const argv = process.argv.slice(2);
const dirIdx = argv.indexOf('--dir');
const cfg = makeConfig();
const dir = dirIdx >= 0 ? require('path').resolve(argv[dirIdx + 1]) : cfg.faithStudiesDir;
const db = openDb(cfg.dbPath);
migrate(db);
try {
  const s = importStudiesFromDir(db, dir, 'cli');
  console.log(`faith studies from ${s.files.join(', ')}: ${s.added.length} added, ${s.kept.length} already loaded (kept as they are)`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
} finally { db.close(); }
