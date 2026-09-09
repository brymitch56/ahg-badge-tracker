'use strict';
/**
 * service.js — READ parsers for the AHGFamily service-hours pages that feed
 * Service Stars (docs/service-stars-plan.md; capture findings in
 * data/captures/service-notes.md, local only).
 *
 *   parseActivitiesIndex(html)   GET /activities — the troop-wide ledger
 *                                grid. Identity (youth hashid per row) and
 *                                the verified flag are reliable; the hour
 *                                VALUES ARE INTEGER-TRUNCATED on this page
 *                                (0.75 renders as 0) and are exposed only as
 *                                `hoursDisplayed`, never as hundredths.
 *   parseProfileAdvancement(html) GET /profile/<youthHashid>?tab=advancement
 *                                — one page carrying the girl's precise
 *                                service ledger (`Time Spent`, decimal),
 *                                AHGFamily's own eligibility table, and the
 *                                per-instance awards grid (aw…/ad… ids).
 *                                This is the PRIMARY hours source.
 *
 * Hours are fractional (0.25, 0.33, 1.75 … all live) and are returned as
 * INTEGER HUNDREDTHS — float summing mis-totals this exact dataset.
 *
 * Nothing here fetches. Cells' hrefs are parsed as data only: the Verified
 * toggle (`/fields/toggleServiceVerified/<id>`) is a GET that WRITES, and
 * every per-row Menu carries edit/Delete? controls — never follow either.
 * Output contains youth ids and record ids: tracker.db only, never logs.
 */
const { parseTables, findTable, textOf } = require('./grid');
const { parseAhgDate } = require('./parse');

const YOUTH_RE = /\/profile(?:\?id=|\/)(u[a-z0-9]{11})\b/;
const TOGGLE_RE = /toggleServiceVerified\/([a-z0-9]+)/i;
const STAR_LEVELS = ['Tenderheart', 'Explorer', 'Pioneer', 'Patriot'];
const ALL_LEVELS = ['Pathfinder', ...STAR_LEVELS];

/** "1.75" → 175, "0.33" → 33, "1,234" → 123400, "" / "(not set)" / "–" → null. Never floats. */
function hoursToHundredths(text) {
  const t = String(text ?? '').replace(/,/g, '').trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) return null;
  const whole = Number(m[2]);
  const frac = (m[3] || '').padEnd(2, '0');
  let cents = Number(frac.slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1; // 0.333 → 0.33, 0.335 → 0.34
  const v = whole * 100 + cents;
  return m[1] ? -v : v;
}

