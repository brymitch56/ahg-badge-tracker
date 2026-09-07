# Entra ID setup for the badge tracker API

The leaders area of the troop website signs leaders in with MSAL against the
church tenant and calls Microsoft Graph. The badge tracker is a *second* API
that must accept those same leaders. The correct pattern is a separate app
registration for the tracker that **exposes an API scope**; the website then
requests a token *for the tracker* (audience = tracker) and sends it as a
Bearer header. A Graph access token must never be accepted by the tracker —
its audience is Graph, its signature is not meant for us to validate, and
Microsoft may change its format.

Nothing here is troop-specific; ids go in the tracker's `.env` and the
website's `config.js`, never in code.

## 1. Register the tracker API (tenant admin — Kyle or Bryan)

Entra admin center → App registrations → **New registration**

- Name: `AHG Badge Tracker API` (any name)
- Supported account types: *Accounts in this organizational directory only*
- Redirect URI: none (it's an API, not a client)

After creation note **Application (client) ID** → tracker `.env` `MSAL_CLIENT_ID`,
and the **Directory (tenant) ID** → `MSAL_TENANT_ID` (same tenant the website uses).

## 2. Expose a scope

App registration → **Expose an API**

- **Application ID URI**: accept the default `api://<client-id>`.
- **Add a scope**:
  - Scope name: `access_as_leader`
  - Who can consent: Admins and users
  - Admin consent display name: *Access the badge tracker as a leader*
  - User consent display name: same
  - State: Enabled

The full scope string is `api://<tracker-client-id>/access_as_leader`.

## 3. Let the website request that scope

App registration of the **website** (the existing leaders-area registration) →
**API permissions** → Add a permission → *My APIs* → `AHG Badge Tracker API` →
Delegated → tick `access_as_leader` → Add. Then **Grant admin consent** for the
tenant so leaders never see a consent prompt.

Optionally, on the tracker registration → **Expose an API** → *Authorized client
applications* → add the website's client id with the scope pre-authorized. This
skips consent even without the tenant-wide grant.

## 4. Groups claim (recommended) or e-mail allow-list

Two ways the tracker decides who is a leader:

**Group (recommended).** Create a security group (or use the existing M365
group for AHG leaders) → note its **Object ID** → tracker `.env`
`LEADER_GROUP_ID`. On the **tracker** registration → **Token configuration**
→ *Add groups claim* → *Security groups* → for **Access** tokens emit **Group
ID**. Membership changes take effect on the next token (≈1 hour) with no
tracker restart.

**Allow-list.** Put leader e-mails in `.env` `LEADER_EMAILS` (comma-separated,
`preferred_username` claim). Simpler, but every change is a config edit and a
restart.

Admins (settings, credentials, push controls) are the subset listed in
`ADMIN_EMAILS` — always an explicit list.

## 5. Website change (leaders.js)

Where MSAL requests Graph scopes today, request the tracker scope separately
(MSAL cannot mix resources in one token):

```js
const trackerToken = await msalInstance.acquireTokenSilent({
  scopes: ['api://<tracker-client-id>/access_as_leader'],
  account,
}); // falls back to acquireTokenRedirect on InteractionRequiredAuthError
fetch(`${config.tracker.baseUrl}/api/v1/me`, {
  headers: { Authorization: `Bearer ${trackerToken.accessToken}` },
});
```

`config.js` gains `tracker: { baseUrl: 'https://badges.<domain>', scope: 'api://<tracker-client-id>/access_as_leader' }`.

## 6. What the tracker validates on every request

1. Signature against the tenant's JWKS (`https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys`, cached, refreshed on unknown `kid`).
2. `iss` = `https://login.microsoftonline.com/<tenant>/v2.0` (v2 tokens; set `accessTokenAcceptedVersion: 2` in the tracker registration's manifest so v2 is issued).
3. `aud` = tracker client id (or `api://<client-id>`).
4. `exp` / `nbf` with 60 s skew.
5. `scp` contains `access_as_leader`.
6. Leader check: `groups` contains `LEADER_GROUP_ID`, or `preferred_username` ∈ `LEADER_EMAILS`.

Any failure → `401 {"error":"unauthorized"}`; a valid leader who isn't an admin hitting an admin route → `403`.

## 7. Test before any tracker code exists

From the leaders area's browser console after sign-in, run the
`acquireTokenSilent` call above and paste the token into https://jwt.ms —
check `aud`, `scp`, `groups` (if configured), and `ver: "2.0"`. If those are
right, the tracker's validation will be too.
