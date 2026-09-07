'use strict';
// Build step 3: AHGFamily #youth-select mapping — parser, encrypted
// credentials, auth-failure latch, suggestions, admin API. All offline:
// the AHGFamily page is a synthetic HTML fixture with INVENTED names and
// hashids only (see CLAUDE.md); nothing here ever performs network I/O.
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { makeConfig } = require('../server/config');
const { openDb, migrate } = require('../server/db');
const { createApp } = require('../server/app');
const { parseYouthSelectPairs } = require('../lib/parse');
const { FetchError, EXIT } = require('../lib/ahgfamily');
const mapping = require('../server/lib/mapping');
const credcrypto = require('../server/lib/credcrypto');
const { getSetting } = require('../server/lib/settings');

const KEY = Buffer.from('ab'.repeat(32), 'hex');
const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000002';
const GROUP = '00000000-0000-0000-0000-000000000003';

// AHGFamily's advancement page shell, reduced to the one element the
// mapping reads. Ids/names are invented.
const PAGE = `<html><body><form>
<select id="badge-select"><option value="">Select...</option></select>
<select id="youth-select" multiple>
  <option value="">Select a youth&hellip;</option>
  <option value="utest0000001">Bea Anders</option>
  <option value="utest0000002">Blake, Cora</option>
  <option value="utest0000003">Fern G&#39;Dell</option>
  <option value="utest0000003">Fern G&#39;Dell</option>
  <option value="utest0000004">Ada Twin</option>
  <option value="utest0000005">Ada Twin</option>
  <option value="not-an-id">Chrome Row</option>
</select></form></body></html>`;

let keys; let jwks; let db; let app; let server; let base;
let fetchCalls = 0; let fetchImpl = async () => { fetchCalls += 1; return PAGE; };

async function token(claims = {}) {
  return new SignJWT({ scp: 'access_as_leader', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(CLIENT)
    .setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
}
const get = (p, t, init = {}) => fetch(base + p, { ...init, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), 'Content-Type': 'application/json', ...(init.headers || {}) } });

