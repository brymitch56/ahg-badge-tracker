'use strict';
/**
 * Per-event, per-level-group plans (spec §4 "Planning", §6, build step 4).
 *
 * One plan per event per level group — a meeting where three units do
 * different badgework is three rows. plan_items carry the multi-session
 * role (decision: session|start|continue|finish); only `session` and
 * `finish` will propose completions in step 5, `start`/`continue` record
 * participation.
 *
 * A PUT replaces the plan's items but keeps the plan_item row (and its id)
 * for every requirement that stays, because participation and completions
 * reference plan_item_id. Removing an item that a completion already rests
 * on is refused (409) — decide or delete the completion first; removing an
 * item with only participation cascades the participation away.
 *
 * Two planners share each plan row: the badge planner (track 'badges') and
 * the Faith tab (track 'faith', migration 011). Each PUT replaces only its
 * own track's items and notes — the faith track also carries standalone
 * Bible studies (plan_studies) — and the row goes only when both are empty.
 *
 * Each track also carries links (migration 012, lib/links.js) — per badge,
 * and on the faith track per Bible study too; saving a plan files them in
 * the link library.
 */
const links = require('./links');

// The units that plan badgework. Pathfinders do no badge work, and the
// catalog's own grouping ("All", "Pioneer", "Patriot") maps onto the three
// unit plans below.
const PLAN_LEVEL_GROUPS = ['Tenderheart', 'Explorer', 'Pioneer/Patriot'];
const ROLES = ['session', 'start', 'continue', 'finish'];
const TRACKS = ['badges', 'faith'];

/** May a badge with this catalog level group appear in this unit's plan? */
function badgeAllowedInPlan(badgeLevelGroup, planLevelGroup) {
  if (badgeLevelGroup === 'All') return true;
  if (badgeLevelGroup === planLevelGroup) return true;
  if (planLevelGroup === 'Pioneer/Patriot') return badgeLevelGroup === 'Pioneer' || badgeLevelGroup === 'Patriot';
  return false;
}

class PlanError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const itemRows = (db, planId, track = 'badges') => db.prepare(`
  SELECT pi.id, pi.requirement_id, pi.role, pi.position, pi.notes,
         r.number, r.letter, r.title, r.text, r.sub_items, r.flags, r.badge_id, b.name AS badge_name, b.level_group AS badge_level_group, b.faith AS badge_faith
  FROM plan_items pi JOIN requirements r ON r.id = pi.requirement_id JOIN badges b ON b.id = r.badge_id
  WHERE pi.plan_id = ? AND pi.track = ? ORDER BY pi.position`).all(planId, track);

const studyRows = (db, planId) => db.prepare(`
  SELECT ps.id, ps.study_id, ps.lesson, ps.position, ps.notes, s.title, s.description, s.active
  FROM plan_studies ps JOIN faith_studies s ON s.id = ps.study_id
  WHERE ps.plan_id = ? ORDER BY ps.position`).all(planId);

const planOut = (db, p, track = 'badges') => {
  const out = {
    id: p.id,
    levelGroup: p.level_group,
    createdBy: p.created_by,
    createdAt: p.created_at,
    notes: track === 'faith' ? p.faith_notes : p.notes,
    items: itemRows(db, p.id, track).map((i) => ({
      id: i.id,
      requirementId: i.requirement_id,
      badgeId: i.badge_id,
      badgeName: i.badge_name,
      badgeLevelGroup: i.badge_level_group,
      ...(track === 'faith' ? { badgeFaith: i.badge_faith } : {}),
      number: i.number,
      letter: i.letter,
      title: i.title,
      text: i.text,
      subItems: JSON.parse(i.sub_items || '[]'),
      role: i.role,
      position: i.position,
      notes: i.notes,
    })),
    links: links.planLinks(db, p.id, track),
  };
  if (track === 'faith') {
    out.studies = studyRows(db, p.id).map((s) => ({
      id: s.id, studyId: s.study_id, title: s.title, description: s.description, studyActive: !!s.active,
      lesson: s.lesson, position: s.position, notes: s.notes,
    }));
  }
  return out;
};

