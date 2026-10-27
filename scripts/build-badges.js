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
// handbook/frontiers.json: badge name → frontier, from the printed Badge
// Index. Used when the annotation doesn't set frontier itself.
const NAME_TO_FRONTIER = (() => {
  const map = new Map();
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'handbook', 'frontiers.json'), 'utf8'));
    for (const [frontier, names] of Object.entries(idx)) {
      if (frontier.startsWith('_')) continue;
      for (const name of names) map.set(normBadgeName(name), frontier);
    }
  } catch { /* index absent — annotations carry frontier themselves */ }
  return map;
})();
// Spaceless compare absorbs the catalog's drift from the printed index
// ("Freshwater & Marinebiology", "US Military Heroes"); a trailing version
// marker ("Canoeing V1-3", "Outdoor Cooking V4") is AHGFamily bookkeeping,
// not part of the badge's name.
function normBadgeName(s) {
  return String(s).toLowerCase()
    .replace(/\s*v\d+(\s*-\s*\d+)?\s*$/, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}
function frontierForName(name) { return NAME_TO_FRONTIER.get(normBadgeName(name)) || null; }

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
  // A few catalogs restart numbering in every group (Together as a Family),
  // so match within the annotation's own group first; the number-only map
  // is the fallback that reports a requirement placed in the wrong group.
  const byGroupKey = new Map(creqs.map((r) => [`${r.groupIndex}|${r.key}`, r]));
  const byKey = new Map(creqs.map((r) => [r.key, r]));
  const repeats = creqs.length !== byKey.size;
  const label = (gi, key) => (repeats ? `${key} (group ${gi + 1})` : key);
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
      const cr = byGroupKey.get(`${gi}|${key}`) || byKey.get(key);
      if (!cr) { e(`requirement ${label(gi, key)}: not in catalog`); continue; }
      if (cr.groupIndex !== gi) e(`requirement ${key}: annotation group ${gi + 1}, catalog group ${cr.groupIndex + 1}`);
      const seenKey = `${cr.groupIndex}|${key}`;
      if (seen.has(seenKey)) e(`requirement ${label(gi, key)}: duplicated in annotation`);
      seen.add(seenKey);
      if (!ar.text || !String(ar.text).trim()) e(`requirement ${label(gi, key)}: empty text`);
      requirements.push({
        number: ar.number, ...(ar.letter ? { letter: ar.letter } : {}),
        ahgFamilyId: cr.id, title: cr.title, text: ar.text,
        subItems: ar.subItems || [], flags: ar.flags || [],
      });
    }
    groups.push({ label: cg ? cg.label : ag.label, rule: (cg && cg.rule) || ag.rule || null, requirements });
  });
  for (const cr of creqs) if (!seen.has(`${cr.groupIndex}|${cr.key}`)) e(`requirement ${label(cr.groupIndex, cr.key)} ("${cr.title}", ${cr.id}): in catalog but not annotated`);
  if (errors.length) return { errors };
  return {
    badge: {
      id: ann.slug.replace(/\./g, '-'),
      awardId: award.awardId, name: award.name, levelGroup: award.levelGroup, levels: ann.levels,
      imageSlug: award.imageSlug || null, classic: !!ann.classic, frontier: frontier.value || frontierForName(award.name),
      handbook: { edition: 'current', pages: [], images: [], ...(ann.handbook || {}) },
      intro: ann.intro || null, ahgHistory: ann.ahgHistory || null, faithConnection: ann.faithConnection || null,
      groups, requirementCount: creqs.length, textSource: 'handbook',
      source: { ahgfamilyFetchedAt: fetchedAt, annotationFile, builtAt: new Date().toISOString() },
    },
  };
}

