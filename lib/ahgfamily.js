'use strict';
/**
 * ahgfamily.js — authenticated, READ-ONLY HTTP client for AHGFamily.org.
 *
 * Login flow is the one proven against Trail Life Connect (same Yii2
 * platform) in troop-checkin's server/scripts/fetch-roster.js:
 *   1. GET  /login   → _csrf hidden input (or csrf-token meta) + cookies
 *   2. POST /login   → LoginForm[email] / LoginForm[password]; 302 on success
 *   3. keep every cookie in a hand-rolled jar; follow redirects manually so
 *      cookies set mid-chain are absorbed
 *   4. XHR calls send X-CSRF-Token + X-Requested-With: XMLHttpRequest and the
 *      _csrf field in the body
 *
 * Second factor (2026-10): a password may be answered by a texted-code form
 * or an MFA-enrollment fence; both are thrown as EXIT.AUTH (so they latch)
 * with `e.kind`, and the code is finished by submitCode() from the admin's
 * Connect screen — see "second factor" below and server/lib/ahgtrust.js.
 *
 * Allowed endpoints (see CLAUDE.md): GET /login, POST /login, GET /logout,
 * GET+POST /site/sms-verify (sign-in code), GET /user/mfa-setup (recognised, never used),
 * GET /advancement/index, POST /advancement/badge-tracker-view, and for
 * Service Stars GET /activities and GET /profile/<youthHashid>.
 * `ALLOWED_PATHS` / `ALLOWED_PATTERNS` below are enforced in request() so a
 * future edit cannot accidentally reach a data-changing endpoint from this
 * module; `FORBIDDEN_PATH_RE` names the write endpoints that are never
 * called (toggleServiceVerified is a GET that writes).
 *
 * Credentials never appear in logs, errors, or written files.
 */

require('./env');

// ---------------------------------------------------------------- errors ---
class FetchError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}
const fail = (code, msg) => { throw new FetchError(code, msg); };

// Exit codes: 1 config · 2 auth · 3 fetch · 4 parse
const EXIT = { CONFIG: 1, AUTH: 2, FETCH: 3, PARSE: 4 };

// ---------------------------------------------------------------- config ---
function makeConfig(env = process.env) {
  return {
    email: env.AHG_EMAIL || '',
    password: env.AHG_PASSWORD || '',
    base: (env.AHG_BASE || 'https://www.ahgfamily.org').replace(/\/$/, ''),
    loginPath: env.AHG_LOGIN_PATH || '/login',
    throttleMs: Number(env.AHG_THROTTLE_MS) >= 0 && env.AHG_THROTTLE_MS !== undefined
      ? Number(env.AHG_THROTTLE_MS) : 300,
    userAgent: 'ahg-badge-tracker-catalog-fetch/0.1 (+self-hosted troop tool; read-only)',
  };
}

