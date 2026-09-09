'use strict';
/**
 * Service Stars — read side (docs/service-stars-plan.md draft 2, build
 * steps 3–4). READ-ONLY: every request goes through lib/ahgfamily.js's
 * allow-list; nothing here writes to AHGFamily. The step-7 push
 * (`add_instance`) is deliberately unbuilt.
 *
 * Weekly pull, per mapped girl:
 *   1. GET /profile/<youthHashid>?tab=advancement — her complete service
 *      ledger (precise hours as integer hundredths, level at the time,
 *      verified flag), AHGFamily's own eligibility table (cross-check
 *      only), and the per-instance awards grid; paged by following the
 *      grid's own pager links until the ledger is complete.
 *   2. POST badge-tracker-view (Standard) for each Service Star level up to
 *      her current level — instances on record, counted by ad… record id
 *      and only where the panel is not a blank `new-` slot.
 * Everything is collected first and written in ONE transaction, so a
 * failure mid-run leaves the mirror untouched. A girl whose ledger cannot
 * be read completely FAILS THE RUN (a silent undercount would suppress
 * stars — the dangerous direction).
 *
 * Then the math (lib/stars.js): approved hours only, carry-forward chain,
 * Pathfinder excluded; per-girl per-level baseline captured on first sight
 * so legacy stars never conflict; proposals ("her Nth star at level L")
 * reconciled idempotently; conflicts for movement after baseline; the
 * AHGFamily Stars-Eligible cross-check surfaced as notes.
 *
 * Rule 8 latch: one auth failure stops all AHGFamily traffic.
 */
const A = require('../../lib/ahgfamily');
const { parseStandardState } = require('../../lib/parse');
const { parseProfileAdvancement, formatHundredths, STAR_LEVELS } = require('../../lib/service');
const stars = require('../../lib/stars');
const mapping = require('./mapping');
const { recordRun } = require('./mirror');
const ahgpull = require('./ahgpull');

const { PullError } = ahgpull;
const now = () => new Date().toISOString();
const today = (tz) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch { return now().slice(0, 10); }
};

/** Star levels a girl at `ahgLevel` can hold (all four when her level is unknown). */
function starLevelsFor(ahgLevel) {
  const i = STAR_LEVELS.indexOf(ahgLevel);
  if (ahgLevel === 'Pathfinder') return [];
  return i < 0 ? STAR_LEVELS.slice() : STAR_LEVELS.slice(0, i + 1);
}

// ------------------------------------------------------------------ fetch --
/** Fetch one girl's profile, following the ledger's pager until complete. */
async function fetchProfile(session, girl, summary, db) {
  const first = `/profile/${girl.ahg_youth_id}?tab=advancement`;
  const html = await withAuthLatch(db, () => session.page(first));
  summary.requests += 1;
  const p = parseProfileAdvancement(html);
  const warn = (w) => summary.warnings.push(`girl ${girl.id}: ${w}`);
  if (!p.ledger.summary && !p.ledger.rows.length && p.warnings.some((w) => /ledger grid not found/.test(w))) {
    throw new PullError('parse', `girl ${girl.id}: the profile page carried no service ledger — role scoping or a layout change; run aborted, nothing written`);
  }
  if (p.youthId && p.youthId !== girl.ahg_youth_id) warn(`profile page names a different youth id than requested — aborting`);
  if (p.youthId && p.youthId !== girl.ahg_youth_id) throw new PullError('parse', `girl ${girl.id}: profile page mismatch; run aborted`);
  // page the ledger by following its own pager links (never by guessing params)
  const seen = new Set([first]);
  let guard = 0;
  while (!p.ledger.complete && guard++ < 50) {
    const next = (p.ledger.pagerHrefs || []).map(relHref).find((h) => h && !seen.has(h) && /[?&]page=\d+/.test(h) && !/[?&]page=1(&|$)/.test(h));
    if (!next) throw new PullError('parse', `girl ${girl.id}: ledger has ${p.ledger.summary ? p.ledger.summary.total : '?'} rows but no next-page link — run aborted`);
    seen.add(next);
    const more = parseProfileAdvancement(await withAuthLatch(db, () => session.page(next)));
    summary.requests += 1;
    if (!more.ledger.rows.length) throw new PullError('parse', `girl ${girl.id}: ledger page ${next.split('?')[1]} came back empty — run aborted`);
    p.ledger.rows.push(...more.ledger.rows);
    p.ledger.pagerHrefs = more.ledger.pagerHrefs;
    p.ledger.summary = more.ledger.summary;
    p.ledger.complete = !!(more.ledger.summary && more.ledger.summary.to >= more.ledger.summary.total);
    for (const w of more.warnings) if (!/PAGE, do not trust/.test(w)) warn(w);
  }
  if (!p.ledger.complete) throw new PullError('parse', `girl ${girl.id}: ledger still incomplete after paging — run aborted`);
  for (const w of p.warnings) if (!/PAGE, do not trust|awards:/.test(w)) warn(w);
  const unreadable = p.ledger.rows.filter((r) => r.verified === true && !Number.isInteger(r.hundredths));
  if (unreadable.length) throw new PullError('parse', `girl ${girl.id}: ${unreadable.length} approved ledger rows had unreadable hours — refusing to compute stars on a partial ledger`);
  if (p.ledger.summary && p.ledger.summary.total !== undefined && p.ledger.summary.total !== p.ledger.rows.length) {
    throw new PullError('parse', `girl ${girl.id}: ledger summary says ${p.ledger.summary.total} rows, read ${p.ledger.rows.length} — run aborted`);
  }
  return p;
}

