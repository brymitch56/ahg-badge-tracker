'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBadge } = require('../scripts/build-badges');
const example = require('../handbook/example.json');

const catalog = () => ({
  awardId: 'aw0000example', name: 'Example Badge', levelGroup: 'Pioneer/Patriot', retired: false, wholeAwardOnly: false, imageSlug: 'example',
  source: { fetchedAt: '2026-09-07T00:00:00Z' },
  groups: [
    { label: 'Complete All', rule: { type: 'all' }, edition: 'current', plannable: true, items: [{ id: 'r00000test01', number: 1, title: 'First' }, { id: 'r00000test02', number: 2, title: 'Second' }] },
    { label: 'Complete One', rule: { type: 'n_of', n: 1 }, edition: 'current', plannable: true, items: [{ id: 'r00000test03', number: 3, title: 'Third' }, { id: 'r00000test04', number: 4, title: 'Fourth' }] },
    { label: 'Complete All (2016 Handbook)', rule: { type: 'all' }, edition: '2016', plannable: false, items: [{ id: 'r00000test09', number: 1, title: 'Old' }] },
  ],
});

test('example annotation builds against a matching catalog; 2016 group ignored', () => {
  const r = buildBadge(example, catalog(), { annotationFile: 'example.json' });
  assert.equal(r.errors, undefined, JSON.stringify(r.errors));
  const b = r.badge;
  assert.equal(b.id, 'example-badge-pipa');
  assert.equal(b.requirementCount, 4);
  assert.deepEqual(b.groups.map((g) => [g.label, g.requirements.length]), [['Complete All', 2], ['Complete One', 2]]);
  assert.deepEqual(b.groups[0].requirements[0], { number: 1, ahgFamilyId: 'r00000test01', title: 'First', text: example.groups[0].requirements[0].text, subItems: [], flags: ['requiredForJoiningAward'] });
  assert.deepEqual(b.groups[0].requirements[1].subItems, ['Option one', 'Option two', 'Option three']);
  assert.deepEqual(b.handbook.pages, [100, 101]);
});

test('refuses on mismatch: missing requirement, wrong rule, retired, wrong name', () => {
  const c = catalog(); c.groups[0].items.push({ id: 'r00000test05', number: 5, title: 'Fifth' });
  let r = buildBadge(example, c);
  assert.ok(r.errors.some((e) => /requirement 5 .* not annotated/.test(e)), r.errors.join('|'));
  const c2 = catalog(); c2.groups[1].rule = { type: 'n_of', n: 2 };
  r = buildBadge(example, c2);
  assert.ok(r.errors.some((e) => /rule: annotation n_of:1, catalog n_of:2/.test(e)));
  const c3 = catalog(); c3.retired = true;
  assert.ok(buildBadge(example, c3).errors.some((e) => /retired/.test(e)));
  const c4 = catalog(); c4.name = 'Other';
  assert.ok(buildBadge(example, c4).errors.some((e) => /name mismatch/.test(e)));
  assert.ok(buildBadge(example, null).errors.some((e) => /not in catalog/.test(e)));
});

test('lettered leaves are matched by number+letter', () => {
  const c = catalog(); c.groups = [{ label: 'Complete All', rule: { type: 'all' }, edition: 'current', plannable: true, items: [
    { id: 'r00000test01', number: 1, title: 'Plain' },
    { id: null, number: 2, title: 'Parent', children: [{ id: 'r00000test02', letter: 'a', title: 'A' }, { id: 'r00000test03', letter: 'b', title: 'B' }] },
  ] }];
  const ann = { ...example, groups: [{ label: 'Complete All', rule: { type: 'all' }, requirements: [
    { number: 1, text: 'one' }, { number: 2, letter: 'a', text: 'two a' }, { number: 2, letter: 'b', text: 'two b' },
  ] }] };
  const r = buildBadge(ann, c);
  assert.equal(r.errors, undefined, JSON.stringify(r.errors));
  assert.deepEqual(r.badge.groups[0].requirements.map((q) => `${q.number}${q.letter || ''}:${q.ahgFamilyId}`), ['1:r00000test01', '2a:r00000test02', '2b:r00000test03']);
});
