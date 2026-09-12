'use strict';
/**
 * In-process background jobs (spec §7) — the check-in app's pattern: one
 * interval, cheap idempotent checks, everything recorded in sync_runs.
 *
 * Covered here: nightly event sync, weekly roster sync, and the attendance
 * sweep — an event is re-polled from 30 minutes after end_at until one
 * post-event fetch finds no open rows (rule 4b), then left alone. Each
 * sweep applies rule 3 (proposals) idempotently. AHGFamily pull/push jobs
 * are steps 6–7 and are NOT here.
 */
const fs = require('fs');
const path = require('path');
const mirror = require('./mirror');
const proposals = require('./proposals');
const mapping = require('./mapping');
const ahgpull = require('./ahgpull');
const servicepull = require('./servicepull');
const servicepush = require('./servicepush');
const report = require('./report');
const { getSetting, setSetting } = require('./settings');
const { CheckinError } = require('./checkin');

const EVENTS_EVERY_MS = 24 * 3600e3;      // nightly
const PEOPLE_EVERY_MS = 7 * 24 * 3600e3;  // weekly
const PULL_EVERY_MS = 7 * 24 * 3600e3;    // weekly (spec §7, decided)
const PUSH_EVERY_MS = 7 * 24 * 3600e3;    // weekly push (spec §7, decided; only while push_enabled)
const BACKUP_EVERY_MS = 24 * 3600e3;      // nightly
const BACKUPS_KEPT = 14;
const SWEEP_DELAY_MS = 30 * 60e3;         // 30 min after end_at
const SWEEP_WINDOW_MS = 7 * 24 * 3600e3;  // stop chasing week-old events

