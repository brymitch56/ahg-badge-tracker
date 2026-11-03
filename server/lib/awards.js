'use strict';
/**
 * The Awards tab: each level's Level Award, the Joining Award, the NCC
 * Catholic Faith Awards, and Stars & Stripes readiness, for Tenderheart and
 * up (Pathfinders keep theirs on the Pathfinder page).
 *
 * The awards are ordinary catalog badges, so meetings plan them and check-in
 * proposes them through the usual flow, and a leader records one by hand
 * through POST /completions; both reach AHGFamily like any completion.
 *
 * "Ready" is derived and never written behind a leader's back, like the
 * Faith tab: a finished badge in a frontier, a finished Faith Award or
 * enough Catholic segments, or enough service hours in a program year each
 * mark the matching level-award item ready to record.
 *
 * Stars & Stripes isn't on AHGFamily. Its badges and the Abigail Adams award
 * are derived; its other steps are tracker-only marks (award_marks), never
 * pulled or pushed.
 */
const fs = require('fs');
const path = require('path');
const { badgeStatusFor, CompletionError } = require('./proposals');
const faith = require('./faith');

const LEVELS = ['Tenderheart', 'Explorer', 'Pioneer', 'Patriot'];
const AWARDS_FILE = path.join(__dirname, '..', '..', 'handbook', 'awards.json');

let cached = null;
function awardsConfig() {
  if (!cached) {
    try { cached = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8')); } catch { cached = { levelAwards: {}, catholic: {}, derive: {} }; }
  }
  return cached;
}
// tests use invented award ids
const setAwardsConfig = (c) => { cached = c; };

const norm = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
const covers = (lg, level) => lg === 'All' || lg === level || (lg === 'Pioneer/Patriot' && (level === 'Pioneer' || level === 'Patriot'));

const badgeByAward = (db, awardId) => (awardId ? db.prepare('SELECT * FROM badges WHERE ahg_award_id = ? AND active = 1').get(awardId) || null : null);

/** Every award id the weekly pull should read, so an award earned on AHGFamily shows here. */
function pulledAwardIds() {
  const c = awardsConfig();
  return [...Object.values(c.levelAwards || {}), ...(c.joining ? [c.joining] : []), ...Object.values(c.catholic || {}).flat()];
}

function awardOut(db, b) {
  const reqs = db.prepare('SELECT * FROM requirements WHERE badge_id = ? AND active = 1 ORDER BY number, letter').all(b.id);
  return {
    badgeId: b.id, awardId: b.ahg_award_id, name: b.name, levelGroup: b.level_group,
    intro: b.intro || null, pages: JSON.parse(b.pages || '[]'), textSource: b.text_source || null,
    requirements: reqs.map((r) => ({
      id: r.id, number: r.number, letter: r.letter || null, title: r.title, text: r.text || r.title, subItems: JSON.parse(r.sub_items || '[]'),
    })),
  };
}

/** What the tab shows for each level; `missing` names awards not imported yet. */
function awardsCatalog(db) {
  const c = awardsConfig();
  const missing = [];
  const pick = (id) => { const b = badgeByAward(db, id); if (!b) missing.push(id); return b ? awardOut(db, b) : null; };
  const levels = LEVELS.map((level) => ({
    level,
    levelAward: pick(c.levelAwards[level]),
    catholic: (c.catholic[level] || []).map(pick).filter(Boolean),
  }));
  return { levels, joining: pick(c.joining), starsAndStripes: c.starsAndStripes || null, missing };
}

/** Program year (starts September 1) a date falls in, as its first calendar year. */
const programYear = (date) => { const [y, m] = date.split('-').map(Number); return m >= 9 ? y : y - 1; };

/** Program years at this level, oldest first, with her approved hours in each. */
function serviceYears(db, girlId, level) {
  const rows = db.prepare('SELECT date, hundredths FROM service_hours WHERE girl_id = ? AND level = ? AND verified = 1 AND date IS NOT NULL AND hundredths IS NOT NULL').all(girlId, level);
  const by = new Map();
  for (const r of rows) { const y = programYear(r.date); by.set(y, (by.get(y) || 0) + r.hundredths); }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([year, hundredths]) => ({ year, hours: hundredths / 100 }));
}

/** Badges she has any confirmed completion in; a badge outside this list can't be finished, so nothing else needs checking. */
const badgesTouched = (db, girlId) => db.prepare(`SELECT DISTINCT b.* FROM completions c JOIN requirements r ON r.id = c.requirement_id JOIN badges b ON b.id = r.badge_id
  WHERE c.girl_id = ? AND c.status = 'confirmed' AND b.active = 1 ORDER BY b.name`).all(girlId);

