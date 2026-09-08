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
 */

// The units that plan badgework. Pathfinders do no badge work, and the
// catalog's own grouping ("All", "Pioneer", "Patriot") maps onto the three
// unit plans below.
const PLAN_LEVEL_GROUPS = ['Tenderheart', 'Explorer', 'Pioneer/Patriot'];
const ROLES = ['session', 'start', 'continue', 'finish'];

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

const itemRows = (db, planId) => db.prepare(`
  SELECT pi.id, pi.requirement_id, pi.role, pi.position, pi.notes,
         r.number, r.letter, r.title, r.text, r.sub_items, r.badge_id, b.name AS badge_name, b.level_group AS badge_level_group
  FROM plan_items pi JOIN requirements r ON r.id = pi.requirement_id JOIN badges b ON b.id = r.badge_id
  WHERE pi.plan_id = ? ORDER BY pi.position`).all(planId);

const planOut = (db, p) => ({
  id: p.id,
  levelGroup: p.level_group,
  createdBy: p.created_by,
  createdAt: p.created_at,
  notes: p.notes,
  items: itemRows(db, p.id).map((i) => ({
    id: i.id,
    requirementId: i.requirement_id,
    badgeId: i.badge_id,
    badgeName: i.badge_name,
    badgeLevelGroup: i.badge_level_group,
    number: i.number,
    letter: i.letter,
    title: i.title,
    text: i.text,
    subItems: JSON.parse(i.sub_items || '[]'),
    role: i.role,
    position: i.position,
    notes: i.notes,
  })),
});

/** Every plan for one event, items included, in level-group order. */
function getPlans(db, eventId) {
  return db.prepare('SELECT * FROM plans WHERE event_id = ? ORDER BY level_group').all(eventId)
    .map((p) => planOut(db, p));
}

/**
 * Replace one event's plan for one level group. body = { notes?, items:
 * [{ requirementId, role, notes? }] } — order is the position. An empty
 * plan (no items, no notes) is deleted. Returns the stored plan, or
 * { deleted: true }.
 */
function putPlan(db, event, levelGroup, body, actor) {
  if (!PLAN_LEVEL_GROUPS.includes(levelGroup)) {
    throw new PlanError(400, `levelGroup must be one of ${PLAN_LEVEL_GROUPS.join(' | ')}`);
  }
  const items = (body || {}).items;
  const notes = typeof (body || {}).notes === 'string' && body.notes.trim() ? body.notes.trim() : null;
  if (!Array.isArray(items)) throw new PlanError(400, 'body must be { items: [{ requirementId, role, notes? }, …], notes? }');

  // validate every item before touching the database
  const seen = new Set();
  const resolved = items.map((it, idx) => {
    const where = `items[${idx}]`;
    if (!it || typeof it.requirementId !== 'string') throw new PlanError(400, `${where}: requirementId required`);
    if (!ROLES.includes(it.role)) throw new PlanError(400, `${where}: role must be ${ROLES.join('|')}`);
    if (seen.has(it.requirementId)) throw new PlanError(400, `${where}: ${it.requirementId} appears twice`);
    seen.add(it.requirementId);
    const r = db.prepare(`SELECT r.id, r.active, b.active AS badge_active, b.level_group FROM requirements r
                          JOIN badges b ON b.id = r.badge_id WHERE r.id = ?`).get(it.requirementId);
    if (!r) throw new PlanError(400, `${where}: unknown requirement ${it.requirementId}`);
    if (!r.active || !r.badge_active) throw new PlanError(400, `${where}: ${it.requirementId} is no longer in the catalog`);
    if (!badgeAllowedInPlan(r.level_group, levelGroup)) {
      throw new PlanError(400, `${where}: ${it.requirementId} belongs to a ${r.level_group} badge — not plannable for ${levelGroup}`);
    }
    return { requirementId: it.requirementId, role: it.role, notes: typeof it.notes === 'string' && it.notes.trim() ? it.notes.trim() : null, position: idx };
  });

  const now = new Date().toISOString();
  const write = db.transaction(() => {
    let plan = db.prepare('SELECT * FROM plans WHERE event_id = ? AND level_group = ?').get(event.id, levelGroup);
    const before = plan ? { notes: plan.notes, items: itemRows(db, plan.id).map((i) => ({ requirementId: i.requirement_id, role: i.role })) } : null;

    if (!resolved.length && !notes) {
      if (plan) {
        // deleting the plan cascades its items; an item with completions is
        // protected by the FK and surfaces as a conflict below
        deleteRemovedItems(db, plan.id, new Set());
        db.prepare('DELETE FROM plans WHERE id = ?').run(plan.id);
        audit(db, actor, event, levelGroup, before, null, now);
      }
      return { deleted: true };
    }

    if (!plan) {
      const r = db.prepare('INSERT INTO plans (event_id, level_group, created_by, created_at, notes) VALUES (?, ?, ?, ?, ?)')
        .run(event.id, levelGroup, actor, now, notes);
      plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(r.lastInsertRowid);
    } else {
      db.prepare('UPDATE plans SET notes = ? WHERE id = ?').run(notes, plan.id);
    }

    deleteRemovedItems(db, plan.id, seen);
    for (const it of resolved) {
      const existing = db.prepare('SELECT id FROM plan_items WHERE plan_id = ? AND requirement_id = ?').get(plan.id, it.requirementId);
      if (existing) {
        db.prepare('UPDATE plan_items SET role = ?, position = ?, notes = ? WHERE id = ?').run(it.role, it.position, it.notes, existing.id);
      } else {
        db.prepare('INSERT INTO plan_items (plan_id, requirement_id, role, position, notes) VALUES (?, ?, ?, ?, ?)')
          .run(plan.id, it.requirementId, it.role, it.position, it.notes);
      }
    }
    audit(db, actor, event, levelGroup, before, { notes, items: resolved.map((i) => ({ requirementId: i.requirementId, role: i.role })) }, now);
    return planOut(db, db.prepare('SELECT * FROM plans WHERE id = ?').get(plan.id));
  });
  return write();
}

