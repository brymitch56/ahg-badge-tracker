'use strict';
/**
 * The Faith tab (migration 011): the Faith Award, faith badges, and
 * standalone Bible studies.
 *
 * The Faith Award is AHGFamily's "B.Y. Faith Award" — one award per level,
 * each a single "complete one of the following studies" list, built from
 * AHGFamily's short titles (scripts/build-badges.js, catalog-only) and
 * tagged `faith = 'award'`. Some studies on the list are faith badges
 * (handbook/faith.json `links`): earning the badge at a level satisfies
 * that level's award item. That is derived here, never written behind a
 * leader's back — the Faith tab shows "ready to record" and a leader
 * records it (a manual completion, which then flows to AHGFamily like any
 * other). Every other study (patch programs, outside studies) is planned
 * and completed on the award item itself, through the usual attendance
 * proposals.
 *
 * Standalone Bible studies (faith_studies) are planned per meeting with a
 * lesson so a substitute knows where the unit is; nobody completes them.
 *
 * Faith Award studies (badges with faith = 'study') are the guide's studies
 * broken into steps per level — chapters, lessons, "choose N of these" — so
 * a unit plans them step by step like a badge. They are tracker-owned:
 * loaded from data/faith-studies/ (the AHG Faith Award Program Guide is
 * copyrighted, so never git), kept out of the catalog build and of every
 * AHGFamily pull and push. A finished study makes its award item ready to
 * record, like a faith badge; a study AHGFamily doesn't list yet (7 C's,
 * Biblical Worldview) counts as earned here and is marked on AHGFamily by
 * hand.
 */
const fs = require('fs');
const path = require('path');
const { PLAN_LEVEL_GROUPS, PlanError, yearOverview } = require('./plans');
const { PLAN_GIRL_LEVELS, badgeStatusFor, manualCompletion, CompletionError } = require('./proposals');

const LEVELS = ['Tenderheart', 'Explorer', 'Pioneer', 'Patriot'];
const FAITH_FILE = path.join(__dirname, '..', '..', 'handbook', 'faith.json');

let cached = null;
function faithConfig() {
  if (!cached) {
    try { cached = JSON.parse(fs.readFileSync(FAITH_FILE, 'utf8')); } catch { cached = { faithAward: {}, faithBadges: [], links: {} }; }
  }
  return cached;
}
// tests use invented award ids
const setFaithConfig = (c) => { cached = c; };

// same loose compare as scripts/build-badges.js (catalog names drift in case
// and punctuation: "Daughter Of The King")
const norm = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

/** Does a badge of this catalog level group count at this girl level? */
const covers = (badgeLevelGroup, level) => badgeLevelGroup === 'All' || badgeLevelGroup === level
  || (badgeLevelGroup === 'Pioneer/Patriot' && (level === 'Pioneer' || level === 'Patriot'));

const isRetired = (r) => JSON.parse(r.flags || '[]').includes('retired');

/** The award badge row for one level, or null while it isn't imported. */
function awardBadge(db, level) {
  const id = faithConfig().faithAward[level];
  return id ? db.prepare("SELECT * FROM badges WHERE ahg_award_id = ? AND active = 1").get(id) || null : null;
}

const studyItem = (b) => { try { return JSON.parse(b.json).awardItem || null; } catch { return null; } };

/**
 * What satisfies an award item title at a level: the faith badge named by
 * handbook/faith.json `links`, and any Faith Award study whose `awardItem`
 * is that title. Each row carries `kind` ('badge' | 'study').
 */
function linkedBadges(db, title, level) {
  const target = faithConfig().links[title];
  const out = [];
  if (target) {
    for (const b of db.prepare("SELECT * FROM badges WHERE active = 1 AND faith = 'badge'").all()) {
      if (norm(b.name) === norm(target) && covers(b.level_group, level)) out.push({ ...b, kind: 'badge' });
    }
  }
  for (const b of db.prepare("SELECT * FROM badges WHERE active = 1 AND faith = 'study'").all()) {
    const item = studyItem(b);
    if (item && norm(item) === norm(title) && covers(b.level_group, level)) out.push({ ...b, kind: 'study' });
  }
  return out;
}

