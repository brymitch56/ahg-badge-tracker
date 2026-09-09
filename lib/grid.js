'use strict';
/**
 * grid.js — parser for the kartik-v GridView tables (Yii2) AHGFamily uses on
 * /activities and on the member profile tabs. Header-driven: a caller looks
 * a table up by the labels in its <th> row and reads cells by label, so the
 * column order and the cosmetic markup inside a cell can change without
 * breaking a read. No DOM library (same policy as parse.js).
 *
 * Shapes this handles (all observed in captures, see
 * data/captures/service-notes.md — local only):
 *   - <thead> holds the label row AND a filter row (tr.filters) — skipped;
 *   - the page-summary row (tr.kv-page-summary, "Total …") can sit in its
 *     own <tbody class="kv-page-summary-container"> OR inside the data
 *     <tbody> — it is ALWAYS excluded from rows (summing it doubles totals);
 *   - the pager summary ("Showing 1-25 of 40 items." / "Total 671 items.")
 *     lives in div.summary of the enclosing div.grid-view;
 *   - the toggleData control (id "<grid>-togdata-page") carries the
 *     grid-specific `_tog<hash>=all` parameter — discovered, never hardcoded.
 *
 * Nothing here follows a link. Cells expose their hrefs as data because
 * some of them (toggleServiceVerified, Delete?) are WRITES when fetched.
 */
const { decodeHtml } = require('./ahgfamily');

const ATTR_RE = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
function attrsOf(s) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s || ''))) {
    if (m[1] === '/') continue;
    out[m[1].toLowerCase()] = decodeHtml(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** Visible text of an HTML snippet: tags stripped, entities decoded, whitespace collapsed. */
function textOf(html) {
  return decodeHtml(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every href / data-url in a snippet, decoded (never fetched). */
function hrefsOf(html) {
  const out = [];
  const re = /<a\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const a = attrsOf(m[1]);
    if (a.href) out.push(a.href);
  }
  return out;
}

const hasClass = (attrs, cls) => ` ${attrs.class || ''} `.includes(` ${cls} `);

/** Header label → canonical key: lower-case letters and digits only. */
const keyOf = (label) => String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function parseRow(trAttrs, inner) {
  const cells = [];
  const re = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = re.exec(inner))) {
    const a = attrsOf(m[2]);
    cells.push({ tag: m[1].toLowerCase(), attrs: a, html: m[3], text: textOf(m[3]), hrefs: hrefsOf(m[3]), colspan: Number(a.colspan || 1) });
  }
  return { attrs: trAttrs, key: trAttrs['data-key'] || null, cells };
}

/**
 * Parse every <table> in an HTML string.
 * @returns {Array<{ id, headers, keys, rows, summaryRow, summary, toggleParam, pos }>}
 *   headers  — visible <th> labels in order
 *   keys     — keyOf(header) in the same order
 *   rows     — data rows only: [{ key, cells: [{ text, html, hrefs }], byKey: { <key>: cell } }]
 *   summaryRow — cells of the kv-page-summary row, or null (never in rows)
 *   summary  — { from, to, total } from "Showing 1-25 of 40 items." / { total } from "Total 671 items." / null
 *   toggleParam — "_tog<hash>" for the grid's Show-all control, or null
 */
function parseTables(html) {
  const out = [];
  const tableRe = /<table\b([^>]*)>([\s\S]*?)<\/table\s*>/gi;
  let m;
  while ((m = tableRe.exec(html))) {
    const pos = m.index;
    const inner = m[2];
    const headers = [];
    const rows = [];
    let summaryRow = null;
    const trRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr\s*>/gi;
    let t;
    while ((t = trRe.exec(inner))) {
      const a = attrsOf(t[1]);
      const row = parseRow(a, t[2]);
      if (!row.cells.length) continue;
      if (hasClass(a, 'kv-page-summary')) { summaryRow = row.cells; continue; }
      if (hasClass(a, 'filters')) continue;
      if (!headers.length && row.cells.every((c) => c.tag === 'th')) {
        for (const c of row.cells) headers.push(c.text);
        continue;
      }
      if (row.cells.every((c) => c.tag === 'th')) continue; // a second header row
      rows.push(row);
    }
    const keys = headers.map(keyOf);
    for (const r of rows) {
      r.byKey = {};
      let col = 0;
      for (const c of r.cells) {
        if (keys[col] !== undefined) r.byKey[keys[col]] = c;
        col += c.colspan;
      }
    }
    // enclosing grid-view container (nearest preceding), for summary/toggle
    const before = html.slice(0, pos);
    const gv = lastMatch(before, /<div\b([^>]*\bgrid-view\b[^>]*)>/gi);
    let id = null;
    let summary = null;
    let toggleParam = null;
    if (gv) {
      id = attrsOf(gv.m[1]).id || null;
      const region = html.slice(gv.index, pos);
      const sm = /<div\b[^>]*\bclass=["'][^"']*\bsummary\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/i.exec(region);
      if (sm) summary = parseSummary(textOf(sm[1]));
      const tg = /_tog[a-z0-9]+(?==all)/i.exec(region);
      if (tg) toggleParam = tg[0];
    }
    out.push({ id, pos, headers, keys, rows, summaryRow, summary, toggleParam });
  }
  return out;
}

function lastMatch(s, re) {
  let last = null;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(s))) last = { index: m.index, m };
  return last;
}

/** "Showing 1-25 of 40 items." → { from, to, total }; "Total 671 items." → { total }. */
function parseSummary(text) {
  let m;
  if ((m = /showing\s+([\d,]+)\s*[-–]\s*([\d,]+)\s+of\s+([\d,]+)\s+items?/i.exec(text))) {
    return { from: num(m[1]), to: num(m[2]), total: num(m[3]) };
  }
  if ((m = /total\s+([\d,]+)\s+items?/i.exec(text))) return { total: num(m[1]) };
  return null;
}
const num = (s) => Number(String(s).replace(/,/g, ''));

/** First table whose headers include EVERY label in `labels` (keyOf-compared). */
function findTable(tables, labels) {
  const want = labels.map(keyOf);
  return tables.find((t) => want.every((k) => t.keys.includes(k))) || null;
}

module.exports = { parseTables, findTable, textOf, hrefsOf, attrsOf, keyOf, parseSummary };
