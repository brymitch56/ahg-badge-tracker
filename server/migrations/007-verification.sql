-- 007: a leader's explicit verification on a completion whose planned
-- sessions were not all attended (a girl missed a start/continue meeting
-- but was present at the finish). JSON: { missed: [YYYY-MM-DD…], note,
-- verifiedBy, verifiedAt }. NULL = nothing was missed, or not yet decided.
ALTER TABLE completions ADD COLUMN verification TEXT;
