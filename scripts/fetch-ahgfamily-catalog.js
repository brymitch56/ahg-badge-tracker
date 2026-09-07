#!/usr/bin/env node
'use strict';
/**
 * fetch-ahgfamily-catalog.js — pull the full award / requirement structure
 * from AHGFamily.org into data/ahgfamily/ (one JSON per award + index.json).
 *
 * READ-ONLY. Calls exactly: GET /login, POST /login, GET /advancement/index,
 * POST /advancement/badge-tracker-view. The client module refuses every
 * other path (lib/ahgfamily.js ALLOWED_PATHS). Never process-advancement,
 * never the index POST, never delete.
 *
 * Flow:
 *   1. login (AHG_EMAIL / AHG_PASSWORD from .env — never printed)
 *   2. GET /advancement/index?level=all&style=grid → #badge-select (every
 *      award: id, name, image slug, level group), #youth-select (ids only),
 *      #level-select (level codes), csrf token
 *   3. for every award not already in data/ahgfamily/awards/:
 *        POST badge-tracker-view style=standard, one youth, that award,
 *        lockedChecked=0 → parse structure (groups, items, titles)
 *        POST badge-tracker-view style=grid, same youth/award → level id
 *        (the Standard fragment has none) + requirement-id cross-check
 *        → scrub youth/record ids → write JSON
 *      ~300 ms between requests; first auth failure stops the run
 *   4. write index.json (awards + levels + failures) and print a summary
 *
 * Output contains NO youth ids, names, or ad… record ids — placeholders only.
 * Raw fragments (which DO contain the youth id) are written to
 * data/ahgfamily/raw/ only on parse failure or with --keep-raw; data/ is
 * gitignored.
 *
 * Flags:
 *   --only aw1,aw2     fetch only these award ids
 *   --pilot            fetch only the three pilot badges (Pioneer/Patriot)
 *   --group "Explorer" fetch only awards in this level group (optgroup label)
 *   --limit N          stop after N new fetches
 *   --force            refetch awards that already have a JSON file
 *   --keep-raw         save every raw fragment to data/ahgfamily/raw/
 *   --youth-index N    use the Nth youth id from #youth-select (default 0)
 *   --no-grid          skip the grid request (no level id; halves the requests)
 *   --staging          write to data/ahgfamily-staging/ instead of the live
 *                      catalog (for scripts/diff-catalog.js); implies --force
 *   --dry-run          log in and parse the index page only; no award fetches
 *
 * Exit codes: 0 ok · 1 config · 2 auth · 3 fetch · 4 every award failed to parse
 */

const fs = require('fs');
const path = require('path');
const A = require('../lib/ahgfamily');
const P = require('../lib/parse');

const PILOT_NAMES = ['Nature & Wildlife', 'Our Flag', 'Toys & Games'];
const PILOT_GROUP = /pioneer\s*\/\s*patriot/i;

// ------------------------------------------------------------------ args ---
function parseArgs(argv) {
  const a = { only: null, pilot: false, group: null, limit: Infinity, force: false, keepRaw: false, youthIndex: 0, dryRun: false, grid: true, staging: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--only') a.only = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--pilot') a.pilot = true;
    else if (k === '--group') a.group = v();
    else if (k === '--limit') a.limit = Number(v());
    else if (k === '--force') a.force = true;
    else if (k === '--keep-raw') a.keepRaw = true;
    else if (k === '--youth-index') a.youthIndex = Number(v());
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--no-grid') a.grid = false;
    else if (k === '--staging') { a.staging = true; a.force = true; }
    else if (k === '-h' || k === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
    else { console.error(`Unknown flag ${k}`); process.exit(1); }
  }
  return a;
}

// ----------------------------------------------------------------- paths ---
function makePaths(env = process.env, { staging = false } = {}) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const root = path.join(dataDir, staging ? 'ahgfamily-staging' : 'ahgfamily');
  return {
    root,
    awards: path.join(root, 'awards'),
    raw: path.join(root, 'raw'),
    index: path.join(root, 'index.json'),
  };
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', { mode: 0o644 });
};

// --------------------------------------------------------------- summary ---
function pad(s, n, right = false) { s = String(s); return right ? s.padStart(n) : s.padEnd(n); }

