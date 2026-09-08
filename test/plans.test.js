'use strict';
// Build step 4: plans API — one plan per event per level group, items with
// multi-session roles, stable plan_item ids across replaces. Offline.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { makeConfig } = require('../server/config');
const { openDb, migrate } = require('../server/db');
const { createApp } = require('../server/app');
const catalog = require('../server/lib/catalog');
const { badgeAllowedInPlan } = require('../server/lib/plans');
const { buildBadge } = require('../scripts/build-badges');
const example = require('../handbook/example.json');

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000002';
const GROUP = '00000000-0000-0000-0000-000000000003';

let keys; let jwks; let db; let server; let base; let badgesDir; let eventId;

async function token(claims = {}) {
  return new SignJWT({ scp: 'access_as_leader', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(CLIENT)
    .setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
}
const get = (p, t, init = {}) => fetch(base + p, { ...init, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), 'Content-Type': 'application/json', ...(init.headers || {}) } });
const put = (p, t, body) => get(p, t, { method: 'PUT', body: JSON.stringify(body) });

function exampleBuilt() {
  const cat = {
    awardId: 'aw0000example', name: 'Example Badge', levelGroup: 'Pioneer/Patriot', retired: false, wholeAwardOnly: false, imageSlug: 'example', source: { fetchedAt: '2026-09-07T00:00:00Z' },
    groups: [
      { label: 'Complete All', rule: { type: 'all' }, edition: 'current', plannable: true, items: [{ id: 'r00000test01', number: 1, title: 'First' }, { id: 'r00000test02', number: 2, title: 'Second' }] },
      { label: 'Complete One', rule: { type: 'n_of', n: 1 }, edition: 'current', plannable: true, items: [{ id: 'r00000test03', number: 3, title: 'Third' }, { id: 'r00000test04', number: 4, title: 'Fourth' }] },
    ],
  };
  const r = buildBadge(example, cat, { annotationFile: 'example.json' });
  assert.equal(r.errors, undefined);
  return r.badge;
}

test.before(async () => {
  keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] });
  badgesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-badges-'));
  const b = exampleBuilt();
  fs.writeFileSync(path.join(badgesDir, 'example-badge-pipa.json'), JSON.stringify(b));
  fs.writeFileSync(path.join(badgesDir, 'other-badge-expl.json'), JSON.stringify({
    ...b, id: 'other-badge-expl', awardId: 'aw0000other0', name: 'Other', levelGroup: 'Explorer',
    groups: [{ label: 'Complete All', rule: { type: 'all' }, requirements: [{ number: 1, ahgFamilyId: 'r00000test09', title: 'x', text: 'x', subItems: [], flags: [] }] }],
  }));
  const cfg = makeConfig({
    MSAL_TENANT_ID: TENANT, MSAL_CLIENT_ID: CLIENT, LEADER_GROUP_ID: GROUP, ADMIN_EMAILS: 'admin@example.com',
    DB_PATH: ':memory:', BADGES_DIR: badgesDir,
  });
  db = openDb(':memory:');
  migrate(db);
  catalog.importFromDir(db, badgesDir, { actor: 'admin@example.com' });
  eventId = Number(db.prepare("INSERT INTO events (checkin_event_id, ical_uid, start_at, end_at, title, updated_at) VALUES (42, 'uid-meeting-1@example.com', '2026-09-01T23:00:00.000Z', '2026-09-02T00:30:00.000Z', 'Weekly Meeting', '2026-09-01T00:00:00Z')").run().lastInsertRowid);
  const app = createApp({ cfg, db, jwks });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); fs.rmSync(badgesDir, { recursive: true, force: true }); });

test('badgeAllowedInPlan: exact, All, and Pioneer/Patriot absorption only', () => {
  assert.equal(badgeAllowedInPlan('Explorer', 'Explorer'), true);
  assert.equal(badgeAllowedInPlan('All', 'Tenderheart'), true);
  assert.equal(badgeAllowedInPlan('Pioneer', 'Pioneer/Patriot'), true);
  assert.equal(badgeAllowedInPlan('Patriot', 'Pioneer/Patriot'), true);
  assert.equal(badgeAllowedInPlan('Pioneer/Patriot', 'Pioneer/Patriot'), true);
  assert.equal(badgeAllowedInPlan('Explorer', 'Pioneer/Patriot'), false);
  assert.equal(badgeAllowedInPlan('Pioneer/Patriot', 'Explorer'), false);
  assert.equal(badgeAllowedInPlan('Pathfinders', 'Tenderheart'), false);
});

