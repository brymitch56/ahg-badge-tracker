'use strict';
// Links on plans and each badge's link library (migration 012). Offline.

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
  badgesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-badges-'));
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

const lg = encodeURIComponent('Pioneer/Patriot');
const plansPath = (id = eventId) => `/api/v1/events/${id}/plans/${lg}`;
const leaderToken = () => token({ groups: [GROUP], preferred_username: 'leader@example.com' });
const item = { requirementId: 'example-badge-pipa:1', role: 'session' };

test('a plan carries links per badge; saving files them in the badge library', async () => {
  const t = await leaderToken();
  let r = await put(plansPath(), t, {
    items: [item],
    links: [
      { badgeId: 'example-badge-pipa', url: 'https://example.com/activity-sheet', title: 'Activity sheet' },
      { badgeId: 'example-badge-pipa', url: 'https://contoso.sharepoint.com/sites/x/Docs/plan.docx', title: 'plan.docx', kind: 'sharepoint', driveId: 'b!drive', itemId: '01ITEM' },
    ],
  });
  assert.equal(r.status, 200);
  const plan = await r.json();
  assert.deepEqual(plan.links.map((l) => [l.title, l.kind]), [['Activity sheet', 'web'], ['plan.docx', 'sharepoint']]);
  assert.equal(plan.links[1].driveId, 'b!drive');

  const lib = await (await get('/api/v1/badges/example-badge-pipa/links', t)).json();
  assert.equal(lib.length, 2);
  assert.equal(lib[0].uses[0].eventId, eventId);
  assert.equal(lib[0].uses[0].unit, 'Pioneer/Patriot');

  // a save that doesn't mention links keeps them (an older page still saves)
  r = await put(plansPath(), t, { items: [item], notes: 'notes only change' });
  assert.equal((await r.json()).links.length, 2);
  // links: [] clears the plan's links but the library keeps them
  r = await put(plansPath(), t, { items: [item], links: [] });
  assert.deepEqual((await r.json()).links, []);
  const after = await (await get('/api/v1/badges/example-badge-pipa/links', t)).json();
  assert.equal(after.length, 2);
  assert.deepEqual(after[0].uses, [], 'no plan uses it any more');
});

test('link validation: badge must be on the plan, http(s) only, no duplicates, default title', async () => {
  const t = await leaderToken();
  const bad = async (links, re) => {
    const r = await put(plansPath(), t, { items: [item], links });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, re);
  };
  await bad([{ badgeId: 'other-badge-expl', url: 'https://example.com/a' }], /no requirement of other-badge-expl/);
  await bad([{ badgeId: 'example-badge-pipa', url: 'javascript:alert(1)' }], /only http and https/);
  await bad([{ badgeId: 'example-badge-pipa', url: 'not a url' }], /not a web address/);
  await bad([{ badgeId: 'example-badge-pipa', url: 'https://example.com/a' }, { badgeId: 'example-badge-pipa', url: 'https://example.com/a' }], /appears twice/);
  await bad([{ badgeId: 'example-badge-pipa', url: 'https://example.com/a', kind: 'ftp' }], /kind must be/);
  await bad('nope', /links must be an array/);

  const r = await put(plansPath(), t, { items: [item], links: [{ badgeId: 'example-badge-pipa', url: 'https://example.com/files/Knot%20Guide.pdf' }] });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).links[0].title, 'Knot Guide.pdf');
});

test('an emptied plan drops its links; the badge library keeps them', async () => {
  const t = await leaderToken();
  await put(plansPath(), t, { items: [item], links: [{ badgeId: 'example-badge-pipa', url: 'https://example.com/keep-me', title: 'Keep me' }] });
  // the Pioneer/Patriot plan is emptied: plan row and plan_links go, library stays
  await put(plansPath(), t, { items: [] });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_links pl JOIN plans p ON p.id = pl.plan_id WHERE p.level_group = ?').get('Pioneer/Patriot').n, 0);
  const lib = await (await get('/api/v1/badges/example-badge-pipa/links', t)).json();
  assert.ok(lib.some((l) => l.title === 'Keep me'));
});

test('hiding a link drops it from suggestions; using it again brings it back with the new title', async () => {
  const t = await leaderToken();
  const lib = await (await get('/api/v1/badges/example-badge-pipa/links', t)).json();
  const target = lib.find((l) => l.url === 'https://example.com/activity-sheet');
  let r = await get(`/api/v1/badges/example-badge-pipa/links/${target.id}/hidden`, t, { method: 'POST', body: JSON.stringify({ hidden: true }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).hidden, true);
  let shown = await (await get('/api/v1/badges/example-badge-pipa/links', t)).json();
  assert.ok(!shown.some((l) => l.id === target.id));
  const all = await (await get('/api/v1/badges/example-badge-pipa/links?all=1', t)).json();
  assert.ok(all.find((l) => l.id === target.id).hidden);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'link.hide'").get().n, 1);

  r = await put(plansPath(), t, { items: [item], links: [{ badgeId: 'example-badge-pipa', url: 'https://example.com/activity-sheet', title: 'Activity sheet v2' }] });
  assert.equal(r.status, 200);
  shown = await (await get('/api/v1/badges/example-badge-pipa/links', t)).json();
  const back = shown.find((l) => l.id === target.id);
  assert.equal(back.title, 'Activity sheet v2', 'same url = same library entry, latest title wins');
  assert.equal(shown[0].id, target.id, 'most recently used first');

  assert.equal((await get('/api/v1/badges/example-badge-pipa/links/999999/hidden', t, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await get('/api/v1/badges/other-badge-expl/links/' + target.id + '/hidden', t, { method: 'POST', body: '{}' })).status, 404, 'link of another badge');
  assert.equal((await get('/api/v1/badges/no-such-badge/links', t)).status, 404);
  assert.equal((await get('/api/v1/badges/example-badge-pipa/links')).status, 401);
});