/**
 * Everything the Faith tab's pickers need: each level's Faith Award with its
 * studies (retired ones flagged, linked badges resolved), the faith badges,
 * and the standalone studies. `missing` names levels whose award isn't
 * imported yet.
 */
function faithCatalog(db, { allStudies = false } = {}) {
  const awards = [];
  const missing = [];
  for (const level of LEVELS) {
    const b = awardBadge(db, level);
    if (!b) { missing.push(level); continue; }
    const items = db.prepare('SELECT * FROM requirements WHERE badge_id = ? AND active = 1 ORDER BY number, letter').all(b.id).map((r) => ({
      requirementId: r.id,
      number: r.number,
      title: r.title,
      retired: isRetired(r),
      linkedBadges: linkedBadges(db, r.title, level).map((x) => ({ badgeId: x.id, name: x.name, levelGroup: x.level_group, kind: x.kind })),
    }));
    awards.push({ level, badgeId: b.id, awardId: b.ahg_award_id, name: b.name, items });
  }
  const badges = db.prepare("SELECT id, name, level_group, frontier, text_source FROM badges WHERE active = 1 AND faith = 'badge' ORDER BY name, level_group").all()
    .map((b) => ({ badgeId: b.id, name: b.name, levelGroup: b.level_group, frontier: b.frontier, textSource: b.text_source }));
  const awardStudies = db.prepare("SELECT * FROM badges WHERE active = 1 AND faith = 'study' ORDER BY name, level_group").all().map((b) => {
    const j = JSON.parse(b.json);
    const reqs = db.prepare('SELECT flags FROM requirements WHERE badge_id = ? AND active = 1').all(b.id);
    return {
      badgeId: b.id, name: b.name, levelGroup: b.level_group, awardItem: j.awardItem || null, about: j.about || null, source: j.source || null,
      stepCount: reqs.length, placeholders: reqs.filter((r) => JSON.parse(r.flags || '[]').includes('placeholder')).length,
    };
  });
  return { levels: LEVELS, awards, missing, badges, awardStudies, studies: listStudies(db, { all: allStudies }) };
}

// ------------------------------------------------------------- awards ---
/** Date a badge became complete for her: the latest of its confirmed completions. */
const badgeDoneOn = (db, girlId, badgeId) => db.prepare(`SELECT MAX(c.completed_on) AS d,
    (SELECT c2.level_at_completion FROM completions c2 JOIN requirements r2 ON r2.id = c2.requirement_id
     WHERE c2.girl_id = ? AND r2.badge_id = ? AND c2.status = 'confirmed' ORDER BY c2.completed_on DESC, c2.id DESC LIMIT 1) AS lvl
  FROM completions c JOIN requirements r ON r.id = c.requirement_id
  WHERE c.girl_id = ? AND r.badge_id = ? AND c.status = 'confirmed'`).get(girlId, badgeId, girlId, badgeId);

/** Where a linked badge or study stands for her at one award level (a multi-level one counts at the level she finished it at). */
function finishedAt(db, girl, b, level) {
  const st = badgeStatusFor(db, girl.id, b.id);
  if (st.status !== 'complete') return { status: st.status, confirmedCount: st.confirmedCount };
  const done = badgeDoneOn(db, girl.id, b.id);
  // with no level on record, her current level
  const at = done.lvl || girl.ahg_level;
  const multi = b.level_group === 'All' || b.level_group === 'Pioneer/Patriot';
  return multi && at !== level ? { status: 'elsewhere' } : { status: 'complete', completedOn: done.d };
}

