-- 014-pathfinder-verses: memory verses covered at a Pathfinder meeting.
--
-- json array of { stone, verse } (stone null for a bonus verse). Every
-- Pathfinder checked in to that meeting is proposed the verse's heart bead;
-- the troop gives the heart for being there when it's taught.
ALTER TABLE pf_plans ADD COLUMN verses TEXT NOT NULL DEFAULT '[]';
