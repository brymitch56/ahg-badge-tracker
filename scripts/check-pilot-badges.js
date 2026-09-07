#!/usr/bin/env node
'use strict';
/**
 * check-pilot-badges.js — compare the three pilot badges in
 * data/ahgfamily/awards/ against the handbook numbering and print a diff.
 * Offline: reads only the JSON the fetch script wrote. No network.
 *
 * Expected (Pioneer/Patriot handbook):
 *   Nature & Wildlife  11 items = 5 "complete all" + 6 "complete three"
 *   Our Flag           11 items = 6 "complete all" + 5 "complete three"
 *   Toys & Games       10 items = 5 "complete all" + 5 "complete three"
 *
 * Exit 0 when all three match, 1 when any differs or is missing.
 */

const fs = require('fs');
const path = require('path');
const { makePaths } = require('./fetch-ahgfamily-catalog');

const EXPECTED = [
  { name: 'Nature & Wildlife', levelGroup: /pioneer\s*\/\s*patriot/i, total: 11, groups: [{ rule: /all/i, count: 5 }, { rule: /three/i, count: 6 }] },
  { name: 'Our Flag', levelGroup: /pioneer\s*\/\s*patriot/i, total: 11, groups: [{ rule: /all/i, count: 6 }, { rule: /three/i, count: 5 }] },
  { name: 'Toys & Games', levelGroup: /pioneer\s*\/\s*patriot/i, total: 10, groups: [{ rule: /all/i, count: 5 }, { rule: /three/i, count: 5 }] },
];

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// Flatten an award's groups into ordered rows (parents contribute their
// leaves; a parent with children is not itself a checkable item).
function rows(award) {
  const out = [];
  for (const g of award.groups || []) {
    for (const it of g.items) {
      if (Array.isArray(it.children) && it.children.length) {
        for (const c of it.children) out.push({ group: g.label, number: `${it.number ?? '?'}${c.letter}`, title: `${it.title} — ${c.title}`, id: c.id });
      } else {
        out.push({ group: g.label, number: it.number ?? '?', title: it.title, id: it.id });
      }
    }
  }
  return out;
}

function checkOne(exp, index, awardsDir) {
  const problems = [];
  const matches = (index.awards || []).filter((a) => a.name.toLowerCase() === exp.name.toLowerCase() && exp.levelGroup.test(a.levelGroup || ''));
  if (!matches.length) return { problems: [`not in index.json under a Pioneer/Patriot group (run the fetch first, or the name differs on AHGFamily)`], award: null };
  if (matches.length > 1) problems.push(`${matches.length} awards named "${exp.name}" in that group: ${matches.map((m) => m.awardId).join(', ')} — checking the first`);
  const meta = matches[0];
  const award = readJson(path.join(awardsDir, `${meta.awardId}.json`));
  if (!award) return { problems: [`${meta.awardId} listed but no JSON on disk — fetch it: --only ${meta.awardId}`], award: null };

  const r = rows(award);
  if (award.itemCount !== exp.total) problems.push(`item count: expected ${exp.total}, AHGFamily has ${award.itemCount} checkable items`);
  if (r.length !== award.itemCount) problems.push(`parsed rows (${r.length}) != checkbox count (${award.itemCount}) — parser dropped or invented items`);

  const groups = award.groups || [];
  if (groups.length !== exp.groups.length) {
    problems.push(`group count: expected ${exp.groups.length} (${exp.groups.map((g) => g.count).join(' + ')}), got ${groups.length} [${groups.map((g) => `${g.label ?? '(unlabeled)'}=${g.items.length}`).join(', ')}]`);
  } else {
    exp.groups.forEach((eg, i) => {
      const g = groups[i];
      const label = g.label ?? '(unlabeled)';
      if (!g.label || !eg.rule.test(g.label)) problems.push(`group ${i + 1} label "${label}" does not look like "complete ${eg.rule.source}"`);
      if (g.items.length !== eg.count) problems.push(`group ${i + 1} "${label}": expected ${eg.count} items, got ${g.items.length}`);
    });
  }

  // numbering 1..N continuous across groups
  const nums = r.map((x) => x.number);
  const expectedNums = Array.from({ length: exp.total }, (_, i) => i + 1);
  if (JSON.stringify(nums) !== JSON.stringify(expectedNums)) problems.push(`numbering: expected ${expectedNums.join(',')}; got ${nums.join(',')}`);
  for (const x of r) {
    if (!x.title) problems.push(`item ${x.number} (${x.id}): no title`);
    if (!/^[a-z0-9]{12}$/.test(x.id || '')) problems.push(`item ${x.number}: bad requirement id "${x.id}"`);
  }
  if (award.wholeAwardOnly) problems.push('flagged whole-award-only — expected per-requirement tracking');
  if (award.multiInstance) problems.push(`flagged multi-instance (${award.instancePanels} panels) — unexpected for a badge`);
  if (award.hasLetteredLeaves) problems.push('has lettered sub-items — unexpected for this badge');
  if (!award.levelId) problems.push('no level id captured');
  for (const w of (award.parse && award.parse.warnings) || []) problems.push(`parser warning: ${w}`);
  return { problems, award, rows: r, meta };
}

function main() {
  const paths = makePaths();
  const index = readJson(paths.index);
  if (!index) { console.error(`No ${paths.index} — run scripts/fetch-ahgfamily-catalog.js first.`); process.exit(1); }
  let bad = 0;
  for (const exp of EXPECTED) {
    const { problems, award, rows: r, meta } = checkOne(exp, index, paths.awards);
    const ok = problems.length === 0;
    if (!ok) bad++;
    console.log(`\n${ok ? '✓' : '✗'} ${exp.name} (Pioneer/Patriot) — expected ${exp.total} items = ${exp.groups.map((g) => g.count).join(' + ')}` + (meta ? `  [${meta.awardId}${award && award.levelId ? ', level ' + award.levelId : ''}]` : ''));
    for (const p of problems) console.log(`    - ${p}`);
    if (award) {
      console.log('    AHGFamily items:');
      let lastGroup = Symbol('none');
      for (const x of r) {
        if (x.group !== lastGroup) { console.log(`      [${x.group ?? '(unlabeled group)'}]`); lastGroup = x.group; }
        console.log(`      ${String(x.number).padStart(3)}  ${x.id}  ${x.title ?? '(no title)'}`);
      }
    }
  }
  console.log(`\n${EXPECTED.length - bad}/${EXPECTED.length} pilot badges match the handbook structure.\n`);
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main();
module.exports = { EXPECTED, rows, checkOne };
