# Handoff — where the build stands (Sept 7, 2026)

Read `CLAUDE.md` first (public repo, PII rules, read-only AHGFamily rule,
copyright rule). Then this file, then `docs/tracker-service-spec.md` (draft 3).

## State

- **Catalog**: 548 AHGFamily awards fetched and parsed (0 warnings), local at
  `data/ahgfamily/` with raw fragments for offline re-parse (`npm run reparse`).
- **Pilot badges**: Nature & Wildlife, Our Flag, Toys & Games (Pioneer/Patriot)
  annotated from handbook scans (`data/handbook/`) and built (`data/badges/`).
  `scripts/check-pilot-badges.js` passes 3/3.
- **Tracker service** (`server/`): build order steps 1–2 done — Express 5 +
  better-sqlite3 (pinned 12.4.1 for prebuilt binaries), migrations
  (`001-init.sql` = full spec §4 schema), `/health`, MSAL bearer validation
  (`server/lib/auth.js`), versioned catalog import (`server/lib/catalog.js`),
  `/api/v1/me`, `/badges`, `/badges/:id`, `/admin/catalog(/import)`,
  `/admin/audit`. `deploy/ahg-badge-tracker.service` for the Pi.
- **Tests**: `npm test` → 24 passing, all offline (synthetic fixtures, local
  JWKS, in-memory SQLite).
- **Not yet done on Bryan's PC**: `npm run migrate`, `npm run import:catalog`,
  `npm start` + `curl /health` against the real pilot badges.
- **Entra**: not yet registered. `docs/entra-setup.md` (also a PDF beside the
  repo) is the admin's guide. Until it exists, `AUTH_DISABLED=true` (dev only)
  fakes an admin.
- **Check-in app**: AHG instance not yet installed on the Pi (systemd, no
  Docker). It will need `TLC_EXPORT_PATH=/user/exportexcel?format=xlsx`.
  Integration API contract: the troop-checkin repo's `docs/13-integration-api.md`
  (v0.4.35); consumer notes in `docs/handoff-to-checkin-roster-identity.md`
  and `docs/reply-to-checkin-roster-identity.md`.

## Decisions that shape the remaining build (all from Bryan)

- Retired awards and 2016-handbook groups are never plannable (already
  filtered out of `data/badges/`).
- Plan items carry `role` ∈ session|start|continue|finish; attendance proposes
  a completion only on session/finish, records participation otherwise.
- Attended ⇔ check-in attendance row has `open: 0` (a sign-out exists —
  kiosk, admin close, or SMS confirmation). Voided sign-out re-opens.
- Levels: TH/EX badges are separate awards, both earnable; a PiPa badge is one
  award, earned once, applied to the girl's current level at confirmation
  (`level_at_completion`); no retroactive handling — corrections happen in
  AHGFamily and arrive via the weekly pull. Level strings are exactly
  Pathfinder|Tenderheart|Explorer|Pioneer|Patriot.
- Girl ↔ AHGFamily `u…` id: no hashid in the export. Fill-when-empty from
  (1) check-in `tlc_user_id` (kiosk badge scans), (2) tracker mapping screen
  fed by AHGFamily's `#youth-select` (name-matched, leader-confirmed),
  (3) manual.
- Weekly automatic push with a report e-mailed after every run
  (`report_mode` = always | errors_only). Push ships behind a flag, OFF.
- Admins: Bryan, the Troop Coordinator, the tenant-admin leader
  (`ADMIN_EMAILS`). Hostname `badges.<domain>`. No Docker anywhere.
- Catalog update check is monthly, human-approved (`npm run fetch:staging`,
  `npm run diff`, `--apply` with an interactive "yes"). Never nightly, never
  auto-apply.

## Build order (spec §10) — next is step 3

3. Check-in Integration API client (`/ping`, `/events`, `/people`,
   `/events/:id/attendance`), HMAC webhook receiver (`/webhooks/checkin`,
   raw body, 5-min window, dedupe on `txn.id`), girls/events/attendance
   mirror, `#youth-select` mapping screen API (`lib/ahgfamily.js` already
   reads that page; add a parser that returns name ↔ id pairs — this data
   lives only in `tracker.db`).
4. Plans API (`PUT /events/:id/plans/:levelGroup` with roles).
5. Proposals from attendance (rule 3/4b), decide endpoint, per-girl and
   per-badge progress views, `badge_status` derivation (all / n_of).
6. AHGFamily pull (grid view per active badge per girl) → `ahg_state`,
   conflicts.
7. Push behind the flag: read-before-write toggle, `dateSpecified` = the
   completion date, whole-badge `completed_on` only via the Standard form
   post and only when rule 1 says complete, auth-failure latch, weekly
   e-mailed report. **Never** call `/advancement/delete`.

Then website leaders-area pages (hub + Documents/Badges/Planning/Progress/
Admin) against the API, and handbook scanning for the rest of the book.

## Working notes

- Tests must stay offline: record check-in API responses as fixtures from a
  local troop-checkin instance; AHGFamily fragments come from
  `data/ahgfamily/raw` (never commit them — they contain a youth id).
- Requirement ids are 12 random alphanumerics with no prefix; never classify
  an id by prefix.
- `better-sqlite3` is pinned to a version with prebuilds for Node 22 win32-x64
  and Pi arm64; check before bumping.
- Deploy to the Pi is a separate, human-triggered session, like the check-in
  app's.
