'use strict';
/**
 * Proposals from attendance and progress derivation (spec §5 rules 1–5,
 * 4b, 9; build step 5).
 *
 * Rule 2 is the heart of it: attendance only ever creates `proposed` rows;
 * a leader confirms or rejects, and nothing rolls up (or, later, pushes)
 * until confirmed. Rule 4b: a girl counts as attended only when her
 * check-in row is closed (`open: 0`). Rule 5: a re-poll that un-attends a
 * girl withdraws her *proposed* rows and flags (never reverts) confirmed
 * ones. Rule 1: badge complete is derived from group rules, never set.
 */

// Which girls a unit plan applies to (plans.PLAN_LEVEL_GROUPS).
const PLAN_GIRL_LEVELS = {
  Tenderheart: ['Tenderheart'],
  Explorer: ['Explorer'],
  'Pioneer/Patriot': ['Pioneer', 'Patriot'],
};

class CompletionError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

/** The event's calendar date in the troop's zone (rule 3: "the event's local date"). */
const localDate = (iso, tz) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });

const now = () => new Date().toISOString();

const auditRow = (db, actor, action, entityId, before, after) => db.prepare(
  'INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)',
).run(now(), actor, action, 'completion', String(entityId), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);

// ------------------------------------------------------------- proposing --
/**
 * Apply rule 3 to one event, idempotently — safe to run on every attendance
 * re-poll and on the scheduled sweep. Also reconciles (rule 5): girls no
 * longer attended lose their proposed rows and participation; their
 * confirmed rows are flagged for review.
 */
function proposeForEvent(db, event, tz) {
  const date = localDate(event.start_at, tz);
  const attendance = db.prepare('SELECT * FROM attendance WHERE event_id = ?').all(event.id);
  const attended = new Set(attendance.filter((a) => !a.open).map((a) => a.girl_id));
  const txnsByGirl = new Map(attendance.map((a) => [a.girl_id, a.source_txn_ids]));
  const plansForEvent = db.prepare('SELECT * FROM plans WHERE event_id = ?').all(event.id);
  const summary = { eventId: event.id, proposed: 0, participation: 0, withdrawn: 0, flagged: 0 };

  const run = db.transaction(() => {
    for (const plan of plansForEvent) {
      const levels = PLAN_GIRL_LEVELS[plan.level_group] || [];
      const girls = db.prepare(`SELECT * FROM girls WHERE active = 1 AND ahg_level IN (${levels.map(() => '?').join(',')})`).all(...levels)
        .filter((g) => attended.has(g.id));
      const items = db.prepare('SELECT * FROM plan_items WHERE plan_id = ?').all(plan.id);
      for (const item of items) {
        for (const g of girls) {
          if (item.role === 'start' || item.role === 'continue') {
            const r = db.prepare('INSERT OR IGNORE INTO participation (girl_id, plan_item_id, event_id, recorded_at) VALUES (?, ?, ?, ?)')
              .run(g.id, item.id, event.id, now());
            summary.participation += r.changes;
          } else { // session | finish → propose (rule 3), unless a live row exists
            const live = db.prepare("SELECT 1 FROM completions WHERE girl_id = ? AND requirement_id = ? AND status <> 'rejected'").get(g.id, item.requirement_id);
            if (live) continue;
            db.prepare(`INSERT INTO completions (girl_id, requirement_id, status, completed_on, event_id, plan_item_id, source, source_txn_ids, proposed_at)
                        VALUES (?, ?, 'proposed', ?, ?, ?, 'attendance', ?, ?)`)
              .run(g.id, item.requirement_id, date, event.id, item.id, txnsByGirl.get(g.id) || '[]', now());
            summary.proposed += 1;
          }
        }
      }
    }

    // ---- reconcile (rule 5): rows resting on this event whose girl is no
    // longer attended (voided sign-out re-opens; voided sign-in removes)
    for (const c of db.prepare("SELECT * FROM completions WHERE event_id = ? AND source = 'attendance' AND status <> 'rejected'").all(event.id)) {
      if (attended.has(c.girl_id)) continue;
      if (c.status === 'proposed') {
        db.prepare('DELETE FROM completions WHERE id = ?').run(c.id);
        auditRow(db, 'system', 'completion.withdraw', c.id, { girlId: c.girl_id, requirementId: c.requirement_id, eventId: event.id }, null);
        summary.withdrawn += 1;
      } else if (!c.needs_review) {
        db.prepare("UPDATE completions SET needs_review = 1, review_reason = ? WHERE id = ?")
          .run('attendance withdrawn after confirmation (voided transaction)', c.id);
        auditRow(db, 'system', 'completion.flag', c.id, null, { reason: 'attendance withdrawn after confirmation' });
        summary.flagged += 1;
      }
    }
    const stale = db.prepare('SELECT * FROM participation WHERE event_id = ?').all(event.id).filter((p) => !attended.has(p.girl_id));
    for (const p of stale) db.prepare('DELETE FROM participation WHERE girl_id = ? AND plan_item_id = ?').run(p.girl_id, p.plan_item_id);
  });
  run();
  return summary;
}