function makeScheduler({ cfg, db, client, credKey = null, ahgSessionFactory = undefined, mailer = undefined, log = (m) => console.log(m) }) {
  async function tick(nowMs = Date.now()) {
    const out = {};
    const lastOk = (kind) => db.prepare('SELECT started_at FROM sync_runs WHERE kind = ? AND ok = 1 ORDER BY id DESC LIMIT 1').get(kind);
    const age = (row) => (row ? nowMs - Date.parse(row.started_at) : Infinity);

    // Nightly SQLite backup (spec §7 — same pattern as the check-in app).
    try {
      const last = getSetting(db, 'last_backup');
      if (db.name && db.name !== ':memory:' && (!last || nowMs - Date.parse(last) >= BACKUP_EVERY_MS)) {
        const dir = path.join(cfg.dataDir, 'backups');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `tracker-${new Date(nowMs).toISOString().slice(0, 10)}.db`);
        await db.backup(file);
        setSetting(db, 'last_backup', new Date(nowMs).toISOString());
        const old = fs.readdirSync(dir).filter((f) => /^tracker-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
        for (const f of old.slice(0, Math.max(0, old.length - BACKUPS_KEPT))) fs.unlinkSync(path.join(dir, f));
        out.backup = file;
      }
    } catch (e) {
      log(`[tracker] backup failed: ${e.message}`);
      out.backupError = e.message;
    }

    // Weekly AHGFamily pull (read-only; rule 8: never while latched, never
    // without credentials, and one auth failure stops everything).
    const lastPull = db.prepare(`SELECT started_at FROM sync_runs WHERE kind = 'pull' AND ok = 1 AND summary LIKE '%"kind":"ahg_state"%' ORDER BY id DESC LIMIT 1`).get();
    if (age(lastPull) >= PULL_EVERY_MS && !mapping.getLatch(db) && mapping.hasStoredCredentials(db, credKey)
        && db.prepare('SELECT 1 FROM girls WHERE active = 1 AND ahg_youth_id IS NOT NULL LIMIT 1').get()) {
      try {
        out.pull = await ahgpull.pullAhgState(db, cfg, { ...(ahgSessionFactory ? { sessionFactory: ahgSessionFactory } : {}), key: credKey });
      } catch (e) {
        log(`[tracker] weekly AHGFamily pull failed: ${e.message}`);
        out.pullError = e.message;
      }
    }

    // Weekly Service Stars pull (read-only; same guards). Runs on its own
    // cadence so a failure in one pull never blocks the other.
    const lastService = db.prepare(`SELECT started_at FROM sync_runs WHERE kind = 'pull' AND ok = 1 AND summary LIKE '%"kind":"service"%' ORDER BY id DESC LIMIT 1`).get();
    if (age(lastService) >= PULL_EVERY_MS && !mapping.getLatch(db) && mapping.hasStoredCredentials(db, credKey)
        && db.prepare('SELECT 1 FROM girls WHERE active = 1 AND ahg_youth_id IS NOT NULL LIMIT 1').get()) {
      try {
        out.service = await servicepull.pullServiceState(db, cfg, { ...(ahgSessionFactory ? { sessionFactory: ahgSessionFactory } : {}), key: credKey });
      } catch (e) {
        log(`[tracker] weekly Service Stars pull failed: ${e.message}`);
        out.serviceError = e.message;
      }
    }

    // Weekly AHGFamily push (spec §7, decided) — only while an admin has the
    // push_enabled flag on; the requirement push additionally needs its own
    // flag. One run report is mailed afterwards (report_mode decides when).
    if (servicepush.pushEnabled(db) && age(lastOk('push')) >= PUSH_EVERY_MS && !mapping.getLatch(db) && mapping.hasStoredCredentials(db, credKey)
        && db.prepare("SELECT 1 FROM push_queue WHERE status = 'queued' LIMIT 1").get()) {
      const opts = { ...(ahgSessionFactory ? { sessionFactory: ahgSessionFactory } : {}), key: credKey };
      try {
        out.push = await servicepush.pushStarInstances(db, cfg, opts);
        if (!mapping.getLatch(db)) out.pushRequirements = await servicepush.pushRequirementMarks(db, cfg, opts);
      } catch (e) {
        log(`[tracker] weekly AHGFamily push failed: ${e.message}`);
        out.pushError = e.message;
      }
      try {
        out.report = await report.sendPushReport(db, cfg, { stars: out.push || null, requirements: out.pushRequirements || null }, { ...(mailer ? { mailer } : {}), trigger: 'weekly', log });
      } catch (e) { log(`[tracker] push report failed: ${e.message}`); }
    }

    if (!client.configured) return Object.keys(out).length ? out : { skipped: 'checkin unconfigured' };
    try {
      if (age(lastOk('checkin_events')) >= EVENTS_EVERY_MS) out.events = await mirror.syncEvents(db, client);
      if (age(lastOk('checkin_people')) >= PEOPLE_EVERY_MS) out.people = await mirror.syncPeople(db, client);

      const lo = new Date(nowMs - SWEEP_WINDOW_MS).toISOString();
      const hi = new Date(nowMs - SWEEP_DELAY_MS).toISOString();
      const due = db.prepare(`
        SELECT * FROM events
        WHERE checkin_event_id IS NOT NULL AND end_at IS NOT NULL AND end_at >= ? AND end_at <= ?
          AND (attendance_fetched_at IS NULL OR attendance_fetched_at < end_at
               OR EXISTS (SELECT 1 FROM attendance a WHERE a.event_id = events.id AND a.open = 1))
        ORDER BY end_at`).all(lo, hi);
      if (due.length) {
        out.attendance = [];
        for (const ev of due) {
          try {
            const s = await mirror.refreshAttendance(db, client, ev);
            out.attendance.push({ ...s, proposals: proposals.proposeForEvent(db, ev, cfg.tz) });
          } catch (e) {
            if (e instanceof CheckinError && e.status === 404) continue; // event gone on the check-in side
            throw e;
          }
        }
      }
    } catch (e) {
      // sync_runs already carries the failure; the next tick retries
      log(`[tracker] scheduler tick failed: ${e.message}`);
      out.error = e.message;
    }
    return out;
  }

  let timer = null;
  return {
    tick,
    start(intervalMs = 10 * 60e3) {
      if (timer) return;
      timer = setInterval(() => { tick().catch((e) => log(`[tracker] scheduler: ${e.message}`)); }, intervalMs);
      timer.unref();
      tick().catch((e) => log(`[tracker] scheduler: ${e.message}`)); // once at startup
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

module.exports = { makeScheduler, EVENTS_EVERY_MS, PEOPLE_EVERY_MS, SWEEP_DELAY_MS, SWEEP_WINDOW_MS };
