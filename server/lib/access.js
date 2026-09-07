'use strict';
/**
 * Who may use the tracker — managed from the website's Admin page.
 *
 * Two layers, merged at every request:
 *   - .env (LEADER_GROUP_ID / LEADER_EMAILS / ADMIN_EMAILS): the bootstrap
 *     and the recovery hatch. Entries here can NEVER be removed through the
 *     API, so a UI mistake can't lock the troop out — fixing .env on the
 *     Pi always works.
 *   - the settings table (key "access"): the lists an admin edits in the
 *     UI. Stored lowercase, audited on every change.
 *
 * An admin e-mail always counts as a leader too (adding an admin never
 * requires a second entry). A group id, when configured, keeps granting
 * leader access alongside the lists.
 */
const { getSetting, setSetting } = require('./settings');

const KEY = 'access';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const lc = (s) => String(s || '').trim().toLowerCase();
const uniq = (arr) => [...new Set(arr)];

function stored(db) {
  const s = getSetting(db, KEY) || {};
  return {
    leaderEmails: Array.isArray(s.leaderEmails) ? s.leaderEmails : [],
    adminEmails: Array.isArray(s.adminEmails) ? s.adminEmails : [],
  };
}

/** The merged access lists auth checks on every request. */
function getAccess(db, cfg) {
  const s = stored(db);
  return {
    leaderGroupId: cfg.auth.leaderGroupId,
    leaderEmails: uniq([...cfg.auth.leaderEmails, ...s.leaderEmails.map(lc)]),
    adminEmails: uniq([...cfg.auth.adminEmails, ...s.adminEmails.map(lc)]),
  };
}

/** What the Admin page shows: stored lists plus the fixed .env entries. */
function accessView(db, cfg) {
  const s = stored(db);
  return {
    leaderGroupConfigured: !!cfg.auth.leaderGroupId,
    env: { leaderEmails: cfg.auth.leaderEmails, adminEmails: cfg.auth.adminEmails },
    leaderEmails: s.leaderEmails,
    adminEmails: s.adminEmails,
  };
}

class AccessError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

/**
 * Replace the STORED lists. .env entries are untouchable and always merged
 * back in. Refuses a change that would drop the acting admin's own admin
 * access (unless .env still grants it) — the last admin can't saw off the
 * branch they're sitting on.
 */
function setAccess(db, cfg, { leaderEmails, adminEmails }, actor) {
  if (!Array.isArray(leaderEmails) || !Array.isArray(adminEmails)) {
    throw new AccessError(400, 'body must be { leaderEmails: [...], adminEmails: [...] }');
  }
  const clean = (list, label) => uniq(list.map(lc)).map((e) => {
    if (!EMAIL_RE.test(e)) throw new AccessError(400, `${label}: "${e}" is not an e-mail address`);
    return e;
  });
  const next = { leaderEmails: clean(leaderEmails, 'leaderEmails'), adminEmails: clean(adminEmails, 'adminEmails') };
  const me = lc(actor);
  // (AUTH_DISABLED dev runs act as a fake admin that is on no list — no
  // lockout is possible there, so the guard only applies under real auth.)
  if (!cfg.auth.disabled && me && !next.adminEmails.includes(me) && !cfg.auth.adminEmails.includes(me)) {
    throw new AccessError(409, 'this change would remove your own admin access — add yourself back first');
  }
  const before = stored(db);
  setSetting(db, KEY, next, actor);
  db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), actor, 'access.update', 'settings', KEY, JSON.stringify(before), JSON.stringify(next));
  return accessView(db, cfg);
}

module.exports = { getAccess, accessView, setAccess, AccessError };
