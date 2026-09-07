'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/parse');
const A = require('../lib/ahgfamily');
const F = require('./fixtures');

test('index page: badge-select, youth-select (ids only), level-select, csrf', () => {
  const badges = P.parseBadgeSelect(F.indexPage);
  assert.equal(badges.length, 3);
  assert.deepEqual(badges[1], { awardId: 'aw0000test02', name: 'Nature & Wildlife', imageSlug: 'nature_and_wildlife_white', levelGroup: 'Pioneer/Patriot' });
  assert.equal(badges[0].levelGroup, 'All');
  assert.deepEqual(P.parseYouthSelect(F.indexPage), [F.YOUTH, 'u0000test002']);
  assert.deepEqual(P.parseLevelSelect(F.indexPage), [{ code: 'all', label: 'All Girls' }, { code: 'pipa', label: 'Pioneer/Patriot' }]);
  assert.equal(A.csrfFrom(F.indexPage), 'tok-fake-123');
});

test('fragment, title-first table layout: 11 items in two groups, level id, award-keyed', () => {
  const a = P.parseFragment(F.fragmentTitleFirst, { awardId: 'aw0000test02', youthId: F.YOUTH });
  assert.equal(a.itemCount, 11);
  assert.equal(a.levelId, F.LEVEL);
  assert.equal(a.wholeAwardOnly, false);
  assert.equal(a.multiInstance, false);
  assert.equal(a.wholeAwardKeyedBy, 'award');
  assert.equal(a.hasLetteredLeaves, false);
  assert.deepEqual(a.groups.map((g) => [g.label, g.items.length]), [['Complete All', 5], ['Complete Three', 6]]);
  assert.deepEqual(a.groups[0].items[1], { id: F.R[1], number: 2, title: 'Edge of a pond, lake or stream' });
  assert.deepEqual(a.groups[1].items[5], { id: F.R[10], number: 11, title: 'Local endangered species' });
  assert.deepEqual(a.parse.warnings, [], 'no warnings expected');
});

test('fragment, title-after layout with lettered leaves and handbook editions', () => {
  const a = P.parseFragment(F.fragmentLettered, { awardId: 'aw0000test09', youthId: F.YOUTH });
  assert.equal(a.itemCount, 6);
  assert.equal(a.levelId, F.LEVEL);
  assert.equal(a.hasLetteredLeaves, true);
  assert.equal(a.instructions.length, 1);
  assert.deepEqual(a.groups.map((g) => g.label), ['Complete All (Current Handbook)', 'Complete All (2016 Handbook)']);
  const g0 = a.groups[0];
  assert.equal(g0.items.length, 3);
  assert.equal(g0.items[0].title, 'Be an active, registered Troop Member.');
  assert.equal(g0.items[1].number, 2);
  assert.equal(g0.items[1].id, null, 'parent with children is not itself checkable');
  assert.deepEqual(g0.items[1].children, [{ id: 'l00000test02', letter: 'a', title: '1st Year' }, { id: 'l00000test03', letter: 'b', title: '2nd Year' }]);
  assert.equal(g0.items[2].title, 'Participate in a Board of Review.');
  assert.deepEqual(a.groups[1].items.map((i) => i.number), [1, 2]);
  // numbering restarts at 1 on the edition-group boundary → not a warning
  assert.deepEqual(a.parse.warnings, []);
});

test('fragment, whole-award-only repeatable bead: zero items, record-keyed panels', () => {
  const a = P.parseFragment(F.fragmentBead, { awardId: 'aw0000test01', youthId: F.YOUTH });
  assert.equal(a.itemCount, 0);
  assert.equal(a.wholeAwardOnly, true);
  assert.equal(a.multiInstance, true);
  assert.equal(a.instancePanels, 2);
  assert.equal(a.wholeAwardKeyedBy, 'record');
  assert.equal(a.levelId, F.LEVEL);
  assert.deepEqual(a._recordIds.sort(), [F.REC, F.REC2].sort());
});

test('scrubPersonal removes youth and record ids everywhere, keeps requirement ids', () => {
  const a = P.parseFragment(F.fragmentBead, { awardId: 'aw0000test01', youthId: F.YOUTH });
  a.source = { youth: F.YOUTH, note: `saw ${F.REC} and ${F.YOUTH}` };
  const s = P.scrubPersonal(a, { youthIds: [F.YOUTH, 'u0000test002'] });
  const text = JSON.stringify(s);
  assert.ok(!text.includes(F.YOUTH));
  assert.ok(!text.includes(F.REC));
  assert.ok(!('_recordIds' in s));
  assert.equal(s.source.note, 'saw <adHashid> and <youthHashid>');
  const b = P.scrubPersonal(P.parseFragment(F.fragmentTitleFirst, { awardId: 'aw0000test02' }), { youthIds: [F.YOUTH] });
  assert.ok(JSON.stringify(b).includes(F.R[0]), 'requirement ids survive');
  assert.ok(!P.containsYouthId(JSON.stringify(b)));
  assert.ok(!P.containsYouthId('universities and unbelievable'), 'plain words are not ids');
  assert.ok(P.containsYouthId('x u0000fake001 y'));
});

test('classify: items beat headings; chrome filtered', () => {
  assert.equal(P.classify('3. Read the handbook').type, 'numbered');
  assert.equal(P.classify('Complete Three').type, 'heading');
  assert.equal(P.classify('Pioneer & Patriot complete all').type, 'heading');
  assert.equal(P.classify('Earned on:').type, 'chrome');
  assert.equal(P.classify('09/07/2026').type, 'chrome');
  assert.equal(P.classify('a.').type, 'letter-marker');
  assert.equal(P.classify('10.').type, 'number-marker');
});

test('read-only allow-list refuses data-changing endpoints', () => {
  const cfg = A.makeConfig({ AHG_BASE: 'https://example.com' });
  assert.throws(() => A.assertAllowed(cfg, '/advancement/process-advancement', 'POST'), /Refusing/);
  assert.throws(() => A.assertAllowed(cfg, '/advancement/index?level=all', 'POST'), /Refusing/);
  assert.throws(() => A.assertAllowed(cfg, '/advancement/delete?user_id=x', 'GET'), /Refusing/);
  assert.doesNotThrow(() => A.assertAllowed(cfg, '/advancement/index?level=all&style=grid', 'GET'));
  assert.doesNotThrow(() => A.assertAllowed(cfg, '/advancement/badge-tracker-view', 'POST'));
  assert.doesNotThrow(() => A.assertAllowed(cfg, '/login', 'POST'));
});

test('cookie jar honours deletions and last-write-wins', () => {
  const jar = new A.CookieJar();
  jar.absorbLines(['a=1; Path=/', 'b=2', 'a=3']);
  assert.equal(jar.header(), 'a=3; b=2');
  jar.absorbLines(['b=; Max-Age=0']);
  assert.equal(jar.header(), 'a=3');
});
