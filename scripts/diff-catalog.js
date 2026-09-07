#!/usr/bin/env node
'use strict';
/**
 * diff-catalog.js — compare a freshly fetched catalog (data/ahgfamily-staging/,
 * from `fetch-ahgfamily-catalog.js --staging`) against the live catalog
 * (data/ahgfamily/) and print a human-readable change report. Nothing is
 * changed unless a person runs `--apply` and types "yes" at the prompt.
 *
 * Offline: reads JSON only. No network.
 *
 * Usage:
 *   node scripts/diff-catalog.js                 report to stdout; exit 0 = no changes, 10 = changes
 *   node scripts/diff-catalog.js --json out.json also write the machine-readable diff
 *   node scripts/diff-catalog.js --md report.md  also write the report as Markdown (PR body)
 *   node scripts/diff-catalog.js --apply         after the report, ask for confirmation, then
 *                                                replace data/ahgfamily/ with the staging copy
 *                                                (the previous catalog is kept in
 *                                                data/ahgfamily-previous-<stamp>/)
 *   --plannable-only   ignore changes inside retired awards and non-current editions
 *
 * --apply refuses to run without an interactive terminal, so a scheduled job
 * can produce the report but can never apply it.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { makePaths } = require('./fetch-ahgfamily-catalog');

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

function loadCatalog(paths) {
  const index = readJson(paths.index);
  if (!index) return null;
  const awards = new Map();
  for (const a of index.awards) {
    const j = readJson(path.join(paths.awards, `${a.awardId}.json`));
    awards.set(a.awardId, { meta: a, data: j });
  }
  return { index, awards };
}

// Flatten an award's checkable items to id → { number, title, group, edition }
function flatten(award) {
  const out = new Map();
  if (!award) return out;
  for (const g of award.groups || []) {
    for (const it of g.items) {
      if (Array.isArray(it.children) && it.children.length) {
        for (const c of it.children) out.set(c.id, { number: `${it.number ?? '?'}${c.letter}`, title: `${it.title} — ${c.title}`, group: g.label, edition: g.edition || 'current' });
      } else if (it.id) {
        out.set(it.id, { number: String(it.number ?? '?'), title: it.title, group: g.label, edition: g.edition || 'current' });
      }
    }
  }
  return out;
}

const groupSig = (g) => `${g.label ?? ''}|${g.rule ? (g.rule.type === 'all' ? 'all' : `n_of:${g.rule.n}`) : '-'}|${g.edition || 'current'}`;

/** Compute the diff between two loaded catalogs. Pure. */
function diffCatalogs(current, staged, { plannableOnly = false } = {}) {
  const d = { added: [], removed: [], changed: [], unchanged: 0, summary: {} };
  const ids = new Set([...current.awards.keys(), ...staged.awards.keys()]);
  for (const id of [...ids].sort()) {
    const cur = current.awards.get(id);
    const nxt = staged.awards.get(id);
    if (!cur) { d.added.push({ awardId: id, name: nxt.meta.name, levelGroup: nxt.meta.levelGroup, items: nxt.data ? nxt.data.itemCount : null, retired: nxt.meta.retired }); continue; }
    if (!nxt) { d.removed.push({ awardId: id, name: cur.meta.name, levelGroup: cur.meta.levelGroup, items: cur.data ? cur.data.itemCount : null }); continue; }
    if (plannableOnly && cur.meta.retired && nxt.meta.retired) { d.unchanged++; continue; }

    const c = { awardId: id, name: nxt.meta.name, levelGroup: nxt.meta.levelGroup, award: [], groups: [], items: [] };
    if (cur.meta.name !== nxt.meta.name) c.award.push({ field: 'name', from: cur.meta.name, to: nxt.meta.name });
    if (cur.meta.levelGroup !== nxt.meta.levelGroup) c.award.push({ field: 'levelGroup', from: cur.meta.levelGroup, to: nxt.meta.levelGroup });
    if (!!cur.meta.retired !== !!nxt.meta.retired) c.award.push({ field: 'retired', from: !!cur.meta.retired, to: !!nxt.meta.retired });
    if (cur.data && nxt.data) {
      for (const f of ['wholeAwardOnly', 'multiInstance', 'hasLetteredLeaves']) {
        if (cur.data[f] !== nxt.data[f]) c.award.push({ field: f, from: cur.data[f], to: nxt.data[f] });
      }
      // groups: by position (labels can be relabelled), report label/rule/edition changes and count changes
      const cg = (cur.data.groups || []).filter((g) => !plannableOnly || g.plannable !== false);
      const ng = (nxt.data.groups || []).filter((g) => !plannableOnly || g.plannable !== false);
      const n = Math.max(cg.length, ng.length);
      for (let i = 0; i < n; i++) {
        const a = cg[i]; const b = ng[i];
        if (!a) c.groups.push({ kind: 'added', label: b.label, items: b.items.length });
        else if (!b) c.groups.push({ kind: 'removed', label: a.label, items: a.items.length });
        else if (groupSig(a) !== groupSig(b)) c.groups.push({ kind: 'changed', from: groupSig(a), to: groupSig(b) });
      }
      // items: by requirement id
      const ci = flatten({ groups: cg }); const ni = flatten({ groups: ng });
      for (const [rid, it] of ni) {
        const old = ci.get(rid);
        if (!old) { c.items.push({ kind: 'added', id: rid, number: it.number, title: it.title, group: it.group }); continue; }
        const fields = [];
        if (old.title !== it.title) fields.push({ field: 'title', from: old.title, to: it.title });
        if (old.number !== it.number) fields.push({ field: 'number', from: old.number, to: it.number });
        if ((old.group ?? '') !== (it.group ?? '')) fields.push({ field: 'group', from: old.group, to: it.group });
        if (fields.length) c.items.push({ kind: 'changed', id: rid, number: it.number, title: it.title, fields });
      }
      for (const [rid, it] of ci) if (!ni.has(rid)) c.items.push({ kind: 'removed', id: rid, number: it.number, title: it.title, group: it.group });
    } else if (!!cur.data !== !!nxt.data) {
      c.award.push({ field: 'fetched', from: !!cur.data, to: !!nxt.data });
    }
    if (c.award.length || c.groups.length || c.items.length) d.changed.push(c); else d.unchanged++;
  }
  d.summary = {
    awardsAdded: d.added.length, awardsRemoved: d.removed.length, awardsChanged: d.changed.length, awardsUnchanged: d.unchanged,
    itemsAdded: d.changed.reduce((n, c) => n + c.items.filter((i) => i.kind === 'added').length, 0),
    itemsRemoved: d.changed.reduce((n, c) => n + c.items.filter((i) => i.kind === 'removed').length, 0),
    itemsChanged: d.changed.reduce((n, c) => n + c.items.filter((i) => i.kind === 'changed').length, 0),
    hasChanges: d.added.length + d.removed.length + d.changed.length > 0,
  };
  return d;
}

