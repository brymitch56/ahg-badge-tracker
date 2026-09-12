# Pi setup — badge tracker beside the check-in app

Systemd on the host, no Docker (decided). Same install pattern as
troop-checkin so there is one thing to know how to operate. Everything
troop-specific lives in `.env`, never in the source.

## 1. Install

```bash
sudo git clone <repo-url> /opt/ahg-badge-tracker
sudo chown -R "$USER" /opt/ahg-badge-tracker
cd /opt/ahg-badge-tracker
sudo bash deploy/install-pi.sh
```

The installer: Node 20 LTS if missing (it never touches an existing
check-in Node install), `npm ci --omit=dev` (better-sqlite3 is pinned to a
version with arm64 prebuilds), `.env` from `.env.example` (chmod 600),
migrations, catalog import when `data/badges/` is present, and the
`ahg-badge-tracker` systemd service (enabled, started).

## 2. Copy the built badge catalog

`data/badges/` holds the built pilot badges with handbook text —
copyrighted, so it is **never in git** and must be copied from the
annotation PC:

```bash
scp -r data/badges <pi>:/opt/ahg-badge-tracker/data/
ssh <pi> 'cd /opt/ahg-badge-tracker && npm run import:catalog'
```

Re-running the import is safe (versioned; unchanged requirements keep
their history).

## 3. `.env` on the Pi

| Key | Value |
|---|---|
| `PORT` | `3100` (the service listens on 127.0.0.1 only) |
| `TZ` | the troop's zone, e.g. `America/New_York` |
| `CHECKIN_BASE` | the **AHG** check-in instance — `http://127.0.0.1:3000`, or its actual port on a Pi running more than one instance (e.g. `:3001`); wire the key/webhook in **that** instance's admin, or the tracker mirrors the wrong troop |
| `CHECKIN_API_KEY` | from the check-in app, step 4 |
| `CHECKIN_WEBHOOK_SECRET` | from the check-in app, step 4 |
| `SITE_ORIGIN` | the website origin (CORS) — set with Entra, step 6 |
| `SMTP_URL`, `REPORT_FROM`, `REPORT_EMAILS` | the push run report mail (after every AHGFamily push — weekly or "Push now"). `SMTP_URL` is a nodemailer URL (e.g. `smtps://user%40example.org:app-password@smtp.office365.com:465`); all three must be set or the report is only kept on the admin page. Optional. |
| `MSAL_TENANT_ID` / `MSAL_CLIENT_ID` | from `docs/entra-setup.md`, step 6 |
| `LEADER_GROUP_ID` or `LEADER_EMAILS`, `ADMIN_EMAILS` | step 6 — the BOOTSTRAP list only; day-to-day leader/admin management happens on the website Admin page (stored in tracker.db, merged with these; `.env` entries can never be removed from the UI, so they are the lockout-recovery hatch) |

`CRED_KEY` appears in `.env` by itself the first time an admin stores the
AHGFamily credentials — never set or copy it by hand. `AHG_EMAIL` /
`AHG_PASSWORD` belong on the annotation PC for the fetch scripts; they are
**not** needed on the Pi (stored credentials replace them, step 5).

Restart after editing: `sudo systemctl restart ahg-badge-tracker`.

## 4. Wire up the check-in app (its AHG instance)

In the check-in app's **Admin → Integrations**:

1. **Generate key** → put the `tci_…` value in `CHECKIN_API_KEY`.
2. **Enable the Integration API.**
3. Webhook: URL `http://127.0.0.1:3100/webhooks/checkin`, a fresh signing
   secret (same value in `CHECKIN_WEBHOOK_SECRET`), all event types,
   **Send test event**, **Send webhook deliveries**.

Then restart the tracker and check:

```bash
curl -s http://127.0.0.1:3100/health
# "checkin":"ok" after the first sync (the scheduler runs one at startup)
```

## 5. Testing before Entra is ready

`AUTH_DISABLED=true` makes every request a fake admin. That is acceptable
**only** while the tracker is reachable from the Pi alone (it binds
127.0.0.1 and no tunnel hostname points at it yet). Remove it the moment
`badges.<domain>` goes live — `NODE_ENV=production` (set by the service
unit) refuses the flag anyway, so testing with it means running by hand:

```bash
sudo systemctl stop ahg-badge-tracker
cd /opt/ahg-badge-tracker && AUTH_DISABLED=true DISABLE_SCHEDULER=true node server/index.js
```

Smoke tests from another shell on the Pi:

```bash
curl -s localhost:3100/health
curl -s localhost:3100/api/v1/badges
curl -s -X POST localhost:3100/api/v1/sync/checkin          # events+roster+attendance mirror
curl -s localhost:3100/api/v1/girls
# store AHGFamily credentials (encrypted at rest; generates CRED_KEY into .env)
curl -s -X POST localhost:3100/api/v1/admin/ahgfamily/credentials \
  -H 'Content-Type: application/json' -d '{"email":"…","password":"…"}'
curl -s -X POST localhost:3100/api/v1/admin/mapping/refresh # reads #youth-select (one real login)
curl -s localhost:3100/api/v1/admin/mapping                 # suggestions to confirm
curl -s -X POST localhost:3100/api/v1/admin/mapping/confirm \
  -H 'Content-Type: application/json' -d '[{"girlId":1,"ahgYouthId":"u…"}]'
curl -s -X POST localhost:3100/api/v1/sync/pull             # AHGFamily grid pull → ahg_state
curl -s localhost:3100/api/v1/sync/status
```

When done, `sudo systemctl start ahg-badge-tracker` (the service runs with
real auth; API calls then fail 401/500 until Entra config lands — /health
still answers).

## 6. When the Entra registration lands

Follow `docs/entra-setup.md`, fill the MSAL keys and `SITE_ORIGIN` in
`.env`, restart, and add the `badges.<domain>` hostname to the existing
Cloudflare Tunnel pointing at `http://127.0.0.1:3100`.

## Operations

- Logs: `journalctl -u ahg-badge-tracker -f`
- Backups: nightly SQLite copy in `data/backups/` (14 kept)
- Background jobs: nightly event sync, weekly roster sync, attendance
  sweep 30 min after each event until every sign-in is closed, weekly
  read-only AHGFamily pull (only once credentials are stored via the admin
  endpoint AND girls are mapped; a failed login latches all AHGFamily
  traffic until credentials are re-entered)
- Update: `cd /opt/ahg-badge-tracker && git pull && npm ci --omit=dev &&
  sudo systemctl restart ahg-badge-tracker` (migrations run on start)
- Push to AHGFamily does not exist yet (build step 7 — behind a flag,
  after steps 1–6 have run through a real meeting)
