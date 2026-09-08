#!/usr/bin/env node
'use strict';
/**
 * build-badges.js — merge handbook annotations (data/handbook/*.json) with
 * the AHGFamily catalog (data/ahgfamily/) into data/badges/<slug>.json, the
 * shape the website and tracker read. See handbook/README.md.
 *
 * Offline. Validates hard: a badge is written only when the annotation and
 * the catalog agree on name, level group, group count, per-group counts,
 * rules, and the exact set of requirement numbers. Retired awards and
 * non-current editions are refused.
 *
 * Usage:
 *   node scripts/build-badges.js            build all
 *   node scripts/build-badges.js --check    validate only, write nothing
 *   node scripts/build-badges.js --only nature-and-wildlife.pipa
 *   --handbook-dir <dir>   annotations (default data/handbook; also tries handbook/example.json with --example)
 *
 * Exit 0 = every annotation built; 1 = at least one refused.
 */

const fs = require('fs');
const path = require('path');
const { makePaths } = require('./fetch-ahgfamily-catalog');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// The handbook's six Frontiers (chapter = frontier). Annotations may write
// them loosely ("science and technology frontier"); storage is canonical.
const FRONTIERS = ['Heritage', 'Family Living', 'Arts', 'Outdoor Skills', 'Personal Well-Being', 'Science & Technology'];
function normalizeFrontier(v) {
  if (v == null || v === '') return { value: null };
  const t = String(v).toLowerCase().replace(/\bfrontier\b/g, '').replace(/&/g, 'and').replace(/[^a-z]+/g, ' ').trim();
  const hit = FRONTIERS.find((f) => f.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]+/g, ' ').trim() === t);
  return hit ? { value: hit } : { error: `unknown frontier "${v}" — one of: ${FRONTIERS.join(' | ')}` };
}
const ruleSig = (r) => (!r ? null : r.type === 'all' ? 'all' : `n_of:${r.n}`);

/** Flatten a catalog award to number-keyed leaves (parents with children expand to "2a"). */
function catalogRequirements(award) {
  const out = [];
  for (const [gi, g] of (award.groups || []).entries()) {
    for (const it of g.items) {
      if (Array.isArray(it.children) && it.children.length) {
        for (const c of it.children) out.push({ key: `${it.number}${c.letter}`, number: it.number, letter: c.letter, id: c.id, title: `${it.title} — ${c.title}`, groupIndex: gi });
      } else {
        out.push({ key: String(it.number), number: it.number, letter: null, id: it.id, title: it.title, groupIndex: gi });
      }
    }
  }
  return out;
}