/** Render the diff as Markdown (also fine on a terminal). */
function renderMarkdown(d, { currentStamp, stagedStamp }) {
  const L = [];
  const s = d.summary;
  L.push(`# AHGFamily catalog changes`, '', `Current catalog: ${currentStamp || 'unknown'} · Fresh fetch: ${stagedStamp || 'unknown'}`, '');
  if (!s.hasChanges) { L.push('**No changes.** The live catalog matches AHGFamily.', ''); return L.join('\n'); }
  L.push(`**${s.awardsAdded} award(s) added, ${s.awardsRemoved} removed, ${s.awardsChanged} changed, ${s.awardsUnchanged} unchanged.** ` +
    `Requirements: +${s.itemsAdded} / −${s.itemsRemoved} / ~${s.itemsChanged}.`, '');
  if (d.added.length) {
    L.push('## Awards added', '');
    for (const a of d.added) L.push(`- **${a.name}** (${a.levelGroup}) \`${a.awardId}\` — ${a.items ?? '?'} items${a.retired ? ' — RETIRED' : ''}`);
    L.push('');
  }
  if (d.removed.length) {
    L.push('## Awards removed', '', '> Removed awards keep their existing completions in the tracker; they just stop being plannable.', '');
    for (const a of d.removed) L.push(`- **${a.name}** (${a.levelGroup}) \`${a.awardId}\` — ${a.items ?? '?'} items`);
    L.push('');
  }
  if (d.changed.length) {
    L.push('## Awards changed', '');
    for (const c of d.changed) {
      L.push(`### ${c.name} (${c.levelGroup}) \`${c.awardId}\``, '');
      for (const f of c.award) L.push(`- ${f.field}: ${JSON.stringify(f.from)} → ${JSON.stringify(f.to)}`);
      for (const g of c.groups) L.push(g.kind === 'changed' ? `- group changed: \`${g.from}\` → \`${g.to}\`` : `- group ${g.kind}: "${g.label}" (${g.items} items)`);
      for (const it of c.items) {
        if (it.kind === 'added') L.push(`- + ${it.number}. ${it.title} \`${it.id}\` [${it.group}]`);
        else if (it.kind === 'removed') L.push(`- − ${it.number}. ${it.title} \`${it.id}\` [${it.group}]`);
        else L.push(`- ~ ${it.number}. \`${it.id}\`: ` + it.fields.map((f) => `${f.field} "${f.from}" → "${f.to}"`).join('; '));
      }
      L.push('');
    }
  }
  return L.join('\n');
}

