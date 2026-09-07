'use strict';
/**
 * Girl ↔ AHGFamily mapping (spec §4 girls, decision 1; HANDOFF build step 3).
 *
 * The AHGFamily roster export has no hashid column, so the u… youth id is
 * filled when empty from, in order: (1) the check-in app's tlc_user_id
 * (mirror.js), (2) THIS mapping screen — AHGFamily's own #youth-select
 * (name ↔ u… id), auto-matched by name, leader-confirmed — and (3) manual
 * entry (PATCH /girls/:id). The fetched name↔id pairs live ONLY in
 * tracker.db (settings), never in logs, data/ or git.
 *
 * AHGFamily traffic here is read-only (lib/ahgfamily.js allow-list: the
 * login pages and GET /advancement/index) and carries the auth-failure
 * latch (rule 8): one failed login disables all AHGFamily traffic until an
 * admin re-enters credentials — never retry, AHGFamily may lock the account.
 */
const A = require('../../lib/ahgfamily');
const { parseYouthSelectPairs } = require('../../lib/parse');
const { getSetting, setSetting } = require('./settings');
const cred = require('./credcrypto');
const { recordRun } = require('./mirror');

const CREDS_KEY = 'ahgfamily_credentials';
const LATCH_KEY = 'ahgfamily_latch';
const YOUTH_SELECT_KEY = 'ahgfamily_youth_select';

// ---------------------------------------------------------------- latch ----
const getLatch = (db) => getSetting(db, LATCH_KEY);
const setLatch = (db, error) => setSetting(db, LATCH_KEY, { latchedAt: new Date().toISOString(), error });
const clearLatch = (db) => setSetting(db, LATCH_KEY, null);

// ---------------------------------------------------------- credentials ----
/** Store AHGFamily credentials AES-GCM-encrypted; re-entry clears the latch. */
function storeCredentials(db, { email, password }, actor, key = null) {
  const k = key || cred.ensureKey();
  setSetting(db, CREDS_KEY, { email, box: cred.encrypt(password, k) }, actor);
  clearLatch(db);
  db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), actor, 'ahgfamily.credentials', 'settings', CREDS_KEY, null,
      JSON.stringify({ email, latchCleared: true })); // never the password
}

/**
 * Resolve credentials: the stored encrypted pair, falling back to
 * AHG_EMAIL/AHG_PASSWORD from .env (the fetch scripts' dev pair).
 * Returns { email, password } or null.
 */
function getCredentials(db, key = null, env = process.env) {
  const stored = getSetting(db, CREDS_KEY);
  if (stored) {
    const password = cred.decrypt(stored.box, key || cred.loadKey(env));
    if (password == null) return { unreadable: true };
    return { email: stored.email, password };
  }
  if (env.AHG_EMAIL && env.AHG_PASSWORD) return { email: env.AHG_EMAIL, password: env.AHG_PASSWORD };
  return null;
}

const credentialsState = (db, key = null, env = process.env) => {
  const c = getCredentials(db, key, env);
  return !c ? 'off' : c.unreadable ? 'unreadable' : 'ok';
};

// -------------------------------------------------- youth-select refresh ----
/**
 * Production fetcher: sign in, GET the advancement page shell, sign out.
 * Read-only by the allow-list; a lost/failed session throws FetchError
 * with code EXIT.AUTH and is never retried.
 */
async function fetchAdvancementIndexHtml(db, key = null, env = process.env) {
  const creds = getCredentials(db, key, env);
  if (!creds) throw Object.assign(new Error('no AHGFamily credentials — enter them via the admin screen'), { code: 'noconfig' });
  if (creds.unreadable) throw Object.assign(new Error('stored AHGFamily credentials are unreadable (CRED_KEY missing or changed) — re-enter them'), { code: 'noconfig' });
  const acfg = { ...A.makeConfig(env), email: creds.email, password: creds.password };
  const jar = new A.CookieJar();
  await A.login(acfg, jar);
  try {
    await A.sleep(acfg.throttleMs);
    return await A.getPage(acfg, jar, '/advancement/index?level=all&style=grid');
  } finally {
    try { await A.request(acfg, jar, '/logout'); } catch { /* best effort */ }
  }
}

/**
 * Refresh the stored name↔id list from AHGFamily. `fetchHtml` is injectable
 * so tests stay offline. Latched ⇒ refuse before any traffic (rule 8).
 */
