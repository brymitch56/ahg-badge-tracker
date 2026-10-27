'use strict';
/**
 * The Pathfinder planner and tracker (migration 013).
 *
 * Pathfinders earn no badges, and nothing they do counts toward a later
 * level's badges or service hours (lib/stars.js already keeps their hours
 * out). Their year is:
 *   - six stepping stones (handbook/pathfinder.json: number, name, the logo
 *     bead's AHGFamily award, the memory verse's reference), each planned
 *     over one or more meetings laid out like the Unit Leader Guide's
 *     meeting planner (intro, activities, optional activity, closing);
 *   - repeat necklace beads — blue attendance, red memory-verse hearts,
 *     white service stars — and one logo bead per stepping stone;
 *   - the Fanny Crosby Level Award and the Joining Award, whose requirements
 *     are planned on the same meetings and tracked as ordinary completions
 *     (so the requirement push carries them to AHGFamily).
 *
 * Beads follow the tracker's rule 2: attendance only PROPOSES (a meeting
 * she was checked in to → attendance bead; a service-project meeting →
 * service star; the meeting that finishes a stone → its logo bead) and a
 * leader confirms. Memory verses are not planned — a leader marks a verse
 * learned, which is a confirmed bead at once. Every confirmed bead queues
 * one push row: AHGFamily keeps a single instance per bead award, so the
 * push appends one line per bead to that instance's comment
 * (servicepush.pushBeadNotes).
 *
 * The outlines (goal, objectives, verse wording) are AHG's copyrighted text
 * and come from data/pathfinder/stones.json (gitignored), when present.
 */
const fs = require('fs');
const path = require('path');
const { localDate, decideRows, CompletionError } = require('./proposals');
const { getSetting, setSetting } = require('./settings');

const CONFIG_FILE = path.join(__dirname, '..', '..', 'handbook', 'pathfinder.json');
const KINDS = ['attendance', 'verse', 'service', 'stone'];
const SLOTS = ['intro', 'activity', 'optional', 'closing'];
const ATTENDANCE_SETTING = 'pathfinder_attendance_source';
const ATTENDANCE_SOURCES = ['planned', 'all'];

class PathfinderError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

let cached = null;
function pfConfig() {
  if (!cached) {
    try { cached = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { cached = { stones: [], beads: {}, fannyCrosbyDerived: {} }; }
  }
  return cached;
}
// tests use invented award ids
const setPfConfig = (c) => { cached = c; };

function stoneTexts(dir) {
  if (!dir) return {};
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'stones.json'), 'utf8'));
    return Object.fromEntries((j.stones || []).map((s) => [s.number, s]));
  } catch { return {}; }
}

const now = () => new Date().toISOString();
const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const stoneOf = (n) => pfConfig().stones.find((s) => s.number === Number(n)) || null;
const audit = (db, actor, action, entity, id, before, after) => db.prepare(
  'INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)',
).run(now(), actor, action, entity, String(id), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);

// ------------------------------------------------------------- program --
/** The Fanny Crosby / Joining badge row (imported catalog), or null. */
function awardBadge(db, awardId) {
  if (!awardId) return null;
  return db.prepare('SELECT * FROM badges WHERE ahg_award_id = ? AND active = 1').get(awardId) || null;
}

function awardRequirements(db, awardId) {
  const b = awardBadge(db, awardId);
  if (!b) return [];
  return db.prepare('SELECT id, number, letter, title, text, ahg_requirement_id FROM requirements WHERE badge_id = ? AND active = 1 ORDER BY number, letter').all(b.id)
    .map((r) => ({ id: r.id, number: r.number, letter: r.letter, title: r.title, text: r.text, ahgRequirementId: r.ahg_requirement_id }));
}

/** Requirement ids a Pathfinder plan may carry: Fanny Crosby and Joining. */
function plannableRequirementIds(db) {
  const c = pfConfig();
  return new Set([...awardRequirements(db, c.fannyCrosby), ...awardRequirements(db, c.joining)].map((r) => r.id));
}