// ------------------------------------------------------------- proposals --
const participationFor = (db, girlId, requirementId) => ({
  count: db.prepare(`SELECT COUNT(*) AS n FROM participation p JOIN plan_items pi ON pi.id = p.plan_item_id
                     WHERE p.girl_id = ? AND pi.requirement_id = ?`).get(girlId, requirementId).n,
  planned: db.prepare("SELECT COUNT(*) AS n FROM plan_items WHERE requirement_id = ? AND role IN ('start', 'continue')").get(requirementId).n,
});

/** The after-meeting screen: proposed rows grouped by girl, plus flagged confirmed rows. */
function eventProposals(db, event) {
  const rows = db.prepare(`
    SELECT c.*, g.first_name, g.last_name, g.nickname, g.ahg_level,
           r.number, r.letter, r.title, r.badge_id, b.name AS badge_name, pi.role
    FROM completions c
    JOIN girls g ON g.id = c.girl_id
    JOIN requirements r ON r.id = c.requirement_id
    JOIN badges b ON b.id = r.badge_id
    LEFT JOIN plan_items pi ON pi.id = c.plan_item_id
    WHERE c.event_id = ? AND (c.status = 'proposed' OR (c.status = 'confirmed' AND c.needs_review = 1))
    ORDER BY g.last_name, g.first_name, b.name, r.number, r.letter`).all(event.id);
  const byGirl = new Map();
  for (const c of rows) {
    if (!byGirl.has(c.girl_id)) {
      byGirl.set(c.girl_id, { girlId: c.girl_id, firstName: c.first_name, lastName: c.last_name, nickname: c.nickname, ahgLevel: c.ahg_level, items: [] });
    }
    byGirl.get(c.girl_id).items.push({
      completionId: c.id,
      requirementId: c.requirement_id,
      badgeId: c.badge_id,
      badgeName: c.badge_name,
      number: c.number,
      letter: c.letter,
      title: c.title,
      role: c.role,
      status: c.status,
      completedOn: c.completed_on,
      needsReview: !!c.needs_review,
      reviewReason: c.review_reason,
      participation: c.role === 'finish' ? participationFor(db, c.girl_id, c.requirement_id) : null,
    });
  }
  return { eventId: event.id, title: event.title, startAt: event.start_at, girls: [...byGirl.values()] };
}

/**
 * Decide proposals: body [{ completionId, decision: confirm|reject,
 * completedOn? }], all-or-nothing. Confirming stamps level_at_completion
 * from the girl's *current* level (rule 9). Re-confirming a flagged
 * confirmed row clears its review flag; rejecting it retracts it.
 */
function decide(db, event, decisions, actor) {
  return decideRows(db, decisions, actor, { eventId: event.id });
}

/**
 * The cross-event review queue (leaders catching up after several
 * meetings): every proposed row — plus confirmed rows flagged for review —
 * on events that have already ended, grouped by event then girl, oldest
 * first. `levelGroup` filters by the PLAN's level group (the unit whose
 * plan generated the item), so a unit leader sees exactly her unit's work.
 */
