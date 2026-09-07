# Handoff → troop-checkin dev session: roster identity and attendance for the badge tracker

*From the badge-tracker session · Sept 7, 2026 · for the check-in app's AHG instance*

Paste this into the check-in app session. It asks questions and requests one small addition; it does not ask for anything AHG- or tracker-specific in the check-in codebase (per the Integration API non-goals).

## Context

The badge tracker (separate service, same Pi) consumes the Integration API from v0.4.35 (`docs/13-integration-api.md`). To link a girl in the check-in roster to her record on AHGFamily.org, the tracker needs a stable identifier that both systems share. On AHGFamily every member has a hashid of the form `u` + 11 alphanumerics (e.g. `u70539b3301c`); the advancement pages key everything by it. The check-in app imports the AHGFamily roster export (same platform as TLC, same `/user/index?export=xlsx` mechanics), so the answer is probably already in the import.

## Questions

1. **What does the AHGFamily roster export contain that identifies a member?** For the AHG instance's most recent import, list the header row (column names only — no data). Specifically: is there a column carrying the `u…` hashid (TLC calls it the user id / "User Hashid" in some exports), a "Member Number", or both? Which of these does the importer store in `people.member_id` and `people.tlc_user_id`?
2. **On the AHG instance, what do `/api/integration/people` rows carry in `member_id` and `tlc_user_id`?** Format only (e.g. "`member_id` = 7-digit number, `tlc_user_id` = `u` + 11 chars"), not values. If `tlc_user_id` is the AHGFamily `u…` hashid, the tracker can map automatically and needs nothing else. If it's null or a different id, say what would be required to populate it from the export.
3. **What values does `level` carry for AHG youth?** The tracker must know each girl's current program level — Pathfinder, Tenderheart, Explorer, Pioneer, Patriot — because Pioneer/Patriot badges are one award on AHGFamily and the push must use the girl's current level. Is `level` the exact export string (which strings appear?), and is it kept current on each import (a girl who moves from Explorer to Pioneer updates on the next sync)?
4. **Attendance semantics for AHG.** The AHG instance syncs attendance to AHGFamily on sign-*out*, and missed sign-outs are closed through the SMS pickup-confirmation feature. Confirm: (a) in `/api/integration/events/:id/attendance`, a girl closed via SMS confirmation appears with `open:0` and a `signed_out_at` (the confirmation time?), and (b) an admin "close open sign-in" does the same. The tracker will treat **only `open:0` rows as attended** and will re-poll after `txn.created` (direction `out`) webhooks, so it needs those closures to be ordinary sign-out transactions.
5. **Webhook from the Pi to a sibling container.** The tracker will listen on `http://<tracker-container>:<port>/webhooks/checkin`. Confirm plain `http://` to a Docker-network hostname is accepted by the webhook URL validator (the handoff says same-host http is allowed; is a container hostname "same host" for that check?).

## Small request (only if #2 says `tlc_user_id` is empty for AHG)

If the AHGFamily export has the `u…` hashid under a different header than the TLC export, extend the importer's header matching to recognise it (generic: "a column named like *user id / user hashid* populates `tlc_user_id`"). No AHG-specific code path — the same rule serves TLC.

## What the tracker will do with the answers

- Map `girls.ahg_youth_id` ← `tlc_user_id` when it's a `u…` hashid; otherwise fall back to a one-time admin mapping screen (name-matched, leader-confirmed, stored on the Pi only).
- Map `girls.ahg_level` ← `level`, normalised to the five program levels; refreshed on every roster sync.
- Count a girl as present only when `open:0`; propose completions 30 minutes after `end_at` and again on each sign-out webhook until the event is fully closed.

Nothing in these answers should include names, member numbers, hashids, phone numbers, or any other roster data — formats and column headers only.
