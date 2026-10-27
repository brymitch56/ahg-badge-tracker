-- 013-pathfinder: the Pathfinder planner and tracker (server/lib/pathfinder.js).
--
-- Pathfinders earn no badges. Their year is six stepping stones, planned
-- meeting by meeting, plus repeat necklace beads and two awards (Fanny
-- Crosby, Joining). Their plans live apart from the badge/faith plans: a
-- Pathfinder meeting is laid out the way the Unit Leader Guide's meeting
-- planner is (intro, activities, closing — what & how, supplies, who).

-- One Pathfinder plan per event. kind 'service' = the whole meeting is a
-- service project (every Pathfinder there earns a service star bead).
-- finishes_stones: stepping stones completed at this meeting (json array of
-- 1–6) — every Pathfinder there earns that stone's logo bead.
CREATE TABLE pf_plans (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL UNIQUE REFERENCES events(id),
  kind TEXT NOT NULL DEFAULT 'meeting' CHECK (kind IN ('meeting', 'service')),
  service_project TEXT,
  finishes_stones TEXT NOT NULL DEFAULT '[]',
  notes TEXT,                             -- the planner's Comments box
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT
);

-- The meeting's parts, in order. A part may work on a stepping stone and/or
-- one Fanny Crosby or Joining Award requirement (its completion is proposed
-- for the Pathfinders who attended, like a badge plan's finish item).
CREATE TABLE pf_plan_parts (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES pf_plans(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('intro', 'activity', 'optional', 'closing')),
  stone INTEGER CHECK (stone BETWEEN 1 AND 6),
  requirement_id TEXT REFERENCES requirements(id) ON UPDATE CASCADE,
  what TEXT,
  supplies TEXT,
  who TEXT
);
CREATE INDEX pf_plan_parts_plan ON pf_plan_parts(plan_id);

-- Every bead a girl earns, one row per bead. AHGFamily keeps a single
-- instance per bead award, so these rows are the real count; each confirmed
-- bead appends a line to that instance's comment (push action 'bead').
--   attendance — a meeting she was checked in to (setting: which events)
--   verse      — a memory verse she learned (a stone's verse, or a bonus one)
--   service    — a service project
--   stone      — a stepping stone completed (its logo bead)
CREATE TABLE pf_beads (
  id INTEGER PRIMARY KEY,
  girl_id INTEGER NOT NULL REFERENCES girls(id),
  kind TEXT NOT NULL CHECK (kind IN ('attendance', 'verse', 'service', 'stone')),
  earned_on TEXT NOT NULL,                -- YYYY-MM-DD local
  event_id INTEGER REFERENCES events(id),
  stone INTEGER CHECK (stone BETWEEN 1 AND 6),
  verse TEXT,                             -- verse reference
  label TEXT,                             -- service project / event title
  status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected')),
  source TEXT NOT NULL CHECK (source IN ('attendance', 'manual')),
  proposed_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  notes TEXT
);
CREATE INDEX pf_beads_girl ON pf_beads(girl_id, kind);
CREATE UNIQUE INDEX pf_beads_attendance ON pf_beads(girl_id, event_id) WHERE kind = 'attendance' AND status <> 'rejected';
CREATE UNIQUE INDEX pf_beads_service_event ON pf_beads(girl_id, event_id) WHERE kind = 'service' AND event_id IS NOT NULL AND status <> 'rejected';
CREATE UNIQUE INDEX pf_beads_stone ON pf_beads(girl_id, stone) WHERE kind = 'stone' AND status <> 'rejected';
CREATE UNIQUE INDEX pf_beads_verse ON pf_beads(girl_id, verse) WHERE kind = 'verse' AND status <> 'rejected';

-- push_queue gains the 'bead' action (one confirmed bead → one appended
-- line on AHGFamily) and a pointer to its bead. SQLite cannot alter a
-- CHECK, so the table is rebuilt (as in 006); nothing references it.
CREATE TABLE push_queue_new (
  id INTEGER PRIMARY KEY,
  girl_id INTEGER NOT NULL REFERENCES girls(id),
  requirement_id TEXT REFERENCES requirements(id) ON UPDATE CASCADE,
  badge_id TEXT REFERENCES badges(id),
  completion_id INTEGER REFERENCES completions(id),
  action TEXT NOT NULL CHECK (action IN ('mark', 'unmark', 'badge_complete', 'add_instance', 'bead')),
  date TEXT,
  level_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'skipped', 'held')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  sync_run_id INTEGER,
  ahg_award_id TEXT,
  star_proposal_id INTEGER REFERENCES star_proposals(id),
  detail TEXT,
  pf_bead_id INTEGER REFERENCES pf_beads(id)
);
INSERT INTO push_queue_new (id, girl_id, requirement_id, badge_id, completion_id, action, date, level_id, status, attempts, last_error, created_at, sent_at, sync_run_id, ahg_award_id, star_proposal_id, detail)
  SELECT id, girl_id, requirement_id, badge_id, completion_id, action, date, level_id, status, attempts, last_error, created_at, sent_at, sync_run_id, ahg_award_id, star_proposal_id, detail FROM push_queue;
DROP TABLE push_queue;
ALTER TABLE push_queue_new RENAME TO push_queue;
CREATE INDEX push_queue_status ON push_queue(status);
