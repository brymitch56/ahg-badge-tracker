# ahg-badge-tracker

Leaders-only badge requirement tracker for an American Heritage Girls troop.
Two parts live here:

- **Catalog tooling** (`scripts/`, `lib/`) — pulls the award and requirement
  structure out of AHGFamily.org into versioned JSON and merges it with
  handbook annotations into the badge files everything else reads.
- **The tracker service** (`server/`) — plans badge work per event, proposes
  completions from check-in attendance for leaders to review, tracks progress
  and service stars, and can (behind admin switches, off by default) write
  confirmed results back to AHGFamily. A separate leaders' website is its
  front end.

Read `CLAUDE.md` first: this repo is public. AHGFamily access is read-only by
design and by code — `lib/ahgfamily.js` refuses any endpoint that changes
data — with **one** audited exception, the write-back in
`server/lib/servicepush.js`, described in `CLAUDE.md`. The catalog and fetch
scripts never write.

## Setup

```sh
cp .env.example .env   # then edit: AHG_EMAIL / AHG_PASSWORD
chmod 600 .env
npm test               # offline parser tests against synthetic fixtures
```

Node 22 recommended (20 is the declared minimum — see the note on
`better-sqlite3` below). The catalog scripts use only Node's standard
library; the tracker service has four runtime dependencies (`express`,
`better-sqlite3`, `jose`, `nodemailer`), so run `npm ci` before `npm test`.

## Scripts

`node scripts/fetch-ahgfamily-catalog.js [flags]` — logs in, reads
`#badge-select` / `#youth-select` / `#level-select` from
`/advancement/index?level=all&style=grid`, then POSTs
`/advancement/badge-tracker-view` (style=standard, one youth, lockedChecked=0)
once per award for structure, then once more in `style=grid` for the level id
(the Standard fragment has none) and a requirement-id cross-check, ~300 ms
apart (`--no-grid` skips the second request). Writes `data/ahgfamily/awards/<awardId>.json`
and `data/ahgfamily/index.json`. Resume-safe: awards already on disk are
skipped. Stops on the first auth failure. Output contains no youth ids, names,
or `ad…` record ids (placeholders `<youthHashid>` / `<adHashid>`).

Flags: `--pilot` (the three pilot badges only), `--only aw…,aw…`,
`--group "Explorer"`, `--limit N`, `--force`, `--keep-raw`,
`--youth-index N`, `--dry-run`.

`node scripts/check-pilot-badges.js` — offline; compares Nature & Wildlife,
Our Flag, and Toys & Games (Pioneer/Patriot) against the handbook numbering
and prints a diff.

## From catalog to badges (Option B)

`data/ahgfamily/` is the raw layer. Handbook annotations
(`data/handbook/*.json`, gitignored — the handbook is copyrighted) add the
full text; `npm run build:badges` merges the two into `data/badges/*.json`,
the only shape the website and tracker read. Retired awards and
non-current editions never reach `data/badges/`. Schema, rules and an
invented example: [`handbook/README.md`](handbook/README.md).

## Tracker service (`server/`)

Node/Express + SQLite (`better-sqlite3`), run under systemd on the Pi beside
the check-in app (`deploy/install-pi.sh`,
`deploy/ahg-badge-tracker.service.template`). Spec:
`docs/tracker-service-spec.md`; Pi setup: `docs/pi-setup.md`; Entra setup:
`docs/entra-setup.md`; tunnel: `docs/tunnel-setup.md`.

**`better-sqlite3` is a native module — check prebuilt binaries before
bumping it.** The locked release (12.11.1) ships prebuilts for **Node 22** on
Windows x64 and Linux arm64, but none for Node 20 on arm64; without a
prebuilt, `npm install` falls back to a from-source build needing Python and
a C++ toolchain. 13.x is not usable yet: it bundles its binaries and sets
`"gypfile": false`, but the npm bundled with Node 22 (10.x) ignores that
under `npm ci` and tries to compile anyway.

```sh
cp .env.example .env            # fill the "Tracker service" block
npm install
npm run migrate                 # apply server/migrations/*.sql
npm run build:badges            # data/handbook → data/badges
npm run import:catalog          # data/badges → tracker.db (versioned; also POST /api/v1/admin/catalog/import)
npm start                       # http://127.0.0.1:3100
curl -s http://127.0.0.1:3100/health
```

