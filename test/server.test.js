'use strict';
// Tracker service tests: in-memory SQLite, local JWKS (no network), real HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { makeConfig } = require('../server/config');
const { openDb, migrate } = require('../server/db');
const { createApp } = require('../server/app');
const { buildBadge } = require('../scripts/build-badges');
const example = require('../handbook/example.json');

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000002';
const GROUP = '00000000-0000-0000-0000-000000000003';
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;

let keys; let jwks; let server; let base; let db; let badgesDir;

async function token(claims = {}, { aud = CLIENT, iss = ISSUER, scp = 'access_as_leader', exp = '1h' } = {}) {
  return new SignJWT({ scp, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp)
    .sign(keys.privateKey);
}
const get = (p, t, init = {}) => fetch(base + p, { ...init, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(init.headers || {}) } });

// a built badge from the example annotation + a synthetic catalog award
function exampleBuilt() {
  const catalog = {
    awardId: 'aw0000example', name: 'Example Badge', levelGroup: 'Pioneer/Patriot', retired: false, wholeAwardOnly: false, imageSlug: 'example', source: { fetchedAt: '2026-09-07T00:00:00Z' },
    groups: [
      { label: 'Complete All', rule: { type: 'all' }, edition: 'current', plannable: true, items: [{ id: 'r00000test01', number: 1, title: 'First' }, { id: 'r00000test02', number: 2, title: 'Second' }] },
      { label: 'Complete One', rule: { type: 'n_of', n: 1 }, edition: 'current', plannable: true, items: [{ id: 'r00000test03', number: 3, title: 'Third' }, { id: 'r00000test04', number: 4, title: 'Fourth' }] },
    ],
  };
  const r = buildBadge(example, catalog, { annotationFile: 'example.json' });
  assert.equal(r.errors, undefined);
  return r.badge;
}

test.before(async () => {
  keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] });
  badgesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'badges-'));
  fs.writeFileSync(path.join(badgesDir, 'example-badge-pipa.json'), JSON.stringify(exampleBuilt()));
  const cfg = makeConfig({
    MSAL_TENANT_ID: TENANT, MSAL_CLIENT_ID: CLIENT, LEADER_GROUP_ID: GROUP,
    LEADER_EMAILS: 'leader@example.com', ADMIN_EMAILS: 'Admin@Example.com',
    SITE_ORIGIN: 'https://troop.example.org', BADGES_DIR: badgesDir, DB_PATH: ':memory:',
  });
  db = openDb(':memory:');
  migrate(db);
  const app = createApp({ cfg, db, jwks });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); fs.rmSync(badgesDir, { recursive: true, force: true }); });

test('migrations apply once and are idempotent', () => {
  const d = openDb(':memory:');
  assert.deepEqual(migrate(d), ['001-init.sql', '002-checkin.sql', '003-review.sql', '004-conflicts.sql']);
  assert.deepEqual(migrate(d), []);
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  for (const t of ['badges', 'requirements', 'girls', 'events', 'plans', 'plan_items', 'completions', 'participation', 'ahg_state', 'push_queue', 'sync_runs', 'settings', 'audit_log']) assert.ok(tables.includes(t), t);
  d.close();
});

test('/health is public and reports no catalog yet', async () => {
  const r = await get('/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true); assert.equal(j.catalog, null); assert.equal(j.auth, 'msal');
});

test('auth: missing / wrong audience / wrong issuer / missing scope / non-leader / expired', async () => {
  assert.equal((await get('/api/v1/me')).status, 401);
  assert.equal((await get('/api/v1/me', await token({ groups: [GROUP] }, { aud: 'https://graph.microsoft.com' }))).status, 401, 'a Graph token is refused');
  assert.equal((await get('/api/v1/me', await token({ groups: [GROUP] }, { iss: 'https://sts.windows.net/x/' }))).status, 401);
  assert.equal((await get('/api/v1/me', await token({ groups: [GROUP] }, { scp: 'User.Read' }))).status, 401);
  assert.equal((await get('/api/v1/me', await token({ preferred_username: 'stranger@example.com' }))).status, 403);
  assert.equal((await get('/api/v1/me', await token({ groups: [GROUP] }, { exp: '-5m' }))).status, 401);
});

test('auth: leader by group, leader by e-mail, admin by e-mail (case-insensitive)', async () => {
  let r = await get('/api/v1/me', await token({ groups: [GROUP], preferred_username: 'someone@example.com', name: 'Some One' }));
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { email: 'someone@example.com', name: 'Some One', role: 'leader' });
  r = await get('/api/v1/me', await token({ preferred_username: 'Leader@example.com' }));
  assert.equal(r.status, 200); assert.equal((await r.json()).role, 'leader');
  r = await get('/api/v1/me', await token({ groups: [GROUP], preferred_username: 'admin@example.com' }));
  assert.equal(r.status, 200); assert.equal((await r.json()).role, 'admin');
});

