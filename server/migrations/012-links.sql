-- 012-links: links on plans, and each badge's library of links.
--
-- Every link a leader puts on a plan (a web page, or a SharePoint file
-- picked or uploaded from the planner) is kept on its badge, so the next
-- leader planning that badge sees it as a suggestion without having to
-- find it again. A link stays in the library when the plan that used it
-- goes; a leader can hide one from the suggestions instead.
CREATE TABLE badge_links (
  id INTEGER PRIMARY KEY,
  badge_id TEXT NOT NULL REFERENCES badges(id),
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'web' CHECK (kind IN ('web', 'sharepoint')),
  drive_id TEXT,                          -- SharePoint driveItem, when kind = 'sharepoint'
  item_id TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,      -- 1 = left out of the suggestions
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  UNIQUE (badge_id, url)
);

CREATE TABLE plan_links (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  track TEXT NOT NULL DEFAULT 'badges' CHECK (track IN ('badges', 'faith')),
  link_id INTEGER NOT NULL REFERENCES badge_links(id),
  position INTEGER NOT NULL,
  UNIQUE (plan_id, link_id)
);
CREATE INDEX plan_links_link ON plan_links(link_id);
