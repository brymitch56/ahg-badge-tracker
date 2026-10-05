'use strict';
// AHGFamily second factor (lib/ahgfamily.js + server/lib/ahgtrust.js).
//
// AHGFamily texts a sign-in code unless the browser is trusted. These tests
// drive a MOCK AHGFamily that behaves that way: a code page with a trust box
// (a checkbox widget backed by a text input) and verify/resend buttons
// sharing one name; a 30-day trusted_device cookie for a verified sign-in
// with trust on; an MFA-setup fence for an account that has not enrolled.
// They prove: the code page LATCHES (so the 10-minute scheduler can never
// text anyone twice), Connect + code earns the trust, later sign-ins skip the
// code, and the fence is a clear error. All values are synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { openDb, migrate } = require('../server/db');
const A = require('../lib/ahgfamily');
const mapping = require('../server/lib/mapping');
const ahgtrust = require('../server/lib/ahgtrust');
const { getSetting } = require('../server/lib/settings');

const KEY = Buffer.from('cd'.repeat(32), 'hex');
const EMAIL = 'fake-leader@example.com';
const PASSWORD = 'fake-password-never-real';
const CODE = '246810';
const CSRF = 'MockCsrf' + 'E'.repeat(40);
const TRUST = 'fake-trust-token-' + 'f'.repeat(32);
const DAY = 864e5;

const loginPage = () => `<html><head><meta name="csrf-token" content="${CSRF}"></head><body><form method="post">
  <input type="hidden" name="_csrf" value="${CSRF}"><input name="LoginForm[email]"><input type="password" name="LoginForm[password]"></form></body></html>`;
const verifyPage = () => `<html><head><meta name="csrf-token" content="${CSRF}"><title>Verify Login</title></head><body>
  <h1>Verify Login</h1>
  <div class="alert">Enter the verification code sent to the mobile number on your account to complete sign-in.</div>
  <form id="sms-verify-form" action="/site/sms-verify" method="post">
    <input type="hidden" name="_csrf" value="${CSRF}">
    <input type="text" id="sms-verify-code" name="code" maxlength="6">
    <input type="text" id="w0" name="trust_device" value="1"> Trust this browser for 30 days
    <button type="submit" name="sms_action" value="verify">Verify &amp; Continue</button>
    <button type="submit" name="sms_action" value="resend">Resend Code</button>
  </form></body></html>`;
const gatePage = () => `<html><head><title>Account Security</title></head><body><div id="mfa-is-gated"></div>
  <input type="checkbox" id="mfa-sms-agreement"><button id="mfa-sms-send">Text Me a Code</button></body></html>`;
const indexPage = () => `<html><head><meta name="csrf-token" content="${CSRF}"></head><body>
  <select id="youth-select" multiple><option value="utest0000001">Bea Anders</option></select></body></html>`;

// ------------------------------------------------------------ mock portal --
const st = { enrolled: true, texts: 0, verifyPosts: [], loginPosts: 0, live: new Set(), n: 1 };
const cookieOf = (req, name) => (new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.headers.cookie || '') || [])[1];
let server; let base;

test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const sess = cookieOf(req, 'PHPSESSID') || '';
      const go = (loc, cookies = []) => { res.writeHead(302, { Location: loc, 'Set-Cookie': cookies }); res.end(); };
      const html = (s) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(s); };
      if (sess.startsWith('gated-')) return url.pathname === '/user/mfa-setup' ? html(gatePage()) : go('/user/mfa-setup');
      if (url.pathname === '/login' && req.method === 'GET') return st.live.has(sess) ? go('/dashboard/index') : html(loginPage());
      if (url.pathname === '/login' && req.method === 'POST') {
        st.loginPosts += 1;
        const p = new URLSearchParams(body);
        if (p.get('LoginForm[email]') !== EMAIL || p.get('LoginForm[password]') !== PASSWORD) return html(loginPage());
        if (!st.enrolled) return go('/user/mfa-setup', [`PHPSESSID=gated-${st.n++}; Path=/`]);
        if (cookieOf(req, 'trusted_device') === TRUST) { const s = `ok-${st.n++}`; st.live.add(s); return go('/dashboard/index', [`PHPSESSID=${s}; Path=/`]); }
        st.texts += 1;
        return go('/site/sms-verify', [`PHPSESSID=half-${st.n++}; Path=/`]);
      }
      if (url.pathname === '/site/sms-verify' && req.method === 'GET') return html(verifyPage());
      if (url.pathname === '/site/sms-verify' && req.method === 'POST') {
        const p = new URLSearchParams(body);
        st.verifyPosts.push(Object.fromEntries(p));
        if (!sess.startsWith('half-') || p.get('_csrf') !== CSRF) { res.writeHead(400); return res.end(); }
        if (p.get('sms_action') !== 'verify' || p.get('code') !== CODE) return html(verifyPage());
        const s = `ok-${st.n++}`; st.live.add(s);
        const cookies = [`PHPSESSID=${s}; Path=/`, '_identity=deleted; expires=Thu, 01-Jan-1970 00:00:01 GMT; Max-Age=0; Path=/'];
        if (p.get('trust_device') === '1') cookies.push(`trusted_device=${TRUST}; expires=${new Date(Date.now() + 30 * DAY).toUTCString()}; Max-Age=2592000; Path=/; Secure; HttpOnly`);
        return go('/dashboard/index', cookies);
      }
      if (url.pathname === '/dashboard/index') return st.live.has(sess) ? html('<html>Dashboard</html>') : go('/login');
      if (url.pathname === '/advancement/index') return st.live.has(sess) ? html(indexPage()) : go('/login');
      if (url.pathname === '/logout') { st.live.delete(sess); return go('/login'); }
      res.writeHead(404); return res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

