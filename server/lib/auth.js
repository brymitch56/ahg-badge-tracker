'use strict';
/**
 * Bearer-token authentication for leaders (docs/entra-setup.md §6).
 *
 * The website's MSAL client requests `api://<tracker-client-id>/access_as_leader`
 * and sends the resulting access token. We verify:
 *   1. signature against the tenant's JWKS (jose, cached)
 *   2. iss  = https://login.microsoftonline.com/<tenant>/v2.0
 *   3. aud  = client id (or api://client-id)
 *   4. exp / nbf with 60 s tolerance
 *   5. scp contains the configured scope
 *   6. leader: `groups` contains LEADER_GROUP_ID, or preferred_username ∈ LEADER_EMAILS
 * Role: 'admin' if the e-mail is in ADMIN_EMAILS, else 'leader'.
 *
 * The remote JWKS is cached for a day (an unknown `kid` still triggers a
 * refetch, so key rotation is safe) and fetched with a 20 s timeout: the Pi
 * sits on Wi-Fi, and one slow fetch after a restart must not lock every
 * leader out with ERR_JWKS_TIMEOUT (seen 2026-09-12).
 * `jwks` is injectable so tests can sign tokens with a local key.
 * A Graph token is never accepted — its audience is Graph, not us.
 */
const { jwtVerify, createRemoteJWKSet } = require('jose');

class AuthError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

function makeAuth(cfg, { jwks = null, issuer = null, getAccess = null } = {}) {
  const a = cfg.auth;
  const iss = issuer || `https://login.microsoftonline.com/${a.tenantId}/v2.0`;
  const keys = jwks || (a.tenantId
    ? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${a.tenantId}/discovery/v2.0/keys`), { cooldownDuration: 30000, cacheMaxAge: 24 * 3600e3, timeoutDuration: 20000 })
    : null);
  const audiences = [a.clientId, `api://${a.clientId}`].filter(Boolean);
  // Access lists are resolved per request so the Admin page's changes
  // (server/lib/access.js) take effect immediately; without a provider the
  // .env lists alone apply. An admin e-mail always counts as a leader.
  const access = () => (getAccess ? getAccess() : { leaderGroupId: a.leaderGroupId, leaderEmails: a.leaderEmails, adminEmails: a.adminEmails });

  async function verify(token) {
    if (!keys || !a.clientId) throw new AuthError(500, 'auth not configured (MSAL_TENANT_ID / MSAL_CLIENT_ID)');
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, { issuer: iss, audience: audiences, clockTolerance: 60 }));
    } catch (e) {
      throw new AuthError(401, `token rejected: ${e.code || e.message}`);
    }
    const scopes = String(payload.scp || '').split(/\s+/).filter(Boolean);
    if (!scopes.includes(a.scope)) throw new AuthError(401, `token lacks scope ${a.scope}`);
    const email = String(payload.preferred_username || payload.upn || payload.email || '').toLowerCase();
    const groups = Array.isArray(payload.groups) ? payload.groups : [];
    const acc = access();
    const isAdmin = !!email && acc.adminEmails.includes(email);
    const isLeader = isAdmin
      || (acc.leaderGroupId && groups.includes(acc.leaderGroupId))
      || (email && acc.leaderEmails.includes(email));
    if (!isLeader) throw new AuthError(403, 'signed in, but not a leader');
    return { email, name: payload.name || null, oid: payload.oid || null, role: isAdmin ? 'admin' : 'leader', groups };
  }

  // Express middleware: requires a valid leader; optionally an admin.
  const require_ = (role = 'leader') => async (req, res, next) => {
    try {
      if (a.disabled) {
        req.user = { email: 'dev@example.com', name: 'Dev (auth disabled)', oid: null, role: 'admin', groups: [] };
      } else {
        const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
        if (!m) throw new AuthError(401, 'missing bearer token');
        req.user = await verify(m[1].trim());
      }
      if (role === 'admin' && req.user.role !== 'admin') throw new AuthError(403, 'admin only');
      next();
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 500;
      res.status(status).json({ error: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'auth error', detail: e.message });
    }
  };

  return { verify, require: require_, AuthError };
}

module.exports = { makeAuth, AuthError };
