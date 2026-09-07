'use strict';
// Express app factory. createApp() is pure enough to test: pass a config, an
// open db, and (in tests) a local JWKS. index.js wires the real thing.
const express = require('express');
const path = require('path');
const { makeAuth } = require('./lib/auth');
const catalog = require('./lib/catalog');

let VERSION = null;
try { VERSION = require(path.join(__dirname, '..', 'package.json')).version; } catch { /* stripped install */ }

function createApp({ cfg, db, jwks = null, issuer = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Cloudflare tunnel in front
  app.use(express.json({ limit: '1mb' }));

  // CORS: exactly one origin (the troop website). No credentials, bearer only.
  app.use((req, res, next) => {
    if (cfg.siteOrigin && req.headers.origin === cfg.siteOrigin) {
      res.setHeader('Access-Control-Allow-Origin', cfg.siteOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  });

  const auth = makeAuth(cfg, { jwks, issuer });
  const leader = auth.require('leader');
  const admin = auth.require('admin');

  // ---------------------------------------------------------- unauthenticated
  app.get('/health', (req, res) => {
    const v = catalog.currentVersion(db);
    res.json({
      ok: true, app: 'ahg-badge-tracker', version: VERSION, now: new Date().toISOString(), tz: cfg.tz,
      catalog: v ? { version: v.id, importedAt: v.imported_at, badges: v.badge_count, requirements: v.requirement_count } : null,
      auth: cfg.auth.disabled ? 'DISABLED' : (cfg.auth.tenantId && cfg.auth.clientId ? 'msal' : 'unconfigured'),
    });
  });

  // ------------------------------------------------------------------ api v1
  const api = express.Router();
  api.get('/me', leader, (req, res) => res.json({ email: req.user.email, name: req.user.name, role: req.user.role }));

  api.get('/badges', leader, (req, res) => {
    const levelGroup = typeof req.query.levelGroup === 'string' ? req.query.levelGroup : null;
    res.json(catalog.listBadges(db, { levelGroup, includeInactive: req.query.includeInactive === '1' }));
  });
  api.get('/badges/:id', leader, (req, res) => {
    const b = catalog.getBadge(db, req.params.id);
    if (!b) return res.status(404).json({ error: 'not found' });
    return res.json(b);
  });

  api.post('/admin/catalog/import', admin, (req, res) => {
    try {
      const summary = catalog.importFromDir(db, cfg.badgesDir, { actor: req.user.email });
      res.json(summary);
    } catch (e) {
      res.status(422).json({ error: 'import refused', detail: e.message, errors: e.errors || [] });
    }
  });
  api.get('/admin/catalog', admin, (req, res) => {
    res.json({ current: catalog.currentVersion(db), versions: db.prepare('SELECT * FROM catalog_versions ORDER BY id DESC LIMIT 20').all(), badgesDir: cfg.badgesDir });
  });
  api.get('/admin/audit', admin, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit));
  });

  app.use('/api/v1', api);

  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad json' });
    console.error('[tracker] unhandled:', err);
    return res.status(500).json({ error: 'server error' });
  });
  return app;
}

module.exports = { createApp };
