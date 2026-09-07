-- 002-checkin: webhook dedupe and roster status for the check-in mirror.

-- At-least-once webhook deliveries are de-duplicated on txn id (contract:
-- troop-checkin docs/13-integration-api.md). id = "<type>:<txn.id>".
CREATE TABLE webhook_txns (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

-- The check-in API distinguishes active members from visitors (and keeps
-- history rows for inactive people). Mirror that beside the active flag so
-- the roster screen can hold or ignore visitors.
ALTER TABLE girls ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