const attendanceSource = (db) => (ATTENDANCE_SOURCES.includes(getSetting(db, ATTENDANCE_SETTING)) ? getSetting(db, ATTENDANCE_SETTING) : 'planned');
function setAttendanceSource(db, value, actor) {
  if (!ATTENDANCE_SOURCES.includes(value)) throw new PathfinderError(400, `attendanceSource must be ${ATTENDANCE_SOURCES.join('|')}`);
  const before = attendanceSource(db);
  setSetting(db, ATTENDANCE_SETTING, value, actor);
  audit(db, actor, 'pathfinder.attendance_source', 'settings', ATTENDANCE_SETTING, { value: before }, { value });
  return value;
}

/**
 * The memory-verse date picker's default: the most recent calendar event on
 * or before today (the same day, or the latest one before it).
 */
function defaultVerseDate(db, tz, { nowIso = now() } = {}) {
  const today = localDate(nowIso, tz);
  const rows = db.prepare('SELECT start_at FROM events WHERE removed_from_feed = 0 AND start_at <= ? ORDER BY start_at DESC LIMIT 40').all(`${today}T￿`);
  for (const r of rows) {
    const d = localDate(r.start_at, tz);
    if (d <= today) return d;
  }
  return today;
}

/** GET /pathfinder — stones (with the outline when data/ has it), awards, settings. */
function program(db, { tz = 'UTC', dataDir = null } = {}) {
  const c = pfConfig();
  const texts = stoneTexts(dataDir);
  const award = (id) => {
    const b = awardBadge(db, id);
    return b ? { badgeId: b.id, awardId: id, name: b.name, requirements: awardRequirements(db, id) } : { badgeId: null, awardId: id, name: null, requirements: [] };
  };
  return {
    stones: c.stones.map((s) => {
      const t = texts[s.number] || {};
      return {
        number: s.number, name: s.name, verse: s.verse, beadAwardId: s.beadAwardId,
        goal: t.goal || null, objectives: t.objectives || [], supplemental: t.supplemental || [],
        verseText: t.verseText || null, creedWords: t.creedWords || [], frontier: t.frontier || null, levelAward: t.levelAward || [],
      };
    }),
    fannyCrosby: award(c.fannyCrosby),
    joining: award(c.joining),
    attendanceSource: attendanceSource(db),
    defaultVerseDate: defaultVerseDate(db, tz),
    outlinesLoaded: Object.keys(texts).length > 0,
  };
}

// --------------------------------------------------------------- plans --
const partRows = (db, planId) => db.prepare(`
  SELECT pp.*, r.number AS req_number, r.letter AS req_letter, r.title AS req_title, b.name AS badge_name, b.ahg_award_id
  FROM pf_plan_parts pp LEFT JOIN requirements r ON r.id = pp.requirement_id LEFT JOIN badges b ON b.id = r.badge_id
  WHERE pp.plan_id = ? ORDER BY pp.position`).all(planId);

function planOut(db, p) {
  if (!p) return null;
  return {
    id: p.id,
    eventId: p.event_id,
    kind: p.kind,
    serviceProject: p.service_project,
    finishesStones: JSON.parse(p.finishes_stones || '[]'),
    notes: p.notes,
    createdBy: p.created_by, createdAt: p.created_at, updatedBy: p.updated_by, updatedAt: p.updated_at,
    parts: partRows(db, p.id).map((x) => ({
      id: x.id, slot: x.slot, position: x.position, stone: x.stone, stoneName: x.stone ? (stoneOf(x.stone) || {}).name || null : null,
      requirementId: x.requirement_id,
      requirement: x.requirement_id ? { badgeName: x.badge_name, number: x.req_number, letter: x.req_letter, title: x.req_title } : null,
      what: x.what, supplies: x.supplies, who: x.who,
    })),
  };
}

const getPlan = (db, eventId) => planOut(db, db.prepare('SELECT * FROM pf_plans WHERE event_id = ?').get(eventId));

/** Events (in [from, to]) that carry a Pathfinder plan — the year view. */
function listPlans(db, { from, to }) {
  if (!isDate(from) || !isDate(to)) throw new PathfinderError(400, 'from and to must be YYYY-MM-DD');
  return db.prepare(`SELECT p.*, e.title, e.start_at, e.end_at, e.location, e.removed_from_feed FROM pf_plans p JOIN events e ON e.id = p.event_id
                     WHERE e.start_at >= ? AND e.start_at <= ? ORDER BY e.start_at, e.id`).all(from, `${to}T￿`)
    .map((p) => ({ event: { id: p.event_id, title: p.title, startAt: p.start_at, endAt: p.end_at, location: p.location, removedFromFeed: !!p.removed_from_feed }, plan: planOut(db, p) }));
}