// --------------------------------------------------------- endpoint guard ---
// Path (no query) → allowed methods. Anything else throws BEFORE a request
// is made. This is the read-only rule from CLAUDE.md, in code.
const ALLOWED_PATHS = {
  '/': ['GET'],                             // site root — login/landing redirects pass through it
  '/login': ['GET', 'POST'],
  '/site/login': ['GET', 'POST'],
  '/logout': ['GET'],
  // Second factor (AHGFamily, 2026-10): part of signing in, not data. The
  // code form at /site/sms-verify is read after a password POST and posted
  // ONLY by submitCode() with a code a person typed; /user/mfa-setup is the
  // fence an un-enrolled account is parked on — read to recognise it, and
  // nothing on it is ever pressed (enrolling is a person's job, in a browser).
  '/site/sms-verify': ['GET', 'POST'],
  '/user/mfa-setup': ['GET'],
  '/dashboard': ['GET'],                    // where the login 302 lands
  '/dashboard/index': ['GET'],
  '/advancement/index': ['GET'],            // POST here is the Standard-view SAVE — never
  '/advancement/badge-tracker-view': ['POST'],
  // Roster export (read-only; the same flow troop-checkin's fetch-roster.js
  // uses). Used only by scripts/roster-headers.js, which keeps the file in
  // memory and prints column headers — never rows.
  '/user/index': ['GET'],
  '/user/exportexcel': ['GET'],            // AHGFamily's export URL (TLC uses /user/index?export=)
  '/databuilder/get-download-status': ['POST'],
  // Service Stars read side (docs/service-stars-plan.md): the troop-wide
  // activities ledger (identity + verified flag; its hours are truncated)
  // and the per-girl profile page (precise ledger, eligibility, awards).
  '/activities': ['GET'],
  '/profile': ['GET'],                      // /profile?id=<youthHashid>
};
// Path patterns for ids-in-path pages (GET only, read-only).
const ALLOWED_PATTERNS = [
  { re: /^\/profile\/u[a-z0-9]{11}$/, methods: ['GET'] },   // /profile/<youthHashid>?tab=advancement
];
// Endpoints that WRITE and are never called, whatever the method — listed
// so a future edit cannot add them by accident and so a crawler that
// followed hrefs would be stopped here. (`toggleServiceVerified` is a GET
// that flips a service-hours approval; the rest edit or delete records.)
const FORBIDDEN_PATH_RE = /^\/(fields\/toggleServiceVerified(\/|$)|advancement\/(delete|process-advancement|update)(\/|$)|fields\/activities-update(\/|$)|fields\/service-update(\/|$))/;
function assertAllowed(cfg, pathOrUrl, method) {
  const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : cfg.base + pathOrUrl);
  const p = url.pathname.replace(/\/$/, '') || '/';
  if (FORBIDDEN_PATH_RE.test(p)) {
    throw new FetchError(EXIT.CONFIG, `Refusing ${method} ${p}: that endpoint changes data on AHGFamily and is never called (see CLAUDE.md).`);
  }
  const allowed = ALLOWED_PATHS[p] || (ALLOWED_PATTERNS.find((x) => x.re.test(p)) || {}).methods;
  if (!allowed || !allowed.includes(method)) {
    throw new FetchError(EXIT.CONFIG,
      `Refusing ${method} ${url.pathname}: not in the read-only allow-list (see CLAUDE.md).`);
  }
}

// ------------------------------------------------------------ cookie jar ---
// Device-trust cookie names: AHGFamily sets "trusted_device" when the code is
// entered with "Trust this browser for 30 days" on. Matched only against
// cookies that carry a future expiry.
const TRUST_COOKIE_RE = /trust|device/i;

// Keeps every cookie the site sets, honours deletions (empty value, Max-Age
// <= 0, a past Expires), last write wins, and remembers each cookie's expiry
// so the long-lived trust cookie can be told apart from the session.
class CookieJar {
  constructor() { this.map = new Map(); this.expires = new Map(); }
  absorbLines(lines) {
    for (const line of lines || []) {
      if (!line) continue;
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      let del = value === '';
      let until = null;
      for (const attr of attrs) {
        const j = attr.indexOf('=');
        const key = (j < 0 ? attr : attr.slice(0, j)).trim().toLowerCase();
        const val = j < 0 ? '' : attr.slice(j + 1).trim();
        if (key === 'max-age') {
          if (Number(val) <= 0) del = true;
          else until = Date.now() + Number(val) * 1000; // Max-Age beats Expires
        }
        if (key === 'expires') {
          const d = new Date(val);
          if (!isNaN(d) && d.getTime() < Date.now()) del = true;
          else if (!isNaN(d) && until === null) until = d.getTime();
        }
      }
      if (del) { this.map.delete(name); this.expires.delete(name); continue; }
      this.map.set(name, value);
      if (until !== null) this.expires.set(name, until);
      else if (attrs.length) this.expires.delete(name); // re-set as a session cookie
    }
  }
  // "name=value" lines — what a parked code prompt stores.
  lines() { return [...this.map].map(([k, v]) => `${k}=${v}`); }
  // The persistent trust cookie(s), with Expires so a restore keeps the date.
  trustLines() {
    const out = [];
    for (const [k, v] of this.map) {
      const until = this.expires.get(k);
      if (!until || until <= Date.now() || !TRUST_COOKIE_RE.test(k)) continue;
      out.push(`${k}=${v}; Expires=${new Date(until).toUTCString()}`);
    }
    return out;
  }
  absorb(res) {
    const lines = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [].concat(res.headers.get('set-cookie') || []);
    this.absorbLines(lines);
  }
  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
  get size() { return this.map.size; }
}