/** Pure: annotation + catalog award → { badge } or { errors[] }. */
function buildBadge(ann, award, { fetchedAt = null, annotationFile = null } = {}) {
  const errors = [];
  const e = (m) => errors.push(m);
  for (const f of ['awardId', 'name', 'levelGroup', 'slug', 'levels', 'groups']) if (ann[f] === undefined) e(`annotation missing "${f}"`);
  if (errors.length) return { errors };
  if (!award) return { errors: [`award ${ann.awardId} not in catalog`] };
  if (award.name !== ann.name) e(`name mismatch: annotation "${ann.name}", catalog "${award.name}"`);
  if (award.levelGroup !== ann.levelGroup) e(`levelGroup mismatch: annotation "${ann.levelGroup}", catalog "${award.levelGroup}"`);
  if (award.retired) e('award is retired on AHGFamily — not buildable');
  if (award.wholeAwardOnly) e('award has no requirement items on AHGFamily (whole-award only)');
  const frontier = normalizeFrontier(ann.frontier);
  if (frontier.error) e(frontier.error);
  const cgroups = (award.groups || []).filter((g) => g.plannable !== false);
  if (cgroups.length !== ann.groups.length) e(`group count: annotation ${ann.groups.length}, catalog ${cgroups.length} [${cgroups.map((g) => g.label).join(' | ')}]`);
  const creqs = catalogRequirements({ groups: cgroups });
  const byKey = new Map(creqs.map((r) => [r.key, r]));
  const seen = new Set();
  const groups = [];
  ann.groups.forEach((ag, gi) => {
    const cg = cgroups[gi];
    if (cg) {
      if (cg.rule && ag.rule && ruleSig(cg.rule) !== ruleSig(ag.rule)) e(`group ${gi + 1} rule: annotation ${ruleSig(ag.rule)}, catalog ${ruleSig(cg.rule)} ("${cg.label}")`);
      const ccount = cg.items.reduce((n, it) => n + (it.children && it.children.length ? it.children.length : 1), 0);
      if (ccount !== (ag.requirements || []).length) e(`group ${gi + 1} "${cg.label}": annotation has ${(ag.requirements || []).length} requirements, catalog ${ccount}`);
    }
    const requirements = [];
    for (const ar of ag.requirements || []) {
      const key = String(ar.number) + (ar.letter || '');
      const cr = byKey.get(key);
      if (!cr) { e(`requirement ${key}: not in catalog`); continue; }
      if (cr.groupIndex !== gi) e(`requirement ${key}: annotation group ${gi + 1}, catalog group ${cr.groupIndex + 1}`);
      if (seen.has(key)) e(`requirement ${key}: duplicated in annotation`);
      seen.add(key);
      if (!ar.text || !String(ar.text).trim()) e(`requirement ${key}: empty text`);
      requirements.push({
        number: ar.number, ...(ar.letter ? { letter: ar.letter } : {}),
        ahgFamilyId: cr.id, title: cr.title, text: ar.text,
        subItems: ar.subItems || [], flags: ar.flags || [],
      });
    }
    groups.push({ label: cg ? cg.label : ag.label, rule: (cg && cg.rule) || ag.rule || null, requirements });
  });
  for (const cr of creqs) if (!seen.has(cr.key)) e(`requirement ${cr.key} ("${cr.title}", ${cr.id}): in catalog but not annotated`);
  if (errors.length) return { errors };
  return {
    badge: {
      id: ann.slug.replace(/\./g, '-'),
      awardId: award.awardId, name: award.name, levelGroup: award.levelGroup, levels: ann.levels,
      imageSlug: award.imageSlug || null, classic: !!ann.classic, frontier: frontier.value,
      handbook: { edition: 'current', pages: [], images: [], ...(ann.handbook || {}) },
      intro: ann.intro || null, ahgHistory: ann.ahgHistory || null, faithConnection: ann.faithConnection || null,
      groups, requirementCount: creqs.length,
      source: { ahgfamilyFetchedAt: fetchedAt, annotationFile, builtAt: new Date().toISOString() },
    },
  };
}

function main(argv) {
  let check = false; let only = null; let dir = null; let example = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true;
    else if (argv[i] === '--only') only = argv[++i];
    else if (argv[i] === '--handbook-dir') dir = argv[++i];
    else if (argv[i] === '--example') example = true;
  }
  const paths = makePaths();
  const handbookDir = dir ? path.resolve(dir) : path.join(path.dirname(paths.root), 'handbook');
  const outDir = path.join(path.dirname(paths.root), 'badges');
  const files = [];
  if (fs.existsSync(handbookDir)) for (const f of fs.readdirSync(handbookDir)) if (f.endsWith('.json')) files.push(path.join(handbookDir, f));
  if (example) files.push(path.join(__dirname, '..', 'handbook', 'example.json'));
  const selected = files.filter((f) => !only || path.basename(f, '.json') === only);
  if (!selected.length) { console.error(`No annotations found in ${handbookDir}${only ? ` matching ${only}` : ''}. See handbook/README.md.`); process.exit(1); }

  let built = 0; let refused = 0;
  for (const file of selected) {
    const ann = readJson(file);
    const awardPath = path.join(paths.awards, `${ann.awardId}.json`);
    const award = fs.existsSync(awardPath) ? readJson(awardPath) : null;
    const r = buildBadge(ann, award, { fetchedAt: award && award.source ? award.source.fetchedAt || null : null, annotationFile: path.basename(file) });
    if (r.errors) {
      refused++;
      console.log(`✗ ${path.basename(file)}`);
      for (const m of r.errors) console.log(`    - ${m}`);
      continue;
    }
    built++;
    const b = r.badge;
    console.log(`✓ ${path.basename(file)} → ${b.id}.json  (${b.requirementCount} requirements in ${b.groups.length} groups, pages ${b.handbook.pages.join('–') || '?'})`);
    if (!check) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, `${b.id}.json`), JSON.stringify(b, null, 2) + '\n'); }
  }
  console.log(`\n${built} built, ${refused} refused${check ? ' (check only — nothing written)' : ` → ${outDir}`}`);
  process.exit(refused ? 1 : 0);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { FRONTIERS, normalizeFrontier, buildBadge, catalogRequirements };
