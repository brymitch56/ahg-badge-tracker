'use strict';
/**
 * xlsx-lite.js — read the first worksheet of an .xlsx Buffer into rows of
 * strings, with no dependencies. Enough for a roster export: shared
 * strings, inline strings, numbers, dates left as their serial numbers.
 * Not a general-purpose reader.
 */
const zlib = require('zlib');

// Minimal ZIP reader: walk the central directory, inflate entries on demand.
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, csize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const lo = e.localOff;
    if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('bad local header');
    const nameLen = buf.readUInt16LE(lo + 26);
    const extraLen = buf.readUInt16LE(lo + 28);
    const start = lo + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`unsupported zip method ${e.method}`);
  };
  return { names: [...entries.keys()], read };
}

const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');

function sharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) {
    out.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join(''));
  }
  return out;
}

const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** @returns {string[][]} rows (ragged; empty cells are '') */
function readFirstSheet(buf) {
  const z = unzip(buf);
  const sst = sharedStrings(z.read('xl/sharedStrings.xml') ? z.read('xl/sharedStrings.xml').toString('utf8') : null);
  const sheetName = z.names.find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n)) || z.names.find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  if (!sheetName) throw new Error('no worksheet in workbook');
  const xml = z.read(sheetName).toString('utf8');
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const row = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1];
      const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1];
      const type = (attrs.match(/\bt="(\w+)"/) || [])[1];
      const inner = cm[2] || '';
      let val = '';
      if (type === 's') { const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1]; val = v !== undefined ? (sst[Number(v)] ?? '') : ''; }
      else if (type === 'inlineStr') val = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join('');
      else { const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1]; val = v !== undefined ? decodeXml(v) : ''; }
      const idx = ref ? colIndex(ref) : row.length;
      while (row.length < idx) row.push('');
      row[idx] = val;
    }
    rows.push(row);
  }
  return rows;
}

module.exports = { unzip, readFirstSheet };
