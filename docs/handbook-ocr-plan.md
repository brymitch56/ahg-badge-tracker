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