function pendingProposals(db, { levelGroup = null, now = new Date().toISOString() } = {}) {
  const rows = db.prepare(`
    SELECT c.*, g.first_name, g.last_name, g.nickname, g.ahg_level,
           r.number, r.letter, r.title, r.badge_id, b.name AS badge_name, pi.role, p.level_group,
           e.title AS event_title, e.start_at, e.end_at
    FROM completions c
    JOIN girls g ON g.id = c.girl_id
    JOIN requirements r ON r.id = c.requirement_id
    JOIN badges b ON b.id = r.badge_id
    JOIN events e ON e.id = c.event_id
    LEFT JOIN plan_items pi ON pi.id = c.plan_item_id
    LEFT JOIN plans p ON p.id = pi.plan_id
    WHERE (c.status = 'proposed' OR (c.status = 'confirmed' AND c.needs_review = 1))
      AND COALESCE(e.end_at, e.start_at) <= ?
      ${levelGroup ? 'AND p.level_group = ?' : ''}
    ORDER BY e.start_at, e.id, g.last_name, g.first_name, b.name, r.number, r.letter`).all(...(levelGroup ? [now, levelGroup] : [now]));
  const events = new Map();
  for (const c of rows) {
    if (!events.has(c.event_id)) events.set(c.event_id, { eventId: c.event_id, title: c.event_title, startAt: c.start_at, endAt: c.end_at, girls: new Map(), count: 0 });
    const ev = events.get(c.event_id);
    if (!ev.girls.has(c.girl_id)) ev.girls.set(c.girl_id, { girlId: c.girl_id, firstName: c.first_name, lastName: c.last_name, nickname: c.nickname, ahgLevel: c.ahg_level, items: [] });
    ev.girls.get(c.girl_id).items.push({
      completionId: c.id,
      levelGroup: c.level_group,
      requirementId: c.requirement_id,
      badgeId: c.badge_id,
      badgeName: c.badge_name,
      number: c.number,
      letter: c.letter,
      title: c.title,
      role: c.role,
      status: c.status,
      completedOn: c.completed_on,
      needsReview: !!c.needs_review,
      reviewReason: c.review_reason,
      participation: c.role === 'finish' ? participationFor(db, c.girl_id, c.requirement_id) : null,
    });
    ev.count += 1;
  }
  return {
    total: rows.length,
    levelGroups: Object.fromEntries(PLAN_GIRL_LEVELS && Object.keys(PLAN_GIRL_LEVELS).map((lg) => [lg, rows.filter((c) => c.level_group === lg).length])),
    events: [...events.values()].map((ev) => ({ ...ev, girls: [...ev.girls.values()] })),
  };
}

/** Cheap counts for the "waiting on you" banner (past events only). */
function pendingCounts(db, { now = new Date().toISOString() } = {}) {
  const completions = db.prepare(`SELECT COUNT(*) AS n FROM completions c JOIN events e ON e.id = c.event_id
                                  WHERE (c.status = 'proposed' OR (c.status = 'confirmed' AND c.needs_review = 1))
                                    AND COALESCE(e.end_at, e.start_at) <= ?`).get(now).n;
  const events = db.prepare(`SELECT COUNT(DISTINCT c.event_id) AS n FROM completions c JOIN events e ON e.id = c.event_id
                             WHERE (c.status = 'proposed' OR (c.status = 'confirmed' AND c.needs_review = 1))
                               AND COALESCE(e.end_at, e.start_at) <= ?`).get(now).n;
  const stars = db.prepare("SELECT COUNT(*) AS n FROM star_proposals WHERE status = 'proposed'").get().n;
  return { completions, events, stars, total: completions + stars };
}