let db;
const env = () => ({ AHG_BASE: base, AHG_THROTTLE_MS: '0' });
const fresh = () => {
  db = openDb(':memory:');
  migrate(db);
  mapping.storeCredentials(db, { email: EMAIL, password: PASSWORD }, 'test', KEY);
};

// --------------------------------------------------------- shape parsing --
test('parseCodeForm: trust box on, the verify button (never resend), the prompt', () => {
  const c = A.parseCodeForm(verifyPage(), '/login');
  assert.equal(c.action, '/site/sms-verify');
  assert.equal(c.field, 'code');
  assert.deepEqual(c.options, { trust_device: '1' });
  assert.deepEqual(c.submit, { name: 'sms_action', value: 'verify' });
  assert.match(c.prompt, /^Enter the verification code sent/);
  assert.equal(A.parseCodeForm(loginPage()), null, 'the login form is not a code prompt');
  assert.equal(A.parseCodeForm(indexPage()), null);
});

test('CookieJar: only a persistent trust cookie counts as trust; deletion forgets it', () => {
  const jar = new A.CookieJar();
  const in30 = new Date(Date.now() + 30 * DAY).toUTCString();
  jar.absorbLines([`trusted_device=${TRUST}; expires=${in30}; Path=/; Secure`, 'PHPSESSID=x; Path=/', `_identity=y; expires=${in30}`]);
  assert.equal(jar.trustLines().length, 1);
  jar.absorbLines(['trusted_device=deleted; expires=Thu, 01-Jan-1970 00:00:01 GMT; Path=/']);
  assert.equal(jar.trustLines().length, 0);
});

// ---------------------------------------------------- the scheduler path --
test('a code page during a background sign-in LATCHES — one text, then silence', async () => {
  fresh();
  const texts = st.texts;
  await assert.rejects(mapping.refreshYouthSelect(db, { key: KEY, env: env() }), (e) => e.code === 'latched');
  assert.equal(st.texts, texts + 1);
  assert.ok(mapping.getLatch(db), 'all AHGFamily traffic is latched');
  assert.match(mapping.getLatch(db).error, /sign-in code/);
  // the next tick refuses before any traffic: no second text
  const posts = st.loginPosts;
  await assert.rejects(mapping.refreshYouthSelect(db, { key: KEY, env: env() }), (e) => e.code === 'latched');
  assert.equal(st.loginPosts, posts);
  assert.equal(st.texts, texts + 1);
  // and the text it did cause is answerable from the admin page
  assert.ok(ahgtrust.status(db).pending, 'the prompt was parked for the admin');
});

test('entering THAT code clears the latch and earns ~30 days of trust', async () => {
  const r = await ahgtrust.enterCode(db, { code: CODE, key: KEY, env: env(), actor: 'admin@example.com' });
  assert.equal(r.connected, true);
  const sent = st.verifyPosts.at(-1);
  assert.equal(sent.trust_device, '1');
  assert.equal(sent.sms_action, 'verify');
  assert.equal(mapping.getLatch(db), null);
  assert.equal(r.pending, null);
  const days = (Date.parse(r.trustedUntil) - Date.now()) / DAY;
  assert.ok(days > 29 && days <= 30, `trusted ~30 days, got ${days}`);
  assert.doesNotMatch(JSON.stringify(getSetting(db, 'ahgfamily_trust')), /fake-trust-token/, 'encrypted at rest');
});

test('later background sign-ins offer the trust and need no code', async () => {
  const texts = st.texts;
  const s = await mapping.refreshYouthSelect(db, { key: KEY, env: env() });
  assert.equal(s.youth, 1);
  assert.equal(st.texts, texts, 'no text message');
  assert.equal(mapping.getLatch(db), null);
});

