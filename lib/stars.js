'use strict';
/**
 * stars.js — Service Star arithmetic (docs/service-stars-plan.md, "The
 * math"). Pure functions, integer hundredths of an hour throughout; nothing
 * here touches a database or the network.
 *
 * Policy (decided):
 *   - rates per star: Tenderheart 5 h · Explorer 10 h · Pioneer 15 h ·
 *     Patriot 20 h;
 *   - unused hours CARRY FORWARD to the next level (AHGFamily's own
 *     eligibility arithmetic does the same);
 *   - Pathfinder rows never count and never carry — Tenderheart's carry-in
 *     is always 0;
 *   - APPROVED hours only (never proposals, never the on-record count):
 *     the chain is arithmetic-anchored, so proposals are stable and
 *     order-independent;
 *   - a level where the record holds MORE stars than the hours explain is
 *     a conflict for a leader, never a silent revert — except for legacy
 *     stars captured in the per-girl, per-level baseline at first sync.
 */
const { STAR_LEVELS, formatHundredths } = require('./service');

/** Hundredths of an hour per star, in program order. */
const RATE_HUNDREDTHS = { Tenderheart: 500, Explorer: 1000, Pioneer: 1500, Patriot: 2000 };

/** Service Star award ids on AHGFamily (program data, committable). */
const STAR_AWARD_IDS = {
  Tenderheart: 'awfhjudhre98',
  Explorer: 'awmhu7yetwrh',
  Pioneer: 'awamidjeryhs',
  Patriot: 'awlodir83ert',
};
const LEVEL_BY_AWARD_ID = Object.fromEntries(Object.entries(STAR_AWARD_IDS).map(([l, id]) => [id, l]));

/**
 * Sum APPROVED hours per star level from ledger rows
 * ({ level, hundredths, verified }). Pathfinder and unverified rows are
 * dropped; rows with unreadable hours are counted in `skipped` so a caller
 * can refuse to trust a ledger it could not read in full.
 */
function sumApprovedByLevel(rows) {
  const hours = Object.fromEntries(STAR_LEVELS.map((l) => [l, 0]));
  let skipped = 0;
  let counted = 0;
  let pathfinder = 0; // approved Pathfinder hours — reported for the cross-check, never counted
  for (const r of rows || []) {
    if (!r || r.verified !== true) continue;
    if (!Number.isInteger(r.hundredths)) { if (STAR_LEVELS.includes(r.level)) skipped += 1; continue; }
    if (r.level === 'Pathfinder') { pathfinder += r.hundredths; continue; }
    if (!STAR_LEVELS.includes(r.level)) continue; // unknown never counts
    hours[r.level] += r.hundredths;
    counted += 1;
  }
  return { hours, counted, skipped, pathfinder };
}

/**
 * The carry-forward chain.
 * @param {object} p
 * @param {Object<string,number>} p.hoursByLevel  approved hundredths per star level
 * @param {Object<string,number>} [p.onRecord]    saved star instances per level (count by ad… id)
 * @param {Object<string,{onRecord:number,earnable:number}>|null} [p.baseline]
 *        per-level snapshot from first sync; legacy = max(0, onRecord − earnable) at that time
 * @param {Object<string,number>} [p.rates]
 * @returns {{ levels: Array<object>, newStars: number, conflicts: number }}
 *
 * Per level: available = hours + carryIn; earnable = floor(available/rate);
 * carryOut = available − earnable×rate (≥ 0 by construction); expected on
 * record = earnable + legacy; newStars = max(0, expected − onRecord);
 * conflict when onRecord > expected (stars the hours do not explain, beyond
 * baseline) or onRecord < baseline.onRecord (an instance disappeared).
 */
