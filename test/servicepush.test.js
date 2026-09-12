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
