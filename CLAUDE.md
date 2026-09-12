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
item) or `GET /advancement/delete` (deletes a record). Those are
data-changing and are never called anywhere.

`POST /advancement/index` (the Standard-view save) is the **one** write the
project makes, and it lives in exactly one audited place:
`server/lib/servicepush.js` (step 7, the Service Star push), reached only
through `lib/ahgfamily.js`'s `postAdvancementIndex` — which is deliberately
**not** in the read-only allow-list, so `request()` still refuses a write
everywhere else. It ships behind the `push_enabled` setting (default off),
is admin-only and manual, never retries an unconfirmed save, and latches on
auth failure like every other AHGFamily call. Do not widen this: no other
module may write, and a catalog/fetch script never writes.

Auth failures are terminal: exit immediately, never retry in a loop
(AHGFamily may lock the account). Throttle every request (~300 ms).

## Catalog rules

- Awards named "(Retired)" on AHGFamily can no longer be earned. The fetch
  flags them `retired: true`; the planner and tracker must never offer them
  for planning, completion, or push. Filter on the flag, not the name.
- Only current-handbook requirements are used — never the 2016 handbook.
  Groups with `edition` other than `current` (and `gridOnlyRequirementIds`)
  are `plannable: false` and must be excluded everywhere downstream.
- Requirement ids are 12 random alphanumerics with NO prefix; some start
  with "aw", "ad", "le" or "u" by chance. Never classify an id by prefix
  alone — compare against the known award id / roster ids.

## Handbook text is copyrighted — never commit it

Full requirement wording, intros, AHG History and Faith Connection text
transcribed from the handbooks live only under `data/handbook/` and
`data/badges/` (gitignored) and reach the website through the
authenticated tracker API, never through this repo or the public site
repo. `handbook/example.json` is the schema with invented text and is the
only annotation in git. AHGFamily's short titles are fine to commit.

## Catalog updates need a human

The live catalog (data/ahgfamily/, later the website repo's data/) changes
only through `scripts/diff-catalog.js --apply` with an interactive "yes",
or through a reviewed pull request carrying the diff report. Never write a
fetch straight over the live catalog in automation, and never add an
auto-apply path. Check cadence is monthly (weekly at most) — AHG changes
awards every few years, so nightly is wasteful.

## Housekeeping

- `npm test` must pass before any push (Node's built-in runner; tests run
  against synthetic fixtures only — never a live site)
- No runtime dependencies without a reason; Node 20 has `fetch`
- Output JSON in data/ahgfamily/ is generated — scripts must be re-runnable
  and resume-safe, and the generated files must contain no youth ids,
  names, or `ad…` record ids (the fetch replaces them with placeholders)
