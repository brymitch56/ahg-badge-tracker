'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { diffCatalogs, renderMarkdown } = require('../scripts/diff-catalog');

const award = (id, name, groups, extra = {}) => ({
  meta: { awardId: id, name, levelGroup: 'Pioneer/Patriot', retired: false, ...extra },
  data: { awardId: id, name, itemCount: groups.reduce((n, g) => n + g.items.length, 0), wholeAwardOnly: false, multiInstance: false, hasLetteredLeaves: false, groups },
});
const g = (label, rule, items, edition = 'current') => ({ label, rule, edition, plannable: edition === 'current', items });
const it = (id, number, title) => ({ id, number, title });
const cat = (...awards) => ({ index: { generatedAt: '2026-09-07T00:00:00Z', awards: awards.map((a) => a.meta) }, awards: new Map(awards.map((a) => [a.meta.awardId, a])) });

test('identical catalogs → no changes', () => {
  const a = award('aw0000test01', 'Our Flag', [g('Complete All', { type: 'all' }, [it('r00000test01', 1, 'Flag etiquette')])]);
  const d = diffCatalogs(cat(a), cat(a));
  assert.equal(d.summary.hasChanges, false);
  assert.match(renderMarkdown(d, {}), /No changes/);
});

test('added / removed / renamed awards, retired flag, item changes', () => {
  const cur = cat(
    award('aw0000test01', 'Our Flag', [g('Complete All', { type: 'all' }, [it('r00000test01', 1, 'Flag etiquette'), it('r00000test02', 2, 'History')]), g('Complete Three', { type: 'n_of', n: 3 }, [it('r00000test03', 3, 'Teach')])]),
    award('aw0000test02', 'Old Badge', [g('Complete All', { type: 'all' }, [it('r00000test09', 1, 'x')])]),
  );
  const nxt = cat(
    award('aw0000test01', 'Our Flag', [g('Complete All', { type: 'all' }, [it('r00000test01', 1, 'Flag etiquette (updated)'), it('r00000test04', 2, 'New item')]), g('Complete Two', { type: 'n_of', n: 2 }, [it('r00000test03', 3, 'Teach')])], { retired: true }),
    award('aw0000test03', 'Brand New', [g('Complete All', { type: 'all' }, [it('r00000test10', 1, 'y')])]),
  );
  const d = diffCatalogs(cur, nxt);
  assert.equal(d.summary.hasChanges, true);
  assert.deepEqual(d.added.map((a) => a.awardId), ['aw0000test03']);
  assert.deepEqual(d.removed.map((a) => a.awardId), ['aw0000test02']);
  assert.equal(d.changed.length, 1);
  const c = d.changed[0];
  assert.deepEqual(c.award, [{ field: 'retired', from: false, to: true }]);
  assert.equal(c.groups.length, 1);
  assert.equal(c.groups[0].kind, 'changed');
  assert.deepEqual(c.items.map((i) => `${i.kind}:${i.id}`).sort(), ['added:r00000test04', 'changed:r00000test01', 'changed:r00000test03', 'removed:r00000test02']);
  assert.deepEqual(c.items.find((i) => i.kind === 'changed').fields, [{ field: 'title', from: 'Flag etiquette', to: 'Flag etiquette (updated)' }]);
  const md = renderMarkdown(d, { currentStamp: 'a', stagedStamp: 'b' });
  assert.match(md, /## Awards added/); assert.match(md, /## Awards removed/); assert.match(md, /### Our Flag/); assert.match(md, /retired: false → true/);
});

test('--plannable-only ignores 2016-edition groups and retired awards', () => {
  const cur = cat(award('aw0000test01', 'Level Award', [g('Complete All (Current Handbook)', { type: 'all' }, [it('r00000test01', 1, 'a')]), g('Complete All (2016 Handbook)', { type: 'all' }, [it('r00000test05', 1, 'old')], '2016')]),
    award('aw0000test02', 'Gone (Retired)', [g('Complete All', { type: 'all' }, [it('r00000test07', 1, 'z')])], { retired: true }));
  const nxt = cat(award('aw0000test01', 'Level Award', [g('Complete All (Current Handbook)', { type: 'all' }, [it('r00000test01', 1, 'a')]), g('Complete All (2016 Handbook)', { type: 'all' }, [it('r00000test06', 1, 'old renamed')], '2016')]),
    award('aw0000test02', 'Gone (Retired)', [g('Complete All', { type: 'all' }, [it('r00000test08', 1, 'zz')])], { retired: true }));
  assert.equal(diffCatalogs(cur, nxt).summary.hasChanges, true);
  assert.equal(diffCatalogs(cur, nxt, { plannableOnly: true }).summary.hasChanges, false);
});
