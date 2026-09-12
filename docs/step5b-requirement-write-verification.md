# Step 5b — verifying the per-requirement write (supervised, one sitting)

Step 5 (`docs/step5-verification-session.md`) proved the Standard-view save
for **star instances**. The requirement push (`pushRequirementMarks` in
`server/lib/servicepush.js`) uses the same full-form save to set a
requirement's `checkbox-<reqId>`, `date-<reqId>` and `comment-<reqId>` — but
that has **not** been watched live. Until this session runs, keep
`push_requirements_enabled` OFF (it is off by default; `push_enabled` alone
does not turn it on).

What the code assumes, and what this session must confirm or refute:

1. Submitting the Standard form with `checkbox-<reqId>` present (value = the
   input's own `value`, `"1"` on the live form) **marks the requirement
   complete** — the same effect as the grid's AJAX `process-advancement`
   toggle — and a form submitted without it leaves an unchecked item
   unchecked (it must NOT un-check a checked item that we echo back).
2. `date-<reqId>` is stored as the requirement's completion date and reads
   back verbatim (`MM/DD/YYYY`).
3. `comment-<reqId>` is stored and reads back **verbatim**; find the length
   limit (the tracker caps notes at 1000 characters — `reqnote.MAX_LEN`) and
   whether `|`, `—`, `&`, `'` survive the round trip. A silently truncated
   note reads back as a mismatch and the row is **held**, so the cap must be
   at or below the real limit.
4. Nothing else on the form moves: every other requirement's
   checked/date/comment and every star-instance panel come back
   byte-identical (the push checks this and holds on any difference).
5. Does a checked requirement whose badge is now complete change the badge's
   `completed_on` on its own (AHGFamily-side roll-up), or is that only the
   whole-badge form field? The push never sets whole-badge dates; the answer
   decides whether a later step must.

## Protocol

Test record: one girl (a leader's own record if it has advancement, else a
girl whose family agreed), one badge with an unchecked requirement that she
has **actually** completed or that the leader will un-check by hand after.
Ids stay in `data/captures/step5b-notes.md` (gitignored), never in git.

1. Fetch the Standard fragment for (girl × badge) with `session.standard`;
   save it as `data/captures/step5b-standard-t0.html`. Note the target
   requirement's current `checkbox-`/`date-`/`comment-` values and every
   other item's.
2. Build the body exactly as `pushRequirementMarks` does (call
   `servicepush.fragmentPairs` with `check: ['checkbox-<reqId>']` and the
   date/comment set), POST it with `session.save`, record status/location.
3. Read back (`session.standard` again → `parseStandardState`): is the item
   checked, with that date and that exact comment? Are all other items and
   panels unchanged? Open the girl's profile on AHGFamily in a browser and
   confirm the requirement shows complete with the note visible.
4. Repeat step 2 with a **1200-character** comment to find the limit; note
   what reads back. Then with a comment containing `| — & ' "`.
5. If this was a test mark, **un-check it by hand on AHGFamily** (the
   tracker never un-marks). Confirm the read-back shows it unchecked.
6. Record the answers below and commit this file (answers only).

## Answers (fill in)

| Question | Answer | Date |
|---|---|---|
| Standard save marks a requirement via `checkbox-`? | | |
| Echoing a checked item keeps it checked? | | |
| `date-` stored and read back verbatim? | | |
| Comment limit / special characters | | |
| Other items and panels untouched? | | |
| Badge-level roll-up on AHGFamily? | | |

Once all six are answered and nothing contradicts the code, an admin can turn
on **Also push requirement completions** on the Push-queue panel. If any
answer contradicts an assumption, fix `pushRequirementMarks` first and rerun.
