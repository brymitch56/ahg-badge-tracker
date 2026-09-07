'use strict';
/**
 * HMAC verification for the check-in app's outbound webhook
 * (contract: troop-checkin docs/13-integration-api.md — timestamp + "." +
 * raw body, SHA-256, 5-minute window, timing-safe compare). This is the
 * contract's reference verifier, verbatim in behavior.
 */
const crypto = require('crypto');

const WINDOW_SECONDS = 300;

function verifySignature(secret, headers, rawBody, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret) return false;
  const ts = String(headers['x-troop-checkin-timestamp'] || '');
  if (!/^\d+$/.test(ts) || Math.abs(nowSec - Number(ts)) > WINDOW_SECONDS) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const got = String(headers['x-troop-checkin-signature'] || '');
  return expected.length === got.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

/**
 * De-duplicate an at-least-once delivery. Only txn.* payloads carry a txn
 * id; other types (test, ical.synced) are cheap and idempotent to re-run.
 * Returns true when this delivery is new.
 */
function markDelivery(db, payload) {
  if (!payload.type || !payload.type.startsWith('txn.') || payload.txn?.id == null) return true;
  const key = `${payload.type}:${payload.txn.id}`;
  const r = db.prepare('INSERT OR IGNORE INTO webhook_txns (id, received_at) VALUES (?, ?)')
    .run(key, new Date().toISOString());
  return r.changes === 1;
}

module.exports = { verifySignature, markDelivery, WINDOW_SECONDS };