function printSummary({ catalog, fetchedNow, failures, awardsDir }) {
  const loaded = [];
  for (const meta of catalog) {
    const j = readJson(path.join(awardsDir, `${meta.awardId}.json`));
    if (j) loaded.push({ ...meta, ...j });
  }
  const zero = loaded.filter((a) => a.itemCount === 0);
  const lettered = loaded.filter((a) => a.hasLetteredLeaves);
  const multi = loaded.filter((a) => a.multiInstance);
  const noLevel = loaded.filter((a) => !a.levelId);
  const warned = loaded.filter((a) => a.parse && a.parse.warnings.length);

  console.log('\n=== AHGFamily catalog summary ===');
  console.log(`awards in #badge-select:        ${catalog.length}  (${catalog.filter((a) => a.retired).length} marked "(Retired)" — flagged retired:true, never plannable)`);
  console.log(`awards fetched this run:        ${fetchedNow}`);
  console.log(`awards with JSON on disk:       ${loaded.length}`);
  console.log(`awards with zero items:         ${zero.length}`);
  console.log(`awards with lettered leaves:    ${lettered.length}`);
  console.log(`awards with multi-instance:     ${multi.length}`);
  console.log(`awards missing a level id:      ${noLevel.length}`);
  console.log(`awards with parser warnings:    ${warned.length}`);
  console.log(`awards that failed to parse:    ${failures.length}`);

  // per level group table
  const groups = new Map();
  for (const a of loaded) {
    const g = a.levelGroup || '(none)';
    if (!groups.has(g)) groups.set(g, { awards: 0, items: 0, zero: 0, retired: 0, min: Infinity, max: 0 });
    const s = groups.get(g);
    s.awards++; s.items += a.itemCount; if (a.itemCount === 0) s.zero++; if (a.retired) s.retired++;
    s.min = Math.min(s.min, a.itemCount); s.max = Math.max(s.max, a.itemCount);
  }
  console.log('\nitems per level group:');
  console.log(`  ${pad('level group', 22)} ${pad('awards', 7, true)} ${pad('items', 7, true)} ${pad('avg', 6, true)} ${pad('min', 4, true)} ${pad('max', 4, true)} ${pad('zero', 5, true)} ${pad('retired', 8, true)}`);
  for (const [g, s] of [...groups].sort((x, y) => x[0].localeCompare(y[0]))) {
    console.log(`  ${pad(g, 22)} ${pad(s.awards, 7, true)} ${pad(s.items, 7, true)} ${pad((s.items / s.awards).toFixed(1), 6, true)} ${pad(s.min === Infinity ? 0 : s.min, 4, true)} ${pad(s.max, 4, true)} ${pad(s.zero, 5, true)} ${pad(s.retired, 8, true)}`);
  }

  if (warned.length) {
    console.log('\nparser warnings (award id · level group · name · first warning):');
    for (const a of warned.slice(0, 40)) {
      console.log(`  ${a.awardId}  ${pad(a.levelGroup || '', 16)} ${pad(a.name, 36)} ${a.parse.warnings[0]}`);
    }
    if (warned.length > 40) console.log(`  … ${warned.length - 40} more (see parse.warnings in each JSON)`);
  }
  if (failures.length) {
    console.log('\nFAILED TO PARSE (raw fragment saved under data/ahgfamily/raw/):');
    for (const f of failures) console.log(`  ${f.awardId}  ${pad(f.levelGroup || '', 16)} ${pad(f.name, 36)} ${f.error}`);
  }
  console.log('');
}