/**
 * One girl's Faith Award at one level: earned (an item confirmed — from a
 * meeting, by hand, or from AHGFamily), pending (an item proposed, waiting
 * on Review), ready (a linked badge is complete but the award item isn't
 * recorded), and what's under way (linked badges in progress).
 */
function girlAwardAtLevel(db, girl, level) {
  const award = awardBadge(db, level);
  if (!award) return null;
  const reqs = db.prepare('SELECT * FROM requirements WHERE badge_id = ? AND active = 1 ORDER BY number').all(award.id);
  const live = new Map(db.prepare(`SELECT c.* FROM completions c JOIN requirements r ON r.id = c.requirement_id
    WHERE c.girl_id = ? AND r.badge_id = ? AND c.status <> 'rejected'`).all(girl.id, award.id).map((c) => [c.requirement_id, c]));
  const earned = [];
  const pending = [];
  const ready = [];
  const underway = [];
  for (const r of reqs) {
    const c = live.get(r.id);
    if (c && c.status === 'confirmed') { earned.push({ requirementId: r.id, title: r.title, completedOn: c.completed_on, source: c.source, notes: c.notes }); continue; }
    if (c) { pending.push({ requirementId: r.id, title: r.title, completedOn: c.completed_on, completionId: c.id }); continue; }
    for (const b of linkedBadges(db, r.title, level)) {
      const st = finishedAt(db, girl, b, level);
      const via = { requirementId: r.id, title: r.title, viaBadgeId: b.id, viaBadgeName: b.name, viaKind: b.kind };
      if (st.status === 'complete') ready.push({ ...via, completedOn: st.completedOn });
      else if (st.status === 'in_progress') underway.push({ ...via, confirmedCount: st.confirmedCount });
    }
  }
  // studies AHGFamily doesn't list at this level: finishing one earns the
  // award here, and a leader marks it on AHGFamily by hand
  const titles = new Set(reqs.map((r) => norm(r.title)));
  const offline = [];
  for (const b of db.prepare("SELECT * FROM badges WHERE active = 1 AND faith = 'study'").all()) {
    const item = studyItem(b);
    if (!covers(b.level_group, level) || (item && titles.has(norm(item)))) continue;
    const st = finishedAt(db, girl, b, level);
    const via = { requirementId: null, title: b.name, viaBadgeId: b.id, viaBadgeName: b.name, viaKind: 'study' };
    if (st.status === 'complete') offline.push({ ...via, completedOn: st.completedOn });
    else if (st.status === 'in_progress') underway.push({ ...via, confirmedCount: st.confirmedCount });
  }
  const status = earned.length || offline.length ? 'earned' : pending.length ? 'pending' : ready.length ? 'ready' : underway.length ? 'in_progress' : 'not_started';
  return { level, badgeId: award.id, status, earned, offline, pending, ready, underway };
}

/**
 * Every active girl at Tenderheart or above: her current level's Faith
 * Award, and every earlier level's (a pin she earned, or missed).
 */
function awardStatus(db) {
  const girls = db.prepare(`SELECT * FROM girls WHERE active = 1 AND ahg_level IN (${LEVELS.map(() => '?').join(',')}) ORDER BY last_name, first_name`).all(...LEVELS);
  return {
    levels: LEVELS.filter((l) => awardBadge(db, l)),
    girls: girls.map((g) => ({
      girlId: g.id, firstName: g.first_name, lastName: g.last_name, nickname: g.nickname, ahgLevel: g.ahg_level,
      unit: Object.keys(PLAN_GIRL_LEVELS).find((u) => PLAN_GIRL_LEVELS[u].includes(g.ahg_level)) || null,
      awards: LEVELS.slice(0, LEVELS.indexOf(g.ahg_level) + 1).map((l) => girlAwardAtLevel(db, g, l)).filter(Boolean),
    })),
  };
}

/**
 * Record award items satisfied by a linked faith badge. rows = [{ girlId,
 * requirementId }]. Each is re-derived (the badge must still be complete),
 * then written as a confirmed manual completion dated the day the badge
 * was finished — from there it queues for AHGFamily like any completion.
 */
