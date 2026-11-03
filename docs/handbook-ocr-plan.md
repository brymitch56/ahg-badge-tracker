# Tenderheart & Explorer handbook → annotations, in segments

Goal: fill every remaining Tenderheart and Explorer annotation
(`data/handbook/<slug>.tend.json` / `.expl.json`) from the full scan of the
handbook, a few frontiers at a time, so the planner shows real requirement
wording for every TH/EX badge.

Copyright rule unchanged: the scan, the page images and every annotation
live under `data/` (gitignored) or outside the repo. Nothing in this plan
puts handbook text in git — this doc holds page numbers and badge names
only.

## Source

`TH & EX Handbook - Combined.pdf` (leaders' machine, scanned-badges
folder): 322 pages, about 1.7 GB, 600 dpi JPEG per page (4957 × 6458).

| PDF page (1-based) | content |
|---|---|
| 1 | front cover |
| 2 | inside front cover (logo / credits) |
| 3 | page 1 (welcome letter, unnumbered) |
| 4 | page 3 (table of contents, unnumbered) |
| n + 1 | printed page n, for n = 4 … 320 |
| 322 | back cover |

Printed page 2 isn't in the scan. That's front matter, which this plan
doesn't need.

## Method: read the images, not OCR text

Tesseract is not installed, and it mangles the two-column boxes, the
sidebars and the italics. A session reads the page images directly instead.
At 1600 px wide a page is ~600 KB and every requirement is clearly legible
(tested on p. 101). Faint bleed-through from the reverse side shows in white
areas. It doesn't affect the boxed text, but watch for it in the sidebars.

## Layout facts that shape the work

- Every badge is a **spread of two pages (even + odd) holding both
  levels**: the left sidebar has AHG History and Faith Connection, then the
  intro and the TENDERHEART boxes, then the EXPLORER boxes. Tenderheart
  boxes may continue onto the odd page (Ancestor Detector, pp. 60–61).
  So one segment writes both `.tend` and `.expl` from the same images, and
  `handbook.pages` lists the pages that level's boxes actually appear on.
- Some badges take four or six pages: Women of Faith 82–87, Sustainable
  Living 112–115, Together as A Family 116–119, Geocaching & Orienteering
  168–171, Graphic Design 134–137, Survival, Search, & Rescue 186–189, Biblical Leadership 196–199,
  Mission Minded 212–215, Internet Adventure 254–257.
- Box headers give the group rule: "Complete All" → `all`,
  "Complete One/Two/Three" → `n_of`. The scaffold already holds the
  catalog's rules. A mismatch means a misread, so stop and look again.
- The CLASSIC seal (top-left of the spread) → `classic: true`.

## Step 0 — prep (done Oct 24, 2026, on the leaders' PC)

1. Page images: `npm run extract:handbook-pages -- "<scan.pdf>"` wrote
   `data/handbook-pages/thex/`: 322 JPEGs at 1600 px wide (178 MB) named by
   printed page: `p004.jpg` … `p320.jpg`, `p001`, `p003`, `cover`,
   `inside-cover`, `back-cover`. The script pulls each page's JPEG stream
   as is and scales it with ffmpeg (on PATH, or `FFMPEG=`). Re-running skips
   pages already there.
2. Scaffolds: every Tenderheart and Explorer badge on `--list` now has a
   `data/handbook/<slug>.tend|expl.json` skeleton (181 files). The build
   refuses each one with "empty text" until it's filled, which is expected.
   The B.Y. Faith Award and NCC Catholic Faith Award entries aren't printed
   in the handbook, so they're left unscaffolded. The build keeps making
   them from AHGFamily titles, and `--list` still shows them; skip them.

## Segments

One session per row. Page ranges come from the printed Badge Index
(p. 320). "Done already" are the eight pilot pairs, which a segment skips
except for the page fix below.

