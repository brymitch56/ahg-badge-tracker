-- 009-star-legacy-mode: a leader's call on a girl's extra stars at a level
-- (stars on record at baseline beyond what her hours earned then).
-- 'separate' (default, the behaviour so far): legacy stars added on top of
-- what the hours earn. 'hours': they count against her hours instead.
-- Stars explained by Pathfinder hours are handled automatically either way
-- (lib/stars.js computeStarChain).
ALTER TABLE star_baseline ADD COLUMN legacy_mode TEXT NOT NULL DEFAULT 'separate' CHECK (legacy_mode IN ('separate', 'hours'));
