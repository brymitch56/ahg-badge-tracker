'use strict';
// Service Stars step 7 — the push to AHGFamily (server/lib/servicepush.js).
// Entirely offline: the AHGFamily session is an injected fixture with an
// in-memory Standard-form state that the fake `save` mutates, so read-back
// is real. Invented ids only; nothing touches a network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { makeConfig } = require('../server/config');
const { openDb, migrate } = require('../server/db');
const { createApp } = require('../server/app');
const A = require('../lib/ahgfamily');
const stars = require('../lib/stars');
const servicepush = require('../server/lib/servicepush');

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000002';
const GROUP = '00000000-0000-0000-0000-000000000003';
const KEY = Buffer.from('ab'.repeat(32), 'hex');
const Y_BEA = 'utest0000001';
const AWARD = stars.STAR_AWARD_IDS.Pioneer;

let keys; let jwks; let db; let cfg; let server; let base; let bea;

async function token(claims = {}) {
  return new SignJWT({ scp: 'access_as_leader', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(CLIENT)
    .setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
}
const get = (p, t, init = {}) => fetch(base + p, { ...init, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), 'Content-Type': 'application/json', ...(init.headers || {}) } });
const adminT = () => token({ groups: [GROUP], preferred_username: 'admin@example.com' });

// ---- fake AHGFamily Standard form, with state the save mutates -----------
const savedPanel = (p) => `<div class="panel">
  <input type="text" name="completed_on-${p.adId}" value="${p.completedOn || ''}">
  <input type="text" name="awarded_on-${p.adId}" value="${p.awardedOn || ''}">
  <input type="text" name="purchased-${p.adId}" value="${p.purchased ? '1' : ''}">
  <textarea name="comment-${p.adId}">${p.comment || ''}</textarea></div>`;
const blankPanel = (adId) => `<div class="panel">
  <input type="hidden" name="new-${adId}" value="true">
  <input type="text" name="completed_on-${adId}" value="">
  <input type="text" name="awarded_on-${adId}" value="">
  <input type="text" name="purchased-${adId}" value="">
  <textarea name="comment-${adId}"></textarea></div>`;

// mutable scenario
const scenario = { saved: [], fetches: 0, saves: 0, closed: 0, swallowSave: false, corruptOnSave: false, authFail: false };
const outerPage = () => `<html><head><meta name="csrf-token" content="tok"></head><body>
  <form id="form-advancement" action="/advancement/index?level=all&style=standard" method="post">
    <input type="hidden" name="_csrf" value="tok">
    <input type="radio" name="style-select" value="standard" checked><input type="radio" name="style-select" value="grid">
    <input type="radio" name="level-select" value="all" checked>
    <input type="text" name="date-specified" value="09/12/2026">
    <input type="text" name="lock-checked" value="1">
    <input type="text" name="show-completed-checked" value="0">
    <input type="text" name="comment-specified" value="">
  </form></body></html>`;

const fakeSessionFactory = async () => {
  if (scenario.authFail) throw new A.FetchError(A.EXIT.AUTH, 'Login rejected (fake).');
  return {
    async standard() {
      scenario.fetches += 1;
      // blank slot ids CHANGE every fetch, like the live site
      const blanks = [0, 1, 2].map((i) => `adbl${String(scenario.fetches).padStart(4, '0')}${i}${'z'.repeat(4)}`.slice(0, 12));
      return `<form>${scenario.saved.map(savedPanel).join('')}${blanks.map(blankPanel).join('')}</form>`;
    },
    async page() { return outerPage(); },
    async save(bodyPairs) {
      scenario.saves += 1;
      if (scenario.swallowSave) return { status: 200, html: outerPage() };
      const byName = new Map(bodyPairs);
      const slot = bodyPairs.find(([n, v]) => /^new-ad/.test(n) && v === 'true');
      if (slot) {
        const adId = slot[0].slice('new-'.length);
        scenario.saved.push({
          adId: `adsv${String(scenario.saves).padStart(4, '0')}${'q'.repeat(4)}`.slice(0, 12),
          completedOn: byName.get(`completed_on-${adId}`) || '',
          awardedOn: '', purchased: false, comment: byName.get(`comment-${adId}`) || '',
        });
      }
      if (scenario.corruptOnSave && scenario.saved.length) scenario.saved[0].completedOn = '01/01/2000';
      return { status: 302, location: '/advancement/index?level=all&style=standard', html: outerPage() };
    },
    async close() { scenario.closed += 1; },
  };
};

