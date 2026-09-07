'use strict';
// Website-managed leaders/admins (server/lib/access.js): stored lists merge
// with .env at every request; .env entries are the recovery hatch and can
// never be removed through the API. Offline (local JWKS).
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { makeConfig } = require('../server/config');
const { openDb, migrate } = require('../server/db');
const { createApp } = require('../server/app');

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000002';

let keys; let jwks; let db; let server; let base;

async function token(email) {
  return new SignJWT({ scp: 'access_as_leader', preferred_username: email })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(CLIENT)
    .setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
}
const get = (p, t, init = {}) => fetch(base + p, { ...init, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), 'Content-Type': 'application/json', ...(init.headers || {}) } });
const me = async (email) => get('/api/v1/me', await token(email));
const post = async (email, body) => get('/api/v1/admin/access', await token(email), { method: 'POST', body: JSON.stringify(body) });

test.before(async () => {
  keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] });
  const cfg = makeConfig({
    MSAL_TENANT_ID: TENANT, MSAL_CLIENT_ID: CLIENT,
    ADMIN_EMAILS: 'bootstrap-admin@example.com', DB_PATH: ':memory:',
  });
  db = openDb(':memory:');
  migrate(db);
  const app = createApp({ cfg, db, jwks });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

test('an .env admin is a leader too, with no LEADER_EMAILS at all', async () => {
  const r = await me('bootstrap-admin@example.com');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).role, 'admin');
  assert.equal((await me('stranger@example.com')).status, 403);
});

test('admins manage users through the API; changes apply immediately', async () => {
  let r = await get('/api/v1/admin/access', await token('bootstrap-admin@example.com'));
  assert.equal(r.status, 200);
  let v = await r.json();
  assert.deepEqual(v.env.adminEmails, ['bootstrap-admin@example.com']);
  assert.deepEqual(v.leaderEmails, []);

  assert.equal((await me('coordinator@example.com')).status, 403, 'not yet added');
  r = await post('bootstrap-admin@example.com', { leaderEmails: ['New.Leader@Example.com'], adminEmails: ['coordinator@example.com'] });
  assert.equal(r.status, 200);
  v = await r.json();
  assert.deepEqual(v.leaderEmails, ['new.leader@example.com'], 'stored lowercase');

  assert.equal((await (await me('new.leader@example.com')).json()).role, 'leader');
  assert.equal((await (await me('coordinator@example.com')).json()).role, 'admin', 'admin implies leader');

  // the new admin can herself manage the lists
  r = await post('coordinator@example.com', { leaderEmails: [], adminEmails: ['coordinator@example.com'] });
  assert.equal(r.status, 200);
  assert.equal((await me('new.leader@example.com')).status, 403, 'removal applies immediately');

  const audit = await (await get('/api/v1/admin/audit', await token('coordinator@example.com'))).json();
  assert.equal(audit[0].action, 'access.update');
});

test('guard rails: no self-lockout, .env entries immovable, junk rejected, admin only', async () => {
  let r = await post('coordinator@example.com', { leaderEmails: [], adminEmails: [] });
  assert.equal(r.status, 409, 'would remove her own admin access');
  assert.match((await r.json()).error, /your own admin/);

  // the bootstrap admin CAN clear the stored lists — .env keeps them admin
  r = await post('bootstrap-admin@example.com', { leaderEmails: [], adminEmails: [] });
  assert.equal(r.status, 200);
  assert.equal((await (await me('bootstrap-admin@example.com')).json()).role, 'admin', '.env admin survives everything');
  assert.equal((await me('coordinator@example.com')).status, 403);

  assert.equal((await post('bootstrap-admin@example.com', { leaderEmails: ['not-an-email'], adminEmails: [] })).status, 400);
  assert.equal((await post('bootstrap-admin@example.com', { leaderEmails: 'x', adminEmails: [] })).status, 400);

  // restore a leader, then confirm a plain leader cannot touch the lists
  await post('bootstrap-admin@example.com', { leaderEmails: ['plain@example.com'], adminEmails: [] });
  assert.equal((await post('plain@example.com', { leaderEmails: [], adminEmails: [] })).status, 403);
  assert.equal((await get('/api/v1/admin/access', await token('plain@example.com'))).status, 403);
});
