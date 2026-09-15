'use strict';
/**
 * Duplicate girl records, repaired from the website admin.
 *
 * How they happen: a girl is added to the check-in app without a member
 * number (a visitor or a hand entry), gets mapped to AHGFamily here, and is
 * later merged in the check-in app into her registered record. The check-in
 * roster feed leaves merged people out, so the mirror deactivates the old
 * girl and creates a new one for the registered person. The AHGFamily id and
 * any history stay on the inactive record, and mapping the new record fails
 * with "already mapped to another girl". A girl deleted in the check-in app
 * leaves the same kind of inactive record behind.
 *
 *   duplicateView  inactive, unmerged records that still hold an AHGFamily
 *                  id or data, each with same-name active girls as candidates
 *   mergeGirls     moves the id and every per-girl row to an active girl
 *   releaseYouthId frees the id on an old record with nowhere to go
 *
 * Both writes are admin-only, atomic and audited. The merged-away record is
 * kept (status 'merged', merged_into_girl_id) so history stays traceable.
 */
const { normName } = require('./mapping');

// Every table that holds per-girl rows. `key`: the columns that must stay
// unique together with girl_id. On a collision the ACTIVE girl's row wins
// and the old copy is dropped — these are mirrors of attendance, AHGFamily
// and service data, re-derived by the next sync anyway. Completions and star
// proposals are leader decisions: a live collision refuses the merge instead
// (checked below), so nothing a leader decided is ever silently dropped.
const TABLES = [
  { name: 'completions' },
  { name: 'star_proposals' },
  { name: 'push_queue' },
  { name: 'conflicts' },
  { name: 'attendance', key: true },
  { name: 'participation', key: true },
  { name: 'ahg_state', key: true },
  { name: 'star_baseline', key: true },
  { name: 'service_hours', key: true },
  { name: 'award_instances', key: true },
];

class MergeError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const fullName = (g) => `${g.first_name} ${g.last_name}`;
const nameKeys = (g) => [...new Set([
  normName(`${g.first_name} ${g.last_name}`),
  ...(g.nickname ? [normName(`${g.nickname} ${g.last_name}`)] : []),
])];

