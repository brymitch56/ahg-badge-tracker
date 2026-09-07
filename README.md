# ahg-badge-tracker

Leaders-only badge requirement tracker for an American Heritage Girls troop.
**Phase 1 (this repo today): read-only tooling that pulls the award and
requirement structure out of AHGFamily.org into versioned JSON.** The tracker
service and website pages come later and read from that catalog.

Read `CLAUDE.md` first: this repo is public, and the fetch scripts are
read-only by design and by code (`lib/ahgfamily.js` refuses any endpoint that
changes data).

## Setup

```sh
cp .env.example .env   # then edit: AHG_EMAIL / AHG_PASSWORD
chmod 600 .env
npm test               # offline parser tests against synthetic fixtures
```

Node 20+, no dependencies.

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

Node/Express + SQLite, runs under systemd on the Pi beside the check-in app
(`deploy/ahg-badge-tracker.service`). Spec: `docs/tracker-service-spec.md`;
Entra setup: `docs/entra-setup.md`.

```sh
cp .env.example .env            # fill the "Tracker service" block
npm install
npm run migrate                 # apply server/migrations/*.sql
npm run build:badges            # data/handbook → data/badges
npm run import:catalog          # data/badges → tracker.db (versioned; also POST /api/v1/admin/catalog/import)
npm start                       # http://127.0.0.1:3100
curl -s http://127.0.0.1:3100/health
```

Built so far (build order steps 1–2): `/health`; MSAL bearer validation
(tenant JWKS, issuer, audience = tracker app id, `scp`, leader group or
e-mail allow-list; admins from `ADMIN_EMAILS`); `GET /api/v1/me`;
`GET /api/v1/badges[?levelGroup=]`, `GET /api/v1/badges/:id`;
`POST /api/v1/admin/catalog/import`, `GET /api/v1/admin/catalog`,
`GET /api/v1/admin/audit`. Every request needs `Authorization: Bearer
<token for api://<tracker-client-id>/access_as_leader>` except `/health`.
`AUTH_DISABLED=true` (never in production) fakes an admin for local
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
