# Handbook annotations → `data/badges/`

The AHGFamily catalog (`data/ahgfamily/`) is the skeleton: every award,
level group, requirement id and short title. A **handbook annotation** adds
what AHGFamily doesn't hold — the full requirement wording, sub-bullets,
the intro paragraph, AHG History, Faith Connection, printed page numbers
and page-image references. `scripts/build-badges.js` merges the two into
`data/badges/<slug>.json`, the only shape the website and tracker read.

## Where the files live — and why most of it is not in git

The handbook is AHG's copyrighted text. This repo and the troop website
are public, so:

- `data/handbook/<slug>.json` — the real annotations. Under `data/`,
  therefore **gitignored**. Keep them on the leaders' machines / the Pi
  (and in the leaders-only SharePoint library if you want a backup).
- `data/badges/<slug>.json` — the built output. Also gitignored. The
  tracker service serves it to the leaders area over the authenticated
  API; it is never committed to the website repo.
- `handbook/example.json` — the schema, demonstrated with **invented**
  text. This is the only annotation in git.

AHGFamily's short titles and requirement ids are program metadata, not
book text, and stay in the public catalog.

## Start from the catalog (recommended)

Don't hand-write the structure — generate it:

```sh
npm run scaffold:annotation -- --list Explorer     # what is left to do
npm run scaffold:annotation -- "Our Flag" --level Explorer
```

That writes `data/handbook/<slug>.<level>.json` with every group, rule,
requirement number and AHGFamily short title already in place (as
`_catalogTitle` hints) and the prose fields blank. Fill in the text, then
`npm run build:badges`. Because the numbering comes from the catalog, the
usual build refusals (wrong counts, wrong rules, drifted numbering) can't
happen — the only errors left are the ones you can fix by typing.

## Annotation file

One file per badge per level group, named `<badge-slug>.<level>.json`
(`nature-and-wildlife.pipa.json`). Fields:

| field | meaning |
|---|---|
| `awardId` | AHGFamily award id — the join key. The build verifies `name` and `levelGroup` against the catalog so a typo can't attach text to the wrong award. |
| `name`, `levelGroup` | must match the catalog exactly |
| `slug` | output file name; kebab-case badge name + level code |
| `levels` | the handbook levels this page covers, e.g. `["Pioneer", "Patriot"]` |
| `classic` | `true` when the page carries the CLASSIC seal |
| `frontier` | the handbook chapter: `Heritage`, `Family Living`, `Arts`, `Outdoor Skills`, `Personal Well-Being`, or `Science & Technology` (loose spellings normalize; the UI filters on it) |
| `handbook` | `{ edition, pages: [182, 183], images: [] }` — `images` are paths in the leaders-only SharePoint library, filled in later |
| `intro`, `ahgHistory` | paragraphs as printed (`ahgHistory` may be `null`) |
| `faithConnection` | `{ text, reference }` — text as printed (italics dropped), `reference` like `"Job 12:7-10, NIV"` |
| `groups[]` | one per printed box, in order: `{ label, rule, requirements[] }` — `rule` is `{ "type": "all" }` or `{ "type": "n_of", "n": 3 }` and **must agree with the catalog** where the catalog has one |
| `requirements[]` | `{ number, text, subItems?: [], flags?: [] }` — `number` matches AHGFamily's numbering; `text` is the full wording; `subItems` are the printed bullets; `flags` currently only `requiredForJoiningAward` |

Numbering is continuous across a badge's groups, exactly as printed.

## Build

```sh
node scripts/build-badges.js            # every data/handbook/*.json → data/badges/
node scripts/build-badges.js --check    # validate only, write nothing
```

The build refuses to write a badge when: the award is retired; a catalog
requirement has no annotation text or an annotation number has no catalog
requirement; the group count, per-group counts, or rules disagree; or the
name/level group doesn't match. Every refusal is printed with the exact
mismatch so the fix is obvious.

Output shape (`data/badges/<slug>.json`):

