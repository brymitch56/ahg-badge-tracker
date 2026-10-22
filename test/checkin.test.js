'use strict';
// Build step 3: check-in Integration API client, mirror, webhook receiver,
// and the girls/events/sync routes. All offline — the check-in app is the
// fixture in checkin-fixtures.js; auth uses a local JWKS.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { makeConfig } = require('../server/config');
const { openDb, migrate } = require('../server/db');
const { createApp } = require('../server/app');
const { makeCheckinClient, CheckinError } = require('../server/lib/checkin');
const mirror = require('../server/lib/mirror');
const { verifySignature } = require('../server/lib/webhook');
const { makeState, makeFakeCheckin } = require('./checkin-fixtures');

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000002';
const GROUP = '00000000-0000-0000-0000-000000000003';
const SECRET = 'whsec-test-never-real';

let keys; let jwks; let app; let server; let base; let db; let state;

async function token(claims = {}) {
  return new SignJWT({ scp: 'access_as_leader', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(CLIENT)
    .setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
}
const get = (p, t, init = {}) => fetch(base + p, { ...init, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), 'Content-Type': 'application/json', ...(init.headers || {}) } });

function signedWebhook(payload, { secret = SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return fetch(base + '/webhooks/checkin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Troop-Checkin-Event': payload.type,
      'X-Troop-Checkin-Timestamp': String(ts),
      'X-Troop-Checkin-Signature': sig,
    },
    body,
  });
}
const webhookIdle = () => Promise.resolve(app.locals.webhookWork);

let client;
test.before(async () => {
  keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] });
  const cfg = makeConfig({
    MSAL_TENANT_ID: TENANT, MSAL_CLIENT_ID: CLIENT, LEADER_GROUP_ID: GROUP, ADMIN_EMAILS: 'admin@example.com',
    DB_PATH: ':memory:', CHECKIN_BASE: 'http://127.0.0.1:59999', CHECKIN_API_KEY: 'tci_test-key', CHECKIN_WEBHOOK_SECRET: SECRET,
  });
  db = openDb(':memory:');
  migrate(db);
  state = makeState();
  client = makeCheckinClient(cfg.checkin, { fetchImpl: makeFakeCheckin(state) });
  app = createApp({ cfg, db, jwks, checkinFetch: makeFakeCheckin(state) });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

// --------------------------------------------------------------- client ----
test('client: unconfigured refuses, wrong key surfaces 401, 404 surfaces', async () => {
  const un = makeCheckinClient({ base: '', apiKey: '' });
  assert.equal(un.configured, false);
  await assert.rejects(() => un.ping(), (e) => e instanceof CheckinError && /not configured/.test(e.message));
  const bad = makeCheckinClient({ base: 'http://127.0.0.1:59999', apiKey: 'tci_wrong' }, { fetchImpl: makeFakeCheckin(state) });
  await assert.rejects(() => bad.ping(), (e) => e instanceof CheckinError && e.status === 401);
  await assert.rejects(() => client.attendance(999), (e) => e instanceof CheckinError && e.status === 404);
  assert.deepEqual((await client.ping()).app, 'troop-checkin');
});

// --------------------------------------------------------------- mirror ----
test('syncEvents: upserts by checkin id and by ical identity; records a run', async () => {
  const s = await mirror.syncEvents(db, client);
  assert.equal(s.fetched, 2); assert.equal(s.created, 2);
  const again = await mirror.syncEvents(db, client);
  assert.equal(again.created, 0); assert.equal(again.updated, 2);
  // check-in app reinstalled: same ical identity, new checkin id
  state.events[0].id = 142;
  await mirror.syncEvents(db, client);
  const ev = db.prepare('SELECT * FROM events WHERE ical_uid = ?').get('uid-meeting-1@example.com');
  assert.equal(ev.checkin_event_id, 142);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2, 'no duplicate rows');
  state.events[0].id = 42; // restore
  await mirror.syncEvents(db, client);
  const run = db.prepare("SELECT * FROM sync_runs WHERE kind = 'checkin_events' ORDER BY id DESC LIMIT 1").get();
  assert.equal(run.ok, 1); assert.equal(JSON.parse(run.summary).fetched, 2);
});

