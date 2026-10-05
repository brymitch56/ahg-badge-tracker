'use strict';
/**
 * AHGFamily second factor: the trusted browser, and Connect.
 *
 * AHGFamily (2026-10) texts a sign-in code whenever a password sign-in comes
 * from a browser it does not trust. The tracker signs in fresh on every run
 * and logs out after, so without this module EVERY scheduled pull would text
 * the account holder — and, before this, the code page was not even
 * recognised as an auth problem, so the 10-minute scheduler would have kept
 * texting until someone noticed.
 *
 * The design (same as troop-checkin's lib/portalSession, adapted):
 *   1. An admin presses Connect on the website Admin page. The tracker posts
 *      the password; AHGFamily texts a code; the half-signed-in cookies and
 *      the code form are PARKED here, encrypted, for 15 minutes.
 *   2. The admin types the code. The tracker posts it with "Trust this
 *      browser for 30 days" ON and keeps the resulting trusted_device cookie
 *      (encrypted, bound to the account e-mail), clears the latch, logs out.
 *   3. Every later run's password sign-in offers that cookie, so AHGFamily
 *      lets it in without a code — until the trust lapses, when the run
 *      latches with "code required" and the admin presses Connect again.
 *
 * Deliberately not built: reading the code automatically (an SMS relay). A
 * person typing it about once a month IS the second factor.
 *
 * Everything at rest is AES-256-GCM via credcrypto, like the password.
 */
const A = require('../../lib/ahgfamily');
const { getSetting, setSetting } = require('./settings');
const cred = require('./credcrypto');

const TRUST_KEY = 'ahgfamily_trust';
const CHALLENGE_KEY = 'ahgfamily_challenge';
const CHALLENGE_TTL_MS = 15 * 60 * 1000;

const normEmail = (e) => String(e || '').trim().toLowerCase();
const mapping = () => require('./mapping'); // lazy: mapping requires this module

