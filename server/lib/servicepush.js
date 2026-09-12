'use strict';
/**
 * Service Stars — step 7, the PUSH to AHGFamily (docs/service-stars-plan.md
 * "The write"; verified live in docs/step5-verification-session.md).
 *
 * This is the ONLY code in the project that writes to AHGFamily. It drains
 * `push_queue` rows with action='add_instance' (created, idle, by the star
 * proposal decide flow) and records each new Service Star instance on the
 * girl's AHGFamily profile. It ships OFF: nothing runs unless an admin has
 * turned the `push_enabled` setting on, and even then it is manual-only
 * ("Push to AHGFamily now") until it has been watched through a real run.
 *
 * Why every step below is mandatory, not defensive padding (all step-5 facts):
 *   - There is no granular add-instance endpoint. Adding one star is a
 *     full-form POST of the ENTIRE Standard view: every panel of every
 *     existing instance must be echoed back byte-for-byte, or the unechoed
 *     fields are cleared on records we never meant to touch.
 *   - Blank `new-<adId>` slot ids change on every fetch, so we FETCH the
 *     fragment immediately before building the body — never a cached one.
 *   - The server validates NOTHING and answers 200/302 + alert-success
 *     whether or not it wrote. So we validate the date ourselves, and we
 *     prove the write happened by READING IT BACK: instance count +1, the
 *     new panel carries our date and comment, and every pre-existing panel
 *     is unchanged. Anything else → the row is HELD for a human, never a
 *     blind retry (a retry on an ambiguous result risks a duplicate star).
 *   - No optimistic-lock token exists, so rows are processed one at a time
 *     and the fragment is re-read per row (two stars for one girl add up).
 *   - Rule 8 latch: one auth failure stops everything until creds re-entered.
 */
const A = require('../../lib/ahgfamily');
const { parseStandardState } = require('../../lib/parse');
const mapping = require('./mapping');
const stars = require('../../lib/stars');
const ahgpull = require('./ahgpull');
const { recordRun } = require('./mirror');
const { getSetting, setSetting } = require('./settings');

const { PullError } = ahgpull;
const SETTING = 'push_enabled';
const now = () => new Date().toISOString();

const pushEnabled = (db) => getSetting(db, SETTING) === true;
const setPushEnabled = (db, on, actor) => { setSetting(db, SETTING, !!on, actor); return !!on; };

// YYYY-MM-DD (stored) → MM/DD/YYYY (the form's format), only for a real,
// non-future calendar date. Returns null otherwise — the server would accept
// garbage and store a dateless star, so this is the only gate there is.
function toFormDate(iso, tz = 'UTC') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  let todayStr;
  try { todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch { todayStr = now().slice(0, 10); }
  if (iso > todayStr) return null; // never date a star in the future
  return `${m[2]}/${m[3]}/${m[1]}`;
}

