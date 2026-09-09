'use strict';
/**
 * AHGFamily weekly pull (spec §4 "AHGFamily sync", §5 rule 6, §7; build
 * step 6). READ-ONLY: every request goes through lib/ahgfamily.js's
 * allow-list (login, badge-tracker-view, logout) — the push module (step 7,
 * behind a flag, not built) is the only thing that will ever write.
 *
 * Shape: one Grid request per active badge (all mapped girls at once) gives
 * checked/unchecked per girl per requirement; a Standard request per
 * (girl, badge) is added only when a checked item is missing its date, to
 * learn earned_on / comment / the ad… record id. Everything lands in
 * ahg_state (tracker.db only — ids and dates never leave the Pi).
 *
 * Rule 6 reconciliation after the fetch:
 *   - complete THERE, no live row HERE   → confirmed completion, source
 *     'ahgfamily', AHGFamily's date;
 *   - confirmed HERE, not there          → queued to push (rows sit until
 *     step 7 ships; visible in /sync/queue);
 *   - was complete there, now UN-checked → an open conflict for a leader,
 *     never resolved silently;
 *   - complete both sides                → any queued mark is skipped.
 *
 * Rule 8: one auth failure latches ALL AHGFamily traffic (mapping.js's
 * latch); a latched tracker refuses to pull before any request is made.
 */
const A = require('../../lib/ahgfamily');
const { parseGridState, parseStandardState, parseAhgDate } = require('../../lib/parse');
const mapping = require('./mapping');
const { recordRun } = require('./mirror');

class PullError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

const now = () => new Date().toISOString();

// AHGFamily dates render as M/D/YYYY; store YYYY-MM-DD like everything else.
// Epoch-0 artefacts (12/31/1969) read as null — see parseAhgDate.
function isoDate(s) {
  if (!s) return null;
  return parseAhgDate(s);
}

/** Live transport: one login for the whole run, throttled, logout after. */
async function makeLiveSession(db, { key = null, env = process.env } = {}) {
  const creds = mapping.getCredentials(db, key, env);
  if (!creds) throw new PullError('noconfig', 'no AHGFamily credentials — enter them via the admin screen');
  if (creds.unreadable) throw new PullError('noconfig', 'stored AHGFamily credentials are unreadable (CRED_KEY missing or changed) — re-enter them');
  const acfg = { ...A.makeConfig(env), email: creds.email, password: creds.password };
  const jar = new A.CookieJar();
  const { token } = await A.login(acfg, jar);
  return {
    async grid(awardId, youthIds) {
      await A.sleep(acfg.throttleMs);
      return A.badgeTrackerView(acfg, jar, token, { level: 'all', style: 'grid', youthIds, awardId });
    },
    async standard(awardId, youthId) {
      await A.sleep(acfg.throttleMs);
      return A.badgeTrackerView(acfg, jar, token, { level: 'all', style: 'standard', youthIds: [youthId], awardId });
    },
    async close() { try { await A.request(acfg, jar, '/logout'); } catch { /* best effort */ } },
  };
}

/** Badges worth pulling: active AND touched by this troop (spec §7 — never all 548). */
function activeBadges(db) {
  return db.prepare(`
    SELECT DISTINCT b.* FROM badges b WHERE b.active = 1 AND (
      EXISTS (SELECT 1 FROM requirements r JOIN completions c ON c.requirement_id = r.id AND c.status <> 'rejected' WHERE r.badge_id = b.id)
      OR EXISTS (SELECT 1 FROM requirements r JOIN plan_items pi ON pi.requirement_id = r.id WHERE r.badge_id = b.id)
      OR EXISTS (SELECT 1 FROM requirements r JOIN ahg_state s ON s.requirement_id = r.id WHERE r.badge_id = b.id)
    ) ORDER BY b.id`).all();
}

/**
 * The pull. `sessionFactory` is injectable so tests stay offline; the
 * default logs in for real. Returns the sync_runs summary.
 */