function recordLinked(db, rows, actor) {
  if (!Array.isArray(rows) || !rows.length) throw new CompletionError(400, 'body must be [{ girlId, requirementId }, …]');
  const run = db.transaction(() => rows.map((row, i) => {
    const girl = db.prepare('SELECT * FROM girls WHERE id = ?').get(Number(row && row.girlId));
    if (!girl) throw new CompletionError(400, `rows[${i}]: unknown girl`);
    const req = db.prepare("SELECT r.*, b.ahg_award_id FROM requirements r JOIN badges b ON b.id = r.badge_id WHERE r.id = ? AND b.faith = 'award'").get(String(row.requirementId || ''));
    if (!req) throw new CompletionError(400, `rows[${i}]: not a Faith Award item`);
    const level = Object.keys(faithConfig().faithAward).find((l) => faithConfig().faithAward[l] === req.ahg_award_id);
    const st = girlAwardAtLevel(db, girl, level);
    const hit = st && st.ready.find((x) => x.requirementId === req.id);
    if (!hit) throw new CompletionError(409, `rows[${i}]: ${girl.first_name}'s ${req.title} isn't ready to record (badge or study not complete, or already recorded)`);
    const c = manualCompletion(db, {
      girlId: girl.id, requirementId: req.id, completedOn: hit.completedOn,
      notes: hit.viaKind === 'study' ? `Completed the ${hit.viaBadgeName} study` : `Earned the ${hit.viaBadgeName} badge`,
    }, actor);
    return { completionId: c.id, girlId: girl.id, requirementId: req.id, completedOn: c.completed_on, viaBadgeId: hit.viaBadgeId };
  }));
  return run();
}

// ----------------------------------------------- Faith Award studies ---
class StudyError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// level group → id suffix (the catalog build's codes)
const LEVEL_CODES = { All: 'all', Tenderheart: 'tend', Explorer: 'expl', Pioneer: 'pion', Patriot: 'patr', 'Pioneer/Patriot': 'pipa' };
const LEVELS_OF = { All: LEVELS, 'Pioneer/Patriot': ['Pioneer', 'Patriot'] };
const slugOk = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(s);

/**
 * Load Faith Award study definitions ({ studies: [{ slug, name, awardItem,
 * about, source, variants: [{ levelGroup, groups: [{ label, rule, steps:
 * [{ title, text?, placeholder? }] }] }] }] }) as tracker-owned badges.
 * Insert-only: a study/level already loaded is left exactly as it is, so
 * leaders' renamed steps and every plan and completion on it survive a
 * re-load. Returns { added, kept }.
 */
