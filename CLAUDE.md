# Instructions for AI assistants working in this repo

## THIS REPO IS PUBLIC — NEVER COMMIT PII. NO EXCEPTIONS.

Git history is permanent and this project serves a youth organization, so a
leaked name is a child's name. Before EVERY commit, scan the full diff
(`git diff --cached`) for the items below; if any appear, fix them BEFORE
committing — never plan to "clean it up later," and treat anything that
slipped into an earlier commit as an incident that requires a history
rewrite, not just a follow-up commit.

Never commit, in any file (code, tests, docs, fixtures, comments, commit
messages, screenshots):

- Real names of troop members, youth, parents/guardians, or leaders —
  test fixtures use invented names, never names from the real roster
- Phone numbers, email addresses, home addresses, birthdates (test phones
  are 555-xxxx; test emails end in @example.com)
- AHGFamily / Trail Life Connect identifiers that belong to a person or a
  person's record: member/youth hashids (`u` + 11 chars), advancement
  record ids (`ad` + 10 chars), role hashids, member numbers, troop numbers.
  Docs and fixtures use `<youthHashid>` / `<adHashid>` placeholders.
  Award ids (`aw…`), level ids (`le…`), program ids (`pr…`) and requirement
  ids (12 chars, no prefix) describe the AHG program, not a person, and may
  be committed — they are the point of the catalog.
- Real roster counts, real event titles, or anything else that profiles
  the troop; keep examples generic
- Credentials of any kind: passwords, tokens, cookies, API keys, .env
  values — mock creds must be self-evidently fake
  ("fake-password-never-real")
- Anything under data/ (fetched catalog output, raw HTML fragments) — the
  .gitignore fences it; never weaken it. Raw fragments from
  `badge-tracker-view` contain a youth id and record ids by construction.

Troop-identifying references (troop number, deployment domain, church
name) stay out of new code and docs — this codebase is troop-agnostic;
branding belongs in env/config on the deployment, not in the source.

## AHGFamily is read-only from this repo — for now

The fetch scripts may call only:

- `GET /login`, `POST /login` (session), `GET /logout`
- `GET /advancement/index?…` (page shell: `#badge-select`, `#youth-select`)
- `POST /advancement/badge-tracker-view` (HTML fragment; read-only)

They must NEVER call `POST /advancement/process-advancement` (toggles an
item), `POST /advancement/index` (Standard-view save), or
`GET /advancement/delete` (deletes a record). Those are data-changing;
the push design that will eventually use them lives in a later phase
behind explicit review, never in a catalog/fetch script.

Auth failures are terminal: exit immediately, never retry in a loop
(AHGFamily may lock the account). Throttle every request (~300 ms).

## Catalog rules

- Awards named "(Retired)" on AHGFamily can no longer be earned. The fetch
  flags them `retired: true`; the planner and tracker must never offer them
  for planning, completion, or push. Filter on the flag, not the name.

## Housekeeping

- `npm test` must pass before any push (Node's built-in runner; tests run
  against synthetic fixtures only — never a live site)
- No runtime dependencies without a reason; Node 20 has `fetch`
- Output JSON in data/ahgfamily/ is generated — scripts must be re-runnable
  and resume-safe, and the generated files must contain no youth ids,
  names, or `ad…` record ids (the fetch replaces them with placeholders)
