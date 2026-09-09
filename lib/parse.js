'use strict';
/**
 * parse.js — HTML parsers for the AHGFamily advancement pages. No DOM
 * library: a small tokenizer plus position-based heuristics, because the
 * exact markup of the Standard-view fragment was not captured verbatim (see
 * the reverse-engineering report, §C3). Every heuristic records a warning
 * in `parse.warnings` instead of failing silently, so a wrong guess shows up
 * in the fetch summary.
 *
 * Nothing here writes anywhere. The parsers accept HTML strings and return
 * plain objects; `scrubPersonal()` is what removes youth / record ids before
 * an award is written to disk.
 */

const { decodeHtml } = require('./ahgfamily');

const RE = {
  awardId: /^aw[a-z0-9]{10}$/,
  levelId: /^le[a-z0-9]{10}$/,
  youthId: /^u[a-z0-9]{11}$/,
  recordId: /^ad[a-z0-9]{10}$/,
  reqId: /^[a-z0-9]{12}$/,
};

// ------------------------------------------------------ text classifier ----
const NUM_WORDS = 'all|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d+';
const HEADING_RE = new RegExp(`^(?:[a-z &/]+\\s+)?complete\\s+(?:at\\s+least\\s+)?(${NUM_WORDS})\\b.*$`, 'i');
const HANDBOOK_HEADING_RE = /^(?:\(?(?:current|\d{4})\s+handbook\)?|[^.]{0,40}\bhandbook\)?)$/i;
const CHROME_RE = /^(?:comment|comments|date|earned on|earned on:|completed on|completed on:|awarded on|awarded on:|purchased|purchased:|delete|remove|add awards? instance|awarded|completed|actions?|#|no\.?|item|items|requirement|requirements|track date|progress|x|\*|:|-|—|save|submit|cancel|yes|no|mm\/dd\/yyyy|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,3}\s?%|\d{1,3}\s*\/\s*\d{1,3}|check all|uncheck all|submit progress|select\s*[.…]*|please select[.…]*)$/i;
const NUMBERED_RE = /^(\d{1,2})\s*[.):]\s*(.*)$/;
const NUMBERED_MARKER_RE = /^(\d{1,2})\s*[.):]?$/;
const LETTERED_RE = /^([a-z])\s*[.):]\s+(.*)$/i;
const LETTERED_MARKER_RE = /^([a-z])\s*[.):]$/i;

// ------------------------------------------------------------- tokenizer ---
const ATTR_RE = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
function parseAttrs(s) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s))) {
    const k = m[1].toLowerCase();
    if (k === '/') continue;
    out[k] = decodeHtml(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

const TOKEN_RE = /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*\/?>|([^<]+)/g;

// Text inside these never contributes to a title / heading.
const SILENT = new Set(['select', 'option', 'button', 'textarea', 'script', 'style', 'noscript']);
const VOID = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'col', 'wbr', 'area', 'base', 'source', 'track', 'embed', 'param']);

// h4 on the live site; h1/h2 are the award/panel title, never a group.
const HEADING_TAGS = new Set(['h3', 'h4', 'h5', 'h6', 'th']);

// Text inside a heading element (h1–h6, th) is merged into ONE token flagged
// `heading: true`, because AHGFamily nests markup inside its group headings
// ("Complete All (<em>Current Handbook</em>)") and also puts the progress
// donut's "0/100" inside them — chrome pieces are dropped from the merge.
function tokenize(html) {
  const tokens = [];
  const stack = [];
  let heading = null; // { tag, pos, parts }
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(html))) {
    const pos = m.index;
    if (m[1]) { // close
      const tag = m[1].toLowerCase();
      const i = stack.lastIndexOf(tag);
      if (i >= 0) stack.length = i;
      if (heading && heading.tag === tag) {
        const text = heading.parts.join(' ').replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
        if (text) tokens.push({ kind: 'text', text, pos: heading.pos, heading: true, silent: false });
        heading = null;
      }
      tokens.push({ kind: 'close', tag, pos });
    } else if (m[2]) { // open
      const tag = m[2].toLowerCase();
      const attrs = parseAttrs(m[3] || '');
      tokens.push({ kind: 'open', tag, attrs, pos, silent: stack.some((t) => SILENT.has(t)) });
      if (!VOID.has(tag) && !/\/>$/.test(m[0])) stack.push(tag);
      if (!heading && HEADING_TAGS.has(tag)) heading = { tag, pos, parts: [] };
    } else if (m[4] !== undefined) { // text
      const text = decodeHtml(m[4]).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const silent = stack.some((t) => SILENT.has(t));
      if (heading && !silent) { if (!CHROME_RE.test(text)) heading.parts.push(text); continue; }
      tokens.push({ kind: 'text', text, pos, silent });
    }
  }
  return tokens;
}