// --------------------------------------------------------------- request ---
// Manual redirect following so cookies set mid-chain (the session cookie on
// the login 302) are absorbed. Redirects are refetched as GET without the
// original body. Every hop is checked against the allow-list.
async function request(cfg, jar, pathOrUrl, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  assertAllowed(cfg, pathOrUrl, method);
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : cfg.base + pathOrUrl;
  const baseHeaders = () => ({
    'User-Agent': cfg.userAgent,
    'Accept-Language': 'en-US,en;q=0.9',
    ...(jar.size ? { Cookie: jar.header() } : {}),
    ...(opts.headers || {}),
  });
  const debug = /^(1|true)$/i.test(process.env.AHG_DEBUG || '');
  const trace = (r, u, m = method) => { if (debug) console.error(`[http] ${m} ${new URL(u).pathname} → ${r.status}${r.headers.get('location') ? ' → ' + new URL(r.headers.get('location'), u).pathname : ''}`); };
  let res = await fetch(url, { ...opts, method, headers: baseHeaders(), redirect: 'manual' });
  jar.absorb(res);
  trace(res, url);
  let hops = 0;
  let from = url;
  while (res.status >= 300 && res.status < 400 && res.headers.get('location') && hops++ < 5) {
    const next = new URL(res.headers.get('location'), from).toString();
    // A redirect to the login page mid-session means the session died.
    const nextPath = new URL(next).pathname;
    if (/\/(site\/)?login$/.test(nextPath) && !/\/(site\/)?login$/.test(new URL(from).pathname)) {
      res._authLost = true; // eslint-disable-line no-underscore-dangle
      res._finalUrl = next; // eslint-disable-line no-underscore-dangle
      return res;
    }
    assertAllowed(cfg, next, 'GET');
    const h = baseHeaders();
    delete h['Content-Type'];
    h.Cookie = jar.header();
    res = await fetch(next, { headers: h, redirect: 'manual' });
    jar.absorb(res);
    trace(res, next, 'GET');
    from = next;
  }
  res._redirected = hops > 0; // eslint-disable-line no-underscore-dangle
  res._finalUrl = from;       // eslint-disable-line no-underscore-dangle
  return res;
}

// ------------------------------------------------------------------ csrf ---
const decodeHtml = (s) => String(s)
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#0?34;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, '&');

// Yii2 renders the token as <meta name="csrf-token" content="..."> and as a
// hidden <input name="_csrf" value="..."> in the form. Prefer the meta tag.
function csrfFrom(html) {
  const meta = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
  if (meta) return decodeHtml(meta[1]);
  const hidden = html.match(/name=["']_csrf[^"']*["'][^>]*value=["']([^"']+)["']/i)
              || html.match(/value=["']([^"']+)["'][^>]*name=["']_csrf[^"']*["']/i);
  return hidden ? decodeHtml(hidden[1]) : null;
}

const looksLikeLoginPage = (html) => /LoginForm\[password\]/.test(html);

// --------------------------------------------------------- second factor ---
// AHGFamily (2026-10) answers a good password in one of three ways:
//   - a session, when this server is a trusted browser (trusted_device);
//   - a CODE FORM (/site/sms-verify) after texting the account holder: a
//     <form> with _csrf, `code`, a "Trust this browser for 30 days" control
//     (a checkbox widget backed by a TEXT input, trust_device) and two submit
//     buttons sharing a name (sms_action = verify | resend);
//   - the ENROLLMENT FENCE (/user/mfa-setup, marker #mfa-is-gated) for an
//     account that has not set MFA up: every page redirects there.
// The last two are thrown as EXIT.AUTH so every existing latch path stops
// all AHGFamily traffic at once — above all, no scheduled run may sign in
// again and text somebody a second code. `e.kind` says which, and a code
// prompt carries `e.challenge` for the admin's Connect screen to finish.
const CODE_FIELD_RE = /(^|[[\]_.\-])(code|otp|pin|token|mfa|2fa|verification|verifycode)/i;
const TRUST_FIELD_RE = /trust|remember/i;
const VERIFY_BUTTON_RE = /verify|confirm|continue|submit|sign.?in|log.?in/i;
const NOT_VERIFY_RE = /resend|send.*(new|again|another)|new code|back|cancel/i;

