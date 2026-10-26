'use strict';
/**
 * Links on plans, and each badge's link library (migration 012).
 *
 * A plan carries links per badge — web pages, or SharePoint files the
 * planner picked or uploaded (the website talks to SharePoint itself with
 * the leader's own Microsoft sign-in; the tracker only stores the link).
 * Saving a plan files every link it carries under its badge, so the planner
 * can offer "previously used" links the next time anyone plans that badge.
 * The library outlives the plans; hiding a link only drops it from the
 * suggestions, and using it again brings it back.
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

/**
 * Check a plan PUT's `links` before anything is written. Each link is
 * { badgeId, url, title?, kind?, driveId?, itemId? } and must belong to a
 * badge that has a requirement on this plan's track (`badgeIds`).
 */
function validate(db, links, badgeIds) {
  if (!Array.isArray(links)) throw new LinkError(400, 'links must be an array of { badgeId, url, title? }');
  const seen = new Set();
  return links.map((l, idx) => {
    const where = `links[${idx}]`;
    if (!l || typeof l.badgeId !== 'string') throw new LinkError(400, `${where}: badgeId required`);
    if (!badgeIds.has(l.badgeId)) throw new LinkError(400, `${where}: no requirement of ${l.badgeId} is on this plan — add one before attaching links`);
    const url = cleanUrl(l.url, where);
    const k = `${l.badgeId}\n${url}`;
    if (seen.has(k)) throw new LinkError(400, `${where}: ${url} appears twice for ${l.badgeId}`);
    seen.add(k);
    const kind = l.kind === undefined ? 'web' : l.kind;
    if (!KINDS.includes(kind)) throw new LinkError(400, `${where}: kind must be ${KINDS.join('|')}`);
    return {
      badgeId: l.badgeId, url, kind, position: idx,
      title: short(l.title, MAX_TITLE) || defaultTitle(url),
      driveId: kind === 'sharepoint' ? short(l.driveId, 200) : null,
      itemId: kind === 'sharepoint' ? short(l.itemId, 200) : null,
    };
  });
}

// File a link under its badge (or refresh the one already there): the
// latest title wins, and using a hidden link un-hides it.
function upsertLibrary(db, l, actor, now) {
  db.prepare(`INSERT INTO badge_links (badge_id, url, title, kind, drive_id, item_id, created_by, created_at, last_used_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(badge_id, url) DO UPDATE SET title = excluded.title, kind = excluded.kind,
                drive_id = COALESCE(excluded.drive_id, drive_id), item_id = COALESCE(excluded.item_id, item_id),
                hidden = 0, last_used_at = excluded.last_used_at`)
    .run(l.badgeId, l.url, l.title, l.kind, l.driveId, l.itemId, actor, now, now);
  return db.prepare('SELECT id FROM badge_links WHERE badge_id = ? AND url = ?').get(l.badgeId, l.url).id;
}

/**
 * Replace this track's links on a plan. `links` undefined keeps them (a
 * page that doesn't know about links can still save), less any whose badge
 * no longer has a requirement on the plan.
 */
function replacePlanLinks(db, planId, track, links, badgeIds, actor, now) {
  if (links === undefined) {
    for (const row of db.prepare(`SELECT pl.id, bl.badge_id FROM plan_links pl JOIN badge_links bl ON bl.id = pl.link_id
                                  WHERE pl.plan_id = ? AND pl.track = ?`).all(planId, track)) {
      if (!badgeIds.has(row.badge_id)) db.prepare('DELETE FROM plan_links WHERE id = ?').run(row.id);
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
  id: r.id, badgeId: r.badge_id, url: r.url, title: r.title, kind: r.kind,
  driveId: r.drive_id || null, itemId: r.item_id || null,
});

/** One plan's links on one track, in order. */
function planLinks(db, planId, track) {
  return db.prepare(`SELECT bl.* FROM plan_links pl JOIN badge_links bl ON bl.id = pl.link_id
                     WHERE pl.plan_id = ? AND pl.track = ? ORDER BY pl.position`).all(planId, track).map(linkOut);
}

/**
 * A badge's link library, most recently used first, each with the meetings
 * that used it. Hidden links only with `all`.
 */
function badgeLibrary(db, badgeId, { all = false } = {}) {
  const rows = db.prepare(`SELECT * FROM badge_links WHERE badge_id = ? ${all ? '' : 'AND hidden = 0'}
                           ORDER BY last_used_at DESC, id DESC`).all(badgeId);
  const uses = db.prepare(`SELECT e.id AS event_id, e.title, e.start_at, p.level_group FROM plan_links pl
                           JOIN plans p ON p.id = pl.plan_id JOIN events e ON e.id = p.event_id
                           WHERE pl.link_id = ? ORDER BY e.start_at DESC`);
  return rows.map((r) => ({
    ...linkOut(r),
    hidden: !!r.hidden, createdBy: r.created_by, createdAt: r.created_at, lastUsedAt: r.last_used_at,
    uses: uses.all(r.id).map((u) => ({ eventId: u.event_id, title: u.title, date: u.start_at, unit: u.level_group })),
  }));
}

/** Hide a link from the suggestions (or bring it back). */
function setHidden(db, badgeId, linkId, hidden, actor) {
  const row = db.prepare('SELECT * FROM badge_links WHERE id = ? AND badge_id = ?').get(linkId, badgeId);
  if (!row) throw new LinkError(404, 'link not found');
  db.prepare('UPDATE badge_links SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, linkId);
  db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), actor, hidden ? 'link.hide' : 'link.unhide', 'badge_link', String(linkId),
      JSON.stringify({ badgeId, url: row.url, title: row.title }), null);
  return { ...linkOut(row), hidden: !!hidden };
}

module.exports = { LinkError, validate, replacePlanLinks, planLinks, badgeLibrary, setHidden };