test('syncPeople: youth only; visitor kept; u… hashid fills ahg_youth_id when empty; level normalized', async () => {
  const s = await mirror.syncPeople(db, client);
  assert.deepEqual({ youth: s.youth, created: s.created, visitors: s.visitors }, { youth: 3, created: 3, visitors: 1 });
  const girls = db.prepare('SELECT * FROM girls ORDER BY last_name').all();
  assert.deepEqual(girls.map((g) => g.last_name), ['Anders', 'Blake', 'Cole'], 'the adult never enters this database');
  const bea = girls[0];
  assert.equal(bea.ahg_youth_id, 'utest0000001');
  assert.equal(bea.ahg_youth_id_source, 'checkin');
  assert.equal(bea.ahg_level, 'Explorer');
  assert.equal(girls[2].status, 'visitor');
  assert.equal(girls[2].ahg_level, null);

  // fill-when-empty: an existing mapping is never overwritten by a sync
  db.prepare("UPDATE girls SET ahg_youth_id = 'utestmapped0', ahg_youth_id_source = 'manual' WHERE id = ?").run(bea.id);
  state.people[0].level = 'pioneer'; // also: normalization is case-insensitive, stored canonical
  await mirror.syncPeople(db, client);
  const bea2 = db.prepare('SELECT * FROM girls WHERE id = ?').get(bea.id);
  assert.equal(bea2.ahg_youth_id, 'utestmapped0', 'manual mapping survives the sync');
  assert.equal(bea2.ahg_level, 'Pioneer');
  db.prepare("UPDATE girls SET ahg_youth_id = 'utest0000001', ahg_youth_id_source = 'checkin' WHERE id = ?").run(bea.id);
  state.people[0].level = 'Explorer';
  await mirror.syncPeople(db, client);
});

test('syncPeople: girls gone from /people are deactivated, not deleted', async () => {
  const removed = state.people.splice(1, 1)[0]; // Blake drops off the roster
  const s = await mirror.syncPeople(db, client);
  assert.equal(s.deactivated, 1);
  const gone = db.prepare("SELECT * FROM girls WHERE last_name = 'Blake'").get();
  assert.equal(gone.active, 0); assert.equal(gone.status, 'inactive');
  state.people.splice(1, 0, removed);
  await mirror.syncPeople(db, client);
  assert.equal(db.prepare("SELECT active FROM girls WHERE last_name = 'Blake'").get().active, 1, 'reactivated on return');
});