test('PUT validation: event, level group, requirement, role, duplicates, cross-level', async () => {
  const t = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  const lg = encodeURIComponent('Pioneer/Patriot');
  assert.equal((await put(`/api/v1/events/9999/plans/${lg}`, t, { items: [] })).status, 404);
  assert.equal((await put(`/api/v1/events/${eventId}/plans/Pathfinders`, t, { items: [] })).status, 400, 'Pathfinders never plan badgework');
  let r = await put(`/api/v1/events/${eventId}/plans/${lg}`, t, { items: [{ requirementId: 'nope:1', role: 'session' }] });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /unknown requirement/);
  r = await put(`/api/v1/events/${eventId}/plans/${lg}`, t, { items: [{ requirementId: 'example-badge-pipa:1', role: 'someday' }] });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /role must be/);
  r = await put(`/api/v1/events/${eventId}/plans/${lg}`, t, { items: [{ requirementId: 'example-badge-pipa:1', role: 'session' }, { requirementId: 'example-badge-pipa:1', role: 'finish' }] });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /appears twice/);
  r = await put(`/api/v1/events/${eventId}/plans/${lg}`, t, { items: [{ requirementId: 'other-badge-expl:1', role: 'session' }] });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /Explorer badge — not plannable/);
  assert.equal((await get(`/api/v1/events/${eventId}/plans`)).status, 401, 'auth required');
});

test('PUT creates; GET returns items in order with badge info; two level groups coexist', async () => {
  const t = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  const lg = encodeURIComponent('Pioneer/Patriot');
  let r = await put(`/api/v1/events/${eventId}/plans/${lg}`, t, {
    notes: 'campfire night',
    items: [
      { requirementId: 'example-badge-pipa:3', role: 'start', notes: 'first of two sessions' },
      { requirementId: 'example-badge-pipa:1', role: 'session' },
    ],
  });
  assert.equal(r.status, 200);
  const plan = await r.json();
  assert.equal(plan.levelGroup, 'Pioneer/Patriot');
  assert.equal(plan.createdBy, 'leader@example.com');
  assert.deepEqual(plan.items.map((i) => [i.requirementId, i.role, i.position]),
    [['example-badge-pipa:3', 'start', 0], ['example-badge-pipa:1', 'session', 1]]);
  assert.equal(plan.items[0].badgeName, 'Example Badge');
  assert.equal(plan.items[0].number, 3);

  r = await put(`/api/v1/events/${eventId}/plans/Explorer`, t, { items: [{ requirementId: 'other-badge-expl:1', role: 'session' }] });
  assert.equal(r.status, 200);
  const both = await (await get(`/api/v1/events/${eventId}/plans`, t)).json();
  assert.deepEqual(both.map((p) => p.levelGroup), ['Explorer', 'Pioneer/Patriot']);
  const evList = await (await get('/api/v1/events?from=2026-09-01&to=2026-09-01', t)).json();
  assert.deepEqual(evList[0].planLevelGroups.sort(), ['Explorer', 'Pioneer/Patriot']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 2, 'replace never duplicates');
});

test('replace: kept requirement keeps its plan_item id; removal cascades participation, 409 on live completion', async () => {
  const t = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  const lg = encodeURIComponent('Pioneer/Patriot');
  const before = await (await get(`/api/v1/events/${eventId}/plans`, t)).json();
  const pipa = before.find((p) => p.levelGroup === 'Pioneer/Patriot');
  const keptId = pipa.items.find((i) => i.requirementId === 'example-badge-pipa:3').id;
  const removedId = pipa.items.find((i) => i.requirementId === 'example-badge-pipa:1').id;

  const girlId = Number(db.prepare("INSERT INTO girls (first_name, last_name, active, updated_at) VALUES ('Bea', 'Anders', 1, '2026-09-01T00:00:00Z')").run().lastInsertRowid);
  db.prepare('INSERT INTO participation (girl_id, plan_item_id, event_id, recorded_at) VALUES (?, ?, ?, ?)').run(girlId, removedId, eventId, '2026-09-02T00:00:00Z');
  db.prepare("INSERT INTO completions (girl_id, requirement_id, status, source, plan_item_id, event_id, proposed_at) VALUES (?, 'example-badge-pipa:1', 'proposed', 'attendance', ?, ?, '2026-09-02T00:00:00Z')").run(girlId, removedId, eventId);

  // a live completion protects its plan item
  let r = await put(`/api/v1/events/${eventId}/plans/${lg}`, t, { items: [{ requirementId: 'example-badge-pipa:3', role: 'finish' }] });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /decide or remove them first/);

  // once rejected, the item may go; the rejected row keeps its history
  db.prepare("UPDATE completions SET status = 'rejected' WHERE plan_item_id = ?").run(removedId);
  r = await put(`/api/v1/events/${eventId}/plans/${lg}`, t, { items: [{ requirementId: 'example-badge-pipa:3', role: 'finish' }] });
  assert.equal(r.status, 200);
  const after = await r.json();
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].id, keptId, 'plan_item id stable across replace');
  assert.equal(after.items[0].role, 'finish');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM participation WHERE plan_item_id = ?').get(removedId).n, 0, 'participation cascaded');
  const rejected = db.prepare("SELECT * FROM completions WHERE girl_id = ? AND requirement_id = 'example-badge-pipa:1'").get(girlId);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.plan_item_id, null, 'history kept, plan item released');
});

