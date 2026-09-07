-- 003-review: rule 5 — a voided transaction under an already-confirmed
-- completion flags it for a leader instead of silently reverting it.
ALTER TABLE completions ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE completions ADD COLUMN review_reason TEXT;

-- The scheduled sweep re-polls an event until one post-event fetch finds
-- no open rows (rule 4b); this records the last fetch so quiet events stop
-- being polled.
ALTER TABLE events ADD COLUMN attendance_fetched_at TEXT;