function addGirl(first, last, opts = {}) {
  return db.prepare(`INSERT INTO girls (first_name, last_name, nickname, ahg_level, ahg_youth_id, ahg_youth_id_source, active, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
    .run(first, last, opts.nickname || null, opts.level || null, opts.youthId || null, opts.youthId ? 'manual' : null, new Date().toISOString()).lastInsertRowid;
}

test.before(async () => {
  keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] });
  const cfg = makeConfig({
    MSAL_TENANT_ID: TENANT, MSAL_CLIENT_ID: CLIENT, LEADER_GROUP_ID: GROUP, ADMIN_EMAILS: 'admin@example.com',
    DB_PATH: ':memory:', CRED_KEY: KEY.toString('hex'),
  });
  db = openDb(':memory:');
  migrate(db);
  app = createApp({ cfg, db, jwks, ahgFetchHtml: (...a) => fetchImpl(...a) });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

test('parseYouthSelectPairs: ids+names, placeholders skipped, dupes collapsed, entities decoded', () => {
  const pairs = parseYouthSelectPairs(PAGE);
  assert.deepEqual(pairs, [
    { id: 'utest0000001', name: 'Bea Anders' },
    { id: 'utest0000002', name: 'Blake, Cora' },
    { id: 'utest0000003', name: "Fern G'Dell" },
    { id: 'utest0000004', name: 'Ada Twin' },
    { id: 'utest0000005', name: 'Ada Twin' },
  ]);
  assert.throws(() => parseYouthSelectPairs('<html></html>'), /#youth-select not found/);
});

test('credcrypto: round-trip; wrong key or tampering yields null, never throws', () => {
  const box = credcrypto.encrypt('fake-password-never-real', KEY);
  assert.equal(credcrypto.decrypt(box, KEY), 'fake-password-never-real');
  assert.equal(credcrypto.decrypt(box, Buffer.from('cd'.repeat(32), 'hex')), null);
  assert.equal(credcrypto.decrypt({ ...box, tag: box.iv }, KEY), null);
  assert.equal(credcrypto.decrypt(null, KEY), null);
});

test('credentials: stored box wins over env fallback; unreadable is surfaced', () => {
  const env = { AHG_EMAIL: 'env@example.com', AHG_PASSWORD: 'fake-env-password' };
  assert.deepEqual(mapping.getCredentials(db, KEY, env), { email: 'env@example.com', password: 'fake-env-password' });
  assert.equal(mapping.getCredentials(db, KEY, {}), null);
  mapping.storeCredentials(db, { email: 'leader@example.com', password: 'fake-password-never-real' }, 'admin@example.com', KEY);
  assert.deepEqual(mapping.getCredentials(db, KEY, env), { email: 'leader@example.com', password: 'fake-password-never-real' });
  assert.equal(mapping.getCredentials(db, Buffer.from('cd'.repeat(32), 'hex'), {}).unreadable, true);
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'ahgfamily_credentials'").get().value;
  assert.ok(!stored.includes('fake-password-never-real'), 'password never stored in the clear');
  const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'ahgfamily.credentials'").get();
  assert.ok(!audit.after.includes('fake-password'), 'password never audited');
});

test('refresh: stores the name↔id list in settings only; latch on auth failure; latched refuses before traffic', async () => {
  const s = await mapping.refreshYouthSelect(db, { fetchHtml: fetchImpl, key: KEY, actor: 'admin@example.com' });
  assert.equal(s.youth, 5);
  const stored = getSetting(db, 'ahgfamily_youth_select');
  assert.equal(stored.youth.length, 5);
  assert.ok(stored.fetchedAt);
  const run = db.prepare("SELECT * FROM sync_runs WHERE kind = 'pull' ORDER BY id DESC LIMIT 1").get();
  assert.equal(run.ok, 1);

  // one failed login latches everything (rule 8) …
  await assert.rejects(
    () => mapping.refreshYouthSelect(db, { fetchHtml: async () => { throw new FetchError(EXIT.AUTH, 'Login rejected.'); }, key: KEY }),
    (e) => e.code === 'latched',
  );
  assert.ok(mapping.getLatch(db));
  // … and a latched tracker never even calls the fetcher
  const before = fetchCalls;
  await assert.rejects(() => mapping.refreshYouthSelect(db, { fetchHtml: fetchImpl, key: KEY }), (e) => e.code === 'latched');
  assert.equal(fetchCalls, before);
  // re-entering credentials clears the latch
  mapping.storeCredentials(db, { email: 'leader@example.com', password: 'fake-password-never-real' }, 'admin@example.com', KEY);
  assert.equal(mapping.getLatch(db), null);
});

test('suggestions: unique name matches only — nickname counts, ambiguity drops, mapped youth excluded', () => {
  const bea = addGirl('Bea', 'Anders');                       // "Bea Anders" — First Last format
  const cora = addGirl('Cora', 'Blake');                      // "Blake, Cora" — Last, First format
  const fern = addGirl('Fernanda', 'G’Dell', { nickname: 'Fern' }); // nickname + curly apostrophe
  const ada1 = addGirl('Ada', 'Twin');                        // two youth options share this name
  addGirl('Zoe', 'Unlisted');                                 // no youth option at all
  const v = mapping.mappingView(db);
  const byGirl = new Map(v.suggestions.map((s) => [s.girlId, s.ahgYouthId]));
  assert.equal(byGirl.get(bea), 'utest0000001');
  assert.equal(byGirl.get(cora), 'utest0000002');
  assert.equal(byGirl.get(fern), 'utest0000003');
  assert.equal(byGirl.has(ada1), false, 'two candidate ids = no suggestion');
  assert.equal(v.suggestions.length, 3);

  // a youth already mapped to some girl is never suggested again
  db.prepare('UPDATE girls SET ahg_youth_id = ? WHERE id = ?').run('utest0000001', bea);
  const v2 = mapping.mappingView(db);
  assert.ok(!v2.suggestions.some((s) => s.ahgYouthId === 'utest0000001'));
  db.prepare('UPDATE girls SET ahg_youth_id = NULL WHERE id = ?').run(bea);
});

test('admin API: credentials validation, mapping view, confirm applies with audit, conflicts refused', async () => {
  const leaderT = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  assert.equal((await get('/api/v1/admin/mapping', leaderT)).status, 403, 'admin only');
  assert.equal((await get('/api/v1/admin/ahgfamily/credentials', adminT, { method: 'POST', body: JSON.stringify({ email: 'x' }) })).status, 400);

  let r = await get('/api/v1/admin/mapping/refresh', adminT, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).youth, 5);

  r = await get('/api/v1/admin/mapping', adminT);
  const view = await r.json();
  assert.equal(view.latched, false);
  assert.equal(view.youth.length, 5);
  const bea = view.unmappedGirls.find((g) => g.lastName === 'Anders');
  assert.ok(view.suggestions.some((s) => s.girlId === bea.id && s.ahgYouthId === 'utest0000001'));

  r = await get('/api/v1/admin/mapping/confirm', adminT, { method: 'POST', body: JSON.stringify([{ girlId: bea.id, ahgYouthId: 'utest0000001' }]) });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).applied, [{ girlId: bea.id, ahgYouthId: 'utest0000001' }]);
  const g = db.prepare('SELECT * FROM girls WHERE id = ?').get(bea.id);
  assert.equal(g.ahg_youth_id, 'utest0000001');
  assert.equal(g.ahg_youth_id_source, 'mapped');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'girl.map'").get().n, 1);

  // already mapped (girl and youth id) → 409, atomically
  r = await get('/api/v1/admin/mapping/confirm', adminT, { method: 'POST', body: JSON.stringify([{ girlId: bea.id, ahgYouthId: 'utest0000009' }]) });
  assert.equal(r.status, 409);
  const other = view.unmappedGirls.find((g2) => g2.lastName === 'Unlisted');
  r = await get('/api/v1/admin/mapping/confirm', adminT, { method: 'POST', body: JSON.stringify([{ girlId: other.id, ahgYouthId: 'utest0000001' }]) });
  assert.equal(r.status, 409);
  assert.equal(db.prepare('SELECT ahg_youth_id FROM girls WHERE id = ?').get(other.id).ahg_youth_id, null);

  // the mapped youth now carries her girlId in the view
  const view2 = await (await get('/api/v1/admin/mapping', adminT)).json();
  assert.equal(view2.youth.find((y) => y.id === 'utest0000001').girlId, bea.id);

  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.ahgfamily, 'ok');
});

test('admin API: a live latch surfaces as 409 on refresh and in /health', async () => {
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  const failing = fetchImpl;
  fetchImpl = async () => { throw new FetchError(EXIT.AUTH, 'Login rejected.'); };
  let r = await get('/api/v1/admin/mapping/refresh', adminT, { method: 'POST' });
  assert.equal(r.status, 409, 'the failing call latches and reports it');
  assert.equal((await r.json()).latched, true);
  fetchImpl = failing;
  r = await get('/api/v1/admin/mapping/refresh', adminT, { method: 'POST' });
  assert.equal(r.status, 409, 'latched now refuses');
  assert.equal((await (await fetch(base + '/health')).json()).ahgfamily, 'latched');
  // re-entering credentials clears it
  r = await get('/api/v1/admin/ahgfamily/credentials', adminT, { method: 'POST', body: JSON.stringify({ email: 'leader@example.com', password: 'fake-password-never-real' }) });
  assert.equal(r.status, 200);
  assert.equal((await get('/api/v1/admin/mapping/refresh', adminT, { method: 'POST' })).status, 200);
});
