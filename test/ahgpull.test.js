'use strict';
// Build step 6: AHGFamily pull → ahg_state, rule 6 reconciliation,
// conflicts, and the weekly scheduler job. Entirely offline: the AHGFamily
// session is an injected fixture serving synthetic fragments with INVENTED
// ids only (utest…, adtest…, letest…) — no network, ever.
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
const ahgpull = require('../server/lib/ahgpull');
const mapping = require('../server/lib/mapping');
const { makeCheckinClient } = require('../server/lib/checkin');
const { makeScheduler } = require('../server/lib/scheduler');
const { parseGridState, parseStandardState } = require('../lib/parse');
const { FetchError, EXIT } = require('../lib/ahgfamily');
const { buildBadge } = require('../scripts/build-badges');
const example = require('../handbook/example.json');

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000002';
const GROUP = '00000000-0000-0000-0000-000000000003';
const KEY = Buffer.from('ab'.repeat(32), 'hex');
const AWARD = 'aw0000example';
const LEVEL = 'letest000001';

let keys; let jwks; let db; let cfg; let server; let base; let badgesDir;
let bea; let cora; let dot; // girl ids

async function token(claims = {}) {
  return new SignJWT({ scp: 'access_as_leader', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(CLIENT)
    .setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
}
const get = (p, t, init = {}) => fetch(base + p, { ...init, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), 'Content-Type': 'application/json', ...(init.headers || {}) } });

function exampleBuilt() {
  const cat = {
    awardId: AWARD, name: 'Example Badge', levelGroup: 'Pioneer/Patriot', retired: false, wholeAwardOnly: false, imageSlug: 'example', source: { fetchedAt: '2026-09-07T00:00:00Z' },
    groups: [
      { label: 'Complete All', rule: { type: 'all' }, edition: 'current', plannable: true, items: [{ id: 'r00000test01', number: 1, title: 'First' }, { id: 'r00000test02', number: 2, title: 'Second' }] },
      { label: 'Complete One', rule: { type: 'n_of', n: 1 }, edition: 'current', plannable: true, items: [{ id: 'r00000test03', number: 3, title: 'Third' }, { id: 'r00000test04', number: 4, title: 'Fourth' }] },
    ],
  };
  const r = buildBadge(example, cat, { annotationFile: 'example.json' });
  assert.equal(r.errors, undefined);
  return r.badge;
}

// ---- synthetic AHGFamily fragments (markup mirrors the live grid cells) ----
const cell = (yt, id, value) => `<div class="advance-icon" data-type="toggle-item" data-id="${id}" data-level="${LEVEL}" data-yt="${yt}" data-value="${value}" id="${id}_${yt}_${LEVEL}"></div>`;
const gridHtml = (states) => `<div class="grid">${states.map(([yt, id, v]) => cell(yt, id, v)).join('')}${cell('utest0000001', 'awtest000001', 0)}</div>`;
const standardHtml = ({ items = [], record = null }) => `<form>
  ${items.map(({ id, date, comment }) => `
    <input type="checkbox" name="checkbox-${id}" checked>
    <input type="text" name="date-${id}" value="${date || ''}">
    <textarea name="comment-${id}" class="form-control">${comment || ''}</textarea>`).join('')}
  <input type="checkbox" name="checkbox-r00000test04">
  ${record ? `<input type="hidden" name="new-${record.adId}"><input type="text" name="completed_on-${record.adId}" value="${record.completedOn || ''}">` : ''}
</form>`;

// mutable pull scenario the fake session serves
const scenario = { grid: [], standard: {}, gridCalls: 0, standardCalls: 0, closed: 0, fail: null };
const fakeSessionFactory = async () => {
  if (scenario.fail) throw scenario.fail;
  return {
    grid: async () => { scenario.gridCalls += 1; return gridHtml(scenario.grid); },
    standard: async (awardId, youthId) => { scenario.standardCalls += 1; return standardHtml(scenario.standard[youthId] || {}); },
    close: async () => { scenario.closed += 1; },
  };
};

