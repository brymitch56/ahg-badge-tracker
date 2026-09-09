# Handoff — where the build stands (Sept 8, 2026)

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
- **Tests**: `npm test` → 67 passing, all offline (invented fixtures,
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

1. **Service Stars — read side** (`docs/service-stars-plan.md` draft 2 is
   the contract; capture findings in `data/captures/service-notes.md`,
   local only). Starts with the `parseStandardState` isNew fix (blank
   instance panels currently count as records — would false-conflict every
   star holder). Then migration, weekly-pull extension, baseline, math,
   proposals UI with bulk confirm. No writes.
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
