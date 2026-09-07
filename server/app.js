'use strict';
// Express app factory. createApp() is pure enough to test: pass a config, an
// open db, and (in tests) a local JWKS. index.js wires the real thing.
const express = require('express');
const path = require('path');
const { makeAuth } = require('./lib/auth');
const catalog = require('./lib/catalog');
const { makeCheckinClient, CheckinError } = require('./lib/checkin');
const mirror = require('./lib/mirror');
const { verifySignature, markDelivery } = require('./lib/webhook');

let VERSION = null;
try { VERSION = require(path.join(__dirname, '..', 'package.json')).version; } catch { /* stripped install */ }

function createApp({ cfg, db, jwks = null, issuer = null, checkinFetch = undefined }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Cloudflare tunnel in front
  const checkin = makeCheckinClient(cfg.checkin, checkinFetch ? { fetchImpl: checkinFetch } : {});

  // Check-in webhook — registered BEFORE the JSON body parser because the
  // HMAC is over the raw body bytes. HMAC only, no bearer, no CORS (server
  // to server). Answer 2xx promptly; the re-poll happens after responding
  // (app.locals.webhookWork chains deliveries so tests and shutdown can
  // await the tail).
  app.post('/webhooks/checkin', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!verifySignature(cfg.checkin.webhookSecret, req.headers, raw)) {
      return res.status(401).json({ error: 'invalid signature' });
    }
    let payload;
    try { payload = JSON.parse(raw); } catch { return res.status(400).json({ error: 'bad json' }); }
    const fresh = markDelivery(db, payload);
    res.json({ ok: true, duplicate: !fresh });
    if (fresh) {
      app.locals.webhookWork = Promise.resolve(app.locals.webhookWork)
        .then(() => mirror.handleWebhook(db, checkin, payload, { log: console.error }));
    }
    return undefined;
  });

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
    let checkinState = 'unconfigured';
    if (checkin.configured) {
      const last = db.prepare("SELECT ok FROM sync_runs WHERE kind IN ('checkin_events', 'checkin_people', 'attendance') ORDER BY id DESC LIMIT 1").get();
      checkinState = !last ? 'unsynced' : last.ok ? 'ok' : 'error';
    }
    res.json({
      ok: true, app: 'ahg-badge-tracker', version: VERSION, now: new Date().toISOString(), tz: cfg.tz,
      catalog: v ? { version: v.id, importedAt: v.imported_at, badges: v.badge_count, requirements: v.requirement_count } : null,
      checkin: checkinState,
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

  // -------------------------------------------- roster & events (mirror) --
  const girlOut = (g) => ({
    id: g.id, memberId: g.member_id, firstName: g.first_name, lastName: g.last_name, nickname: g.nickname,
    level: g.level, ahgLevel: g.ahg_level, ahgYouthId: g.ahg_youth_id, ahgYouthIdSource: g.ahg_youth_id_source,
    status: g.status, active: !!g.active,
  });
  api.get('/girls', leader, (req, res) => {
    const rows = req.query.includeInactive === '1'
      ? db.prepare('SELECT * FROM girls ORDER BY last_name, first_name').all()
      : db.prepare('SELECT * FROM girls WHERE active = 1 ORDER BY last_name, first_name').all();
    res.json(rows.map(girlOut));
  });
  api.patch('/girls/:id', admin, (req, res) => {
    const g = db.prepare('SELECT * FROM girls WHERE id = ?').get(req.params.id);
    if (!g) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const sets = {};
    if ('ahgLevel' in b) {
      if (b.ahgLevel !== null && !mirror.AHG_LEVELS.includes(b.ahgLevel)) return res.status(400).json({ error: `ahgLevel must be one of ${mirror.AHG_LEVELS.join('|')} or null` });
      sets.ahg_level = b.ahgLevel;
    }
    if ('ahgYouthId' in b) {
      if (b.ahgYouthId !== null && !/^u[a-z0-9]{11}$/i.test(b.ahgYouthId)) return res.status(400).json({ error: 'ahgYouthId must be a u… hashid or null' });
      const v = b.ahgYouthId === null ? null : b.ahgYouthId.toLowerCase();
      if (v && db.prepare('SELECT 1 FROM girls WHERE ahg_youth_id = ? AND id <> ?').get(v, g.id)) return res.status(409).json({ error: 'that AHGFamily id is already mapped to another girl' });
      sets.ahg_youth_id = v;
      sets.ahg_youth_id_source = v === null ? null : 'manual';
    }
    if ('active' in b) sets.active = b.active ? 1 : 0;
    if (!Object.keys(sets).length) return res.status(400).json({ error: 'nothing to change (ahgLevel, ahgYouthId, active)' });
    sets.updated_at = new Date().toISOString();
    db.prepare(`UPDATE girls SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(sets), g.id);
    db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sets.updated_at, req.user.email, 'girl.update', 'girl', String(g.id),
        JSON.stringify({ ahg_level: g.ahg_level, ahg_youth_id: g.ahg_youth_id, active: g.active }), JSON.stringify(sets));
    return res.json(girlOut(db.prepare('SELECT * FROM girls WHERE id = ?').get(g.id)));
  });

  const eventOut = (e) => ({
    id: e.id, checkinEventId: e.checkin_event_id, icalUid: e.ical_uid, startAt: e.start_at, endAt: e.end_at,
    title: e.title, location: e.location, allDay: !!e.all_day, removedFromFeed: !!e.removed_from_feed,
  });
  api.get('/events', leader, (req, res) => {
    // from/to are YYYY-MM-DD; start_at is ISO-8601, so pad `to` past that day.
    const from = typeof req.query.from === 'string' ? req.query.from : '0000';
    const to = typeof req.query.to === 'string' ? `${req.query.to}T￿` : '9999';
    const rows = db.prepare('SELECT * FROM events WHERE start_at >= ? AND start_at <= ? ORDER BY start_at').all(from, to);
    const att = db.prepare('SELECT event_id, COUNT(*) AS total, SUM(open) AS open FROM attendance GROUP BY event_id').all();
    const plans = db.prepare('SELECT event_id, level_group FROM plans').all();
    const byEvent = new Map(att.map((a) => [a.event_id, a]));
    res.json(rows.map((e) => ({
      ...eventOut(e),
      attendance: byEvent.has(e.id) ? { total: byEvent.get(e.id).total, open: byEvent.get(e.id).open || 0 } : null,
      planLevelGroups: plans.filter((p) => p.event_id === e.id).map((p) => p.level_group),
    })));
  });
  api.get('/events/:id', leader, (req, res) => {
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    const att = db.prepare(`SELECT a.*, g.first_name, g.last_name, g.nickname, g.ahg_level FROM attendance a
                            JOIN girls g ON g.id = a.girl_id WHERE a.event_id = ? ORDER BY g.last_name, g.first_name`).all(e.id);
    return res.json({
      ...eventOut(e),
      plans: db.prepare('SELECT id, level_group, created_by, created_at, notes FROM plans WHERE event_id = ?').all(e.id)
        .map((p) => ({ id: p.id, levelGroup: p.level_group, createdBy: p.created_by, createdAt: p.created_at, notes: p.notes })),
      attendance: att.map((a) => ({
        girlId: a.girl_id, firstName: a.first_name, lastName: a.last_name, nickname: a.nickname, ahgLevel: a.ahg_level,
        signedInAt: a.signed_in_at, signedOutAt: a.signed_out_at, open: !!a.open, fetchedAt: a.fetched_at,
      })),
    });
  });

  // ------------------------------------------------------------------ sync --
  api.post('/sync/checkin', admin, async (req, res) => {
    try {
      res.json(await mirror.syncCheckin(db, checkin));
    } catch (e) {
      if (e instanceof CheckinError) return res.status(502).json({ error: 'check-in sync failed', detail: e.message });
      throw e;
    }
    return undefined;
  });
  api.get('/sync/status', leader, (req, res) => {
    const lastByKind = db.prepare(`SELECT kind, MAX(id) AS id FROM sync_runs GROUP BY kind`).all()
      .map((r) => db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(r.id));
    res.json({
      checkinConfigured: checkin.configured,
      runs: lastByKind.map((r) => ({ kind: r.kind, startedAt: r.started_at, finishedAt: r.finished_at, ok: r.ok === null ? null : !!r.ok, summary: r.summary ? JSON.parse(r.summary) : null, error: r.error })),
      webhookDeliveries: db.prepare('SELECT COUNT(*) AS n FROM webhook_txns').get().n,
    });
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
