-- 001-init: catalog, roster/event mirrors, planning, completion, AHGFamily sync, audit.
-- Shape per docs/tracker-service-spec.md §4. Timestamps ISO-8601 UTC; "date" columns YYYY-MM-DD local.

-- ---------------------------------------------------------------- catalog --
CREATE TABLE catalog_versions (
  id INTEGER PRIMARY KEY,
  imported_at TEXT NOT NULL,
  source_generated_at TEXT,
  badge_count INTEGER NOT NULL,
  requirement_count INTEGER NOT NULL,
  notes TEXT
);

CREATE TABLE badges (
  id TEXT PRIMARY KEY,                    -- slug, e.g. nature-and-wildlife-pipa
  catalog_version_id INTEGER NOT NULL REFERENCES catalog_versions(id),
  ahg_award_id TEXT NOT NULL,
  name TEXT NOT NULL,
  level_group TEXT NOT NULL,
  levels TEXT NOT NULL,                   -- json array
  classic INTEGER NOT NULL DEFAULT 0,
  pages TEXT NOT NULL DEFAULT '[]',       -- json array
  image_paths TEXT NOT NULL DEFAULT '[]', -- json array (leaders-only library paths)
  intro TEXT,
  ahg_history TEXT,
  faith_text TEXT,
  faith_reference TEXT,
  json TEXT NOT NULL,                     -- the full built badge, verbatim
  active INTEGER NOT NULL DEFAULT 1       -- 0 when a later import no longer contains it
);
CREATE INDEX badges_level_group ON badges(level_group);
CREATE UNIQUE INDEX badges_award ON badges(ahg_award_id);

CREATE TABLE badge_groups (
  id TEXT PRIMARY KEY,                    -- badge_id + ':' + position
  badge_id TEXT NOT NULL REFERENCES badges(id),
  position INTEGER NOT NULL,
  label TEXT,
  rule_type TEXT,                         -- all | n_of | NULL
  rule_n INTEGER
);

CREATE TABLE requirements (
  id TEXT PRIMARY KEY,                    -- badge_id + ':' + number + letter
  badge_id TEXT NOT NULL REFERENCES badges(id),
  group_id TEXT NOT NULL REFERENCES badge_groups(id),
  number INTEGER NOT NULL,
  letter TEXT,
  ahg_requirement_id TEXT NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  sub_items TEXT NOT NULL DEFAULT '[]',   -- json array
  flags TEXT NOT NULL DEFAULT '[]',       -- json array
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX requirements_badge ON requirements(badge_id);
CREATE UNIQUE INDEX requirements_ahg ON requirements(ahg_requirement_id);

-- ------------------------------------------------ people & events (mirror) --
CREATE TABLE girls (
  id INTEGER PRIMARY KEY,
  checkin_person_id INTEGER UNIQUE,
  member_id TEXT UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  nickname TEXT,
  level TEXT,                             -- verbatim from the roster
  ahg_level TEXT,                         -- Pathfinder|Tenderheart|Explorer|Pioneer|Patriot
  ahg_youth_id TEXT UNIQUE,               -- u… hashid; null until mapped
  ahg_youth_id_source TEXT,               -- checkin | mapped | manual
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  checkin_event_id INTEGER UNIQUE,
  ical_uid TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT,
  title TEXT NOT NULL,
  location TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  removed_from_feed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX events_identity ON events(ical_uid, start_at);

CREATE TABLE attendance (
  event_id INTEGER NOT NULL REFERENCES events(id),
  girl_id INTEGER NOT NULL REFERENCES girls(id),
  signed_in_at TEXT,
  signed_out_at TEXT,
  open INTEGER NOT NULL DEFAULT 1,
  source_txn_ids TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (event_id, girl_id)
);

-- --------------------------------------------------------------- planning --
CREATE TABLE plans (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  level_group TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  notes TEXT,
  UNIQUE (event_id, level_group)
);

CREATE TABLE plan_items (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON UPDATE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('session', 'start', 'continue', 'finish')),
  position INTEGER NOT NULL,
  notes TEXT,
  UNIQUE (plan_id, requirement_id)
);

-- ------------------------------------------------------------- completion --
CREATE TABLE completions (
  id INTEGER PRIMARY KEY,
  girl_id INTEGER NOT NULL REFERENCES girls(id),
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON UPDATE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected')),
  completed_on TEXT,
  event_id INTEGER REFERENCES events(id),
  plan_item_id INTEGER REFERENCES plan_items(id),
  source TEXT NOT NULL CHECK (source IN ('attendance', 'manual', 'ahgfamily')),
  source_txn_ids TEXT NOT NULL DEFAULT '[]',
  level_at_completion TEXT,
  proposed_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  notes TEXT
);
CREATE INDEX completions_girl ON completions(girl_id);
CREATE INDEX completions_req ON completions(requirement_id);
-- one live (non-rejected) row per girl per requirement
CREATE UNIQUE INDEX completions_live ON completions(girl_id, requirement_id) WHERE status <> 'rejected';

CREATE TABLE participation (
  girl_id INTEGER NOT NULL REFERENCES girls(id),
  plan_item_id INTEGER NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (girl_id, plan_item_id)
);

-- ---------------------------------------------------------- AHGFamily sync --
CREATE TABLE ahg_state (
  girl_id INTEGER NOT NULL REFERENCES girls(id),
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON UPDATE CASCADE,
  completed INTEGER NOT NULL DEFAULT 0,
  earned_on TEXT,
  comment TEXT,
  ad_record_id TEXT,                      -- per-girl record id; never exported
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (girl_id, requirement_id)
);

CREATE TABLE push_queue (
  id INTEGER PRIMARY KEY,
  girl_id INTEGER NOT NULL REFERENCES girls(id),
  requirement_id TEXT REFERENCES requirements(id) ON UPDATE CASCADE,
  badge_id TEXT REFERENCES badges(id),
  completion_id INTEGER REFERENCES completions(id),
  action TEXT NOT NULL CHECK (action IN ('mark', 'unmark', 'badge_complete')),
  date TEXT,
  level_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'skipped', 'held')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  sync_run_id INTEGER
);
CREATE INDEX push_queue_status ON push_queue(status);

CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('pull', 'push', 'catalog', 'checkin_events', 'checkin_people', 'attendance')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  summary TEXT,                           -- json
  error TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT,                             -- json
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- ------------------------------------------------------------------ audit --
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  before TEXT,                            -- json
  after TEXT                              -- json
);
CREATE INDEX audit_at ON audit_log(at);
