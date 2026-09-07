#!/usr/bin/env node
'use strict';
/**
 * reparse-raw.js — rebuild data/ahgfamily/awards/<id>.json from the raw
 * fragments saved by `fetch-ahgfamily-catalog.js --keep-raw`, with NO
 * network access. Use it to iterate on lib/parse.js against real markup.
 *
 * Reads:  data/ahgfamily/raw/<awardId>.html (+ optional <awardId>.grid.html)
 *         data/ahgfamily/index.json (award name / level group / retired)
 * Writes: data/ahgfamily/awards/<awardId>.json (same shape as the fetch)
 *
 * Flags: --only aw1,aw2   limit to these ids
 *        --dry-run        parse and report, write nothing
 *
 * Raw fragments contain the youth id; the same scrub as the fetch runs here.
 * The youth ids to scrub are taken from every data-yt in the grid fragments
 * plus any u… token found in the standard fragment's hidden inputs.
 */

const fs = require('fs');
const path = require('path');
const P = require('../lib/parse');
const { makePaths } = require('./fetch-ahgfamily-catalog');

function main(argv) {
  let only = null; let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--dry-run') dryRun = true;
  }
  const paths = makePaths();
  const index = JSON.parse(fs.readFileSync(paths.index, 'utf8'));
  const meta = new Map(index.awards.map((a) => [a.awardId, a]));
  const files = fs.existsSync(paths.raw) ? fs.readdirSync(paths.raw).filter((f) => /^aw[a-z0-9]{10}\.html$/.test(f)) : [];
  let ok = 0; let warned = 0;
  for (const f of files) {
    const awardId = f.replace(/\.html$/, '');
    if (only && !only.includes(awardId)) continue;
    const m = meta.get(awardId) || { awardId, name: '(not in index.json)', levelGroup: null, retired: false };
    const html = fs.readFileSync(path.join(paths.raw, f), 'utf8');
    const gridPath = path.join(paths.raw, `${awardId}.grid.html`);
    const gridHtml = fs.existsSync(gridPath) ? fs.readFileSync(gridPath, 'utf8') : null;

    const parsed = P.parseFragment(html, { awardId });
    let award = {
      awardId, name: m.name, imageSlug: m.imageSlug, levelGroup: m.levelGroup, retired: m.retired,
      ...parsed,
      source: { endpoint: 'badge-tracker-view', style: 'standard', level: 'all', youth: '<youthHashid>', reparsedAt: new Date().toISOString(), levelIdFrom: null },
    };
    const youthIds = new Set([...html.matchAll(/\bu[a-z0-9]{11}\b/g)].map((x) => x[0]).filter((t) => /\d/.test(t)));
    if (gridHtml) {
      const g = P.parseGridFragment(gridHtml, { awardId });
      for (const y of g.youthIds) youthIds.add(y);
      award.levelId = g.levelId; award.source.levelIdFrom = g.levelId ? 'grid' : null;
      if (!g.levelId && !award.wholeAwardOnly) award.parse.warnings.push(`grid: no level id (${g.cells} advance-icon cells)`);
      const std = new Set(award.groups.flatMap((grp) => grp.items.flatMap((it) => (it.children ? it.children.map((c) => c.id) : [it.id]))).filter(Boolean));
      const onlyGrid = g.requirementIds.filter((id) => !std.has(id));
      const onlyStd = [...std].filter((id) => !g.requirementIds.includes(id));
      award.gridOnlyRequirementIds = onlyGrid; // prior-edition items the Standard view hides; never plannable
      if (onlyStd.length) award.parse.warnings.push(`requirement ids in Standard view but not in grid: [${onlyStd.join(',')}]`);
    }
    award = P.scrubPersonal(award, { youthIds: [...youthIds] });
    const flags = [award.wholeAwardOnly ? 'whole-award' : `${award.itemCount} items`, `${award.groups.length} groups`, award.hasLetteredLeaves ? 'lettered' : null, award.multiInstance ? `multi×${award.instancePanels}` : null, award.instructions.length ? `${award.instructions.length} instr` : null].filter(Boolean);
    console.log(`${awardId}  ${(m.levelGroup || '').padEnd(16)} ${m.name.padEnd(36).slice(0, 36)}  ${flags.join(', ')}`);
    for (const g of award.groups) console.log(`    [${g.label ?? '(none)'}] ${g.items.length} items  rule=${g.rule ? (g.rule.type === 'all' ? 'all' : `${g.rule.n} of`) : '?'}${g.edition !== 'current' ? `  edition=${g.edition} NOT plannable` : ''}`);
    for (const w of award.parse.warnings) console.log(`    ! ${w}`);
    if (award.parse.warnings.length) warned++;
    if (!dryRun) {
      fs.mkdirSync(paths.awards, { recursive: true });
      fs.writeFileSync(path.join(paths.awards, `${awardId}.json`), JSON.stringify(award, null, 2) + '\n');
    }
    ok++;
  }
  console.log(`\n${ok} award(s) re-parsed, ${warned} with warnings${dryRun ? ' (dry run — nothing written)' : ''}`);
}

if (require.main === module) main(process.argv.slice(2));
