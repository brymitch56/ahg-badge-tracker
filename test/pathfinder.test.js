'use strict';
// Service Stars: stars awarded on Pathfinder hours before the troop stopped
// counting them (ruling Sept 2026), and a leader's fresh start for other
// extra stars. Pathfinder: the awarded stars stand and the Pathfinder hours
// they needed stay counted as a fixed credit. Fresh start: the stars on
// record stand and only hours from the program year on count, nothing
// carried in. Invented names and ids only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { makeConfig } = require('../server/config');
const { openDb, migrate } = require('../server/db');
const { createApp } = require('../server/app');
const servicepull = require('../server/lib/servicepull');
const St = require('../lib/stars');

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000002';
const GROUP = '00000000-0000-0000-0000-000000000003';
const KEY = Buffer.from('ef'.repeat(32), 'hex');

const TH = (hours, pf, baseline, onRecord) => St.computeStarChain({
  hoursByLevel: { Tenderheart: hours }, onRecord: { Tenderheart: onRecord },
  baseline: baseline ? { Tenderheart: baseline } : null, pathfinderHundredths: pf,
}).levels[0];

// ------------------------------------------------------------------ math --
test('Pathfinder stars stand; a 3rd star covered by Pathfinder hours is not stacked on top of counted hours', () => {
  // 14 h counted at baseline, 3 on record, 9.5 h Pathfinder → 1 star needed 1 h of it
  const base = { onRecord: 3, earnable: 2, hours: 1400 };
  let l = TH(1550, 950, base, 3); // after a 1.5 h meeting
  assert.deepEqual(
    { earnable: l.earnable, legacy: l.legacy, expected: l.expected, newStars: l.newStars, covered: l.coveredStars, credit: l.pathfinderCredit, carryOut: l.carryOut, conflict: l.conflict },
    { earnable: 3, legacy: 0, expected: 3, newStars: 0, covered: 1, credit: 100, carryOut: 150, conflict: null },
    'the whole 1.5 h meeting counts toward the next star',
  );
  assert.equal(TH(1850, 950, base, 3).newStars, 0, '18.5 counted hours: still 3');
  l = TH(1900, 950, base, 3);
  assert.deepEqual({ expected: l.expected, newStars: l.newStars, carryOut: l.carryOut, credit: l.pathfinderCredit }, { expected: 4, newStars: 1, carryOut: 0, credit: 100 },
    'the 4th star at 19 counted hours — the 1 h of Pathfinder credit stays counted');
  // the same girl WITHOUT Pathfinder hours keeps the old legacy behaviour (paper-era star on top)
  assert.equal(TH(1550, 0, base, 3).expected, 4);
});

test('the Pathfinder credit is fixed at what the awarded stars needed — never more, and it never shrinks', () => {
  const base = { onRecord: 3, earnable: 2, hours: 1100 }; // 11 h counted, 7.5 h Pathfinder → 4 h needed
  let l = TH(1100, 750, base, 3);
  assert.deepEqual({ credit: l.pathfinderCredit, available: l.available, earnable: l.earnable, carryOut: l.carryOut }, { credit: 400, available: 1500, earnable: 3, carryOut: 0 });
  l = TH(1250, 750, base, 3); // +1.5 h
  assert.deepEqual({ credit: l.pathfinderCredit, available: l.available, carryOut: l.carryOut, expected: l.expected }, { credit: 400, available: 1650, carryOut: 150, expected: 3 });
  l = TH(1600, 750, base, 3);
  assert.deepEqual({ credit: l.pathfinderCredit, expected: l.expected, newStars: l.newStars }, { credit: 400, expected: 4, newStars: 1 }, 'the 4th star at 16 counted hours');
  // Pathfinder hours beyond what the stars needed never count
  assert.equal(TH(1100, 5000, base, 3).pathfinderCredit, 400);
});

test('Pathfinder hours that explain only some extra stars cover those; the rest stay legacy', () => {
  const base = { onRecord: 4, earnable: 2, hours: 1350 }; // 2.5 h Pathfinder explains 1 of 2 extras
  const l = TH(1350, 250, base, 4);
  assert.deepEqual({ explained: l.pathfinderExplained, covered: l.coveredStars, unexplained: l.unexplainedExtras, legacy: l.legacy, credit: l.pathfinderCredit, expected: l.expected, conflict: l.conflict },
    { explained: 1, covered: 1, unexplained: 1, legacy: 1, credit: 150, expected: 4, conflict: null });
});

