# Badge tracker service — draft spec for review

*Draft 1 · Sept 7, 2026 · for discussion before any code*

## 1. What it is

A small Node/Express + SQLite service that runs on the Raspberry Pi beside the check-in app, in its own container, with its own database. It holds the things AHGFamily can't: the full-text badge catalog, per-event plans, per-girl per-requirement completions with dates and sign-off, and the queue of completions waiting to be pushed to AHGFamily. It exposes a JSON API that the troop website's leaders area calls with the Microsoft token it already has. It talks to two other systems: the check-in app (read-only, via its Integration API) for events and attendance, and AHGFamily (read now, write later) for the official record.

It does not render pages — the website does — and it does not own attendance — the check-in app does. Nothing troop-specific is in the code; troop identity, hostnames, tenant ids and keys are all configuration.

## 2. Deployment shape

| | |
|---|---|
| Runtime | Node 20, Express, `better-sqlite3`, no ORM. Same stack as the check-in app so there is one thing to know how to operate. |
| Where | Pi, Docker container beside `troop-checkin`, its own volume for `data/` (database, `badges/`, backups). Same-host HTTP to the check-in API. |
| Public entry | Second hostname on the existing Cloudflare Tunnel (e.g. `badges.<domain>`), HTTPS terminated by Cloudflare. Keeps cookies and CORS separate from the check-in app. |
| Config | `.env` (gitignored): `PORT`, `PUBLIC_URL`, `SITE_ORIGIN` (the one origin allowed for CORS), `MSAL_TENANT_ID`, `MSAL_CLIENT_ID` (audience), `LEADER_GROUP_ID` or `LEADER_EMAILS`, `ADMIN_EMAILS`, `CHECKIN_BASE`, `CHECKIN_API_KEY`, `CHECKIN_WEBHOOK_SECRET`, `AHG_BASE`, `CRED_KEY` (auto-generated, encrypts the stored AHGFamily password), `TZ`. |
| Backups | Nightly SQLite backup to the volume, same pattern as the check-in app; the catalog JSON is reproducible from the `ahg-badge-tracker` build and doesn't need backing up separately. |

## 3. Authentication and authorization