test('refreshAttendance: snapshot replaces, adults skipped, open mirrored verbatim', async () => {
  const ev = db.prepare('SELECT * FROM events WHERE checkin_event_id = 42').get();
  let s = await mirror.refreshAttendance(db, client, ev);
  assert.deepEqual({ rows: s.rows, open: s.open }, { rows: 2, open: 1 });
  const rows = db.prepare('SELECT a.*, g.last_name FROM attendance a JOIN girls g ON g.id = a.girl_id WHERE a.event_id = ? ORDER BY g.last_name').all(ev.id);
  assert.deepEqual(rows.map((r) => [r.last_name, r.open]), [['Anders', 0], ['Blake', 1]]);
  assert.deepEqual(JSON.parse(rows[0].source_txn_ids), [9001, 9017]);
  // Blake signs out (SMS confirmation closes her row) → re-poll shows open:0
  state.attendance[42][1].signed_out_at = '2026-09-02T00:45:00.000Z';
  state.attendance[42][1].open = 0;
  state.attendance[42][1].sign_out_txn_id = 9020;
  s = await mirror.refreshAttendance(db, client, ev);
  assert.deepEqual({ rows: s.rows, open: s.open }, { rows: 2, open: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attendance WHERE event_id = ?').get(ev.id).n, 2, 'replaced, not appended');
});

// -------------------------------------------------------------- webhook ----
test('webhook: HMAC per contract — bad secret, stale timestamp, malformed all 401/400', async () => {
  assert.equal(verifySignature(SECRET, {}, '{}'), false, 'missing headers');
  assert.equal((await signedWebhook({ type: 'test', sent_at: 'x' }, { secret: 'wrong' })).status, 401);
  assert.equal((await signedWebhook({ type: 'test' }, { ts: Math.floor(Date.now() / 1000) - 301 })).status, 401);
  const r = await fetch(base + '/webhooks/checkin', { method: 'POST', body: '{}' });
  assert.equal(r.status, 401, 'unsigned');
  const ok = await signedWebhook({ type: 'test', sent_at: new Date().toISOString(), instance: { troop_id: 'XX-0000' } });
  assert.equal(ok.status, 200);
  await webhookIdle();
});

test('webhook: txn.created re-polls that event; duplicate delivery is a no-op', async () => {
  // a girl signs in at the meeting: open row appears on re-poll
  state.attendance[42].push({ person_id: 3, member_id: null, tlc_user_id: null, last_name: 'Cole', first_name: 'Dot', nickname: null, is_youth: 1, level: null, patrol: null, status: 'visitor', signed_in_at: '2026-09-01T23:10:00.000Z', signed_out_at: null, open: 1, forced: 0, permission_override: 0, sign_in_txn_id: 9021, sign_out_txn_id: null });
  const payload = { type: 'txn.created', sent_at: new Date().toISOString(), instance: { troop_id: 'XX-0000' }, txn: { id: 9021, event_id: 42, ical_uid: 'uid-meeting-1@example.com', start_at: '2026-09-01T23:00:00.000Z', direction: 'in', signed_at: '2026-09-01T23:10:00.000Z', forced: 0, voided_by_txn_id: null }, persons: [{ person_id: 3, member_id: null, tlc_user_id: null, is_youth: 1 }] };
  let r = await signedWebhook(payload);
  assert.deepEqual(await r.json(), { ok: true, duplicate: false });
  await webhookIdle();
  const ev = db.prepare('SELECT * FROM events WHERE checkin_event_id = 42').get();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attendance WHERE event_id = ?').get(ev.id).n, 3);

  const before = state.calls.length;
  r = await signedWebhook(payload); // at-least-once retry of the same txn
  assert.deepEqual(await r.json(), { ok: true, duplicate: true });
  await webhookIdle();
  assert.equal(state.calls.length, before, 'duplicate never re-polls');
  // undo for later tests
  state.attendance[42].pop();
  await mirror.refreshAttendance(db, client, ev);
});

test('webhook: ical.synced refreshes the events mirror', async () => {
  state.events.push({ id: 44, ical_uid: 'uid-campout@example.com', tlc_event_id: null, source: 'ical', title: 'Campout', location: null, start_at: '2026-09-12T21:00:00.000Z', end_at: '2026-09-13T21:00:00.000Z', all_day: 0, track_adults: 0, removed_from_feed: 0, requires_permission_form: 1 });
  const r = await signedWebhook({ type: 'ical.synced', sent_at: new Date().toISOString(), instance: { troop_id: 'XX-0000' }, counts: { added: 1, updated: 0, flagged: 0, deleted: 0, feed_events: 3 } });
  assert.equal(r.status, 200);
  await webhookIdle();
  assert.ok(db.prepare('SELECT 1 FROM events WHERE checkin_event_id = 44').get());
});

// ---------------------------------------------------------------- routes ----
test('routes: girls list + PATCH validation, mapping uniqueness, audit', async () => {
  const leaderT = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  assert.equal((await get('/api/v1/girls')).status, 401);
  const girls = await (await get('/api/v1/girls', leaderT)).json();
  assert.deepEqual(girls.map((g) => g.lastName), ['Anders', 'Blake', 'Cole']);
  assert.equal(girls[0].ahgYouthId, 'utest0000001');

  const cora = girls[1];
  assert.equal((await get(`/api/v1/girls/${cora.id}`, leaderT, { method: 'PATCH', body: '{}' })).status, 403, 'admin only');
  assert.equal((await get(`/api/v1/girls/${cora.id}`, adminT, { method: 'PATCH', body: JSON.stringify({ ahgLevel: 'Navigator' }) })).status, 400);
  assert.equal((await get(`/api/v1/girls/${cora.id}`, adminT, { method: 'PATCH', body: JSON.stringify({ ahgYouthId: 'nope' }) })).status, 400);
  assert.equal((await get(`/api/v1/girls/${cora.id}`, adminT, { method: 'PATCH', body: JSON.stringify({ ahgYouthId: 'utest0000001' }) })).status, 409, 'already mapped to Bea');
  const r = await get(`/api/v1/girls/${cora.id}`, adminT, { method: 'PATCH', body: JSON.stringify({ ahgYouthId: 'UTEST0000002' }) });
  assert.equal(r.status, 200);
  const updated = await r.json();
  assert.equal(updated.ahgYouthId, 'utest0000002', 'stored lowercase');
  assert.equal(updated.ahgYouthIdSource, 'manual');
  const audit = await (await get('/api/v1/admin/audit', adminT)).json();
  assert.equal(audit[0].action, 'girl.update');
});

test('routes: events list window + detail with attendance and empty plans', async () => {
  const leaderT = await token({ groups: [GROUP], preferred_username: 'x@example.com' });
  const all = await (await get('/api/v1/events', leaderT)).json();
  assert.equal(all.length, 3);
  const sept1 = await (await get('/api/v1/events?from=2026-09-01&to=2026-09-01', leaderT)).json();
  assert.equal(sept1.length, 1);
  assert.equal(sept1[0].title, 'Weekly Meeting');
  assert.deepEqual(sept1[0].attendance, { total: 2, open: 0 });
  assert.deepEqual(sept1[0].planLevelGroups, []);
  const detail = await (await get(`/api/v1/events/${sept1[0].id}`, leaderT)).json();
  assert.deepEqual(detail.plans, []);
  assert.deepEqual(detail.attendance.map((a) => [a.lastName, a.open]), [['Anders', false], ['Blake', false]]);
  assert.equal((await get('/api/v1/events/9999', leaderT)).status, 404);
});

test('routes: POST /sync/checkin (admin) full refresh; /sync/status; /health checkin state', async () => {
  const leaderT = await token({ groups: [GROUP], preferred_username: 'x@example.com' });
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  assert.equal((await get('/api/v1/sync/checkin', leaderT, { method: 'POST' })).status, 403);
  const r = await get('/api/v1/sync/checkin', adminT, { method: 'POST' });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.events.fetched, 3);
  assert.equal(s.people.youth, 3);
  const status = await (await get('/api/v1/sync/status', leaderT)).json();
  assert.equal(status.checkinConfigured, true);
  assert.ok(status.runs.some((x) => x.kind === 'checkin_events' && x.ok === true));
  assert.ok(status.webhookDeliveries >= 1);
  assert.equal((await (await fetch(base + '/health')).json()).checkin, 'ok');
});

// The fixture meeting is dated 2026-09-01; the default window (today −30 days)
// stopped covering it in October and this test started failing on main.
const FIXTURE_WINDOW = { from: '2026-08-01', to: '2026-12-31' };
test('syncEvents: a renamed feed entry (new ical uid) marks the old event removed and moves its plans to the same-time twin', async () => {
  // the meeting at 42 gets renamed on the calendar → a NEW uid and id; 42 vanishes from the feed
  const old = db.prepare('SELECT * FROM events WHERE checkin_event_id = 42').get();
  db.prepare("INSERT INTO plans (event_id, level_group, created_by, created_at) VALUES (?, 'Explorer', 'leader@example.com', '2026-09-01T00:00:00Z')").run(old.id);
  const renamed = { ...state.events[0], id: 99, ical_uid: 'uid-meeting-1-renamed@example.com', title: 'Service Hour Meeting' };
  const original = state.events[0];
  state.events[0] = renamed;
  const s = await mirror.syncEvents(db, client, FIXTURE_WINDOW);
  assert.deepEqual({ removed: s.removed, plansMoved: s.plansMoved, created: s.created }, { removed: 1, plansMoved: 1, created: 1 });
  const twin = db.prepare('SELECT * FROM events WHERE checkin_event_id = 99').get();
  assert.equal(db.prepare('SELECT removed_from_feed FROM events WHERE id = ?').get(old.id).removed_from_feed, 1);
  assert.equal(db.prepare('SELECT event_id FROM plans WHERE level_group = ?').get('Explorer').event_id, twin.id, 'plans followed the meeting');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'plan.move' AND actor = 'system'").get());
  // idempotent: a second sync changes nothing
  const s2 = await mirror.syncEvents(db, client, FIXTURE_WINDOW);
  assert.deepEqual({ removed: s2.removed, plansMoved: s2.plansMoved }, { removed: 0, plansMoved: 0 });
  // an absent event WITHOUT plans is just marked; a removed event with two same-time twins is left for a human
  state.events[0] = original; // restore the fixture for later tests
  db.prepare('DELETE FROM plans WHERE event_id = ?').run(twin.id);
  db.prepare('DELETE FROM events WHERE id = ?').run(twin.id);
  db.prepare('UPDATE events SET removed_from_feed = 0 WHERE id = ?').run(old.id);
  await mirror.syncEvents(db, client, FIXTURE_WINDOW);
  assert.equal(db.prepare('SELECT removed_from_feed FROM events WHERE id = ?').get(old.id).removed_from_feed, 0);
});

// 2026-10-19/20: the portal served one empty feed, then changed every UID's
// shape. The check-in app deleted its event rows and re-created them with new
// ids, so the events here holding leaders' plans were flagged removed and empty
// duplicates appeared. The portal event id inside the UID ties them together.
test('portalIdOf: both portal UID shapes; foreign UIDs are not portal events', () => {
  assert.equal(mirror.portalIdOf('ABCDEFGHI-evfakeid0001-20260720T162540'), 'evfakeid0001');
  assert.equal(mirror.portalIdOf('ABCDEFGHI-evfakeid0001@ahgfamily.org'), 'evfakeid0001');
  assert.equal(mirror.portalIdOf('uid-meeting-1@example.com'), null);
  assert.equal(mirror.portalIdOf('googlecalendar-evfakeid0001@google.com'), null);
  assert.equal(mirror.portalIdOf(null), null);
});

test('syncEvents: re-created check-in event (new id, new UID shape) folds the empty duplicate into the event holding the plans', async () => {
  const saved = state.events;
  const W = { from: '2026-11-01', to: '2026-12-31' };
  const base = { tlc_event_id: null, source: 'ical', title: 'Weekly Meeting', location: 'Hall', all_day: 0, track_adults: 0, removed_from_feed: 0, requires_permission_form: 0 };
  // as it was: a mirrored meeting with a plan on it
  state.events = [{ ...base, id: 136, ical_uid: 'ABCDEFGHI-evfakeid0002-20260720T162545', start_at: '2026-11-02T23:15:00.000Z', end_at: '2026-11-03T01:15:00.000Z' }];
  await mirror.syncEvents(db, client, W);
  const orig = db.prepare('SELECT * FROM events WHERE checkin_event_id = 136').get();
  db.prepare("INSERT INTO plans (event_id, level_group, created_by, created_at) VALUES (?, 'Pioneer', 'leader@example.com', '2026-10-01T00:00:00Z')").run(orig.id);
  // night 1: empty feed → the check-in app lists nothing; the event is marked removed
  state.events = [];
  await mirror.syncEvents(db, client, W);
  assert.equal(db.prepare('SELECT removed_from_feed FROM events WHERE id = ?').get(orig.id).removed_from_feed, 1);
  // night 2: the same portal event, re-created with a NEW check-in id and the @domain UID
  const recreated = { ...base, id: 308, ical_uid: 'ABCDEFGHI-evfakeid0002@ahgfamily.org', start_at: '2026-11-02T23:15:00.000Z', end_at: '2026-11-03T01:15:00.000Z' };
  state.events = [recreated];
  const s = await mirror.syncEvents(db, client, W);
  assert.deepEqual({ created: s.created, merged: s.merged }, { created: 0, merged: 0 }, 'matched straight to the original');
  let row = db.prepare('SELECT * FROM events WHERE id = ?').get(orig.id);
  assert.deepEqual({ ce: row.checkin_event_id, uid: row.ical_uid, gone: row.removed_from_feed }, { ce: 308, uid: recreated.ical_uid, gone: 0 });

  // the state production is ALREADY in: an empty duplicate holds the new id
  db.prepare('UPDATE events SET checkin_event_id = NULL, removed_from_feed = 1, ical_uid = ? WHERE id = ?').run('ABCDEFGHI-evfakeid0002-20260720T162545', orig.id);
  db.prepare(`INSERT INTO events (checkin_event_id, ical_uid, start_at, end_at, title, all_day, removed_from_feed, updated_at)
              VALUES (308, ?, '2026-11-02T23:15:00.000Z', '2026-11-03T01:15:00.000Z', 'Weekly Meeting', 0, 0, '2026-10-21T01:50:10Z')`).run(recreated.ical_uid);
  const s2 = await mirror.syncEvents(db, client, W);
  assert.equal(s2.merged, 1);
  row = db.prepare('SELECT * FROM events WHERE checkin_event_id = 308').get();
  assert.equal(row.id, orig.id, 'the event with the plan is current again');
  assert.equal(row.removed_from_feed, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE ical_uid LIKE ?').get('%evfakeid0002%').n, 1, 'duplicate gone');
  assert.equal(db.prepare("SELECT event_id FROM plans WHERE level_group = 'Pioneer'").get().event_id, orig.id);
  // idempotent
  const s3 = await mirror.syncEvents(db, client, W);
  assert.deepEqual({ created: s3.created, merged: s3.merged, removed: s3.removed }, { created: 0, merged: 0, removed: 0 });

  // two live check-in events sharing one portal id: never guessed between
  db.prepare("DELETE FROM plans WHERE level_group = 'Pioneer'").run();
  state.events = [recreated, { ...recreated, id: 309, start_at: '2026-11-09T23:15:00.000Z', end_at: '2026-11-10T01:15:00.000Z' }];
  const s4 = await mirror.syncEvents(db, client, W);
  assert.equal(s4.created, 1, 'the second one is its own event');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE ical_uid = ?').get(recreated.ical_uid).n, 2);
  state.events = saved;
});

test('syncEvents: check-in folds its own split back to the ORIGINAL id — the duplicate holding the new UID is folded in, no UNIQUE clash', async () => {
  const saved = state.events;
  const W = { from: '2026-11-01', to: '2026-12-31' };
  const base = { tlc_event_id: null, source: 'ical', title: 'Weekly Meeting', location: 'Hall', all_day: 0, track_adults: 0, removed_from_feed: 0, requires_permission_form: 0,
    start_at: '2026-11-16T23:15:00.000Z', end_at: '2026-11-17T01:15:00.000Z' };
  const newUid = 'ABCDEFGHI-evfakeid0003@ahgfamily.org';
  const ins = db.prepare(`INSERT INTO events (checkin_event_id, ical_uid, start_at, end_at, title, all_day, removed_from_feed, updated_at)
                          VALUES (?, ?, '2026-11-16T23:15:00.000Z', '2026-11-17T01:15:00.000Z', 'Weekly Meeting', 0, ?, '2026-10-21T01:50:10Z')`);
  const orig = ins.run(140, 'ABCDEFGHI-evfakeid0003-20260720T162550', 1).lastInsertRowid; // flagged, holds the plan
  const dup = ins.run(312, newUid, 0).lastInsertRowid;                                     // empty, holds the new uid+start
  db.prepare("INSERT INTO plans (event_id, level_group, created_by, created_at) VALUES (?, 'Patriot', 'leader@example.com', '2026-10-01T00:00:00Z')").run(orig);
  // the check-in app now lists the ORIGINAL id with the new uid; 312 no longer exists there
  state.events = [{ ...base, id: 140, ical_uid: newUid }];
  const s = await mirror.syncEvents(db, client, W);
  assert.equal(s.merged, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE id = ?').get(dup).n, 0, 'empty duplicate folded away');
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(orig);
  assert.deepEqual({ ce: row.checkin_event_id, uid: row.ical_uid, gone: row.removed_from_feed }, { ce: 140, uid: newUid, gone: 0 });
  assert.equal(db.prepare("SELECT event_id FROM plans WHERE level_group = 'Patriot'").get().event_id, orig);
  db.prepare("DELETE FROM plans WHERE level_group = 'Patriot'").run();
  state.events = saved;
});