/** Her finished frontier badges at a level: frontier → [{ name, completedOn }], earliest first. */
function frontierBadges(db, girl, level) {
  const out = new Map();
  for (const b of badgesTouched(db, girl.id)) {
    if (!b.frontier || !covers(b.level_group, level)) continue;
    const st = faith.finishedAt(db, girl, b, level);
    if (st.status !== 'complete') continue;
    if (!out.has(b.frontier)) out.set(b.frontier, []);
    out.get(b.frontier).push({ name: b.name, completedOn: st.completedOn });
  }
  for (const list of out.values()) list.sort((x, y) => String(x.completedOn).localeCompare(String(y.completedOn)));
  return out;
}

/** Catholic segments finished at a level (the catalog names them "Segment n"). */
function catholicDone(db, girl, level) {
  const out = [];
  for (const id of awardsConfig().catholic[level] || []) {
    const b = badgeByAward(db, id);
    if (!b || !/segment/i.test(b.name)) continue;
    const st = faith.finishedAt(db, girl, b, level);
    if (st.status === 'complete') out.push(st.completedOn);
  }
  return out.sort();
}

/** requirementId → { why, completedOn } for items her record already proves. */
function readyItems(db, girl, level, award) {
  const d = (awardsConfig().derive || {})[level];
  const ready = new Map();
  if (!d) return ready;
  const frontiers = frontierBadges(db, girl, level);
  const faithAward = badgesTouched(db, girl.id).some((b) => b.faith) ? faith.girlAwardAtLevel(db, girl, level) : null;
  const segments = catholicDone(db, girl, level);
  const years = serviceYears(db, girl.id, level).filter((y) => y.hours >= d.serviceHours);
  for (const r of db.prepare('SELECT * FROM requirements WHERE badge_id = ? AND active = 1').all(award.id)) {
    if (r.number === d.frontier) {
      const front = [...frontiers.keys()].find((f) => norm(r.letter ? (r.title || '').split('—').pop() : '') === norm(f));
      if (front) ready.set(r.id, { why: `${frontiers.get(front)[0].name} badge finished`, completedOn: frontiers.get(front)[0].completedOn });
    } else if (r.number === d.faith) {
      if (faithAward && faithAward.status === 'earned') {
        const on = [...faithAward.earned, ...faithAward.offline].map((x) => x.completedOn).filter(Boolean).sort()[0] || null;
        ready.set(r.id, { why: 'Faith Award earned', completedOn: on });
      } else if (segments.length >= d.catholicSegments) {
        ready.set(r.id, { why: `${segments.length} Catholic Faith Award segment${segments.length === 1 ? '' : 's'} finished`, completedOn: segments[d.catholicSegments - 1] });
      }
    } else if (r.number === d.service) {
      // "1st year" is ready once one program year reached the hours, "2nd" once two did
      const n = Number((/—\s*(\d)/.exec(r.title || '') || [])[1]);
      const y = n ? years[n - 1] : null;
      if (y) ready.set(r.id, { why: `${y.hours} service hours in ${y.year}–${String(y.year + 1).slice(2)}`, completedOn: `${y.year + 1}-08-31` });
    }
  }
  return ready;
}

function girlAward(db, girl, badge, ready = new Map()) {
  const reqs = db.prepare('SELECT * FROM requirements WHERE badge_id = ? AND active = 1 ORDER BY number, letter').all(badge.id);
  const live = new Map(db.prepare(`SELECT c.* FROM completions c JOIN requirements r ON r.id = c.requirement_id
    WHERE c.girl_id = ? AND r.badge_id = ? AND c.status <> 'rejected'`).all(girl.id, badge.id).map((c) => [c.requirement_id, c]));
  const pushRow = db.prepare('SELECT status, last_error FROM push_queue WHERE completion_id = ? ORDER BY id DESC LIMIT 1');
  const items = {};
  let done = 0; let pending = 0; let readyCount = 0;
  for (const r of reqs) {
    const c = live.get(r.id);
    if (c) {
      const push = pushRow.get(c.id);
      items[r.id] = { status: c.status, completionId: c.id, completedOn: c.completed_on, source: c.source, notes: c.notes, push: push ? { status: push.status, error: push.last_error } : null };
      if (c.status === 'confirmed') done += 1; else pending += 1;
    } else if (ready.has(r.id)) {
      items[r.id] = { status: 'ready', ...ready.get(r.id) };
      readyCount += 1;
    }
  }
  return { done, total: reqs.length, pending, ready: readyCount, complete: badgeStatusFor(db, girl.id, badge.id).status === 'complete', items };
}

