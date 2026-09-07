-- 004-conflicts: rule 6 — AHGFamily-vs-tracker disagreements are surfaced
-- to a leader, never resolved silently.
CREATE TABLE conflicts (
  id INTEGER PRIMARY KEY,
  girl_id INTEGER NOT NULL REFERENCES girls(id),
  requirement_id TEXT REFERENCES requirements(id) ON UPDATE CASCADE,
  kind TEXT NOT NULL,                     -- ahg_unchecked (item complete here, later un-checked there)
  detail TEXT,                            -- json
  detected_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by TEXT,
  resolved_at TEXT,
  resolution TEXT
);
CREATE INDEX conflicts_status ON conflicts(status);