// Does this plan row carry anything for a track? (A plan the faith planner
// made is not a badge plan, and vice versa.)
function hasTrack(db, p, track) {
  if (track === 'faith') {
    return !!p.faith_notes || !!db.prepare("SELECT 1 FROM plan_items WHERE plan_id = ? AND track = 'faith'").get(p.id)
      || !!db.prepare('SELECT 1 FROM plan_studies WHERE plan_id = ?').get(p.id);
  }
  return !!p.notes || !!db.prepare("SELECT 1 FROM plan_items WHERE plan_id = ? AND track = 'badges'").get(p.id);
}

/**
 * Planning history per requirement of one badge for one unit — what the
 * planner's picker shows beside each requirement so the leader can tell an
 * unplanned requirement from one already on the calendar. Nothing is hidden
 * (a repeat can be deliberate); the state just says where it stands:
 *   unplanned — no plan item for this unit
 *   started   — planned as start/continue only (no session/finish yet)
 *   planned   — a session or finish exists
 * `sessions` lists every planned meeting, in date order, with its role.
 */
function requirementPlanState(db, badgeId, levelGroup) {
  if (!PLAN_LEVEL_GROUPS.includes(levelGroup)) throw new PlanError(400, `unit must be one of ${PLAN_LEVEL_GROUPS.join(' | ')}`);
  const rows = db.prepare(`
    SELECT pi.requirement_id, pi.role, pi.notes, pi.track, e.id AS event_id, e.title, e.start_at, e.removed_from_feed
    FROM plan_items pi JOIN plans p ON p.id = pi.plan_id JOIN events e ON e.id = p.event_id
    JOIN requirements r ON r.id = pi.requirement_id
    WHERE r.badge_id = ? AND p.level_group = ? ORDER BY e.start_at, e.id`).all(badgeId, levelGroup);
  const out = {};
  for (const r of db.prepare('SELECT id FROM requirements WHERE badge_id = ? AND active = 1').all(badgeId)) out[r.id] = { state: 'unplanned', sessions: [] };
  for (const x of rows) {
    if (!out[x.requirement_id]) continue;
    out[x.requirement_id].sessions.push({ eventId: x.event_id, date: x.start_at, title: x.title, role: x.role, notes: x.notes || null, track: x.track, removedFromFeed: !!x.removed_from_feed });
  }
  for (const v of Object.values(out)) {
    if (!v.sessions.length) continue;
    v.state = v.sessions.some((s) => s.role === 'session' || s.role === 'finish') ? 'planned' : 'started';
  }
  return out;
}

/**
 * Every plan for one event that carries something for `track`, items
 * included, in level-group order. The faith track adds `studies`.
 */
function getPlans(db, eventId, { track = 'badges' } = {}) {
  return db.prepare('SELECT * FROM plans WHERE event_id = ? ORDER BY level_group').all(eventId)
    .filter((p) => hasTrack(db, p, track))
    .map((p) => planOut(db, p, track));
}

/** Unit names per event with something planned on `track` (the events list's pills). */
function trackLevelGroups(db, track) {
  const out = new Map();
  for (const p of db.prepare('SELECT * FROM plans').all()) {
    if (!hasTrack(db, p, track)) continue;
    const list = out.get(p.event_id) || out.set(p.event_id, []).get(p.event_id);
    list.push(p.level_group);
  }
  return out;
}

