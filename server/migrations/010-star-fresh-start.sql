-- 010-star-fresh-start: the leader's choice for a girl's extra stars becomes
-- 'separate' (default: legacy stars added on top of what hours earn) or
-- 'fresh' (the stars on record stand, and from fresh_from — the start of the
-- program year when it was chosen — only that level's hours dated on or
-- after it count; nothing carries in). 009's 'hours' choice is dropped: it
-- was never chosen live. SQLite cannot alter a CHECK, so the table is rebuilt.
CREATE TABLE star_baseline_new (
  girl_id INTEGER NOT NULL REFERENCES girls(id),
  level TEXT NOT NULL,
  on_record INTEGER NOT NULL,
  earnable INTEGER NOT NULL,
  hours_hundredths INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  captured_by TEXT,
  legacy_mode TEXT NOT NULL DEFAULT 'separate' CHECK (legacy_mode IN ('separate', 'fresh')),
  fresh_from TEXT,                        -- YYYY-MM-DD; set only for 'fresh'
  PRIMARY KEY (girl_id, level)
);
INSERT INTO star_baseline_new (girl_id, level, on_record, earnable, hours_hundredths, captured_at, captured_by, legacy_mode, fresh_from)
  SELECT girl_id, level, on_record, earnable, hours_hundredths, captured_at, captured_by, 'separate', NULL FROM star_baseline;
DROP TABLE star_baseline;
ALTER TABLE star_baseline_new RENAME TO star_baseline;