function importStudies(db, defs, actor) {
  const studies = (defs && defs.studies) || [];
  if (!Array.isArray(studies) || !studies.length) throw new StudyError(400, 'no studies in the definition file');
  const version = db.prepare("SELECT value FROM settings WHERE key = 'catalog_version'").get();
  if (!version) throw new StudyError(409, 'import the badge catalog first (Admin → Re-import)');
  const errs = [];
  for (const [i, s] of studies.entries()) {
    if (!slugOk(s.slug) || !s.name || !Array.isArray(s.variants)) { errs.push(`studies[${i}]: slug, name and variants required`); continue; }
    for (const v of s.variants) {
      if (!LEVEL_CODES[v.levelGroup]) errs.push(`${s.slug}: unknown level group ${v.levelGroup}`);
      for (const g of v.groups || []) {
        if (!g.rule || !['all', 'n_of'].includes(g.rule.type)) errs.push(`${s.slug} ${v.levelGroup} "${g.label}": rule must be all or n_of`);
        if (!Array.isArray(g.steps) || !g.steps.length || g.steps.some((x) => !x || !x.title)) errs.push(`${s.slug} ${v.levelGroup} "${g.label}": every step needs a title`);
        if (g.rule && g.rule.type === 'n_of' && !(g.rule.n >= 1 && g.rule.n <= (g.steps || []).length)) errs.push(`${s.slug} ${v.levelGroup} "${g.label}": n out of range`);
      }
    }
  }
  if (errs.length) throw new StudyError(400, `study definitions refused:\n  ${errs.join('\n  ')}`);

  const now = new Date().toISOString();
  const added = [];
  const kept = [];
  const run = db.transaction(() => {
    for (const s of studies) {
      for (const v of s.variants) {
        const id = `study-${s.slug}-${LEVEL_CODES[v.levelGroup]}`;
        if (db.prepare('SELECT 1 FROM badges WHERE id = ?').get(id)) { kept.push(id); continue; }
        let n = 0;
        const groups = v.groups.map((g) => ({
          label: g.label, rule: g.rule.type === 'n_of' ? { type: 'n_of', n: g.rule.n } : { type: 'all' },
          requirements: g.steps.map((x) => {
            n += 1;
            return { number: n, ahgFamilyId: `study:${id}:${n}`, title: x.title, text: x.text || x.title, subItems: [], flags: x.placeholder ? ['placeholder'] : [] };
          }),
        }));
        const json = {
          id, awardId: `study:${id}`, name: s.name, levelGroup: v.levelGroup, levels: LEVELS_OF[v.levelGroup] || [v.levelGroup],
          faith: 'study', textSource: 'guide', awardItem: s.awardItem || null, about: s.about || null, source: s.source || null,
          groups, requirementCount: n,
        };
        db.prepare(`INSERT INTO badges (id, catalog_version_id, ahg_award_id, name, level_group, frontier, levels, classic, pages, image_paths, faith, text_source, json, active)
                    VALUES (?, ?, ?, ?, ?, NULL, ?, 0, '[]', '[]', 'study', 'guide', ?, 1)`)
          .run(id, JSON.parse(version.value), json.awardId, s.name, v.levelGroup, JSON.stringify(json.levels), JSON.stringify(json));
        groups.forEach((g, gi) => {
          const gid = `${id}:${gi + 1}`;
          db.prepare('INSERT INTO badge_groups (id, badge_id, position, label, rule_type, rule_n) VALUES (?, ?, ?, ?, ?, ?)')
            .run(gid, id, gi + 1, g.label, g.rule.type, g.rule.type === 'n_of' ? g.rule.n : null);
          for (const r of g.requirements) {
            db.prepare(`INSERT INTO requirements (id, badge_id, group_id, number, letter, ahg_requirement_id, title, text, sub_items, flags, active)
                        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, '[]', ?, 1)`)
              .run(`${id}:${r.number}`, id, gid, r.number, r.ahgFamilyId, r.title, r.text, JSON.stringify(r.flags));
          }
        });
        added.push(id);
      }
    }
    db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(now, actor, 'faith_studies.import', 'badge', null, null, JSON.stringify({ added, kept: kept.length }));
  });
  run();
  return { added, kept };
}

/** Every *.json in a directory, loaded in name order. */
function importStudiesFromDir(db, dir, actor) {
  if (!fs.existsSync(dir)) throw new StudyError(404, `no study definitions at ${dir}`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) throw new StudyError(404, `no study definitions at ${dir}`);
  const out = { added: [], kept: [], files };
  for (const f of files) {
    const r = importStudies(db, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), actor);
    out.added.push(...r.added);
    out.kept.push(...r.kept);
  }
  return out;
}

/**
 * Rename a study step — how a placeholder ("Activity 2") becomes the
 * activity the unit chose. Study steps only; catalog badges come from the
 * build. The badge's stored JSON follows, so the planner shows the new name.
 */
