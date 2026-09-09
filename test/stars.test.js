'use strict';
// Service Star arithmetic — pure, integer hundredths, carry-forward chain.
const test = require('node:test');
const assert = require('node:assert/strict');
const St = require('../lib/stars');

test('rates and award ids are the program constants', () => {
  assert.deepEqual(St.RATE_HUNDREDTHS, { Tenderheart: 500, Explorer: 1000, Pioneer: 1500, Patriot: 2000 });
  assert.deepEqual(St.STAR_LEVELS, ['Tenderheart', 'Explorer', 'Pioneer', 'Patriot']);
  assert.equal(St.LEVEL_BY_AWARD_ID['awamidjeryhs'], 'Pioneer');
});

test('sumApprovedByLevel: approved rows only, Pathfinder dropped, unreadable hours counted as skipped', () => {
  const rows = [
    { level: 'Pathfinder', hundredths: 500, verified: true },   // never counts
    { level: 'Tenderheart', hundredths: 33, verified: true },
    { level: 'Tenderheart', hundredths: 33, verified: true },
    { level: 'Tenderheart', hundredths: 34, verified: true },
    { level: 'Explorer', hundredths: 200, verified: false },    // pending
    { level: 'Explorer', hundredths: null, verified: true },    // unreadable
    { level: 'Pioneer', hundredths: 1495, verified: true },
  ];
  const r = St.sumApprovedByLevel(rows);
  assert.deepEqual(r.hours, { Tenderheart: 100, Explorer: 0, Pioneer: 1495, Patriot: 0 });
  assert.equal(r.counted, 4);
  assert.equal(r.skipped, 1);
});

test('chain: carry forward through an empty level; remainders are exact', () => {
  // TH 7.50 h → 1 star, 2.50 carries; no Explorer hours → 2.50 passes through;
  // Pioneer 12.50 + 2.50 = 15.00 → exactly one star, 0 carry; Patriot 19.99 → none.
  const c = St.computeStarChain({ hoursByLevel: { Tenderheart: 750, Pioneer: 1250, Patriot: 1999 } });
  const by = Object.fromEntries(c.levels.map((l) => [l.level, l]));
  assert.deepEqual([by.Tenderheart.earnable, by.Tenderheart.carryOut], [1, 250]);
  assert.deepEqual([by.Explorer.hours, by.Explorer.carryIn, by.Explorer.earnable, by.Explorer.carryOut], [0, 250, 0, 250]);
  assert.deepEqual([by.Pioneer.available, by.Pioneer.earnable, by.Pioneer.carryOut], [1500, 1, 0]);
  assert.deepEqual([by.Patriot.earnable, by.Patriot.carryOut, by.Patriot.toNext.hundredths], [0, 1999, 1]);
  assert.equal(c.newStars, 2);
  assert.equal(c.conflicts, 0);
  assert.equal(by.Tenderheart.carryIn, 0, 'Tenderheart carry-in is always 0');
  assert.equal(by.Patriot.display.carryOut, '19.99');
});

test('chain: the 14.95 foot-gun — a 0.05 correction flips a Pioneer star, nothing is lost to floats', () => {
  const before = St.computeStarChain({ hoursByLevel: { Pioneer: 1495 } });
  assert.equal(before.levels[2].earnable, 0);
  const after = St.computeStarChain({ hoursByLevel: { Pioneer: 1500 } });
  assert.equal(after.levels[2].earnable, 1);
  // many small entries summed in hundredths land exactly on the boundary
  const rows = Array.from({ length: 60 }, () => ({ level: 'Explorer', hundredths: 17, verified: true })); // 60 × 0.17 = 10.20
  const sum = St.sumApprovedByLevel(rows).hours;
  assert.equal(sum.Explorer, 1020);
  assert.equal(St.computeStarChain({ hoursByLevel: sum }).levels[1].earnable, 1);
});

