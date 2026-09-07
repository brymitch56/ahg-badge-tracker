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
 * Allowed endpoints (see CLAUDE.md): GET /login, POST /login, GET /logout,
 * GET /advancement/index, POST /advancement/badge-tracker-view.
 * `ALLOWED_PATHS` below is enforced in request() so a future edit cannot
 * accidentally reach a data-changing endpoint from this module.
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
  '/dashboard': ['GET'],                    // where the login 302 lands
  '/advancement/index': ['GET'],            // POST here is the Standard-view SAVE — never
  '/advancement/badge-tracker-view': ['POST'],
  // Roster export (read-only; the same flow troop-checkin's fetch-roster.js
  // uses). Used only by scripts/roster-headers.js, which keeps the file in
  // memory and prints column headers — never rows.
  '/user/index': ['GET'],
  '/user/exportexcel': ['GET'],            // AHGFamily's export URL (TLC uses /user/index?export=)
  '/databuilder/get-download-status': ['POST'],
};
function assertAllowed(cfg, pathOrUrl, method) {
  const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : cfg.base + pathOrUrl);
  const allowed = ALLOWED_PATHS[url.pathname.replace(/\/$/, '') || '/'];
  if (!allowed || !allowed.includes(method)) {
    throw new FetchError(EXIT.CONFIG,
      `Refusing ${method} ${url.pathname}: not in the read-only allow-list (see CLAUDE.md).`);
  }
}

// ------------------------------------------------------------ cookie jar ---
class CookieJar {
  constructor() { this.map = new Map(); }
  absorbLines(lines) {
    for (const line of lines || []) {
      if (!line) continue;
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      let del = value === '';
      for (const attr of attrs) {
        const j = attr.indexOf('=');
        const key = (j < 0 ? attr : attr.slice(0, j)).trim().toLowerCase();
        const val = j < 0 ? '' : attr.slice(j + 1).trim();
        if (key === 'max-age' && Number(val) <= 0) del = true;
        if (key === 'expires') {
          const d = new Date(val);
          if (!isNaN(d) && d.getTime() < Date.now()) del = true;
        }
      }
      if (del) this.map.delete(name);
      else this.map.set(name, value);
    }
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

// ----------------------------------------------------------------- login ---
async function login(cfg, jar) {
  if (!cfg.email || !cfg.password) fail(EXIT.CONFIG, 'AHG_EMAIL / AHG_PASSWORD not set (put them in .env).');

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
  return { token: csrfFrom(after) || token, html: after };
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

module.exports = {
  FetchError, EXIT, makeConfig, ALLOWED_PATHS, assertAllowed, CookieJar, request,
  csrfFrom, decodeHtml, looksLikeLoginPage, login, getPage, badgeTrackerView, sleep,
};