test('counted hours dropping below the baseline still surface as a conflict', () => {
  const l = TH(800, 750, { onRecord: 3, earnable: 2, hours: 1100 }, 3);
  assert.equal(l.pathfinderCredit, 400, 'the credit stays what the stars needed');
  assert.equal(l.expected, 2);
  assert.deepEqual(l.conflict, { kind: 'more_on_record', onRecord: 3, expected: 2, unexplained: 1 });
});

test('a fresh start: the stars on record stand, only hours since the program year began count, nothing carries in', () => {
  // 42.25 h Tenderheart → 8 stars, 2.25 carry; 1 Explorer star on record at 8.75 h;
  // 1.5 of her 8 Explorer hours were logged this program year
  const levels = (legacyMode, freshHours, { onRecordEx = 1, explorerHours = 800 } = {}) => St.computeStarChain({
    hoursByLevel: { Tenderheart: 4225, Explorer: explorerHours },
    onRecord: { Tenderheart: 8, Explorer: onRecordEx },
    baseline: {
      Tenderheart: { onRecord: 8, earnable: 8, hours: 4225 },
      Explorer: { onRecord: 1, earnable: 0, hours: 875, legacyMode, freshFrom: '2026-09-01', freshHours },
    },
  }).levels;
  assert.equal(levels('separate', 150)[1].expected, 2, 'default: the extra star is added on top of 10.25 h');

  let [, ex, pi] = levels('fresh', 150);
  assert.deepEqual(
    { carryIn: ex.carryIn, available: ex.available, earnable: ex.earnable, expected: ex.expected, newStars: ex.newStars, carryOut: ex.carryOut, freshFrom: ex.freshFrom, freshHours: ex.freshHours, toNext: ex.toNext.hundredths, conflict: ex.conflict },
    { carryIn: 0, available: 150, earnable: 0, expected: 1, newStars: 0, carryOut: 150, freshFrom: '2026-09-01', freshHours: 150, toNext: 850, conflict: null },
  );
  assert.equal(pi.carryIn, 150, 'hours earned this year still carry on up');
  [, ex] = levels('fresh', 950);
  assert.equal(ex.newStars, 0, '9.5 h this year: still 1');
  [, ex] = levels('fresh', 1000);
  assert.deepEqual({ expected: ex.expected, newStars: ex.newStars, carryOut: ex.carryOut }, { expected: 2, newStars: 1, carryOut: 0 }, 'her 2nd star at 10 hours this year');
  [, ex] = levels('fresh', 150, { onRecordEx: 0 });
  assert.equal(ex.conflict.kind, 'instance_removed', 'a star removed on AHGFamily is still surfaced');
  [, ex] = levels('fresh', 150, { onRecordEx: 3 });
  assert.deepEqual(ex.conflict, { kind: 'more_on_record', onRecord: 3, expected: 1, unexplained: 2 });
});

test('girls with no extra stars are untouched by Pathfinder hours', () => {
  const l = TH(1200, 900, { onRecord: 2, earnable: 2, hours: 1000 }, 2);
  assert.deepEqual({ credit: l.credit, covered: l.coveredStars, expected: l.expected, carryOut: l.carryOut, freshHours: l.freshHours }, { credit: 0, covered: 0, expected: 2, carryOut: 200, freshHours: null });
});

test('programYearStart: Sept 1 of the program year containing the day', () => {
  assert.equal(servicepull.programYearStart('2026-09-01'), '2026-09-01');
  assert.equal(servicepull.programYearStart('2026-12-31'), '2026-09-01');
  assert.equal(servicepull.programYearStart('2027-08-31'), '2026-09-01');
});

