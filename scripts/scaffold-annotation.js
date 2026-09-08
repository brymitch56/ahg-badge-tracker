#!/usr/bin/env node
'use strict';
/**
 * scaffold-annotation.js — start a handbook annotation from the catalog.
 *
 * The AHGFamily catalog already knows a badge's structure: groups, their
 * rules, every requirement number and short title, and the ids. Only the
 * printed prose has to be typed. This writes
 * data/handbook/<slug>.<level>.json pre-filled with the structure and
 * empty text fields, so annotating is "fill in the blanks" instead of
 * "get the shape right too" — and the numbering can't drift from the
 * catalog, which is the usual cause of a refused build.
 *
 * Offline; reads data/ahgfamily/ only. Never overwrites an existing
 * annotation unless --force.
 *
 * Usage:
 *   node scripts/scaffold-annotation.js "Our Flag"                 (one match)
 *   node scripts/scaffold-annotation.js "Our Flag" --level Explorer
 *   node scripts/scaffold-annotation.js awi7ow5nbzev               (by award id)
 *   node scripts/scaffold-annotation.js --list Explorer            (what's left to do)
 *   ... --force        overwrite an existing annotation file
 *   ... --stdout       print instead of writing
 *
 * Then: fill in the text, `npm run build:badges`, copy data/badges/ to the
 * Pi, import. handbook/README.md documents every field.
 */
const fs = require('fs');
const path = require('path');
const { makePaths } = require('./fetch-ahgfamily-catalog');
const { frontierForName } = require('./build-badges');

// Level group → file-name code + the handbook levels the page covers.
const LEVELS = {
  All: { code: 'all', levels: ['Pathfinder', 'Tenderheart', 'Explorer', 'Pioneer', 'Patriot'] },
  Pathfinders: { code: 'path', levels: ['Pathfinder'] },
  Tenderheart: { code: 'tend', levels: ['Tenderheart'] },
  Explorer: { code: 'expl', levels: ['Explorer'] },
  Pioneer: { code: 'pion', levels: ['Pioneer'] },
  Patriot: { code: 'patr', levels: ['Patriot'] },
  'Pioneer/Patriot': { code: 'pipa', levels: ['Pioneer', 'Patriot'] },
};

const slugify = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function loadCatalog(paths) {
  const dir = paths.awards;
  if (!fs.existsSync(dir)) throw new Error(`no catalog at ${dir} — run the fetch first`);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

/** Catalog award → annotation skeleton (structure filled, prose blank). */
function scaffold(award) {
  const lv = LEVELS[award.levelGroup] || { code: slugify(award.levelGroup), levels: [award.levelGroup] };
  const groups = (award.groups || []).filter((g) => g.plannable !== false).map((g) => ({
    label: g.label,
    rule: g.rule || null,
    requirements: g.items.flatMap((it) => (
      Array.isArray(it.children) && it.children.length
        ? it.children.map((c) => ({ number: it.number, letter: c.letter, _catalogTitle: `${it.title} — ${c.title}`, text: '', subItems: [] }))
        : [{ number: it.number, _catalogTitle: it.title, text: '', subItems: [] }]
    )),
  }));
  return {
    _README: 'Fill in every "text" (the printed wording), the intro/ahgHistory/faithConnection, handbook.pages, classic, and frontier (the handbook chapter). _catalogTitle is AHGFamily\'s short title, shown only as a hint — leave it or delete it. Then: npm run build:badges',
    awardId: award.awardId,
    name: award.name,
    levelGroup: award.levelGroup,
    slug: `${slugify(award.name)}.${lv.code}`,
    levels: lv.levels,
    classic: false,
    // pre-filled from handbook/frontiers.json (the printed Badge Index);
    // blank means the badge isn't a frontier badge (special/faith/level awards)
    frontier: frontierForName(award.name) || '',

    handbook: { edition: 'current', pages: [], images: [] },
    intro: '',
    ahgHistory: null,
    faithConnection: { text: '', reference: '' },
    groups,
  };
}

function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => args.includes(name);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const paths = makePaths(process.env);
  const catalog = loadCatalog(paths);
  // same location build-badges.js reads from (data/handbook, beside data/ahgfamily)
  const outDir = path.join(path.dirname(paths.root), 'handbook');

  const done = new Set(fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.json')) : []);

  if (flag('--list')) {
    const want = opt('--list');
    const rows = catalog
      .filter((a) => !a.retired && !a.wholeAwardOnly && (!want || a.levelGroup.toLowerCase().includes(want.toLowerCase())))
      .sort((a, b) => a.levelGroup.localeCompare(b.levelGroup) || a.name.localeCompare(b.name));
    let pending = 0;
    for (const a of rows) {
      const lv = LEVELS[a.levelGroup] || { code: slugify(a.levelGroup) };
      const file = `${slugify(a.name)}.${lv.code}.json`;
      const has = done.has(file);
      if (!has) pending += 1;
      console.log(`${has ? '[done]' : '[    ]'} ${a.levelGroup.padEnd(16)} ${a.name}`);
    }
    console.log(`\n${rows.length} badges${want ? ` matching "${want}"` : ''}; ${pending} not yet annotated.`);
    return 0;
  }

  const query = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--level');
  if (!query) {
    console.error('Usage: node scripts/scaffold-annotation.js "<badge name>" [--level <level group>] | <awardId> | --list [level]');
    return 1;
  }
  const level = opt('--level');
  let matches = catalog.filter((a) => a.awardId === query
    || (a.name.toLowerCase() === query.toLowerCase() && (!level || a.levelGroup.toLowerCase().includes(level.toLowerCase()))));
  if (!matches.length) {
    matches = catalog.filter((a) => a.name.toLowerCase().includes(query.toLowerCase())
      && (!level || a.levelGroup.toLowerCase().includes(level.toLowerCase())));
  }
  if (!matches.length) { console.error(`No badge matches "${query}"${level ? ` at ${level}` : ''}.`); return 1; }
  if (matches.length > 1) {
    console.error(`"${query}" matches ${matches.length} awards — add --level:`);
    for (const m of matches) console.error(`  ${m.levelGroup.padEnd(16)} ${m.name}  (${m.awardId})`);
    return 1;
  }
  const award = matches[0];
  if (award.retired) { console.error(`"${award.name}" is retired on AHGFamily — it can never be earned, so it is not annotated.`); return 1; }
  if (award.wholeAwardOnly) { console.error(`"${award.name}" has no requirement items on AHGFamily (whole-award only) — nothing to annotate.`); return 1; }

  const ann = scaffold(award);
  const out = JSON.stringify(ann, null, 2) + '\n';
  if (flag('--stdout')) { process.stdout.write(out); return 0; }
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${ann.slug}.json`);
  if (fs.existsSync(file) && !flag('--force')) {
    console.error(`${file} already exists — edit it, or pass --force to start over.`);
    return 1;
  }
  fs.writeFileSync(file, out);
  const count = ann.groups.reduce((n, g) => n + g.requirements.length, 0);
  console.log(`Wrote ${file}`);
  console.log(`  ${award.name} (${award.levelGroup}) — ${ann.groups.length} group(s), ${count} requirements to fill in.`);
  console.log('  Next: type the printed text into each "text" field, set handbook.pages and classic,');
  console.log('        then run: npm run build:badges');
  return 0;
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { scaffold, LEVELS, slugify };