test('chain: proposals are arithmetic-anchored — the on-record count never changes carry', () => {
  const a = St.computeStarChain({ hoursByLevel: { Tenderheart: 1200 }, onRecord: {} });
  const b = St.computeStarChain({ hoursByLevel: { Tenderheart: 1200 }, onRecord: { Tenderheart: 2 } });
  assert.equal(a.levels[0].carryOut, b.levels[0].carryOut);
  assert.equal(a.levels[0].newStars, 2);
  assert.equal(b.levels[0].newStars, 0);
  assert.equal(a.levels[1].carryIn, 200);
});

test('chain without a baseline: legacy stars are absorbed, never a conflict, never a negative', () => {
  // 4 Explorer stars on record, no Explorer hours in the ledger (paper-era history)
  const c = St.computeStarChain({ hoursByLevel: { Pioneer: 3000 }, onRecord: { Explorer: 4, Pioneer: 1 } });
  const ex = c.levels[1];
  assert.deepEqual([ex.earnable, ex.legacy, ex.expected, ex.newStars, ex.conflict], [0, 4, 4, 0, null]);
  const pi = c.levels[2];
  assert.deepEqual([pi.earnable, pi.legacy, pi.newStars, pi.conflict], [2, 0, 1, null]);
  assert.equal(c.conflicts, 0);
  assert.deepEqual(St.baselineFrom(c).Explorer, { onRecord: 4, earnable: 0 });
});

test('chain with a baseline: movement after baseline is proposed or surfaced, legacy stays explained', () => {
  const baseline = { Explorer: { onRecord: 4, earnable: 0 }, Pioneer: { onRecord: 1, earnable: 1 } };
  // later: Explorer hours appear (10 h → 1 star) — expected 5 on record, still 4 → propose 1
  let c = St.computeStarChain({ hoursByLevel: { Explorer: 1000, Pioneer: 1500 }, onRecord: { Explorer: 4, Pioneer: 1 }, baseline });
  assert.deepEqual([c.levels[1].expected, c.levels[1].newStars, c.levels[1].conflict], [5, 1, null]);
  // a star added by hand beyond what hours explain → conflict, not a revert
  c = St.computeStarChain({ hoursByLevel: { Explorer: 1000, Pioneer: 1500 }, onRecord: { Explorer: 6, Pioneer: 1 }, baseline });
  assert.deepEqual(c.levels[1].conflict, { kind: 'more_on_record', onRecord: 6, expected: 5, unexplained: 1 });
  assert.equal(c.levels[1].newStars, 0);
  // an instance removed since baseline → conflict
  c = St.computeStarChain({ hoursByLevel: { Pioneer: 1500 }, onRecord: { Explorer: 3, Pioneer: 1 }, baseline });
  assert.deepEqual(c.levels[1].conflict, { kind: 'instance_removed', onRecord: 3, baselineOnRecord: 4 });
  // hours revoked so earnable drops under the record → conflict, never negative stars
  c = St.computeStarChain({ hoursByLevel: { Pioneer: 1000 }, onRecord: { Explorer: 4, Pioneer: 1 }, baseline });
  assert.deepEqual(c.levels[2].conflict, { kind: 'more_on_record', onRecord: 1, expected: 0, unexplained: 1 });
  assert.equal(c.levels[2].newStars, 0);
  assert.equal(c.conflicts, 1);
});

test('crossCheckEligibility: agreement is silent; AHGFamily counting pending hours is explained', () => {
  const c = St.computeStarChain({ hoursByLevel: { Pioneer: 8733, Patriot: 11495 } });
  // Pioneer 87.33 → 5 stars, 12.33 carry; Patriot 114.95 + 12.33 = 127.28 → 6 stars
  assert.deepEqual(c.levels.slice(2).map((l) => l.earnable), [5, 6]);
  assert.deepEqual(St.crossCheckEligibility(c, [{ level: 'Pioneer', starsEligible: 5 }, { level: 'Patriot', starsEligible: 6 }]), []);
  const notes = St.crossCheckEligibility(c, [{ level: 'Patriot', starsEligible: 7 }]);
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].level, notes[0].ours, notes[0].theirs], ['Patriot', 6, 7]);
  assert.match(notes[0].note, /pending/);
});
