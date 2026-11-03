'use strict';
// The Awards tab: level awards, derived "ready" items, Stars & Stripes.
// Offline; every id and name is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, migrate } = require('../server/db');
const catalog = require('../server/lib/catalog');
const faith = require('../server/lib/faith');
const awards = require('../server/lib/awards');
const { BOOKS } = require('../scripts/extract-handbook-pages');
const { buildCatalogOnly } = require('../scripts/build-badges');

const CFG = {
  levelAwards: { Tenderheart: 'aw00level0th', Explorer: 'aw00level0ex', Pioneer: 'aw00level0pi', Patriot: 'aw00level0pa' },
  joining: 'aw00joining0',
  catholic: { Pioneer: ['aw00segment1', 'aw00medal000'] },
  derive: {
    Pioneer: { frontier: 4, faith: 5, service: 6, serviceHours: 15, catholicSegments: 1 },
    Patriot: { frontier: 5, faith: 6, service: 7, serviceHours: 20, catholicSegments: 2 },
  },
  starsAndStripes: {
    prerequisite: 'Patriot',
    requiredBadges: [{ frontier: 'Heritage', badges: ['Our Flag'] }],
    fitnessBadge: 'Physical Fitness',
    steps: [{ key: 'candidacy', label: 'Candidacy granted' }, { key: 'fitness', label: 'Fitness' }, { key: 'choice', label: 'Choice' }],
  },
};
const FAITH = { faithAward: { Pioneer: 'aw00faith0pi' }, faithBadges: [], links: {} };

const simple = (awardId, name, levelGroup, prefix, titles, extra = {}) => ({
  awardId, name, levelGroup, retired: false, wholeAwardOnly: false, ...extra,
  groups: [{ label: 'Complete All', rule: { type: 'all' }, edition: 'current', plannable: true,
    items: titles.map((title, i) => ({ id: `${prefix}${String(i + 1).padStart(10, '0')}`, number: i + 1, title })) }],
});
const pioneerLevel = {
  awardId: CFG.levelAwards.Pioneer, name: 'Pioneer Level Award', levelGroup: 'Pioneer', retired: false, wholeAwardOnly: false,
  groups: [{ label: 'Complete All', rule: { type: 'all' }, edition: 'current', plannable: true, items: [
    { id: 'pl0000000001', number: 1, title: 'Active member' },
    { id: 'pl0000000002', number: 2, title: 'Flag ceremony' },
    { id: 'pl0000000003', number: 3, title: 'Leadership' },
    { id: 'pl0000000004', number: 4, title: 'Badges', children: [
      { id: 'pl000000004a', letter: 'a', title: 'Heritage' }, { id: 'pl000000004b', letter: 'b', title: 'Arts' }] },
    { id: 'pl0000000005', number: 5, title: 'Faith' },
    { id: 'pl0000000006', number: 6, title: 'Service', children: [
      { id: 'pl000000006a', letter: 'a', title: '1st Year' }, { id: 'pl000000006b', letter: 'b', title: '2nd Year' }] },
  ] }],
};

let db; let dir; let girl; let other;
const girlRow = (id) => db.prepare('SELECT * FROM girls WHERE id = ?').get(id);
const finish = (g, badgeId, on) => {
  for (const r of db.prepare('SELECT id FROM requirements WHERE badge_id = ?').all(badgeId)) {
    db.prepare(`INSERT INTO completions (girl_id, requirement_id, status, completed_on, source, level_at_completion, proposed_at)
      VALUES (?, ?, 'confirmed', ?, 'manual', ?, ?)`).run(g, r.id, on, girlRow(g).ahg_level, on);
  }
};
const status = () => awards.awardsStatus(db).girls.find((g) => g.girlId === girl);
const pioneer = () => db.prepare('SELECT id FROM badges WHERE ahg_award_id = ?').get(CFG.levelAwards.Pioneer).id;

