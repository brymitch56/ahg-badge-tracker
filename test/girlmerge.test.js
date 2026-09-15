'use strict';
// Duplicate / old girl records (server/lib/girlmerge.js): the admin list,
// merge (id + history move, mirror collisions keep the current record's
// copy, decisions never dropped), release, refusals that change nothing,
// and the mapping error that points at the old record. Invented names and
// hashids only (CLAUDE.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { makeConfig } = require('../server/config');
const { openDb, migrate } = require('../server/db');
const { createApp } = require('../server/app');

const KEY = Buffer.from('cd'.repeat(32), 'hex');
const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000002';
const GROUP = '00000000-0000-0000-0000-000000000003';

let keys; let db; let server; let base; let adminT; let leaderT;
const ts = () => new Date().toISOString();

async function token(claims = {}) {
  return new SignJWT({ scp: 'access_as_leader', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(CLIENT)
    .setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
}
const call = async (method, p, t, body) => {
  const r = await fetch(base + p, {
    method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

function addGirl(first, last, { active = 1, youthId = null, memberId = null } = {}) {
  return Number(db.prepare(`INSERT INTO girls (first_name, last_name, member_id, ahg_level, ahg_youth_id, ahg_youth_id_source, active, status, updated_at)
                            VALUES (?, ?, ?, 'Explorer', ?, ?, ?, ?, ?)`)
    .run(first, last, memberId, youthId, youthId ? 'mapped' : null, active, active ? 'active' : 'inactive', ts()).lastInsertRowid);
}
const girl = (id) => db.prepare('SELECT * FROM girls WHERE id = ?').get(id);
const count = (table, girlId) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE girl_id = ?`).get(girlId).n;
const addCompletion = (girlId, req, status = 'confirmed') => db.prepare(
  "INSERT INTO completions (girl_id, requirement_id, status, source, proposed_at) VALUES (?, ?, ?, 'manual', ?)").run(girlId, req, status, ts());
const addAttendance = (eventId, girlId, signedIn) => db.prepare(
  'INSERT INTO attendance (event_id, girl_id, signed_in_at, fetched_at) VALUES (?, ?, ?, ?)').run(eventId, girlId, signedIn, ts());
const addAhgState = (girlId, req, comment) => db.prepare(
  'INSERT INTO ahg_state (girl_id, requirement_id, completed, comment, fetched_at) VALUES (?, ?, 1, ?, ?)').run(girlId, req, comment, ts());

let evA; let evB;

test.before(async () => {
  keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] });
  const cfg = makeConfig({
    MSAL_TENANT_ID: TENANT, MSAL_CLIENT_ID: CLIENT, LEADER_GROUP_ID: GROUP, ADMIN_EMAILS: 'admin@example.com',
    DB_PATH: ':memory:', CRED_KEY: KEY.toString('hex'),
  });
  db = openDb(':memory:');
  migrate(db);
  // a one-badge catalog and two events, enough for the per-girl FKs
  db.prepare("INSERT INTO catalog_versions (id, imported_at, badge_count, requirement_count) VALUES (1, ?, 1, 2)").run(ts());
  db.prepare("INSERT INTO badges (id, catalog_version_id, ahg_award_id, name, level_group, levels, json) VALUES ('merge-badge', 1, 'awmergetest1', 'Merge Badge', 'Explorer', '[\"Explorer\"]', '{}')").run();
  db.prepare("INSERT INTO badge_groups (id, badge_id, position, rule_type) VALUES ('merge-badge:0', 'merge-badge', 0, 'all')").run();
  for (const n of [1, 2]) {
    db.prepare("INSERT INTO requirements (id, badge_id, group_id, number, ahg_requirement_id, text) VALUES (?, 'merge-badge', 'merge-badge:0', ?, ?, 'x')")
      .run(`merge-badge:${n}`, n, `rmergetest0${n}`);
  }
  evA = Number(db.prepare("INSERT INTO events (checkin_event_id, start_at, title, updated_at) VALUES (501, '2026-09-01T23:00:00.000Z', 'Weekly Meeting', ?)").run(ts()).lastInsertRowid);
  evB = Number(db.prepare("INSERT INTO events (checkin_event_id, start_at, title, updated_at) VALUES (502, '2026-09-08T23:00:00.000Z', 'Weekly Meeting', ?)").run(ts()).lastInsertRowid);
  const app = createApp({ cfg, db, jwks });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  leaderT = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
});
test.after(() => { server.close(); db.close(); });

let oldIvy; let ivy; let oldRae; let empty;

test('old-records list: an inactive record holding an id or data, with same-name current girls; empty ones left out', async () => {
  oldIvy = addGirl('Ivy', 'Example', { active: 0, youthId: 'umergetest01' });
  ivy = addGirl('Ivy', 'Example', { memberId: 'TEST-0001' });
  oldRae = addGirl('Rae', 'Gone', { active: 0, youthId: 'umergetest02' });
  empty = addGirl('Nia', 'Empty', { active: 0 });

  assert.equal((await call('GET', '/api/v1/admin/mapping', leaderT)).status, 403, 'admin only');
  const view = (await call('GET', '/api/v1/admin/mapping', adminT)).json;
  const ids = view.duplicates.map((d) => d.id);
  assert.ok(ids.includes(oldIvy) && ids.includes(oldRae));
  assert.ok(!ids.includes(empty), 'an old record with nothing on it is not listed');
  const d = view.duplicates.find((x) => x.id === oldIvy);
  assert.equal(d.ahgYouthId, 'umergetest01');
  assert.deepEqual(d.candidates.map((c) => c.id), [ivy]);
  assert.deepEqual(view.duplicates.find((x) => x.id === oldRae).candidates, []);
});

test('mapping a current girl to an id an old record holds is refused, naming the old record', async () => {
  const r = await call('POST', '/api/v1/admin/mapping/confirm', adminT, [{ girlId: ivy, ahgYouthId: 'umergetest01' }]);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /old, inactive record for Ivy Example/);
  assert.equal(girl(ivy).ahg_youth_id, null);
});

test('merge refusals change nothing', async () => {
  const other = addGirl('Uma', 'Mapped', { youthId: 'umergetest03' });
  const oldOther = addGirl('Uma', 'Mapped', { active: 0, youthId: 'umergetest04' });
  const snapshot = () => JSON.stringify([girl(oldIvy), girl(ivy), girl(other), girl(oldOther)]);
  const before = snapshot();

  assert.equal((await call('POST', '/api/v1/admin/girls/merge', leaderT, { fromGirlId: oldIvy, intoGirlId: ivy })).status, 403);
  assert.equal((await call('POST', '/api/v1/admin/girls/merge', adminT, { fromGirlId: oldIvy })).status, 400);
  assert.equal((await call('POST', '/api/v1/admin/girls/merge', adminT, { fromGirlId: ivy, intoGirlId: ivy })).status, 400);
  assert.equal((await call('POST', '/api/v1/admin/girls/merge', adminT, { fromGirlId: 99999, intoGirlId: ivy })).status, 404);
  let r = await call('POST', '/api/v1/admin/girls/merge', adminT, { fromGirlId: ivy, intoGirlId: other });
  assert.equal(r.status, 409, 'an active record is never merged away');
  r = await call('POST', '/api/v1/admin/girls/merge', adminT, { fromGirlId: oldIvy, intoGirlId: oldRae });
  assert.equal(r.status, 409, 'the target must be a current record');
  r = await call('POST', '/api/v1/admin/girls/merge', adminT, { fromGirlId: oldOther, intoGirlId: other });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /different AHGFamily members/);

  // both hold a live decision for the same requirement → refused, atomically
  addCompletion(oldIvy, 'merge-badge:2', 'confirmed');
  addCompletion(ivy, 'merge-badge:2', 'proposed');
  r = await call('POST', '/api/v1/admin/girls/merge', adminT, { fromGirlId: oldIvy, intoGirlId: ivy });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /1 requirement completion/);
  assert.equal(snapshot(), before);
  assert.equal(count('completions', oldIvy), 1);
  // the leader clears one side (here: the proposal on the current record)
  db.prepare("DELETE FROM completions WHERE girl_id = ? AND requirement_id = 'merge-badge:2'").run(ivy);
  db.prepare("DELETE FROM completions WHERE girl_id = ? AND requirement_id = 'merge-badge:2'").run(oldIvy);
});

test('merge moves the id and history; a mirror collision keeps the current record\'s copy; the old record stays as merged', async () => {
  addCompletion(oldIvy, 'merge-badge:1', 'confirmed');
  addCompletion(oldIvy, 'merge-badge:1', 'rejected'); // rejected rows never collide
  addAttendance(evA, oldIvy, 'old-copy');
  addAttendance(evB, oldIvy, 'old-only');
  addAttendance(evA, ivy, 'current-copy');
  addAhgState(oldIvy, 'merge-badge:1', 'old');
  addAhgState(ivy, 'merge-badge:1', 'current');

  const r = await call('POST', '/api/v1/admin/girls/merge', adminT, { fromGirlId: oldIvy, intoGirlId: ivy });
  assert.equal(r.status, 200);
  assert.equal(r.json.youthIdMoved, 'umergetest01');
  assert.deepEqual(r.json.moved, { completions: 2, attendance: 1 });
  assert.deepEqual(r.json.dropped, { attendance: 1, ahg_state: 1 });

  const now = girl(ivy);
  assert.equal(now.ahg_youth_id, 'umergetest01');
  assert.equal(now.ahg_youth_id_source, 'mapped');
  const old = girl(oldIvy);
  assert.deepEqual({ id: old.ahg_youth_id, active: old.active, status: old.status, into: old.merged_into_girl_id },
    { id: null, active: 0, status: 'merged', into: ivy });
  for (const t of ['completions', 'attendance', 'ahg_state']) assert.equal(count(t, oldIvy), 0, `${t} left behind`);
  assert.equal(count('completions', ivy), 2);
  assert.equal(db.prepare('SELECT signed_in_at FROM attendance WHERE event_id = ? AND girl_id = ?').get(evA, ivy).signed_in_at, 'current-copy');
  assert.equal(db.prepare('SELECT signed_in_at FROM attendance WHERE event_id = ? AND girl_id = ?').get(evB, ivy).signed_in_at, 'old-only');
  assert.equal(db.prepare("SELECT comment FROM ahg_state WHERE girl_id = ? AND requirement_id = 'merge-badge:1'").get(ivy).comment, 'current');

  const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'girl.merge' AND entity_id = ?").get(String(oldIvy));
  assert.equal(JSON.parse(audit.before).from.ahgYouthId, 'umergetest01');
  assert.equal(audit.actor, 'admin@example.com');

  const view = (await call('GET', '/api/v1/admin/mapping', adminT)).json;
  assert.ok(!view.duplicates.some((d) => d.id === oldIvy), 'a merged record leaves the list');
  const again = await call('POST', '/api/v1/admin/girls/merge', adminT, { fromGirlId: oldIvy, intoGirlId: ivy });
  assert.equal(again.status, 409, 'already merged');
});

test('release frees an old record\'s id so it can be mapped; refuses current and empty records', async () => {
  assert.equal((await call('POST', `/api/v1/admin/girls/${oldRae}/release-youth-id`, leaderT)).status, 403);
  assert.equal((await call('POST', `/api/v1/admin/girls/${ivy}/release-youth-id`, adminT)).status, 409, 'current record');
  assert.equal((await call('POST', '/api/v1/admin/girls/99999/release-youth-id', adminT)).status, 404);

  // AHGFamily mirror copies on the old record: listed while it holds the id
  addAhgState(oldRae, 'merge-badge:1', 'mirror');
  assert.ok((await call('GET', '/api/v1/admin/mapping', adminT)).json.duplicates.some((d) => d.id === oldRae));

  const r = await call('POST', `/api/v1/admin/girls/${oldRae}/release-youth-id`, adminT);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { girlId: oldRae, released: 'umergetest02' });
  assert.equal(girl(oldRae).ahg_youth_id, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'girl.release_youth_id'").get().n, 1);
  assert.equal((await call('POST', `/api/v1/admin/girls/${oldRae}/release-youth-id`, adminT)).status, 409, 'nothing left to release');

  // the freed id now maps to a current girl
  const rae = addGirl('Rae', 'Gone', { memberId: 'TEST-0002' });
  const m = await call('POST', '/api/v1/admin/mapping/confirm', adminT, [{ girlId: rae, ahgYouthId: 'umergetest02' }]);
  assert.equal(m.status, 200);
  assert.equal(girl(rae).ahg_youth_id, 'umergetest02');
  assert.ok(!(await call('GET', '/api/v1/admin/mapping', adminT)).json.duplicates.some((d) => d.id === oldRae), 'nothing left on the old record');
});