What the service does today (current state, decisions and what is still
open are in `docs/HANDOFF.md`):

- **Auth** — MSAL bearer validation (tenant JWKS cached and warmed at boot,
  issuer, audience = tracker app id, `scp`); leaders and admins are managed
  from the website, with `ADMIN_EMAILS` in `.env` as the recovery list.
- **Catalog** — versioned import of `data/badges` and the `/badges` reads.
- **Check-in mirror** — girls, events and attendance from the check-in app's
  Integration API, plus a signed webhook; leader-confirmed mapping of each
  girl to her AHGFamily record.
- **Plans** — per-event, per-unit plans with multi-session requirements, a
  program-year overview, and per-requirement planning history.
- **Proposals and review** — completions proposed from attendance, a review
  queue with bulk decisions, manual (at-home) completions, progress views.
- **AHGFamily pull** — weekly, read-only; reconciliation and conflict reports.
- **Service stars** — profile pull, star maths, proposals
  (`docs/service-stars-plan.md`).
- **Write-back** — the one audited writer, off by default; see `CLAUDE.md`.
- **Operations** — migrations on start, nightly backup job, optional e-mailed
  run report, `/health`.

Every request needs `Authorization: Bearer <token for
api://<tracker-client-id>/access_as_leader>` except `/health` (`/` is 404 by
design). `AUTH_DISABLED=true` (never in production) fakes an admin for local
development.

## Checking AHGFamily for changes (periodic)

AHG changes badges rarely — once every few years for a given award — so
**monthly is plenty; weekly at most.** Never nightly. Two steps, and the
second never changes anything without a person typing "yes":

```sh
npm run fetch:staging     # fresh pull into data/ahgfamily-staging/ (live catalog untouched)
npm run diff              # report: awards added/removed/changed, requirements +/−/~
                          # exit 0 = no changes, 10 = changes to review
node scripts/diff-catalog.js --md report.md   # same report as Markdown (PR body)
node scripts/diff-catalog.js --apply          # asks for confirmation, then promotes staging
                                              # to live; previous catalog kept as
                                              # data/ahgfamily-previous-<stamp>/
```

`--apply` refuses to run without an interactive terminal, so a scheduled
task can produce the report (and e-mail or post it) but can never apply it.
`--plannable-only` hides changes inside retired awards and prior-edition
groups. When the catalog lives in the website repo, the report is the pull
request body and merging the PR is the approval.

## Output shape (per award)

```json
{
  "awardId": "aw…", "name": "…", "imageSlug": "…", "levelGroup": "Pioneer/Patriot",
  "retired": false,
  "levelId": "le…",
  "wholeAwardOnly": false, "multiInstance": false, "instancePanels": 0,
  "wholeAwardKeyedBy": "award",
  "instructions": [],
  "groups": [
    { "label": "Complete All", "rule": { "type": "all" }, "edition": "current", "plannable": true, "items": [
      { "id": "<12-char requirement id>", "number": 1, "title": "…" },
      { "id": null, "number": 2, "title": "parent", "children": [
        { "id": "…", "letter": "a", "title": "…" } ] }
    ] }
  ],
  "itemCount": 11, "hasLetteredLeaves": false,
  "gridOnlyRequirementIds": [],
  "parse": { "mode": "title-first", "warnings": [] },
  "source": { "endpoint": "badge-tracker-view", "style": "standard", "level": "all", "youth": "<youthHashid>", "fetchedAt": "…" }
}
```

Group labels are AHGFamily's `<h4>` text verbatim ("Complete Three",
"History and Rules", "Together We Play (Choose One)"); `rule` is derived from
the label when it says "Complete/Choose N|All", else `null`. Groups labelled
with a year ("2016 Handbook") get `edition: "2016"`, `plannable: false` —
only current-handbook requirements are ever planned. `gridOnlyRequirementIds`
lists items the Grid view tracks but the Standard view hides (prior-edition
items on level awards); they are never plannable.

`scripts/reparse-raw.js` rebuilds award JSON from fragments saved with
`--keep-raw`, offline — use it when tuning the parser.

Awards whose AHGFamily name contains "(Retired)" are fetched (they still
exist as records) but carry `retired: true`; nothing downstream may offer
them for planning or tracking.

`data/` is gitignored. Raw HTML fragments (which contain the youth id used
for the fetch) are kept under `data/ahgfamily/raw/` only on parse failure or
with `--keep-raw`.
