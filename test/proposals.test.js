'use strict';
// Build step 5: proposals from attendance (rules 3/4b/5), decide, manual
// completions, badge_status derivation (rule 1), progress views, and the
// §7 scheduler sweep. Offline; invented names/ids only.
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
const { makeCheckinClient } = require('../server/lib/checkin');
const mirror = require('../server/lib/mirror');
const { makeScheduler } = require('../server/lib/scheduler');
const { makeState, makeFakeCheckin } = require('./checkin-fixtures');
const { buildBadge } = require('../scripts/build-badges');
const example = require('../handbook/example.json');

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000002';
const GROUP = '00000000-0000-0000-0000-000000000003';
const TZ = 'America/New_York';

let keys; let jwks; let db; let server; let base; let badgesDir; let cfg;
let ev1; let ev2; let pia; let pat; let expl; // event ids / girl ids

async function token(claims = {}) {
  return new SignJWT({ scp: 'access_as_leader', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(CLIENT)
    .setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
}
const get = (p, t, init = {}) => fetch(base + p, { ...init, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), 'Content-Type': 'application/json', ...(init.headers || {}) } });

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

const addGirl = (first, last, level) => Number(db.prepare(
  'INSERT INTO girls (first_name, last_name, level, ahg_level, active, updated_at) VALUES (?, ?, ?, ?, 1, ?)',
).run(first, last, level, level, new Date().toISOString()).lastInsertRowid);
const addEvent = (checkinId, startAt, endAt, title) => Number(db.prepare(
  "INSERT INTO events (checkin_event_id, ical_uid, start_at, end_at, title, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
).run(checkinId, `uid-${title.toLowerCase().replace(/\W+/g, '-')}@example.com`, startAt, endAt, title, new Date().toISOString()).lastInsertRowid);
const setAttendance = (eventId, girlId, open) => db.prepare(
  `INSERT INTO attendance (event_id, girl_id, signed_in_at, signed_out_at, open, source_txn_ids, fetched_at)
   VALUES (?, ?, '2026-09-01T23:02:00.000Z', ?, ?, '[9001]', ?)
   ON CONFLICT(event_id, girl_id) DO UPDATE SET open = excluded.open, signed_out_at = excluded.signed_out_at`,
).run(eventId, girlId, open ? null : '2026-09-02T00:31:00.000Z', open ? 1 : 0, new Date().toISOString());
const eventRow = (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id);

test.before(async () => {
  keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] });
  badgesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-badges-'));
  fs.writeFileSync(path.join(badgesDir, 'example-badge-pipa.json'), JSON.stringify(exampleBuilt()));
  cfg = makeConfig({
    MSAL_TENANT_ID: TENANT, MSAL_CLIENT_ID: CLIENT, LEADER_GROUP_ID: GROUP, ADMIN_EMAILS: 'admin@example.com',
    DB_PATH: ':memory:', BADGES_DIR: badgesDir, TZ,
  });
  db = openDb(':memory:');
  migrate(db);
  catalog.importFromDir(db, badgesDir, { actor: 'admin@example.com' });
  pia = addGirl('Bea', 'Anders', 'Pioneer');
  pat = addGirl('Cora', 'Blake', 'Patriot');
  expl = addGirl('Dot', 'Cole', 'Explorer');
  ev1 = addEvent(42, '2026-09-01T23:00:00.000Z', '2026-09-02T00:30:00.000Z', 'Meeting One');
  ev2 = addEvent(43, '2026-09-08T23:00:00.000Z', '2026-09-09T00:30:00.000Z', 'Meeting Two');
  const app = createApp({ cfg, db, jwks });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); fs.rmSync(badgesDir, { recursive: true, force: true }); });

test('localDate: UTC instants land on the troop-local calendar day', () => {
  assert.equal(proposals.localDate('2026-09-01T23:00:00.000Z', TZ), '2026-09-01'); // 7 pm EDT
  assert.equal(proposals.localDate('2026-09-02T03:30:00.000Z', TZ), '2026-09-01'); // 11:30 pm EDT
});

