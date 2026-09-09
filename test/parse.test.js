'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/parse');
const A = require('../lib/ahgfamily');
const F = require('./fixtures');

test('index page: badge-select, youth-select (ids only), level-select, csrf', () => {
  const badges = P.parseBadgeSelect(F.indexPage);
  assert.equal(badges.length, 4);
  assert.deepEqual(badges[1], { awardId: 'aw0000test02', name: 'Nature & Wildlife', imageSlug: 'nature_and_wildlife_white', levelGroup: 'Pioneer/Patriot', retired: false });
  assert.equal(badges[3].retired, true, '"(Retired)" awards are flagged');
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

test('live markup: h4 groups of any wording, aw-prefixed ids, instruction h4, rule/edition', () => {
  const a = P.parseFragment(F.fragmentLive, { awardId: 'aw0000test07', youthId: F.YOUTH });
  assert.equal(a.itemCount, 7, 'the aw… requirement id is not mistaken for an award id');
  assert.equal(a.wholeAwardKeyedBy, 'award');
  assert.deepEqual(a.instructions, ['Pioneers and Patriots may complete EITHER the Rifle section or the Shotgun section of this badge.']);
  assert.deepEqual(a.groups.map((g) => [g.label, g.items.length, g.rule, g.edition, g.plannable]), [
    ['Complete All (Current Handbook)', 2, { type: 'all' }, 'current', true],
    ['Women Of The Old Testament: Complete One', 2, { type: 'n_of', n: 1 }, 'current', true],
    ['Rifles', 1, null, 'current', true],
    ['Complete All (2016 Handbook)', 1, { type: 'all' }, '2016', false],
  ]);
  assert.deepEqual(a.groups[0].items[0], { id: 'awh000test01', number: 1, title: 'Explore the history of the sport.' });
  const rifles = a.groups[2].items[0];
  assert.equal(rifles.title, 'Complete All');
  assert.equal(rifles.id, null);
  assert.deepEqual(rifles.children.map((c) => c.letter + ':' + c.title), ['a:Basic gun safety', 'b:Types of rifles']);
  assert.deepEqual(a.parse.warnings, []);
  const s = P.scrubPersonal(a, { youthIds: [F.YOUTH] });
  assert.ok(!JSON.stringify(s).includes('Placeholder, Girl'), 'girl name never reaches output');
});

test('grid fragment: level id, requirement ids, youth ids for scrubbing', () => {
  const g = P.parseGridFragment(F.fragmentGrid);
  assert.equal(g.levelId, F.LEVEL);
  assert.deepEqual(g.requirementIds, [F.R[0], F.R[1]]);
  assert.deepEqual(g.youthIds, [F.YOUTH]);
  assert.equal(g.cells, 3);
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
  assert.equal(P.classify('History and Rules', { heading: true }).type, 'heading');
  assert.equal(P.classify('History and Rules').type, 'other');
  assert.deepEqual(P.groupMeta('Together We Play (Choose One)'), { rule: { type: 'n_of', n: 1 }, edition: 'current', plannable: true });
  assert.deepEqual(P.groupMeta('Application: Complete Three').rule, { type: 'n_of', n: 3 });
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

// ---- Service Stars read side: instance panels and AHGFamily dates ---------
// Markup shape from the capture notes: every panel carries five fields; a
// BLANK slot also carries new-<id>="true"; a saved instance has no new-.
const panel = (adId, { isNew = false, completedOn = '', awardedOn = '', purchased = '', comment = '' } = {}) => `
  <div class="award-instance">
    ${isNew ? `<input type="hidden" name="new-${adId}" value="true">` : ''}
    <input type="text" name="completed_on-${adId}" value="${completedOn}">
    <input type="text" name="awarded_on-${adId}" value="${awardedOn}">
    <input type="text" name="purchased-${adId}" value="${purchased}">
    <input type="text" name="comment-${adId}" value="${comment}">
  </div>`;

test('parseStandardState: 5 saved + 5 blank panels count as 5 instances (isNew discriminator)', () => {
  const saved = ['adtest00s001', 'adtest00s002', 'adtest00s003', 'adtest00s004', 'adtest00s005'];
  const blanks = ['adtest00b001', 'adtest00b002', 'adtest00b003', 'adtest00b004', 'adtest00b005'];
  const html = `<form>
    ${panel(saved[0], { completedOn: '05/10/2024', awardedOn: '06/01/2024', purchased: '1' })}
    ${panel(saved[1], { completedOn: '05/10/2024', comment: 'Court of Awards' })}
    ${panel(saved[2], { completedOn: '05/10/2024' })}
    ${panel(saved[3], { completedOn: '11/02/2025', awardedOn: '12/31/1969' })}
    ${panel(saved[4], { completedOn: '' })}
    ${blanks.map((id) => panel(id, { isNew: true })).join('')}
  </form>`;
  const st = P.parseStandardState(html, { awardId: 'awtest0star1' });
  assert.equal(st.records.length, 10, 'every panel is reported');
  assert.equal(st.instanceCount, 5, 'only saved panels are instances');
  assert.deepEqual(st.records.filter((r) => !r.isNew).map((r) => r.adId), saved);
  assert.deepEqual(st.records.filter((r) => r.isNew).map((r) => r.adId), blanks);
  // same-date instances stay distinct (keyed by record id, never by date)
  assert.equal(st.records.filter((r) => r.completedOn === '05/10/2024').length, 3);
  assert.deepEqual(st.records[0], { adId: saved[0], isNew: false, completedOn: '05/10/2024', awardedOn: '06/01/2024', purchased: true, comment: null });
  assert.equal(st.records[1].comment, 'Court of Awards');
  assert.equal(st.records[3].awardedOn, null, 'epoch-0 reads as null');
  assert.equal(st.records[4].isNew, false, 'an undated saved instance is still an instance');
  // record comments never leak into the requirement map
  assert.deepEqual(Object.keys(st.items), []);
});

test('parseStandardState: record-panel comments stay off the requirement map; requirement ids that start with "ad" still work', () => {
  const html = `<form>
    <input type="checkbox" name="checkbox-adreq00test1" checked>
    <input type="text" name="date-adreq00test1" value="9/2/2026">
    <textarea name="comment-adreq00test1">a requirement whose id happens to start with ad</textarea>
    ${panel('adtest00s009', { completedOn: '9/3/2026', comment: 'whole-award note' })}
  </form>`;
  const st = P.parseStandardState(html, { awardId: 'awtest0badge' });
  assert.deepEqual(st.items, { adreq00test1: { checked: true, date: '9/2/2026', comment: 'a requirement whose id happens to start with ad' } });
  assert.deepEqual(st.records, [{ adId: 'adtest00s009', isNew: false, completedOn: '9/3/2026', awardedOn: null, purchased: false, comment: 'whole-award note' }]);
  assert.equal(st.instanceCount, 1);
});

test('parseAhgDate: M/D/YYYY, MM/DD/YY, ISO; epoch-0 spellings read as null', () => {
  assert.equal(P.parseAhgDate('9/1/2026'), '2026-09-01');
  assert.equal(P.parseAhgDate('07/12/26'), '2026-07-12');
  assert.equal(P.parseAhgDate('2026-09-01'), '2026-09-01');
  assert.equal(P.parseAhgDate(' 12/31/1969 '), null);
  assert.equal(P.parseAhgDate('01/01/1970'), null);
  assert.equal(P.parseAhgDate('12/31/69'), null);
  assert.equal(P.parseAhgDate('1/1/70'), null);
  assert.equal(P.parseAhgDate(''), null);
  assert.equal(P.parseAhgDate(null), null);
  assert.equal(P.parseAhgDate('not a date'), null);
  assert.equal(P.parseAhgDate('13/40/2026'), null);
  assert.equal(P.isEpochZeroDate('12/31/1969'), true);
  assert.equal(P.isEpochZeroDate('12/30/1969'), false);
});
