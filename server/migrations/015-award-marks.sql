-- 015-award-marks: Stars & Stripes steps a leader marks by hand.
--
-- AHGFamily has no Stars & Stripes award, so the Awards tab keeps its steps
-- here (handbook/awards.json names them). Never pulled or pushed.
CREATE TABLE award_marks (
  id INTEGER PRIMARY KEY,
  girl_id INTEGER NOT NULL REFERENCES girls(id),
  step TEXT NOT NULL,
  done_on TEXT NOT NULL,                  -- YYYY-MM-DD
  notes TEXT,
  marked_by TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  UNIQUE (girl_id, step)
);