/** decide() without the per-event constraint — the review queue's bulk path. */
function decideRows(db, decisions, actor, { eventId = null } = {}) {
  if (!Array.isArray(decisions) || !decisions.length) {
    throw new CompletionError(400, 'body must be [{ completionId, decision: confirm|reject, completedOn? }, …]');
  }
  const run = db.transaction(() => {
    const results = [];
    for (const d of decisions) {
      if (!['confirm', 'reject'].includes(d.decision)) throw new CompletionError(400, `decision must be confirm|reject (completion ${d.completionId})`);
      const c = eventId === null
        ? db.prepare('SELECT * FROM completions WHERE id = ?').get(d.completionId)
        : db.prepare('SELECT * FROM completions WHERE id = ? AND event_id = ?').get(d.completionId, eventId);
      if (!c) throw new CompletionError(404, eventId === null ? `completion ${d.completionId} not found` : `completion ${d.completionId} not found on this event`);
      const decidable = c.status === 'proposed' || (c.status === 'confirmed' && c.needs_review);
      if (!decidable) throw new CompletionError(409, `completion ${d.completionId} is already ${c.status}`);
      if (d.completedOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(d.completedOn || '')) {
        throw new CompletionError(400, `completedOn must be YYYY-MM-DD (completion ${d.completionId})`);
      }
      if (d.decision === 'confirm') {
        const girl = db.prepare('SELECT * FROM girls WHERE id = ?').get(c.girl_id);
        db.prepare(`UPDATE completions SET status = 'confirmed', completed_on = ?, level_at_completion = ?,
                    needs_review = 0, review_reason = NULL, decided_by = ?, decided_at = ? WHERE id = ?`)
          .run(d.completedOn || c.completed_on, girl.ahg_level, actor, now(), c.id);
        auditRow(db, actor, 'completion.confirm', c.id, { status: c.status, needsReview: !!c.needs_review },
          { completedOn: d.completedOn || c.completed_on, levelAtCompletion: girl.ahg_level });
      } else {
        db.prepare("UPDATE completions SET status = 'rejected', needs_review = 0, review_reason = NULL, decided_by = ?, decided_at = ? WHERE id = ?")
          .run(actor, now(), c.id);
        auditRow(db, actor, 'completion.reject', c.id, { status: c.status }, null);
      }
      results.push({ completionId: c.id, decision: d.decision });
    }
    return results;
  });
  return run();
}

// ------------------------------------------------------ manual completions --
/** Rule 4: home completions are manual and confirmed directly by a leader. */
function manualCompletion(db, { girlId, requirementId, completedOn, notes }, actor) {
  const girl = db.prepare('SELECT * FROM girls WHERE id = ?').get(girlId);
  if (!girl) throw new CompletionError(400, 'unknown girl');
  const req = db.prepare(`SELECT r.*, b.active AS badge_active FROM requirements r JOIN badges b ON b.id = r.badge_id WHERE r.id = ?`).get(requirementId);
  if (!req || !req.active || !req.badge_active) throw new CompletionError(400, 'unknown or inactive requirement');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(completedOn || '')) throw new CompletionError(400, 'completedOn must be YYYY-MM-DD');
  if (db.prepare("SELECT 1 FROM completions WHERE girl_id = ? AND requirement_id = ? AND status <> 'rejected'").get(girlId, requirementId)) {
    throw new CompletionError(409, 'a live completion already exists for this girl and requirement');
  }
  const r = db.prepare(`INSERT INTO completions (girl_id, requirement_id, status, completed_on, source, level_at_completion, proposed_at, decided_by, decided_at, notes)
                        VALUES (?, ?, 'confirmed', ?, 'manual', ?, ?, ?, ?, ?)`)
    .run(girlId, requirementId, completedOn, girl.ahg_level, now(), actor, now(), notes || null);
  auditRow(db, actor, 'completion.manual', r.lastInsertRowid, null, { girlId, requirementId, completedOn });
  return db.prepare('SELECT * FROM completions WHERE id = ?').get(r.lastInsertRowid);
}

/** Delete a completion that never reached AHGFamily (spec §6; the queued-unmark path is step 7). */
function deleteCompletion(db, id, actor) {
  const c = db.prepare('SELECT * FROM completions WHERE id = ?').get(id);
  if (!c) throw new CompletionError(404, 'not found');
  const pushed = db.prepare("SELECT 1 FROM push_queue WHERE completion_id = ? AND status = 'sent'").get(id);
  if (pushed) throw new CompletionError(409, 'already pushed to AHGFamily — deleting it must queue an unmark (step 7)');
  db.prepare('DELETE FROM push_queue WHERE completion_id = ?').run(id);
  db.prepare('DELETE FROM completions WHERE id = ?').run(id);
  auditRow(db, actor, 'completion.delete', id, { girlId: c.girl_id, requirementId: c.requirement_id, status: c.status }, null);
}

// ---------------------------------------------------------------- progress --
/**
 * Rule 1: badge complete is derived, never set. `all` groups need every
 * active requirement confirmed; `n_of` groups need at least rule_n (a
 * NULL rule is treated as `all`).
 */