async function pullAhgState(db, cfg, { sessionFactory = makeLiveSession, key = null, env = process.env, actor = 'system' } = {}) {
  const latch = mapping.getLatch(db);
  if (latch) throw new PullError('latched', `AHGFamily is latched since ${latch.latchedAt} (${latch.error}) — re-enter credentials to clear`);

  const girls = db.prepare('SELECT * FROM girls WHERE active = 1 AND ahg_youth_id IS NOT NULL').all();
  const badges = activeBadges(db);
  if (!girls.length) throw new PullError('noconfig', 'no girls are mapped to AHGFamily yet — run the mapping screen first');

  return recordRun(db, 'pull', async () => {
    const summary = { kind: 'ahg_state', girls: girls.length, badges: badges.length, requests: 0, cells: 0, checked: 0, detailFetches: 0, newFromAhg: 0, queued: 0, skippedQueue: 0, conflicts: 0, warnings: [] };
    let session;
    try {
      session = await sessionFactory(db, { key, env });
    } catch (e) {
      if (e instanceof A.FetchError && e.code === A.EXIT.AUTH) {
        mapping.setLatch(db, e.message);
        throw new PullError('latched', `AHGFamily login failed — latched all AHGFamily traffic (${e.message})`);
      }
      throw e;
    }
    try {
      const byYouthId = new Map(girls.map((g) => [g.ahg_youth_id, g]));
      const youthIds = girls.map((g) => g.ahg_youth_id);

      for (const badge of badges) {
        // tracker requirement id per AHGFamily requirement id, this badge only
        const reqByAhgId = new Map(db.prepare('SELECT id, ahg_requirement_id FROM requirements WHERE badge_id = ? AND active = 1').all(badge.id)
          .map((r) => [r.ahg_requirement_id, r.id]));
        const html = await withAuthLatch(db, () => session.grid(badge.ahg_award_id, youthIds));
        summary.requests += 1;
        const cells = parseGridState(html);
        if (!cells.length) { summary.warnings.push(`${badge.id}: grid fragment had no cells`); continue; }
        const ts = now();
        const needDetail = new Set(); // girls with a checked item missing its date
        for (const cell of cells) {
          const girl = byYouthId.get(cell.youthId);
          const reqId = reqByAhgId.get(cell.itemId);
          if (!girl || !reqId) continue; // other youth, the award's own row, or a grid-only id
          summary.cells += 1;
          if (cell.value) summary.checked += 1;
          const prior = db.prepare('SELECT * FROM ahg_state WHERE girl_id = ? AND requirement_id = ?').get(girl.id, reqId);
          if (prior) {
            db.prepare('UPDATE ahg_state SET completed = ?, earned_on = ?, comment = ?, fetched_at = ? WHERE girl_id = ? AND requirement_id = ?')
              .run(cell.value, cell.value ? prior.earned_on : null, cell.value ? prior.comment : null, ts, girl.id, reqId);
          } else {
            db.prepare('INSERT INTO ahg_state (girl_id, requirement_id, completed, fetched_at) VALUES (?, ?, ?, ?)')
              .run(girl.id, reqId, cell.value, ts);
          }
          if (cell.value && !(prior && prior.earned_on)) needDetail.add(girl.id);
          // transition complete → un-checked with a confirmed row here = rule 6 conflict
          if (prior && prior.completed && !cell.value) {
            const local = db.prepare("SELECT * FROM completions WHERE girl_id = ? AND requirement_id = ? AND status = 'confirmed'").get(girl.id, reqId);
            if (local && !db.prepare("SELECT 1 FROM conflicts WHERE girl_id = ? AND requirement_id = ? AND status = 'open'").get(girl.id, reqId)) {
              db.prepare('INSERT INTO conflicts (girl_id, requirement_id, kind, detail, detected_at) VALUES (?, ?, ?, ?, ?)')
                .run(girl.id, reqId, 'ahg_unchecked', JSON.stringify({ badgeId: badge.id, completionId: local.id, localCompletedOn: local.completed_on }), ts);
              summary.conflicts += 1;
            }
          }
        }
        // Standard detail only where a checked item lacks its date
        for (const girlId of needDetail) {
          const girl = girls.find((g) => g.id === girlId);
          const detailHtml = await withAuthLatch(db, () => session.standard(badge.ahg_award_id, girl.ahg_youth_id));
          summary.requests += 1;
          summary.detailFetches += 1;
          const st = parseStandardState(detailHtml, { awardId: badge.ahg_award_id });
          for (const [ahgId, d] of Object.entries(st.items)) {
            const reqId = reqByAhgId.get(ahgId);
            if (!reqId || !d.checked) continue;
            db.prepare('UPDATE ahg_state SET earned_on = COALESCE(?, earned_on), comment = COALESCE(?, comment) WHERE girl_id = ? AND requirement_id = ?')
              .run(isoDate(d.date), d.comment, girl.id, reqId);
          }
          // prefer a SAVED instance (no new- field); a blank slot is only a fallback
          const saved = st.records.filter((r) => !r.isNew);
          const rec = saved.find((r) => r.completedOn) || saved[0] || st.records[0];
          if (rec) {
            db.prepare(`UPDATE ahg_state SET ad_record_id = ? WHERE girl_id = ? AND requirement_id IN
                        (SELECT id FROM requirements WHERE badge_id = ?)`).run(rec.adId, girl.id, badge.id);
          }
        }
      }

      reconcile(db, badges, summary, actor);
      return summary;
    } finally {
      await session.close();
    }
  });
}