test('empty PUT deletes the plan; audit trail records put and delete', async () => {
  const t = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  const r = await put(`/api/v1/events/${eventId}/plans/Explorer`, t, { items: [] });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { deleted: true });
  const left = await (await get(`/api/v1/events/${eventId}/plans`, t)).json();
  assert.deepEqual(left.map((p) => p.levelGroup), ['Pioneer/Patriot']);
  const audit = await (await get('/api/v1/admin/audit', adminT)).json();
  const actions = audit.map((a) => a.action);
  assert.ok(actions.includes('plan.put'));
  assert.ok(actions.includes('plan.delete'));
  const del = audit.find((a) => a.action === 'plan.delete');
  assert.equal(del.entity_id, `${eventId}:Explorer`);
  assert.ok(JSON.parse(del.before).items.length, 'before captured the dropped items');
});

test('year overview: plan-based bars — needed honors n_of, done = completing items on past events', async () => {
  const t = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  // fresh events: one last week (held), one next week (scheduled)
  const past = new Date(Date.now() - 7 * 864e5).toISOString();
  const future = new Date(Date.now() + 7 * 864e5).toISOString();
  const evPast = Number(db.prepare("INSERT INTO events (checkin_event_id, ical_uid, start_at, end_at, title, updated_at) VALUES (91, 'uid-yr-past@example.com', ?, ?, 'Held Meeting', ?)").run(past, past, past).lastInsertRowid);
  const evFuture = Number(db.prepare("INSERT INTO events (checkin_event_id, ical_uid, start_at, end_at, title, updated_at) VALUES (92, 'uid-yr-future@example.com', ?, ?, 'Coming Meeting', ?)").run(future, future, future).lastInsertRowid);
  // held: req 1 done that night, req 3 (n_of group) done, req 2 only STARTED
  await put(`/api/v1/events/${evPast}/plans/${encodeURIComponent('Pioneer/Patriot')}`, t, { items: [
    { requirementId: 'example-badge-pipa:1', role: 'session' },
    { requirementId: 'example-badge-pipa:3', role: 'session' },
    { requirementId: 'example-badge-pipa:2', role: 'start' },
  ] });
  // coming: req 2 finishes, req 4 (n_of group — beyond the rule's 1) scheduled
  await put(`/api/v1/events/${evFuture}/plans/${encodeURIComponent('Pioneer/Patriot')}`, t, { items: [
    { requirementId: 'example-badge-pipa:2', role: 'finish' },
    { requirementId: 'example-badge-pipa:4', role: 'session' },
  ] });
  const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const y = await (await get(`/api/v1/progress/year?from=${from}&to=${to}`, t)).json();
  const unit = y.units.find((u) => u.unit === 'Pioneer/Patriot');
  const b = unit.badges.find((x) => x.badgeId === 'example-badge-pipa');
  // needed = all-group 2 + n_of(1) = 3; planned: 1,2 (all group) + n_of capped at 1 (3&4 both planned) = 3
  // done: req1 (past session) + req3 (past, counts within n_of cap) = 2; req2's finish is in the future
  assert.deepEqual(
    { needed: b.needed, planned: b.planned, done: b.done, startedOnly: b.startedOnly },
    { needed: 3, planned: 3, done: 2, startedOnly: 0 },
  );
  assert.equal((await get('/api/v1/progress/year?from=bad&to=2027-01-01', t)).status, 400);
});
