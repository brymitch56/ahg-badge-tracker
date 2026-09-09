# Service Stars — design, draft 2

*Sept 2026 · supersedes draft 1. Every draft-1 open question is resolved by
the capture session (raw + full findings: `data/captures/service-notes.md`,
local only — it documents live AHGFamily pages). Still planning: nothing is
built. Award ids and endpoint shapes here are program data, committable.*

## Policy (decided)

- Rates per star: Tenderheart 5 h · Explorer 10 h · Pioneer 15 h · Patriot 20 h.
- **Unused hours carry forward to the next level** (troop coordinator's
  ruling — and confirmed to be AHGFamily's own arithmetic on the profile
  eligibility table: `Total = On-Level + previous level's Extra`).
- **Pathfinder rows never count and never carry** (their service rows are an
  attendance artifact; Tenderheart's carry-in is always 0). Keep the rows in
  the mirror (real attendance data, bead work may want them); exclude them in
  the math.
- Star date on push: the tracker's confirmation date (matches how a leader
  stamps a manual add — the form seeds `date-specified` with today).

## The math (arithmetic-anchored chain)

Levels evaluate in program order, passing the remainder through levels with
no hours, clamped at zero, computed **from approved hours only** (never from
proposals or on-record counts — keeps proposals stable and order-independent):

```
available_L = approved_hours_at_L + carry_in_L        # carry_in_TH = 0
earnable_L  = floor(available_L / rate_L)
carry_out_L = available_L − earnable_L × rate_L
new_stars_L = earnable_L − stars_on_record_L          # <0 ⇒ conflict, not revert
```

**Hours are fractional** (0.25, 0.33, 1.75… all observed live). Accumulate as
**integer hundredths**; divide only at the end. A real girl sits at 14.95
carry toward a 15-hour star — float summing already mis-totals this exact
dataset. Cross-check available: AHGFamily's own `Stars Eligible` column
(profile Service tab) is hours-derived and trustworthy — read it as a sanity
check against our result and surface disagreement; never adopt it blindly.

## Data sources (chosen, verified complete)

**Approved hours — `GET /activities`**, the one ledger (per-entry rows:
date, description, `Event Level` = *the girl's level at the time* — proven,
so no attribution heuristic — `Service Hours`, boolean `verified`).
Completeness verified: one girl's profile ledger vs the troop export matched
86/86 rows and summed identically.

- Filter params are `ActivitiesSearch[...]`: `service_hours=1`,
  `verified=1`, `user_id=<youthHashid>`; plain GET, pageable, `per-page`
  accepted (ceiling untested). Sticky session filters: **always send
  explicit filters and assert the result count** or a fetch inherits
  whatever the last request filtered.
- ⚠️ **The HTML grid truncates hours to integers.** It supplies identity
  (`/profile?id=<youthHashid>` per row) and the verified flag, but hour
  VALUES must come from either the **per-girl profile ledger** or the
  **per-girl filtered XLSX export** (the troop-wide export has names only —
  never design a name join; names collide in this troop today).
- Preferred pull shape: **one `GET /profile/<youthHashid>?tab=advancement`
  per girl** — a single response carries all six tabs: the precise service
  ledger (`Time Spent` decimal-rendered), the eligibility table, and the
  per-instance awards grid. ~1 GET/girl/week at the standard throttle.

**Stars on record — the existing read**, four more award ids:

```
POST /advancement/badge-tracker-view
  _csrf, level=all, style=standard, lockedChecked=1,
  youth[]=<hashid…>   (array — batching possible, limit untested)
  badges=<awardId>
```

| Award | id |
|---|---|
| Service Star (Tenderheart) | `awfhjudhre98` |
| Service Star (Explorer) | `awmhu7yetwrh` |
| Service Star (Pioneer) | `awamidjeryhs` |
| Service Star (Patriot) | `awlodir83ert` |

Instance panels carry five fields (`new-`, `completed_on-`, `awarded_on-`,
`purchased-`, `comment-` × `<adHashid>`). **The discriminator is `new-`:**
blank slots have `new-<id>="true"`; saved instances have no `new-` field.
Panel counts are dynamic (5 earned ⇒ 5 real + 5 blanks), and **same-date
instances are normal** (Court of Awards) — count by `ad…` record id, never
by date.

## The write (step 7 only, behind the flag)