// ------------------------------------------------------------------- run ---
async function run(argv) {
  const args = parseArgs(argv);
  const cfg = A.makeConfig();
  const paths = makePaths(process.env, { staging: args.staging });
  if (args.staging) { fs.rmSync(paths.root, { recursive: true, force: true }); console.log(`[catalog] staging run → ${paths.root} (live catalog untouched)`); }
  fs.mkdirSync(paths.awards, { recursive: true });

  const jar = new A.CookieJar();
  console.log('[catalog] logging in…');
  let { token } = await A.login(cfg, jar);
  console.log('[catalog] signed in');
  await A.sleep(cfg.throttleMs);

  console.log('[catalog] loading /advancement/index?level=all&style=grid');
  const indexHtml = await A.getPage(cfg, jar, '/advancement/index?level=all&style=grid');
  token = A.csrfFrom(indexHtml) || token;

  const catalog = P.parseBadgeSelect(indexHtml);
  const youthIds = P.parseYouthSelect(indexHtml);
  const levelCodes = P.parseLevelSelect(indexHtml);
  const pageLevelIds = P.findLevelIds(indexHtml);
  if (!catalog.length) throw new A.FetchError(A.EXIT.FETCH, '#badge-select parsed to zero awards — page layout changed?');
  if (!youthIds.length) throw new A.FetchError(A.EXIT.FETCH, '#youth-select has no youth ids — is the account in a role that sees the roster?');
  if (args.youthIndex < 0 || args.youthIndex >= youthIds.length) throw new A.FetchError(A.EXIT.CONFIG, `--youth-index out of range (0..${youthIds.length - 1})`);
  const youthId = youthIds[args.youthIndex];

  const groupCounts = {};
  for (const a of catalog) groupCounts[a.levelGroup || '(none)'] = (groupCounts[a.levelGroup || '(none)'] || 0) + 1;
  console.log(`[catalog] ${catalog.length} awards in ${Object.keys(groupCounts).length} level groups: ` +
    Object.entries(groupCounts).map(([g, n]) => `${g}=${n}`).join(', '));
  console.log(`[catalog] ${youthIds.length} youth in roster (using one id, never written to output)`);
  console.log(`[catalog] level codes: ${levelCodes.map((l) => `${l.code}=${l.label}`).join(', ') || '(no #level-select found)'}`);
  if (args.dryRun || !levelCodes.length) {
    const selectIds = [...indexHtml.matchAll(/<select\b[^>]*\bid=["']([^"']+)["']/gi)].map((m) => m[1]);
    console.log(`[catalog] <select> ids on the index page: ${selectIds.join(', ') || '(none)'}`);
  }

  // selection
  let todo = catalog;
  if (args.only) todo = todo.filter((a) => args.only.includes(a.awardId));
  if (args.group) todo = todo.filter((a) => (a.levelGroup || '').toLowerCase() === args.group.toLowerCase());
  if (args.pilot) todo = todo.filter((a) => PILOT_GROUP.test(a.levelGroup || '') && PILOT_NAMES.some((n) => n.toLowerCase() === a.name.toLowerCase()));
  const skipped = args.force ? [] : todo.filter((a) => fs.existsSync(path.join(paths.awards, `${a.awardId}.json`)));
  todo = todo.filter((a) => !skipped.includes(a));
  if (args.limit < todo.length) todo = todo.slice(0, args.limit);
  console.log(`[catalog] ${todo.length} to fetch, ${skipped.length} already on disk (resume)` + (args.dryRun ? ' — dry run, stopping' : ''));

  const prevIndex = readJson(paths.index) || {};
  const failures = [];
  let fetchedNow = 0;

  if (!args.dryRun) {
    for (let i = 0; i < todo.length; i++) {
      const meta = todo[i];
      await A.sleep(cfg.throttleMs);
      process.stdout.write(`[catalog] ${pad(i + 1, 4, true)}/${todo.length} ${meta.awardId} ${pad(meta.levelGroup || '', 16)} ${meta.name}`);
      let html;
      try {
        html = await A.badgeTrackerView(cfg, jar, token, { level: 'all', style: 'standard', youthIds: [youthId], awardId: meta.awardId, lockedChecked: 0 });
      } catch (e) {
        console.log('');
        if (e instanceof A.FetchError && e.code === A.EXIT.AUTH) throw e; // stop the run
        failures.push({ awardId: meta.awardId, name: meta.name, levelGroup: meta.levelGroup, error: `fetch: ${e.message}` });
        console.log(`[catalog]   fetch failed: ${e.message}`);
        continue;
      }
      if (args.keepRaw) { fs.mkdirSync(paths.raw, { recursive: true }); fs.writeFileSync(path.join(paths.raw, `${meta.awardId}.html`), html, { mode: 0o600 }); }

      let award;
      try {
        const parsed = P.parseFragment(html, { awardId: meta.awardId, youthId });
        if (!parsed.levelId && parsed.itemCount === 0 && !parsed.wholeAwardKeyedBy) {
          throw new Error('fragment has no checkboxes, no level id and no whole-award fields — probably not a tracker fragment');
        }
        award = P.scrubPersonal({
          awardId: meta.awardId,
          name: meta.name,
          imageSlug: meta.imageSlug,
          levelGroup: meta.levelGroup,
          retired: meta.retired,
          ...parsed,
          source: { endpoint: 'badge-tracker-view', style: 'standard', level: 'all', youth: '<youthHashid>', fetchedAt: new Date().toISOString() },
        }, { youthIds });
      } catch (e) {
        fs.mkdirSync(paths.raw, { recursive: true });
        fs.writeFileSync(path.join(paths.raw, `${meta.awardId}.html`), html, { mode: 0o600 });
        failures.push({ awardId: meta.awardId, name: meta.name, levelGroup: meta.levelGroup, error: `parse: ${e.message}` });
        console.log(`  ✗ parse failed: ${e.message}`);
        continue;
      }
      if (args.grid) {
        await A.sleep(cfg.throttleMs);
        let gridHtml;
        try {
          gridHtml = await A.badgeTrackerView(cfg, jar, token, { level: 'all', style: 'grid', youthIds: [youthId], awardId: meta.awardId, lockedChecked: 0 });
        } catch (e) {
          if (e instanceof A.FetchError && e.code === A.EXIT.AUTH) { console.log(''); throw e; }
          award.parse.warnings.push(`grid fetch failed: ${e.message}`);
        }
        if (gridHtml) {
          if (args.keepRaw) fs.writeFileSync(path.join(paths.raw, `${meta.awardId}.grid.html`), gridHtml, { mode: 0o600 });
          const g = P.parseGridFragment(gridHtml, { awardId: meta.awardId });
          award.levelId = g.levelId;
          award.source.levelIdFrom = g.levelId ? 'grid' : null;
          // the grid renders no cells for whole-award / multi-instance awards — nothing to read there
          if (!g.levelId && !award.wholeAwardOnly) award.parse.warnings.push(`grid: no level id (${g.cells} advance-icon cells)`);
          if (g.levelIds.length > 1) award.parse.warnings.push(`grid: multiple level ids ${g.levelIds.join(',')} — used first`);
          const std = new Set(award.groups.flatMap((grp) => grp.items.flatMap((it) => (it.children ? it.children.map((c) => c.id) : [it.id]))).filter(Boolean));
          const onlyGrid = g.requirementIds.filter((id) => !std.has(id));
          const onlyStd = [...std].filter((id) => !g.requirementIds.includes(id));
          // Ids the grid tracks but the Standard view never renders: on level
          // awards these are the prior-edition (2016 handbook) items. Kept for
          // reference, never plannable. Ids missing from the grid are a real problem.
          award.gridOnlyRequirementIds = onlyGrid;
          if (onlyStd.length) award.parse.warnings.push(`requirement ids in Standard view but not in grid: [${onlyStd.join(',')}]`);
          award = P.scrubPersonal({ ...award, _recordIds: [] }, { youthIds: [...youthIds, ...g.youthIds] });
        }
      }
      writeJson(path.join(paths.awards, `${meta.awardId}.json`), award);
      fetchedNow++;
      const flags = [award.wholeAwardOnly ? 'whole-award' : `${award.itemCount} items`, award.hasLetteredLeaves ? 'lettered' : null, award.multiInstance ? `multi×${award.instancePanels}` : null, award.parse.warnings.length ? `${award.parse.warnings.length} warn` : null].filter(Boolean);
      console.log(`  ✓ ${flags.join(', ')}`);
    }
  }

  // index.json — catalog metadata + levels + which awards have files. Merge
  // failures: an award that failed before but succeeded now drops out.
  const onDisk = new Set(fs.readdirSync(paths.awards).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')));
  const oldFailures = (prevIndex.failures || []).filter((f) => !onDisk.has(f.awardId) && !failures.some((x) => x.awardId === f.awardId));
  const allFailures = [...oldFailures, ...failures];
  const levelIdsByGroup = {};
  let backfilled = 0;
  for (const id of onDisk) {
    const p = path.join(paths.awards, `${id}.json`);
    const j = readJson(p);
    if (j && typeof j.retired !== 'boolean') { // files written before the flag existed
      const rebuilt = { awardId: j.awardId, name: j.name, imageSlug: j.imageSlug, levelGroup: j.levelGroup, retired: P.isRetired(j.name) };
      for (const [k, v] of Object.entries(j)) if (!(k in rebuilt)) rebuilt[k] = v;
      writeJson(p, rebuilt); backfilled++;
    }
    if (j && j.levelId) { levelIdsByGroup[j.levelGroup] = levelIdsByGroup[j.levelGroup] || new Set(); levelIdsByGroup[j.levelGroup].add(j.levelId); }
  }
  if (backfilled) console.log(`[catalog] backfilled the retired flag on ${backfilled} existing award file(s)`);
  writeJson(paths.index, {
    generatedAt: new Date().toISOString(),
    source: { site: cfg.base, page: '/advancement/index?level=all&style=grid' },
    levels: {
      codes: levelCodes,
      idsOnIndexPage: pageLevelIds,
      idsByLevelGroup: Object.fromEntries(Object.entries(levelIdsByGroup).map(([g, s]) => [g, [...s]])),
    },
    awards: catalog.map((a) => ({ ...a, fetched: onDisk.has(a.awardId) })),
    failures: allFailures,
  });

  printSummary({ catalog, fetchedNow, failures: allFailures, awardsDir: paths.awards });
  return { fetchedNow, failures: allFailures, todo: todo.length };
}

if (require.main === module) {
  run(process.argv.slice(2)).then((r) => {
    if (r.todo > 0 && r.fetchedNow === 0 && r.failures.length) process.exit(A.EXIT.PARSE);
    process.exit(0);
  }).catch((e) => {
    const code = e instanceof A.FetchError ? e.code : A.EXIT.FETCH;
    console.error('\n[catalog] ' + (e instanceof A.FetchError ? e.message : (e.stack || String(e))));
    process.exit(code);
  });
}

module.exports = { run, parseArgs, makePaths, PILOT_NAMES };