/** 175 → "1.75" (display only). */
function formatHundredths(n) {
  if (n === null || n === undefined) return '';
  const neg = n < 0;
  const a = Math.abs(Math.trunc(n));
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** Level label → canonical name, or null when it is not one of the five. */
function normalizeLevel(s) {
  const t = String(s || '').trim().toLowerCase();
  return ALL_LEVELS.find((l) => l.toLowerCase() === t) || null;
}

/**
 * Verified cell → true / false / null (unknown). Reads the toggle icon
 * class or title (HTML grids) or the Y/N text (exports). The href inside is
 * the write endpoint — read as data, never fetched.
 */
function parseVerifiedCell(cell) {
  if (!cell) return null;
  const html = cell.html || '';
  if (/toggle-green/.test(html) || /title=["']Verified["']/i.test(html) || /glyphicon-ok\b/.test(html)) return true;
  if (/toggle-red/.test(html) || /title=["']Not Verified["']/i.test(html) || /glyphicon-remove\b/.test(html)) return false;
  const t = (cell.text || '').trim().toLowerCase();
  if (t === 'y' || t === 'yes' || t === 'verified') return true;
  if (t === 'n' || t === 'no' || t === 'not verified') return false;
  return null;
}

const notSet = (t) => /^\(not set\)$/i.test(t || '') || t === '' || t === '–' || t === '-';

/**
 * GET /activities → { rows, summary, toggleParam, warnings, distinctYouth }.
 * rows: [{ youthId, recordId, date, activity, eventType, eventLevel,
 *          hoursDisplayed (INTEGER-TRUNCATED, display only), verified }]
 */
function parseActivitiesIndex(html) {
  const warnings = [];
  const tables = parseTables(html);
  const t = findTable(tables, ['Youth', 'Activity Date', 'Service Hours', 'Verified']);
  if (!t) return { rows: [], summary: null, toggleParam: null, warnings: ['activities grid not found'], distinctYouth: [] };
  const rows = [];
  const youth = new Set();
  for (const r of t.rows) {
    const yc = r.byKey.youth;
    const ym = yc && YOUTH_RE.exec(yc.html);
    if (!ym) { warnings.push(`row ${r.key || '?'}: no /profile?id= link in the Youth cell`); continue; }
    const vc = r.byKey.verified;
    const tm = vc && TOGGLE_RE.exec(vc.html);
    const rawDate = r.byKey.activitydate ? r.byKey.activitydate.text : '';
    const date = parseAhgDate(rawDate);
    if (!date) warnings.push(`row ${r.key || '?'}: unreadable date "${rawDate}"`);
    const level = normalizeLevel(r.byKey.eventlevel ? r.byKey.eventlevel.text : '');
    if (!level) warnings.push(`row ${r.key || '?'}: unknown Event Level "${r.byKey.eventlevel ? r.byKey.eventlevel.text : ''}"`);
    const hoursText = r.byKey.servicehours ? r.byKey.servicehours.text : '';
    const hours = hoursToHundredths(hoursText);
    youth.add(ym[1]);
    rows.push({
      youthId: ym[1],
      recordId: tm ? tm[1] : (r.key || null),
      date,
      activity: r.byKey.activity ? r.byKey.activity.text : null,
      eventType: r.byKey.eventtype && !notSet(r.byKey.eventtype.text) ? r.byKey.eventtype.text : null,
      eventLevel: level,
      // The grid floors hours to whole numbers: keep the integer for
      // indexing/sanity only. Real values come from the profile ledger.
      hoursDisplayed: hours === null ? null : Math.trunc(hours / 100),
      verified: parseVerifiedCell(vc),
    });
  }
  if (t.summary && t.summary.total !== undefined) {
    const expected = t.summary.to !== undefined ? t.summary.to - t.summary.from + 1 : t.summary.total;
    if (expected !== rows.length) warnings.push(`activities grid: summary says ${expected} rows on this page, parsed ${rows.length}`);
  }
  return { rows, summary: t.summary, toggleParam: t.toggleParam, warnings, distinctYouth: [...youth] };
}

/**
 * Awards-grid Progress cell → { done, total, pct } or null.
 * Renders as "10/12 83%" (two elements → a space after textOf) or, if the
 * markup ever runs the pieces together, "10/1283%": then every split of
 * the digits into total|pct is tried and the one whose pct equals
 * round(done/total×100) wins (pct never has a leading zero, so "0/100%" is
 * 0 of 10 at 0%, not 0 of 1 at "00"%).
 */
function parseProgress(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  let m;
  if ((m = /^(\d+)\s*\/\s*(\d+)\s+(\d{1,3})\s*%$/.exec(t))) return { done: Number(m[1]), total: Number(m[2]), pct: Number(m[3]) };
  if ((m = /^(\d+)\s*\/\s*(\d+)$/.exec(t))) return { done: Number(m[1]), total: Number(m[2]), pct: null };
  if (!(m = /^(\d+)\/(\d+)%$/.exec(t))) return null;
  const done = Number(m[1]);
  const digits = m[2];
  for (let cut = 1; cut < digits.length; cut++) {
    const totalS = digits.slice(0, cut);
    const pctS = digits.slice(cut);
    if (/^0\d/.test(pctS) || /^0\d/.test(totalS)) continue;
    const total = Number(totalS);
    const pct = Number(pctS);
    if (total > 0 && pct <= 100 && Math.round((done / total) * 100) === pct) return { done, total, pct };
  }
  return null;
}

/**
 * GET /profile/<youthHashid>?tab=advancement → the girl's whole picture.
 * @returns {{
 *   youthId: string|null,
 *   ledger: { rows: [{ recordId, date, description, hundredths, level, verified }], summary, complete },
 *   eligibility: { rows: [{ level, onLevel, total, extra, starsEligible }] },
 *   awards: { rows: [{ awardId, adId, program, title, progress, completedOn, awardedOn, purchased }], summary, complete },
 *   warnings: string[]
 * }}
 * `complete` is false when the pager summary reports more rows than the
 * page holds — the caller MUST page rather than trust a partial ledger (a
 * silent undercount suppresses stars). `eligibility.alreadyRecorded` is
 * deliberately not returned: that column collapses same-date instances.
 */
function parseProfileAdvancement(html) {
  const warnings = [];
  const tables = parseTables(html);
  const ym = /\/profile\/(u[a-z0-9]{11})\b|[?&]id=(u[a-z0-9]{11})\b/.exec(html);
  const youthId = ym ? (ym[1] || ym[2]) : null;

  // --- service ledger ------------------------------------------------------
  const ledger = { rows: [], summary: null, complete: false, pagerHrefs: [] };
  const lt = findTable(tables, ['Time Spent', 'Verified']);
  if (!lt) warnings.push('service ledger grid not found');
  else {
    for (const r of lt.rows) {
      const dateText = (r.byKey.servicedate || r.byKey.activitydate || r.byKey.date || {}).text || '';
      const date = parseAhgDate(dateText);
      if (!date) warnings.push(`ledger row ${r.key || '?'}: unreadable date "${dateText}"`);
      const hoursText = (r.byKey.timespent || {}).text || '';
      const hundredths = hoursToHundredths(hoursText);
      if (hundredths === null) warnings.push(`ledger row ${r.key || '?'}: unreadable hours "${hoursText}"`);
      const levelText = (r.byKey.girllevel || r.byKey.eventlevel || r.byKey.level || {}).text || '';
      const level = normalizeLevel(levelText);
      if (!level) warnings.push(`ledger row ${r.key || '?'}: unknown level "${levelText}"`);
      const vc = r.byKey.verified;
      const tm = vc && TOGGLE_RE.exec(vc.html);
      ledger.rows.push({
        recordId: tm ? tm[1] : (r.key || null),
        date,
        description: (r.byKey.actofservice || r.byKey.activity || r.byKey.description || {}).text || null,
        hundredths,
        level,
        verified: parseVerifiedCell(vc),
      });
    }
    ledger.summary = lt.summary;
    ledger.pagerHrefs = lt.pagerHrefs;
    ledger.complete = isComplete(lt.summary, ledger.rows.length, warnings, 'ledger');
  }

  // --- eligibility table (AHGFamily's own star math — cross-check only) -----
  const eligibility = { rows: [] };
  const et = findTable(tables, ['Stars Eligible']);
  if (!et) warnings.push('eligibility table not found');
  else {
    for (const r of et.rows) {
      const level = normalizeLevel((r.byKey.girllevel || r.byKey.level || r.cells[0] || {}).text || '');
      if (!level) continue;
      const n = (k) => (r.byKey[k] ? hoursToHundredths(r.byKey[k].text) : null);
      const se = r.byKey.starseligible ? (r.byKey.starseligible.text.match(/\d+/) || [null])[0] : null;
      eligibility.rows.push({
        level,
        onLevel: n('onlevelhours'),
        total: n('totalhours'),
        extra: n('extrahours'),
        starsEligible: se === null ? null : Number(se),
      });
    }
  }

  // --- awards grid (one row PER INSTANCE; aw…/ad… ids in the markup) --------
  const awards = { rows: [], summary: null, complete: false, pagerHrefs: [] };
  const at = findTable(tables, ['Awards Title']);
  if (!at) warnings.push('awards grid not found');
  else {
    for (const r of at.rows) {
      const rowHtml = r.cells.map((c) => c.html).join(' ');
      const awardIds = uniq(rowHtml.match(/\baw[a-z0-9]{10}\b/g) || []);
      const adIds = uniq([...(rowHtml.match(/\bad[a-z0-9]{10}\b/g) || []), ...(r.key && /^ad[a-z0-9]{10}$/.test(r.key) ? [r.key] : [])]);
      if (awardIds.length !== 1) warnings.push(`awards row ${r.key || '?'}: ${awardIds.length} award ids in the row`);
      if (adIds.length > 1) warnings.push(`awards row ${r.key || '?'}: ${adIds.length} record ids in the row — used first`);
      const dateCell = (r.byKey.completedon || {}).text || '';
      const pick = (label) => { const m = new RegExp(`${label}\\s*:?\\s*(\\d{1,2}/\\d{1,2}/\\d{2,4})`, 'i').exec(dateCell); return m ? parseAhgDate(m[1]) : null; };
      awards.rows.push({
        awardId: awardIds[0] || null,
        adId: adIds[0] || null,
        program: (r.byKey.program || {}).text || null,
        title: (r.byKey.awardstitle || {}).text || null,
        progress: parseProgress((r.byKey.progress || {}).text),
        completedOn: pick('Completed on') || (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(dateCell) ? parseAhgDate(dateCell) : null),
        awardedOn: pick('Awarded on'),
        purchased: /purchased\s*:?\s*(?:<[^>]*(?:glyphicon-ok|fa-check|toggle-green)|yes|y\b|1\b)/i.test((r.byKey.completedon || {}).html || ''),
      });
    }
    awards.summary = at.summary;
    awards.pagerHrefs = at.pagerHrefs;
    awards.complete = isComplete(at.summary, awards.rows.length, warnings, 'awards');
  }

  return { youthId, ledger, eligibility, awards, warnings };
}

function isComplete(summary, count, warnings, what) {
  if (!summary) return count > 0 || true; // no pager rendered = single page
  if (summary.total === undefined) return true;
  if (summary.from !== undefined && summary.to !== undefined) {
    const onPage = summary.to - summary.from + 1;
    if (onPage !== count) warnings.push(`${what}: summary says ${onPage} rows on this page, parsed ${count}`);
    if (summary.to < summary.total) { warnings.push(`${what}: ${summary.total} rows in total, this page ends at ${summary.to} — PAGE, do not trust a partial read`); return false; }
    return true;
  }
  if (summary.total !== count) { warnings.push(`${what}: summary says ${summary.total} rows, parsed ${count}`); return false; }
  return true;
}

const uniq = (a) => [...new Set(a)];

module.exports = {
  STAR_LEVELS, ALL_LEVELS, hoursToHundredths, formatHundredths, normalizeLevel, parseVerifiedCell, parseProgress,
  parseActivitiesIndex, parseProfileAdvancement, textOf,
};