// Latch on an auth failure mid-run, exactly like at login (rule 8).
async function withAuthLatch(db, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof A.FetchError && e.code === A.EXIT.AUTH) {
      mapping.setLatch(db, e.message);
      throw new PullError('latched', `AHGFamily session failed mid-pull — latched (${e.message})`);
    }
    throw e;
  }
}

// Rule 6, over every (girl, requirement) the pull now has state for.
function reconcile(db, badges, summary, actor) {
  const ts = now();
  for (const badge of badges) {
    const rows = db.prepare(`SELECT s.*, g.ahg_level FROM ahg_state s JOIN girls g ON g.id = s.girl_id
                             JOIN requirements r ON r.id = s.requirement_id WHERE r.badge_id = ? AND g.active = 1`).all(badge.id);
    for (const s of rows) {
      const local = db.prepare("SELECT * FROM completions WHERE girl_id = ? AND requirement_id = ? AND status <> 'rejected'").get(s.girl_id, s.requirement_id);
      if (s.completed && !local) {
        // complete on AHGFamily, unknown here → confirmed, source ahgfamily
        const r = db.prepare(`INSERT INTO completions (girl_id, requirement_id, status, completed_on, source, level_at_completion, proposed_at, decided_by, decided_at)
                              VALUES (?, ?, 'confirmed', ?, 'ahgfamily', ?, ?, ?, ?)`)
          .run(s.girl_id, s.requirement_id, s.earned_on, s.ahg_level, ts, actor, ts);
        db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(ts, actor, 'completion.from_ahgfamily', 'completion', String(r.lastInsertRowid), null,
            JSON.stringify({ girlId: s.girl_id, requirementId: s.requirement_id, completedOn: s.earned_on }));
        summary.newFromAhg += 1;
      } else if (s.completed && local && local.status === 'confirmed') {
        // both sides agree — a queued mark is no longer needed
        const r = db.prepare("UPDATE push_queue SET status = 'skipped', last_error = 'already complete on AHGFamily' WHERE completion_id = ? AND status = 'queued'").run(local.id);
        summary.skippedQueue += r.changes;
      } else if (!s.completed && local && local.status === 'confirmed') {
        // confirmed here, not there → queue to push (idle until step 7),
        // unless a conflict says a human should look first
        const conflicted = db.prepare("SELECT 1 FROM conflicts WHERE girl_id = ? AND requirement_id = ? AND status = 'open'").get(s.girl_id, s.requirement_id);
        const queued = db.prepare("SELECT 1 FROM push_queue WHERE completion_id = ? AND status IN ('queued', 'sent')").get(local.id);
        if (!conflicted && !queued) {
          db.prepare(`INSERT INTO push_queue (girl_id, requirement_id, badge_id, completion_id, action, date, created_at)
                      VALUES (?, ?, ?, ?, 'mark', ?, ?)`)
            .run(s.girl_id, s.requirement_id, badge.id, local.id, local.completed_on, ts);
          summary.queued += 1;
        }
      }
    }
  }
}

