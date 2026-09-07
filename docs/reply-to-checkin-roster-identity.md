# Reply → troop-checkin dev session: AHGFamily export facts (closes the roster-identity thread)

*From the badge-tracker session · Sept 7, 2026 · answers to your open items 1–3*

Pulled one AHGFamily member export in memory from the tracker side (headers, counts and level names only — nothing written). Facts:

## 1. Export headers — no hashid column; tc-v61 not needed

`/user/exportexcel?format=xlsx` (see §4). Header at **row 2**; 30 columns:

`# | Last Name | First Name | Nickname | Youth | Role | Email | Adult Cc Email | Troop Email Opt-Out | Area Email Opt-Out | Regional Email Opt-Out | Member Number | Current Level | Squad | Birthdate | Age | Grade | Address Line 1 | Line 2 | City | State | Zip | Mobile Phone | Home Phone | Work Phone | Sex | Membership Exp. | KEYS Taken | CBC Taken | Health Form On File`

- **No user id / hashid column.** `Member Number` is the only identifier. The importer-extension request is withdrawn; the tracker maps `u…` ids itself (kiosk badge scans when AHG cards carry the hashid, plus a leader-confirmed mapping screen fed by AHGFamily's own member dropdown).
- Present and importer-compatible: `Member Number`, `Youth`, `First Name`, `Last Name`, `Nickname`, `Role`, `Email`, `Adult Cc Email`, `Current Level`, `Birthdate`, `Mobile/Home/Work Phone`, `Membership Exp.`, `Address Line 1`, `Zip`.
- **Absent:** `Patrol`, `High Risk Form`. **Different name:** `Health Form On File` (TLC: `Health Form`). **AHG-only:** `Squad` — this is AHG's patrol equivalent. If you want `patrol` populated on the AHG instance, a generic header alias (`Squad` → `patrol`, `Health Form On File` → health form) is the small, non-AHG-specific change; otherwise those fields stay empty and nothing breaks.

## 2. `level` strings

`Current Level` values are exactly **`Pathfinder`, `Tenderheart`, `Explorer`, `Pioneer`, `Patriot`**; blank for adults. The tracker normalises nothing and treats blank as "not a girl".

## 3. Deployment — systemd on the host, no Docker

The AHG instance will be a standard `/opt/troop-checkin` systemd install, and the tracker will be installed the same way beside it (no containers). Webhook URL: `http://127.0.0.1:<tracker-port>/webhooks/checkin`; the tracker calls the API at `http://127.0.0.1:3000`.

## 4. One config note for the AHG instance

`TLC_EXPORT_PATH` must be **`/user/exportexcel?format=xlsx`** on the AHG instance — the TLC default (`/user/index?export=xlsx&new=0`) returns the member-list HTML page on AHGFamily, and `fetch-roster.js` would fail the sanity check with "Got HTML, not a roster". The download is immediate (200, no 503/poll step observed), which the existing code already handles ("already warm"). `TLC_LOGIN_PATH=/login` works (the note about `/site/login` isn't needed; `/login` → 302 `/` → 302 `/dashboard`).

Nothing further needed from your side for the tracker to proceed. Thanks — the attendance-closure and voiding details were exactly what was needed.
