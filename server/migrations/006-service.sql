-- 006-service: Service Stars read side (docs/service-stars-plan.md draft 2,
-- build-order step 2). Mirrors of AHGFamily's per-entry service ledger and
-- per-instance award records, the per-girl per-level baseline taken at
-- first sync, star proposals, and the push_queue action the (unbuilt)
-- step-7 push will use. Nothing here writes to AHGFamily.

-- Per-entry service ledger, one row per AHGFamily activity row. Hours are
-- INTEGER HUNDREDTHS (1.75 h = 175): float sums mis-total the real data.
-- Pathfinder rows are kept (real attendance data) and excluded in the math.
CREATE TABLE service_hours (
  id INTEGER PRIMARY KEY,
  girl_id INTEGER NOT NULL REFERENCES girls(id),
  ahg_record_id TEXT NOT NULL,            -- the ledger row's id; never exported
  date TEXT,                              -- YYYY-MM-DD
  level TEXT,                             -- the girl's level at the time (AHGFamily's own stamp)
  hundredths INTEGER,                     -- NULL = unreadable (the run refuses to compute on it)
  verified INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  fetched_at TEXT NOT NULL,
  UNIQUE (girl_id, ahg_record_id)
);
CREATE INDEX service_hours_girl ON service_hours(girl_id);

-- Award instances (whole-award records) — award-generic so Pathfinder
-- beads reuse it. Counted by ad… record id, never by date (Court of
-- Awards stamps several stars with one date).
CREATE TABLE award_instances (
  id INTEGER PRIMARY KEY,
  girl_id INTEGER NOT NULL REFERENCES girls(id),
  ahg_award_id TEXT NOT NULL,
  ad_record_id TEXT NOT NULL,             -- per-girl record id; never exported
  completed_on TEXT,                      -- YYYY-MM-DD (epoch-0 read as NULL)
  awarded_on TEXT,
  purchased INTEGER NOT NULL DEFAULT 0,
  comment TEXT,
  first_seen_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  missing_since TEXT,                     -- set when a later pull no longer sees the instance
  UNIQUE (girl_id, ahg_award_id, ad_record_id)
);
CREATE INDEX award_instances_girl ON award_instances(girl_id, ahg_award_id);

-- First-sync snapshot per girl per star level: how many instances existed
-- and how many the ledger explained. Legacy (paper-era) stars are the
-- difference; conflicts are raised only for movement AFTER this.
CREATE TABLE star_baseline (
  girl_id INTEGER NOT NULL REFERENCES girls(id),
  level TEXT NOT NULL,
  on_record INTEGER NOT NULL,
  earnable INTEGER NOT NULL,
  hours_hundredths INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  captured_by TEXT,
  PRIMARY KEY (girl_id, level)
);

-- Star proposals: "her Nth star at this level" (ordinal). proposed →
-- confirmed (a leader; completed_on = confirmation date, which is what the
-- push stamps) → recorded (AHGFamily shows the instance). withdrawn = the
-- arithmetic no longer supports it or AHGFamily already records it.
CREATE TABLE star_proposals (
  id INTEGER PRIMARY KEY,
  girl_id INTEGER NOT NULL REFERENCES girls(id),
  level TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  hours_hundredths INTEGER NOT NULL,      -- available at the level when proposed (hours + carry-in)
  carry_in INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'recorded', 'rejected', 'withdrawn')),
  proposed_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  completed_on TEXT,
  notes TEXT
);
CREATE INDEX star_proposals_girl ON star_proposals(girl_id, level);
CREATE UNIQUE INDEX star_proposals_live ON star_proposals(girl_id, level, ordinal) WHERE status IN ('proposed', 'confirmed', 'recorded');

-- push_queue gains the add_instance action (used by step 7 only) plus the
-- columns it needs. SQLite cannot alter a CHECK, so the table is rebuilt.
CREATE TABLE push_queue_new (
  id INTEGER PRIMARY KEY,
  girl_id INTEGER NOT NULL REFERENCES girls(id),
  requirement_id TEXT REFERENCES requirements(id) ON UPDATE CASCADE,
  badge_id TEXT REFERENCES badges(id),
  completion_id INTEGER REFERENCES completions(id),
  action TEXT NOT NULL CHECK (action IN ('mark', 'unmark', 'badge_complete', 'add_instance')),
  date TEXT,
  level_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'skipped', 'held')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  sync_run_id INTEGER,
  ahg_award_id TEXT,                      -- add_instance: which award (e.g. a Service Star level)
  star_proposal_id INTEGER REFERENCES star_proposals(id),
  detail TEXT                             -- json (e.g. the provenance comment to write)
);
INSERT INTO push_queue_new (id, girl_id, requirement_id, badge_id, completion_id, action, date, level_id, status, attempts, last_error, created_at, sent_at, sync_run_id)
  SELECT id, girl_id, requirement_id, badge_id, completion_id, action, date, level_id, status, attempts, last_error, created_at, sent_at, sync_run_id FROM push_queue;
DROP TABLE push_queue;
ALTER TABLE push_queue_new RENAME TO push_queue;
CREATE INDEX push_queue_status ON push_queue(status);