const cleanText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Replace one event's plan for one level group on one track. body =
 * { notes?, items: [{ requirementId, role, notes? }], links? } — order is the
 * position; links are lib/links.js's { badgeId | studyId, url, title?, kind? }. The faith track's items may instead be standalone studies,
 * { studyId, lesson?, notes? }, and only faith-tagged badges (the Faith
 * Award and faith badges) are plannable there. The other track's items and
 * notes are never touched; a requirement already on the other track of the
 * same plan is refused rather than moved. A plan left with nothing on
 * either track is deleted. Returns the stored plan (this track's view), or
 * { deleted: true } when this track is now empty.
 */
function putPlan(db, event, levelGroup, body, actor, { track = 'badges' } = {}) {
  if (!TRACKS.includes(track)) throw new PlanError(400, `track must be ${TRACKS.join('|')}`);
  if (!PLAN_LEVEL_GROUPS.includes(levelGroup)) {
    throw new PlanError(400, `levelGroup must be one of ${PLAN_LEVEL_GROUPS.join(' | ')}`);
  }
  const items = (body || {}).items;
  const notes = cleanText((body || {}).notes);
  if (!Array.isArray(items)) throw new PlanError(400, 'body must be { items: [{ requirementId, role, notes? }, …], notes? }');
  const faith = track === 'faith';
  const current = db.prepare('SELECT * FROM plans WHERE event_id = ? AND level_group = ?').get(event.id, levelGroup);

  // validate every item before touching the database
  const seen = new Set();
  const seenStudies = new Set();
  const resolved = [];
  const studies = [];
  items.forEach((it, idx) => {
    const where = `items[${idx}]`;
    if (faith && it && it.studyId !== undefined) {
      const sid = Number(it.studyId);
      const st = db.prepare('SELECT * FROM faith_studies WHERE id = ?').get(sid);
      if (!st) throw new PlanError(400, `${where}: unknown study ${it.studyId}`);
      if (seenStudies.has(sid)) throw new PlanError(400, `${where}: study ${sid} appears twice`);
      seenStudies.add(sid);
      const kept = current && db.prepare('SELECT 1 FROM plan_studies WHERE plan_id = ? AND study_id = ?').get(current.id, sid);
      if (!st.active && !kept) throw new PlanError(400, `${where}: "${st.title}" is retired`);
      const units = JSON.parse(st.units || '[]');
      if (units.length && !units.includes(levelGroup)) throw new PlanError(400, `${where}: "${st.title}" is not a ${levelGroup} study`);
      studies.push({ studyId: sid, lesson: cleanText(it.lesson), notes: cleanText(it.notes), position: idx });
      return;
    }
    if (!it || typeof it.requirementId !== 'string') throw new PlanError(400, `${where}: requirementId required`);
    if (!ROLES.includes(it.role)) throw new PlanError(400, `${where}: role must be ${ROLES.join('|')}`);
    if (seen.has(it.requirementId)) throw new PlanError(400, `${where}: ${it.requirementId} appears twice`);
    seen.add(it.requirementId);
    const r = db.prepare(`SELECT r.id, r.active, r.flags, r.badge_id, b.active AS badge_active, b.level_group, b.faith FROM requirements r
                          JOIN badges b ON b.id = r.badge_id WHERE r.id = ?`).get(it.requirementId);
    if (!r) throw new PlanError(400, `${where}: unknown requirement ${it.requirementId}`);
    if (!r.active || !r.badge_active) throw new PlanError(400, `${where}: ${it.requirementId} is no longer in the catalog`);
    if (!badgeAllowedInPlan(r.level_group, levelGroup)) {
      throw new PlanError(400, `${where}: ${it.requirementId} belongs to a ${r.level_group} badge — not plannable for ${levelGroup}`);
    }
    if (faith && !r.faith) throw new PlanError(400, `${where}: ${it.requirementId} is not a faith badge or Faith Award item — plan it on the Planning page`);
    const there = current && db.prepare('SELECT track FROM plan_items WHERE plan_id = ? AND requirement_id = ?').get(current.id, it.requirementId);
    if (there && there.track !== track) {
      throw new PlanError(409, `${where}: ${it.requirementId} is already on this meeting's ${there.track === 'faith' ? 'Faith' : 'badge'} plan — remove it there first`);
    }
    // a study AHGFamily has retired is never newly planned (one already on
    // this plan may stay, so an old plan still saves)
    if (JSON.parse(r.flags || '[]').includes('retired') && !there) throw new PlanError(400, `${where}: ${it.requirementId} is retired on AHGFamily`);
    resolved.push({ requirementId: it.requirementId, badgeId: r.badge_id, role: it.role, notes: cleanText(it.notes), position: idx });
  });
  if (!faith && studies.length) throw new PlanError(400, 'studies belong on the faith track');
  // links ride on the badges (and Bible studies) this track plans;
  // undefined = keep the saved ones
  const owners = { badgeIds: new Set(resolved.map((x) => x.badgeId)), studyIds: new Set(studies.map((x) => x.studyId)) };
  let linkList;
  try {
    linkList = (body || {}).links === undefined ? undefined : links.validate(db, body.links, owners);
  } catch (e) {
    if (e instanceof links.LinkError) throw new PlanError(e.status, e.message);
    throw e;
  }

  const now = new Date().toISOString();
  const notesCol = faith ? 'faith_notes' : 'notes';
  const write = db.transaction(() => {
    let plan = current;
    const snapshot = (p) => (p ? {
      notes: faith ? p.faith_notes : p.notes,
      items: itemRows(db, p.id, track).map((i) => ({ requirementId: i.requirement_id, role: i.role })),
      links: links.planLinks(db, p.id, track).map((l) => l.url),
      ...(faith ? { studies: studyRows(db, p.id).map((x) => ({ studyId: x.study_id, lesson: x.lesson })) } : {}),
    } : null);
    const before = snapshot(plan);
    const empty = !resolved.length && !studies.length && !notes;

    if (empty && !plan) return { deleted: true };
    if (!plan) {
      const r = db.prepare(`INSERT INTO plans (event_id, level_group, created_by, created_at, ${notesCol}) VALUES (?, ?, ?, ?, ?)`)
        .run(event.id, levelGroup, actor, now, notes);
      plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(r.lastInsertRowid);
    } else {
      db.prepare(`UPDATE plans SET ${notesCol} = ? WHERE id = ?`).run(notes, plan.id);
    }

    deleteRemovedItems(db, plan.id, seen, track);
    for (const it of resolved) {
      const existing = db.prepare('SELECT id FROM plan_items WHERE plan_id = ? AND requirement_id = ?').get(plan.id, it.requirementId);
      if (existing) {
        db.prepare('UPDATE plan_items SET role = ?, position = ?, notes = ? WHERE id = ?').run(it.role, it.position, it.notes, existing.id);
      } else {
        db.prepare('INSERT INTO plan_items (plan_id, requirement_id, role, position, notes, track) VALUES (?, ?, ?, ?, ?, ?)')
          .run(plan.id, it.requirementId, it.role, it.position, it.notes, track);
      }
    }
    links.replacePlanLinks(db, plan.id, track, linkList, owners, actor, now);
    if (faith) {
      db.prepare(`DELETE FROM plan_studies WHERE plan_id = ? AND study_id NOT IN (${studies.map(() => '?').join(',') || 'NULL'})`)
        .run(plan.id, ...studies.map((x) => x.studyId));
      for (const x of studies) {
        db.prepare(`INSERT INTO plan_studies (plan_id, study_id, lesson, position, notes) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(plan_id, study_id) DO UPDATE SET lesson = excluded.lesson, position = excluded.position, notes = excluded.notes`)
          .run(plan.id, x.studyId, x.lesson, x.position, x.notes);
      }
    }
    const fresh = db.prepare('SELECT * FROM plans WHERE id = ?').get(plan.id);
    const after = empty ? null : snapshot(fresh);
    audit(db, actor, event, levelGroup, before, after, now, track);
    if (!hasTrack(db, fresh, 'badges') && !hasTrack(db, fresh, 'faith')) {
      db.prepare('DELETE FROM plans WHERE id = ?').run(plan.id);
      return { deleted: true };
    }
    return empty ? { deleted: true } : planOut(db, fresh, track);
  });
  return write();
}

// Remove this track's plan items not in `keep`. A completion resting on one
// is a 409 — the leader decides/removes the completion first.
// Participation-only items cascade away silently (the session no longer
// counts toward the requirement because it is no longer planned).
function deleteRemovedItems(db, planId, keep, track = 'badges') {
  const current = db.prepare('SELECT id, requirement_id FROM plan_items WHERE plan_id = ? AND track = ?').all(planId, track);
  for (const row of current) {
    if (keep.has(row.requirement_id)) continue;
    const c = db.prepare("SELECT COUNT(*) AS n FROM completions WHERE plan_item_id = ? AND status <> 'rejected'").get(row.id);
    if (c.n) throw new PlanError(409, `${row.requirement_id} has ${c.n} completion(s) resting on this plan — decide or remove them first`);
    // rejected completions keep their history but let go of the plan item
    db.prepare("UPDATE completions SET plan_item_id = NULL WHERE plan_item_id = ? AND status = 'rejected'").run(row.id);
    db.prepare('DELETE FROM plan_items WHERE id = ?').run(row.id); // participation cascades
  }
}

function audit(db, actor, event, levelGroup, before, after, at, track = 'badges') {
  const kind = track === 'faith' ? 'plan.faith' : 'plan';
  db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(at, actor, after ? `${kind}.put` : `${kind}.delete`, 'plan', `${event.id}:${levelGroup}`,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}

/**
 * Program-year overview: per unit, every badge with plan items on events in
 * [from, to], with plan-based coverage numbers. A requirement is "planned"
 * when a completing item (role session|finish) is on the calendar, and
 * "done" when that item's event has passed — deliberately plan-based, not
 * completion-based (decision: the year bar tracks the schedule). "needed"
 * honors the badge's rules: every requirement of an `all` group, rule_n of
 * an `n_of` group — so planning 3 of a complete-three group fills its share.
 * start/continue-only requirements are counted separately (nothing
 * completes there yet).
 */
function yearOverview(db, { from: windowFrom, to, includeUnfinished = false, track = 'badges' }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(windowFrom || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    throw new PlanError(400, 'from and to must be YYYY-MM-DD');
  }
  // includeUnfinished: no lower bound, so plans from earlier years count too;
  // a badge with nothing inside [windowFrom, to] is then kept only while its
  // planned sessions aren't all held (started last year, still to continue)
  const from = includeUnfinished ? '0000-01-01' : windowFrom;
  const rows = db.prepare(`
    SELECT pl.level_group AS unit, pi.requirement_id, pi.role, e.start_at, e.end_at,
           r.group_id, r.badge_id
    FROM plan_items pi
    JOIN plans pl ON pl.id = pi.plan_id
    JOIN events e ON e.id = pl.event_id
    JOIN requirements r ON r.id = pi.requirement_id
    WHERE pi.track = ? AND e.start_at >= ? AND e.start_at <= ?`).all(track, from, `${to}T￿`);
  const nowIso = new Date().toISOString();
  const units = new Map(); // unit → badgeId → groupId → reqId → state
  // earliest planned meeting per unit + badge, any role — the website's
  // "first planned date" sort on the program-year view
  const firsts = new Map(); // `${unit}|${badgeId}` → start_at
  const inWindow = new Set(); // unit|badge with an item inside [windowFrom, to]
  for (const row of rows) {
    const fk = `${row.unit}|${row.badge_id}`;
    if (!firsts.has(fk) || row.start_at < firsts.get(fk)) firsts.set(fk, row.start_at);
    if (row.start_at >= windowFrom) inWindow.add(fk);
    const badges = units.get(row.unit) || units.set(row.unit, new Map()).get(row.unit);
    const groups = badges.get(row.badge_id) || badges.set(row.badge_id, new Map()).get(row.badge_id);
    const reqs = groups.get(row.group_id) || groups.set(row.group_id, new Map()).get(row.group_id);
    const st = reqs.get(row.requirement_id) || reqs.set(row.requirement_id, { completing: false, completingPast: false }).get(row.requirement_id);
    if (row.role === 'session' || row.role === 'finish') {
      st.completing = true;
      if ((row.end_at || row.start_at) <= nowIso) st.completingPast = true;
    }
  }
  const out = [];
  for (const [unit, badges] of units) {
    const list = [];
    for (const [badgeId, groups] of badges) {
      const b = db.prepare('SELECT id, name, level_group, frontier FROM badges WHERE id = ?').get(badgeId);
      let needed = 0; let planned = 0; let done = 0; let startedOnly = 0;
      for (const gr of db.prepare('SELECT * FROM badge_groups WHERE badge_id = ? ORDER BY position').all(badgeId)) {
        const activeCount = db.prepare('SELECT COUNT(*) AS n FROM requirements WHERE group_id = ? AND active = 1').get(gr.id).n;
        const need = gr.rule_type === 'n_of' ? Math.min(gr.rule_n || activeCount, activeCount) : activeCount;
        needed += need;
        let pl = 0; let dn = 0;
        for (const st of (groups.get(gr.id) || new Map()).values()) {
          if (st.completing) { pl += 1; if (st.completingPast) dn += 1; } else startedOnly += 1;
        }
        planned += Math.min(pl, need);
        done += Math.min(dn, need);
      }
      const key = `${unit}|${badgeId}`;
      const firstPlannedAt = firsts.get(key) || null;
      if (includeUnfinished && !inWindow.has(key) && done >= needed) continue; // an earlier year's badge, held in full
      list.push({
        badgeId, name: b.name, levelGroup: b.level_group, frontier: b.frontier, needed, planned, done, startedOnly,
        firstPlannedAt, carriedOver: !!firstPlannedAt && firstPlannedAt < windowFrom,
      });
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    if (list.length) out.push({ unit, badges: list });
  }
  out.sort((a, b) => PLAN_LEVEL_GROUPS.indexOf(a.unit) - PLAN_LEVEL_GROUPS.indexOf(b.unit));
  return { from: windowFrom, to, includeUnfinished: !!includeUnfinished, track, units: out };
}


/**
 * One badge's plan for the year, for the dashboard's drill-down modal:
 * every plan item on this unit's events in [from, to], per requirement,
 * plus what still needs planning — required (all-group) gaps first, then
 * n_of groups only while their threshold isn't met by planned items.
 */
function yearBadgeDetail(db, { badgeId, unit, from, to, track = 'badges' }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw new PlanError(400, 'from and to must be YYYY-MM-DD');
  if (!PLAN_LEVEL_GROUPS.includes(unit)) throw new PlanError(400, `unit must be one of ${PLAN_LEVEL_GROUPS.join(' | ')}`);
  const badge = db.prepare('SELECT id, name, level_group, frontier FROM badges WHERE id = ?').get(badgeId);
  if (!badge) throw new PlanError(404, 'unknown badge');
  const rows = db.prepare(`
    SELECT pi.requirement_id, pi.role, e.id AS event_id, e.title, e.start_at, e.end_at
    FROM plan_items pi
    JOIN plans pl ON pl.id = pi.plan_id
    JOIN events e ON e.id = pl.event_id
    JOIN requirements r ON r.id = pi.requirement_id
    WHERE pi.track = ? AND pl.level_group = ? AND r.badge_id = ? AND e.start_at >= ? AND e.start_at <= ?
    ORDER BY e.start_at`).all(track, unit, badgeId, from, `${to}T` + String.fromCharCode(0xffff));
  const nowIso = new Date().toISOString();
  const byReq = new Map();
  for (const row of rows) {
    const list = byReq.get(row.requirement_id) || byReq.set(row.requirement_id, []).get(row.requirement_id);
    list.push({ eventId: row.event_id, title: row.title, startAt: row.start_at, role: row.role, past: (row.end_at || row.start_at) <= nowIso });
  }
  const groups = db.prepare('SELECT * FROM badge_groups WHERE badge_id = ? ORDER BY position').all(badgeId).map((gr) => {
    const reqs = db.prepare('SELECT * FROM requirements WHERE group_id = ? AND active = 1 ORDER BY number, letter').all(gr.id).map((r) => {
      const sessions = byReq.get(r.id) || [];
      const planned = sessions.some((s) => s.role === 'session' || s.role === 'finish');
      return {
        requirementId: r.id,
        number: r.number,
        letter: r.letter,
        title: r.title,
        planned,
        done: sessions.some((s) => (s.role === 'session' || s.role === 'finish') && s.past),
        startedOnly: !planned && sessions.length > 0,
        sessions,
      };
    });
    const need = gr.rule_type === 'n_of' ? Math.min(gr.rule_n || reqs.length, reqs.length) : reqs.length;
    const plannedCount = reqs.filter((r) => r.planned).length;
    return {
      label: gr.label,
      ruleType: gr.rule_type,
      ruleN: gr.rule_n,
      need,
      plannedCount: Math.min(plannedCount, need),
      remaining: Math.max(0, need - plannedCount),
      requirements: reqs,
    };
  });
  return { badgeId: badge.id, name: badge.name, frontier: badge.frontier, levelGroup: badge.level_group, unit, from, to, groups };
}

/**
 * Move every plan on one event to another. A calendar entry that is
 * renamed or re-saved gets a NEW iCal identity, so the check-in app and
 * this mirror see a new event while the plans stay on the old row. Plan
 * items follow their plan; completions and participation pointing at the
 * old event follow too. A level group the target already plans is left
 * behind (reported in `skipped`) for a human to merge by hand.
 */
function movePlans(db, fromEvent, toEvent, actor) {
  if (!fromEvent || !toEvent) throw new PlanError(404, 'event not found');
  if (fromEvent.id === toEvent.id) throw new PlanError(400, 'source and target are the same event');
  const at = new Date().toISOString();
  const rows = db.prepare('SELECT * FROM plans WHERE event_id = ? ORDER BY level_group').all(fromEvent.id);
  const moved = [];
  const skipped = [];
  const run = db.transaction(() => {
    for (const plan of rows) {
      if (db.prepare('SELECT 1 FROM plans WHERE event_id = ? AND level_group = ?').get(toEvent.id, plan.level_group)) { skipped.push(plan.level_group); continue; }
      db.prepare('UPDATE plans SET event_id = ? WHERE id = ?').run(toEvent.id, plan.id);
      db.prepare('UPDATE completions SET event_id = ? WHERE event_id = ? AND plan_item_id IN (SELECT id FROM plan_items WHERE plan_id = ?)').run(toEvent.id, fromEvent.id, plan.id);
      db.prepare('UPDATE participation SET event_id = ? WHERE event_id = ? AND plan_item_id IN (SELECT id FROM plan_items WHERE plan_id = ?)').run(toEvent.id, fromEvent.id, plan.id);
      db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(at, actor, 'plan.move', 'plan', `${toEvent.id}:${plan.level_group}`,
          JSON.stringify({ eventId: fromEvent.id, title: fromEvent.title }), JSON.stringify({ eventId: toEvent.id, title: toEvent.title }));
      moved.push(plan.level_group);
    }
  });
  run();
  return { moved, skipped };
}

module.exports = { PLAN_LEVEL_GROUPS, ROLES, TRACKS, badgeAllowedInPlan, PlanError, getPlans, putPlan, movePlans, yearOverview, yearBadgeDetail, requirementPlanState, trackLevelGroups };