// ------------------------------------------------------ select parsers -----
function selectBlock(html, id) {
  const re = new RegExp(`<select\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/select\\s*>`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

const isRetired = (name) => /\(\s*retired\s*\)/i.test(name || '');

/** #badge-select → [{ awardId, name, imageSlug, levelGroup, retired }] */
function parseBadgeSelect(html) {
  const block = selectBlock(html, 'badge-select');
  if (block === null) throw new Error('#badge-select not found on the page.');
  const out = [];
  let group = null;
  const re = /<optgroup\b([^>]*)>|<\/optgroup\s*>|<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi;
  let m;
  while ((m = re.exec(block))) {
    if (m[0].startsWith('</optgroup')) { group = null; continue; }
    if (m[1] !== undefined) { group = parseAttrs(m[1]).label || null; continue; }
    const attrs = parseAttrs(m[2] || '');
    const value = (attrs.value || '').trim();
    if (!RE.awardId.test(value)) continue; // skip "Select…" placeholders
    const text = decodeHtml(m[3]).replace(/\s+/g, ' ').trim();
    const bar = text.lastIndexOf('|');
    const name = bar >= 0 ? text.slice(0, bar).trim() : text;
    out.push({
      awardId: value,
      name,
      imageSlug: bar >= 0 ? text.slice(bar + 1).trim() : null,
      levelGroup: group,
      // "(Retired)" awards stay in AHGFamily's list but can no longer be
      // earned — the planner/tracker must never offer them.
      retired: isRetired(name),
    });
  }
  return out;
}

/** #youth-select → youth ids only (never names). */
function parseYouthSelect(html) {
  const block = selectBlock(html, 'youth-select');
  if (block === null) throw new Error('#youth-select not found on the page.');
  const ids = [];
  const re = /<option\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(block))) {
    const v = (parseAttrs(m[1] || '').value || '').trim();
    if (RE.youthId.test(v) && !ids.includes(v)) ids.push(v);
  }
  return ids;
}

/**
 * #youth-select → [{ id, name }] pairs for the tracker's mapping screen.
 * Names are roster PII: this parser's output lives only in tracker.db on
 * the Pi (spec §4 girls mapping source 2) — it is never logged, written to
 * data/, or committed. Everything else in this repo that touches the page
 * uses parseYouthSelect (ids only).
 */