async function confirm(question) {
  if (!process.stdin.isTTY) throw new Error('--apply needs an interactive terminal; refusing to apply from a non-interactive run.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

function stampOf(index) { return index && index.generatedAt ? index.generatedAt.replace(/\.\d+Z$/, 'Z') : null; }

async function main(argv) {
  let jsonOut = null; let mdOut = null; let apply = false; let plannableOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') jsonOut = argv[++i];
    else if (argv[i] === '--md') mdOut = argv[++i];
    else if (argv[i] === '--apply') apply = true;
    else if (argv[i] === '--plannable-only') plannableOnly = true;
  }
  const live = makePaths(); const stg = makePaths(process.env, { staging: true });
  const current = loadCatalog(live); const staged = loadCatalog(stg);
  if (!staged) { console.error(`No staging catalog at ${stg.root} — run: node scripts/fetch-ahgfamily-catalog.js --staging`); process.exit(1); }
  if (!current) { console.error(`No live catalog at ${live.root}. First-time setup: rename ${stg.root} to ${live.root} by hand (nothing to diff against).`); process.exit(1); }

  const d = diffCatalogs(current, staged, { plannableOnly });
  const md = renderMarkdown(d, { currentStamp: stampOf(current.index), stagedStamp: stampOf(staged.index) });
  console.log(md);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ generatedAt: new Date().toISOString(), ...d }, null, 2) + '\n');
  if (mdOut) fs.writeFileSync(mdOut, md + '\n');

  if (!apply) process.exit(d.summary.hasChanges ? 10 : 0);
  if (!d.summary.hasChanges) { console.log('Nothing to apply.'); process.exit(0); }
  const ok = await confirm(`\nReplace the live catalog with this fetch? Type "yes" to apply, anything else to abort: `);
  if (!ok) { console.log('Aborted — live catalog unchanged.'); process.exit(2); }
  const stamp = (stampOf(current.index) || new Date().toISOString()).replace(/[:T]/g, '-').replace(/Z$/, '');
  const backup = path.join(path.dirname(live.root), `ahgfamily-previous-${stamp}`);
  fs.renameSync(live.root, backup);
  fs.renameSync(stg.root, live.root);
  console.log(`Applied. Previous catalog kept at ${backup}`);
  process.exit(0);
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { diffCatalogs, renderMarkdown, flatten, loadCatalog };