test.before(async () => {
  keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] });
  badgesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-badges-'));
  fs.writeFileSync(path.join(badgesDir, 'example-badge-pipa.json'), JSON.stringify(exampleBuilt()));
  cfg = makeConfig({
    MSAL_TENANT_ID: TENANT, MSAL_CLIENT_ID: CLIENT, LEADER_GROUP_ID: GROUP, ADMIN_EMAILS: 'admin@example.com',
    DB_PATH: ':memory:', BADGES_DIR: badgesDir, CRED_KEY: KEY.toString('hex'),
  });
  db = openDb(':memory:');
  migrate(db);
  catalog.importFromDir(db, badgesDir, { actor: 'admin@example.com' });
  const addGirl = (first, last, level, youthId) => Number(db.prepare(
    "INSERT INTO girls (first_name, last_name, ahg_level, ahg_youth_id, ahg_youth_id_source, active, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
  ).run(first, last, level, youthId, youthId ? 'manual' : null, new Date().toISOString()).lastInsertRowid);
  bea = addGirl('Bea', 'Anders', 'Pioneer', 'utest0000001');
  cora = addGirl('Cora', 'Blake', 'Patriot', 'utest0000002');
  dot = addGirl('Dot', 'Cole', 'Explorer', null); // unmapped — the pull never sees her
  // Cora already has a leader-confirmed completion on :2 — makes the badge
  // "active" for the pull and sets up "confirmed here, not there"
  db.prepare(`INSERT INTO completions (girl_id, requirement_id, status, completed_on, source, level_at_completion, proposed_at, decided_by, decided_at)
              VALUES (?, 'example-badge-pipa:2', 'confirmed', '2026-08-25', 'manual', 'Patriot', ?, 'leader@example.com', ?)`)
    .run(cora, new Date().toISOString(), new Date().toISOString());
  const app = createApp({ cfg, db, jwks, ahgSessionFactory: fakeSessionFactory });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); fs.rmSync(badgesDir, { recursive: true, force: true }); });

test('parseGridState / parseStandardState read the observed markup', () => {
  const cells = parseGridState(gridHtml([['utest0000001', 'r00000test01', 1], ['utest0000002', 'r00000test02', 0]]));
  assert.deepEqual(cells, [
    { youthId: 'utest0000001', itemId: 'r00000test01', levelId: LEVEL, value: 1 },
    { youthId: 'utest0000002', itemId: 'r00000test02', levelId: LEVEL, value: 0 },
    { youthId: 'utest0000001', itemId: 'awtest000001', levelId: LEVEL, value: 0 }, // the award's own row — callers skip it
  ]);
  const st = parseStandardState(standardHtml({
    items: [{ id: 'r00000test01', date: '9/1/2026', comment: 'Done at camp &amp; home' }],
    record: { adId: 'adtest000001', completedOn: '' },
  }), { awardId: AWARD });
  assert.deepEqual(st.items['r00000test01'], { checked: true, date: '9/1/2026', comment: 'Done at camp & home' });
  assert.deepEqual(st.items['r00000test04'], { checked: false, date: null, comment: null });
  assert.deepEqual(st.records, [{ adId: 'adtest000001', isNew: true, completedOn: null, awardedOn: null, purchased: false, comment: null }]);
  assert.equal(st.instanceCount, 0, 'a blank new- slot is not an instance');
  assert.equal(ahgpull.isoDate('9/1/2026'), '2026-09-01');
});

test('pull: grid → ahg_state; rule 6 creates ahgfamily completions with dates and queues local-only ones', async () => {
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  scenario.grid = [
    ['utest0000001', 'r00000test01', 1], ['utest0000001', 'r00000test02', 0],
    ['utest0000002', 'r00000test01', 0], ['utest0000002', 'r00000test02', 0],
  ];
  scenario.standard['utest0000001'] = {
    items: [{ id: 'r00000test01', date: '9/1/2026', comment: 'At the campout' }],
    record: { adId: 'adtest000001', completedOn: '' },
  };
  let r = await get('/api/v1/sync/pull', adminT, { method: 'POST' });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.deepEqual(
    { badges: s.badges, requests: s.requests, detailFetches: s.detailFetches, newFromAhg: s.newFromAhg, queued: s.queued, conflicts: s.conflicts },
    { badges: 1, requests: 2, detailFetches: 1, newFromAhg: 1, queued: 1, conflicts: 0 },
  );
  assert.equal(scenario.closed, 1, 'logout after the run');

  // Bea's AHGFamily-complete item became a confirmed completion, dated from the Standard detail
  const c = db.prepare("SELECT * FROM completions WHERE girl_id = ? AND requirement_id = 'example-badge-pipa:1'").get(bea);
  assert.deepEqual(
    { status: c.status, source: c.source, on: c.completed_on, level: c.level_at_completion },
    { status: 'confirmed', source: 'ahgfamily', on: '2026-09-01', level: 'Pioneer' },
  );
  const st = db.prepare("SELECT * FROM ahg_state WHERE girl_id = ? AND requirement_id = 'example-badge-pipa:1'").get(bea);
  assert.deepEqual({ completed: st.completed, on: st.earned_on, comment: st.comment, ad: st.ad_record_id },
    { completed: 1, on: '2026-09-01', comment: 'At the campout', ad: 'adtest000001' });
  // Cora's local-only confirmed :2 is queued (idle until step 7)
  const q = db.prepare('SELECT * FROM push_queue WHERE girl_id = ?').get(cora);
  assert.deepEqual({ action: q.action, status: q.status, date: q.date, req: q.requirement_id },
    { action: 'mark', status: 'queued', date: '2026-08-25', req: 'example-badge-pipa:2' });
  // the unmapped girl never appears
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ahg_state WHERE girl_id = ?').get(dot).n, 0);

  // idempotent: same grid again → nothing new, no detail refetch
  const before = { g: scenario.gridCalls, s: scenario.standardCalls };
  r = await get('/api/v1/sync/pull', adminT, { method: 'POST' });
  const s2 = await r.json();
  assert.deepEqual({ newFromAhg: s2.newFromAhg, queued: s2.queued, detailFetches: s2.detailFetches }, { newFromAhg: 0, queued: 0, detailFetches: 0 });
  assert.deepEqual({ g: scenario.gridCalls - before.g, s: scenario.standardCalls - before.s }, { g: 1, s: 0 });
  assert.deepEqual({ unseen: s2.unseenGirls, warnings: s2.warnings }, { unseen: [], warnings: [] }, 'every mapped girl appeared');
});

