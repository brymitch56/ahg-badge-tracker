#!/usr/bin/env node
'use strict';
// Import data/badges/*.json (or --dir <path>) into the tracker database.
// Same code path as POST /api/v1/admin/catalog/import; actor recorded as "cli".
const { makeConfig } = require('../config');
const { openDb, migrate } = require('../db');
const { importFromDir } = require('../lib/catalog');

const argv = process.argv.slice(2);
const dirIdx = argv.indexOf('--dir');
const cfg = makeConfig();
const dir = dirIdx >= 0 ? require('path').resolve(argv[dirIdx + 1]) : cfg.badgesDir;
const db = openDb(cfg.dbPath);
migrate(db);
try {
  const s = importFromDir(db, dir, { actor: 'cli' });
  console.log(`catalog version ${s.version}: ${s.badges} badges, ${s.requirements} requirements` +
    (s.renumbered ? `, ${s.renumbered} renumbered` : '') +
    (s.deactivatedBadges.length ? `, deactivated badges: ${s.deactivatedBadges.join(', ')}` : '') +
    (s.deactivatedRequirements.length ? `, deactivated requirements: ${s.deactivatedRequirements.length}` : ''));
  if (s.orphans.length) {
    console.log('ORPHANS — requirements no longer in the catalog that still have completions (review these):');
    for (const o of s.orphans) console.log(`  ${o.id}: ${o.completions} completion(s)`);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
} finally { db.close(); }
