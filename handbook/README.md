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