test('the trust is never offered for a different account', () => {
  assert.ok(ahgtrust.loadTrust(db, EMAIL.toUpperCase(), KEY));
  assert.equal(ahgtrust.loadTrust(db, 'someone-else@example.com', KEY), null);
});

// ------------------------------------------------------------- Connect ----
test('Connect: a wrong code is refused but the same text stays usable', async () => {
  fresh();
  const r = await ahgtrust.connect(db, { key: KEY, env: env() });
  assert.equal(r.codeRequired, true);
  assert.match(r.pending.prompt, /verification code/);
  await assert.rejects(ahgtrust.enterCode(db, { code: '000000', key: KEY, env: env() }), (e) => e.code === 'rejected');
  assert.ok(ahgtrust.status(db).pending, 'still answerable');
  const ok = await ahgtrust.enterCode(db, { code: CODE, key: KEY, env: env() });
  assert.ok(ok.trustedUntil);
});

test('Connect while trusted signs straight in — no text', async () => {
  const texts = st.texts;
  const r = await ahgtrust.connect(db, { key: KEY, env: env() });
  assert.equal(r.connected, true);
  assert.equal(st.texts, texts);
});

test('an expired prompt cannot be answered', async () => {
  fresh();
  await ahgtrust.connect(db, { key: KEY, env: env() });
  const c = getSetting(db, 'ahgfamily_challenge');
  require('../server/lib/settings').setSetting(db, 'ahgfamily_challenge', { ...c, expiresAt: new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(ahgtrust.enterCode(db, { code: CODE, key: KEY, env: env() }), (e) => e.code === 'expired');
});

test('an account that has not enrolled: a clear error, latched, nothing to type', async () => {
  fresh();
  st.enrolled = false;
  await assert.rejects(mapping.refreshYouthSelect(db, { key: KEY, env: env() }), (e) => e.code === 'latched');
  assert.match(mapping.getLatch(db).error, /two-step sign-in/);
  assert.equal(ahgtrust.status(db).pending, null);
  await assert.rejects(ahgtrust.connect(db, { key: KEY, env: env() }), (e) => e.code === 'enroll');
  st.enrolled = true;
});

test('a rejected password at Connect re-latches (never retried)', async () => {
  fresh();
  mapping.storeCredentials(db, { email: EMAIL, password: 'fake-wrong-password' }, 'test', KEY);
  await assert.rejects(ahgtrust.connect(db, { key: KEY, env: env() }), (e) => e.code === 'latched');
  assert.ok(mapping.getLatch(db));
});

// ---------------------------------------------------------- admin routes --
test('routes: admin-only; Connect parks a prompt, the code connects, status never leaks cookies', async () => {
  const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
  const { makeConfig } = require('../server/config');
  const { createApp } = require('../server/app');
  const TENANT = '00000000-0000-0000-0000-000000000001';
  const CLIENT = '00000000-0000-0000-0000-000000000002';
  const GROUP = '00000000-0000-0000-0000-000000000003';
  const keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] });
  const tok = (who) => new SignJWT({ scp: 'access_as_leader', groups: [GROUP], preferred_username: who })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
    .setAudience(CLIENT).setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
  const cfg = makeConfig({ MSAL_TENANT_ID: TENANT, MSAL_CLIENT_ID: CLIENT, LEADER_GROUP_ID: GROUP, ADMIN_EMAILS: 'admin@example.com', DB_PATH: ':memory:', CRED_KEY: KEY.toString('hex') });
  fresh();
  const app = createApp({ cfg, db, jwks });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const at = `http://127.0.0.1:${srv.address().port}/api/v1`;
  const saved = { AHG_BASE: process.env.AHG_BASE, AHG_THROTTLE_MS: process.env.AHG_THROTTLE_MS };
  process.env.AHG_BASE = base; process.env.AHG_THROTTLE_MS = '0';
  try {
    const admin = await tok('admin@example.com');
    const leader = await tok('leader@example.com');
    const call = (p, t, body) => fetch(at + p, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await call('/admin/ahgfamily/connect', leader, {})).status, 403);
    const c = await (await call('/admin/ahgfamily/connect', admin, {})).json();
    assert.equal(c.codeRequired, true);
    const s1 = await (await call('/admin/ahgfamily/signin', admin)).json();
    assert.ok(s1.pending && s1.pending.expiresAt);
    assert.doesNotMatch(JSON.stringify(s1), /PHPSESSID|_csrf|half-/, 'no cookies or form internals');
    const bad = await call('/admin/ahgfamily/code', admin, { code: '000000' });
    assert.equal(bad.status, 422);
    const ok = await (await call('/admin/ahgfamily/code', admin, { code: CODE })).json();
    assert.equal(ok.connected, true);
    assert.ok(ok.trustedUntil);
    const sync = await (await call('/sync/status', admin)).json();
    assert.ok(sync.ahgSignIn.trustedUntil);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    srv.close();
  }
});