function attrOf(tagAttrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tagAttrs);
  if (!m) return null;
  const v = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
  return decodeHtml(v || '');
}

function isEnrollmentGate(html, url) {
  if (/\bid=["']mfa-is-gated["']/i.test(String(html || ''))) return true;
  try { return /\/(mfa|2fa|two-?factor)[-_]?setup\b/i.test(new URL(url).pathname); } catch { return false; }
}

// The sentence above the box ("Enter the verification code sent to …").
function codePrompt(html) {
  const text = String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '\n');
  for (const raw of decodeHtml(text).split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length > 4 && line.length <= 200 && /\bcodes?\b/i.test(line)) return line;
  }
  return null;
}

// {action, field, hidden, options, submit, csrf, prompt} or null.
function parseCodeForm(html, atPath = '') {
  const page = String(html || '');
  if (!page || looksLikeLoginPage(page)) return null;
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let f;
  while ((f = formRe.exec(page))) {
    const ins = [];
    for (const m of f[2].matchAll(/<input\b([^>]*)>/gi)) {
      const name = attrOf(m[1], 'name');
      if (name) ins.push({ name, type: (attrOf(m[1], 'type') || 'text').toLowerCase(), value: attrOf(m[1], 'value') || '' });
    }
    if (ins.some((i) => i.type === 'password')) continue;
    const field = ins.find((i) => i.type !== 'hidden' && ['text', 'tel', 'number', ''].includes(i.type) && CODE_FIELD_RE.test(i.name));
    if (!field) continue;
    const hidden = {};
    const options = {};
    for (const i of ins) {
      if (i.type === 'hidden') hidden[i.name] = i.value;
      else if (i !== field && i.type !== 'radio' && TRUST_FIELD_RE.test(i.name)) options[i.name] = i.type === 'checkbox' ? (i.value || 'on') : '1';
    }
    const buttons = [];
    for (const m of f[2].matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
      const name = attrOf(m[1], 'name');
      if (!name || (attrOf(m[1], 'type') || 'submit').toLowerCase() !== 'submit') continue;
      buttons.push({ name, value: attrOf(m[1], 'value') || '', label: decodeHtml(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() });
    }
    const looks = (b) => `${b.value} ${b.label}`;
    const submit = buttons.find((b) => VERIFY_BUTTON_RE.test(looks(b)) && !NOT_VERIFY_RE.test(looks(b)))
      || buttons.find((b) => !NOT_VERIFY_RE.test(looks(b))) || null;
    return {
      action: attrOf(f[1], 'action') || atPath,
      field: field.name, hidden, options,
      submit: submit ? { name: submit.name, value: submit.value } : null,
      csrf: hidden._csrf || csrfFrom(page) || null,
      prompt: codePrompt(page),
    };
  }
  return null;
}

const authError = (kind, msg, extra = {}) => Object.assign(new FetchError(EXIT.AUTH, msg), { kind }, extra);
const ENROLL_MSG = 'The AHGFamily account must finish its two-step sign-in (text-message) setup before the tracker can use it. ' +
  'Sign in to AHGFamily in a browser with this account, complete the security setup, then press Connect on the tracker Admin page.';

// ----------------------------------------------------------------- login ---
// opts.trust: stored trusted-browser cookie lines (Set-Cookie style). Offered
// with the password so a trusted server signs in without a code.
async function login(cfg, jar, opts = {}) {
  if (!cfg.email || !cfg.password) fail(EXIT.CONFIG, 'AHG_EMAIL / AHG_PASSWORD not set (put them in .env).');
  if (opts.trust && opts.trust.length) jar.absorbLines(opts.trust);

  const page = await request(cfg, jar, cfg.loginPath);
  const html = await page.text();
  const token = csrfFrom(html);
  if (!token) fail(EXIT.AUTH, 'Could not find the _csrf token on the login page — the form may have changed.');

  const body = new URLSearchParams({
    _csrf: token,
    'LoginForm[email]': cfg.email,
    'LoginForm[password]': cfg.password,
    'login-button': '',
  });
  const res = await request(cfg, jar, cfg.loginPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: cfg.base,
      Referer: cfg.base + cfg.loginPath,
    },
    body: body.toString(),
  });
  const after = await res.text();
  // Success = 302 away from /login (followed). Failure = form re-rendered.
  if (looksLikeLoginPage(after)) {
    fail(EXIT.AUTH, 'Login rejected. Check credentials — do NOT retry in a loop, AHGFamily may lock the account.');
  }
  if (isEnrollmentGate(after, res._finalUrl)) throw authError('enroll', ENROLL_MSG); // eslint-disable-line no-underscore-dangle
  const challenge = parseCodeForm(after, new URL(res._finalUrl).pathname); // eslint-disable-line no-underscore-dangle
  if (challenge) {
    throw authError('code_required',
      'AHGFamily texted a sign-in code' + (challenge.prompt ? ` (${challenge.prompt})` : '') +
      ' — an admin must enter it: tracker Admin page → AHGFamily sign-in → Connect.',
      { challenge, cookies: jar.lines() });
  }
  return { token: csrfFrom(after) || token, html: after };
}

