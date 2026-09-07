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

function tokenize(html) {
  const tokens = [];
  const stack = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(html))) {
    const pos = m.index;
    if (m[1]) { // close
      const tag = m[1].toLowerCase();
      const i = stack.lastIndexOf(tag);
      if (i >= 0) stack.length = i;
      tokens.push({ kind: 'close', tag, pos });
    } else if (m[2]) { // open
      const tag = m[2].toLowerCase();
      const attrs = parseAttrs(m[3] || '');
      tokens.push({ kind: 'open', tag, attrs, pos, silent: stack.some((t) => SILENT.has(t)) });
      if (!VOID.has(tag) && !/\/>$/.test(m[0])) stack.push(tag);
    } else if (m[4] !== undefined) { // text
      const text = decodeHtml(m[4]).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      tokens.push({ kind: 'text', text, pos, silent: stack.some((t) => SILENT.has(t)) });
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

/** Every le… id mentioned anywhere in an HTML string (attribute values). */
function findLevelIds(html) {
  const set = new Set();
  const re = /\ble[a-z0-9]{10}\b/g;
  let m;
  while ((m = re.exec(html))) set.add(m[0]);
  return [...set];
}

// ------------------------------------------------------ text classifier ----
const NUM_WORDS = 'all|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d+';
const HEADING_RE = new RegExp(`^(?:[a-z &/]+\\s+)?complete\\s+(?:at\\s+least\\s+)?(${NUM_WORDS})\\b.*$`, 'i');
const HANDBOOK_HEADING_RE = /^(?:\(?(?:current|\d{4})\s+handbook\)?|[^.]{0,40}\bhandbook\)?)$/i;
const CHROME_RE = /^(?:comment|comments|date|earned on|earned on:|completed on|completed on:|awarded on|awarded on:|purchased|purchased:|delete|remove|add awards? instance|awarded|completed|actions?|#|no\.?|item|items|requirement|requirements|track date|progress|x|\*|:|-|—|save|submit|cancel|yes|no|mm\/dd\/yyyy|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,3}\s?%|select\s*[.…]*|please select[.…]*)$/i;
const NUMBERED_RE = /^(\d{1,2})\s*[.):]\s*(.*)$/;
const NUMBERED_MARKER_RE = /^(\d{1,2})\s*[.):]?$/;
const LETTERED_RE = /^([a-z])\s*[.):]\s+(.*)$/i;
const LETTERED_MARKER_RE = /^([a-z])\s*[.):]$/i;

function classify(text) {
  if (CHROME_RE.test(text)) return { type: 'chrome' };
  let m;
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
    if ((m = /^checkbox-([a-z0-9]{12})$/.exec(name)) && !RE.awardId.test(m[1])) {
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
    if (!m || RE.awardId.test(m[2])) continue;
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
        const c = classify(b.text);
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
        let c = classify(b.text);
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
  if (candidates[0].score === candidates[1].score && list.length) {
    warnings.push('title-first and title-after layouts scored equally — used title-first');
  }
  warnings.push(...best.warnings);

  // Strip empty unlabeled placeholder groups; drop a leading unlabeled group only if it has no items.
  const groups = best.groups.filter((g) => g.items.length > 0 || g.label);

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
function parseGridFragment(html) {
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
    if (RE.reqId.test(id) && !RE.awardId.test(id)) requirementIds.add(id);
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
  RE, tokenize, parseAttrs, isRetired, parseBadgeSelect, parseYouthSelect, parseLevelSelect, findLevelIds,
  classify, parseFragment, parseGridFragment, scrubPersonal, containsYouthId,
};