| # | frontier | pages | badges to fill | done already |
|---|---|---|---|---|
| 1 | Heritage | 60–89 | Ancestor Detector, Caring for Creation, Citizenship & Government, Dawn of Our Country, Freedom Seekers, Living in the USA, Our Constitution, Our Flag, U.S. Military Heroes, Women of Faith, World Heritage | Native American, Our Heritage |
| 2 | Family Living I | 90–107 | Auto Care & Safety, Cake Decorating, Cooking, Family Helper, Home Care & Repair, Kid Care, Money Management, Pet Care | Home Decorating |
| 3 | Family Living II | 108–121 | Scrapbooking, Sewing, Sustainable Living, Together as A Family, Toys & Games | |
| 4 | Arts I | 122–137 | Art History, Cinematography, Crafts, Creative Writing, Dance, Fine Arts, Graphic Design | |
| 5 | Arts II | 138–153 | Music Appreciation, Music Performance, Needle Arts, Pen & Paper Arts, Photography, Puppetry, Textile Arts, Theater | |
| 6 | Outdoor Skills I | 154–171 | Archery, Boating, Camping, Canoeing, Cycling, Fire Safety & Fire Building, Fishing, Geocaching & Orienteering | |
| 7 | Outdoor Skills II | 172–191 | Hiking, Horsemanship, Nature & Wildlife, Outdoor Cooking, Outdoor Skills, Rock Climbing, Shooting Sports, Survival, Search, & Rescue, Swimming | |
| 8 | Personal Well-Being I | 192–215 | All God's Children, Bible Basics, Biblical Leadership, Book Adventurer, Daughter of the King, Emergency Preparedness, Entrepreneurship, Identity, Mission Minded | Fashion |
| 9 | Personal Well-Being II | 216–229 | Personal Care, Physical Fitness, Public Speaking, Sign Language, Social Skills & Etiquette, Travel, World Languages | |
| 10 | Science & Technology I | 230–251 | Architecture, Astronomy, Aviation, Biomimicry, Birds, Communication Technology, Digital Citizenship, Engineering, Fresh Water & Marine Biology, Geology, Horticulture | |
| 11 | Science & Technology II | 252–273 | Insects, Internet Adventure, Living & Working in Space, Mathematics, Meteorology, Women Inventors | Kitchen Scientist, Medical, Robotics, Zoology |
| 12 | Level awards | 54–55 | Sacagawea Level Award (Tenderheart), Ida Scudder Level Award (Explorer). Scaffolded with no frontier, which is correct for a level award | |

About 8 badges (16 annotation files, roughly 20 page images) per session,
which leaves room for re-reading a page. Segments are independent and touch
different files, so they can run in any order, even in parallel.

The catalog is the authority on what needs filling. If `--list` names a
badge that isn't in this table, or the reverse (a level that doesn't exist
in the catalog), follow `--list` and note it in the segment report.
Once Step 0 has run, `--list` counts every scaffolded badge as done, so
measure progress with `node scripts/build-badges.js --check` instead: an
unfilled scaffold shows up as refused for "empty text".

## Results (Oct 24, 2026)

All 12 segments ran. `build-badges --check`: 198 built, 2 refused. Pages
and catalog matched everywhere else, and no word was unreadable.

The level awards' requirements aren't on pp. 54–55, which are only an
overview. They come from the tracking sheets: Sacagawea p. 304, Ida Scudder
p. 311. Identity (Tenderheart) prints req 6 under a stray "Complete All
continued" header. It's numbered after the Complete One items, so the
catalog's grouping was kept.

Together as a Family needed the build and the importer to key requirements by group: its catalog restarts at 1–5 in every category and lists all 30 again under "Additional". The book numbers 1–30 straight through (pp. 116–119). Badges like it get group-qualified tracker ids (`<badge>:g7.12`); every other badge keeps its `<badge>:12` ids.

Still refused:

| file | why |
|---|---|
| `canoeing-v1-3.expl` | AHGFamily has two Explorer versions; this book prints V4 (filled). V1-3 needs an older printing. |
| `outdoor-cooking-v4.expl` | The reverse: this book prints V1-3 (filled). V4 needs a newer printing. |

## What a segment session does

1. Read `CLAUDE.md`, `handbook/README.md` and one finished pilot pair
   (e.g. `data/handbook/home-decorating.*.json`) for the house style.
2. For each badge in the row: open its spread images and fill both scaffolds:
   `intro`, `ahgHistory`, `faithConnection` (text + reference),
   `classic`, `handbook.pages`, and every requirement's `text` and
   `subItems`. Transcribe exactly as printed. Drop italics, keep
   punctuation, and don't fix the book's wording.
3. `node scripts/build-badges.js --check` until that segment's badges
   pass. Every other unfilled scaffold still fails, which is expected.
4. Report: badges filled, any word it couldn't read for certain (page +
   requirement number, so a leader can check the paper copy), and any
   catalog mismatch.

## Finish

After the last segment (or after any segment, to get partial results live):
`npm run build:badges` → copy `data/badges/` to the Pi → Admin
"Re-import" (the flow in `docs/HANDOFF.md`).

Pilot page check: the pilots record a single page per level
(Tenderheart = even, Explorer = odd). Each was re-checked against its
spread during its segment, and all were correct.

## Out of scope (for now)

- Sports Pins (pp. 274–302): not in the annotatable catalog.
- Sections 1–2 apart from the level awards (segment 12), and the Section 4
  tracking sheets.
- `handbook.images` (leaders-only SharePoint paths): the page images from
  Step 0 could be uploaded there later.

# Pioneer & Patriot handbook → annotations

Same method and copyright rule as above. This section holds page numbers and
names only.

## Source

`Pioneer & Patriot Handbook.pdf` (leaders' machine, scanned-badges folder,
copyright 2020): 336 pages, 151 MB, 200 dpi JPEG per page (1700 × 2200 once
upright; every page is stored rotated, which the extractor now corrects).

**PDF page n = printed page n, for every page.** The covers weren't scanned.
Printed numbers were checked on pp. 8–336, and none are missing or out of order.
Extract with `npm run extract:handbook-pages -- "<scan.pdf>" --book pipa --width 1700`
into `data/handbook-pages/pipa/`. `--raw` names files by PDF page, for working
out the mapping of a new scan.