function sealJson(obj, key) { return cred.encrypt(JSON.stringify(obj), key || cred.loadKey()); }
function openJson(box, key) {
  if (!box) return null;
  let raw;
  try { raw = cred.decrypt(box, key || cred.loadKey()); } catch { return null; }
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
const expiryOf = (lines) => Math.max(0, ...lines.map((l) => Date.parse((/;\s*Expires=([^;]+)/i.exec(l) || [])[1]) || 0));

// --------------------------------------------------------------- trust ----
/** Store the jar's trust cookie(s) for this account. No trust cookie → no-op. */
function saveTrust(db, jar, email, key = null) {
  const lines = jar.trustLines();
  if (!lines.length) return null;
  const until = expiryOf(lines);
  setSetting(db, TRUST_KEY, {
    savedAt: new Date().toISOString(),
    expiresAt: until ? new Date(until).toISOString() : null,
    box: sealJson({ lines, email: normEmail(email) }, key),
  });
  return until ? new Date(until).toISOString() : null;
}

/** Trust cookie lines for this account, or null (missing, expired, other account, unreadable). */
function loadTrust(db, email, key = null) {
  const t = getSetting(db, TRUST_KEY);
  if (!t) return null;
  if (t.expiresAt && Date.parse(t.expiresAt) <= Date.now()) { setSetting(db, TRUST_KEY, null); return null; }
  const p = openJson(t.box, key);
  if (!p || !Array.isArray(p.lines) || !p.lines.length || p.email !== normEmail(email)) return null;
  return p.lines;
}

const clearTrust = (db) => setSetting(db, TRUST_KEY, null);

/**
 * THE sign-in every AHGFamily caller uses: password + stored trust; a
 * renewed trust cookie is saved on the way out. Throws whatever A.login
 * throws (EXIT.AUTH with e.kind for a code prompt or the enrollment fence),
 * so the callers' latch handling is unchanged.
 */
async function signIn(db, acfg, jar, key = null) {
  let out;
  try {
    out = await A.login(acfg, jar, { trust: loadTrust(db, acfg.email, key) });
  } catch (e) {
    // A scheduled run that set off a text parks the prompt too, so whoever
    // received it can enter THAT code (15 min) instead of pressing Connect
    // and being texted a second one. The caller still latches.
    if (e instanceof A.FetchError && e.kind === 'code_required') {
      try { parkChallenge(db, { cookies: e.cookies, challenge: e.challenge }, key); } catch { /* best effort */ }
    }
    throw e;
  }
  try { saveTrust(db, jar, acfg.email, key); } catch { /* storing is best effort */ }
  return out;
}

// ------------------------------------------------------- parked prompt ----
function parkChallenge(db, { cookies, challenge }, key = null) {
  const id = require('crypto').randomBytes(9).toString('base64url');
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  setSetting(db, CHALLENGE_KEY, { id, createdAt, expiresAt, prompt: challenge.prompt || null, box: sealJson({ cookies, challenge }, key) });
  return { id, createdAt, expiresAt, prompt: challenge.prompt || null };
}
function getChallenge(db, key = null) {
  const c = getSetting(db, CHALLENGE_KEY);
  if (!c) return null;
  if (Date.parse(c.expiresAt) < Date.now()) { setSetting(db, CHALLENGE_KEY, null); return null; }
  const p = openJson(c.box, key);
  return p ? { id: c.id, expiresAt: c.expiresAt, prompt: c.prompt, ...p } : null;
}
const clearChallenge = (db) => setSetting(db, CHALLENGE_KEY, null);

/** Safe summary for the admin page — never cookies or form internals. */
function status(db) {
  const t = getSetting(db, TRUST_KEY);
  const c = getSetting(db, CHALLENGE_KEY);
  const pending = c && Date.parse(c.expiresAt) >= Date.now() ? { id: c.id, createdAt: c.createdAt, expiresAt: c.expiresAt, prompt: c.prompt } : null;
  return {
    trustedUntil: t && t.expiresAt && Date.parse(t.expiresAt) > Date.now() ? t.expiresAt : null,
    pending,
  };
}

// ------------------------------------------------------------- connect ----
function creds(db, key, env) {
  const c = mapping().getCredentials(db, key, env);
  if (!c) throw Object.assign(new Error('no AHGFamily credentials — enter them first'), { code: 'noconfig' });
  if (c.unreadable) throw Object.assign(new Error('stored AHGFamily credentials are unreadable (CRED_KEY missing or changed) — re-enter them'), { code: 'noconfig' });
  return c;
}

const audit = (db, actor, action, after) => db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(new Date().toISOString(), actor, action, 'settings', TRUST_KEY, null, JSON.stringify(after));

async function logout(acfg, jar) { try { await A.request(acfg, jar, '/logout'); } catch { /* best effort */ } }

/**
 * Admin "Connect": one deliberate sign-in, allowed while latched (it is the
 * human action that clears the latch). Results:
 *   { connected: true, trustedUntil }       — signed in (trusted, or no MFA)
 *   { codeRequired: true, pending }         — a code was texted; enter it
 * A rejected password re-latches; the enrollment fence throws 'enroll'.
 */
async function connect(db, { key = null, env = process.env, actor = 'admin' } = {}) {
  const c = creds(db, key, env);
  const acfg = { ...A.makeConfig(env), email: c.email, password: c.password };
  const jar = new A.CookieJar();
  try {
    await signIn(db, acfg, jar, key);
  } catch (e) {
    if (e instanceof A.FetchError && e.kind === 'code_required') {
      const pending = status(db).pending || parkChallenge(db, { cookies: e.cookies, challenge: e.challenge }, key); // signIn parked it
      audit(db, actor, 'ahgfamily.connect', { codeRequired: true });
      return { codeRequired: true, pending };
    }
    if (e instanceof A.FetchError && e.kind === 'enroll') throw Object.assign(new Error(e.message), { code: 'enroll' });
    if (e instanceof A.FetchError && e.code === A.EXIT.AUTH) {
      mapping().setLatch(db, e.message);
      throw Object.assign(new Error(e.message), { code: 'latched' });
    }
    throw e;
  }
  await logout(acfg, jar);
  mapping().clearLatch(db);
  clearChallenge(db);
  audit(db, actor, 'ahgfamily.connect', { connected: true, latchCleared: true });
  return { connected: true, ...status(db) };
}

/** Finish a parked Connect with the code. */
async function enterCode(db, { code, key = null, env = process.env, actor = 'admin' } = {}) {
  const parked = getChallenge(db, key);
  if (!parked) throw Object.assign(new Error('That code prompt has expired — press Connect for a new code.'), { code: 'expired' });
  const c = creds(db, key, env);
  const acfg = { ...A.makeConfig(env), email: c.email, password: c.password };
  const jar = new A.CookieJar();
  jar.absorbLines(parked.cookies);
  try {
    await A.submitCode(acfg, jar, parked.challenge, code);
  } catch (e) {
    if (e instanceof A.FetchError && e.kind === 'code_rejected') {
      // same text message stays usable: re-park the refreshed form
      parkChallenge(db, { cookies: e.cookies, challenge: e.challenge }, key);
      throw Object.assign(new Error(e.message), { code: 'rejected' });
    }
    if (e instanceof A.FetchError && e.code === A.EXIT.CONFIG) throw Object.assign(new Error(e.message), { code: 'bad' });
    clearChallenge(db);
    throw Object.assign(new Error(e.message), { code: e.kind === 'enroll' ? 'enroll' : 'expired' });
  }
  const trustedUntil = saveTrust(db, jar, c.email, key);
  await logout(acfg, jar);
  clearChallenge(db);
  mapping().clearLatch(db);
  audit(db, actor, 'ahgfamily.code', { connected: true, trusted: !!trustedUntil, latchCleared: true });
  return { connected: true, ...status(db) };
}

module.exports = {
  TRUST_KEY, CHALLENGE_KEY, CHALLENGE_TTL_MS,
  saveTrust, loadTrust, clearTrust, signIn,
  parkChallenge, getChallenge, clearChallenge, status,
  connect, enterCode,
};