function badgeStatusFor(db, girlId, badgeId) {
  const groups = db.prepare('SELECT * FROM badge_groups WHERE badge_id = ? ORDER BY position').all(badgeId);
  const confirmed = new Set(db.prepare(`SELECT c.requirement_id FROM completions c JOIN requirements r ON r.id = c.requirement_id
                                        WHERE c.girl_id = ? AND r.badge_id = ? AND c.status = 'confirmed'`).all(girlId, badgeId).map((x) => x.requirement_id));
  let complete = groups.length > 0;
  for (const gr of groups) {
    const reqs = db.prepare('SELECT id FROM requirements WHERE group_id = ? AND active = 1').all(gr.id).map((x) => x.id);
    const done = reqs.filter((id) => confirmed.has(id)).length;
    const need = gr.rule_type === 'n_of' ? Math.min(gr.rule_n || reqs.length, reqs.length) : reqs.length;
    if (done < need) complete = false;
  }
  return { status: complete ? 'complete' : confirmed.size ? 'in_progress' : 'not_started', confirmedCount: confirmed.size };
}

const stateRows = (db, girlId, badgeId) => db.prepare(`SELECT c.requirement_id, c.status, c.completed_on, c.source, c.needs_review
  FROM completions c JOIN requirements r ON r.id = c.requirement_id
  WHERE c.girl_id = ? AND r.badge_id = ? AND c.status <> 'rejected'`).all(girlId, badgeId);

/** Per girl: every active badge (optionally one level group) with status and per-requirement state. */
function girlProgress(db, girl, { levelGroup = null } = {}) {
  const badges = db.prepare(`SELECT * FROM badges WHERE active = 1 ${levelGroup ? 'AND level_group = ?' : ''} ORDER BY name`)
    .all(...(levelGroup ? [levelGroup] : []));
  return badges.map((b) => {
    const states = new Map(stateRows(db, girl.id, b.id).map((c) => [c.requirement_id, c]));
    const groups = db.prepare('SELECT * FROM badge_groups WHERE badge_id = ? ORDER BY position').all(b.id).map((gr) => ({
      label: gr.label,
      ruleType: gr.rule_type,
      ruleN: gr.rule_n,
      requirements: db.prepare('SELECT * FROM requirements WHERE group_id = ? AND active = 1 ORDER BY number, letter').all(gr.id).map((r) => {
        const c = states.get(r.id);
        return {
          requirementId: r.id,
          number: r.number,
          letter: r.letter,
          title: r.title,
          state: c ? c.status : 'none',
          completedOn: c ? c.completed_on : null,
          source: c ? c.source : null,
          needsReview: c ? !!c.needs_review : false,
        };
      }),
    }));
    // eligible = earnable at the girl's CURRENT level (spec rule 9). A badge
    // from an earlier level stays visible once she has activity on it, but
    // further requirement recording for it happens directly in AHGFamily.
    const levels = b.level_group === 'All' ? null : PLAN_GIRL_LEVELS[b.level_group];
    const eligible = !girl.ahg_level || !levels ? true : levels.includes(girl.ahg_level);
    return { badgeId: b.id, name: b.name, levelGroup: b.level_group, eligible, ...badgeStatusFor(db, girl.id, b.id), groups };
  });
}

/** Per badge: every active girl's status and per-requirement state ("who is missing what"). */
function badgeProgress(db, badge) {
  const requirements = db.prepare('SELECT * FROM requirements WHERE badge_id = ? AND active = 1 ORDER BY number, letter').all(badge.id)
    .map((r) => ({ requirementId: r.id, number: r.number, letter: r.letter, title: r.title }));
  const girls = db.prepare('SELECT * FROM girls WHERE active = 1 ORDER BY last_name, first_name').all().map((g) => {
    const states = {};
    for (const c of stateRows(db, g.id, badge.id)) {
      states[c.requirement_id] = { state: c.status, completedOn: c.completed_on, source: c.source, needsReview: !!c.needs_review };
    }
    return { girlId: g.id, firstName: g.first_name, lastName: g.last_name, nickname: g.nickname, ahgLevel: g.ahg_level, ...badgeStatusFor(db, g.id, badge.id), states };
  });
  return { badgeId: badge.id, name: badge.name, levelGroup: badge.level_group, requirements, girls };
}

module.exports = {
  PLAN_GIRL_LEVELS, CompletionError, localDate,
  proposeForEvent, eventProposals, decide, manualCompletion, deleteCompletion,
  badgeStatusFor, girlProgress, badgeProgress,
};

// Review queue (cross-event catch-up) — see pendingProposals above.
Object.assign(module.exports, { pendingProposals, pendingCounts, decideRows });
