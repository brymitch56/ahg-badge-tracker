#!/usr/bin/env node
'use strict';
/**
 * extract-handbook-pages.js — one readable JPEG per page of a scanned handbook.
 *
 * A full-book scan is one huge PDF (each page a 600 dpi JPEG). Annotating
 * from it means reading pages as images, so this pulls each page's JPEG
 * stream out as is (no re-render), scales it with ffmpeg to a width that is
 * still crisp but small enough to read, and names it by printed page number:
 * p004.jpg … p320.jpg, plus the covers and the unnumbered front pages.
 *
 * The images are AHG's copyrighted pages: write them under data/ (gitignored)
 * and never commit them. docs/handbook-ocr-plan.md is the workflow.
 *
 * Usage:
 *   node --max-old-space-size=8000 scripts/extract-handbook-pages.js "<scan.pdf>"
 *   ... --out data/handbook-pages/thex   output folder (default shown)
 *   ... --width 1600                     scaled width in px
 *   ... --force                          redo pages already extracted
 *
 * Needs ffmpeg on PATH (or FFMPEG=<path to ffmpeg>).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PDFDocument, PDFName } = require('pdf-lib');

// The Tenderheart & Explorer scan: PDF page (1-based) → file name. Printed
// page 2 was never scanned, so from PDF page 5 on, PDF page n+1 is printed n.
function labelFor(pdfPage, pageCount) {
  if (pdfPage === 1) return 'cover';
  if (pdfPage === 2) return 'inside-cover';
  if (pdfPage === 3) return 'p001';
  if (pdfPage === pageCount) return 'back-cover';
  if (pdfPage === 4) return 'p003';
  return `p${String(pdfPage - 1).padStart(3, '0')}`;
}

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
  const opt = { out: 'data/handbook-pages/thex', width: 1600, force: false, pdf: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') opt.out = argv[++i];
    else if (argv[i] === '--width') opt.width = Number(argv[++i]);
    else if (argv[i] === '--force') opt.force = true;
    else opt.pdf = argv[i];
  }
  if (!opt.pdf) throw new Error('usage: extract-handbook-pages.js "<scan.pdf>" [--out dir] [--width px] [--force]');
  const ffmpeg = process.env.FFMPEG || 'ffmpeg';
  fs.mkdirSync(opt.out, { recursive: true });

  const doc = await PDFDocument.load(fs.readFileSync(opt.pdf), { updateMetadata: false });
  const pages = doc.getPages();
  const tmp = path.join(os.tmpdir(), `handbook-page-${process.pid}.jpg`);
  let written = 0;
  for (let i = 0; i < pages.length; i++) {
    const file = path.join(opt.out, `${labelFor(i + 1, pages.length)}.jpg`);
    if (!opt.force && fs.existsSync(file)) continue;
    fs.writeFileSync(tmp, pageJpeg(doc, pages[i]));
    execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-i', tmp, '-vf', `scale=${opt.width}:-1`, '-q:v', '3', file]);
    written++;
    if (written % 25 === 0) console.log(`${i + 1}/${pages.length}`);
  }
  fs.rmSync(tmp, { force: true });
  console.log(`${written} written, ${pages.length - written} already there → ${opt.out}`);
}

main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
