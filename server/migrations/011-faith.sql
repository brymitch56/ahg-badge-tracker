-- 011-faith: the Faith tab. Faith work is planned apart from badgework so
-- the two planners don't step on each other, but it rides the same plans,
-- plan_items, attendance proposals and completions.

-- 'award' = the Faith Award itself (AHGFamily's B.Y. Faith Award, one per
-- level); 'badge' = a handbook badge tagged as a faith badge. Set by the
-- build from handbook/faith.json.
ALTER TABLE badges ADD COLUMN faith TEXT;
-- 'handbook' (annotated) | 'ahgfamily' (built from AHGFamily's short titles,
-- handbook wording still to come)
ALTER TABLE badges ADD COLUMN text_source TEXT;

-- Which planner owns a plan item. The badge planner and the faith planner
-- each replace only their own items; one plan row (per event per unit)
-- holds both, so a meeting's attendance proposes for both alike.
ALTER TABLE plan_items ADD COLUMN track TEXT NOT NULL DEFAULT 'badges' CHECK (track IN ('badges', 'faith'));
ALTER TABLE plans ADD COLUMN faith_notes TEXT;

-- Bible studies a unit does that aren't tied to a badge or the Faith Award.
-- Planned per meeting (which lesson), never completed per girl.
CREATE TABLE faith_studies (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  units TEXT NOT NULL DEFAULT '[]',       -- json array of plan units; [] = every unit
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE plan_studies (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  study_id INTEGER NOT NULL REFERENCES faith_studies(id),
  lesson TEXT,                            -- e.g. "Lesson 3 — Ruth"
  position INTEGER NOT NULL,              -- shares the faith items' position space
  notes TEXT,
  UNIQUE (plan_id, study_id)
);
CREATE INDEX plan_studies_study ON plan_studies(study_id);