// Remove plan items not in `keep`. A completion resting on one is a 409 —
// the leader decides/removes the completion first. Participation-only
// items cascade away silently (the session no longer counts toward the
// requirement because it is no longer planned).
function deleteRemovedItems(db, planId, keep) {
  const current = db.prepare('SELECT id, requirement_id FROM plan_items WHERE plan_id = ?').all(planId);
  for (const row of current) {
    if (keep.has(row.requirement_id)) continue;
    const c = db.prepare("SELECT COUNT(*) AS n FROM completions WHERE plan_item_id = ? AND status <> 'rejected'").get(row.id);
    if (c.n) throw new PlanError(409, `${row.requirement_id} has ${c.n} completion(s) resting on this plan — decide or remove them first`);
    // rejected completions keep their history but let go of the plan item
    db.prepare("UPDATE completions SET plan_item_id = NULL WHERE plan_item_id = ? AND status = 'rejected'").run(row.id);
    db.prepare('DELETE FROM plan_items WHERE id = ?').run(row.id); // participation cascades
  }
}

function audit(db, actor, event, levelGroup, before, after, at) {
  db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(at, actor, after ? 'plan.put' : 'plan.delete', 'plan', `${event.id}:${levelGroup}`,
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
function yearOverview(db, { from, to }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    throw new PlanError(400, 'from and to must be YYYY-MM-DD');
  }
  const rows = db.prepare(`
    SELECT pl.level_group AS unit, pi.requirement_id, pi.role, e.start_at, e.end_at,
           r.group_id, r.badge_id
    FROM plan_items pi
    JOIN plans pl ON pl.id = pi.plan_id
    JOIN events e ON e.id = pl.event_id
    JOIN requirements r ON r.id = pi.requirement_id
    WHERE e.start_at >= ? AND e.start_at <= ?`).all(from, `${to}T￿`);
  const nowIso = new Date().toISOString();
  const units = new Map(); // unit → badgeId → groupId → reqId → state
  for (const row of rows) {
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
      list.push({ badgeId, name: b.name, levelGroup: b.level_group, frontier: b.frontier, needed, planned, done, startedOnly });
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    out.push({ unit, badges: list });
  }
  out.sort((a, b) => PLAN_LEVEL_GROUPS.indexOf(a.unit) - PLAN_LEVEL_GROUPS.indexOf(b.unit));
  return { from, to, units: out };
}


/**
 * One badge's plan for the year, for the dashboard's drill-down modal:
 * every plan item on this unit's events in [from, to], per requirement,
 * plus what still needs planning — required (all-group) gaps first, then
 * n_of groups only while their threshold isn't met by planned items.
 */
function yearBadgeDetail(db, { badgeId, unit, from, to }) {
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
    WHERE pl.level_group = ? AND r.badge_id = ? AND e.start_at >= ? AND e.start_at <= ?
    ORDER BY e.start_at`).all(unit, badgeId, from, `${to}T` + String.fromCharCode(0xffff));
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

module.exports = { PLAN_LEVEL_GROUPS, ROLES, badgeAllowedInPlan, PlanError, getPlans, putPlan, yearOverview, yearBadgeDetail };