async function refreshYouthSelect(db, { fetchHtml = fetchAdvancementIndexHtml, key = null, env = process.env, actor = null } = {}) {
  const latch = getLatch(db);
  if (latch) {
    throw Object.assign(new Error(`AHGFamily is latched since ${latch.latchedAt} (${latch.error}) — re-enter credentials to clear`), { code: 'latched' });
  }
  return recordRun(db, 'pull', async () => {
    let html;
    try {
      html = await fetchHtml(db, key, env);
    } catch (e) {
      if (e instanceof A.FetchError && e.code === A.EXIT.AUTH) {
        setLatch(db, e.message);
        throw Object.assign(new Error(`AHGFamily login failed — latched all AHGFamily traffic (${e.message})`), { code: 'latched' });
      }
      throw e;
    }
    const youth = parseYouthSelectPairs(html);
    if (!youth.length) throw new Error('#youth-select parsed to zero youth — page layout changed?');
    setSetting(db, YOUTH_SELECT_KEY, { fetchedAt: new Date().toISOString(), youth }, actor);
    return { kind: 'youth_select', youth: youth.length };
  });
}

// ----------------------------------------------------------- suggestions ----
// "Anna Smith", "Smith, Anna" → "anna smith" (accents stripped, punctuation
// dropped) so both systems' name orders compare equal.
function normName(s) {
  let t = String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const comma = t.indexOf(',');
  if (comma >= 0) t = `${t.slice(comma + 1)} ${t.slice(0, comma)}`;
  return t.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The mapping screen's data: the stored youth-select list, unmapped girls,
 * and unambiguous name matches as suggestions (a leader confirms each pair
 * — nothing is applied automatically).
 */
function mappingView(db) {
  const stored = getSetting(db, YOUTH_SELECT_KEY);
  const girls = db.prepare('SELECT * FROM girls WHERE active = 1 ORDER BY last_name, first_name').all();
  const mappedIds = new Set(girls.map((g) => g.ahg_youth_id).filter(Boolean));
  const unmapped = girls.filter((g) => !g.ahg_youth_id);
  const suggestions = [];
  if (stored) {
    const freeYouth = stored.youth.filter((y) => !mappedIds.has(y.id));
    const byName = new Map(); // normalized youth name → ids
    for (const y of freeYouth) {
      const k = normName(y.name);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(y.id);
    }
    for (const g of unmapped) {
      const keys = new Set([normName(`${g.first_name} ${g.last_name}`)]);
      if (g.nickname) keys.add(normName(`${g.nickname} ${g.last_name}`));
      const hits = [...keys].flatMap((k) => byName.get(k) || []);
      if (new Set(hits).size === 1) suggestions.push({ girlId: g.id, ahgYouthId: hits[0] });
    }
    // a youth id suggested for two girls is ambiguous — drop both
    const counts = suggestions.reduce((m, s) => m.set(s.ahgYouthId, (m.get(s.ahgYouthId) || 0) + 1), new Map());
    return { stored, girls, unmapped, suggestions: suggestions.filter((s) => counts.get(s.ahgYouthId) === 1) };
  }
  return { stored: null, girls, unmapped, suggestions };
}

/**
 * Apply leader-confirmed pairs. Fill-when-empty: refuses a girl already
 * mapped and a youth id already in use. All-or-nothing.
 */
function confirmMappings(db, pairs, actor) {
  const apply = db.transaction(() => {
    const applied = [];
    for (const p of pairs) {
      const g = db.prepare('SELECT * FROM girls WHERE id = ?').get(p.girlId);
      if (!g) throw Object.assign(new Error(`girl ${p.girlId} not found`), { code: 'bad' });
      if (!/^u[a-z0-9]{11}$/i.test(String(p.ahgYouthId || ''))) throw Object.assign(new Error(`girl ${p.girlId}: ahgYouthId must be a u… hashid`), { code: 'bad' });
      const id = p.ahgYouthId.toLowerCase();
      if (g.ahg_youth_id) throw Object.assign(new Error(`girl ${p.girlId} is already mapped`), { code: 'conflict' });
      if (db.prepare('SELECT 1 FROM girls WHERE ahg_youth_id = ?').get(id)) throw Object.assign(new Error(`${id} is already mapped to another girl`), { code: 'conflict' });
      db.prepare("UPDATE girls SET ahg_youth_id = ?, ahg_youth_id_source = 'mapped', updated_at = ? WHERE id = ?")
        .run(id, new Date().toISOString(), g.id);
      db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(new Date().toISOString(), actor, 'girl.map', 'girl', String(g.id), null, JSON.stringify({ ahg_youth_id: id, source: 'mapped' }));
      applied.push({ girlId: g.id, ahgYouthId: id });
    }
    return applied;
  });
  return apply();
}

module.exports = {
  CREDS_KEY, LATCH_KEY, YOUTH_SELECT_KEY,
  getLatch, setLatch, clearLatch,
  storeCredentials, getCredentials, credentialsState,
  fetchAdvancementIndexHtml, refreshYouthSelect,
  normName, mappingView, confirmMappings,
};
