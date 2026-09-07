# Cloudflare Tunnel + Access — AHG hostnames

Goal: `https://checkin.ahg2911.org` (AHG check-in kiosk, port 3001) and
`https://badges.ahg2911.org` (badge tracker, port 3100) reach the Pi from
anywhere, no port forwarding. Same pattern as the Trail Life deployment
(troop-checkin `docs/09-tunnel-setup.md`), with two deliberate differences
called out below.

The website itself (`ahg2911.org`, GitHub Pages) is untouched — these are
new subdomains alongside it.

## Two things that differ from the Trail Life setup

**1. You do NOT need a second tunnel.** One `cloudflared` service serves any
number of public hostnames, across any number of zones **in the same
Cloudflare account**. If `ahg2911.org` lives in the same account as the
Trail Life domain, add both AHG hostnames to the tunnel already running on
the Pi — nothing to install, no Pi changes at all. Only if `ahg2911.org` is
in a *different* Cloudflare account do you need a second tunnel (Part D).

**2. Cloudflare Access goes on the check-in admin paths ONLY — never on
`badges.ahg2911.org`.** The badge pages call the tracker API from the
browser with a Microsoft (Entra) bearer token. Access would intercept those
calls with its own login redirect, which fails CORS and breaks every page.
The tracker already authenticates every request itself (Entra token →
leader/admin list), so Access would add nothing but breakage.

## Part A — Add the hostnames to the existing tunnel

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels** → open the
   tunnel already running on the Pi (the one serving the Trail Life
   check-in hostname) → **Public Hostnames → Add a public hostname**.
2. Add the check-in hostname:
   - Subdomain `checkin` · Domain `ahg2911.org` · Path blank
   - Service: **HTTP** → `localhost:3001`  ← the **AHG** instance (3000 is
     Trail Life; getting this wrong points AHG families at the other troop)
3. **Add a public hostname** again, for the tracker:
   - Subdomain `badges` · Domain `ahg2911.org` · Path blank
   - Service: **HTTP** → `localhost:3100`
4. Save. Cloudflare creates both DNS records automatically. The tunnel
   should still show **HEALTHY**.
5. Test from any device on any network:
   - `https://badges.ahg2911.org/health` → JSON with `"ok":true`
   - `https://checkin.ahg2911.org/` → the AHG kiosk (confirm it says AHG,
     not Trail Life)

If `ahg2911.org` doesn't appear in the domain dropdown, the zone is in a
different Cloudflare account — see Part D.

## Part B — Access on the AHG check-in admin area only

Same shape as Trail Life: a login wall on admin paths, with the kiosk left
open (it needs no challenge) and `/api/sms/inbound` public for Twilio.

1. Zero Trust → **Access → Applications → Add an application** →
   **Self-hosted**.
2. Name: `AHG Check-In Admin`. Session duration: 24 hours.
3. Add **two** public hostname entries:
   - `checkin.ahg2911.org` path `/admin.html`
   - `checkin.ahg2911.org` path `/api/admin/*`
4. Policy: name `AHG Leaders`, action **Allow**, include → **Emails** → the
   AHG admins' addresses (these are Cloudflare's own one-time-PIN logins —
   any e-mail works, unrelated to the Microsoft tenant accounts the badge
   pages use). Keep this list separate from the Trail Life application's.
5. Save. **Do not** add an application covering `/` or the whole hostname.
6. Test in a private window: `https://checkin.ahg2911.org/admin.html` asks
   for an e-mail code, then the app's own admin login appears (two layers,
   by design). `https://checkin.ahg2911.org/` must load with **no**
   Cloudflare challenge.

**No Access application on `badges.ahg2911.org`** — see the note above.

## Part C — Pi config after the hostnames are live

1. AHG check-in instance `.env`: `PUBLIC_URL=https://checkin.ahg2911.org`,
   then restart that instance. (Sets Twilio signature validation and secure
   cookies, exactly as on the Trail Life instance. If the AHG instance uses
   SMS, also point its Twilio number's inbound webhook at
   `https://checkin.ahg2911.org/api/sms/inbound`.)
2. Tracker `.env` — confirm `SITE_ORIGIN=https://ahg2911.org` (the origin
   leaders' browsers use; add/adjust if the site is served as `www.`), plus
   the Entra values, then `sudo systemctl restart ahg-badge-tracker`.
   `curl -s http://127.0.0.1:3100/health` should report `"auth":"msal"`.
3. Leader phones: switch the AHG kiosk to `https://checkin.ahg2911.org`
   and re-add to home screen (new origin — check the offline queue is empty
   on the old address first).

## Part D — Only if `ahg2911.org` is in a different Cloudflare account

Two options, easiest first:

- **Move the zone** into the same account as the Trail Life domain
  (Cloudflare → the zone → Overview → *Move to another account*), then do
  Part A. One tunnel, one thing to operate.
- **Or run a second tunnel** on the same Pi: create a new tunnel named
  `ahg-troop` in the AHG account's Zero Trust, then on the Pi install it as
  a *second, differently-named service* — `cloudflared` installs as a
  single `cloudflared.service` by default, so the second one needs its own
  unit (e.g. `cloudflared-ahg.service` with its own credentials file).
  Hand that step to the Pi session; it is the only reason to have two
  tunnels.

## Part E — Optional hardening

The tracker's webhook endpoint (`/webhooks/checkin`) is only ever called by
the check-in app over localhost, so it never needs to be reachable from the
internet. It is HMAC-protected either way, but you can block it at the edge:
Cloudflare → `ahg2911.org` → **Security → WAF → Custom rules** → *Block*
where `Hostname equals badges.ahg2911.org and URI Path starts with
/webhooks/`.

## Verification checklist

- `https://badges.ahg2911.org/health` from cellular → `"ok":true`,
  `"checkin":"ok"`, `"auth":"msal"`
- `https://checkin.ahg2911.org/` → AHG kiosk, no Cloudflare challenge
- `https://checkin.ahg2911.org/admin.html` → Cloudflare e-mail code first
- ahg2911.org → Leaders → Badges → sign in with Microsoft → the catalog
  loads (this proves Entra + CORS + tunnel all line up)
- The Trail Life hostname still works exactly as before

## Troubleshooting

- **Error 1033** on either hostname: tunnel down — `sudo systemctl status
  cloudflared` on the Pi.
- **502**: tunnel up, app down — check the relevant service
  (`troop-checkin` instance or `ahg-badge-tracker`).
- **Badge pages sign in but say the tracker isn't reachable**: hostname not
  live yet, or an Access application is covering `badges.ahg2911.org`
  (remove it).
- **Badge pages fail with a CORS error in the browser console**:
  `SITE_ORIGIN` on the Pi doesn't exactly match the origin in the address
  bar (`https://ahg2911.org` vs `https://www.ahg2911.org`).
- **Signed in but "not a leader" (403)**: the account isn't on the leader
  list — add it in the tracker's Admin page, or bootstrap it in the Pi's
  `.env` (`ADMIN_EMAILS`) and restart.
- **AHG kiosk shows Trail Life**: the public hostname points at
  `localhost:3000` instead of `3001`.