**There is no granular add-instance endpoint.** The save is a full-form
POST of the entire Standard view (~64 fields) to `POST /advancement/index`
(302 on success): every panel of every instance is echoed back, with the
new star being one blank panel's `new-<adHashid>=true` +
`completed_on-<adHashid>=<date>`. The `ad…` slot ids are server-generated
inside the fragment. Consequences, all mandatory:

1. **Read-modify-write**: fetch the fragment immediately before the save;
   echo every existing field **byte-for-byte** (unfetched or reformatted
   fields get cleared/rewritten — epoch-0 `awarded_on` dates round-trip
   verbatim today and must keep doing so).
2. **Serialize per girl+award** (no lock token; last write wins).
3. **Provenance stamp**: write a short marker into the new instance's
   `comment-` (e.g. `tracker: 47.50h Pioneer, confirmed 2026-09-08`) —
   distinguishes tracker-added stars from hand-added ones on later pulls,
   visible to leaders on AHGFamily. Preserve existing comments exactly.
4. Verified live: adding one star left the other 9 panels untouched, and
   the saved panel drops its `new-` field (the discriminator round-trips).

## New forbidden endpoints (extend the never-call list)

- `GET /fields/toggleServiceVerified/<id>?attribute=verified` — **a GET that
  writes** (flips approval). A crawler that follows hrefs would corrupt
  approvals; every `/activities` parse must read hrefs, never fetch them.
- The per-row Menu actions on `/activities` and the profile grids
  (edit/delete — the profile awards grid has a `Delete?` per instance).
- `/advancement/delete` (unchanged).
Approval of girl-submitted hours stays on AHGFamily; the tracker only reads
the pending count (dashboard's "Unapproved Service/Sports Hours" — mixes
sports, so filter service rows before showing a nudge).

## Legacy history ⇒ baseline at first sync (new requirement)

History is ~6 years deep; girls legitimately hold stars their *current*
ledger doesn't explain (`Stars Eligible = 0` with stars recorded is normal).
On first sync, record a **per-girl, per-level baseline** (instances found,
hours-explained count) and raise conflicts only for movement *after*
baseline. Without this, day one drowns in false conflicts. Same run also
surfaces a large backfill batch of proposals → the proposals UI needs
**bulk confirm** ergonomics before this ships.

## Parser fixes required before building (verified in code)

1. `parseStandardState` counts blank `new-` panels as records
   (`lib/parse.js` — a 5-star girl parses as 10 instances, which flips every
   star-holder to a false conflict). Carry an `isNew` flag; count instances
   as `!isNew`; **do not** use "has a date" as the test. Fixture: the
   5-earned/5-blank shape.
2. Treat epoch-0 dates (`12/31/1969`/`01/01/1970`) as null when *reading*
   (still echo verbatim when writing).
3. Grid parsing: exclude `tr.kv-page-summary` (it renders **inside tbody**
   — naive sums double, which over-awards); never trust page-summary sums
   (page-scoped); discover the `_tog…` widget hash per page, don't hardcode.

## Build order (when approved — read side first, no writes)

1. **Parser fixes** above + fixtures (from the captured fragments, ids
   invented).
2. Migration: `service_hours` mirror (per entry: girl, date, level, hours
   in hundredths, verified, description), `award_instances` (award-generic:
   girl, award id, `ad…` id, completed_on, comment), `star_baseline`,
   push_queue action `add_instance` (unused until step 7).
3. Weekly pull extension (same session/throttle/latch): per-girl profile
   ledger + 4 star-award fragments; assert distinct-youth coverage against
   the roster and **fail loudly on shortfall** (a silent undercount
   suppresses stars — the dangerous direction). First run writes baselines.
4. Star math + proposals (`source: 'service'`) + conflicts; Stars view on
   Progress (hours at level, carry-in/out, on record, next-star progress);
   bulk confirm on the proposals screen; AHGFamily `Stars Eligible`
   cross-check warning.
5. **Pre-write verifications** (one supervised session, before any push
   code): do blank `new-` slot ids survive a delay between fragment fetch
   and save? what does a rejected save look like (vs the 302)? `/activities`
   role-scoping under the pull account; `per-page` ceiling; `youth[]` batch
   limit.
6. Step 7: `add_instance` push per the write contract above — plausibly the
   FIRST push we enable (single additive save, lower risk than requirement
   toggling), weekly report includes stars.

## Pathfinder beads (unchanged from draft 1, now cheaper)

Beads are the same multi-instance model; `award_instances` + the
`add_instance` push cover them unchanged. The attendance bead's source is
our own check-in mirror (no new reads); memory-verse/service-project beads
need small local counters. Phase after stars.