test('CORS: only the site origin is allowed', async () => {
  let r = await fetch(base + '/health', { method: 'OPTIONS', headers: { Origin: 'https://troop.example.org', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), 'https://troop.example.org');
  r = await fetch(base + '/health', { headers: { Origin: 'https://evil.example.net' } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('catalog import: admin only; badges listed and fetched; versioned; audit written', async () => {
  const leaderT = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  assert.equal((await get('/api/v1/admin/catalog/import', leaderT, { method: 'POST' })).status, 403);
  assert.deepEqual(await (await get('/api/v1/badges', leaderT)).json(), [], 'empty before import');

  let r = await get('/api/v1/admin/catalog/import', adminT, { method: 'POST' });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.version, 1); assert.equal(s.badges, 1); assert.equal(s.requirements, 4); assert.deepEqual(s.orphans, []);

  r = await get('/api/v1/badges?levelGroup=Pioneer%2FPatriot', leaderT);
  const list = await r.json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'example-badge-pipa'); assert.equal(list[0].requirementCount, 4); assert.deepEqual(list[0].pages, [100, 101]);
  assert.deepEqual(await (await get('/api/v1/badges?levelGroup=Explorer', leaderT)).json(), []);

  r = await get('/api/v1/badges/example-badge-pipa', leaderT);
  const b = await r.json();
  assert.equal(b.name, 'Example Badge'); assert.equal(b.groups[0].trackerGroupId, 'example-badge-pipa:1');
  assert.equal(b.groups[0].requirements[0].trackerId, 'example-badge-pipa:1');
  assert.equal(b.groups[0].requirements[0].ahgFamilyId, 'r00000test01');
  assert.equal((await get('/api/v1/badges/nope', leaderT)).status, 404);

  const h = await (await get('/health')).json();
  assert.equal(h.catalog.version, 1); assert.equal(h.catalog.badges, 1);
  const audit = await (await get('/api/v1/admin/audit', adminT)).json();
  assert.equal(audit[0].action, 'catalog.import'); assert.equal(audit[0].actor, 'admin@example.com');
});

test('catalog re-import: renumbering keeps history via ahg id; removed badge deactivated, not deleted', async () => {
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  // simulate a live completion on requirement 3 (ahg r00000test03)
  db.prepare("INSERT INTO girls (first_name, last_name, active, updated_at) VALUES ('Placeholder', 'Girl', 1, '2026-09-07T00:00:00Z')").run();
  db.prepare("INSERT INTO completions (girl_id, requirement_id, status, source, proposed_at) VALUES (1, 'example-badge-pipa:3', 'confirmed', 'manual', '2026-09-07T00:00:00Z')").run();
  // new build: requirement 3 becomes number 5 (same ahg id); add a second badge; then a third import drops the first badge
  const b = exampleBuilt();
  b.groups[1].requirements[0].number = 5;
  fs.writeFileSync(path.join(badgesDir, 'example-badge-pipa.json'), JSON.stringify(b));
  fs.writeFileSync(path.join(badgesDir, 'other-badge-expl.json'), JSON.stringify({ ...b, id: 'other-badge-expl', awardId: 'aw0000other0', name: 'Other', levelGroup: 'Explorer',
    groups: [{ label: 'Complete All', rule: { type: 'all' }, requirements: [{ number: 1, ahgFamilyId: 'r00000test09', title: 'x', text: 'x', subItems: [], flags: [] }] }] }));
  let s = await (await get('/api/v1/admin/catalog/import', adminT, { method: 'POST' })).json();
  assert.equal(s.version, 2); assert.equal(s.badges, 2); assert.equal(s.renumbered, 1);
  assert.equal(db.prepare('SELECT requirement_id FROM completions WHERE id = 1').get().requirement_id, 'example-badge-pipa:5', 'completion follows the renamed requirement');

  fs.rmSync(path.join(badgesDir, 'example-badge-pipa.json'));
  s = await (await get('/api/v1/admin/catalog/import', adminT, { method: 'POST' })).json();
  assert.equal(s.version, 3); assert.deepEqual(s.deactivatedBadges, ['example-badge-pipa']);
  assert.equal(s.orphans.length, 1); assert.equal(s.orphans[0].id, 'example-badge-pipa:5');
  assert.equal((await (await get('/api/v1/badges', adminT)).json()).length, 1, 'inactive badge hidden by default');
  assert.equal((await (await get('/api/v1/badges?includeInactive=1', adminT)).json()).length, 2);
});

test('catalog import refuses a malformed badge file', async () => {
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  fs.writeFileSync(path.join(badgesDir, 'bad.json'), JSON.stringify({ id: 'bad', name: 'Bad' }));
  const r = await get('/api/v1/admin/catalog/import', adminT, { method: 'POST' });
  assert.equal(r.status, 422);
  const j = await r.json();
  assert.ok(j.errors.some((e) => /bad.json: missing awardId/.test(e)), j.errors.join('|'));
  fs.rmSync(path.join(badgesDir, 'bad.json'));
});