test.before(async () => {
  keys = await generateKeyPair('RS256');
  jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'test', alg: 'RS256', use: 'sig' }] });
  cfg = makeConfig({ MSAL_TENANT_ID: TENANT, MSAL_CLIENT_ID: CLIENT, LEADER_GROUP_ID: GROUP, ADMIN_EMAILS: 'admin@example.com', DB_PATH: ':memory:', CRED_KEY: KEY.toString('hex'), TZ: 'UTC' });
  db = openDb(':memory:');
  migrate(db);
  bea = Number(db.prepare("INSERT INTO girls (first_name, last_name, ahg_level, ahg_youth_id, ahg_youth_id_source, active, updated_at) VALUES ('Bea','Anders','Pioneer',?,?,1,?)")
    .run(Y_BEA, 'manual', new Date().toISOString()).lastInsertRowid);
  // stored credentials so the push is not short-circuited as "noconfig"
  require('../server/lib/mapping').storeCredentials(db, { email: 'x@example.com', password: 'fake-password-never-real' }, 'admin@example.com', KEY);
  const app = createApp({ cfg, db, jwks, ahgSessionFactory: fakeSessionFactory });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

const queueRow = (date, { comment = 'tracker: 15.00h Pioneer, confirmed 2026-09-01', level = 'Pioneer' } = {}) => Number(db.prepare(
  "INSERT INTO push_queue (girl_id, action, date, created_at, ahg_award_id, detail) VALUES (?, 'add_instance', ?, ?, ?, ?)",
).run(bea, date, new Date().toISOString(), AWARD, JSON.stringify({ level, comment })).lastInsertRowid);
const rowStatus = (id) => db.prepare('SELECT status, last_error FROM push_queue WHERE id = ?').get(id);
const resetScenario = (over = {}) => Object.assign(scenario, { saved: [], fetches: 0, saves: 0, closed: 0, swallowSave: false, corruptOnSave: false, authFail: false }, over);

test('unit: toFormDate accepts a real past date, rejects junk and the future', () => {
  assert.equal(servicepush.toFormDate('2026-09-01', 'UTC'), '09/01/2026');
  assert.equal(servicepush.toFormDate('2026-13-40', 'UTC'), null);
  assert.equal(servicepush.toFormDate('2026-02-30', 'UTC'), null); // not a real calendar day
  assert.equal(servicepush.toFormDate('2999-01-01', 'UTC'), null); // future
  assert.equal(servicepush.toFormDate('', 'UTC'), null);
});

test('push is OFF by default: the route is a no-op and nothing is sent', async () => {
  resetScenario();
  const id = queueRow('2026-09-01');
  const r = await (await get('/api/v1/sync/push', await adminT(), { method: 'POST' })).json();
  assert.deepEqual({ skipped: r.skipped, pushed: r.pushed }, { skipped: 'push disabled', pushed: 0 });
  assert.equal(scenario.saves, 0);
  assert.equal(rowStatus(id).status, 'queued');
  db.prepare('DELETE FROM push_queue WHERE id = ?').run(id);
});

test('enabling requires admin; a leader cannot flip the flag', async () => {
  const leaderT = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  assert.equal((await get('/api/v1/admin/push-enabled', leaderT, { method: 'POST', body: JSON.stringify({ enabled: true }) })).status, 403);
  const r = await (await get('/api/v1/admin/push-enabled', await adminT(), { method: 'POST', body: JSON.stringify({ enabled: true }) })).json();
  assert.equal(r.pushEnabled, true);
  assert.equal((await (await get('/api/v1/sync/status', leaderT)).json()).pushEnabled, true);
});

