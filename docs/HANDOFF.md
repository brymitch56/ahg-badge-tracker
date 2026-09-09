# Handoff — where the build stands (Sept 8, 2026, evening)

Read `CLAUDE.md` first (public repo, PII rules, read-only AHGFamily rule,
copyright rule). Then this file, then `docs/tracker-service-spec.md`
(draft 3) and `docs/service-stars-plan.md` (draft 2, next feature).

## Deployed and live

- **Tracker service**: build-order steps 1–6 complete, running on the Pi
  (`/opt/ahg-badge-tracker`, systemd, 127.0.0.1:3100). Entra is registered
  and configured (MSAL auth live), the Cloudflare Tunnel serves
  `https://badges.ahg2911.org`, and the check-in AHG instance (port 3001 —
  port 3000 is the Trail Life instance) is wired: Integration API key +
  HMAC webhook verified. Deploy/ops: `docs/pi-setup.md`,
  `docs/tunnel-setup.md`; update = `git pull && npm ci --omit=dev &&
  sudo systemctl restart ahg-badge-tracker` (migrations run on start).
- **Website leaders pages** (site repo `ahg-troop-ny2911`, checkout
  `D:\AHG\Website`, work on branch `leaders-sharepoint`, main is merged
  from it; `gh` CLI is a different account — push with git, no PRs):
  Badges (frontier+level filters) · Planning (date presets/custom/paging,
  full handbook text per plan item, auto-growing notes, after-meeting
  proposals) · Progress (Program-year dashboard with stacked planned/held
  bars + per-badge drill-down modal, by-girl, by-badge, searchable
  comboboxes everywhere) · Admin (sync, conflicts, mapping, AHGFamily
  credentials, **leaders/admins user management** — stored lists merge
  with .env at every request; .env entries are the un-removable recovery
  hatch). Local page testing: `assets/config.local.example.js` +
  `scripts/serve-local.js` + SSH tunnel to the Pi.
- **Tests**: `npm test` → 97 passing, all offline (invented fixtures,
  local JWKS, in-memory SQLite). Must pass before any push.

## Server features beyond the original spec

- Website-managed access lists (`server/lib/access.js`,
  GET/POST `/admin/access`; admin e-mail implies leader; self-lockout
  guard; .env merged per request).
