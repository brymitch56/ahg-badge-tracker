#!/usr/bin/env node
'use strict';
/**
 * extract-handbook-pages.js — one readable JPEG per page of a scanned handbook.
 *
 * A full-book scan is one huge PDF (each page a 600 dpi JPEG). Annotating
 * from it means reading pages as images, so this pulls each page's JPEG
 * stream out as is (no re-render), scales it with ffmpeg to a width that is
 * still crisp but small enough to read, and names it by printed page number:
 * p004.jpg … p320.jpg, plus the covers and the unnumbered front pages. Each
 * scan's page mapping is its own: see BOOKS below.
 *
 * The images are AHG's copyrighted pages: write them under data/ (gitignored)
 * and never commit them. docs/handbook-ocr-plan.md is the workflow.
 *
 * Usage:
 *   node --max-old-space-size=8000 scripts/extract-handbook-pages.js "<scan.pdf>"
 *   ... --book thex                      thex (default) or pipa: the page mapping
 *   ... --out data/handbook-pages/<book> output folder (default shown)
 *   ... --width 1600                     scaled width in px
 *   ... --force                          redo pages already extracted
 *   ... --raw                            name files pdf001.jpg … (for working
 *                                        out a new scan's page mapping)
 *
 * Needs ffmpeg on PATH (or FFMPEG=<path to ffmpeg>).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PDFDocument, PDFName } = require('pdf-lib');

// A page's /Rotate (clockwise) → the ffmpeg filter that stands it upright.
const ROTATE_FILTER = { 90: 'transpose=1,', 180: 'hflip,vflip,', 270: 'transpose=2,' };

const printed = (n) => `p${String(n).padStart(3, '0')}`;

// The Tenderheart & Explorer scan: PDF page (1-based) → file name. Printed
// page 2 was never scanned, so from PDF page 5 on, PDF page n+1 is printed n.
function thexLabel(pdfPage, pageCount) {
  if (pdfPage === 1) return 'cover';
  if (pdfPage === 2) return 'inside-cover';
  if (pdfPage === 3) return 'p001';
  if (pdfPage === pageCount) return 'back-cover';
  if (pdfPage === 4) return 'p003';
  return printed(pdfPage - 1);
}

// PDF page → file name, per scan. The Pioneer & Patriot scan has no covers
// and every page in order, so PDF page n is printed page n (checked against
// the printed numbers, pp. 8–336).
const BOOKS = { thex: thexLabel, pipa: printed };

/** The page's one image XObject — a scan page has nothing else. */
function pageJpeg(doc, page) {
  const xobjects = page.node.Resources().lookup(PDFName.of('XObject'));
  const images = xobjects ? xobjects.entries().map(([, ref]) => doc.context.lookup(ref)) : [];
  if (images.length !== 1) throw new Error(`expected one image, found ${images.length}`);
  const filter = String(images[0].dict.get(PDFName.of('Filter')));
  if (!filter.includes('DCTDecode')) throw new Error(`image is ${filter}, not a JPEG`);
  return images[0].contents;
}

async function main(argv) {
  const opt = { book: 'thex', out: null, width: 1600, force: false, raw: false, pdf: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--book') opt.book = argv[++i];
    else if (argv[i] === '--out') opt.out = argv[++i];
    else if (argv[i] === '--width') opt.width = Number(argv[++i]);
    else if (argv[i] === '--force') opt.force = true;
    else if (argv[i] === '--raw') opt.raw = true;
    else opt.pdf = argv[i];
  }
  if (!opt.pdf) throw new Error('usage: extract-handbook-pages.js "<scan.pdf>" [--book thex|pipa] [--out dir] [--width px] [--force]');
  const labelFor = BOOKS[opt.book];
  if (!labelFor) throw new Error(`unknown --book ${opt.book} — one of: ${Object.keys(BOOKS).join(', ')}`);
  opt.out = opt.out || `data/handbook-pages/${opt.book}`;
  const ffmpeg = process.env.FFMPEG || 'ffmpeg';
  fs.mkdirSync(opt.out, { recursive: true });

  const doc = await PDFDocument.load(fs.readFileSync(opt.pdf), { updateMetadata: false });
  const pages = doc.getPages();
  const tmp = path.join(os.tmpdir(), `handbook-page-${process.pid}.jpg`);
  let written = 0;
  for (let i = 0; i < pages.length; i++) {
    const name = opt.raw ? `pdf${String(i + 1).padStart(3, '0')}` : labelFor(i + 1, pages.length);
    const file = path.join(opt.out, `${name}.jpg`);
    if (!opt.force && fs.existsSync(file)) continue;
    fs.writeFileSync(tmp, pageJpeg(doc, pages[i]));
    execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-i', tmp, '-vf', `${ROTATE_FILTER[pages[i].getRotation().angle] || ''}scale=${opt.width}:-1`, '-q:v', '3', file]);
    written++;
    if (written % 25 === 0) console.log(`${i + 1}/${pages.length}`);
  }
  fs.rmSync(tmp, { force: true });
  console.log(`${written} written, ${pages.length - written} already there → ${opt.out}`);
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { BOOKS };