// Finish a sign-in with the code a person typed: posts the form a browser
// would, with "trust this browser" ON and the verify button pressed. On a
// refused code throws kind 'code_rejected' with the refreshed form as
// .challenge (retype without a new text). Returns { token, html }.
async function submitCode(cfg, jar, challenge, code) {
  const value = String(code || '').trim();
  if (!/^[0-9A-Za-z]{4,10}$/.test(value)) fail(EXIT.CONFIG, 'Enter the code from the text message.');
  const fields = { ...(challenge.hidden || {}) };
  if (challenge.csrf && !fields._csrf) fields._csrf = challenge.csrf;
  fields[challenge.field] = value;
  Object.assign(fields, challenge.options || {});
  if (challenge.submit && challenge.submit.name) fields[challenge.submit.name] = challenge.submit.value;
  const action = challenge.action || '/site/sms-verify';
  const res = await request(cfg, jar, action, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: cfg.base,
      Referer: cfg.base + action,
    },
    body: new URLSearchParams(fields).toString(),
  });
  const html = await res.text();
  if (res._authLost || looksLikeLoginPage(html)) { // eslint-disable-line no-underscore-dangle
    throw authError('code_expired', 'AHGFamily sent us back to the sign-in page — the code prompt expired. Press Connect again for a fresh code.');
  }
  if (res.status >= 400) throw authError('code_expired', `AHGFamily refused the code form (status ${res.status}) — press Connect again for a fresh code.`);
  if (isEnrollmentGate(html, res._finalUrl)) throw authError('enroll', ENROLL_MSG); // eslint-disable-line no-underscore-dangle
  const again = parseCodeForm(html, action);
  if (again) {
    throw authError('code_rejected', 'That code was not accepted — check the digits and try again (the same text stays valid for a few minutes).',
      { challenge: again, cookies: jar.lines() });
  }
  return { token: csrfFrom(html), html };
}

// ----------------------------------------------------------- page helpers --
// GET a page in the signed-in session. Throws AUTH if the session is gone.
async function getPage(cfg, jar, pathWithQuery) {
  const res = await request(cfg, jar, pathWithQuery);
  const html = await res.text();
  if (res._authLost || looksLikeLoginPage(html)) { // eslint-disable-line no-underscore-dangle
    fail(EXIT.AUTH, `Session lost while fetching ${pathWithQuery.split('?')[0]} — stopping (no retry).`);
  }
  if (res.status !== 200) fail(EXIT.FETCH, `GET ${pathWithQuery.split('?')[0]} returned ${res.status}.`);
  return html;
}