- Event mirror window widened to today−30…+365 (planner browses a year
  ahead; spec §7's −7…+90 superseded by decision).
- `GET /progress/year` + `GET /progress/year/badge` — plan-based
  program-year coverage (needed honors all/n_of rules; done = completing
  session's date passed) powering the dashboard + modal.
- Badges carry `frontier` (migration 005): `handbook/frontiers.json` maps
  badge name → frontier (transcribed from the printed Badge Index, both
  handbooks; loose-name matcher absorbs catalog drift). Build falls back
  to it; scaffold pre-fills it. Catalog has one badge in no index:
  "Women's History" (newer than the printing — set by hand when annotated).
- Plan items serve full requirement `text` + `subItems` (catalog titles
  are shortened; planner shows real wording).
- **Service Stars — read side BUILT (Sept 8, 2026), not yet deployed or
  live-verified.** `docs/service-stars-plan.md` build order 1–4 done:
  `lib/parse.js` isNew fix + `parseAhgDate` (epoch-0 → null), `lib/grid.js`
  (kartik grid parser, summary row excluded wherever it sits, pager hrefs,
  `_tog` hash discovery), `lib/service.js` (/activities index — identity
  only, hours truncated there; profile advancement page — precise ledger
  in integer hundredths, eligibility cross-check, per-instance awards),
  `lib/stars.js` (carry-forward chain, approved hours only, Pathfinder
  excluded, baseline-aware), migration 006 (`service_hours`,
  `award_instances`, `star_baseline`, `star_proposals`, push_queue
  `add_instance`), `server/lib/servicepull.js` (weekly pull: one profile
  page per mapped girl + a Standard fragment per star level up to hers;
  collected then written in one transaction; any unreadable/incomplete
  ledger aborts the run — nothing written). API: `POST /sync/service`,
  `GET /stars`, `GET /stars/proposals`, `POST /stars/proposals/decide`;
  star conflicts (`star_more_on_record`, `star_instance_removed`, no
  requirement id) go through `/conflicts` — accept_ahgfamily re-baselines
  the level. Website: Progress → "Service stars" chip (bulk confirm/reject,
  per-girl grid), Admin → "Pull service hours" button, conflict/queue rows.
  Allow-list now includes GET `/activities`, `/profile`, `/profile/<u…>`;
  a FORBIDDEN list in `lib/ahgfamily.js` refuses toggleServiceVerified,
  delete/update, process-advancement whatever the method.

## Catalog / annotation status

- 3 pilot badges built and imported (with frontiers). 343 annotatable
  badges remain (of 548 fetched; rest retired/whole-award-only).
- `npm run scaffold:annotation -- "<name>" --level <lg>` writes a
  structure-perfect skeleton (only prose missing); `--list` shows
  progress. Bryan has 16 scaffolds in flight (Fashion, Home Decorating,
  Kitchen Scientist, Medical, Native American, Our Heritage, Robotics,
  Zoology × tend/expl) — they fail the build with "empty text" until
  filled, which is expected. Flow: fill → `npm run build:badges` → scp
  `data/badges/` to the Pi → Admin "Re-import". Future: OCR/photograph
  handbook pages and have a session fill scaffolds directly (pilot badges
  were done this way). Handbook text never enters git.

## Next work (in likely order)

1. **Service Stars — deploy and verify live** (code is on main; the site
   is deployed on push). On the Pi: `git pull && npm ci --omit=dev && sudo
   systemctl restart ahg-badge-tracker` (migration 006 runs on start), then
   Admin → "Pull service hours" with Bryan watching. The first run is a
   backfill; check the summary's `warnings` and `crossCheck`. Things the
   parsers met only via captures/invented fixtures and MUST be checked on
   that first pull (any mismatch aborts the run rather than writing):
   - the profile page's grid headers (`Service Date · Act of Service ·
     Time Spent · Girl Level · Verified`) and pager links (paging is
     followed via the grid's own hrefs — never guessed);
   - the awards grid parse (`aw…`/`ad…` in the row markup) — currently
     informational only ("awards grid not found" is just a warning; stars
     on record come from the Standard fragments, which are verified);
   - per-girl profile access under the pull account (role scoping);
   - `Time Spent` really unrounded (sum one girl against her export).
   Plan-doc step 5 (pre-write verifications) is still open and belongs
   before any push code.
2. **Step 7 — push to AHGFamily**: still deliberately unbuilt, behind a
   flag, needs Bryan's explicit go after real-meeting testing. The star
   `add_instance` push may be its lowest-risk pilot. Includes the weekly
   e-mailed run report. Never `/advancement/delete`; also never
   `/fields/toggleServiceVerified` (a GET that WRITES — new finding) or
   any per-row Menu/Delete control.
3. Handbook annotation at scale; Pathfinder beads after stars.

## Operational facts a session may need

- Pi at 192.168.86.125; tracker binds Pi-localhost only (SSH tunnel to
  reach it from the PC). Scheduler: nightly events sync, weekly roster,
  attendance sweep (end+30 min until closed), weekly AHGFamily pull
  (armed only by STORED credentials + mapped girls + no latch), nightly
  backups (`data/backups/`, 14 kept).
- Rule 8 latch everywhere: one failed AHGFamily login stops all AHGFamily
  traffic until credentials are re-entered. Never retry logins.
- Girls↔AHGFamily mapping: fill-when-empty (checkin scan → mapping screen
  → manual); verify the first live pull's `ahg_state` against AHGFamily
  (grid/standard parsers met live markup only via captures so far).
- Site deploys on push to main (GitHub Pages); an hourly calendar-feed
  Action also commits to main — merge, don't force.

## Working notes

- Tests stay offline; fixtures use invented names/ids only.
- Requirement ids: 12 random alphanumerics, never classify by prefix.
- better-sqlite3 pinned 12.4.1 (prebuilds Node 22 win32-x64 + Pi arm64).
- Catalog updates: monthly, human-approved (`fetch:staging` → `diff` →
  `--apply`); never auto-apply.
- Beware heredoc/template-literal escape eating when writing JS with
  regexes via Bash — verify written regexes (`\d`, `\b`) survived.