/** Where she stands on Stars & Stripes: the prerequisite, the required badges and the marked steps. */
function starsStatus(db, girl) {
  const c = awardsConfig();
  const s = c.starsAndStripes;
  if (!s) return null;
  const badges = badgesTouched(db, girl.id).filter((b) => b.level_group === 'Pioneer/Patriot');
  const finished = (name) => {
    const b = badges.find((x) => norm(x.name) === norm(name));
    return b && badgeStatusFor(db, girl.id, b.id).status === 'complete' ? b : null;
  };
  const required = s.requiredBadges.flatMap((f) => f.badges.map((name) => ({ frontier: f.frontier, name, done: !!finished(name) })));
  const taken = new Set([...required.map((r) => norm(r.name)), norm(s.fitnessBadge)]);
  const fitness = finished(s.fitnessBadge);
  const choice = badges.find((b) => b.frontier && !taken.has(norm(b.name)) && badgeStatusFor(db, girl.id, b.id).status === 'complete');
  const auto = { fitness: fitness ? `${fitness.name} badge finished` : null, choice: choice ? `${choice.name} badge finished` : null };
  const marks = new Map(db.prepare('SELECT * FROM award_marks WHERE girl_id = ?').all(girl.id).map((m) => [m.step, m]));
  const steps = s.steps.map((st) => {
    const m = marks.get(st.key);
    return { key: st.key, label: st.label, done: !!m || !!auto[st.key], doneOn: m ? m.done_on : null, notes: m ? m.notes : null, auto: auto[st.key] || null, marked: !!m };
  });
  const prereq = badgeByAward(db, c.levelAwards[s.prerequisite]);
  return {
    prerequisite: { name: prereq ? prereq.name : null, done: !!prereq && badgeStatusFor(db, girl.id, prereq.id).status === 'complete' },
    required, steps,
    done: required.filter((r) => r.done).length + steps.filter((st) => st.done).length,
    total: required.length + steps.length,
  };
}

/** Every active girl at Tenderheart or above, with each award up to her level. */
function awardsStatus(db) {
  const c = awardsConfig();
  const girls = db.prepare(`SELECT * FROM girls WHERE active = 1 AND ahg_level IN (${LEVELS.map(() => '?').join(',')}) ORDER BY last_name, first_name`).all(...LEVELS);
  const joining = badgeByAward(db, c.joining);
  return {
    girls: girls.map((g) => {
      const awards = {};
      for (const level of LEVELS.slice(0, LEVELS.indexOf(g.ahg_level) + 1)) {
        const la = badgeByAward(db, c.levelAwards[level]);
        if (la) awards[la.id] = { ...girlAward(db, g, la, readyItems(db, g, level, la)), serviceYears: serviceYears(db, g.id, level) };
        for (const id of c.catholic[level] || []) {
          const b = badgeByAward(db, id);
          if (b) awards[b.id] = girlAward(db, g, b);
        }
      }
      if (joining) awards[joining.id] = girlAward(db, g, joining);
      return {
        girlId: g.id, firstName: g.first_name, lastName: g.last_name, nickname: g.nickname, ahgLevel: g.ahg_level, mapped: !!g.ahg_youth_id,
        awards,
        starsAndStripes: g.ahg_level === 'Pioneer' || g.ahg_level === 'Patriot' ? starsStatus(db, g) : null,
      };
    }),
  };
}

function markStep(db, { girlId, step, doneOn, notes }, actor) {
  const s = awardsConfig().starsAndStripes;
  if (!s || !s.steps.some((x) => x.key === step)) throw new CompletionError(400, 'unknown Stars & Stripes step');
  if (!db.prepare('SELECT 1 FROM girls WHERE id = ?').get(Number(girlId))) throw new CompletionError(400, 'unknown girl');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(doneOn || '')) throw new CompletionError(400, 'doneOn must be YYYY-MM-DD');
  db.prepare(`INSERT INTO award_marks (girl_id, step, done_on, notes, marked_by, marked_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(girl_id, step) DO UPDATE SET done_on = excluded.done_on, notes = excluded.notes, marked_by = excluded.marked_by, marked_at = excluded.marked_at`)
    .run(Number(girlId), step, doneOn, notes || null, actor, new Date().toISOString());
}

function unmarkStep(db, { girlId, step }) {
  db.prepare('DELETE FROM award_marks WHERE girl_id = ? AND step = ?').run(Number(girlId), step);
}

module.exports = { LEVELS, awardsConfig, setAwardsConfig, pulledAwardIds, awardsCatalog, awardsStatus, markStep, unmarkStep };
