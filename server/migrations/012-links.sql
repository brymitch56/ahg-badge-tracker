-- 012-links: links on plans, and a link library per badge and per Bible
-- study.
--
-- Every link a leader puts on a plan (a web page, or a SharePoint file
-- picked or uploaded from the planner) is kept with what it was for — a
-- badge (badge plans, faith badges, Faith Award studies) or a standalone
-- Bible study (the Faith tab) — so the next leader planning it sees the
-- link as a suggestion without having to find it again. A link stays in
-- the library when the plan that used it goes; a leader can hide one from
-- the suggestions instead.
CREATE TABLE link_library (
  id INTEGER PRIMARY KEY,
  badge_id TEXT REFERENCES badges(id),
  study_id INTEGER REFERENCES faith_studies(id),
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'web' CHECK (kind IN ('web', 'sharepoint')),
  drive_id TEXT,                          -- SharePoint driveItem, when kind = 'sharepoint'
  item_id TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,      -- 1 = left out of the suggestions
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  CHECK ((badge_id IS NULL) <> (study_id IS NULL))   -- exactly one owner
);
CREATE UNIQUE INDEX link_library_badge ON link_library(badge_id, url) WHERE badge_id IS NOT NULL;
CREATE UNIQUE INDEX link_library_study ON link_library(study_id, url) WHERE study_id IS NOT NULL;

CREATE TABLE plan_links (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  track TEXT NOT NULL DEFAULT 'badges' CHECK (track IN ('badges', 'faith')),
  link_id INTEGER NOT NULL REFERENCES link_library(id),
  position INTEGER NOT NULL,
  UNIQUE (plan_id, link_id)
);
CREATE INDEX plan_links_link ON plan_links(link_id);