// ------------------------------------------------- reconcile + admin API --
let keys; let db; let server; let base; let adminT; let leaderT;
async function token(claims = {}) {
  return new SignJWT({ scp: 'access_as_leader', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(CLIENT)
    .setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
}
const call = async (method, p, t, body) => {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const ts = () => new Date().toISOString();
const todayUtc = () => new Date().toISOString().slice(0, 10);
const PY_START = servicepull.programYearStart(todayUtc()); // the test server runs in UTC
let rec = 0;
const addGirl = (first, level, youthId) => Number(db.prepare(
  "INSERT INTO girls (first_name, last_name, ahg_level, ahg_youth_id, ahg_youth_id_source, active, updated_at) VALUES (?, 'Example', ?, ?, 'manual', 1, ?)",
).run(first, level, youthId, ts()).lastInsertRowid);
const addHours = (girlId, level, hundredths, date = '2025-01-01') => db.prepare(
  'INSERT INTO service_hours (girl_id, ahg_record_id, date, level, hundredths, verified, description, fetched_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
).run(girlId, `svctest${String(++rec).padStart(5, '0')}`, date, level, hundredths, 'Service Hour Meeting', ts());
const addStars = (girlId, level, n) => {
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO award_instances (girl_id, ahg_award_id, ad_record_id, completed_on, first_seen_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(girlId, St.STAR_AWARD_IDS[level], `adtest${String(++rec).padStart(6, '0')}`, '2025-01-01', ts(), ts());
  }
};
const addBaseline = (girlId, level, onRecord, earnable, hours) => db.prepare(
  "INSERT INTO star_baseline (girl_id, level, on_record, earnable, hours_hundredths, captured_at, captured_by) VALUES (?, ?, ?, ?, ?, ?, 'system')",
).run(girlId, level, onRecord, earnable, hours, ts());
const addProposal = (girlId, level, ordinal) => Number(db.prepare(
  "INSERT INTO star_proposals (girl_id, level, ordinal, hours_hundredths, carry_in, status, proposed_at) VALUES (?, ?, ?, 0, 0, 'proposed', ?)",
).run(girlId, level, ordinal, ts()).lastInsertRowid);
const proposal = (id) => db.prepare('SELECT status, notes FROM star_proposals WHERE id = ?').get(id);
const girlRow = (id) => db.prepare('SELECT * FROM girls WHERE id = ?').get(id);

let pia; let lo; let lu; let piaProposal; let luProposal;

test.before(async () => {
  keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] });
  const cfg = makeConfig({ MSAL_TENANT_ID: TENANT, MSAL_CLIENT_ID: CLIENT, LEADER_GROUP_ID: GROUP, ADMIN_EMAILS: 'admin@example.com', DB_PATH: ':memory:', CRED_KEY: KEY.toString('hex'), TZ: 'UTC' });
  db = openDb(':memory:');
  migrate(db);
  const app = createApp({ cfg, db, jwks });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  leaderT = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });

  // Pia: 3 stars, 14 h counted at baseline, 9.5 h Pathfinder, then a 1.5 h meeting; a false #4 pending
  pia = addGirl('Pia', 'Tenderheart', 'upftest00001');
  for (const h of [500, 500, 400, 150]) addHours(pia, 'Tenderheart', h);
  addHours(pia, 'Pathfinder', 950);
  addStars(pia, 'Tenderheart', 3);
  addBaseline(pia, 'Tenderheart', 3, 2, 1400);
  piaProposal = addProposal(pia, 'Tenderheart', 4);

  // Lo: 3 stars, 11 h counted at baseline, 12.5 h now, 7.5 h Pathfinder — the credit is visible
  lo = addGirl('Lo', 'Tenderheart', 'upftest00002');
  addHours(lo, 'Tenderheart', 1250);
  addHours(lo, 'Pathfinder', 750);
  addStars(lo, 'Tenderheart', 3);
  addBaseline(lo, 'Tenderheart', 3, 2, 1100);

  // Lu: an Explorer star awarded before this program year; 6.5 h before it,
  // 1.5 h logged this year, 2.25 h carried from Tenderheart; a #2 pending
  lu = addGirl('Lu', 'Explorer', 'upftest00003');
  addHours(lu, 'Tenderheart', 4225);
  addHours(lu, 'Explorer', 650);
  addHours(lu, 'Explorer', 150, todayUtc());
  addStars(lu, 'Tenderheart', 8);
  addStars(lu, 'Explorer', 1);
  addBaseline(lu, 'Tenderheart', 8, 8, 4225);
  addBaseline(lu, 'Explorer', 1, 0, 875);
  luProposal = addProposal(lu, 'Explorer', 2);
});
test.after(() => { server.close(); db.close(); });

test('reconcile withdraws a star proposal that only Pathfinder hours ever supported, and proposes the real one later', () => {
  let r = servicepull.reconcileGirl(db, girlRow(pia), { fetchedLevels: ['Tenderheart'] });
  assert.equal(r.withdrawn, 1);
  assert.equal(r.proposed, 0);
  assert.deepEqual(proposal(piaProposal), { status: 'withdrawn', notes: 'withdrawn: approved hours no longer support this star' });
  assert.equal(r.conflicts, 0);

  addHours(pia, 'Tenderheart', 300); // 18.5 h counted + 1 h credit
  r = servicepull.reconcileGirl(db, girlRow(pia), { fetchedLevels: ['Tenderheart'] });
  assert.equal(r.proposed, 0);
  addHours(pia, 'Tenderheart', 50); // 19 h counted + 1 h credit = 20
  r = servicepull.reconcileGirl(db, girlRow(pia), { fetchedLevels: ['Tenderheart'] });
  assert.equal(r.proposed, 1, 'a withdrawn proposal never blocks the real star');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM star_proposals WHERE girl_id = ? AND ordinal = 4 AND status = 'proposed'").get(pia).n, 1);
});