## Layout facts that differ from TH/EX

- Each badge has one level group, `Pioneer/Patriot`, written to
  `data/handbook/<slug>.pipa.json`. Page ranges come from the Badge Index (p. 336).
- Level awards: overview pp. 64–65, requirements on the tracking sheets:
  Harriet Tubman p. 314, Abigail Adams p. 318. The planning guides (pp. 315–317,
  319–322) are not requirements.
- Stars & Stripes: pp. 66–67 give an outline and the required badges, not full
  requirements (those are in AHG's Stars & Stripes Award Guide). AHGFamily has no
  such award, so `handbook/awards.json` names it for the website's Awards tab.
- The Joining Award is on pp. 32–33.

## Segments

| # | frontier | pages | badges |
|---|---|---|---|
| 1 | Heritage I | 74–87 | Ancestor Detector, Caring for Creation, Citizenship & Government, Dawn of Our Country, Freedom Seekers, Living in the USA, Native American |
| 2 | Heritage II | 88–101 | Our Constitution, Our Flag, Our Heritage, U.S. Military Heroes, Women of Faith, World Heritage |
| 3 | Family Living I | 102–119 | Auto Care & Safety, Cake Decorating, Cooking, Family Helper, Home Care & Repair, Home Decorating, Kid Care, Money Management |
| 4 | Family Living II | 120–133 | Pet Care, Scrapbooking, Sewing, Sustainable Living, Together as A Family, Toys & Games |
| 5 | Arts I | 134–147 | Art History, Cinematography, Crafts, Creative Writing, Dance, Fine Arts, Graphic Design |
| 6 | Arts II | 148–163 | Music Appreciation, Music Performance, Needle Arts, Pen & Paper Arts, Photography, Puppetry, Textile Arts, Theater |
| 7 | Outdoor Skills I | 164–181 | Archery, Boating, Camping, Canoeing, Cycling, Fire Safety & Fire Building, Fishing, Geocaching & Orienteering, Hiking |
| 8 | Outdoor Skills II | 182–199 | Horsemanship, Nature & Wildlife, Outdoor Cooking, Outdoor Skills, Rock Climbing, Shooting Sports, Survival, Search, & Rescue, Swimming |
| 9 | Personal Well-Being I | 200–223 | All God's Children, Bible Basics, Biblical Leadership, Book Adventurer, Daughter of the King, Emergency Preparedness, Entrepreneurship, Fashion, Identity, Mission Minded |
| 10 | Personal Well-Being II | 224–237 | Personal Care, Physical Fitness, Public Speaking, Sign Language, Social Skills & Etiquette, Travel, World Languages |
| 11 | Science & Technology I | 238–259 | Architecture, Astronomy, Aviation, Biomimicry, Communication Technology, Digital Citizenship, Engineering, Entomology, Fresh Water & Marine Biology |
| 12 | Science & Technology II | 260–283 | Geology, Horticulture, Internet Adventure, Kitchen Scientist, Living & Working in Space, Mathematics, Medical, Meteorology, Ornithology, Robotics, Women Inventors, Zoology |

## Results (Nov 2, 2026)

All 12 segments ran, and the two level awards were filled by hand. Every badge
the book prints builds: 97 `.pipa` files and both level awards. The only
refusals left are the two TH/EX editions listed above. No word was unreadable,
and every requirement count and rule matched the catalog.

The older pilots came from a different printing and were rechecked against this
scan: Our Flag (was pp. 88–89), Toys & Games (130–131) and Nature & Wildlife
(182–183) are now pp. 90–91, 132–133 and 184–185. Nature & Wildlife requirement 4
also has different wording in this printing.

To check against the paper copy or AHG:

| page | what |
|---|---|
| 192–194 | Shooting Sports prints "either the Rifle section or the Shotgun section", but the catalog has both as groups with no rule, so the tracker treats the badge as needing both. The tracker can't express either/or between groups yet, so a girl who finishes one section won't show the badge complete. |
| 33 | Joining Award wording differs from AHGFamily's titles. It stays built from the titles because one record serves every level, including Pathfinders. |
| 318 | Abigail Adams requirements 9 and 12 differ from AHGFamily's titles. The annotation has the book's wording. |

Printed oddities kept as printed: Women of Faith req 14 "positon"; Archery Faith
Connection "Ismael"; Ornithology AHG History "origianlly"; Robotics intro
"otherwise by dangerous"; Medical req 4 "choose her or her"; Shooting Sports
printed req 14 "types of rifles" in the shotgun box; Joining p. 33 "truddy".

Pages with no requirements, assigned to no badge: 119, 195, 207, 223, 251, 255.

Not annotated:

- B.Y. Faith Award and NCC Catholic Faith Awards: no handbook prints them, so
  they build from AHGFamily's titles.
- Sports Pins (pp. 284–312): level group `All`, out of scope as with TH/EX.