/** Non-zero row counts per table for one girl, e.g. { ahg_state: 11 }. */
function dataCounts(db, girlId) {
  const out = {};
  for (const t of TABLES) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t.name} WHERE girl_id = ?`).get(girlId).n;
    if (n) out[t.name] = n;
  }
  return out;
}

// Copies of AHGFamily data keyed to the girl's AHGFamily id. On an old
// record whose id is gone (released, or never mapped) they are stale and
// re-pulled for whoever holds the id now, so on their own they don't keep
// the record on the admin list. A merge still moves them.
const AHG_MIRRORS = new Set(['ahg_state', 'service_hours', 'award_instances', 'star_baseline']);

/**
 * Old records worth a leader's attention, with likely current records:
 * inactive, unmerged, and holding an AHGFamily id or tracker history
 * (completions, attendance, proposals, queue rows, conflicts).
 */
function duplicateView(db) {
  const active = db.prepare('SELECT * FROM girls WHERE active = 1').all();
  const byName = new Map();
  for (const g of active) {
    for (const k of nameKeys(g)) {
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(g);
    }
  }
  return db.prepare('SELECT * FROM girls WHERE active = 0 AND merged_into_girl_id IS NULL ORDER BY last_name, first_name').all()
    .map((g) => ({ g, data: dataCounts(db, g.id) }))
    .filter(({ g, data }) => g.ahg_youth_id || Object.keys(data).some((t) => !AHG_MIRRORS.has(t)))
    .map(({ g, data }) => {
      const seen = new Set();
      const candidates = nameKeys(g).flatMap((k) => byName.get(k) || [])
        .filter((c) => (seen.has(c.id) ? false : seen.add(c.id)))
        .sort((a, b) => Number(Boolean(a.ahg_youth_id)) - Number(Boolean(b.ahg_youth_id))) // unmapped first
        .map((c) => ({ id: c.id, firstName: c.first_name, lastName: c.last_name, ahgLevel: c.ahg_level, mapped: Boolean(c.ahg_youth_id) }));
      return {
        id: g.id, firstName: g.first_name, lastName: g.last_name, nickname: g.nickname, ahgLevel: g.ahg_level,
        status: g.status, ahgYouthId: g.ahg_youth_id, data, candidates,
      };
    });
}

function audit(db, actor, action, girlId, before, after) {
  db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), actor, action, 'girl', String(girlId), JSON.stringify(before), JSON.stringify(after));
}

/**
 * Merge an inactive (old) record into an active girl. Refuses — changing
 * nothing — when the old record is still active or already merged, the
 * target isn't active, both carry different AHGFamily ids, or both hold a
 * live decision for the same requirement or service star.
 */
function mergeGirls(db, { fromGirlId, intoGirlId } = {}, actor = null) {
  const fromId = Number(fromGirlId);
  const intoId = Number(intoGirlId);
  if (!Number.isInteger(fromId) || !Number.isInteger(intoId) || fromId <= 0 || intoId <= 0) {
    throw new MergeError(400, 'fromGirlId and intoGirlId are required');
  }
  if (fromId === intoId) throw new MergeError(400, 'a record cannot be merged into itself');
  const run = db.transaction(() => {
    const from = db.prepare('SELECT * FROM girls WHERE id = ?').get(fromId);
    const into = db.prepare('SELECT * FROM girls WHERE id = ?').get(intoId);
    if (!from || !into) throw new MergeError(404, 'girl not found');
    if (from.active) throw new MergeError(409, `${fullName(from)} is still active on the roster — only an old, inactive record can be merged away`);
    if (from.merged_into_girl_id) throw new MergeError(409, `the old record for ${fullName(from)} was already merged`);
    if (!into.active) throw new MergeError(409, `${fullName(into)} isn't active — merge into the girl's current record`);
    if (from.ahg_youth_id && into.ahg_youth_id && from.ahg_youth_id !== into.ahg_youth_id) {
      throw new MergeError(409, 'the two records are mapped to different AHGFamily members — check which is right, then release the wrong one first');
    }
    const completionClash = db.prepare(`
      SELECT COUNT(*) AS n FROM completions a JOIN completions b ON b.requirement_id = a.requirement_id
      WHERE a.girl_id = ? AND b.girl_id = ? AND a.status <> 'rejected' AND b.status <> 'rejected'`).get(fromId, intoId).n;
    const starClash = db.prepare(`
      SELECT COUNT(*) AS n FROM star_proposals a JOIN star_proposals b ON b.level = a.level AND b.ordinal = a.ordinal
      WHERE a.girl_id = ? AND b.girl_id = ?
        AND a.status IN ('proposed', 'confirmed', 'recorded') AND b.status IN ('proposed', 'confirmed', 'recorded')`).get(fromId, intoId).n;
    if (completionClash || starClash) {
      const parts = [];
      if (completionClash) parts.push(`${completionClash} requirement completion${completionClash === 1 ? "" : "s"}`);
      if (starClash) parts.push(`${starClash} service star${starClash === 1 ? "" : "s"}`);
      throw new MergeError(409, `both records hold a decision for the same item (${parts.join(' and ')}) — remove the duplicate from one of them first`);
    }

    const before = {
      from: { id: fromId, ahgYouthId: from.ahg_youth_id, status: from.status, data: dataCounts(db, fromId) },
      into: { id: intoId, ahgYouthId: into.ahg_youth_id },
    };
    const moved = {};
    const dropped = {};
    for (const t of TABLES) {
      const m = db.prepare(`UPDATE ${t.key ? 'OR IGNORE ' : ''}${t.name} SET girl_id = ? WHERE girl_id = ?`).run(intoId, fromId).changes;
      if (m) moved[t.name] = m;
      if (t.key) {
        const d = db.prepare(`DELETE FROM ${t.name} WHERE girl_id = ?`).run(fromId).changes; // the active girl already had these
        if (d) dropped[t.name] = d;
      }
    }
    const ts = new Date().toISOString();
    let youthIdMoved = null;
    if (from.ahg_youth_id) {
      db.prepare('UPDATE girls SET ahg_youth_id = NULL WHERE id = ?').run(fromId); // the column is UNIQUE
      if (!into.ahg_youth_id) {
        db.prepare('UPDATE girls SET ahg_youth_id = ?, ahg_youth_id_source = ?, updated_at = ? WHERE id = ?')
          .run(from.ahg_youth_id, from.ahg_youth_id_source || 'mapped', ts, intoId);
        youthIdMoved = from.ahg_youth_id;
      }
    }
    db.prepare("UPDATE girls SET active = 0, status = 'merged', merged_into_girl_id = ?, updated_at = ? WHERE id = ?").run(intoId, ts, fromId);
    const result = { fromGirlId: fromId, intoGirlId: intoId, youthIdMoved, moved, dropped };
    audit(db, actor, 'girl.merge', fromId, before, result);
    return result;
  });
  return run();
}

/** Free the AHGFamily id held by an old, inactive record. */
function releaseYouthId(db, girlId, actor = null) {
  const id = Number(girlId);
  const run = db.transaction(() => {
    const g = db.prepare('SELECT * FROM girls WHERE id = ?').get(id);
    if (!g) throw new MergeError(404, 'girl not found');
    if (g.active) throw new MergeError(409, `${fullName(g)} is active — only an old, inactive record's AHGFamily id can be released here`);
    if (!g.ahg_youth_id) throw new MergeError(409, `the old record for ${fullName(g)} holds no AHGFamily id`);
    db.prepare('UPDATE girls SET ahg_youth_id = NULL, ahg_youth_id_source = NULL, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    const result = { girlId: id, released: g.ahg_youth_id };
    audit(db, actor, 'girl.release_youth_id', id, { ahgYouthId: g.ahg_youth_id, source: g.ahg_youth_id_source }, result);
    return result;
  });
  return run();
}

module.exports = { TABLES, MergeError, dataCounts, duplicateView, mergeGirls, releaseYouthId };