test('happy path: reads fresh, writes once, proves +1 by read-back, marks sent; pre-existing untouched', async () => {
  resetScenario({ saved: [{ adId: 'adold00000aa', completedOn: '03/23/2026', awardedOn: '05/26/2026', purchased: true, comment: '' }] });
  const id = queueRow('2026-09-01');
  const r = await (await get('/api/v1/sync/push', await adminT(), { method: 'POST' })).json();
  assert.deepEqual({ pushed: r.pushed, held: r.held, failed: r.failed }, { pushed: 1, held: 0, failed: 0 });
  assert.equal(scenario.saves, 1, 'exactly one write');
  assert.equal(scenario.fetches >= 2, true, 'read before and read back');
  assert.equal(scenario.closed, 1, 'logout after the run');
  assert.equal(rowStatus(id).status, 'sent');
  // the original instance is still present and unchanged; a new one was added
  assert.equal(scenario.saved.length, 2);
  assert.deepEqual(scenario.saved[0], { adId: 'adold00000aa', completedOn: '03/23/2026', awardedOn: '05/26/2026', purchased: true, comment: '' });
  assert.equal(scenario.saved[1].completedOn, '09/01/2026');
  db.prepare('DELETE FROM push_queue WHERE id = ?').run(id);
});

test('an invalid/future queued date is HELD before any write', async () => {
  resetScenario();
  const bad = queueRow('2026-02-30');
  const future = queueRow('2999-01-01');
  const r = await (await get('/api/v1/sync/push', await adminT(), { method: 'POST' })).json();
  assert.deepEqual({ pushed: r.pushed, held: r.held }, { pushed: 0, held: 2 });
  assert.equal(scenario.saves, 0, 'never reached the write');
  assert.match(rowStatus(bad).last_error, /invalid or future/);
  assert.match(rowStatus(future).last_error, /invalid or future/);
  db.prepare('DELETE FROM push_queue WHERE id IN (?, ?)').run(bad, future);
});

test('a save that does not take is HELD for review, never retried or marked sent', async () => {
  resetScenario({ swallowSave: true });
  const id = queueRow('2026-09-01');
  const r = await (await get('/api/v1/sync/push', await adminT(), { method: 'POST' })).json();
  assert.deepEqual({ pushed: r.pushed, held: r.held }, { pushed: 0, held: 1 });
  assert.equal(scenario.saves, 1);
  assert.equal(rowStatus(id).status, 'held');
  assert.match(rowStatus(id).last_error, /save not confirmed/);
  db.prepare('DELETE FROM push_queue WHERE id = ?').run(id);
});

test('a save that disturbs a pre-existing instance is HELD, not accepted', async () => {
  resetScenario({ saved: [{ adId: 'adold00000aa', completedOn: '03/23/2026', awardedOn: '', purchased: false, comment: '' }], corruptOnSave: true });
  const id = queueRow('2026-09-01');
  const r = await (await get('/api/v1/sync/push', await adminT(), { method: 'POST' })).json();
  assert.deepEqual({ pushed: r.pushed, held: r.held }, { pushed: 0, held: 1 });
  assert.match(rowStatus(id).last_error, /pre-existing instance changed|save not confirmed/);
  db.prepare('DELETE FROM push_queue WHERE id = ?').run(id);
});

