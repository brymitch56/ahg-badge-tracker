# Service Stars (and later, Pathfinder beads) — design draft

*Draft 1 · Sept 2026 · planning only — nothing here is built. Decisions
marked ❓ are open for Bryan.*

## The problem

AHGFamily accrues **approved service hours** per girl (leaders attach hours
to troop events; girls self-report and a leader approves). Stars are earned
per level at a fixed rate, and the pain is the ledger: which hours are
already "spent" on earned stars vs. carrying toward the next one — plus
actually adding the star **instances** on AHGFamily (one record per star,
"Add award instance") for every girl, every time.

| Level | Hours per star |
|---|---|
| Tenderheart | 5 |
| Explorer | 10 |
| Pioneer | 15 |
| Patriot | 20 |

Pathfinders earn no stars (they have beads — see the last section).

## The key simplification

Nobody needs to track *which* hours were spent. Stars at a level are
interchangeable, so the ledger collapses to arithmetic over two numbers the
tracker can fetch:

```
earnable = floor(approved_hours_at_level / rate(level))
new_stars = earnable − stars_on_record_at_level
carryover = approved_hours_at_level − stars_on_record_at_level × rate
```

If hours are corrected downward on AHGFamily (an entry rejected later),
`new_stars` can go negative — that's a **conflict** for a leader (same
rule-6 posture as badges: surface, never silently revert).

## What AHGFamily gives us

**Stars on record — already solved.** The catalog shows `Service Star
(<level>)` is a whole-award, **multi-instance** award keyed by `ad…`
records (`instancePanels: 6`). Our existing read-only
`badge-tracker-view` (Standard style) + `parseStandardState` already
extract those instance records per girl. Counting existing stars = the
same pull we do for badges, pointed at four more award ids. Zero new
endpoints.

**Approved hours — the missing read.** We need one reliable, low-request
way to read *approved* hours per girl. Candidates, best first:

1. A troop-level service report page (one GET for everyone) — ideal.
2. A per-member service log page (N GETs, throttled — acceptable, ~1/girl/week).
3. A databuilder/export report if AHGFamily's Reports section offers
   service hours (we already speak that download protocol for the roster).

❓ **Capture needed #1:** Bryan browses the service-hours area once with
dev tools open and notes: the URL(s), whether the page distinguishes
**approved vs pending**, and whether hours are shown **per level** or as a
lifetime total. Save the page HTML locally (data/, never git — it's full
of names).

❓ **Open question — level attribution:** does AHGFamily itself bucket
hours by the level the girl was when serving? If yes, we read it directly.
If it only shows a total, the tracker attributes by **entry date vs. the
girl's level dates** — and then we need level-change dates (we know
`ahg_level` per roster sync; the transition date is only as fine-grained
as our weekly sync unless the service log itself shows per-entry dates,
which it almost certainly does).

❓ **Open question — carryover across levels:** when a girl levels up, do
leftover hours reset (per-level buckets) or carry into the new level's
math? (If AHGFamily reports per-level, its answer wins; if we compute,
we need the troop's rule. AHG policy reads as per-level reset — confirm.)

**Adding a star — the missing write.** The "Add award instance" POST
(the Standard form's `new-ad…` panel submit). This is a **write** and
belongs to the step-7 push module, behind the same flag, latch, and
read-before-write rules. ❓ **Capture needed #2:** one dev-tools capture of
adding a star instance manually (URL, form fields, how the level/date are
carried). Until then, nothing to build on the write side anyway.

## How it fits the existing machinery (almost everything reuses)

| Piece | Reuse |
|---|---|
| Weekly pull | extends: after badge grid pull, fetch star instances (badge-tracker-view per level award × mapped girls) + service hours (new page). Same session, same throttle, same latch. |
| Mirror tables | new `service_hours` (girl, level, approved_hours, fetched_at) and `award_instances` (girl, award_id, ad_record_id, completed_on) — instance mirror is award-generic so beads reuse it. |
| Proposals | new proposal kind: "Service Star #3 (Pioneer) — 47 hrs approved, 2 on record". Same proposed → confirm/reject flow, same audit. Confirming stamps the girl's current level (rule 9 analog). |
| Push queue | new action `add_instance` (needs a CHECK-constraint migration). Read-before-write = re-count instances immediately before POSTing so a star added by hand on AHGFamily is never duplicated. Multiple new stars = multiple queued instances. **Never** the delete endpoint. |
| Conflicts | `new_stars < 0` (hours revoked, or an instance removed there while confirmed here) → open conflict. |
| UI | Progress page gains a Stars view: per girl — hours at level, stars on record, pending proposals, "7/15 toward the next". Proposals screen shows star proposals beside badge ones. |
| Report e-mail | star pushes ride the same weekly run report. |

Deliberately **out of scope**: the tracker never writes service hours and
never approves girl-submitted hours — approval stays on AHGFamily. ❓ Worth
surfacing a read-only "N pending approvals" nudge on the Admin page?

❓ **Star dates on push:** an instance wants a `completed_on`. The honest
date (when the qualifying hour was approved) isn't knowable cheaply.
Options: date of confirmation in the tracker (simple, recommended) or a
leader-editable date on the proposal (like badge proposals today).

## Build order (when we build)

1. Captures #1/#2 + one saved sample of a Standard fragment for a Service
   Star award with existing instances (verifies the 6-panel parse against
   reality — same "first live pull" caveat badges had).
2. Migration: `service_hours`, `award_instances`, push_queue action.
3. Pull: hours + instances into the mirror; star math; proposals.
4. UI: Stars view + proposals integration.
5. Push `add_instance` inside step 7's module when that ships (stars might
   even be the *first* push we turn on — single POST, no toggle semantics,
   lower risk than requirement toggling).

## Pathfinder beads (phase after stars)

Same multi-instance model, confirmed from the catalog: Attendance (Blue
Round Bead), Memory Verses (Red Heart Bead), Service Projects (White Star
Bead) are all `multiInstance, keyedBy: record`; Stepping Stones One–Six
are single-instance whole-awards. Notable: the **attendance bead's source
of truth is our own check-in mirror** — the tracker can propose attendance
beads with no new AHGFamily reads at all. Memory-verse and service-project
beads need a local counting UI (nothing on AHGFamily to pull). The
`award_instances` mirror + `add_instance` push built for stars covers the
write side unchanged; Pathfinder support then becomes mostly UI plus two
small counters.
