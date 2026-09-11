# Step 5 — pre-write verification session (supervised, one sitting)

`docs/service-stars-plan.md` build order, step 5. This is the last gate before
any push code (step 7). It is **not automated and never will be**: it includes
one real save on AHGFamily, so it runs with a leader at the keyboard, on a
record chosen for the purpose, and everything observed is written down here.

Read-only rules still apply to everything except the single save in §4:
nothing in this session calls `/advancement/delete`, `process-advancement`,
`fields/toggleServiceVerified`, or any per-row Menu/Delete control.

## 0. Before the session

- A **test youth** (a leader's own record, or a girl whose family has agreed)
  and a **test award instance** that can be added and then removed *by hand
  on AHGFamily* afterwards. Write down which, here (no ids in git — keep the
  ids in `data/captures/step5-notes.md`, which is gitignored).
- The pull account signed in in a browser tab (for the manual clean-up) and
  the tracker's stored credentials working (`GET /health` → `"ahgfamily":"ok"`,
  no latch).
- Captures go to `data/captures/step5-*.html` (gitignored). Fixtures derived
  from them later get invented ids.

## 1. Do blank `new-` slot ids survive a delay?

The Standard-view fragment carries blank panels with server-generated
`new-<adHashid>` slot ids. The push design fetches the fragment, then saves
minutes later (read-modify-write). Question: is a slot id still valid after a
delay, or is it session/request-scoped?

1. Fetch the Standard fragment for (test youth × test award) via
   `badgeTrackerView(…, { style: 'standard' })`. Save as `step5-standard-t0.html`.
   Note the blank panels' `new-` ids.
2. Wait **10 minutes** without touching AHGFamily.
3. Fetch it again → `step5-standard-t10.html`. Compare the `new-` ids.
   - Same ids → slots are stable; a 10-minute read-modify-write window is safe.
   - Different ids → slots are per-fetch; the push must fetch and save within
     one request pair (spec §"The write", rule 1 becomes stricter).
4. Also fetch once from a **second** signed-in session (the browser tab) and
   compare — if ids differ per session, the push must never reuse a fragment
   fetched under another login.

## 2. What does a rejected save look like?

Rule 1 says a good save answers **302**. The push needs to recognise the
failure shape without guessing.

1. POST `/advancement/index` with the fetched form **minus one required
   field** (e.g. drop `completed_on-<slot>` but keep `new-<slot>=true`).
   Record status, `Location`, and the body → `step5-rejected-save.html`.
2. POST it again with an **invalid date** (`13/45/2026`). Record the same.
3. POST with a **stale** fragment (the `t0` form after a browser-side edit to
   the same instance). Does the server refuse, or does last-write-win silently?
   This decides whether the push needs a read-back compare after every save.

Expected outcomes to write down: HTTP status for each, whether the form
re-renders with a validation message (and its markup — that becomes the
"rejected" detector), and whether any partial write happened (check the
profile awards grid after each attempt).

## 3. Read paths, under the pull account

- `/activities` role-scoping: does the pull account see **every** mapped
  girl's rows, or only its own troop/level? Compare the distinct-youth count
  on `/activities` (all pages) with the mapped roster. Any shortfall is the
  dangerous direction (suppressed stars) and must abort the pull, which
  `servicepull.js` already does — this confirms the baseline is complete.
- `per-page` ceiling: request `/activities?per-page=500`; note the actual page
  size returned (the grid summary line). The pull pages by following hrefs
  either way, but the ceiling sets how many requests a full pull costs.
- `youth[]` batch limit on `badgeTrackerView`: grid style with 1, 10, 31,
  and 60 youth ids. Note where it truncates or errors. The weekly pull batches
  by this number.

## 4. The one real save (the pilot of step 7)

Only after §1–§3 are recorded:

1. Fetch the Standard fragment for (test youth × test award) fresh.
2. Echo every field byte-for-byte, fill exactly one blank panel:
   `new-<slot>=true`, `completed_on-<slot>=<today MM/DD/YYYY>`,
   `comment-<slot>=tracker: step5 verification <date>`.
3. POST `/advancement/index`. Expect 302.
4. Read back: profile awards grid shows one more instance with that comment;
   the other panels are untouched (compare with the fetched fragment).
5. **Remove it by hand on AHGFamily** in the browser. Confirm the grid is back
   to its previous count.

## 5. After the session

- Fill in the answers below and commit this file (answers only — no ids, no
  names, no captured HTML).
- If §1 says slots are per-fetch or §2 shows silent last-write-wins, update
  `docs/service-stars-plan.md` → "The write" before step 7 starts.
- Step 7 stays behind its flag and behind Bryan's explicit go.

## Answers (fill in)

| Question | Answer | Date |
|---|---|---|
| `new-` slot ids stable across 10 min? | | |
| …across sessions? | | |
| Rejected save: status / shape | | |
| Stale save: refused or last-write-wins? | | |
| `/activities` coverage = mapped roster? | | |
| `per-page` ceiling | | |
| `youth[]` batch limit | | |
| Pilot save + read-back + manual removal | | |
