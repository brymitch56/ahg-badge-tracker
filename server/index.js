'use strict';
// Entry point: node server/index.js  (systemd: deploy/ahg-badge-tracker.service)
const { makeConfig } = require('./config');
const { openDb, migrate } = require('./db');
const { createApp } = require('./app');
const { makeCheckinClient } = require('./lib/checkin');
const { makeScheduler } = require('./lib/scheduler');

const cfg = makeConfig();
const db = openDb(cfg.dbPath);
const applied = migrate(db);
if (applied.length) console.log(`[tracker] applied migrations: ${applied.join(', ')}`);
if (cfg.auth.disabled) console.warn('[tracker] WARNING: AUTH_DISABLED — every request is a fake admin. Never in production.');
if (!cfg.siteOrigin) console.warn('[tracker] SITE_ORIGIN not set — browser calls from the website will be blocked by CORS.');

const app = createApp({ cfg, db });
// Warm the Microsoft signing-key cache in the background (retries for a few
// minutes); on the Pi's Wi-Fi the first fetch can be slow, and a leader's
// first request must not be the one that pays for it.
if (!cfg.auth.disabled && app.locals.auth) app.locals.auth.warm().catch(() => {});
const server = app.listen(cfg.port, '127.0.0.1', () => {
  console.log(`[tracker] listening on http://127.0.0.1:${cfg.port} (db: ${cfg.dbPath})`);
});

// Background jobs (spec §7): event/roster syncs, the attendance sweep, and
// the weekly read-only AHGFamily pull (runs only once credentials are
// stored and girls are mapped; a latch stops it entirely).
const scheduler = makeScheduler({
  cfg, db, client: makeCheckinClient(cfg.checkin),
  credKey: cfg.credKeyHex ? Buffer.from(cfg.credKeyHex, 'hex') : null,
});
if (/^(1|true)$/i.test(process.env.DISABLE_SCHEDULER || '')) {
  console.log('[tracker] scheduler disabled (DISABLE_SCHEDULER)');
} else {
  if (!cfg.checkin.apiKey) console.warn('[tracker] CHECKIN_API_KEY not set — check-in syncs will not run.');
  scheduler.start();
}

const shutdown = (sig) => {
  console.log(`[tracker] ${sig} — shutting down`);
  scheduler.stop();
  server.close(() => { try { db.close(); } catch { /* ignore */ } process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