// ------------------------------------------------------------ faith ------
// handbook/faith.json: the Faith Award (AHGFamily's B.Y. Faith Award, one
// per level), the handbook badges tagged as faith badges, and which award
// study each badge satisfies. Absent file → no faith build.
function loadFaithConfig(file = path.join(__dirname, '..', 'handbook', 'faith.json')) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// handbook/pathfinder.json: the Pathfinder awards and stepping stones.
function loadPathfinderConfig(file = path.join(__dirname, '..', 'handbook', 'pathfinder.json')) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 'award' | 'badge' | null for a catalog award under a faith config. */
function faithTag(award, faith) {
  if (!faith || !award) return null;
  if (Object.values(faith.faithAward || {}).includes(award.awardId)) return 'award';
  const names = new Set((faith.faithBadges || []).map(normBadgeName));
  return names.has(normBadgeName(award.name)) ? 'badge' : null;
}

// AHGFamily marks a study it no longer accepts by its title.
const RETIRED_TITLE = /\(retired\b/i;

/**
 * Pure: a catalog award → a badge built from AHGFamily's short titles alone,
 * for awards the handbook doesn't print (the Faith Award) and faith badges
 * not annotated yet. `text` is the short title; `textSource: 'ahgfamily'`
 * tells the website the handbook wording is still to come. Items AHGFamily
 * titles "(Retired)" are kept (their ids stay mappable) but flagged
 * `retired`, and are never offered for planning.
 */
function buildCatalogOnly(award, { fetchedAt = null, faith = null } = {}) {
  if (!award) return { errors: ['award not in catalog'] };
  const errors = [];
  if (award.retired) errors.push('award is retired on AHGFamily — not buildable');
  if (award.wholeAwardOnly) errors.push('award has no requirement items on AHGFamily (whole-award only)');
  const cgroups = (award.groups || []).filter((g) => g.plannable !== false);
  if (!cgroups.length) errors.push('award has no current requirement groups');
  if (errors.length) return { errors };
  const { LEVELS, slugify } = require('./scaffold-annotation');
  const lv = LEVELS[award.levelGroup] || { code: slugify(award.levelGroup), levels: [award.levelGroup] };
  const creqs = catalogRequirements({ groups: cgroups });
  const groups = cgroups.map((g, gi) => ({
    label: g.label,
    rule: g.rule || null,
    requirements: creqs.filter((r) => r.groupIndex === gi).map((r) => ({
      number: r.number, ...(r.letter ? { letter: r.letter } : {}),
      ahgFamilyId: r.id, title: r.title, text: r.title, subItems: [], flags: RETIRED_TITLE.test(r.title) ? ['retired'] : [],
    })),
  }));
  return {
    badge: {
      // the id scaffold-annotation's slug builds to, so a later handbook
      // annotation replaces this badge in place
      id: `${slugify(award.name)}-${lv.code}`,
      awardId: award.awardId, name: award.name, levelGroup: award.levelGroup, levels: lv.levels,
      imageSlug: award.imageSlug || null, classic: false, frontier: frontierForName(award.name),
      handbook: { edition: 'current', pages: [], images: [] },
      intro: null, ahgHistory: null, faithConnection: null,
      groups, requirementCount: creqs.length, textSource: 'ahgfamily',
      ...(faith ? { faith } : {}),
      source: { ahgfamilyFetchedAt: fetchedAt, annotationFile: null, builtAt: new Date().toISOString() },
    },
  };
}

/** Catalog awards the faith config asks for: every Faith Award level plus each current faith badge variant. */
function faithAwardIds(indexAwards, faith) {
  if (!faith) return [];
  const ids = new Set(Object.values(faith.faithAward || {}));
  for (const a of indexAwards || []) if (!a.retired && faithTag(a, faith) === 'badge') ids.add(a.awardId);
  return [...ids];
}

function main(argv) {
  let check = false; let only = null; let dir = null; let example = false; let noFaith = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true;
    else if (argv[i] === '--only') only = argv[++i];
    else if (argv[i] === '--handbook-dir') dir = argv[++i];
    else if (argv[i] === '--example') example = true;
    else if (argv[i] === '--no-faith') noFaith = true;
  }
  const paths = makePaths();
  const handbookDir = dir ? path.resolve(dir) : path.join(path.dirname(paths.root), 'handbook');
  const outDir = path.join(path.dirname(paths.root), 'badges');
  const faith = noFaith ? null : loadFaithConfig();
  const files = [];
  if (fs.existsSync(handbookDir)) for (const f of fs.readdirSync(handbookDir)) if (f.endsWith('.json')) files.push(path.join(handbookDir, f));
  if (example) files.push(path.join(__dirname, '..', 'handbook', 'example.json'));
  const selected = files.filter((f) => !only || path.basename(f, '.json') === only);
  if (!selected.length && !faith) { console.error(`No annotations found in ${handbookDir}${only ? ` matching ${only}` : ''}. See handbook/README.md.`); process.exit(1); }

  const readAward = (id) => { const p = path.join(paths.awards, `${id}.json`); return fs.existsSync(p) ? readJson(p) : null; };
  const write = (b) => { if (!check) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, `${b.id}.json`), JSON.stringify(b, null, 2) + '\n'); } };
  let built = 0; let refused = 0;
  const annotated = new Set(); // award ids built from a handbook annotation
  for (const file of selected) {
    const ann = readJson(file);
    const award = readAward(ann.awardId);
    const r = buildBadge(ann, award, { fetchedAt: award && award.source ? award.source.fetchedAt || null : null, annotationFile: path.basename(file) });
    if (r.errors) {
      refused++;
      console.log(`✗ ${path.basename(file)}`);
      for (const m of r.errors) console.log(`    - ${m}`);
      continue;
    }
    built++;
    const b = r.badge;
    const tag = faithTag(award, faith);
    if (tag) b.faith = tag;
    annotated.add(b.awardId);
    console.log(`✓ ${path.basename(file)} → ${b.id}.json  (${b.requirementCount} requirements in ${b.groups.length} groups, pages ${b.handbook.pages.join('–') || '?'})`);
    write(b);
  }

  // Faith awards and faith badges without a buildable annotation: from
  // AHGFamily's short titles, so the Faith tab can plan and track them now.
  let fromCatalog = 0;
  if (faith && !only) {
    const index = readJson(paths.index);
    for (const id of faithAwardIds(index.awards, faith)) {
      if (annotated.has(id)) continue;
      const award = readAward(id);
      const r = buildCatalogOnly(award, { fetchedAt: award && award.source ? award.source.fetchedAt || null : null, faith: faithTag(award, faith) });
      if (r.errors) {
        refused++;
        console.log(`✗ faith ${award ? `${award.name} (${award.levelGroup})` : id}`);
        for (const m of r.errors) console.log(`    - ${m}`);
        continue;
      }
      fromCatalog++;
      console.log(`✓ faith ${r.badge.name} (${r.badge.levelGroup}) → ${r.badge.id}.json  (${r.badge.requirementCount} requirements, AHGFamily titles only)`);
      write(r.badge);
    }
  }
  // Pathfinder: the Fanny Crosby Level Award and the Joining Award, from
  // AHGFamily's short titles (handbook/pathfinder.json), so the Pathfinder
  // planner can plan and track them. An annotation, if one is ever made,
  // replaces the text under the same ids.
  const pathfinder = noFaith ? null : loadPathfinderConfig();
  if (pathfinder && !only) {
    for (const id of [pathfinder.fannyCrosby, pathfinder.joining].filter(Boolean)) {
      if (annotated.has(id)) continue;
      const award = readAward(id);
      const r = buildCatalogOnly(award, { fetchedAt: award && award.source ? award.source.fetchedAt || null : null });
      if (r.errors) {
        refused++;
        console.log(`✗ pathfinder ${award ? award.name : id}`);
        for (const m of r.errors) console.log(`    - ${m}`);
        continue;
      }
      fromCatalog++;
      console.log(`✓ pathfinder ${r.badge.name} → ${r.badge.id}.json  (${r.badge.requirementCount} requirements, AHGFamily titles only)`);
      write(r.badge);
    }
  }
  console.log(`\n${built} built, ${fromCatalog ? `${fromCatalog} from AHGFamily titles, ` : ''}${refused} refused${check ? ' (check only — nothing written)' : ` → ${outDir}`}`);
  process.exit(refused ? 1 : 0);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { FRONTIERS, normalizeFrontier, frontierForName, buildBadge, catalogRequirements, loadFaithConfig, loadPathfinderConfig, faithTag, buildCatalogOnly, faithAwardIds };
