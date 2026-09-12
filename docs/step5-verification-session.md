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

## Answers (session run 2026-09-12, Bryan present; one Patriot-level test girl, ids kept out of git)

| Question | Answer | Date |
|---|---|---|
| `new-` slot ids stable across 10 min? | **No — they change on every `badge-tracker-view` fetch**, even two back-to-back in one login. Saved-instance ids are stable. | 2026-09-12 |
| …across sessions? | Different per fetch, so also different per session. | 2026-09-12 |
| Rejected save: status / shape | **There is no rejection.** Every POST answered **200** (not 302 — the 302 in CAPTURE 5 was the browser navigation) with the full page and an `alert-success` block, whether or not anything was written. Missing `completed_on` with `new-=true` → nothing written. `completed_on=13/45/2026` → **an instance was created with a null date** and our comment. No validation markup anywhere. | 2026-09-12 |
| Stale save: refused or last-write-wins? | **Honoured.** A `new-` slot id from an older fetch (already superseded by a newer fetch) created a correctly dated instance. The id is evidently just an unused token, not a reservation. Concurrency: no lock token; assume last-write-wins. | 2026-09-12 |
| `/activities` coverage = mapped roster? | **No.** 28 of 29 mapped girls; two (with 11 and 20 verified rows on their profile ledgers) are absent even unfiltered. Their profile pages load fine — the profile path the pull uses is the right one; `/activities` must never be the source. | 2026-09-12 |
| `per-page` ceiling | Ignored: **25 rows fixed** (671 rows → 27 pages), `per-page=500` and `1000` both return 25. | 2026-09-12 |
| `youth[]` batch limit | 29 ids in one request fine (117 KB fragment). The two ids dropped were the same two girls — they are **outside the pull account's advancement scope** (not in the page's youth dropdown), not a ceiling. `s.grid()` on a **star** award returns a 1.3 KB stub (no grid for instance awards; expected). | 2026-09-12 |
| Pilot save + read-back + manual removal | Written (via the stale-slot test): 7 → 8 instances, new panel `09/12/2026`, comment `tracker: step5 verification 2026-09-12`, awarded_on empty, not purchased; all pre-existing panels byte-identical. Read-back via fragment and profile grid agree. Removal by Bryan by hand — **two** instances to delete (the dateless one from the invalid-date test, and this one). | 2026-09-12 |

### Consequences for step 7 (update `service-stars-plan.md` → "The write")

1. **Fetch-and-save in one breath.** Never queue a slot id; the queue holds
   the intent (girl, award, date, comment), and the push fetches the fragment
   immediately before the POST.
2. **The server validates nothing.** The push must validate the date itself
   (`MM/DD/YYYY`, a real calendar date, not in the future) before sending;
   a bad date does not fail, it writes a dateless star.
3. **Success is only provable by read-back.** Treat 200 + `alert-success` as
   "request accepted", then re-fetch the fragment and confirm: instance count
   +1, the new panel carries the sent date and comment, every pre-existing
   panel unchanged. Anything else → conflict for a human, never a retry.
4. **Scope check before every pull and every push.** A mapped, active girl
   who yields no cells / is not in the youth dropdown must be reported, not
   silently skipped — `ahgpull.js` currently leaves her `ahg_state` stale
   with no warning (two girls since 2026-09-08).

### Housekeeping

The session scripts and captures live only on the Pi under
`data/captures/step5-*` (gitignored): `step5-read{,2..6}.js`,
`step5-write.js` (phases a/b/c run; `d` not needed), fragments t0/t10, POST
bodies and responses. The girl is passed as `STEP5_GIRL` on the command
line, never stored.