**Leaders (website → API).** The leaders area signs in with MSAL against the church tenant and already holds an access token. It sends it as `Authorization: Bearer <token>` to the tracker. The tracker validates signature (tenant JWKS, cached), issuer, audience (`MSAL_CLIENT_ID` — the website's app registration needs an exposed API scope, e.g. `access_as_leader`, so the token is minted *for the tracker*, not for Graph), expiry, and then membership: either the `groups` claim contains `LEADER_GROUP_ID`, or the `preferred_username` is in `LEADER_EMAILS`. Two roles: **leader** (plan, confirm, view everything) and **admin** (settings, credentials, push controls, catalog import) — admin = leader who is also in `ADMIN_EMAILS`. No sessions, no cookies, no CSRF surface. CORS allows exactly `SITE_ORIGIN`.

**Check-in app → tracker (webhook).** HMAC per the Integration API contract (timestamp + raw body, 5-minute window). Deduplicate on `txn.id`.

**Tracker → check-in app.** `Authorization: Bearer tci_…` from config. Read-only by contract.

**Tracker → AHGFamily.** Email + password entered once by an admin in the UI, stored AES-GCM-encrypted with `CRED_KEY` exactly like the check-in app's TLC credentials (`credCrypto`). Login flow, cookie jar and endpoint allow-list come from `lib/ahgfamily.js` in this repo, extended with the two write endpoints only inside the push module, behind a feature flag that ships **off**.

## 4. Data model

SQLite, migrations as numbered files. Timestamps ISO-8601 UTC; dates that mean "the day it happened" are `YYYY-MM-DD` in the troop's local zone.

**Catalog (imported, read-only to the UI)**

- `catalog_versions` — `id, imported_at, source_generated_at, badge_count, requirement_count, notes`. Each import of `data/badges/` is a version; rows below carry `catalog_version_id` so history is never orphaned when a badge changes.
- `badges` — `id (slug), catalog_version_id, ahg_award_id, name, level_group, levels (json), classic, pages (json), image_paths (json), intro, ahg_history, faith_text, faith_reference, json (the full built badge, verbatim)`.
- `badge_groups` — `id, badge_id, position, label, rule_type (all|n_of|null), rule_n`.
- `requirements` — `id (badge_id + number + letter), badge_id, group_id, number, letter, ahg_requirement_id, title, text, sub_items (json), flags (json)`.

A retired award or a non-current edition never reaches `data/badges/`, so the tracker has no concept of either — that filtering happened upstream, by design.

**People and events (mirrored from the check-in app)**

- `girls` — `id, checkin_person_id, member_id, first_name, last_name, nickname, level (as the roster carries it), ahg_level (Explorer|Pioneer|…, normalized), ahg_youth_id (u… hashid, nullable until mapped), active, updated_at`. Names live here because leaders need to see them; this database is on the Pi, never in git, and the API only serves them to authenticated leaders.
- `events` — `id, checkin_event_id, ical_uid, start_at, end_at, title, location, all_day, removed_from_feed, updated_at`. Identity is `ical_uid + start_at`, falling back to `checkin_event_id` for manual events — the same rule the check-in app uses.
- `attendance` — `event_id, girl_id, signed_in_at, signed_out_at, open, source_txn_ids (json), fetched_at`. Snapshot of the check-in answer; refreshed on webhook and on poll.

**Planning**

- `plans` — `id, event_id, level_group, created_by, created_at, notes`. One plan per event per level group (TH, EX, PiPa) so a meeting where three units do different badgework is three rows.
- `plan_items` — `id, plan_id, requirement_id, role (session|start|continue|finish), position, notes`. This is the multi-session rule: a requirement may appear on any number of events; only `session` and `finish` rows mean "done tonight".

**Completion**

- `completions` — `id, girl_id, requirement_id, status (proposed|confirmed|rejected), completed_on (date), event_id (nullable — done at home), plan_item_id (nullable), source (attendance|manual|ahgfamily), proposed_at, decided_by, decided_at, notes`. Unique on `(girl_id, requirement_id)` among non-rejected rows.
- `participation` — `girl_id, plan_item_id, event_id`. Recorded when a girl attends a `start`/`continue` session; shown as "present for 1 of 2 sessions" when a leader decides the eventual completion.
- `badge_status` — a *view*, not a table: per girl per badge, computed from confirmed completions and the group rules (`all` ⇒ every requirement; `n_of` ⇒ at least *n*). Yields `not_started | in_progress | complete`, plus `ahgfamily_state` from the last sync.

**AHGFamily sync**

- `ahg_state` — `girl_id, requirement_id, completed (0/1), earned_on, comment, ad_record_id, fetched_at` (the `ad…` record id is per girl; it lives only in this database and is never exported). What AHGFamily currently says, per girl per requirement.
- `push_queue` — `id, girl_id, requirement_id, completion_id, action (mark|unmark|badge_complete), date, status (queued|sent|failed|skipped|held), attempts, last_error, created_at, sent_at`.
- `sync_runs` — `id, kind (pull|push|catalog), started_at, finished_at, ok, summary (json), error`.
- `settings` — key/value: AHGFamily credentials (encrypted box), push enabled flag, auth-failure latch, last catalog version, schedule choices.

**Audit**

- `audit_log` — `id, at, actor (email), action, entity, entity_id, before (json), after (json)`. Every confirm/reject/plan change/push.

## 5. Rules the service enforces

1. **Badge complete** is derived, never set by hand: all `all`-groups fully done and every `n_of` group at its threshold. A leader can't tick "badge complete" — they complete requirements.
2. **Proposed ≠ done.** Attendance only ever creates `proposed` rows. A leader confirms or rejects; nothing rolls up or pushes until confirmed.
3. **Multi-session.** For each present girl and each plan item: role `session` or `finish` → propose a completion dated the event's local date; role `start` or `continue` → record participation only. A `finish` proposal shows the girl's participation count for that requirement so the leader can judge.
4. **Home completions** are manual: a leader adds a confirmed completion with a date and no event.
5. **Voided sign-ins.** On `txn.voided`, withdraw any *proposed* completion that rests on that transaction; if already confirmed, flag it for review rather than reverting.
6. **AHGFamily is a second source of truth.** A pull that finds an item complete on AHGFamily but not here creates a `confirmed` completion with `source: ahgfamily` and AHGFamily's date. An item confirmed here and not there is queued to push. Complete here but later *un-checked* there is surfaced as a conflict for a leader, never resolved silently.
7. **Push is per requirement and read-before-write.** `process-advancement` toggles; the service reloads the girl's grid state immediately before each write and skips items already complete. `dateSpecified` is the completion's date, not today. Whole-badge `completed_on` is set only via the Standard-view form post, only when rule 1 says the badge is complete, and only after every requirement push succeeded. The delete endpoint is never called.
8. **Auth-failure latch.** One failed AHGFamily login disables all AHGFamily traffic until an admin re-enters credentials — the check-in app's rule, verbatim, because a locked account is worse than a stale push.
9. **Catalog changes are versioned.** Importing a new `data/badges/` build never deletes requirement rows; it creates a new catalog version, links unchanged requirements by `ahg_requirement_id`, and reports orphans (completions whose requirement vanished) for a human.

## 6. API surface (v1, all JSON, all under `/api/v1`, all require a leader token unless noted)

| Method & path | Purpose |
|---|---|
| `GET /health` | No auth. `{ ok, version, catalogVersion, checkin: ok/err, ahgfamily: ok/latched/off }` |
| `GET /me` | Who the token is; role. |
| `GET /badges?levelGroup=` · `GET /badges/:id` | Catalog browse; full badge with groups/requirements/text/pages/images. |
| `GET /girls` · `PATCH /girls/:id` (admin) | Roster mirror; set `ahg_level`, `ahg_youth_id`, active. |
| `GET /events?from=&to=` · `GET /events/:id` | Mirror of check-in events, each with its plans and attendance summary. |
| `GET /events/:id/plans` · `PUT /events/:id/plans/:levelGroup` | The planner: replace the plan's items `[{ requirementId, role, notes }]`. |
| `GET /events/:id/proposals` · `POST /events/:id/proposals/decide` | After the meeting: proposed completions grouped by girl; body `[{ completionId, decision: confirm|reject, completedOn? }]`. |
| `GET /girls/:id/progress` · `GET /badges/:id/progress` | Per girl (every badge with status and per-requirement state) · per badge (every girl). |
| `POST /completions` (manual) · `DELETE /completions/:id` | Home/manual completion; delete only if never pushed (else it becomes a queued `unmark` for an admin to approve). |
| `GET /conflicts` · `POST /conflicts/:id/resolve` | AHGFamily-vs-tracker disagreements. |
| `GET /sync/status` · `POST /sync/pull` (admin) · `POST /sync/push` (admin) · `GET /sync/queue` | Runs, queue, latch state. |
| `POST /admin/ahgfamily/credentials` (admin) · `POST /admin/catalog/import` (admin) · `GET /admin/audit` | Settings. |
| `POST /webhooks/checkin` | HMAC, no bearer. |

Errors: `{ error: "…" }` with 400/401/403/404/409. Pagination only where lists can exceed a few hundred rows (audit, queue).

## 7. Background jobs (in-process scheduler, like the check-in app's)

| Job | When | Does |
|---|---|---|
| Check-in events | nightly + on `ical.synced` | `GET /events?from=today-7&to=today+90`, upsert. |
| Check-in roster | weekly + on demand | `GET /people`, upsert girls; flag unmatched/visitors. |
| Attendance & proposals | 30 min after each event's `end_at`, and on `txn.*` webhooks | Pull attendance, apply rule 3. |
| AHGFamily pull | weekly, and always immediately before a push | Grid state per active badge per girl (only badges with any activity here — not all 548). |
| AHGFamily push | manual "Push now" at first; optional weekly once trusted | Drain the queue, read-before-write, latch on auth failure. |
| Backup | nightly | SQLite backup to the volume. |

Catalog *checking* (fetch → diff → approve) stays a monthly manual step in the `ahg-badge-tracker` repo, per your rule; the tracker only imports an approved build.

## 8. Website pages this implies (leaders area, later)

Badge catalog browser (with SharePoint page images inline) · Planning calendar (event → per-level plan with roles) · After-meeting confirmation (the proposals screen) · Girl progress · Badge progress ("who is missing what") · Sync/admin. All static pages calling the API with the MSAL token; no data in the site repo.

## 9. Decisions I need from you

1. **Girl ↔ AHGFamily mapping.** AHGFamily's `#youth-select` carries names with the `u…` ids, and the check-in roster carries `member_id`. Is the AHGFamily member number in the roster export the check-in app imports (so we can match automatically), or do we map by name once in an admin screen and store the result? The catalog fetch deliberately never wrote names or ids; the tracker DB on the Pi is the right place for that mapping.
2. **Level resolution.** "Pioneer/Patriot" badges are one award id in AHGFamily, but the girl's own level decides the `le…` used in a push. Confirm `ahg_level` comes from the roster (and what values the AHG roster export actually uses), or whether a leader sets it per girl.
3. **Who is admin?** You plus the Troop Coordinator? Admin controls credentials and pushing.
4. **Token audience.** Validating a token issued for Microsoft Graph is the wrong thing to do; the website's app registration needs an exposed API scope for the tracker so MSAL can request a token *for it*. That's a change in the Entra app you already registered — fine to do, just noting it's not free.
5. **Push timing.** Manual "Push now" only for the first season, or a weekly automatic push from the start?
6. **Hostname.** `badges.<domain>` on the tunnel, or a path under the check-in hostname? Spec assumes a second hostname.
7. **Attendance = present?** The check-in API leaves it to us: for a meeting, count a girl present if she signed in (even if the sign-out is still open after `end_at`); for campouts, require a sign-out. Agree?

## 10. Build order once approved

1. Skeleton + migrations + `/health` + MSAL validation (testable with a real token from the leaders area).
2. Catalog import from `data/badges/` + `GET /badges`.
3. Check-in client (events, people, attendance) + webhook receiver + girls/events mirror.
4. Plans and plan items API.
5. Proposals from attendance (rule 3) + decide endpoint + progress views.
6. AHGFamily pull (read-only) + conflicts.
7. AHGFamily push behind the flag, manual only, with the latch — last, and only after 1–6 have run through a real meeting.

Each step ships with tests against fixtures (check-in API responses recorded from a local instance; AHGFamily fragments from `data/ahgfamily/raw`).