test('rule 3 + 4b: session proposes, start records participation, open rows and other units never propose; idempotent', () => {
  plans.putPlan(db, eventRow(ev1), 'Pioneer/Patriot', {
    items: [
      { requirementId: 'example-badge-pipa:1', role: 'session' },
      { requirementId: 'example-badge-pipa:3', role: 'start' },
    ],
  }, 'leader@example.com');
  setAttendance(ev1, pia, false); // Pioneer, signed out → attended
  setAttendance(ev1, pat, true);  // Patriot, still open → NOT attended (rule 4b)
  setAttendance(ev1, expl, false); // Explorer, signed out, but a PiPa plan doesn't apply to her

  let s = proposals.proposeForEvent(db, eventRow(ev1), TZ);
  assert.deepEqual(s, { eventId: ev1, proposed: 1, participation: 1, withdrawn: 0, flagged: 0 });
  const c = db.prepare('SELECT * FROM completions').all();
  assert.equal(c.length, 1);
  assert.deepEqual(
    { girl: c[0].girl_id, req: c[0].requirement_id, status: c[0].status, on: c[0].completed_on, source: c[0].source },
    { girl: pia, req: 'example-badge-pipa:1', status: 'proposed', on: '2026-09-01', source: 'attendance' },
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM participation WHERE girl_id = ?').get(pia).n, 1);

  s = proposals.proposeForEvent(db, eventRow(ev1), TZ); // re-poll: nothing doubles
  assert.deepEqual(s, { eventId: ev1, proposed: 0, participation: 0, withdrawn: 0, flagged: 0 });

  // the Patriot signs out (SMS confirmation) → next poll proposes for her
  setAttendance(ev1, pat, false);
  s = proposals.proposeForEvent(db, eventRow(ev1), TZ);
  assert.deepEqual({ proposed: s.proposed, participation: s.participation }, { proposed: 1, participation: 1 });
});

test('finish proposal carries the participation count', async () => {
  const t = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  plans.putPlan(db, eventRow(ev2), 'Pioneer/Patriot', {
    items: [{ requirementId: 'example-badge-pipa:3', role: 'finish' }],
  }, 'leader@example.com');
  setAttendance(ev2, pia, false);
  proposals.proposeForEvent(db, eventRow(ev2), TZ);
  const view = await (await get(`/api/v1/events/${ev2}/proposals`, t)).json();
  assert.equal(view.girls.length, 1);
  const item = view.girls[0].items[0];
  assert.equal(item.role, 'finish');
  assert.equal(item.completedOn, '2026-09-08');
  assert.deepEqual(item.participation, { count: 1, planned: 1 }, 'present for 1 of the 1 planned session');
});

test('rule 5: un-attended girl loses proposed rows and participation; confirmed rows are flagged, never reverted', async () => {
  const t = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  // Patriot's sign-out is voided → her row re-opens; her proposal withdraws
  setAttendance(ev1, pat, true);
  let s = proposals.proposeForEvent(db, eventRow(ev1), TZ);
  assert.equal(s.withdrawn, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM completions WHERE girl_id = ?").get(pat).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM participation WHERE girl_id = ?').get(pat).n, 0);

  // Pioneer's proposal is confirmed, THEN her sign-out is voided → flag only
  const cid = db.prepare("SELECT id FROM completions WHERE girl_id = ? AND event_id = ?").get(pia, ev1).id;
  let r = await get(`/api/v1/events/${ev1}/proposals/decide`, t, { method: 'POST', body: JSON.stringify([{ completionId: cid, decision: 'confirm' }]) });
  assert.equal(r.status, 200);
  setAttendance(ev1, pia, true);
  s = proposals.proposeForEvent(db, eventRow(ev1), TZ);
  assert.deepEqual({ withdrawn: s.withdrawn, flagged: s.flagged }, { withdrawn: 0, flagged: 1 });
  const flagged = db.prepare('SELECT * FROM completions WHERE id = ?').get(cid);
  assert.equal(flagged.status, 'confirmed', 'never silently reverted');
  assert.equal(flagged.needs_review, 1);

  // the flagged row shows on the proposals screen; re-confirming clears it
  const view = await (await get(`/api/v1/events/${ev1}/proposals`, t)).json();
  assert.equal(view.girls[0].items.find((i) => i.completionId === cid).needsReview, true);
  r = await get(`/api/v1/events/${ev1}/proposals/decide`, t, { method: 'POST', body: JSON.stringify([{ completionId: cid, decision: 'confirm' }]) });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT needs_review FROM completions WHERE id = ?').get(cid).needs_review, 0);
  setAttendance(ev1, pia, false); // restore
  proposals.proposeForEvent(db, eventRow(ev1), TZ);
});

test('decide: rule 9 level stamp, completedOn override, double-decide 409, all-or-nothing', async () => {
  const t = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  const confirmed = db.prepare("SELECT * FROM completions WHERE girl_id = ? AND requirement_id = 'example-badge-pipa:1'").get(pia);
  assert.equal(confirmed.level_at_completion, 'Pioneer', 'girl was a Pioneer when confirmed');
  assert.equal(confirmed.decided_by, 'leader@example.com');

  // Patriot re-attends → her proposal returns; confirm with a corrected date
  setAttendance(ev1, pat, false);
  proposals.proposeForEvent(db, eventRow(ev1), TZ);
  const pc = db.prepare("SELECT * FROM completions WHERE girl_id = ? AND status = 'proposed'").get(pat);
  let r = await get(`/api/v1/events/${ev1}/proposals/decide`, t, { method: 'POST', body: JSON.stringify([{ completionId: pc.id, decision: 'confirm', completedOn: '2026-08-30' }]) });
  assert.equal(r.status, 200);
  const after = db.prepare('SELECT * FROM completions WHERE id = ?').get(pc.id);
  assert.equal(after.completed_on, '2026-08-30');
  assert.equal(after.level_at_completion, 'Patriot');

  r = await get(`/api/v1/events/${ev1}/proposals/decide`, t, { method: 'POST', body: JSON.stringify([{ completionId: pc.id, decision: 'reject' }]) });
  assert.equal(r.status, 409, 'already confirmed (and not flagged) — not decidable');

  // all-or-nothing: a bad id in the batch rolls the whole batch back
  const finishRow = db.prepare("SELECT * FROM completions WHERE girl_id = ? AND event_id = ?").get(pia, ev2);
  r = await get(`/api/v1/events/${ev2}/proposals/decide`, t, { method: 'POST', body: JSON.stringify([{ completionId: finishRow.id, decision: 'confirm' }, { completionId: 999999, decision: 'confirm' }]) });
  assert.equal(r.status, 404);
  assert.equal(db.prepare('SELECT status FROM completions WHERE id = ?').get(finishRow.id).status, 'proposed', 'rolled back');
  // …and reject works on its own
  r = await get(`/api/v1/events/${ev2}/proposals/decide`, t, { method: 'POST', body: JSON.stringify([{ completionId: finishRow.id, decision: 'reject' }]) });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT status FROM completions WHERE id = ?').get(finishRow.id).status, 'rejected');
});

test('manual completions: created confirmed, duplicate 409, delete guarded by pushed state', async () => {
  const t = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  let r = await get('/api/v1/completions', t, { method: 'POST', body: JSON.stringify({ girlId: expl, requirementId: 'example-badge-pipa:2', completedOn: '2026-09-03' }) });
  assert.equal(r.status, 201);
  const c = await r.json();
  assert.deepEqual({ status: c.status, source: c.source, level: c.levelAtCompletion }, { status: 'confirmed', source: 'manual', level: 'Explorer' });
  assert.equal((await get('/api/v1/completions', t, { method: 'POST', body: JSON.stringify({ girlId: expl, requirementId: 'example-badge-pipa:2', completedOn: '2026-09-04' }) })).status, 409);
  assert.equal((await get('/api/v1/completions', t, { method: 'POST', body: JSON.stringify({ girlId: expl, requirementId: 'example-badge-pipa:1', completedOn: 'soon' }) })).status, 400);

  // pushed → refuse to delete (unmark queueing is step 7)
  db.prepare("INSERT INTO push_queue (girl_id, requirement_id, completion_id, action, status, created_at, sent_at) VALUES (?, 'example-badge-pipa:2', ?, 'mark', 'sent', ?, ?)")
    .run(expl, c.id, new Date().toISOString(), new Date().toISOString());
  assert.equal((await get(`/api/v1/completions/${c.id}`, t, { method: 'DELETE' })).status, 409);
  db.prepare('DELETE FROM push_queue WHERE completion_id = ?').run(c.id);
  assert.equal((await get(`/api/v1/completions/${c.id}`, t, { method: 'DELETE' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM completions WHERE id = ?').get(c.id).n, 0);
});

test('rule 1: badge_status derived from group rules; progress views', async () => {
  const t = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  // Bea (Pioneer) has :1 confirmed → in_progress
  let p = await (await get(`/api/v1/girls/${pia}/progress`, t)).json();
  assert.equal(p.girl.firstName, 'Bea');
  assert.equal(p.badges.length, 1);
  assert.deepEqual({ status: p.badges[0].status, confirmed: p.badges[0].confirmedCount }, { status: 'in_progress', confirmed: 1 });
  assert.equal(p.badges[0].eligible, true, 'a Pioneer/Patriot badge is earnable by a Pioneer');
  const ex = await (await get(`/api/v1/girls/${expl}/progress`, t)).json();
  assert.equal(ex.badges[0].eligible, false, 'an Explorer cannot earn a Pioneer/Patriot badge — the UI hides it unless she has activity on it');
  const flat = p.badges[0].groups.flatMap((g) => g.requirements);
  assert.equal(flat.find((x) => x.requirementId === 'example-badge-pipa:1').state, 'confirmed');
  assert.equal(flat.find((x) => x.requirementId === 'example-badge-pipa:4').state, 'none');

  // complete the all-group (:2) and one of the n_of group (:3) → complete
  proposals.manualCompletion(db, { girlId: pia, requirementId: 'example-badge-pipa:2', completedOn: '2026-09-05' }, 'leader@example.com');
  proposals.manualCompletion(db, { girlId: pia, requirementId: 'example-badge-pipa:3', completedOn: '2026-09-05' }, 'leader@example.com');
  p = await (await get(`/api/v1/girls/${pia}/progress`, t)).json();
  assert.equal(p.badges[0].status, 'complete', 'all-group full + n_of at threshold');

  const bp = await (await get('/api/v1/badges/example-badge-pipa/progress', t)).json();
  assert.equal(bp.requirements.length, 4);
  const rows = new Map(bp.girls.map((g) => [g.girlId, g]));
  assert.equal(rows.get(pia).status, 'complete');
  assert.equal(rows.get(expl).status, 'not_started');
  assert.equal(rows.get(pat).status, 'in_progress');
  assert.equal(rows.get(pat).states['example-badge-pipa:1'].state, 'confirmed');
  assert.deepEqual(await (await get(`/api/v1/girls/${pia}/progress?levelGroup=Explorer`, t)).json().then((x) => x.badges), [], 'level filter');
});

test('scheduler: nightly/weekly cadence and the 30-min attendance sweep that stops when closed', async () => {
  const state = makeState();
  const nowMs = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  // one event that ended an hour ago, one still running
  state.events = [
    { id: 42, ical_uid: 'uid-sweep-1@example.com', tlc_event_id: null, source: 'ical', title: 'Swept Meeting', location: null, start_at: iso(nowMs - 3 * 3600e3), end_at: iso(nowMs - 3600e3), all_day: 0, track_adults: 0, removed_from_feed: 0, requires_permission_form: 0 },
    { id: 43, ical_uid: 'uid-sweep-2@example.com', tlc_event_id: null, source: 'ical', title: 'Running Meeting', location: null, start_at: iso(nowMs - 3600e3), end_at: iso(nowMs + 3600e3), all_day: 0, track_adults: 0, removed_from_feed: 0, requires_permission_form: 0 },
  ];
  state.attendance = { 42: [state.attendance[42][0]], 43: [] }; // one closed row (Bea)
  const sdb = openDb(':memory:');
  migrate(sdb);
  catalog.importFromDir(sdb, badgesDir, { actor: 'admin@example.com' });
  const client = makeCheckinClient({ base: 'http://127.0.0.1:59999', apiKey: 'tci_test-key' }, { fetchImpl: makeFakeCheckin(state) });
  const sched = makeScheduler({ cfg, db: sdb, client, log: () => {} });

  let out = await sched.tick(nowMs);
  assert.ok(out.events && out.people, 'first tick syncs both');
  assert.equal(out.attendance.length, 1, 'only the ended event is swept');
  assert.equal(out.attendance[0].rows, 1);

  out = await sched.tick(nowMs + 60e3);
  assert.equal(out.events, undefined, 'nightly cadence: not again within 24h');
  assert.equal(out.attendance, undefined, 'no open rows → the sweep stopped');

  // a late sign-in arrives AFTER the sweep stopped: only the webhook path
  // re-polls (mirror.refreshAttendance here stands in for it) — and its open
  // row makes the sweep resume until the event is fully closed again
  state.attendance[42].push({ ...state.attendance[42][0], person_id: 2, member_id: '0000002', tlc_user_id: null, last_name: 'Blake', first_name: 'Cora', nickname: 'Cee', level: 'Pioneer', signed_out_at: null, open: 1, sign_out_txn_id: null });
  const evRow = sdb.prepare('SELECT * FROM events WHERE checkin_event_id = 42').get();
  await mirror.refreshAttendance(sdb, client, evRow);
  out = await sched.tick(nowMs + 180e3);
  assert.equal(out.attendance.length, 1, 'sweeping again while a row is open');
  state.attendance[42][1].open = 0;
  state.attendance[42][1].signed_out_at = iso(nowMs - 1800e3);
  await sched.tick(nowMs + 240e3); // fetches the now-closed roster
  out = await sched.tick(nowMs + 300e3);
  assert.equal(out.attendance, undefined, 'closed again → quiet');
  sdb.close();
});
