'use strict';
/**
 * Links on plans, and the link library (migration 012).
 *
 * A plan carries links, each for one thing on it: a badge (the Planning
 * page's badges; the Faith tab's faith badges and Faith Award studies) or a
 * standalone Bible study (Faith tab). Links are web pages or SharePoint
 * files the planner picked or uploaded — the website talks to SharePoint
 * itself with the leader's own Microsoft sign-in; the tracker only stores
 * the link. Saving a plan files every link it carries under its badge or
 * study, so the planner can offer "previously used" links the next time
 * anyone plans it. The library outlives the plans; hiding a link only drops
 * it from the suggestions, and using it again brings it back.
 *
 * An owner is { badgeId } or { studyId } — exactly one.
 */

class LinkError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const MAX_URL = 2048;
const MAX_TITLE = 200;
const KINDS = ['web', 'sharepoint'];

const short = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// http(s) only — a javascript: or data: "link" on a shared page is an attack
function cleanUrl(v, where) {
  const s = short(v, MAX_URL + 1);
  if (!s) throw new LinkError(400, `${where}: url required`);
  if (s.length > MAX_URL) throw new LinkError(400, `${where}: url is longer than ${MAX_URL} characters`);
  let u;
  try { u = new URL(s); } catch { throw new LinkError(400, `${where}: "${s}" is not a web address`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new LinkError(400, `${where}: only http and https links can be saved`);
  return u.href;
}

// a title for a link saved without one: the last path segment, else the host
function defaultTitle(href) {
  const u = new URL(href);
  const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
  return (seg || u.hostname).slice(0, MAX_TITLE);
}

// column + value for an owner
const ownerCol = (o) => (o.badgeId != null ? ['badge_id', o.badgeId] : ['study_id', o.studyId]);
const ownerKey = (o) => (o.badgeId != null ? `b:${o.badgeId}` : `s:${o.studyId}`);

/**
 * Check a plan PUT's `links` before anything is written. Each link is
 * { badgeId | studyId, url, title?, kind?, driveId?, itemId? } and must
 * belong to a badge with a requirement on this plan's track (`badgeIds`)
 * or a Bible study on it (`studyIds`, faith track).
 */
function validate(db, links, { badgeIds, studyIds = new Set() }) {
  if (!Array.isArray(links)) throw new LinkError(400, 'links must be an array of { badgeId | studyId, url, title? }');
  const seen = new Set();
  return links.map((l, idx) => {
    const where = `links[${idx}]`;
    if (!l || typeof l !== 'object') throw new LinkError(400, `${where}: badgeId or studyId required`);
    const hasBadge = typeof l.badgeId === 'string';
    const hasStudy = l.studyId !== undefined && l.studyId !== null;
    if (hasBadge === hasStudy) throw new LinkError(400, `${where}: give exactly one of badgeId or studyId`);
    const owner = hasBadge ? { badgeId: l.badgeId } : { studyId: Number(l.studyId) };
    if (hasBadge && !badgeIds.has(owner.badgeId)) throw new LinkError(400, `${where}: no requirement of ${owner.badgeId} is on this plan — add one before attaching links`);
    if (hasStudy && !studyIds.has(owner.studyId)) throw new LinkError(400, `${where}: Bible study ${l.studyId} is not on this plan — add it before attaching links`);
    const url = cleanUrl(l.url, where);
    const k = `${ownerKey(owner)}\n${url}`;
    if (seen.has(k)) throw new LinkError(400, `${where}: ${url} appears twice for the same ${hasBadge ? 'badge' : 'study'}`);
    seen.add(k);
    const kind = l.kind === undefined ? 'web' : l.kind;
    if (!KINDS.includes(kind)) throw new LinkError(400, `${where}: kind must be ${KINDS.join('|')}`);
    return {
      ...owner, url, kind, position: idx,
      title: short(l.title, MAX_TITLE) || defaultTitle(url),
      driveId: kind === 'sharepoint' ? short(l.driveId, 200) : null,
      itemId: kind === 'sharepoint' ? short(l.itemId, 200) : null,
    };
  });
}

// File a link with its owner (or refresh the one already there): the
// latest title wins, and using a hidden link un-hides it.
function upsertLibrary(db, l, actor, now) {
  const [col, val] = ownerCol(l);
  const row = db.prepare(`SELECT id FROM link_library WHERE ${col} = ? AND url = ?`).get(val, l.url);
  if (row) {
    db.prepare(`UPDATE link_library SET title = ?, kind = ?, drive_id = COALESCE(?, drive_id), item_id = COALESCE(?, item_id),
                hidden = 0, last_used_at = ? WHERE id = ?`).run(l.title, l.kind, l.driveId, l.itemId, now, row.id);
    return row.id;
  }
  return Number(db.prepare(`INSERT INTO link_library (${col}, url, title, kind, drive_id, item_id, created_by, created_at, last_used_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(val, l.url, l.title, l.kind, l.driveId, l.itemId, actor, now, now).lastInsertRowid);
}

/**
 * Replace this track's links on a plan. `links` undefined keeps them (a
 * page that doesn't know about links can still save), less any whose badge
 * or study is no longer on the plan.
 */
function replacePlanLinks(db, planId, track, links, { badgeIds, studyIds = new Set() }, actor, now) {
  if (links === undefined) {
    for (const row of db.prepare(`SELECT pl.id, ll.badge_id, ll.study_id FROM plan_links pl JOIN link_library ll ON ll.id = pl.link_id
                                  WHERE pl.plan_id = ? AND pl.track = ?`).all(planId, track)) {
      const kept = row.badge_id != null ? badgeIds.has(row.badge_id) : studyIds.has(row.study_id);
      if (!kept) db.prepare('DELETE FROM plan_links WHERE id = ?').run(row.id);
    }
    return;
  }
  db.prepare('DELETE FROM plan_links WHERE plan_id = ? AND track = ?').run(planId, track);
  for (const l of links) {
    const linkId = upsertLibrary(db, l, actor, now);
    db.prepare('INSERT INTO plan_links (plan_id, track, link_id, position) VALUES (?, ?, ?, ?)').run(planId, track, linkId, l.position);
  }
}

const linkOut = (r) => ({
  id: r.id,
  ...(r.badge_id != null ? { badgeId: r.badge_id } : { studyId: r.study_id }),
  url: r.url, title: r.title, kind: r.kind,
  driveId: r.drive_id || null, itemId: r.item_id || null,
});

/** One plan's links on one track, in order. */
function planLinks(db, planId, track) {
  return db.prepare(`SELECT ll.* FROM plan_links pl JOIN link_library ll ON ll.id = pl.link_id
                     WHERE pl.plan_id = ? AND pl.track = ? ORDER BY pl.position`).all(planId, track).map(linkOut);
}

/**
 * An owner's link library, most recently used first, each with the
 * meetings that used it. Hidden links only with `all`.
 */
function library(db, owner, { all = false } = {}) {
  const [col, val] = ownerCol(owner);
  const rows = db.prepare(`SELECT * FROM link_library WHERE ${col} = ? ${all ? '' : 'AND hidden = 0'}
                           ORDER BY last_used_at DESC, id DESC`).all(val);
  const uses = db.prepare(`SELECT e.id AS event_id, e.title, e.start_at, p.level_group, pl.track FROM plan_links pl
                           JOIN plans p ON p.id = pl.plan_id JOIN events e ON e.id = p.event_id
                           WHERE pl.link_id = ? ORDER BY e.start_at DESC`);
  return rows.map((r) => ({
    ...linkOut(r),
    hidden: !!r.hidden, createdBy: r.created_by, createdAt: r.created_at, lastUsedAt: r.last_used_at,
    uses: uses.all(r.id).map((u) => ({ eventId: u.event_id, title: u.title, date: u.start_at, unit: u.level_group, track: u.track })),
  }));
}

/** Hide a link from the suggestions (or bring it back). */
function setHidden(db, owner, linkId, hidden, actor) {
  const [col, val] = ownerCol(owner);
  const row = db.prepare(`SELECT * FROM link_library WHERE id = ? AND ${col} = ?`).get(linkId, val);
  if (!row) throw new LinkError(404, 'link not found');
  db.prepare('UPDATE link_library SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, linkId);
  db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), actor, hidden ? 'link.hide' : 'link.unhide', 'link', String(linkId),
      JSON.stringify({ ...owner, url: row.url, title: row.title }), null);
  return { ...linkOut(row), hidden: !!hidden };
}

module.exports = { LinkError, validate, replacePlanLinks, planLinks, library, setHidden };
