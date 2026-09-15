'use strict';
// Service Stars: stars awarded on Pathfinder hours before the troop stopped
// counting them (ruling Sept 2026), and a leader's call on other extra stars.
// The awarded stars stand; Pathfinder hours count only to cover them; new
// stars need counted hours beyond them. Invented names and ids only.
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
  // 14 h counted at baseline, 3 on record, 9.5 h Pathfinder → 1 star on Pathfinder hours
  const base = { onRecord: 3, earnable: 2, hours: 1400 };
  let l = TH(1550, 950, base, 3); // after a 1.5 h meeting
  assert.deepEqual(
    { earnable: l.earnable, legacy: l.legacy, expected: l.expected, newStars: l.newStars, covered: l.coveredStars, credit: l.pathfinderCredit, conflict: l.conflict },
    { earnable: 3, legacy: 0, expected: 3, newStars: 0, covered: 1, credit: 0, conflict: null },
  );
  assert.equal(TH(1950, 950, base, 3).newStars, 0, '19.5 counted hours: still 3');
  l = TH(2000, 950, base, 3);
  assert.deepEqual({ expected: l.expected, newStars: l.newStars, carryOut: l.carryOut }, { expected: 4, newStars: 1, carryOut: 0 }, 'the 4th star needs 20 counted hours');
  // the same girl WITHOUT Pathfinder hours keeps the old legacy behaviour (paper-era star on top)
  assert.equal(TH(1550, 0, base, 3).expected, 4);
});

test('the credit fills only up to the stars on record and shrinks to nothing as counted hours catch up', () => {
  const base = { onRecord: 3, earnable: 2, hours: 1100 }; // 11 h counted, 7.5 h Pathfinder
  let l = TH(1250, 750, base, 3);
  assert.deepEqual({ credit: l.pathfinderCredit, available: l.available, earnable: l.earnable, carryOut: l.carryOut, expected: l.expected, newStars: l.newStars },
    { credit: 250, available: 1500, earnable: 3, carryOut: 0, expected: 3, newStars: 0 });
  l = TH(1600, 750, base, 3);
  assert.deepEqual({ credit: l.pathfinderCredit, carryOut: l.carryOut }, { credit: 0, carryOut: 100 }, 'no Pathfinder hours carry once counted hours cover the stars');
});

test('Pathfinder hours that explain only some extra stars cover those; the rest stay legacy', () => {
  const base = { onRecord: 4, earnable: 2, hours: 1350 }; // 2.5 h Pathfinder explains 1 of 2 extras
  const l = TH(1350, 250, base, 4);
  assert.deepEqual({ explained: l.pathfinderExplained, covered: l.coveredStars, unexplained: l.unexplainedExtras, legacy: l.legacy, credit: l.pathfinderCredit, expected: l.expected, conflict: l.conflict },
    { explained: 1, covered: 1, unexplained: 1, legacy: 1, credit: 150, expected: 4, conflict: null });
});

test('counted hours dropping below the baseline still surface as a conflict', () => {
  const l = TH(800, 750, { onRecord: 3, earnable: 2, hours: 1100 }, 3);
  assert.equal(l.pathfinderCredit, 500, 'the credit never exceeds the covered stars\' worth');
  assert.equal(l.expected, 2);
  assert.deepEqual(l.conflict, { kind: 'more_on_record', onRecord: 3, expected: 2, unexplained: 1 });
});

test('a leader\'s "count against her hours" choice: extra stars are no longer stacked', () => {
  // 42.25 h Tenderheart → 8 stars, 2.25 carry; Explorer 1 on record at 8.75 h
  const run = (explorerHours, legacyMode, onRecordEx = 1) => St.computeStarChain({
    hoursByLevel: { Tenderheart: 4225, Explorer: explorerHours },
    onRecord: { Tenderheart: 8, Explorer: onRecordEx },
    baseline: { Tenderheart: { onRecord: 8, earnable: 8, hours: 4225 }, Explorer: { onRecord: 1, earnable: 0, hours: 875, legacyMode } },
  }).levels[1];
  assert.equal(run(800, 'separate').expected, 2, 'default: the extra star is added on top');
  let l = run(800, 'hours');
  assert.deepEqual({ expected: l.expected, newStars: l.newStars, legacyMode: l.legacyMode, credit: l.credit, pfCredit: l.pathfinderCredit, unexplained: l.unexplainedExtras },
    { expected: 1, newStars: 0, legacyMode: 'hours', credit: 0, pfCredit: 0, unexplained: 1 });
  l = run(500, 'hours'); // fewer hours than the star she holds: covered, not a conflict
  assert.deepEqual({ available: l.available, expected: l.expected, conflict: l.conflict }, { available: 1000, expected: 1, conflict: null });
  assert.equal(run(1800, 'hours').expected, 2, 'the 2nd Explorer star once the hours earn it');
});

