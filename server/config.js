'use strict';
// Tracker service configuration. Everything troop-specific lives in .env
// (see .env.example); nothing here is hard-coded to a troop, tenant, or host.
require('../lib/env');
const path = require('path');

const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function makeConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
  return {
    port: Number(env.PORT) || 3100,
    dataDir,
    dbPath: env.DB_PATH ? path.resolve(env.DB_PATH) : path.join(dataDir, 'tracker.db'),
    badgesDir: env.BADGES_DIR ? path.resolve(env.BADGES_DIR) : path.join(dataDir, 'badges'),
    siteOrigin: (env.SITE_ORIGIN || '').replace(/\/$/, ''),
    tz: env.TZ || 'America/New_York',
    auth: {
      tenantId: env.MSAL_TENANT_ID || '',
      clientId: env.MSAL_CLIENT_ID || '',
      scope: env.MSAL_SCOPE || 'access_as_leader',
      leaderGroupId: env.LEADER_GROUP_ID || '',
      leaderEmails: list(env.LEADER_EMAILS),
      adminEmails: list(env.ADMIN_EMAILS),
      // AUTH_DISABLED=true serves everything as a fake admin — local dev only,
      // refused unless NODE_ENV !== 'production'.
      disabled: /^(1|true)$/i.test(env.AUTH_DISABLED || '') && env.NODE_ENV !== 'production',
    },
  };
}

module.exports = { makeConfig };