test('stars view shows the Pathfinder credit and covered stars; other extra stars offer the leader\'s choice', async () => {
  const v = (await call('GET', '/api/v1/stars', leaderT)).json;
  const th = (id) => v.girls.find((g) => g.id === id).levels.find((l) => l.level === 'Tenderheart');
  assert.deepEqual({ credit: th(lo).pathfinderCredit, covered: th(lo).coveredStars, unexplained: th(lo).unexplainedExtras, earnable: th(lo).earnable, carryOut: th(lo).carryOut, newStars: th(lo).newStars },
    { credit: 4, covered: 1, unexplained: 0, earnable: 3, carryOut: 1.5, newStars: 0 });
  const ex = v.girls.find((g) => g.id === lu).levels.find((l) => l.level === 'Explorer');
  assert.deepEqual({ unexplained: ex.unexplainedExtras, mode: ex.legacyMode, expected: ex.expected, freshFrom: ex.freshFrom, freshHours: ex.freshHours },
    { unexplained: 1, mode: 'separate', expected: 2, freshFrom: null, freshHours: null });
});

test('admin sets a fresh start from the program year: the false proposal is withdrawn at once, audited; bad input refused', async () => {
  const body = { girlId: lu, level: 'Explorer', mode: 'fresh' };
  assert.equal((await call('POST', '/api/v1/admin/stars/legacy-mode', leaderT, body)).status, 403);
  assert.equal((await call('POST', '/api/v1/admin/stars/legacy-mode', adminT, { ...body, mode: 'hours' })).status, 400, 'the retired choice is refused');
  assert.equal((await call('POST', '/api/v1/admin/stars/legacy-mode', adminT, { ...body, level: 'Pathfinder' })).status, 400);
  assert.equal((await call('POST', '/api/v1/admin/stars/legacy-mode', adminT, { ...body, level: 'Patriot' })).status, 404, 'no baseline at that level');
  assert.equal((await call('POST', '/api/v1/admin/stars/legacy-mode', adminT, { ...body, girlId: 99999 })).status, 404);
  assert.equal(proposal(luProposal).status, 'proposed', 'nothing changed by the refusals');

  const r = await call('POST', '/api/v1/admin/stars/legacy-mode', adminT, body);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { girlId: lu, level: 'Explorer', mode: 'fresh', freshFrom: PY_START, withdrawn: 1, proposed: 0, conflicts: 0 });
  assert.equal(proposal(luProposal).status, 'withdrawn');
  assert.deepEqual({ ...db.prepare("SELECT legacy_mode, fresh_from FROM star_baseline WHERE girl_id = ? AND level = 'Explorer'").get(lu) }, { legacy_mode: 'fresh', fresh_from: PY_START });
  const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'stars.legacy_mode'").get();
  assert.deepEqual([JSON.parse(audit.before), JSON.parse(audit.after), audit.actor],
    [{ level: 'Explorer', mode: 'separate', freshFrom: null }, { level: 'Explorer', mode: 'fresh', freshFrom: PY_START }, 'admin@example.com']);

  const v = (await call('GET', '/api/v1/stars', leaderT)).json;
  const ex = v.girls.find((g) => g.id === lu).levels.find((l) => l.level === 'Explorer');
  assert.deepEqual({ mode: ex.legacyMode, freshFrom: ex.freshFrom, freshHours: ex.freshHours, carryIn: ex.carryIn, expected: ex.expected, carryOut: ex.carryOut, toNextHours: ex.toNextHours },
    { mode: 'fresh', freshFrom: PY_START, freshHours: 1.5, carryIn: 0, expected: 1, carryOut: 1.5, toNextHours: 8.5 });

  // choosing fresh again keeps the stored start date
  const again = await call('POST', '/api/v1/admin/stars/legacy-mode', adminT, body);
  assert.equal(again.json.freshFrom, PY_START);

  // flipping back means the leader wants the extra star added on top again:
  // a withdrawn proposal never blocks, so #2 is proposed afresh
  const back = await call('POST', '/api/v1/admin/stars/legacy-mode', adminT, { ...body, mode: 'separate' });
  assert.equal(back.status, 200);
  assert.equal(back.json.freshFrom, null);
  assert.equal(back.json.proposed, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM star_proposals WHERE girl_id = ? AND level = 'Explorer' AND ordinal = 2 AND status = 'proposed'").get(lu).n, 1);
});