function computeStarChain({ hoursByLevel = {}, onRecord = {}, baseline = null, rates = RATE_HUNDREDTHS } = {}) {
  const levels = [];
  let carry = 0; // Tenderheart carry-in is always 0 — Pathfinder never carries
  let newStars = 0;
  let conflicts = 0;
  for (const level of STAR_LEVELS) {
    const rate = rates[level];
    const hours = int(hoursByLevel[level]);
    const available = hours + carry;
    const earnable = Math.floor(available / rate);
    const carryOut = available - earnable * rate;
    const rec = int(onRecord[level]);
    const base = baseline && baseline[level] ? baseline[level] : null;
    // Legacy stars: on record but not explained by the ledger at baseline
    // (paper-era history). Without a baseline, "now" is the baseline.
    const legacy = base ? Math.max(0, int(base.onRecord) - int(base.earnable)) : Math.max(0, rec - earnable);
    const expected = earnable + legacy;
    const proposed = Math.max(0, expected - rec);
    let conflict = null;
    if (base && rec < int(base.onRecord)) {
      conflict = { kind: 'instance_removed', onRecord: rec, baselineOnRecord: int(base.onRecord) };
    } else if (rec > expected) {
      conflict = { kind: 'more_on_record', onRecord: rec, expected, unexplained: rec - expected };
    }
    if (conflict) conflicts += 1;
    newStars += proposed;
    levels.push({
      level,
      rate,
      hours,
      carryIn: carry,
      available,
      earnable,
      carryOut,
      onRecord: rec,
      legacy,
      expected,
      newStars: proposed,
      conflict,
      toNext: { hundredths: rate - carryOut, pct: Math.floor((carryOut * 100) / rate) },
      display: { hours: formatHundredths(hours), carryIn: formatHundredths(carry), carryOut: formatHundredths(carryOut) },
    });
    carry = carryOut;
  }
  return { levels, newStars, conflicts };
}

/** Snapshot a computed chain as a baseline object ({ level: { onRecord, earnable } }). */
function baselineFrom(chain) {
  return Object.fromEntries(chain.levels.map((l) => [l.level, { onRecord: l.onRecord, earnable: l.earnable }]));
}

/**
 * Soft cross-check against AHGFamily's own `Stars Eligible`. Two known,
 * legitimate reasons theirs exceeds ours: it counts approved + PENDING
 * hours, and it carries PATHFINDER hours into Tenderheart (confirmed on
 * the first live pull, Sept 2026) — troop policy excludes both. Returns
 * notes, never throws; a disagreement is explained, not alarmed.
 * @param {{pathfinderHundredths?:number, pendingByLevel?:Object<string,number>}} [ctx]
 */
function crossCheckEligibility(chain, eligibilityRows, { pathfinderHundredths = 0, pendingByLevel = {} } = {}) {
  const notes = [];
  for (const l of chain.levels) {
    const e = (eligibilityRows || []).find((r) => r.level === l.level);
    if (!e || e.starsEligible === null || e.starsEligible === undefined) continue;
    if (e.starsEligible === l.earnable) continue;
    let note;
    if (e.starsEligible > l.earnable) {
      const pending = int(pendingByLevel[l.level]);
      const withPathfinder = l.level === 'Tenderheart' ? Math.floor((l.available + int(pathfinderHundredths)) / l.rate) : null;
      const withPending = Math.floor((l.available + pending) / l.rate);
      if (withPathfinder !== null && withPathfinder >= e.starsEligible) note = `AHGFamily carries Pathfinder hours (${formatHundredths(pathfinderHundredths)} h) into Tenderheart; troop policy excludes them`;
      else if (withPending >= e.starsEligible) note = `AHGFamily counts pending (unapproved) hours (${formatHundredths(pending)} h) toward eligibility; the tracker counts approved hours only`;
      else note = 'AHGFamily reports more than approved hours explain (pending and Pathfinder hours do not close the gap) — check the ledger read';
    } else {
      note = 'tracker computes more than AHGFamily reports — check the ledger read and the carry-in';
    }
    notes.push({ level: l.level, ours: l.earnable, theirs: e.starsEligible, note });
  }
  return notes;
}

const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

module.exports = { RATE_HUNDREDTHS, STAR_AWARD_IDS, LEVEL_BY_AWARD_ID, STAR_LEVELS, sumApprovedByLevel, computeStarChain, baselineFrom, crossCheckEligibility };
