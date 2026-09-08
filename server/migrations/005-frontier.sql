-- 005-frontier: the handbook organizes badges into six Frontiers; the
-- AHGFamily select doesn't carry them, so the annotation supplies one and
-- the UI filters on it (alongside level group).
ALTER TABLE badges ADD COLUMN frontier TEXT;
