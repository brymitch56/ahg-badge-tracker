'use strict';
// Minimal .env loader (no dependency). Values already in process.env win.
// Same parser as troop-checkin's server/lib/env.js. ENV_FILE overrides the
// location (containers); default is the repo root.
const fs = require('fs');
const path = require('path');

const ENV_PATH = process.env.ENV_FILE
  ? path.resolve(process.env.ENV_FILE)
  : path.join(__dirname, '..', '.env');

let loaded = false;
try {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  loaded = true;
} catch { /* no .env — defaults apply */ }

module.exports = { ENV_PATH, loaded };