// -------------------------------------------------------------- conflicts --
function listConflicts(db, { all = false } = {}) {
  const rows = db.prepare(`SELECT c.*, g.first_name, g.last_name, g.ahg_level, r.number, r.letter, r.title, r.badge_id, b.name AS badge_name
                           FROM conflicts c JOIN girls g ON g.id = c.girl_id
                           LEFT JOIN requirements r ON r.id = c.requirement_id LEFT JOIN badges b ON b.id = r.badge_id
                           ${all ? '' : "WHERE c.status = 'open'"} ORDER BY c.id DESC`).all();
  return rows.map((c) => ({
    id: c.id,
    kind: c.kind,
    status: c.status,
    detectedAt: c.detected_at,
    girlId: c.girl_id,
    firstName: c.first_name,
    lastName: c.last_name,
    ahgLevel: c.ahg_level,
    requirementId: c.requirement_id,
    badgeId: c.badge_id,
    badgeName: c.badge_name,
    number: c.number,
    letter: c.letter,
    title: c.title,
    detail: c.detail ? JSON.parse(c.detail) : null,
    resolvedBy: c.resolved_by,
    resolvedAt: c.resolved_at,
    resolution: c.resolution,
  }));
}

/**
 * A leader resolves a conflict: 'accept_ahgfamily' retracts the local
 * completion (AHGFamily is the official record); 'keep_tracker' queues the
 * item to push again. Either way the conflict closes with an audit trail.
 */
function resolveConflict(db, id, { resolution, note }, actor) {
  if (!['accept_ahgfamily', 'keep_tracker'].includes(resolution)) {
    throw new PullError('bad', "resolution must be 'accept_ahgfamily' or 'keep_tracker'");
  }
  const c = db.prepare('SELECT * FROM conflicts WHERE id = ?').get(id);
  if (!c) throw new PullError('notfound', 'conflict not found');
  if (c.status !== 'open') throw new PullError('conflict', 'already resolved');
  const ts = now();
  const run = db.transaction(() => {
    const local = db.prepare("SELECT * FROM completions WHERE girl_id = ? AND requirement_id = ? AND status = 'confirmed'").get(c.girl_id, c.requirement_id);
    if (resolution === 'accept_ahgfamily' && local) {
      db.prepare("UPDATE completions SET status = 'rejected', decided_by = ?, decided_at = ?, notes = COALESCE(notes || ' | ', '') || 'conflict: accepted AHGFamily' WHERE id = ?")
        .run(actor, ts, local.id);
      db.prepare("UPDATE push_queue SET status = 'skipped', last_error = 'conflict resolved: AHGFamily accepted' WHERE completion_id = ? AND status = 'queued'").run(local.id);
    }
    if (resolution === 'keep_tracker' && local
        && !db.prepare("SELECT 1 FROM push_queue WHERE completion_id = ? AND status IN ('queued', 'sent')").get(local.id)) {
      const badge = db.prepare('SELECT badge_id FROM requirements WHERE id = ?').get(c.requirement_id);
      db.prepare(`INSERT INTO push_queue (girl_id, requirement_id, badge_id, completion_id, action, date, created_at)
                  VALUES (?, ?, ?, ?, 'mark', ?, ?)`)
        .run(c.girl_id, c.requirement_id, badge ? badge.badge_id : null, local.id, local.completed_on, ts);
    }
    db.prepare("UPDATE conflicts SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution = ? WHERE id = ?")
      .run(actor, ts, note ? `${resolution}: ${note}` : resolution, id);
    db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ts, actor, 'conflict.resolve', 'conflict', String(id), JSON.stringify({ kind: c.kind }), JSON.stringify({ resolution, note: note || null }));
  });
  run();
  return listConflicts(db, { all: true }).find((x) => x.id === Number(id));
}

module.exports = { PullError, isoDate, makeLiveSession, activeBadges, pullAhgState, listConflicts, resolveConflict };