function parseYouthSelectPairs(html) {
  const block = selectBlock(html, 'youth-select');
  if (block === null) throw new Error('#youth-select not found on the page.');
  const out = [];
  const seen = new Set();
  const re = /<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi;
  let m;
  while ((m = re.exec(block))) {
    const id = (parseAttrs(m[1] || '').value || '').trim();
    if (!RE.youthId.test(id) || seen.has(id)) continue;
    const name = decodeHtml(m[2]).replace(/\s+/g, ' ').trim();
    if (!name) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

/** #level-select → [{ code, label }] (level CODES: all|path|tend|expl|pipa|adult). */
function parseLevelSelect(html) {
  const block = selectBlock(html, 'level-select');
  if (block === null) return [];
  const out = [];
  const re = /<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi;
  let m;
  while ((m = re.exec(block))) {
    const code = (parseAttrs(m[1] || '').value || '').trim();
    if (!code) continue;
    out.push({ code, label: decodeHtml(m[2]).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/**
 * Grid fragment → per-cell state for the tracker's pull (spec §7):
 * [{ youthId, itemId, levelId, value }] from every
 * div.advance-icon[data-yt][data-id][data-value] cell. `itemId` may be a
 * requirement id OR the award id (the whole-award row); the caller maps
 * ids against its catalog. Output contains youth ids — it lives only in
 * tracker.db, never in logs or files.
 */
function parseGridState(html) {
  const out = [];
  const re = /<div\b([^>]*\badvance-icon\b[^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const a = parseAttrs(m[1]);
    if (!(a.class || '').split(/\s+/).includes('advance-icon')) continue;
    const youthId = (a['data-yt'] || '').trim();
    const itemId = (a['data-id'] || '').trim();
    if (!RE.youthId.test(youthId) || !RE.reqId.test(itemId)) continue;
    out.push({
      youthId,
      itemId,
      levelId: RE.levelId.test((a['data-level'] || '').trim()) ? a['data-level'].trim() : null,
      value: (a['data-value'] || '').trim() === '1' ? 1 : 0,
    });
  }
  return out;
}

// ------------------------------------------------------------- dates -----
/**
 * AHGFamily renders dates as M/D/YYYY (Standard-view fields, profile
 * grids), MM/DD/YY (the /activities grid) or, rarely, already ISO. Unix
 * epoch 0 shows up as a real-looking date on real records (`12/31/1969`,
 * or `01/01/1970` in other zones) — site-wide, not a one-off — and must
 * read as "no date", never as 1969. Returns YYYY-MM-DD or null. (A push
 * must still echo the raw field verbatim; this helper is for READING.)
 */
function parseAhgDate(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  if (!t) return null;
  let y; let mo; let d;
  let m;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t))) {
    mo = Number(m[1]); d = Number(m[2]); y = Number(m[3]);
    if (m[3].length === 2) y += y >= 69 ? 1900 : 2000; // 69/70 = epoch-0 spellings
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) {
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
  } else {
    return null;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if ((y === 1969 && mo === 12 && d === 31) || (y === 1970 && mo === 1 && d === 1)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** True when a raw AHGFamily date string is the epoch-0 artefact. */
function isEpochZeroDate(s) {
  const t = String(s || '').trim();
  return /^(12\/31\/(19)?69|0?1\/0?1\/(19)?70|1969-12-31|1970-01-01)$/.test(t);
}

/**
 * Standard fragment (ONE youth) → completion detail the grid can't give:
 * checked state, date and comment per requirement, and the whole-award
 * ad… instance panels. Defensive: absent fields come back null, unknown
 * markup is skipped. Output may contain ad… record ids — tracker.db only.
 *
 * Instance panels (whole-award records; multi-instance awards such as
 * Service Stars render several) carry five fields each: `new-`,
 * `completed_on-`, `awarded_on-`, `purchased-`, `comment-` × <adHashid>.
 * THE DISCRIMINATOR IS `new-`: a blank slot the page offers for "Add
 * Awards Instance" carries `new-<id>="true"`; a saved instance has no
 * `new-` field at all. Panel counts are dynamic (5 earned ⇒ 5 real + 5
 * blank), so callers count instances as records where `!isNew` — never by
 * `records.length`, and never by "has a completed_on" (an instance saved
 * without a date is still an instance). Epoch-0 dates read as null.
 */
function parseStandardState(html, { awardId = null } = {}) {
  const items = new Map(); // reqId → { checked, date, comment }
  const records = new Map(); // adId → { adId, isNew, completedOn, awardedOn, purchased, comment }
  const item = (id) => {
    if (!items.has(id)) items.set(id, { checked: false, date: null, comment: null });
    return items.get(id);
  };
  const record = (id) => {
    if (!records.has(id)) records.set(id, { adId: id, isNew: false, completedOn: null, awardedOn: null, purchased: false, comment: null });
    return records.get(id);
  };
  const fields = [];
  let m;
  const inputRe = /<(input|textarea|select)\b([^>]*)>(?:([\s\S]*?)<\/\1\s*>)?/gi;
  while ((m = inputRe.exec(html))) {
    const attrs = parseAttrs(m[2]);
    const name = (attrs.name || '').trim();
    if (!name) continue;
    const value = m[1].toLowerCase() === 'textarea' ? decodeHtml(m[3] || '').trim() : (attrs.value || '').trim();
    fields.push({ name, attrs, value });
  }
  const dateOrNull = (v) => (v && !isEpochZeroDate(v) ? v : null);
  // Pass 1: fields whose name alone says "instance panel" (an ad… id
  // after new-/completed_on-/awarded_on-/purchased-). A requirement id is
  // 12 random chars and CAN start with "ad", so `date-`/`comment-` are
  // resolved in pass 2 against the ids pass 1 learned.
  for (const f of fields) {
    let g;
    if ((g = /^new-(ad[a-z0-9]{10})$/.exec(f.name))) {
      record(g[1]).isNew = true;
    } else if ((g = /^completed_on-(ad[a-z0-9]{10})$/.exec(f.name))) {
      record(g[1]).completedOn = dateOrNull(f.value);
    } else if ((g = /^awarded_on-(ad[a-z0-9]{10})$/.exec(f.name))) {
      record(g[1]).awardedOn = dateOrNull(f.value);
    } else if ((g = /^purchased-(ad[a-z0-9]{10})$/.exec(f.name))) {
      record(g[1]).purchased = /^(1|true|on|yes)$/i.test(f.value) || 'checked' in f.attrs;
    }
  }
  for (const f of fields) {
    let g;
    if ((g = /^checkbox-([a-z0-9]{12})$/.exec(f.name)) && g[1] !== awardId) {
      item(g[1]).checked = 'checked' in f.attrs || /^(checked|true|1)$/i.test(f.attrs.checked || '');
    } else if ((g = /^date-([a-z0-9]{12})$/.exec(f.name)) && g[1] !== awardId) {
      if (records.has(g[1])) continue;
      if (f.value) item(g[1]).date = f.value;
    } else if ((g = /^comment-([a-z0-9]{12})$/.exec(f.name)) && g[1] !== awardId) {
      if (records.has(g[1])) { if (f.value) records.get(g[1]).comment = f.value; continue; }
      if (f.value) item(g[1]).comment = f.value;
    }
  }
  const list = [...records.values()];
  return {
    items: Object.fromEntries(items),
    records: list,
    /** Saved instances only — what "stars on record" means. */
    instanceCount: list.filter((r) => !r.isNew).length,
  };
}

/** Every le… id mentioned anywhere in an HTML string (attribute values). */
function findLevelIds(html) {
  const set = new Set();
  const re = /\ble[a-z0-9]{10}\b/g;
  let m;
  while ((m = re.exec(html))) set.add(m[0]);
  return [...set];
}

function classify(text, { heading = false } = {}) {
  if (CHROME_RE.test(text)) return { type: 'chrome' };
  let m;
  if (heading) {
    // An <h4> is a group heading — unless it reads as a sentence of
    // instructions ("Pioneers and Patriots may complete EITHER …").
    if (text.length > 60 && /[.!?]$/.test(text)) return { type: 'instruction', text };
    return { type: 'heading', label: text };
  }
  // numbered / lettered first: "3. Read the handbook" is an item, not a heading
  if ((m = NUMBERED_MARKER_RE.exec(text))) return { type: 'number-marker', number: Number(m[1]) };
  if ((m = NUMBERED_RE.exec(text))) return { type: 'numbered', number: Number(m[1]), title: m[2].trim() };
  if ((m = LETTERED_MARKER_RE.exec(text))) return { type: 'letter-marker', letter: m[1].toLowerCase() };
  if ((m = LETTERED_RE.exec(text))) return { type: 'lettered', letter: m[1].toLowerCase(), title: m[2].trim() };
  if (HEADING_RE.test(text) && text.length <= 80) return { type: 'heading', label: text };
  if (HANDBOOK_HEADING_RE.test(text) && text.length <= 60) return { type: 'heading', label: text };
  if (/handbook/i.test(text) && text.length > 60) return { type: 'instruction', text };
  return { type: 'other', text };
}

// ------------------------------------------------------ group metadata -----
const WORD_N = { all: null, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
/**
 * Best-effort rule + handbook edition from a group label.
 *   "Complete All" → { rule: { type: 'all' } }
 *   "Complete Three", "…: Complete One", "(Choose One)" → { rule: { type: 'n_of', n } }
 *   anything else ("History and Rules", "Rifles") → { rule: null }
 *   "(Current Handbook)" → edition 'current'; "(2016 Handbook)" → edition '2016'
 * Only current-edition groups are plannable (Bryan, 2026-09-07: never the 2016 handbook).
 */
function groupMeta(label) {
  const out = { rule: null, edition: 'current', plannable: true };
  if (!label) return out;
  const m = /\b(complete|choose)\s+(?:at\s+least\s+)?(all|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\b/i.exec(label);
  if (m) {
    const w = m[2].toLowerCase();
    out.rule = w === 'all' ? { type: 'all' } : { type: 'n_of', n: WORD_N[w] ?? Number(w) };
  }
  const ed = /\b(\d{4})\s+handbook\b/i.exec(label);
  if (ed) { out.edition = ed[1]; out.plannable = false; }
  return out;
}

// ------------------------------------------------------ fragment parser ----
/**
 * Parse a Standard-style badge-tracker-view fragment.
 * @param {string} html
 * @param {{awardId:string, youthId?:string}} ctx
 * @returns {object} award structure (NOT yet scrubbed — call scrubPersonal)
 */
function parseFragment(html, ctx = {}) {
  const warnings = [];
  const tokens = tokenize(html);

  // --- 1. inputs by name ---------------------------------------------------
  const inputs = tokens.filter((t) => t.kind === 'open' && ['input', 'select', 'textarea'].includes(t.tag) && t.attrs.name);
  const items = new Map(); // reqId → { id, checkboxPos, positions: [] }
  const recordIds = new Set();
  const wholeKeys = { award: 0, record: 0 };
  let instancePanels = 0;
  // Pass 1: ids that are unambiguous by field name. `checkbox-X` is always a
  // requirement; `new-/completed_on-/awarded_on-/purchased-/deleted-` with an
  // ad… id is always a whole-award record. (A requirement id is 12 alnum
  // chars and CAN start with "ad", so `comment-X` / `date-X` are resolved in
  // pass 2 against what pass 1 learned.)
  for (const inp of inputs) {
    const name = inp.attrs.name;
    let m;
    // NB: requirement ids are 12 random chars and CAN start with "aw" (seen
    // live: awh6kv61gne7). Only this award's own id is excluded.
    if ((m = /^checkbox-([a-z0-9]{12})$/.exec(name)) && m[1] !== ctx.awardId) {
      const id = m[1];
      if (!items.has(id)) items.set(id, { id, checkboxPos: inp.pos, positions: [] });
      items.get(id).positions.push(inp.pos);
    } else if ((m = /^new-(ad[a-z0-9]{10})$/.exec(name))) {
      instancePanels++; recordIds.add(m[1]);
    } else if ((m = /^(completed_on|awarded_on|purchased|deleted)-(ad[a-z0-9]{10})$/.exec(name))) {
      recordIds.add(m[2]);
      if (m[1] === 'completed_on') wholeKeys.record++;
    } else if ((m = /^completed_on-(aw[a-z0-9]{10})$/.exec(name))) {
      wholeKeys.award++;
    }
  }
  for (const inp of inputs) {
    const m = /^(date|comment)-([a-z0-9]{12})$/.exec(inp.attrs.name);
    if (!m || m[2] === ctx.awardId) continue;
    const id = m[2];
    if (items.has(id)) items.get(id).positions.push(inp.pos);
    else if (recordIds.has(id)) { /* whole-award comment on a record panel */ }
    else if (RE.recordId.test(id) && recordIds.size) recordIds.add(id);
    else {
      // date/comment for an id with no checkbox — keep it visible, but it is not trackable
      items.set(id, { id, checkboxPos: null, positions: [inp.pos] });
    }
  }
  // Items without a checkbox (date-/comment- only) are not trackable; keep them but flag.
  const list = [...items.values()]
    .map((it) => ({ ...it, start: Math.min(...it.positions), end: Math.max(...it.positions) }))
    .sort((a, b) => a.start - b.start);
  for (const it of list) if (it.checkboxPos === null) warnings.push(`item ${it.id} has date/comment fields but no checkbox`);

  // --- 2. text blocks -------------------------------------------------------
  const texts = tokens.filter((t) => t.kind === 'text' && !t.silent);

  // --- 3. level id ----------------------------------------------------------
  const levelIds = new Set();
  for (const t of tokens) {
    if (t.kind !== 'open') continue;
    for (const v of Object.values(t.attrs)) if (RE.levelId.test(v)) levelIds.add(v);
  }
  if (levelIds.size === 0) for (const id of findLevelIds(html)) levelIds.add(id);
  const levelId = levelIds.size ? [...levelIds][0] : null;
  // No warning when absent: the live Standard fragment never carries one —
  // the fetch script fills levelId from the Grid fragment instead.
  if (levelIds.size > 1) warnings.push(`multiple level ids in fragment: ${[...levelIds].join(',')} — used first`);

  // --- 4. segment text into per-item windows and walk ---------------------
  // Two candidate layouts: title BEFORE the item's inputs (window = text
  // after previous item's last input, up to this item's last input) or title
  // AFTER (window = from this item's first input to the next item's first
  // input). Build both, keep the one that titles more items.
  function build(mode) {
    const w = [];
    const bounds = list.map((it, i) => (mode === 'title-first'
      ? [i === 0 ? -1 : list[i - 1].end, it.end]
      : [it.start, i === list.length - 1 ? Infinity : list[i + 1].start]));
    if (list.length === 0) return walk([], [], mode);
    // In title-first mode, text after the last item's inputs is ignored; in
    // title-after mode, text before the first item's inputs is ignored.
    // Headings in the ignored region are still honored by the walk below
    // via a leading pseudo-window.
    const lead = mode === 'title-first' ? [] : texts.filter((t) => t.pos < list[0].start);
    for (const [lo, hi] of bounds) w.push(texts.filter((t) => t.pos > lo && t.pos <= hi));
    return walk(w, lead, mode);
  }

  function walk(windows, lead, mode) {
    const wlist = [];
    const groups = [];
    const instructions = [];
    let group = null;
    let pendingParent = null;
    let titled = 0;
    let numberedSeen = [];
    const ensureGroup = () => {
      if (!group) { group = { label: null, items: [] }; groups.push(group); }
      return group;
    };
    const applyLead = (blocks) => {
      for (const b of blocks) {
        const c = classify(b.text, { heading: !!b.heading });
        if (c.type === 'heading') { group = { label: c.label, items: [] }; groups.push(group); pendingParent = null; }
        else if (c.type === 'instruction') instructions.push(c.text);
      }
    };
    applyLead(lead);

    windows.forEach((blocks, i) => {
      const it = list[i];
      let lastNumbered = null;
      let lastLettered = null;
      let carry = null; // marker awaiting its text
      let finalized = false;
      const finalize = () => {
        if (finalized) return;
        finalized = true;
        const g = ensureGroup();
        if (lastLettered) {
          const leaf = { id: it.id, letter: lastLettered.letter, title: lastLettered.title };
          if (lastNumbered) {
            pendingParent = { id: null, number: lastNumbered.number, title: lastNumbered.title, children: [leaf] };
            g.items.push(pendingParent);
            numberedSeen.push(lastNumbered.number);
          } else if (pendingParent) {
            pendingParent.children.push(leaf);
          } else {
            g.items.push({ id: it.id, number: null, letter: leaf.letter, title: leaf.title });
            wlist.push(`item ${it.id}: lettered leaf "${leaf.letter}" with no parent item`);
          }
          titled++;
        } else if (lastNumbered) {
          g.items.push({ id: it.id, number: lastNumbered.number, title: lastNumbered.title });
          numberedSeen.push(lastNumbered.number);
          pendingParent = null;
          titled++;
        } else {
          g.items.push({ id: it.id, number: null, title: null });
          wlist.push(`item ${it.id}: no title text found`);
        }
      };

      for (const b of blocks) {
        let c = classify(b.text, { heading: !!b.heading });
        if (carry) {
          // a bare "1." / "a." marker takes the next non-chrome block as its title
          if (c.type !== 'chrome') {
            c = carry.type === 'number-marker'
              ? { type: 'numbered', number: carry.number, title: b.text }
              : { type: 'lettered', letter: carry.letter, title: b.text };
          }
          carry = null;
        }
        switch (c.type) {
          case 'heading':
            if (lastNumbered || lastLettered) finalize(); // title-after layouts: heading follows this item
            group = { label: c.label, items: [] }; groups.push(group); pendingParent = null;
            break;
          case 'instruction': instructions.push(c.text); break;
          case 'number-marker': case 'letter-marker': carry = c; break;
          case 'numbered':
            if (lastNumbered && !lastLettered) wlist.push(`item ${it.id}: two numbered blocks in one window (${lastNumbered.number}, ${c.number}) — used last`);
            lastNumbered = { number: c.number, title: c.title }; lastLettered = null;
            break;
          case 'lettered':
            lastLettered = { letter: c.letter, title: c.title };
            break;
          case 'other':
            // continuation of the immediately preceding title (split by inline markup)
            if (lastLettered && !lastLettered.closed) lastLettered.title = `${lastLettered.title} ${b.text}`.trim();
            else if (lastNumbered && !lastNumbered.closed) lastNumbered.title = `${lastNumbered.title} ${b.text}`.trim();
            break;
          default: // chrome closes any open title
            if (lastLettered) lastLettered.closed = true;
            if (lastNumbered) lastNumbered.closed = true;
        }
      }
      finalize();
    });
    for (const g of groups) for (const it of g.items) { delete it.closed; if (it.children) for (const c of it.children) delete c.closed; }
    // numbering monotonic within the award = second scoring signal
    let mono = 0;
    for (let i = 1; i < numberedSeen.length; i++) if (numberedSeen[i] === numberedSeen[i - 1] + 1) mono++;
    return { groups: groups.filter((g) => g.items.length || g.label), instructions, warnings: wlist, score: titled * 10 + mono, mode };
  }

  const candidates = [build('title-first'), build('title-after')];
  const best = candidates[1].score > candidates[0].score ? candidates[1] : candidates[0];
  // (a tie is normal on the live layout — checkbox, title, date — and both
  // segmentations give the same answer, so it is not reported)
  warnings.push(...best.warnings);

  // Headings with no items under them are instructions, not groups.
  const groups = [];
  for (const g of best.groups) {
    if (!g.items.length) { if (g.label) best.instructions.push(g.label); continue; }
    groups.push({ label: g.label, ...groupMeta(g.label), items: g.items });
  }

  const leafCount = list.filter((it) => it.checkboxPos !== null).length;
  const hasLetteredLeaves = groups.some((g) => g.items.some((it) => Array.isArray(it.children) && it.children.length));
  // Numbering should be continuous across "complete all / complete N" groups;
  // a restart at 1 on a group boundary (handbook-edition alternatives) is fine.
  const seq = groups.flatMap((g, gi) => g.items.filter((it) => it.number !== null).map((it, ii) => ({ n: it.number, first: ii === 0 && gi > 0 })));
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].n === seq[i - 1].n + 1) continue;
    if (seq[i].first && seq[i].n === 1) continue;
    warnings.push(`numbering not continuous: ${seq.map((s) => s.n).join(',')}`); break;
  }

  return {
    awardId: ctx.awardId || null,
    levelId,
    wholeAwardOnly: leafCount === 0,
    multiInstance: instancePanels > 0,
    instancePanels,
    wholeAwardKeyedBy: wholeKeys.record ? 'record' : (wholeKeys.award ? 'award' : null),
    instructions: best.instructions,
    groups,
    itemCount: leafCount,
    hasLetteredLeaves,
    parse: { mode: best.mode, warnings },
    _recordIds: [...recordIds], // removed by scrubPersonal
  };
}

// ---------------------------------------------------------- grid parser ----
/**
 * Parse a Grid-style badge-tracker-view fragment: a table of
 * `div.advance-icon[data-id][data-yt][data-level][data-value]` cells.
 * The Standard fragment carries no level id at all (confirmed on the live
 * site 2026-09-07), so this is where `le…` comes from. Also yields the
 * requirement ids the grid knows about, for cross-checking the Standard
 * parse. `data-id` values `p_…`/`a_…` (purchased/awarded rows) are skipped.
 * Nothing girl-specific is returned except through `youthIds` (for scrubbing).
 */
function parseGridFragment(html, { awardId = null } = {}) {
  const tokens = tokenize(html);
  const levelIds = new Set();
  const requirementIds = new Set();
  const youthIds = new Set();
  let cells = 0;
  for (const t of tokens) {
    if (t.kind !== 'open' || t.tag !== 'div') continue;
    const cls = ` ${t.attrs.class || ''} `;
    if (!cls.includes(' advance-icon ')) continue;
    cells++;
    const id = (t.attrs['data-id'] || '').trim();
    const level = (t.attrs['data-level'] || '').trim();
    const yt = (t.attrs['data-yt'] || '').trim();
    if (RE.levelId.test(level)) levelIds.add(level);
    if (RE.youthId.test(yt)) youthIds.add(yt);
    if (RE.reqId.test(id) && id !== awardId) requirementIds.add(id);
  }
  if (levelIds.size === 0) for (const id of findLevelIds(html)) levelIds.add(id);
  return {
    levelId: levelIds.size ? [...levelIds][0] : null,
    levelIds: [...levelIds],
    requirementIds: [...requirementIds],
    youthIds: [...youthIds],
    cells,
  };
}

// ---------------------------------------------------------------- scrub ----
/**
 * Replace youth ids and advancement-record ids with placeholders everywhere
 * in the award object (recursively, in strings). Only ids we actually saw
 * are replaced — requirement ids are 12 alnum chars and could start with
 * "ad" by chance, so a blanket regex would corrupt the catalog.
 */
function scrubPersonal(award, { youthIds = [] } = {}) {
  const recordIds = award._recordIds || [];
  const map = new Map();
  for (const y of youthIds) map.set(y, '<youthHashid>');
  for (const r of recordIds) map.set(r, '<adHashid>');
  const scrubStr = (s) => { let o = s; for (const [k, v] of map) o = o.split(k).join(v); return o; };
  const rec = (v) => {
    if (typeof v === 'string') return scrubStr(v);
    if (Array.isArray(v)) return v.map(rec);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) if (k !== '_recordIds') o[scrubStr(k)] = rec(x);
      return o;
    }
    return v;
  };
  return rec(award);
}

/**
 * True if the text still contains something that looks like a youth id
 * (u + 11 alnum, with at least one digit so 12-letter words like
 * "universities" don't trip it). Advisory only — scrubPersonal() removes the
 * ids we actually saw; this catches anything unexpected.
 */
function containsYouthId(text) { return /\bu(?=[a-z0-9]{11}\b)[a-z0-9]*\d[a-z0-9]*\b/.test(text); }

module.exports = {
  RE, tokenize, parseAttrs, isRetired, parseBadgeSelect, parseYouthSelect, parseYouthSelectPairs, parseLevelSelect, findLevelIds,
  classify, groupMeta, parseFragment, parseGridFragment, parseGridState, parseStandardState, parseAhgDate, isEpochZeroDate, scrubPersonal, containsYouthId,
};