// POST /advancement/badge-tracker-view (XHR). Read-only: returns the HTML
// fragment for (youth × award). `level` is the level CODE (all|path|tend|
// expl|pipa|adult); `youthIds` is an array of youth hashids; `awardId` is aw….
async function badgeTrackerView(cfg, jar, token, { level = 'all', style = 'standard', youthIds, awardId, lockedChecked = 0 }) {
  if (!Array.isArray(youthIds) || !youthIds.length) fail(EXIT.CONFIG, 'badgeTrackerView needs at least one youth id.');
  const body = new URLSearchParams();
  body.set('level', level);
  body.set('style', style);
  for (const y of youthIds) body.append('youth[]', y);
  body.set('badges', awardId);
  body.set('trackLevel', '');
  body.set('lockedChecked', String(lockedChecked));
  body.set('_csrf', token);
  const res = await request(cfg, jar, '/advancement/badge-tracker-view', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-CSRF-Token': token,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'text/html, */*; q=0.01',
      Origin: cfg.base,
      Referer: `${cfg.base}/advancement/index?level=${encodeURIComponent(level)}&style=${style}`,
    },
    body: body.toString(),
  });
  const html = await res.text();
  if (res._authLost || looksLikeLoginPage(html)) { // eslint-disable-line no-underscore-dangle
    fail(EXIT.AUTH, 'Session lost during badge-tracker-view — stopping (no retry).');
  }
  if (res.status === 403 || res.status === 400) {
    // Yii answers 400 "Unable to verify your data submission" on a bad CSRF token
    fail(EXIT.AUTH, `badge-tracker-view returned ${res.status} (CSRF/session problem) — stopping.`);
  }
  if (res.status !== 200) fail(EXIT.FETCH, `badge-tracker-view returned ${res.status} for award ${awardId}.`);
  return html;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- THE WRITE ---
// The single, audited exception to this module's read-only rule. Everything
// else refuses to write (ALLOWED_PATHS lists only GET for /advancement/index,
// so request() throws on a POST there). This function bypasses that guard ON
// PURPOSE and is called from exactly one place — server/lib/servicepush.js,
// behind the `push_enabled` flag — to add a Service Star instance. There is
// no granular add-instance endpoint: the save is a full-form POST of the whole
// Standard view back to /advancement/index (see docs/step5-verification-session.md).
//
// Step-5 facts this relies on: the server answers 200 (or a 302 to the same
// page) and validates NOTHING, so the CALLER must validate every field first
// and prove the result by reading it back. This function only transports the
// body and reports what came back; it makes no success judgement.
async function postAdvancementIndex(cfg, jar, token, bodyPairs) {
  const path = '/advancement/index?level=all&style=standard';
  const res = await fetch(cfg.base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'User-Agent': cfg.userAgent,
      Cookie: jar.header(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: cfg.base,
      Referer: cfg.base + path,
    },
    body: new URLSearchParams(bodyPairs).toString(),
  });
  jar.absorb(res);
  let html = '';
  const location = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && location) {
    const loc = new URL(location, cfg.base);
    if (/\/(site\/)?login$/.test(loc.pathname)) fail(EXIT.AUTH, 'Session lost during save — stopping (no retry).');
    const g = await request(cfg, jar, loc.pathname + loc.search); // GET is allow-listed
    html = await g.text();
  } else {
    html = await res.text();
  }
  if (looksLikeLoginPage(html)) fail(EXIT.AUTH, 'Session lost during save — stopping (no retry).');
  return { status: res.status, location, html };
}

module.exports = {
  FetchError, EXIT, makeConfig, ALLOWED_PATHS, assertAllowed, CookieJar, request,
  csrfFrom, decodeHtml, looksLikeLoginPage, login, getPage, badgeTrackerView, sleep,
  postAdvancementIndex, submitCode, parseCodeForm, isEnrollmentGate,
};