test('pull: a mapped girl absent from every fragment is reported as out of scope, not silently skipped', async () => {
  // Seen live 2026-09-12: the badge-tracker view is scoped to what the pull
  // account may see, and a girl outside it yields no cells at all. Her state
  // must not be touched, and the run must say so.
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  const coraBefore = db.prepare('SELECT fetched_at FROM ahg_state WHERE girl_id = ? ORDER BY requirement_id').all(cora);
  scenario.grid = [['utest0000001', 'r00000test01', 1], ['utest0000001', 'r00000test02', 0]]; // Bea only
  const r = await get('/api/v1/sync/pull', adminT, { method: 'POST' });
  const s = await r.json();
  assert.deepEqual(s.unseenGirls, [cora]);
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0], /1 mapped girl\(s\) never appeared .* registration not finished .* NOT refreshed/);
  assert.deepEqual(db.prepare('SELECT fetched_at FROM ahg_state WHERE girl_id = ? ORDER BY requirement_id').all(cora), coraBefore, "Cora's rows untouched");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM conflicts WHERE girl_id = ? AND status = 'open'").get(cora).n, 0, 'no conflict invented from absence');
});

test('pull: agreement skips the queued mark; un-check there opens a conflict, never a silent revert', async () => {
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  // AHGFamily now shows Cora's :2 checked too (pushed by hand there) — and Bea's :1 un-checked
  scenario.grid = [
    ['utest0000001', 'r00000test01', 0], ['utest0000001', 'r00000test02', 0],
    ['utest0000002', 'r00000test01', 0], ['utest0000002', 'r00000test02', 1],
  ];
  scenario.standard['utest0000002'] = { items: [{ id: 'r00000test02', date: '8/25/2026', comment: '' }], record: { adId: 'adtest000002', completedOn: '' } };
  const s = await (await get('/api/v1/sync/pull', adminT, { method: 'POST' })).json();
  assert.deepEqual({ conflicts: s.conflicts, skippedQueue: s.skippedQueue, newFromAhg: s.newFromAhg }, { conflicts: 1, skippedQueue: 1, newFromAhg: 0 });
  assert.equal(db.prepare('SELECT status FROM push_queue WHERE girl_id = ?').get(cora).status, 'skipped');
  assert.equal(db.prepare("SELECT status FROM completions WHERE girl_id = ? AND requirement_id = 'example-badge-pipa:1'").get(bea).status,
    'confirmed', 'rule 6: never silently reverted');

  const leaderT = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  const open = await (await get('/api/v1/conflicts', leaderT)).json();
  assert.equal(open.length, 1);
  assert.deepEqual({ kind: open[0].kind, girl: open[0].firstName, req: open[0].requirementId },
    { kind: 'ahg_unchecked', girl: 'Bea', req: 'example-badge-pipa:1' });
});