test('an unmapped or inactive girl is HELD, not pushed', async () => {
  resetScenario();
  const ghost = Number(db.prepare("INSERT INTO girls (first_name, last_name, ahg_level, active, updated_at) VALUES ('No','Map','Pioneer',1,?)").run(new Date().toISOString()).lastInsertRowid);
  const id = Number(db.prepare("INSERT INTO push_queue (girl_id, action, date, created_at, ahg_award_id, detail) VALUES (?, 'add_instance', '2026-09-01', ?, ?, '{}')").run(ghost, new Date().toISOString(), AWARD).lastInsertRowid);
  const r = await (await get('/api/v1/sync/push', await adminT(), { method: 'POST' })).json();
  assert.equal(r.held, 1);
  assert.equal(scenario.saves, 0);
  assert.match(rowStatus(id).last_error, /not active \/ not mapped/);
  db.prepare('DELETE FROM push_queue WHERE id = ?').run(id);
});

test('rule 8: an auth failure at login latches everything and writes nothing', async () => {
  resetScenario({ authFail: true });
  const id = queueRow('2026-09-01');
  const r = await get('/api/v1/sync/push', await adminT(), { method: 'POST' });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /latched/);
  assert.equal(rowStatus(id).status, 'queued', 'untouched — the run never started writing');
  require('../server/lib/mapping').clearLatch(db);
  db.prepare('DELETE FROM push_queue WHERE id = ?').run(id);
});

// ---------------------------------------------------------------------------
// Requirement marks with notes (pushRequirementMarks) — own database with the
// example catalog; the fake Standard form carries per-requirement
// checkbox-/date-/comment- fields that the fake save mutates.
const fs = require('fs');
const os = require('os');
const path = require('path');
const catalog = require('../server/lib/catalog');
const plans = require('../server/lib/plans');
const proposals = require('../server/lib/proposals');
const { buildBadge } = require('../scripts/build-badges');
const example = require('../handbook/example.json');
const { makeScheduler } = require('../server/lib/scheduler');
const { makeCheckinClient } = require('../server/lib/checkin');
const reportLib = require('../server/lib/report');

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

const freshItems = () => ({ r00000test01: { checked: false, date: '', comment: '' }, r00000test02: { checked: true, date: '08/01/2026', comment: 'hand-entered' }, r00000test03: { checked: false, date: '', comment: '' }, r00000test04: { checked: false, date: '', comment: '' } });
const req = { items: freshItems(), saves: 0, fetches: 0, swallow: false, corrupt: false, bodies: [] };
const resetReq = () => Object.assign(req, { items: freshItems(), saves: 0, fetches: 0, swallow: false, corrupt: false, bodies: [] });
const reqPanel = (id, it) => `<div><input type="checkbox" name="checkbox-${id}" value="1"${it.checked ? ' checked' : ''}><input type="text" name="date-${id}" value="${it.date}"><textarea name="comment-${id}">${it.comment}</textarea></div>`;
const reqSessionFactory = async () => ({
  async standard(awardId) {
    req.fetches += 1;
    if (awardId !== 'aw0000example') return '<form></form>';
    return `<form>${Object.entries(req.items).map(([id, it]) => reqPanel(id, it)).join('')}${blankPanel(`adbl${String(req.fetches).padStart(8, '0')}`.slice(0, 12))}</form>`;
  },
  async page() { return outerPage(); },
  async save(bodyPairs) {
    req.saves += 1; req.bodies.push(bodyPairs);
    if (req.swallow) return { status: 200, html: '' };
    const byName = new Map(bodyPairs);
    for (const id of Object.keys(req.items)) {
      req.items[id] = { checked: byName.has(`checkbox-${id}`), date: byName.get(`date-${id}`) || '', comment: byName.get(`comment-${id}`) || '' };
    }
    if (req.corrupt) req.items.r00000test02.date = '01/01/2000';
    return { status: 302, html: '' };
  },
  async close() {},
});