// Browser-faithful serialisation of every successful-submit field in an HTML
// form string (the behaviour a browser's form POST would produce): skip
// disabled/submit/button/file; unchecked checkbox/radio contribute nothing;
// selects contribute their selected option (first option if none marked).
function serializeForm(html) {
  const out = [];
  const re = /<(input|textarea|select)\b([^>]*)>(?:([\s\S]*?)<\/\1\s*>)?/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = Object.fromEntries([...m[2].matchAll(/([a-zA-Z_:-]+)(?:="([^"]*)")?/g)].map((x) => [x[1], x[2] === undefined ? '' : A.decodeHtml(x[2])]));
    const name = (attrs.name || '').trim();
    if (!name || 'disabled' in attrs) continue;
    const tag = m[1].toLowerCase();
    const type = (attrs.type || 'text').toLowerCase();
    if (tag === 'input') {
      if (type === 'submit' || type === 'button' || type === 'file' || type === 'image' || type === 'reset') continue;
      if ((type === 'checkbox' || type === 'radio') && !('checked' in attrs)) continue;
      out.push([name, attrs.value === undefined ? (type === 'checkbox' ? 'on' : '') : attrs.value]);
    } else if (tag === 'textarea') {
      out.push([name, A.decodeHtml(m[3] || '')]);
    } else {
      const opts = [...(m[3] || '').matchAll(/<option\b([^>]*)>/gi)]
        .map((o) => Object.fromEntries([...o[1].matchAll(/([a-zA-Z_:-]+)(?:="([^"]*)")?/g)].map((x) => [x[1], x[2] === undefined ? '' : A.decodeHtml(x[2])])));
      const sel = opts.filter((o) => 'selected' in o);
      const multi = 'multiple' in attrs;
      const chosen = sel.length ? sel : (multi || !opts.length ? [] : [opts[0]]);
      for (const o of chosen) out.push([name, o.value || '']);
    }
  }
  return out;
}

// Just the panel fields of a Standard fragment, in document order, with one
// blank slot's new-/completed_on-/comment- filled. Everything else is echoed
// verbatim (date/awarded/purchased/comment of every existing instance).
function panelPairsWithStar(fragmentHtml, slotId, formDate, comment) {
  const pairs = [];
  const re = /<(input|textarea)\b([^>]*)>(?:([\s\S]*?)<\/\1\s*>)?/gi;
  let m;
  while ((m = re.exec(fragmentHtml))) {
    const attrs = Object.fromEntries([...m[2].matchAll(/([a-zA-Z_:-]+)(?:="([^"]*)")?/g)].map((x) => [x[1], x[2] === undefined ? '' : A.decodeHtml(x[2])]));
    const name = (attrs.name || '').trim();
    if (!/^(new|completed_on|awarded_on|purchased|comment)-ad[a-z0-9]{10}$/.test(name)) continue;
    const value = m[1].toLowerCase() === 'textarea' ? A.decodeHtml(m[3] || '') : (attrs.value || '');
    pairs.push([name, value]);
  }
  // Fill the chosen blank slot: it currently contributes empty values; set them.
  const set = (suffix, val) => {
    const nm = `${suffix}-${slotId}`;
    const i = pairs.findIndex(([n]) => n === nm);
    if (i >= 0) pairs[i] = [nm, val]; else pairs.push([nm, val]);
  };
  set('new', 'true');
  set('completed_on', formDate);
  set('comment', comment);
  return pairs;
}

// Compare the saved (non-blank) panels, ignoring a given ad id, as a stable
// signature so "pre-existing instances untouched" is a byte-level assertion.
const savedSig = (state, exceptId = null) => state.records
  .filter((r) => !r.isNew && r.adId !== exceptId)
  .map((r) => [r.adId, r.completedOn, r.awardedOn, r.purchased, r.comment])
  .sort((a, b) => (a[0] < b[0] ? -1 : 1));

/**
 * Push queued add_instance rows. Off unless `push_enabled`; manual only.
 * `sessionFactory` is injected in tests; the live one (ahgpull.makeLiveSession)
 * carries the read calls AND the single `save()`.
 */
async function pushStarInstances(db, cfg, { sessionFactory = ahgpull.makeLiveSession, key = null, env = process.env, actor = 'system', limit = 50 } = {}) {
  if (!pushEnabled(db)) return { skipped: 'push disabled', pushed: 0, held: 0, failed: 0 };
  const latch = mapping.getLatch(db);
  if (latch) throw new PullError('latched', `AHGFamily is latched since ${latch.latchedAt} (${latch.error}) — re-enter credentials to clear`);
  if (!mapping.hasStoredCredentials(db, key)) throw new PullError('noconfig', 'no AHGFamily credentials — enter them via the admin screen');

  const rows = db.prepare("SELECT * FROM push_queue WHERE action = 'add_instance' AND status = 'queued' ORDER BY id LIMIT ?").all(limit);

  return recordRun(db, 'push', async () => {
    const summary = { action: 'add_instance', queued: rows.length, pushed: 0, held: 0, failed: 0, items: [], warnings: [] };
    if (!rows.length) return summary;

    let session;
    try {
      session = await sessionFactory(db, { key, env });
    } catch (e) {
      if (e instanceof A.FetchError && e.code === A.EXIT.AUTH) {
        mapping.setLatch(db, e.message);
        throw new PullError('latched', `AHGFamily login failed — latched all AHGFamily traffic (${e.message})`);
      }
      throw e;
    }

    const runId = db.prepare('SELECT MAX(id) AS id FROM sync_runs').get().id;
    const finish = (row, status, lastError) => {
      db.prepare('UPDATE push_queue SET status = ?, attempts = attempts + 1, last_error = ?, sent_at = ?, sync_run_id = ? WHERE id = ?')
        .run(status, lastError || null, status === 'sent' ? now() : null, runId, row.id);
      db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(now(), actor, `push.add_instance.${status}`, 'push_queue', String(row.id),
          JSON.stringify({ status: 'queued' }), JSON.stringify({ status, girlId: row.girl_id, error: lastError || null }));
      summary.items.push({ id: row.id, girlId: row.girl_id, status, error: lastError || null });
      summary[status === 'sent' ? 'pushed' : status === 'held' ? 'held' : 'failed'] += 1;
    };

    try {
      for (const row of rows) {
        const girl = db.prepare('SELECT * FROM girls WHERE id = ?').get(row.girl_id);
        const detail = row.detail ? JSON.parse(row.detail) : {};
        const awardId = row.ahg_award_id;
        // Guards that fail the ROW (held), not the run.
        if (!girl || !girl.active || !girl.ahg_youth_id) { finish(row, 'held', 'girl is not active / not mapped to AHGFamily'); continue; }
        if (!awardId) { finish(row, 'held', 'queue row has no AHGFamily award id'); continue; }
        const formDate = toFormDate(row.date, cfg.tz);
        if (!formDate) { finish(row, 'held', `refusing to push an invalid or future completion date (${row.date}) — the server would store it dateless`); continue; }
        const comment = detail.comment || `tracker: ${detail.level || ''} service star`;

        // READ fresh — slot ids are per-fetch.
        const beforeHtml = await session.standard(awardId, girl.ahg_youth_id);
        const before = parseStandardState(beforeHtml, { awardId });
        const slot = before.records.find((r) => r.isNew);
        if (!slot) { finish(row, 'held', 'no blank instance slot on the Standard form — cannot add without clobbering'); continue; }

        // BUILD the full form: outer shell + this girl/award + every panel,
        // with one blank slot filled.
        const pageHtml = await session.page('/advancement/index?level=all&style=standard');
        const outer = serializeForm(pageHtml).filter(([n]) => !/^(youth-select\[\]|badge-select)$/.test(n) && !/^(new|completed_on|awarded_on|purchased|comment)-ad[a-z0-9]{10}$/.test(n));
        const body = [...outer, ['youth-select[]', girl.ahg_youth_id], ['badge-select', awardId],
          ...panelPairsWithStar(beforeHtml, slot.adId, formDate, comment)];

        // WRITE (the one exception), then PROVE it by reading back.
        await session.save(body);
        const after = parseStandardState(await session.standard(awardId, girl.ahg_youth_id), { awardId });
        const added = after.records.filter((r) => !r.isNew).find((r) => r.completedOn === formDate && r.comment === comment && !savedSig(before).some(([id]) => id === r.adId));
        const untouched = JSON.stringify(savedSig(before)) === JSON.stringify(savedSig(after, added ? added.adId : null));

        if (after.instanceCount === before.instanceCount + 1 && added && untouched) {
          finish(row, 'sent', null);
        } else {
          // Ambiguous: do NOT retry (duplicate risk). A human reads it back.
          const why = after.instanceCount !== before.instanceCount + 1
            ? `instance count went ${before.instanceCount}→${after.instanceCount} (expected +1)`
            : !added ? 'could not find the new instance with our date and comment on read-back'
              : 'a pre-existing instance changed during the save';
          finish(row, 'held', `save not confirmed: ${why} — left for review, not retried`);
          summary.warnings.push(`girl ${row.girl_id}: ${why}`);
        }
      }
    } finally {
      await session.close();
    }
    return summary;
  });
}

// ======================================================================
// Requirement marks with notes (the `mark` queue rows ahgpull's reconcile
// creates for "confirmed here, not on AHGFamily"). Same vehicle as the star
// push — the full Standard-view save — with the requirement's own three
// fields set: `checkbox-<reqId>` (checked), `date-<reqId>`, and
// `comment-<reqId>` = the note from lib/reqnote (attended dates + plan
// notes + the leader's verification). Everything else on the form is
// echoed byte-for-byte. Gated by ITS OWN flag on top of push_enabled,
// because the per-requirement save has not yet been watched live
// (docs/step5b-requirement-write-verification.md).
const REQ_SETTING = 'push_requirements_enabled';
const pushRequirementsEnabled = (db) => getSetting(db, REQ_SETTING) === true;
const setPushRequirementsEnabled = (db, on, actor) => { setSetting(db, REQ_SETTING, !!on, actor); return !!on; };

// Browser-faithful pairs for a whole fragment, with `check` names forced
// on (contributing the input's own value, or "on") and `set` overrides.
function fragmentPairs(html, { check = [], set = {} } = {}) {
  const pairs = [];
  const re = /<(input|textarea|select)\b([^>]*)>(?:([\s\S]*?)<\/\1\s*>)?/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = Object.fromEntries([...m[2].matchAll(/([a-zA-Z_:-]+)(?:="([^"]*)")?/g)].map((x) => [x[1], x[2] === undefined ? '' : A.decodeHtml(x[2])]));
    const name = (attrs.name || '').trim();
    if (!name || 'disabled' in attrs) continue;
    const tag = m[1].toLowerCase();
    const type = (attrs.type || 'text').toLowerCase();
    if (tag === 'input') {
      if (['submit', 'button', 'file', 'image', 'reset'].includes(type)) continue;
      if (type === 'checkbox' || type === 'radio') {
        if (!('checked' in attrs) && !check.includes(name)) continue;
        pairs.push([name, attrs.value === undefined ? 'on' : attrs.value]);
      } else {
        pairs.push([name, attrs.value === undefined ? '' : attrs.value]);
      }
    } else if (tag === 'textarea') {
      pairs.push([name, A.decodeHtml(m[3] || '')]);
    } else {
      const opts = [...(m[3] || '').matchAll(/<option\b([^>]*)>/gi)]
        .map((o) => Object.fromEntries([...o[1].matchAll(/([a-zA-Z_:-]+)(?:="([^"]*)")?/g)].map((x) => [x[1], x[2] === undefined ? '' : A.decodeHtml(x[2])])));
      const sel = opts.filter((o) => 'selected' in o);
      const chosen = sel.length ? sel : (('multiple' in attrs) || !opts.length ? [] : [opts[0]]);
      for (const o of chosen) pairs.push([name, o.value || '']);
    }
  }
  for (const [name, value] of Object.entries(set)) {
    const i = pairs.findIndex(([n]) => n === name);
    if (i >= 0) pairs[i] = [name, value]; else pairs.push([name, value]);
  }
  return pairs;
}

const itemSig = (state, except = null) => Object.entries(state.items)
  .filter(([id]) => id !== except).map(([id, it]) => [id, !!it.checked, it.date || null, it.comment || null])
  .sort((a, b) => (a[0] < b[0] ? -1 : 1));

async function pushRequirementMarks(db, cfg, { sessionFactory = ahgpull.makeLiveSession, key = null, env = process.env, actor = 'system', limit = 50 } = {}) {
  if (!pushEnabled(db)) return { skipped: 'push disabled', pushed: 0, held: 0, failed: 0, skippedRows: 0 };
  if (!pushRequirementsEnabled(db)) return { skipped: 'requirement push disabled', pushed: 0, held: 0, failed: 0, skippedRows: 0 };
  const latch = mapping.getLatch(db);
  if (latch) throw new PullError('latched', `AHGFamily is latched since ${latch.latchedAt} (${latch.error}) — re-enter credentials to clear`);
  if (!mapping.hasStoredCredentials(db, key)) throw new PullError('noconfig', 'no AHGFamily credentials — enter them via the admin screen');
  const { requirementNote } = require('./reqnote');

  const rows = db.prepare(`SELECT q.*, r.ahg_requirement_id, r.number, r.letter, b.ahg_award_id AS award_id, b.name AS badge_name
                           FROM push_queue q JOIN requirements r ON r.id = q.requirement_id JOIN badges b ON b.id = r.badge_id
                           WHERE q.action = 'mark' AND q.status = 'queued' ORDER BY q.girl_id, q.badge_id, q.id LIMIT ?`).all(limit);

  return recordRun(db, 'push', async () => {
    const summary = { action: 'mark', queued: rows.length, pushed: 0, held: 0, failed: 0, skippedRows: 0, items: [], warnings: [] };
    if (!rows.length) return summary;
    let session;
    try {
      session = await sessionFactory(db, { key, env });
    } catch (e) {
      if (e instanceof A.FetchError && e.code === A.EXIT.AUTH) {
        mapping.setLatch(db, e.message);
        throw new PullError('latched', `AHGFamily login failed — latched all AHGFamily traffic (${e.message})`);
      }
      throw e;
    }
    const runId = db.prepare('SELECT MAX(id) AS id FROM sync_runs').get().id;
    const finish = (row, status, lastError) => {
      db.prepare('UPDATE push_queue SET status = ?, attempts = attempts + 1, last_error = ?, sent_at = ?, sync_run_id = ? WHERE id = ?')
        .run(status, lastError || null, status === 'sent' ? now() : null, runId, row.id);
      db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(now(), actor, `push.mark.${status}`, 'push_queue', String(row.id), JSON.stringify({ status: 'queued' }),
          JSON.stringify({ status, girlId: row.girl_id, requirementId: row.requirement_id, error: lastError || null }));
      summary.items.push({ id: row.id, girlId: row.girl_id, requirementId: row.requirement_id, badge: row.badge_name, label: `${row.number}${row.letter || ''}`, status, error: lastError || null });
      summary[status === 'sent' ? 'pushed' : status === 'held' ? 'held' : status === 'skipped' ? 'skippedRows' : 'failed'] += 1;
    };

    try {
      for (const row of rows) {
        const girl = db.prepare('SELECT * FROM girls WHERE id = ?').get(row.girl_id);
        const completion = row.completion_id ? db.prepare('SELECT * FROM completions WHERE id = ?').get(row.completion_id) : null;
        if (!girl || !girl.active || !girl.ahg_youth_id) { finish(row, 'held', 'girl is not active / not mapped to AHGFamily'); continue; }
        if (!completion || completion.status !== 'confirmed') { finish(row, 'skipped', 'completion is no longer confirmed'); continue; }
        if (!row.award_id || !row.ahg_requirement_id) { finish(row, 'held', 'catalog row lacks an AHGFamily award or requirement id'); continue; }
        const formDate = toFormDate(row.date || completion.completed_on, cfg.tz);
        if (!formDate) { finish(row, 'held', `refusing to push an invalid or future completion date (${row.date || completion.completed_on})`); continue; }
        const note = requirementNote(db, completion, { tz: cfg.tz });
        const reqId = row.ahg_requirement_id;

        const beforeHtml = await session.standard(row.award_id, girl.ahg_youth_id);
        const before = parseStandardState(beforeHtml, { awardId: row.award_id });
        if (!(reqId in before.items)) { finish(row, 'held', 'requirement is not on the Standard form for this badge (catalog drift?) — check on AHGFamily'); continue; }
        if (before.items[reqId].checked) { finish(row, 'skipped', 'already complete on AHGFamily'); continue; }

        const pageHtml = await session.page('/advancement/index?level=all&style=standard');
        const outer = serializeForm(pageHtml).filter(([n]) => !/^(youth-select\[\]|badge-select)$/.test(n) && !/^(checkbox|date|comment|new|completed_on|awarded_on|purchased)-[a-z0-9]{12}$/.test(n));
        const body = [...outer, ['youth-select[]', girl.ahg_youth_id], ['badge-select', row.award_id],
          ...fragmentPairs(beforeHtml, { check: [`checkbox-${reqId}`], set: { [`date-${reqId}`]: formDate, [`comment-${reqId}`]: note } })];

        await session.save(body);
        const after = parseStandardState(await session.standard(row.award_id, girl.ahg_youth_id), { awardId: row.award_id });
        const it = after.items[reqId] || {};
        const mineOk = it.checked && (it.date || '') === formDate && (it.comment || '') === note;
        const othersOk = JSON.stringify(itemSig(before, reqId)) === JSON.stringify(itemSig(after, reqId))
          && JSON.stringify(savedSig(before)) === JSON.stringify(savedSig(after));
        if (mineOk && othersOk) {
          finish(row, 'sent', null);
          db.prepare(`INSERT INTO ahg_state (girl_id, requirement_id, completed, earned_on, comment, fetched_at) VALUES (?, ?, 1, ?, ?, ?)
                      ON CONFLICT(girl_id, requirement_id) DO UPDATE SET completed = 1, earned_on = excluded.earned_on, comment = excluded.comment, fetched_at = excluded.fetched_at`)
            .run(row.girl_id, row.requirement_id, completion.completed_on, note, now());
        } else {
          const why = !it.checked ? 'requirement did not read back as checked'
            : (it.date || '') !== formDate ? `date read back as "${it.date || ''}", sent "${formDate}"`
              : (it.comment || '') !== note ? 'note did not read back as sent (length limit on AHGFamily?)'
                : 'another requirement or instance changed during the save';
          finish(row, 'held', `save not confirmed: ${why} — left for review, not retried`);
          summary.warnings.push(`girl ${row.girl_id} ${row.badge_name} ${row.number}${row.letter || ''}: ${why}`);
        }
      }
    } finally {
      await session.close();
    }
    return summary;
  });
}

module.exports = {
  pushStarInstances, pushRequirementMarks, pushEnabled, setPushEnabled, pushRequirementsEnabled, setPushRequirementsEnabled,
  toFormDate, serializeForm, panelPairsWithStar, fragmentPairs,
};