test('conflicts: accept_ahgfamily retracts locally; keep_tracker re-queues; both audited', async () => {
  const leaderT = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  let open = await (await get('/api/v1/conflicts', leaderT)).json();
  let r = await get(`/api/v1/conflicts/${open[0].id}/resolve`, leaderT, { method: 'POST', body: JSON.stringify({ resolution: 'nope' }) });
  assert.equal(r.status, 400);
  r = await get(`/api/v1/conflicts/${open[0].id}/resolve`, leaderT, { method: 'POST', body: JSON.stringify({ resolution: 'accept_ahgfamily', note: 'was entered by mistake' }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'resolved');
  assert.equal(db.prepare("SELECT status FROM completions WHERE girl_id = ? AND requirement_id = 'example-badge-pipa:1'").get(bea).status, 'rejected');
  assert.equal((await get(`/api/v1/conflicts/${open[0].id}/resolve`, leaderT, { method: 'POST', body: JSON.stringify({ resolution: 'keep_tracker' }) })).status, 409, 'already resolved');

  // AHGFamily un-checks Cora's :2 later → new conflict → keep_tracker queues a fresh mark
  scenario.grid = scenario.grid.map(([yt, id, v]) => [yt, id, yt === 'utest0000002' && id === 'r00000test02' ? 0 : v]);
  await get('/api/v1/sync/pull', adminT, { method: 'POST' });
  open = await (await get('/api/v1/conflicts', leaderT)).json();
  assert.equal(open.length, 1);
  assert.equal(open[0].firstName, 'Cora');
  r = await get(`/api/v1/conflicts/${open[0].id}/resolve`, leaderT, { method: 'POST', body: JSON.stringify({ resolution: 'keep_tracker' }) });
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM push_queue WHERE girl_id = ? AND status = 'queued'").get(cora).n, 1, 're-queued for step 7');

  const status = await (await get('/api/v1/sync/status', leaderT)).json();
  assert.equal(status.openConflicts, 0);
  assert.ok(status.queue.queued >= 1);
  const queue = await (await get('/api/v1/sync/queue', leaderT)).json();
  assert.equal(queue.find((q) => q.status === 'queued').lastName, 'Blake');
});

test('rule 8: an auth failure mid-pull latches; a latched tracker refuses before any traffic', async () => {
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  scenario.fail = new FetchError(EXIT.AUTH, 'Login rejected.');
  let r = await get('/api/v1/sync/pull', adminT, { method: 'POST' });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).latched, true);
  scenario.fail = null;
  const calls = scenario.gridCalls;
  r = await get('/api/v1/sync/pull', adminT, { method: 'POST' });
  assert.equal(r.status, 409, 'still latched');
  assert.equal(scenario.gridCalls, calls, 'no traffic while latched');
  mapping.storeCredentials(db, { email: 'leader@example.com', password: 'fake-password-never-real' }, 'admin@example.com', KEY);
  assert.equal((await get('/api/v1/sync/pull', adminT, { method: 'POST' })).status, 200, 're-entered credentials clear the latch');
});

test('scheduler: weekly pull only with STORED credentials and mapped girls; env fallback never auto-pulls', async () => {
  const sdb = openDb(':memory:');
  migrate(sdb);
  catalog.importFromDir(sdb, badgesDir, { actor: 'admin@example.com' });
  sdb.prepare("INSERT INTO girls (first_name, last_name, ahg_level, ahg_youth_id, active, updated_at) VALUES ('Bea', 'Anders', 'Pioneer', 'utest0000001', 1, '2026-09-01T00:00:00Z')").run();
  sdb.prepare(`INSERT INTO completions (girl_id, requirement_id, status, completed_on, source, proposed_at) VALUES (1, 'example-badge-pipa:2', 'confirmed', '2026-08-25', 'manual', '2026-09-01T00:00:00Z')`).run();
  // The scheduler also runs the weekly Service Stars pull with the same
  // factory; that session gets a minimal profile page so it fails harmlessly
  // (its own test lives in servicepull.test.js) and is not counted here.
  let factoryCalls = 0;
  const countingFactory = async (...a) => {
    const s = await fakeSessionFactory(...a);
    return { ...s, grid: async (...g) => { factoryCalls += 1; return s.grid(...g); }, page: async () => '<html></html>' };
  };
  const client = makeCheckinClient({ base: '', apiKey: '' }); // check-in not configured — pull must still run
  const sched = makeScheduler({ cfg, db: sdb, client, credKey: KEY, ahgSessionFactory: countingFactory, log: () => {} });
  const nowMs = Date.now();

  scenario.grid = [['utest0000001', 'r00000test01', 0], ['utest0000001', 'r00000test02', 0]];
  let out = await sched.tick(nowMs);
  assert.equal(factoryCalls, 0, '.env fallback credentials never trigger the scheduled pull');
  assert.equal(out.pull, undefined);

  mapping.storeCredentials(sdb, { email: 'leader@example.com', password: 'fake-password-never-real' }, 'admin@example.com', KEY);
  out = await sched.tick(nowMs);
  assert.equal(factoryCalls, 1);
  assert.equal(out.pull.kind, 'ahg_state');
  assert.match(out.serviceError || '', /no service ledger/, 'service pull ran and failed loudly on the blank page');
  assert.equal(out.pull.queued, 1);

  out = await sched.tick(nowMs + 60e3);
  assert.equal(factoryCalls, 1, 'weekly cadence: not again within 7 days');
  out = await sched.tick(nowMs + 8 * 24 * 3600e3);
  assert.equal(factoryCalls, 2, 'due again after a week');
  sdb.close();
});