function updateStep(db, requirementId, body, actor) {
  const r = db.prepare("SELECT r.* FROM requirements r JOIN badges b ON b.id = r.badge_id WHERE r.id = ? AND b.faith = 'study'").get(String(requirementId));
  if (!r) throw new StudyError(404, 'not a Faith Award study step');
  const b = body || {};
  const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 200) : r.title;
  const text = typeof b.text === 'string' && b.text.trim() ? b.text.trim().slice(0, 4000) : (title !== r.title && r.text === r.title ? title : r.text);
  // a renamed placeholder is a real step now
  const flags = JSON.parse(r.flags || '[]').filter((f) => !(f === 'placeholder' && title !== r.title));
  const run = db.transaction(() => {
    db.prepare('UPDATE requirements SET title = ?, text = ?, flags = ? WHERE id = ?').run(title, text, JSON.stringify(flags), r.id);
    const row = db.prepare('SELECT json FROM badges WHERE id = ?').get(r.badge_id);
    const j = JSON.parse(row.json);
    for (const g of j.groups) for (const q of g.requirements) if (q.number === r.number) Object.assign(q, { title, text, flags });
    db.prepare('UPDATE badges SET json = ? WHERE id = ?').run(JSON.stringify(j), r.badge_id);
    db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), actor, 'faith_step.update', 'requirement', r.id, JSON.stringify({ title: r.title, text: r.text }), JSON.stringify({ title, text }));
  });
  run();
  return { requirementId: r.id, title, text, placeholder: flags.includes('placeholder') };
}

// ------------------------------------------------------------ studies ---
const studyOut = (s) => ({
  id: s.id, title: s.title, description: s.description, units: JSON.parse(s.units || '[]'), active: !!s.active,
  createdBy: s.created_by, createdAt: s.created_at, updatedAt: s.updated_at,
});

function listStudies(db, { all = false } = {}) {
  return db.prepare(`SELECT * FROM faith_studies ${all ? '' : 'WHERE active = 1'} ORDER BY active DESC, title`).all().map(studyOut);
}

function cleanStudy(body, { partial = false } = {}) {
  const b = body || {};
  const out = {};
  if (!partial || 'title' in b) {
    if (typeof b.title !== 'string' || !b.title.trim()) throw new PlanError(400, 'title required');
    out.title = b.title.trim().slice(0, 200);
  }
  if ('description' in b) out.description = typeof b.description === 'string' && b.description.trim() ? b.description.trim().slice(0, 4000) : null;
  if (!partial || 'units' in b) {
    const units = b.units == null ? [] : b.units;
    if (!Array.isArray(units) || units.some((u) => !PLAN_LEVEL_GROUPS.includes(u))) throw new PlanError(400, `units must be a list of ${PLAN_LEVEL_GROUPS.join(' | ')} (empty = every unit)`);
    out.units = JSON.stringify([...new Set(units)]);
  }
  if ('active' in b) out.active = b.active ? 1 : 0;
  return out;
}

const auditStudy = (db, actor, action, id, before, after) => db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(new Date().toISOString(), actor, action, 'faith_study', String(id), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);

