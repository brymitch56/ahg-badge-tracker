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
const server = app.listen(cfg.port, '127.0.0.1', () => {
  console.log(`[tracker] listening on http://127.0.0.1:${cfg.port} (db: ${cfg.dbPath})`);
});

// Background jobs (spec §7): event/roster syncs and the attendance sweep.
const scheduler = makeScheduler({ cfg, db, client: makeCheckinClient(cfg.checkin) });
if (/^(1|true)$/i.test(process.env.DISABLE_SCHEDULER || '')) {
  console.log('[tracker] scheduler disabled (DISABLE_SCHEDULER)');
} else if (cfg.checkin.apiKey) {
  scheduler.start();
} else {
  console.warn('[tracker] CHECKIN_API_KEY not set — check-in syncs will not run.');
}

const shutdown = (sig) => {
  console.log(`[tracker] ${sig} — shutting down`);
  scheduler.stop();
  server.close(() => { try { db.close(); } catch { /* ignore */ } process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
