'use strict';
// Plans saved AFTER the meeting (2026-10-11). Proposals used to come only
// from the check-in webhook, the 7-day sweep and "Sync check-in now" (14
// days), so a plan added or fixed for a meeting that had already happened
// proposed nothing — the girls who attended never reached the Review page.
// Now saving (or moving) a plan for a started event proposes at once.
// Offline; invented names/ids only.
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
const plans = require('../server/lib/plans');
const proposals = require('../server/lib/proposals');
const { buildBadge } = require('../scripts/build-badges');
const example = require('../handbook/example.json');

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000002';
const GROUP = '00000000-0000-0000-0000-000000000003';
const TZ = 'America/New_York';
const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString();

let keys; let jwks; let db; let server; let base; let badgesDir;
let bea; let cora; // girls

async function token() {
  return new SignJWT({ scp: 'access_as_leader', groups: [GROUP], preferred_username: 'leader@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(CLIENT)
    .setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
}
const call = async (method, p, body) => fetch(base + '/api/v1' + p, {
  method, headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

function exampleBuilt() {
  const cat = {
    awardId: 'aw0000example', name: 'Example Badge', levelGroup: 'Pioneer/Patriot', retired: false, wholeAwardOnly: false, imageSlug: 'example', source: { fetchedAt: '2026-09-07T00:00:00Z' },
    groups: [
      { label: 'Complete All', rule: { type: 'all' }, edition: 'current', plannable: true, items: [{ id: 'r00000test01', number: 1, title: 'First' }, { id: 'r00000test02', number: 2, title: 'Second' }] },
      { label: 'Complete One', rule: { type: 'n_of', n: 1 }, edition: 'current', plannable: true, items: [{ id: 'r00000test03', number: 3, title: 'Third' }, { id: 'r00000test04', number: 4, title: 'Fourth' }] },
    ],
  };
  return buildBadge(example, cat, { annotationFile: 'example.json' }).badge;
}

const addGirl = (first, last, level) => Number(db.prepare(
  'INSERT INTO girls (first_name, last_name, level, ahg_level, active, updated_at) VALUES (?, ?, ?, ?, 1, ?)',
).run(first, last, level, level, iso(Date.now())).lastInsertRowid);
let evN = 500;
const addEvent = (startMs, title) => {
  evN += 1;
  return Number(db.prepare(
    'INSERT INTO events (checkin_event_id, ical_uid, start_at, end_at, title, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(evN, `uid-${evN}@example.com`, iso(startMs), iso(startMs + 90 * 60e3), title, iso(Date.now())).lastInsertRowid);
};
const attended = (eventId, girlId) => db.prepare(
  `INSERT INTO attendance (event_id, girl_id, signed_in_at, signed_out_at, open, source_txn_ids, fetched_at)
   VALUES (?, ?, 'x', 'y', 0, '[1]', ?) ON CONFLICT(event_id, girl_id) DO UPDATE SET open = 0`,
).run(eventId, girlId, iso(Date.now()));
const eventRow = (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id);
const liveFor = (girlId, req) => db.prepare("SELECT * FROM completions WHERE girl_id = ? AND requirement_id = ? AND status <> 'rejected'").get(girlId, req);

test.before(async () => {
  keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] });
  badgesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planprop-badges-'));
  fs.writeFileSync(path.join(badgesDir, 'example-badge-pipa.json'), JSON.stringify(exampleBuilt()));
  const cfg = makeConfig({
    MSAL_TENANT_ID: TENANT, MSAL_CLIENT_ID: CLIENT, LEADER_GROUP_ID: GROUP, ADMIN_EMAILS: 'admin@example.com',
    DB_PATH: ':memory:', BADGES_DIR: badgesDir, TZ,
  });
  db = openDb(':memory:');
  migrate(db);
  catalog.importFromDir(db, badgesDir, { actor: 'admin@example.com' });
  bea = addGirl('Bea', 'Anders', 'Pioneer');
  cora = addGirl('Cora', 'Blake', 'Patriot');
  // no check-in configured here: the mirrored attendance is what counts
  const app = createApp({ cfg, db, jwks });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); fs.rmSync(badgesDir, { recursive: true, force: true }); });

test('a plan added a month after the meeting proposes for the girls who attended — and they reach the Review page', async () => {
  const old = addEvent(Date.now() - 30 * DAY, 'Long-Ago Meeting'); // well past the 7- and 14-day windows
  attended(old, bea); // Cora did not come
  const r = await call('PUT', `/events/${old}/plans/Pioneer%2FPatriot`, {
    items: [{ requirementId: 'example-badge-pipa:1', role: 'finish' }, { requirementId: 'example-badge-pipa:3', role: 'start' }],
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.proposals.proposed, 1, 'Bea, for the finish item');
  assert.equal(body.proposals.participation, 1, 'and her start item counts as a session');
  assert.equal(liveFor(bea, 'example-badge-pipa:1').status, 'proposed');
  assert.equal(liveFor(cora, 'example-badge-pipa:1'), undefined, 'not for a girl who was not there');
  const review = await (await call('GET', '/review')).json();
  assert.ok(JSON.stringify(review).includes('example-badge-pipa:1'), 'it is waiting on the Review page');
  // saving the same plan again changes nothing
  const again = await (await call('PUT', `/events/${old}/plans/Pioneer%2FPatriot`, {
    items: [{ requirementId: 'example-badge-pipa:1', role: 'finish' }, { requirementId: 'example-badge-pipa:3', role: 'start' }],
  })).json();
  assert.equal(again.proposals.proposed, 0);
});

test('a plan for a meeting that has not happened yet proposes nothing', async () => {
  const next = addEvent(Date.now() + 7 * DAY, 'Next Week');
  const body = await (await call('PUT', `/events/${next}/plans/Pioneer%2FPatriot`, {
    items: [{ requirementId: 'example-badge-pipa:2', role: 'finish' }],
  })).json();
  assert.deepEqual(body.proposals, { skipped: 'event has not started' });
});

test('re-planning a finish as a start: a proposed row is withdrawn, a confirmed one is flagged (never reverted)', async () => {
  const ev = addEvent(Date.now() - 3 * DAY, 'Replanned Meeting');
  attended(ev, bea); attended(ev, cora);
  await call('PUT', `/events/${ev}/plans/Pioneer%2FPatriot`, { items: [{ requirementId: 'example-badge-pipa:4', role: 'finish' }] });
  const beaRow = liveFor(bea, 'example-badge-pipa:4');
  const coraRow = liveFor(cora, 'example-badge-pipa:4');
  assert.equal(beaRow.status, 'proposed');
  proposals.decideRows(db, [{ completionId: coraRow.id, decision: 'confirm' }], 'leader@example.com', { tz: TZ });
  assert.equal(liveFor(cora, 'example-badge-pipa:4').status, 'confirmed');

  const body = await (await call('PUT', `/events/${ev}/plans/Pioneer%2FPatriot`, { items: [{ requirementId: 'example-badge-pipa:4', role: 'start' }] })).json();
  assert.equal(body.proposals.withdrawn, 1);
  assert.equal(body.proposals.flagged, 1);
  assert.equal(liveFor(bea, 'example-badge-pipa:4'), undefined, 'the unreviewed proposal is gone');
  const cr = liveFor(cora, 'example-badge-pipa:4');
  assert.equal(cr.status, 'confirmed', 'a confirmed completion is never silently undone');
  assert.equal(cr.needs_review, 1);
  assert.match(cr.review_reason, /plan changed after confirmation/);
});

test('attendance is refreshed from check-in first; if that fails, the mirror is used and the response says so', async () => {
  const ev = addEvent(Date.now() - 20 * DAY, 'Refresh Meeting');
  plans.putPlan(db, eventRow(ev), 'Pioneer/Patriot', { items: [{ requirementId: 'example-badge-pipa:2', role: 'session' }] }, 'leader@example.com');
  // check-in knows Bea attended; the mirror did not yet
  let refreshed = 0;
  const s = await proposals.proposeAfterPlanChange(db, { configured: true }, eventRow(ev), TZ, {
    refresh: async (d, c, e) => { refreshed += 1; attended(e.id, bea); },
  });
  assert.equal(refreshed, 1);
  assert.equal(s.proposed, 1);
  assert.equal(s.warning, undefined);
  // check-in unreachable: proposals still run on the mirrored attendance, with a warning
  attended(ev, cora);
  const s2 = await proposals.proposeAfterPlanChange(db, { configured: true }, eventRow(ev), TZ, {
    refresh: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(s2.proposed, 1, 'Cora, from the mirror');
  assert.match(s2.warning, /attendance not refreshed from check-in \(ECONNREFUSED\)/);
});

test('moving plans onto a meeting that already happened proposes there', async () => {
  const from = addEvent(Date.now() + 14 * DAY, 'Wrong Calendar Entry');
  const to = addEvent(Date.now() - 2 * DAY, 'Right Calendar Entry');
  plans.putPlan(db, eventRow(from), 'Pioneer/Patriot', { items: [{ requirementId: 'example-badge-pipa:2', role: 'finish' }] }, 'leader@example.com');
  db.prepare("DELETE FROM completions WHERE requirement_id = 'example-badge-pipa:2'").run(); // clean slate for this item
  attended(to, cora);
  const body = await (await call('POST', `/events/${from}/plans/move`, { toEventId: to })).json();
  assert.deepEqual(body.moved, ['Pioneer/Patriot']);
  assert.equal(body.proposals.proposed, 1);
  assert.equal(liveFor(cora, 'example-badge-pipa:2').event_id, to);
});