```json
{
  "id": "nature-and-wildlife-pipa", "awardId": "aw…", "name": "Nature & Wildlife",
  "levelGroup": "Pioneer/Patriot", "levels": ["Pioneer", "Patriot"], "classic": true,
  "handbook": { "edition": "current", "pages": [182, 183], "images": [] },
  "intro": "…", "ahgHistory": "…", "faithConnection": { "text": "…", "reference": "…" },
  "groups": [
    { "label": "Complete All", "rule": { "type": "all" },
      "requirements": [
        { "number": 1, "ahgFamilyId": "vkyengtym3ey", "title": "Tree identification hike",
          "text": "Take a tree identification hike. …", "subItems": [], "flags": [] }
      ] }
  ],
  "requirementCount": 11,
  "source": { "ahgfamilyFetchedAt": "…", "annotationFile": "nature-and-wildlife.pipa.json", "builtAt": "…" }
}
```

`title` is AHGFamily's short label; `text` is the handbook's. Retired
awards and non-current editions never reach `data/badges/`.

## Faith: the Faith Award and faith badges (`handbook/faith.json`)

The Faith Award is AHGFamily's **B.Y. Faith Award** — one award per level
(a different colored pin each), each a single "complete one of the
following studies" list. The handbooks don't print it, so it is built from
AHGFamily's short titles alone. `handbook/faith.json` (committable — AHG
program structure, no handbook prose) names:

- `faithAward` — the award id per level;
- `faithBadges` — handbook badges tagged as faith badges (every current
  level variant, matched loosely by name);
- `links` — which award study each faith badge satisfies ("Bible Basics
  Badge" → Bible Basics). Earning the badge at a level makes that level's
  award item *ready to record* on the website's Faith tab.

`npm run build:badges` builds every faith award and faith badge that has no
buildable annotation **from AHGFamily's titles** (`textSource: "ahgfamily"`,
`text` = the short title; studies AHGFamily titles "(Retired)" are kept but
flagged `retired` and never offered for planning). The build uses the same
id the scaffold's slug produces, so annotating a faith badge later
(`npm run scaffold:annotation -- "Bible Basics" --level Explorer`, fill,
build, re-import) replaces its text in place. `--no-faith` skips the faith
build. AHGFamily's patch programs on the award list (Girls in Prayer, I
Choose Truth, NBB Believe…) are whole-award-only there, so their steps
come from the Faith Award guide instead (below); a study the tracker has no
steps for is planned as one item on the Faith Award.

Known gap: AHGFamily gives no group rules for the Tenderheart and Explorer
**Women of Faith** badges, so their AHGFamily-titles build treats every
group as "complete all" until the handbook annotation supplies the rules.

### Faith Award studies, step by step (`data/faith-studies/`)

The studies themselves (Girls in Prayer, Believe, I Choose Truth, Back2Back,
7 C's of History, Biblical Worldview…) are broken into steps per level —
chapters, lessons, "choose N of these" — from AHG's *Faith Award Program
Guide*, so a unit plans them step by step like a badge. That guide is AHG's
copyrighted text, so the definitions live only in
`data/faith-studies/*.json` (gitignored). Shape:

```json
{ "studies": [ { "slug": "example-study", "name": "Example Study",
  "awardItem": "Example Study Patch Program",
  "about": "…", "source": "Faith Award Program Guide pp. …",
  "variants": [ { "levelGroup": "Explorer", "groups": [
    { "label": "Choose 2 of 3", "rule": { "type": "n_of", "n": 2 },
      "steps": [ { "title": "…", "text": "…" }, { "title": "Activity 1", "placeholder": true } ] } ] } ] } ] }
```

- `awardItem` is the study's title on AHGFamily's Faith Award list; a
  finished study makes that item *ready to record*. `null` = a study the
  guide approves but AHGFamily doesn't list yet — the Faith tab counts it as
  earned and a leader marks the award on AHGFamily by hand.
- `placeholder` steps are slots for choices the guide leaves to the leader
  (activities, projects, verses); leaders rename them on the Faith tab
  ("What counts" → Steps).

Load with `npm run import:faith-studies` (or the Faith tab's **Load study
steps**, admin). Loading is **insert-only**: a study/level already in the
tracker is never changed, so renamed steps, plans and completions survive.
Studies are tracker-owned badges (`faith = 'study'`): the catalog build
never deactivates them, and they are never pulled from or pushed to
AHGFamily.

