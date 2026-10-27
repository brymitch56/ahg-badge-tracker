# Pathfinder bead push — first live check

The bead push (`server/lib/servicepush.js` → `pushBeadNotes`, action
`bead`) ships behind `push_pathfinder_enabled` (default off) on top of
`push_enabled`. Its write shape has only met fixtures, so watch it once on
AHGFamily before leaving it on.

What it does: AHGFamily keeps ONE instance per bead award (seen live
2026-10-27 — a Pathfinder's attendance bead shows a single panel and no blank
slot once one is saved). Each bead a leader confirms appends one line to that
instance's comment and never edits what is already there:

- attendance / memory verse / service — record-keyed panel. First bead: fills
  a blank slot (`new-<ad…>` = true) with its date and line. Later beads: keep
  the date already there, append `\n<line>`.
- stepping-stone logo beads — award-keyed (`completed_on-<aw…>`,
  `comment-<aw…>`): date set if blank, line appended.

Lines: `Bead 7 of 7 to date: 2026-10-26 (tracker)`, `Heart 3 of 3 to date:
2026-10-05, Luke 6:31 (tracker)`, `Star 2 of 2 to date: 2026-10-24, <project>
(tracker)`, `Stepping Stone 3 - Cherish My Family: 2026-11-11 (tracker)`.

## Steps

1. Admin → Push queue: turn on **Allow pushing**, then **Also push Pathfinder
   beads**. Confirm one bead for one mapped Pathfinder on the Pathfinder page
   (it pushes right away).
2. On AHGFamily (Track levels & awards → Pathfinder → that girl → the bead):
   the date and the line are there, any earlier comment text is intact,
   Awarded On / Purchased unchanged, still one panel.
3. Confirm a second bead of the same kind: the line is appended under the
   first, the date unchanged.
4. Admin → Push queue: both rows `sent`. A `held` row means the read-back did
   not match — look at AHGFamily, fix by hand if needed, then re-queue or
   remove the bead.
5. Note the result (and any comment-length limit seen) here.