test.before(() => {
  awards.setAwardsConfig(CFG);
  faith.setFaithConfig(FAITH);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awards-badges-'));
  const list = [
    pioneerLevel,
    simple(CFG.levelAwards.Patriot, 'Patriot Level Award', 'Patriot', 'pa', ['Everything']),
    simple(CFG.joining, 'AHG Joining Award', 'All', 'jo', ['Oath', 'Creed']),
    simple('aw00segment1', 'Catholic Segment 1 (Pioneer)', 'Pioneer', 'sg', ['Chapter 1']),
    simple('aw00medal000', 'Catholic Medal (Pioneer)', 'Pioneer', 'md', ['Year 1']),
    simple(FAITH.faithAward.Pioneer, 'B.Y. Faith Award (Pioneer)', 'Pioneer', 'fa', ['Some Study']),
    simple('aw00ourflag0', 'Our Flag', 'Pioneer/Patriot', 'fl', ['Etiquette']),
    simple('aw00fitness0', 'Physical Fitness', 'Pioneer/Patriot', 'ft', ['Run']),
    simple('aw00crafts00', 'Crafts', 'Pioneer/Patriot', 'cr', ['Make one']),
  ];
  const frontier = { 'Our Flag': 'Heritage', 'Physical Fitness': 'Personal Well-Being', Crafts: 'Arts' };
  for (const a of list) {
    const r = buildCatalogOnly(a);
    assert.equal(r.errors, undefined, JSON.stringify(r.errors));
    if (frontier[a.name]) r.badge.frontier = frontier[a.name];
    fs.writeFileSync(path.join(dir, `${r.badge.id}.json`), JSON.stringify(r.badge));
  }
  db = openDb(':memory:');
  migrate(db);
  catalog.importFromDir(db, dir, { actor: 'admin@example.com' });
  const add = (first, level, cid) => Number(db.prepare(`INSERT INTO girls (checkin_person_id, first_name, last_name, ahg_level, updated_at)
    VALUES (?, ?, 'Example', ?, '2026-01-01')`).run(cid, first, level).lastInsertRowid);
  girl = add('Testa', 'Pioneer', 901);
  other = add('Sample', 'Tenderheart', 902);
});
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('catalog names each level and reports awards not imported', () => {
  const c = awards.awardsCatalog(db);
  assert.equal(c.levels.find((l) => l.level === 'Pioneer').levelAward.name, 'Pioneer Level Award');
  assert.equal(c.levels.find((l) => l.level === 'Pioneer').catholic.length, 2);
  assert.ok(c.missing.includes(CFG.levelAwards.Tenderheart));
  assert.equal(c.joining.requirements.length, 2);
});

test('girls see awards only up to their level', () => {
  const s = awards.awardsStatus(db).girls;
  const younger = s.find((g) => g.girlId === other);
  assert.equal(younger.starsAndStripes, null);
  assert.ok(Object.keys(younger.awards).every((id) => !id.startsWith('pioneer-level')));
  assert.ok(status().awards[pioneer()]);
});

test('a finished frontier badge makes only that frontier ready', () => {
  finish(girl, 'our-flag-pipa', '2026-03-01');
  const a = status().awards[pioneer()];
  assert.equal(a.items[`${pioneer()}:4a`].status, 'ready');
  assert.match(a.items[`${pioneer()}:4a`].why, /Our Flag/);
  assert.equal(a.items[`${pioneer()}:4a`].completedOn, '2026-03-01');
  assert.equal(a.items[`${pioneer()}:4b`], undefined);
  assert.equal(a.done, 0, 'ready is never written behind a leader');
});

test('service hours: one qualifying year readies the 1st year, not the 2nd; unverified hours do not count', () => {
  const add = (rec, date, h, verified) => db.prepare(`INSERT INTO service_hours (girl_id, ahg_record_id, date, level, hundredths, verified, fetched_at)
    VALUES (?, ?, ?, 'Pioneer', ?, ?, '2026-01-01')`).run(girl, rec, date, h, verified);
  add('r1', '2025-10-01', 1000, 1);
  add('r2', '2026-02-01', 500, 1);
  add('r3', '2026-10-01', 2000, 0);
  const a = status().awards[pioneer()];
  assert.equal(a.items[`${pioneer()}:6a`].status, 'ready');
  assert.match(a.items[`${pioneer()}:6a`].why, /15 service hours in 2025–26/);
  assert.equal(a.items[`${pioneer()}:6b`], undefined);
  assert.deepEqual(status().awards[pioneer()].serviceYears, [{ year: 2025, hours: 15 }]);
});

test('Faith programming: a finished Catholic segment or the earned Faith Award readies it', () => {
  assert.equal(status().awards[pioneer()].items[`${pioneer()}:5`], undefined);
  finish(girl, 'catholic-segment-1-pioneer-pion', '2026-04-01');
  assert.match(status().awards[pioneer()].items[`${pioneer()}:5`].why, /1 Catholic Faith Award segment finished/);
});

test('recording a ready item turns it confirmed through the normal completion', () => {
  const { manualCompletion } = require('../server/lib/proposals');
  manualCompletion(db, { girlId: girl, requirementId: `${pioneer()}:4a`, completedOn: '2026-03-01' }, 'leader@example.com');
  const a = status().awards[pioneer()];
  assert.equal(a.items[`${pioneer()}:4a`].status, 'confirmed');
  assert.equal(a.done, 1);
  assert.equal(a.complete, false);
});

test('Stars & Stripes: badges derive, steps are marks, unknown steps are refused', () => {
  let s = status().starsAndStripes;
  assert.deepEqual(s.required, [{ frontier: 'Heritage', name: 'Our Flag', done: true }]);
  assert.equal(s.prerequisite.done, false);
  assert.equal(s.steps.find((x) => x.key === 'fitness').done, false);
  finish(girl, 'physical-fitness-pipa', '2026-05-01');
  finish(girl, 'crafts-pipa', '2026-05-02');
  s = status().starsAndStripes;
  assert.match(s.steps.find((x) => x.key === 'fitness').auto, /Physical Fitness/);
  assert.match(s.steps.find((x) => x.key === 'choice').auto, /Crafts/, 'a required or fitness badge never counts as her choice');
  awards.markStep(db, { girlId: girl, step: 'candidacy', doneOn: '2026-06-01', notes: 'note' }, 'leader@example.com');
  s = status().starsAndStripes;
  assert.equal(s.steps[0].done, true);
  assert.equal(s.done, 4);
  awards.unmarkStep(db, { girlId: girl, step: 'candidacy' });
  assert.equal(status().starsAndStripes.steps[0].done, false);
  assert.throws(() => awards.markStep(db, { girlId: girl, step: 'nope', doneOn: '2026-06-01' }, 'x'), /unknown/);
  assert.throws(() => awards.markStep(db, { girlId: girl, step: 'candidacy', doneOn: 'soon' }, 'x'), /doneOn/);
});