// AHGFamily's pager links are site-relative ("/profile/…?page=2"); keep only the path+query.
function relHref(h) {
  try { const u = new URL(h, 'https://example.invalid'); return u.pathname + u.search; } catch { return null; }
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

// ------------------------------------------------------------------- pull --
/**
 * The pull. `sessionFactory` is injectable (tests stay offline); it must
 * yield { page(pathWithQuery), standard(awardId, youthId), close() } —
 * ahgpull.makeLiveSession does. Returns the sync_runs summary.
 */
async function pullServiceState(db, cfg, { sessionFactory = ahgpull.makeLiveSession, key = null, env = process.env, actor = 'system' } = {}) {
  const latch = mapping.getLatch(db);
  if (latch) throw new PullError('latched', `AHGFamily is latched since ${latch.latchedAt} (${latch.error}) — re-enter credentials to clear`);
  const girls = db.prepare('SELECT * FROM girls WHERE active = 1 AND ahg_youth_id IS NOT NULL ORDER BY id').all();
  if (!girls.length) throw new PullError('noconfig', 'no girls are mapped to AHGFamily yet — run the mapping screen first');

  return recordRun(db, 'pull', async () => {
    const summary = {
      kind: 'service', girls: girls.length, requests: 0, ledgerRows: 0, instances: 0, baselines: 0,
      proposed: 0, withdrawn: 0, recorded: 0, conflicts: 0, crossCheck: [], warnings: [],
    };
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
    const collected = [];
    try {
      for (const girl of girls) {
        const profile = await fetchProfile(session, girl, summary, db);
        const instances = []; // { level, awardId, records: [saved records] }
        for (const level of starLevelsFor(girl.ahg_level)) {
          const awardId = stars.STAR_AWARD_IDS[level];
          const html = await withAuthLatch(db, () => session.standard(awardId, girl.ahg_youth_id));
          summary.requests += 1;
          const st = parseStandardState(html, { awardId });
          instances.push({ level, awardId, records: st.records.filter((r) => !r.isNew) });
        }
        collected.push({ girl, profile, instances });
      }
    } finally {
      await session.close();
    }

    // ---- write phase: one transaction ----------------------------------
    const ts = now();
    const write = db.transaction(() => {
      for (const { girl, profile, instances } of collected) {
        // service ledger mirror: replace the girl's rows wholesale
        db.prepare('DELETE FROM service_hours WHERE girl_id = ?').run(girl.id);
        const ins = db.prepare(`INSERT INTO service_hours (girl_id, ahg_record_id, date, level, hundredths, verified, description, fetched_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        profile.ledger.rows.forEach((r, i) => {
          ins.run(girl.id, r.recordId || `row-${i}`, r.date, r.level, r.hundredths, r.verified === true ? 1 : 0, r.description, ts);
          summary.ledgerRows += 1;
        });
        // award instances: upsert what we saw, mark what vanished
        for (const inst of instances) {
          const seenIds = new Set();
          for (const r of inst.records) {
            seenIds.add(r.adId);
            db.prepare(`INSERT INTO award_instances (girl_id, ahg_award_id, ad_record_id, completed_on, awarded_on, purchased, comment, first_seen_at, fetched_at, missing_since)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                        ON CONFLICT(girl_id, ahg_award_id, ad_record_id) DO UPDATE SET completed_on = excluded.completed_on, awarded_on = excluded.awarded_on,
                          purchased = excluded.purchased, comment = excluded.comment, fetched_at = excluded.fetched_at, missing_since = NULL`)
              .run(girl.id, inst.awardId, r.adId, isoOrNull(r.completedOn), isoOrNull(r.awardedOn), r.purchased ? 1 : 0, r.comment, ts, ts);
            summary.instances += 1;
          }
          const known = db.prepare('SELECT ad_record_id FROM award_instances WHERE girl_id = ? AND ahg_award_id = ? AND missing_since IS NULL').all(girl.id, inst.awardId);
          for (const k of known) {
            if (!seenIds.has(k.ad_record_id)) {
              db.prepare('UPDATE award_instances SET missing_since = ? WHERE girl_id = ? AND ahg_award_id = ? AND ad_record_id = ?').run(ts, girl.id, inst.awardId, k.ad_record_id);
            }
          }
        }
        // the math, proposals, conflicts, cross-check
        const r = reconcileGirl(db, girl, { fetchedLevels: instances.map((i) => i.level), eligibility: profile.eligibility.rows, actor, ts });
        summary.baselines += r.baselines;
        summary.proposed += r.proposed;
        summary.withdrawn += r.withdrawn;
        summary.recorded += r.recorded;
        summary.conflicts += r.conflicts;
        for (const n of r.crossCheck) summary.crossCheck.push({ girlId: girl.id, ...n });
      }
    });
    write();
    return summary;
  });
}

const isoOrNull = (s) => (s ? ahgpull.isoDate(s) : null);

// ------------------------------------------------------------------- math --
/** Approved hours per star level for a girl, from the mirror. */
function hoursForGirl(db, girlId) {
  const rows = db.prepare('SELECT level, hundredths, verified FROM service_hours WHERE girl_id = ?').all(girlId)
    .map((r) => ({ level: r.level, hundredths: r.hundredths, verified: r.verified === 1 }));
  return stars.sumApprovedByLevel(rows);
}

/** Instances on record per star level (present, i.e. not missing). */
function onRecordForGirl(db, girlId) {
  const out = {};
  for (const level of STAR_LEVELS) {
    out[level] = db.prepare('SELECT COUNT(*) AS n FROM award_instances WHERE girl_id = ? AND ahg_award_id = ? AND missing_since IS NULL')
      .get(girlId, stars.STAR_AWARD_IDS[level]).n;
  }
  return out;
}

function baselineForGirl(db, girlId) {
  const rows = db.prepare('SELECT level, on_record, earnable FROM star_baseline WHERE girl_id = ?').all(girlId);
  if (!rows.length) return null;
  return Object.fromEntries(rows.map((r) => [r.level, { onRecord: r.on_record, earnable: r.earnable }]));
}

/** Compute a girl's chain from the mirror (no fetch). */
function chainForGirl(db, girlId) {
  const { hours } = hoursForGirl(db, girlId);
  const onRecord = onRecordForGirl(db, girlId);
  const baseline = baselineForGirl(db, girlId);
  return { chain: stars.computeStarChain({ hoursByLevel: hours, onRecord, baseline }), hours, onRecord, baseline };
}

/**
 * Baseline (first sight of a level), proposals and conflicts for one girl.
 * Idempotent: running it twice changes nothing. Only levels actually
 * fetched this run may create baselines or conflicts; the arithmetic runs
 * over the whole chain regardless (carry must pass through).
 */
function reconcileGirl(db, girl, { fetchedLevels = STAR_LEVELS, eligibility = [], actor = 'system', ts = now() } = {}) {
  const out = { baselines: 0, proposed: 0, withdrawn: 0, recorded: 0, conflicts: 0, crossCheck: [] };
  const { hours } = hoursForGirl(db, girl.id);
  const onRecord = onRecordForGirl(db, girl.id);
  let baseline = baselineForGirl(db, girl.id) || {};
  // first sight of a level: snapshot before judging it
  const pre = stars.computeStarChain({ hoursByLevel: hours, onRecord, baseline: null });
  for (const l of pre.levels) {
    if (!fetchedLevels.includes(l.level) || baseline[l.level]) continue;
    db.prepare(`INSERT INTO star_baseline (girl_id, level, on_record, earnable, hours_hundredths, captured_at, captured_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(girl.id, l.level, l.onRecord, l.earnable, l.available, ts, actor);
    baseline = { ...baseline, [l.level]: { onRecord: l.onRecord, earnable: l.earnable } };
    out.baselines += 1;
  }
  const chain = stars.computeStarChain({ hoursByLevel: hours, onRecord, baseline });
  for (const l of chain.levels) {
    if (!fetchedLevels.includes(l.level)) continue;
    // -- proposals: ordinals onRecord+1 .. expected ------------------------
    const live = db.prepare("SELECT * FROM star_proposals WHERE girl_id = ? AND level = ? AND status IN ('proposed', 'confirmed', 'recorded', 'rejected')").all(girl.id, l.level);
    for (const p of live) {
      if (p.status === 'proposed' && (p.ordinal <= l.onRecord || p.ordinal > l.expected)) {
        // AHGFamily already records it (hand-added), or the hours no longer support it
        db.prepare("UPDATE star_proposals SET status = 'withdrawn', decided_at = ?, notes = ? WHERE id = ?")
          .run(ts, p.ordinal <= l.onRecord ? 'withdrawn: already on record at AHGFamily' : 'withdrawn: approved hours no longer support this star', p.id);
        out.withdrawn += 1;
      } else if (p.status === 'confirmed' && p.ordinal <= l.onRecord) {
        db.prepare("UPDATE star_proposals SET status = 'recorded' WHERE id = ?").run(p.id);
        db.prepare("UPDATE push_queue SET status = 'skipped', last_error = 'already on record at AHGFamily' WHERE star_proposal_id = ? AND status = 'queued'").run(p.id);
        out.recorded += 1;
      }
    }
    // an open conflict on this level means a human looks first — no new
    // proposals until it is resolved (rule 6 posture, as for badges)
    const openConflict = l.conflict || db.prepare("SELECT 1 FROM conflicts WHERE girl_id = ? AND kind LIKE 'star_%' AND status = 'open' AND detail LIKE ?").get(girl.id, `%"level":"${l.level}"%`);
    for (let ordinal = l.onRecord + 1; ordinal <= l.expected && !openConflict; ordinal++) {
      const exists = live.find((p) => p.ordinal === ordinal && ['proposed', 'confirmed', 'recorded', 'rejected'].includes(p.status));
      if (exists) continue;
      db.prepare(`INSERT INTO star_proposals (girl_id, level, ordinal, hours_hundredths, carry_in, status, proposed_at) VALUES (?, ?, ?, ?, ?, 'proposed', ?)`)
        .run(girl.id, l.level, ordinal, l.available, l.carryIn, ts);
      out.proposed += 1;
    }
    // -- conflicts (movement after baseline) --------------------------------
    if (l.conflict) {
      const kind = `star_${l.conflict.kind}`;
      const open = db.prepare("SELECT 1 FROM conflicts WHERE girl_id = ? AND kind = ? AND status = 'open' AND detail LIKE ?").get(girl.id, kind, `%"level":"${l.level}"%`);
      if (!open) {
        db.prepare('INSERT INTO conflicts (girl_id, requirement_id, kind, detail, detected_at) VALUES (?, NULL, ?, ?, ?)')
          .run(girl.id, kind, JSON.stringify({ level: l.level, ...l.conflict, earnable: l.earnable, legacy: l.legacy, hours: formatHundredths(l.available) }), ts);
        out.conflicts += 1;
      }
    }
  }
  const pf = hoursForGirl(db, girl.id).pathfinder;
  const pendingByLevel = Object.fromEntries(db.prepare('SELECT level, SUM(hundredths) h FROM service_hours WHERE girl_id = ? AND verified = 0 AND hundredths IS NOT NULL GROUP BY level').all(girl.id).map((r) => [r.level, r.h]));
  out.crossCheck = stars.crossCheckEligibility(chain, eligibility, { pathfinderHundredths: pf, pendingByLevel });
  return out;
}

/** A leader accepted AHGFamily's count for a level: re-baseline it so it is "explained". */
function rebaselineLevel(db, girlId, level, actor = 'system') {
  const { hours } = hoursForGirl(db, girlId);
  const onRecord = onRecordForGirl(db, girlId);
  const chain = stars.computeStarChain({ hoursByLevel: hours, onRecord, baseline: null });
  const l = chain.levels.find((x) => x.level === level);
  if (!l) return;
  db.prepare(`INSERT INTO star_baseline (girl_id, level, on_record, earnable, hours_hundredths, captured_at, captured_by) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(girl_id, level) DO UPDATE SET on_record = excluded.on_record, earnable = excluded.earnable, hours_hundredths = excluded.hours_hundredths,
                captured_at = excluded.captured_at, captured_by = excluded.captured_by`)
    .run(girlId, level, l.onRecord, l.earnable, l.available, now(), actor);
}

// ------------------------------------------------------------------ views --
/** Stars view for the Progress page: every active girl, every level. */
function listStars(db, { girlId = null } = {}) {
  const girls = db.prepare(`SELECT * FROM girls WHERE active = 1 ${girlId ? 'AND id = ?' : ''} ORDER BY last_name, first_name`).all(...(girlId ? [girlId] : []));
  const lastPull = db.prepare(`SELECT started_at, finished_at, ok FROM sync_runs WHERE kind = 'pull' AND summary LIKE '%"kind":"service"%' ORDER BY id DESC LIMIT 1`).get();
  return {
    lastPull: lastPull ? { startedAt: lastPull.started_at, finishedAt: lastPull.finished_at, ok: lastPull.ok === 1 } : null,
    rates: Object.fromEntries(Object.entries(stars.RATE_HUNDREDTHS).map(([l, r]) => [l, r / 100])),
    girls: girls.map((g) => {
      const mapped = !!g.ahg_youth_id;
      const { chain, hours } = chainForGirl(db, g.id);
      const pending = db.prepare("SELECT level, COUNT(*) AS n FROM star_proposals WHERE girl_id = ? AND status = 'proposed' GROUP BY level").all(g.id);
      const unverified = db.prepare('SELECT level, SUM(hundredths) AS h FROM service_hours WHERE girl_id = ? AND verified = 0 GROUP BY level').all(g.id);
      const lastFetched = db.prepare('SELECT MAX(fetched_at) AS t FROM service_hours WHERE girl_id = ?').get(g.id).t;
      return {
        id: g.id,
        firstName: g.first_name,
        lastName: g.last_name,
        nickname: g.nickname,
        ahgLevel: g.ahg_level,
        mapped,
        fetchedAt: lastFetched,
        levels: chain.levels.map((l) => ({
          level: l.level,
          rate: l.rate / 100,
          hours: l.hours / 100,
          hoursDisplay: formatHundredths(l.hours),
          carryIn: l.carryIn / 100,
          available: l.available / 100,
          earnable: l.earnable,
          carryOut: l.carryOut / 100,
          onRecord: l.onRecord,
          legacy: l.legacy,
          expected: l.expected,
          newStars: l.newStars,
          proposedPending: (pending.find((p) => p.level === l.level) || { n: 0 }).n,
          pendingHours: ((unverified.find((u) => u.level === l.level) || { h: 0 }).h || 0) / 100,
          toNextHours: l.toNext.hundredths / 100,
          toNextPct: l.toNext.pct,
          conflict: l.conflict,
          current: g.ahg_level === l.level,
          reachable: starLevelsFor(g.ahg_level).includes(l.level),
        })),
        totalApprovedHours: Object.values(hours).reduce((a, b) => a + b, 0) / 100,
      };
    }),
  };
}

/** Proposals awaiting a leader (or all), grouped flat with girl names. */
function listStarProposals(db, { all = false } = {}) {
  const rows = db.prepare(`SELECT p.*, g.first_name, g.last_name, g.ahg_level FROM star_proposals p JOIN girls g ON g.id = p.girl_id
                           ${all ? '' : "WHERE p.status = 'proposed'"} ORDER BY g.last_name, g.first_name, p.level, p.ordinal`).all();
  return rows.map((p) => ({
    id: p.id,
    girlId: p.girl_id,
    firstName: p.first_name,
    lastName: p.last_name,
    ahgLevel: p.ahg_level,
    level: p.level,
    ordinal: p.ordinal,
    hours: p.hours_hundredths / 100,
    hoursDisplay: formatHundredths(p.hours_hundredths),
    carryIn: p.carry_in / 100,
    rate: stars.RATE_HUNDREDTHS[p.level] / 100,
    status: p.status,
    proposedAt: p.proposed_at,
    decidedBy: p.decided_by,
    decidedAt: p.decided_at,
    completedOn: p.completed_on,
    notes: p.notes,
  }));
}

/**
 * Bulk decide: [{ id, decision: 'confirm'|'reject', completedOn?, note? }].
 * Confirm stamps completed_on (default today — what the eventual push
 * writes) and queues an `add_instance` row, which sits idle until step 7.
 */
function decideStarProposals(db, decisions, actor, { tz = 'UTC' } = {}) {
  if (!Array.isArray(decisions) || !decisions.length) throw new PullError('bad', 'decisions must be a non-empty array');
  const ts = now();
  const results = [];
  const run = db.transaction(() => {
    for (const d of decisions) {
      const p = db.prepare('SELECT * FROM star_proposals WHERE id = ?').get(Number(d.id));
      if (!p) throw new PullError('notfound', `proposal ${d.id} not found`);
      if (p.status !== 'proposed') throw new PullError('conflict', `proposal ${d.id} is ${p.status}, not proposed`);
      if (!['confirm', 'reject'].includes(d.decision)) throw new PullError('bad', "decision must be 'confirm' or 'reject'");
      if (d.decision === 'confirm') {
        const date = d.completedOn && /^\d{4}-\d{2}-\d{2}$/.test(d.completedOn) ? d.completedOn : today(tz);
        db.prepare("UPDATE star_proposals SET status = 'confirmed', decided_by = ?, decided_at = ?, completed_on = ?, notes = ? WHERE id = ?")
          .run(actor, ts, date, d.note || null, p.id);
        const comment = `tracker: ${formatHundredths(p.hours_hundredths)}h ${p.level}, confirmed ${date}`;
        db.prepare(`INSERT INTO push_queue (girl_id, action, date, created_at, ahg_award_id, star_proposal_id, detail)
                    VALUES (?, 'add_instance', ?, ?, ?, ?, ?)`)
          .run(p.girl_id, date, ts, stars.STAR_AWARD_IDS[p.level], p.id, JSON.stringify({ level: p.level, ordinal: p.ordinal, comment }));
      } else {
        db.prepare("UPDATE star_proposals SET status = 'rejected', decided_by = ?, decided_at = ?, notes = ? WHERE id = ?")
          .run(actor, ts, d.note || null, p.id);
      }
      db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ts, actor, `star_proposal.${d.decision}`, 'star_proposal', String(p.id),
          JSON.stringify({ status: 'proposed' }), JSON.stringify({ girlId: p.girl_id, level: p.level, ordinal: p.ordinal, note: d.note || null }));
      results.push({ id: p.id, status: d.decision === 'confirm' ? 'confirmed' : 'rejected' });
    }
  });
  run();
  return results;
}

module.exports = {
  pullServiceState, reconcileGirl, chainForGirl, rebaselineLevel, listStars, listStarProposals, decideStarProposals, starLevelsFor,
};