let rdb; let rcfg; let rbase; let rserver; let rgirl; let rEv1; let rEv2; let badgesDir;
const rget = async (p, init = {}) => fetch(rbase + p, { ...init, headers: { Authorization: `Bearer ${await adminT()}`, 'Content-Type': 'application/json' } });
const queueMark = () => Number(rdb.prepare("SELECT id FROM push_queue WHERE action = 'mark' AND status = 'queued' ORDER BY id DESC LIMIT 1").get().id);
const enqueueMark = (completionId) => rdb.prepare("INSERT INTO push_queue (girl_id, requirement_id, badge_id, completion_id, action, date, created_at) VALUES (?, 'example-badge-pipa:1', 'example-badge-pipa', ?, 'mark', '2026-09-08', ?)").run(rgirl, completionId, new Date().toISOString());
const eventRow2 = (id) => rdb.prepare('SELECT * FROM events WHERE id = ?').get(id);

let reqReady = null;
async function setupReq() {
  if (reqReady) return reqReady;
  reqReady = (async () => {
  badgesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-badges-'));
  fs.writeFileSync(path.join(badgesDir, 'example-badge-pipa.json'), JSON.stringify(exampleBuilt()));
  rcfg = makeConfig({ MSAL_TENANT_ID: TENANT, MSAL_CLIENT_ID: CLIENT, LEADER_GROUP_ID: GROUP, ADMIN_EMAILS: 'admin@example.com', DB_PATH: ':memory:', BADGES_DIR: badgesDir, CRED_KEY: KEY.toString('hex'), TZ: 'America/New_York' });
  rdb = openDb(':memory:');
  migrate(rdb);
  catalog.importFromDir(rdb, badgesDir, { actor: 'admin@example.com' });
  rgirl = Number(rdb.prepare("INSERT INTO girls (first_name, last_name, ahg_level, ahg_youth_id, ahg_youth_id_source, active, updated_at) VALUES ('Bea','Anders','Pioneer',?,?,1,?)").run(Y_BEA, 'manual', new Date().toISOString()).lastInsertRowid);
  require('../server/lib/mapping').storeCredentials(rdb, { email: 'x@example.com', password: 'fake-password-never-real' }, 'admin@example.com', KEY);
  const ev = (id, s, e, t) => Number(rdb.prepare("INSERT INTO events (checkin_event_id, ical_uid, start_at, end_at, title, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `uid-${id}@example.com`, s, e, t, new Date().toISOString()).lastInsertRowid);
  rEv1 = ev(1, '2026-09-01T23:00:00.000Z', '2026-09-02T00:30:00.000Z', 'Meeting One');
  rEv2 = ev(2, '2026-09-08T23:00:00.000Z', '2026-09-09T00:30:00.000Z', 'Meeting Two');
  const app = createApp({ cfg: rcfg, db: rdb, jwks, ahgSessionFactory: reqSessionFactory });
  await new Promise((r) => { rserver = app.listen(0, '127.0.0.1', r); });
  rbase = `http://127.0.0.1:${rserver.address().port}`;
  servicepush.setPushEnabled(rdb, true, 'admin@example.com');
  servicepush.setPushRequirementsEnabled(rdb, true, 'admin@example.com');
  })();
  return reqReady;
}
test.after(() => { if (rserver) rserver.close(); if (rdb) rdb.close(); if (badgesDir) fs.rmSync(badgesDir, { recursive: true, force: true }); });

// A confirmed completion for requirement :1 planned over two meetings (she
// missed the first, verified by the leader), queued as a mark row.
function confirmedWithNote() {
  plans.putPlan(rdb, eventRow2(rEv1), 'Pioneer/Patriot', { items: [{ requirementId: 'example-badge-pipa:1', role: 'start', notes: 'Chose a topic' }] }, 'leader@example.com');
  plans.putPlan(rdb, eventRow2(rEv2), 'Pioneer/Patriot', { items: [{ requirementId: 'example-badge-pipa:1', role: 'finish', notes: 'Presented it' }] }, 'leader@example.com');
  rdb.prepare("INSERT OR REPLACE INTO attendance (event_id, girl_id, signed_in_at, signed_out_at, open, source_txn_ids, fetched_at) VALUES (?, ?, 'x', 'y', 0, '[1]', ?)").run(rEv2, rgirl, new Date().toISOString());
  proposals.proposeForEvent(rdb, eventRow2(rEv2), 'America/New_York');
  const c = rdb.prepare("SELECT * FROM completions WHERE girl_id = ? AND requirement_id = 'example-badge-pipa:1'").get(rgirl);
  proposals.decideRows(rdb, [{ completionId: c.id, decision: 'confirm', verified: true, note: 'Finished the first half at home' }], 'leader@example.com', { tz: 'America/New_York' });
  enqueueMark(c.id);
  return c;
}

test('unit: fragmentPairs forces a checkbox on with its own value, sets date/comment, echoes the rest', () => {
  const html = `<form>${reqPanel('r00000test01', { checked: false, date: '', comment: '' })}${reqPanel('r00000test02', { checked: true, date: '08/01/2026', comment: 'hand &amp; entered' })}</form>`;
  const pairs = servicepush.fragmentPairs(html, { check: ['checkbox-r00000test01'], set: { 'date-r00000test01': '09/08/2026', 'comment-r00000test01': 'note' } });
  assert.deepEqual(pairs, [
    ['checkbox-r00000test01', '1'], ['date-r00000test01', '09/08/2026'], ['comment-r00000test01', 'note'],
    ['checkbox-r00000test02', '1'], ['date-r00000test02', '08/01/2026'], ['comment-r00000test02', 'hand & entered'],
  ]);
});

test('requirement push: OFF without its own flag even when push_enabled is on', async () => {
  await setupReq();
  resetReq();
  servicepush.setPushRequirementsEnabled(rdb, false, 'admin@example.com');
  confirmedWithNote();
  const r = await (await rget('/api/v1/sync/push', { method: 'POST' })).json();
  assert.equal(r.requirements.skipped, 'requirement push disabled');
  assert.equal(req.saves, 0);
  assert.equal(rdb.prepare('SELECT status FROM push_queue WHERE id = ?').get(queueMark()).status, 'queued');
  servicepush.setPushRequirementsEnabled(rdb, true, 'admin@example.com');
});

test('requirement push: checks the box, writes her date and the note, echoes every other item; read-back → sent', async () => {
  await setupReq();
  resetReq();
  const id = queueMark();
  const r = await (await rget('/api/v1/sync/push', { method: 'POST' })).json();
  assert.deepEqual({ pushed: r.requirements.pushed, held: r.requirements.held, skipped: r.requirements.skippedRows }, { pushed: 1, held: 0, skipped: 0 });
  assert.equal(req.saves, 1);
  const body = new Map(req.bodies[0]);
  assert.equal(body.get('checkbox-r00000test01'), '1');
  assert.equal(body.get('date-r00000test01'), '09/08/2026');
  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  assert.equal(body.get('comment-r00000test01'), `tracker: 09/08/2026 Meeting Two — Presented it | Leader verified full completion (missed planned session 09/01/2026): Finished the first half at home — leader@example.com, ${today}`);
  assert.equal(body.get('checkbox-r00000test02'), '1', 'the hand-entered item is echoed checked');
  assert.equal(body.get('comment-r00000test02'), 'hand-entered');
  assert.equal(body.has('checkbox-r00000test03'), false, 'unchecked items contribute no checkbox');
  assert.equal(body.get('youth-select[]'), Y_BEA);
  assert.equal(body.get('badge-select'), 'aw0000example');
  assert.equal(rdb.prepare('SELECT status FROM push_queue WHERE id = ?').get(id).status, 'sent');
  const st = rdb.prepare("SELECT completed, comment FROM ahg_state WHERE girl_id = ? AND requirement_id = 'example-badge-pipa:1'").get(rgirl);
  assert.equal(st && st.completed, 1, 'mirror updated so the next pull does not re-queue');
  assert.equal(r.report.wanted, true);
  assert.equal(r.report.configured, false, 'no SMTP in tests — report kept, not mailed');
});

test('requirement push: already checked → skipped without a write; swallowed save → held; disturbed neighbour → held', async () => {
  await setupReq();
  const c = rdb.prepare("SELECT * FROM completions WHERE girl_id = ? AND requirement_id = 'example-badge-pipa:1'").get(rgirl);
  resetReq(); req.items.r00000test01.checked = true;
  enqueueMark(c.id);
  let id = queueMark();
  let r = await (await rget('/api/v1/sync/push', { method: 'POST' })).json();
  assert.deepEqual({ skipped: r.requirements.skippedRows, saves: req.saves }, { skipped: 1, saves: 0 });
  assert.match(rdb.prepare('SELECT last_error FROM push_queue WHERE id = ?').get(id).last_error, /already complete/);
  resetReq(); req.swallow = true;
  enqueueMark(c.id);
  id = queueMark();
  r = await (await rget('/api/v1/sync/push', { method: 'POST' })).json();
  assert.deepEqual({ held: r.requirements.held, saves: req.saves }, { held: 1, saves: 1 });
  assert.match(rdb.prepare('SELECT last_error FROM push_queue WHERE id = ?').get(id).last_error, /did not read back as checked/);
  resetReq(); req.corrupt = true;
  enqueueMark(c.id);
  id = queueMark();
  r = await (await rget('/api/v1/sync/push', { method: 'POST' })).json();
  assert.equal(r.requirements.held, 1);
  assert.match(rdb.prepare('SELECT last_error FROM push_queue WHERE id = ?').get(id).last_error, /another requirement or instance changed/);
});

test('scheduler: weekly push only while push_enabled and something is queued; one report per run; errors_only', async () => {
  await setupReq();
  const c = rdb.prepare("SELECT * FROM completions WHERE girl_id = ? AND requirement_id = 'example-badge-pipa:1'").get(rgirl);
  resetReq();
  rdb.prepare('DELETE FROM push_queue').run();
  enqueueMark(c.id);
  const mails = [];
  const mailer = async (cfg, m) => { mails.push(m); };
  const mcfg = { ...rcfg, mail: { smtpUrl: 'smtp://fake', from: 'tracker@example.org', to: ['coord@example.org'] } };
  const sched = makeScheduler({ cfg: mcfg, db: rdb, client: makeCheckinClient({ base: '', apiKey: '' }), credKey: KEY, ahgSessionFactory: reqSessionFactory, mailer, log: () => {} });
  const t0 = Date.parse('2026-09-20T08:00:00Z');
  servicepush.setPushEnabled(rdb, false, 'admin@example.com');
  let out = await sched.tick(t0);
  assert.equal(out.push, undefined, 'flag off: nothing');
  servicepush.setPushEnabled(rdb, true, 'admin@example.com');
  out = await sched.tick(t0);
  assert.equal(out.pushRequirements && out.pushRequirements.pushed, 1);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /AHGFamily push \(weekly\): 1 sent/);
  assert.match(mails[0].text, /SENT\s+Anders, Bea — Example Badge 1/);
  assert.deepEqual(mails[0].to, ['coord@example.org']);
  out = await sched.tick(t0 + 60e3);
  assert.equal(out.push, undefined, 'weekly cadence, and nothing queued');
  // errors_only: a clean run is silent, a held run mails
  reportLib.setReportMode(rdb, 'errors_only', 'admin@example.com');
  resetReq();
  enqueueMark(c.id);
  out = await sched.tick(t0 + 8 * 24 * 3600e3);
  assert.equal(out.pushRequirements.pushed, 1);
  assert.equal(mails.length, 1, 'errors_only: clean run not mailed');
  resetReq(); req.swallow = true;
  enqueueMark(c.id);
  out = await sched.tick(t0 + 16 * 24 * 3600e3);
  assert.equal(out.pushRequirements.held, 1);
  assert.equal(mails.length, 2);
  assert.match(mails[1].subject, /1 HELD/);
  assert.match((await (await rget('/api/v1/sync/push-report')).json()).text, /HELD/);
});