test('a completed AHGFamily record earns an award with its boxes blank', () => {
  const j = db.prepare('SELECT id FROM badges WHERE ahg_award_id = ?').get(CFG.joining).id;
  assert.equal(status().awards[j].complete, false);
  const rec = db.prepare(`INSERT INTO award_instances (girl_id, ahg_award_id, ad_record_id, completed_on, first_seen_at, fetched_at)
    VALUES (?, ?, 'adtest000001', '2015-05-20', '2026-01-01', '2026-01-01')`).run(girl, CFG.joining);
  const a = status().awards[j];
  assert.equal(a.complete, true);
  assert.equal(a.earnedOn, '2015-05-20');
  assert.equal(a.done, 0, 'the boxes stay as they are');
  db.prepare("UPDATE award_instances SET missing_since = '2026-02-01' WHERE id = ?").run(rec.lastInsertRowid);
  assert.equal(status().awards[j].complete, false, 'a record that vanished stops counting');
  db.prepare('UPDATE award_instances SET missing_since = NULL WHERE id = ?').run(rec.lastInsertRowid);
});

test('a badge earned as a whole counts toward a level award, and an earned level award offers nothing to record', () => {
  const g = Number(db.prepare(`INSERT INTO girls (checkin_person_id, first_name, last_name, ahg_level, updated_at) VALUES (903, 'Whole', 'Example', 'Pioneer', '2026-01-01')`).run().lastInsertRowid);
  const rec = (award, on, ad) => db.prepare(`INSERT INTO award_instances (girl_id, ahg_award_id, ad_record_id, completed_on, first_seen_at, fetched_at) VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01')`).run(g, award, ad, on);
  rec('aw00ourflag0', '2025-01-02', 'adtest000002');
  const one = () => awards.awardsStatus(db).girls.find((x) => x.girlId === g);
  const it = one().awards[pioneer()].items[`${pioneer()}:4a`];
  assert.equal(it.status, 'ready');
  assert.equal(it.completedOn, '2025-01-02');
  assert.equal(one().starsAndStripes.required[0].done, true);
  rec(CFG.levelAwards.Pioneer, '2025-06-01', 'adtest000003');
  const a = one().awards[pioneer()];
  assert.equal(a.complete, true);
  assert.equal(a.ready, 0);
});

test('levels: a one-level badge counts at its level; a multi-level one at her ledger level that day', () => {
  const { levelForCompletion, levelOnDate } = require('../server/lib/awardrecords');
  const add = (rec, date, level) => db.prepare(`INSERT INTO service_hours (girl_id, ahg_record_id, date, level, hundredths, verified, fetched_at) VALUES (?, ?, ?, ?, 100, 1, '2026-01-01')`).run(other, rec, date, level);
  add('l1', '2022-10-01', 'Explorer');
  add('l2', '2024-10-01', 'Pioneer');
  add('l3', '2026-10-01', 'Patriot');
  const g = { id: other, ahg_level: 'Patriot' };
  assert.equal(levelForCompletion(db, g, 'Tenderheart', '2019-01-01'), 'Tenderheart');
  assert.equal(levelOnDate(db, other, '2025-05-01'), 'Pioneer');
  assert.equal(levelForCompletion(db, g, 'Pioneer/Patriot', '2025-05-01'), 'Pioneer');
  assert.equal(levelForCompletion(db, g, 'Pioneer/Patriot', '2026-11-01'), 'Patriot');
  assert.equal(levelForCompletion(db, g, 'Pioneer/Patriot', '2023-01-01'), 'Pioneer', 'never below Pioneer');
  assert.equal(levelForCompletion(db, g, 'All', '2021-01-01'), 'Explorer', 'before any stamp: her earliest');
  assert.equal(levelForCompletion(db, { id: girl + 500, ahg_level: 'Explorer' }, 'All', '2021-01-01'), 'Explorer', 'no ledger: her current level');
});

test('the weekly pull reads every award on the tab', () => {
  const ids = awards.pulledAwardIds();
  for (const id of [...Object.values(CFG.levelAwards), CFG.joining, 'aw00segment1', 'aw00medal000']) assert.ok(ids.includes(id), id);
});

test('page mapping: the TH/EX scan is unchanged and the P&P scan is PDF n = printed n', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 321, 322].map((n) => BOOKS.thex(n, 322)), ['cover', 'inside-cover', 'p001', 'p003', 'p004', 'p320', 'back-cover']);
  assert.deepEqual([1, 88, 336].map((n) => BOOKS.pipa(n, 336)), ['p001', 'p088', 'p336']);
});