function createStudy(db, body, actor) {
  const v = cleanStudy(body);
  const now = new Date().toISOString();
  const id = Number(db.prepare('INSERT INTO faith_studies (title, description, units, active, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
    .run(v.title, v.description || null, v.units, actor, now, now).lastInsertRowid);
  auditStudy(db, actor, 'faith_study.create', id, null, v);
  return studyOut(db.prepare('SELECT * FROM faith_studies WHERE id = ?').get(id));
}

/** Edit or retire (active: false) a study. Retired studies stay on the plans that used them. */
function updateStudy(db, id, body, actor) {
  const before = db.prepare('SELECT * FROM faith_studies WHERE id = ?').get(Number(id));
  if (!before) throw new PlanError(404, 'not found');
  const v = cleanStudy(body, { partial: true });
  if (!Object.keys(v).length) throw new PlanError(400, 'nothing to change (title, description, units, active)');
  v.updated_at = new Date().toISOString();
  db.prepare(`UPDATE faith_studies SET ${Object.keys(v).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(v), before.id);
  auditStudy(db, actor, 'faith_study.update', before.id, studyOut(before), v);
  return studyOut(db.prepare('SELECT * FROM faith_studies WHERE id = ?').get(before.id));
}

// --------------------------------------------------------------- year ---
/**
 * The whole faith plan for [from, to], per unit: every meeting with faith
 * items or studies, in date order, so anyone can see what was done and
 * what comes next. `studies` tracks each standalone study's lessons across
 * the window (where to pick up); `coverage` is the program-year view of the
 * faith track's badges and award items.
 */
function faithYear(db, { from, to }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw new PlanError(400, 'from and to must be YYYY-MM-DD');
  const end = `${to}T${String.fromCharCode(0xffff)}`;
  const nowIso = new Date().toISOString();
  const plans = db.prepare(`SELECT p.*, e.title, e.start_at, e.end_at, e.removed_from_feed FROM plans p JOIN events e ON e.id = p.event_id
    WHERE e.start_at >= ? AND e.start_at <= ? ORDER BY e.start_at, e.id`).all(from, end);
  const units = new Map(PLAN_LEVEL_GROUPS.map((u) => [u, []]));
  const studyLog = new Map(); // studyId → { title, sessions: [] }
  for (const p of plans) {
    const items = db.prepare(`SELECT pi.requirement_id, pi.role, pi.notes, r.number, r.letter, r.title, b.id AS badge_id, b.name AS badge_name, b.faith
      FROM plan_items pi JOIN requirements r ON r.id = pi.requirement_id JOIN badges b ON b.id = r.badge_id
      WHERE pi.plan_id = ? AND pi.track = 'faith' ORDER BY pi.position`).all(p.id);
    const studies = db.prepare(`SELECT ps.study_id, ps.lesson, ps.notes, ps.position, s.title FROM plan_studies ps JOIN faith_studies s ON s.id = ps.study_id
      WHERE ps.plan_id = ? ORDER BY ps.position`).all(p.id);
    if (!items.length && !studies.length && !p.faith_notes) continue;
    const past = (p.end_at || p.start_at) <= nowIso;
    units.get(p.level_group).push({
      eventId: p.event_id, title: p.title, startAt: p.start_at, past, removedFromFeed: !!p.removed_from_feed, notes: p.faith_notes,
      items: items.map((i) => ({ requirementId: i.requirement_id, badgeId: i.badge_id, badgeName: i.badge_name, faith: i.faith, number: i.number, letter: i.letter, title: i.title, role: i.role, notes: i.notes })),
      studies: studies.map((s) => ({ studyId: s.study_id, title: s.title, lesson: s.lesson, notes: s.notes })),
    });
    for (const s of studies) {
      const log = studyLog.get(s.study_id) || studyLog.set(s.study_id, { studyId: s.study_id, title: s.title, sessions: [] }).get(s.study_id);
      log.sessions.push({ unit: p.level_group, eventId: p.event_id, startAt: p.start_at, past, lesson: s.lesson });
    }
  }
  const coverage = yearOverview(db, { from, to, track: 'faith' }).units;
  return {
    from, to,
    units: [...units].map(([unit, meetings]) => ({ unit, meetings })),
    // where each unit left off and what's next, per study
    studies: [...studyLog.values()].map((s) => ({
      ...s,
      byUnit: Object.fromEntries([...new Set(s.sessions.map((x) => x.unit))].map((u) => {
        const mine = s.sessions.filter((x) => x.unit === u);
        return [u, { lastHeld: [...mine].reverse().find((x) => x.past) || null, next: mine.find((x) => !x.past) || null }];
      })),
    })),
    coverage,
  };
}

module.exports = { LEVELS, faithConfig, setFaithConfig, faithCatalog, importStudies, importStudiesFromDir, updateStep, StudyError, awardStatus, girlAwardAtLevel, recordLinked, listStudies, createStudy, updateStudy, faithYear, covers };