test('girls with no extra stars are untouched by Pathfinder hours', () => {
  const l = TH(1200, 900, { onRecord: 2, earnable: 2, hours: 1000 }, 2);
  assert.deepEqual({ credit: l.credit, covered: l.coveredStars, expected: l.expected, carryOut: l.carryOut }, { credit: 0, covered: 0, expected: 2, carryOut: 200 });
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
let rec = 0;
const addGirl = (first, level, youthId) => Number(db.prepare(
  "INSERT INTO girls (first_name, last_name, ahg_level, ahg_youth_id, ahg_youth_id_source, active, updated_at) VALUES (?, 'Example', ?, ?, 'manual', 1, ?)",
).run(first, level, youthId, ts()).lastInsertRowid);
const addHours = (girlId, level, hundredths) => db.prepare(
  'INSERT INTO service_hours (girl_id, ahg_record_id, date, level, hundredths, verified, description, fetched_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
).run(girlId, `svctest${String(++rec).padStart(5, '0')}`, '2026-01-01', level, hundredths, 'Service Hour Meeting', ts());
const addStars = (girlId, level, n) => {
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO award_instances (girl_id, ahg_award_id, ad_record_id, completed_on, first_seen_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(girlId, St.STAR_AWARD_IDS[level], `adtest${String(++rec).padStart(6, '0')}`, '2026-01-01', ts(), ts());
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

  // Lo: 3 stars, 12.5 h counted, 7.5 h Pathfinder — the credit is visible
  lo = addGirl('Lo', 'Tenderheart', 'upftest00002');
  addHours(lo, 'Tenderheart', 1250);
  addHours(lo, 'Pathfinder', 750);
  addStars(lo, 'Tenderheart', 3);
  addBaseline(lo, 'Tenderheart', 3, 2, 1100);

  // Lu: an Explorer star on record before her hours earned it; a #2 pending
  lu = addGirl('Lu', 'Explorer', 'upftest00003');
  addHours(lu, 'Tenderheart', 4225);
  addHours(lu, 'Explorer', 800);
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

  addHours(pia, 'Tenderheart', 400); // 19.5 h counted
  r = servicepull.reconcileGirl(db, girlRow(pia), { fetchedLevels: ['Tenderheart'] });
  assert.equal(r.proposed, 0);
  addHours(pia, 'Tenderheart', 50); // 20 h counted
  r = servicepull.reconcileGirl(db, girlRow(pia), { fetchedLevels: ['Tenderheart'] });
  assert.equal(r.proposed, 1, 'a withdrawn proposal never blocks the real star');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM star_proposals WHERE girl_id = ? AND ordinal = 4 AND status = 'proposed'").get(pia).n, 1);
});

test('stars view shows the Pathfinder credit and covered stars; other extra stars offer the leader\'s choice', async () => {
  const v = (await call('GET', '/api/v1/stars', leaderT)).json;
  const th = (id) => v.girls.find((g) => g.id === id).levels.find((l) => l.level === 'Tenderheart');
  assert.deepEqual({ credit: th(lo).pathfinderCredit, covered: th(lo).coveredStars, unexplained: th(lo).unexplainedExtras, earnable: th(lo).earnable, newStars: th(lo).newStars },
    { credit: 2.5, covered: 1, unexplained: 0, earnable: 3, newStars: 0 });
  const ex = v.girls.find((g) => g.id === lu).levels.find((l) => l.level === 'Explorer');
  assert.deepEqual({ unexplained: ex.unexplainedExtras, mode: ex.legacyMode, expected: ex.expected }, { unexplained: 1, mode: 'separate', expected: 2 });
});

test('admin sets "count against her hours": the false proposal is withdrawn at once, audited; bad input refused', async () => {
  const body = { girlId: lu, level: 'Explorer', mode: 'hours' };
  assert.equal((await call('POST', '/api/v1/admin/stars/legacy-mode', leaderT, body)).status, 403);
  assert.equal((await call('POST', '/api/v1/admin/stars/legacy-mode', adminT, { ...body, mode: 'nope' })).status, 400);
  assert.equal((await call('POST', '/api/v1/admin/stars/legacy-mode', adminT, { ...body, level: 'Pathfinder' })).status, 400);
  assert.equal((await call('POST', '/api/v1/admin/stars/legacy-mode', adminT, { ...body, level: 'Patriot' })).status, 404, 'no baseline at that level');
  assert.equal((await call('POST', '/api/v1/admin/stars/legacy-mode', adminT, { ...body, girlId: 99999 })).status, 404);
  assert.equal(proposal(luProposal).status, 'proposed', 'nothing changed by the refusals');

  const r = await call('POST', '/api/v1/admin/stars/legacy-mode', adminT, body);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { girlId: lu, level: 'Explorer', mode: 'hours', withdrawn: 1, proposed: 0, conflicts: 0 });
  assert.equal(proposal(luProposal).status, 'withdrawn');
  assert.equal(db.prepare("SELECT legacy_mode FROM star_baseline WHERE girl_id = ? AND level = 'Explorer'").get(lu).legacy_mode, 'hours');
  const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'stars.legacy_mode'").get();
  assert.deepEqual([JSON.parse(audit.before), JSON.parse(audit.after), audit.actor], [{ level: 'Explorer', mode: 'separate' }, { level: 'Explorer', mode: 'hours' }, 'admin@example.com']);

  // flipping back means the leader wants the extra star added on top again:
  // a withdrawn proposal never blocks, so #2 is proposed afresh
  const back = await call('POST', '/api/v1/admin/stars/legacy-mode', adminT, { ...body, mode: 'separate' });
  assert.equal(back.status, 200);
  assert.equal(back.json.proposed, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM star_proposals WHERE girl_id = ? AND level = 'Explorer' AND ordinal = 2 AND status = 'proposed'").get(lu).n, 1);
});
