#!/usr/bin/env node
'use strict';
/**
 * roster-headers.js — answer "what columns does the AHGFamily member export
 * have?" without ever writing roster data to disk.
 *
 * Logs in (lib/ahgfamily.js), requests the member export the same way
 * troop-checkin's fetch-roster.js does (GET export → 503 kicks off the job →
 * poll /databuilder/get-download-status → GET again → file), parses the
 * workbook IN MEMORY, and prints:
 *   - the export file's declared format (xlsx / csv / html)
 *   - the header row (column names only)
 *   - the number of data rows (a count, nothing else)
 *   - with --levels: the distinct values of the "Current Level" column
 *     (program-level names only — never a person)
 * Nothing is written anywhere. The buffer is dropped when the process exits.
 *
 * Read-only endpoints only (allow-listed in lib/ahgfamily.js). Never run this
 * in a loop; one export job per run.
 */

const A = require('../lib/ahgfamily');
const { readFirstSheet } = require('../lib/xlsx-lite');

function detectFormat(buf) {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) return 'xlsx';
  const head = buf.subarray(0, 300).toString('utf8').replace(/^﻿/, '');
  if (/^\s*<(!doctype|html)/i.test(head)) return 'html';
  return 'csv';
}

function csvRows(text) {
  // Good enough for an export: quoted fields with commas/newlines, "" escapes.
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function pollUntilReady(cfg, jar, token, statusPath, max = 40, ms = 3000) {
  for (let i = 0; i < max; i++) {
    const res = await A.request(cfg, jar, statusPath, {
      method: 'POST',
      headers: { 'X-CSRF-Token': token, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01', Referer: cfg.base + '/user/index' },
    });
    let json = {};
    try { json = JSON.parse(await res.text()); } catch { /* keep polling */ }
    if (String(json.status).toLowerCase() === 'finished') return true;
    if (i < max - 1) await A.sleep(ms);
  }
  return false;
}

async function main(argv) {
  const wantLevels = argv.includes('--levels');
  const exportPath = process.env.AHG_EXPORT_PATH || '/user/exportexcel?format=xlsx'; // AHGFamily; TLC would be /user/index?export=xlsx&new=0
  const statusPath = '/databuilder/get-download-status';
  const cfg = A.makeConfig();
  const jar = new A.CookieJar();
  console.log('[roster-headers] logging in…');
  const { token } = await A.login(cfg, jar);
  await A.sleep(cfg.throttleMs);

  let res = await A.request(cfg, jar, exportPath);
  let buf;
  if (res.status === 200) buf = Buffer.from(await res.arrayBuffer());
  else if (res.status === 503) {
    console.log('[roster-headers] export job started; polling…');
    if (!await pollUntilReady(cfg, jar, token, statusPath)) throw new A.FetchError(A.EXIT.FETCH, 'export never reported finished');
    res = await A.request(cfg, jar, exportPath);
    if (res.status !== 200) throw new A.FetchError(A.EXIT.FETCH, `export not served after finished (${res.status})`);
    buf = Buffer.from(await res.arrayBuffer());
  } else throw new A.FetchError(A.EXIT.FETCH, `unexpected status ${res.status} requesting the export`);

  const format = detectFormat(buf);
  console.log(`[roster-headers] received ${buf.length} bytes, format=${format} (Content-Type: ${res.headers.get('content-type')})`);
  if (format === 'html') throw new A.FetchError(A.EXIT.FETCH, 'got an HTML page instead of an export — role without member-list access, or the export path differs on this site');

  const rows = format === 'xlsx' ? readFirstSheet(buf) : csvRows(buf.toString('utf8').replace(/^﻿/, ''));
  const headerIdx = rows.findIndex((r) => r.some((c) => /member number/i.test(String(c))));
  if (headerIdx < 0) {
    console.log(`[roster-headers] no "Member Number" header found. First row cells (count ${rows[0] ? rows[0].length : 0}):`);
    console.log('  ' + (rows[0] || []).map((c) => String(c).trim()).filter(Boolean).join(' | '));
    process.exit(A.EXIT.PARSE);
  }
  const header = rows[headerIdx].map((c) => String(c).trim());
  const data = rows.slice(headerIdx + 1).filter((r) => r.some((c) => String(c).trim() !== ''));
  console.log(`\nHEADER ROW (${header.filter(Boolean).length} columns, header at row ${headerIdx + 1}):`);
  console.log('  ' + header.filter(Boolean).join(' | '));
  console.log(`\nDATA ROWS: ${data.length}`);
  const idLike = header.filter((h) => /hash|user ?id|\bid\b|uid/i.test(h));
  console.log(`\nID-LIKE COLUMNS: ${idLike.length ? idLike.join(' | ') : '(none besides Member Number)'}`);
  if (wantLevels) {
    const li = header.findIndex((h) => /^current level$/i.test(h));
    if (li < 0) console.log('\nCURRENT LEVEL: no such column');
    else {
      const counts = {};
      for (const r of data) { const v = String(r[li] ?? '').trim() || '(blank)'; counts[v] = (counts[v] || 0) + 1; }
      console.log('\nCURRENT LEVEL values (value: count):');
      for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(() => process.exit(0)).catch((e) => {
    console.error('[roster-headers] ' + (e instanceof A.FetchError ? e.message : (e.stack || String(e))));
    process.exit(e instanceof A.FetchError ? e.code : A.EXIT.FETCH);
  });
}