/** Event ids with a Pathfinder plan (the events list's pill). */
const plannedEventIds = (db) => new Set(db.prepare('SELECT event_id FROM pf_plans').all().map((r) => r.event_id));

/**
 * Replace one event's Pathfinder plan. body = { kind?, serviceProject?,
 * finishesStones?: [1–6], notes?, parts: [{ slot, stone?, requirementId?,
 * what?, supplies?, who? }] } — order is the position. A plan with nothing
 * in it is deleted. Returns the stored plan, or { deleted: true }.
 */
function putPlan(db, event, body, actor) {
  const b = body || {};
  if (!Array.isArray(b.parts)) throw new PathfinderError(400, 'body must be { parts: [{ slot, stone?, requirementId?, what?, supplies?, who? }, …], kind?, serviceProject?, finishesStones?, notes? }');
  const kind = b.kind === undefined ? 'meeting' : b.kind;
  if (!['meeting', 'service'].includes(kind)) throw new PathfinderError(400, 'kind must be meeting|service');
  const finishes = b.finishesStones === undefined ? [] : b.finishesStones;
  if (!Array.isArray(finishes) || finishes.some((n) => !stoneOf(n))) throw new PathfinderError(400, 'finishesStones must be stepping stone numbers 1–6');
  const finishesStones = [...new Set(finishes.map(Number))].sort();
  const allowed = plannableRequirementIds(db);
  const parts = b.parts.map((p, i) => {
    const where = `parts[${i}]`;
    if (!p || !SLOTS.includes(p.slot)) throw new PathfinderError(400, `${where}: slot must be ${SLOTS.join('|')}`);
    if (p.stone != null && !stoneOf(p.stone)) throw new PathfinderError(400, `${where}: stone must be 1–6`);
    if (p.requirementId != null && !allowed.has(p.requirementId)) throw new PathfinderError(400, `${where}: ${p.requirementId} is not a Fanny Crosby or Joining Award requirement`);
    return { slot: p.slot, stone: p.stone == null ? null : Number(p.stone), requirementId: p.requirementId || null, what: clean(p.what), supplies: clean(p.supplies), who: clean(p.who), position: i };
  });
  const notes = clean(b.notes);
  const serviceProject = kind === 'service' ? clean(b.serviceProject) : null;
  const empty = !parts.length && !notes && kind === 'meeting' && !finishesStones.length;

  const run = db.transaction(() => {
    const current = db.prepare('SELECT * FROM pf_plans WHERE event_id = ?').get(event.id);
    const before = current ? planOut(db, current) : null;
    if (empty) {
      if (current) {
        db.prepare('DELETE FROM pf_plans WHERE id = ?').run(current.id);
        audit(db, actor, 'pathfinder.plan.delete', 'pf_plan', event.id, before, null);
      }
      return { deleted: true };
    }
    let id;
    if (current) {
      db.prepare('UPDATE pf_plans SET kind = ?, service_project = ?, finishes_stones = ?, notes = ?, updated_by = ?, updated_at = ? WHERE id = ?')
        .run(kind, serviceProject, JSON.stringify(finishesStones), notes, actor, now(), current.id);
      id = current.id;
      db.prepare('DELETE FROM pf_plan_parts WHERE plan_id = ?').run(id);
    } else {
      id = Number(db.prepare('INSERT INTO pf_plans (event_id, kind, service_project, finishes_stones, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(event.id, kind, serviceProject, JSON.stringify(finishesStones), notes, actor, now()).lastInsertRowid);
    }
    const ins = db.prepare('INSERT INTO pf_plan_parts (plan_id, position, slot, stone, requirement_id, what, supplies, who) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const p of parts) ins.run(id, p.position, p.slot, p.stone, p.requirementId, p.what, p.supplies, p.who);
    const after = planOut(db, db.prepare('SELECT * FROM pf_plans WHERE id = ?').get(id));
    audit(db, actor, 'pathfinder.plan.put', 'pf_plan', event.id, before, after);
    return after;
  });
  return run();
}

// ----------------------------------------------------------- proposing --
const pathfinders = (db) => db.prepare("SELECT * FROM girls WHERE active = 1 AND ahg_level = 'Pathfinder'").all();

/**
 * Propose beads and Fanny Crosby / Joining completions for one event from
 * its (closed) attendance, idempotently, and withdraw PROPOSED rows the
 * attendance or the plan no longer supports. Confirmed rows are never
 * touched here — a leader removes those. Called from
 * proposals.proposeForEvent, so the webhook, the sweep and a plan save all
 * reach it.
 */
function proposeForEvent(db, event, tz) {
  const summary = { beads: 0, completions: 0, withdrawn: 0 };
  const date = localDate(event.start_at, tz);
  const attended = new Set(db.prepare('SELECT girl_id FROM attendance WHERE event_id = ? AND open = 0').all(event.id).map((a) => a.girl_id));
  const plan = db.prepare('SELECT * FROM pf_plans WHERE event_id = ?').get(event.id);
  const parts = plan ? partRows(db, plan.id) : [];
  const finishes = plan ? JSON.parse(plan.finishes_stones || '[]') : [];
  const wantAttendance = !!plan || attendanceSource(db) === 'all';
  const wantService = !!plan && plan.kind === 'service';
  const reqIds = [...new Set(parts.map((p) => p.requirement_id).filter(Boolean))];

  const run = db.transaction(() => {
    const addBead = (g, kind, extra = {}) => {
      const r = db.prepare(`INSERT OR IGNORE INTO pf_beads (girl_id, kind, earned_on, event_id, stone, verse, label, status, source, proposed_at)
                            VALUES (?, ?, ?, ?, ?, NULL, ?, 'proposed', 'attendance', ?)`)
        .run(g.id, kind, date, event.id, extra.stone || null, extra.label || null, now());
      summary.beads += r.changes;
    };
    for (const g of pathfinders(db)) {
      if (!attended.has(g.id)) continue;
      // a bead a leader rejected for this meeting is never proposed again
      const had = (kind) => db.prepare('SELECT 1 FROM pf_beads WHERE girl_id = ? AND kind = ? AND event_id = ?').get(g.id, kind, event.id);
      if (wantAttendance && !had('attendance')) addBead(g, 'attendance', { label: event.title });
      if (wantService && !had('service')) addBead(g, 'service', { label: plan.service_project || event.title });
      for (const n of finishes) {
        if (db.prepare("SELECT 1 FROM pf_beads WHERE girl_id = ? AND kind = 'stone' AND stone = ? AND (status <> 'rejected' OR event_id = ?)").get(g.id, n, event.id)) continue;
        addBead(g, 'stone', { stone: n, label: event.title });
      }
      for (const rid of reqIds) {
        if (db.prepare("SELECT 1 FROM completions WHERE girl_id = ? AND requirement_id = ? AND (status <> 'rejected' OR event_id = ?)").get(g.id, rid, event.id)) continue;
        const what = parts.filter((p) => p.requirement_id === rid).map((p) => p.what).filter(Boolean).join('; ');
        db.prepare(`INSERT INTO completions (girl_id, requirement_id, status, completed_on, event_id, source, proposed_at, notes)
                    VALUES (?, ?, 'proposed', ?, ?, 'attendance', ?, ?)`)
          .run(g.id, rid, date, event.id, now(), `Pathfinder meeting ${date} ${event.title}${what ? ` — ${what}` : ''}`);
        summary.completions += 1;
      }
    }
    // withdraw what this event no longer supports (proposed rows only)
    for (const bd of db.prepare("SELECT * FROM pf_beads WHERE event_id = ? AND status = 'proposed' AND source = 'attendance'").all(event.id)) {
      const ok = attended.has(bd.girl_id) && (
        (bd.kind === 'attendance' && wantAttendance) || (bd.kind === 'service' && wantService) || (bd.kind === 'stone' && finishes.includes(bd.stone)));
      if (ok) continue;
      db.prepare('DELETE FROM pf_beads WHERE id = ?').run(bd.id);
      summary.withdrawn += 1;
    }
    const allowed = plannableRequirementIds(db);
    for (const c of db.prepare("SELECT * FROM completions WHERE event_id = ? AND source = 'attendance' AND plan_item_id IS NULL AND status = 'proposed'").all(event.id)) {
      if (!allowed.has(c.requirement_id)) continue;
      if (attended.has(c.girl_id) && reqIds.includes(c.requirement_id)) continue;
      db.prepare('DELETE FROM completions WHERE id = ?').run(c.id);
      summary.withdrawn += 1;
    }
  });
  run();
  return summary;
}

/** Re-run the proposer over every event since `from` (a setting changed, or a leader asked). */
function rescan(db, tz, { from }) {
  if (!isDate(from)) throw new PathfinderError(400, 'from must be YYYY-MM-DD');
  const total = { events: 0, beads: 0, completions: 0, withdrawn: 0 };
  for (const e of db.prepare('SELECT * FROM events WHERE start_at >= ? AND start_at <= ? ORDER BY start_at').all(from, now())) {
    const s = proposeForEvent(db, e, tz);
    total.events += 1; total.beads += s.beads; total.completions += s.completions; total.withdrawn += s.withdrawn;
  }
  return total;
}

// --------------------------------------------------------------- beads --
/**
 * The line a bead appends to its AHGFamily instance's comment (the agreed
 * format: her count to date and the bead's own date). `n` is how many beads
 * of the kind she has to date, this one included.
 */
function beadLine(bead, n) {
  const d = bead.earned_on;
  if (bead.kind === 'attendance') return `Bead ${n} of ${n} to date: ${d} (tracker)`;
  if (bead.kind === 'verse') return `Heart ${n} of ${n} to date: ${d}${bead.verse ? `, ${bead.verse}` : ''} (tracker)`;
  if (bead.kind === 'service') return `Star ${n} of ${n} to date: ${d}${bead.label ? `, ${bead.label}` : ''} (tracker)`;
  const s = stoneOf(bead.stone);
  return `Stepping Stone ${bead.stone}${s ? ` - ${s.name}` : ''}: ${d} (tracker)`;
}

const beadAwardId = (bead) => (bead.kind === 'stone' ? (stoneOf(bead.stone) || {}).beadAwardId : (pfConfig().beads || {})[bead.kind]) || null;

/** Queue one confirmed bead for the push (the line is fixed now, at its place in her count). */
function queueBead(db, bead) {
  const n = db.prepare("SELECT COUNT(*) AS n FROM pf_beads WHERE girl_id = ? AND kind = ? AND status = 'confirmed' AND id <> ?").get(bead.girl_id, bead.kind, bead.id).n + 1;
  const line = beadLine(bead, n);
  db.prepare(`INSERT INTO push_queue (girl_id, action, date, status, created_at, ahg_award_id, detail, pf_bead_id)
              VALUES (?, 'bead', ?, 'queued', ?, ?, ?, ?)`)
    .run(bead.girl_id, bead.earned_on, now(), beadAwardId(bead), JSON.stringify({ kind: bead.kind, line }), bead.id);
  return line;
}

/**
 * Fanny Crosby requirements the beads already prove: all six stone beads →
 * "one activity from each stepping stone"; a service star → "at least one
 * service project". Proposed for a leader, never confirmed here.
 */
function proposeDerived(db, girlId) {
  const c = pfConfig();
  const d = c.fannyCrosbyDerived || {};
  const fc = awardBadge(db, c.fannyCrosby);
  if (!fc) return 0;
  const reqByAhg = (ahgId) => (ahgId ? db.prepare('SELECT id FROM requirements WHERE badge_id = ? AND ahg_requirement_id = ? AND active = 1').get(fc.id, ahgId) : null);
  let n = 0;
  const propose = (req, date, notes) => {
    if (!req || db.prepare("SELECT 1 FROM completions WHERE girl_id = ? AND requirement_id = ? AND status <> 'rejected'").get(girlId, req.id)) return;
    db.prepare(`INSERT INTO completions (girl_id, requirement_id, status, completed_on, source, proposed_at, notes)
                VALUES (?, ?, 'proposed', ?, 'attendance', ?, ?)`).run(girlId, req.id, date, now(), notes);
    n += 1;
  };
  const stones = db.prepare("SELECT stone, earned_on FROM pf_beads WHERE girl_id = ? AND kind = 'stone' AND status = 'confirmed' ORDER BY stone").all(girlId);
  if (new Set(stones.map((s) => s.stone)).size >= 6) {
    const last = stones.map((s) => s.earned_on).sort().pop();
    propose(reqByAhg(d.stones), last, `All six stepping stones: ${stones.map((s) => `${s.stone} ${s.earned_on}`).join(', ')}`);
  }
  const svc = db.prepare("SELECT earned_on, label FROM pf_beads WHERE girl_id = ? AND kind = 'service' AND status = 'confirmed' ORDER BY earned_on LIMIT 1").get(girlId);
  if (svc) propose(reqByAhg(d.service), svc.earned_on, `Service project ${svc.earned_on}${svc.label ? ` — ${svc.label}` : ''}`);
  return n;
}

function confirmBead(db, bead, actor, { earnedOn = null } = {}) {
  const date = earnedOn || bead.earned_on;
  db.prepare("UPDATE pf_beads SET status = 'confirmed', earned_on = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(date, actor, now(), bead.id);
  const fresh = db.prepare('SELECT * FROM pf_beads WHERE id = ?').get(bead.id);
  const line = queueBead(db, fresh);
  audit(db, actor, 'pathfinder.bead.confirm', 'pf_bead', bead.id, { status: bead.status }, { kind: bead.kind, earnedOn: date, line });
  proposeDerived(db, bead.girl_id);
  return fresh;
}

/** decisions: [{ beadId, decision: confirm|reject, earnedOn? }] */
function decideBeads(db, decisions, actor) {
  if (!Array.isArray(decisions) || !decisions.length) throw new PathfinderError(400, 'body must be [{ beadId, decision: confirm|reject, earnedOn? }, …]');
  const run = db.transaction(() => decisions.map((d) => {
    if (!['confirm', 'reject'].includes(d.decision)) throw new PathfinderError(400, `decision must be confirm|reject (bead ${d.beadId})`);
    const bead = db.prepare('SELECT * FROM pf_beads WHERE id = ?').get(d.beadId);
    if (!bead) throw new PathfinderError(404, `bead ${d.beadId} not found`);
    if (bead.status !== 'proposed') throw new PathfinderError(409, `bead ${d.beadId} is already ${bead.status}`);
    if (d.earnedOn !== undefined && !isDate(d.earnedOn)) throw new PathfinderError(400, `earnedOn must be YYYY-MM-DD (bead ${d.beadId})`);
    if (d.decision === 'confirm') confirmBead(db, bead, actor, { earnedOn: d.earnedOn || null });
    else {
      db.prepare("UPDATE pf_beads SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?").run(actor, now(), bead.id);
      audit(db, actor, 'pathfinder.bead.reject', 'pf_bead', bead.id, { status: bead.status }, null);
    }
    return { beadId: bead.id, decision: d.decision };
  }));
  return run();
}

/**
 * A bead a leader records by hand — a memory verse learned, a service
 * project outside a meeting, a stone finished at home, or a bead for a
 * meeting check-in missed. Confirmed at once. body = { girlId, kind,
 * earnedOn, stone?, verse?, label?, eventId?, notes? }. A verse with
 * `stone` is that stone's verse; without, `verse` names a bonus verse.
 */
function addBead(db, body, actor) {
  const b = body || {};
  const girl = db.prepare('SELECT * FROM girls WHERE id = ?').get(Number(b.girlId));
  if (!girl) throw new PathfinderError(400, 'unknown girl');
  if (girl.ahg_level !== 'Pathfinder') throw new PathfinderError(400, 'beads are for Pathfinders');
  if (!KINDS.includes(b.kind)) throw new PathfinderError(400, `kind must be ${KINDS.join('|')}`);
  if (!isDate(b.earnedOn)) throw new PathfinderError(400, 'earnedOn must be YYYY-MM-DD');
  let stone = null; let verse = null;
  if (b.kind === 'stone') {
    if (!stoneOf(b.stone)) throw new PathfinderError(400, 'stone must be 1–6');
    stone = Number(b.stone);
  }
  if (b.kind === 'verse') {
    if (b.stone != null) {
      if (!stoneOf(b.stone)) throw new PathfinderError(400, 'stone must be 1–6');
      stone = Number(b.stone);
      verse = stoneOf(stone).verse;
    } else {
      verse = clean(b.verse);
      if (!verse) throw new PathfinderError(400, 'a bonus verse needs its reference');
    }
  }
  const event = b.eventId != null ? db.prepare('SELECT * FROM events WHERE id = ?').get(Number(b.eventId)) : null;
  if (b.eventId != null && !event) throw new PathfinderError(400, 'unknown event');
  if (b.kind === 'attendance' && !event) throw new PathfinderError(400, 'an attendance bead needs its meeting (eventId)');
  const run = db.transaction(() => {
    // a waiting proposal for the same bead is replaced by the leader's entry
    if (event && (b.kind === 'attendance' || b.kind === 'service')) {
      db.prepare("DELETE FROM pf_beads WHERE girl_id = ? AND kind = ? AND event_id = ? AND status = 'proposed'").run(girl.id, b.kind, event.id);
    }
    if (b.kind === 'stone') db.prepare("DELETE FROM pf_beads WHERE girl_id = ? AND kind = 'stone' AND stone = ? AND status = 'proposed'").run(girl.id, stone);
    let id;
    try {
      id = Number(db.prepare(`INSERT INTO pf_beads (girl_id, kind, earned_on, event_id, stone, verse, label, status, source, proposed_at, notes)
                              VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', 'manual', ?, ?)`)
        .run(girl.id, b.kind, b.earnedOn, event ? event.id : null, stone, verse, clean(b.label) || (event ? event.title : null), now(), clean(b.notes)).lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new PathfinderError(409, b.kind === 'verse' ? 'she already has a heart for that verse' : b.kind === 'stone' ? 'she already has that stepping stone' : 'she already has that bead for this meeting');
      throw e;
    }
    return confirmBead(db, db.prepare('SELECT * FROM pf_beads WHERE id = ?').get(id), actor);
  });
  return run();
}

/**
 * Remove a confirmed bead recorded by mistake. One already written to
 * AHGFamily is refused: the tracker never edits a note it has sent — fix
 * the comment on AHGFamily by hand, then pass alreadyFixed: true.
 */
function removeBead(db, id, actor, { alreadyFixed = false } = {}) {
  const bead = db.prepare('SELECT * FROM pf_beads WHERE id = ?').get(Number(id));
  if (!bead) throw new PathfinderError(404, 'bead not found');
  if (bead.status === 'rejected') return { removed: false };
  const sent = db.prepare("SELECT 1 FROM push_queue WHERE pf_bead_id = ? AND status = 'sent'").get(bead.id);
  if (sent && !alreadyFixed) throw new PathfinderError(409, 'this bead is already in the AHGFamily note — correct the note there first, then remove it with alreadyFixed');
  db.transaction(() => {
    db.prepare("UPDATE pf_beads SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?").run(actor, now(), bead.id);
    db.prepare("UPDATE push_queue SET status = 'skipped', last_error = 'bead removed' WHERE pf_bead_id = ? AND status IN ('queued', 'held')").run(bead.id);
    audit(db, actor, 'pathfinder.bead.remove', 'pf_bead', bead.id, { status: bead.status, kind: bead.kind, earnedOn: bead.earned_on }, null);
  })();
  return { removed: true };
}

// ------------------------------------------------------------- tracker --
const pushState = (db, beadId) => {
  const q = db.prepare('SELECT status, last_error FROM push_queue WHERE pf_bead_id = ? ORDER BY id DESC LIMIT 1').get(beadId);
  return q ? { status: q.status, error: q.last_error } : null;
};

const beadOut = (db, b) => ({
  id: b.id, kind: b.kind, earnedOn: b.earned_on, eventId: b.event_id, stone: b.stone, verse: b.verse, label: b.label,
  status: b.status, source: b.source, notes: b.notes, push: b.status === 'confirmed' ? pushState(db, b.id) : null,
});

function awardStatus(db, girlId, awardId) {
  const items = awardRequirements(db, awardId).map((r) => {
    const c = db.prepare("SELECT status, completed_on FROM completions WHERE girl_id = ? AND requirement_id = ? AND status <> 'rejected'").get(girlId, r.id);
    return { requirementId: r.id, number: r.number, letter: r.letter, title: r.title, status: c ? c.status : null, completedOn: c ? c.completed_on : null };
  });
  return { done: items.filter((i) => i.status === 'confirmed').length, total: items.length, complete: items.length > 0 && items.every((i) => i.status === 'confirmed'), items };
}

/** Every active Pathfinder with her bead counts, beads, stones, verses and award progress. */
function tracker(db) {
  const c = pfConfig();
  return {
    stones: c.stones.map((s) => ({ number: s.number, name: s.name, verse: s.verse })),
    girls: pathfinders(db).sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name)).map((g) => {
      const beads = db.prepare("SELECT * FROM pf_beads WHERE girl_id = ? AND status <> 'rejected' ORDER BY earned_on, id").all(g.id);
      const confirmed = beads.filter((b) => b.status === 'confirmed');
      const counts = Object.fromEntries(KINDS.map((k) => [k, confirmed.filter((b) => b.kind === k).length]));
      const pendingCounts = Object.fromEntries(KINDS.map((k) => [k, beads.filter((b) => b.kind === k && b.status === 'proposed').length]));
      return {
        id: g.id, firstName: g.first_name, lastName: g.last_name, nickname: g.nickname, mapped: !!g.ahg_youth_id,
        counts, pending: pendingCounts,
        stones: Object.fromEntries(confirmed.filter((b) => b.kind === 'stone').map((b) => [b.stone, b.earned_on])),
        verses: Object.fromEntries(confirmed.filter((b) => b.kind === 'verse').map((b) => [b.verse, { beadId: b.id, earnedOn: b.earned_on, stone: b.stone }])),
        beads: beads.map((b) => beadOut(db, b)),
        fannyCrosby: awardStatus(db, g.id, c.fannyCrosby),
        joining: awardStatus(db, g.id, c.joining),
      };
    }),
  };
}

/** What waits on a leader: proposed beads, and proposed Fanny Crosby / Joining completions for Pathfinders. */
function pending(db) {
  const allowed = plannableRequirementIds(db);
  const beads = db.prepare(`SELECT b.*, g.first_name, g.last_name, g.nickname, e.title AS event_title FROM pf_beads b
                            JOIN girls g ON g.id = b.girl_id LEFT JOIN events e ON e.id = b.event_id
                            WHERE b.status = 'proposed' ORDER BY b.earned_on, b.event_id, g.last_name, g.first_name, b.kind`).all()
    .map((b) => ({ ...beadOut(db, b), girlId: b.girl_id, firstName: b.first_name, lastName: b.last_name, nickname: b.nickname, eventTitle: b.event_title, stoneName: b.stone ? (stoneOf(b.stone) || {}).name : null }));
  const completions = db.prepare(`SELECT c.*, g.first_name, g.last_name, g.nickname, r.number, r.letter, r.title, b.name AS badge_name, e.title AS event_title
                                  FROM completions c JOIN girls g ON g.id = c.girl_id JOIN requirements r ON r.id = c.requirement_id
                                  JOIN badges b ON b.id = r.badge_id LEFT JOIN events e ON e.id = c.event_id
                                  WHERE c.status = 'proposed' AND g.ahg_level = 'Pathfinder' ORDER BY c.completed_on, g.last_name, g.first_name, r.number`).all()
    .filter((c) => allowed.has(c.requirement_id))
    .map((c) => ({ completionId: c.id, girlId: c.girl_id, firstName: c.first_name, lastName: c.last_name, nickname: c.nickname, badgeName: c.badge_name,
      requirementId: c.requirement_id, number: c.number, letter: c.letter, title: c.title, completedOn: c.completed_on, eventId: c.event_id, eventTitle: c.event_title, notes: c.notes }));
  return { beads, completions, total: beads.length + completions.length };
}

/** Confirm/reject Fanny Crosby / Joining completions from the Pathfinder page (the Review page's rules). */
function decideCompletions(db, decisions, actor, { tz }) {
  const allowed = plannableRequirementIds(db);
  for (const d of decisions || []) {
    const c = db.prepare('SELECT requirement_id FROM completions WHERE id = ?').get(d.completionId);
    if (c && !allowed.has(c.requirement_id)) throw new PathfinderError(400, `completion ${d.completionId} is not a Pathfinder award requirement — decide it on the Review page`);
  }
  try {
    return decideRows(db, decisions, actor, { tz });
  } catch (e) {
    if (e instanceof CompletionError) throw new PathfinderError(e.status, e.message);
    throw e;
  }
}

module.exports = {
  KINDS, SLOTS, ATTENDANCE_SOURCES, PathfinderError, pfConfig, setPfConfig,
  program, attendanceSource, setAttendanceSource, defaultVerseDate,
  getPlan, putPlan, listPlans, plannedEventIds,
  proposeForEvent, rescan,
  beadLine, beadAwardId, queueBead, decideBeads, addBead, removeBead, proposeDerived,
  tracker, pending, decideCompletions,
};
