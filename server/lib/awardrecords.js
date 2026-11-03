'use strict';
/**
 * AHGFamily's whole-award records. An award can be complete there (a record
 * with a completed date, on the profile's awards grid) while its requirement
 * boxes stay blank, as on older records. The service pull mirrors those
 * records into award_instances; anything that asks "has she earned this?"
 * checks them here as well as the boxes.
 *
 * Also: which level a girl was at on a date. AHGFamily's records don't say,
 * so it comes from the badge when the badge has one level, else from the
 * level stamp on her service ledger.
 */
const LEVEL_ORDER = ['Pathfinder', 'Tenderheart', 'Explorer', 'Pioneer', 'Patriot'];

/** Earliest completed record of an award for her: YYYY-MM-DD, or null. */
function wholeAward(db, girlId, awardId) {
  if (!awardId) return null;
  const r = db.prepare(`SELECT MIN(completed_on) AS d FROM award_instances
    WHERE girl_id = ? AND ahg_award_id = ? AND missing_since IS NULL AND completed_on IS NOT NULL`).get(girlId, awardId);
  return r ? r.d : null;
}

/** Same, for the award a requirement belongs to. */
function wholeAwardForRequirement(db, girlId, requirementId) {
  const b = db.prepare('SELECT b.ahg_award_id AS a FROM requirements r JOIN badges b ON b.id = r.badge_id WHERE r.id = ?').get(requirementId);
  return b ? wholeAward(db, girlId, b.a) : null;
}

/** Her level on a date, from the ledger: the latest stamp on or before it, else her earliest stamp. */
function levelOnDate(db, girlId, date) {
  const rows = db.prepare('SELECT date, level FROM service_hours WHERE girl_id = ? AND date IS NOT NULL AND level IS NOT NULL ORDER BY date').all(girlId)
    .filter((r) => LEVEL_ORDER.includes(r.level));
  if (!rows.length || !date) return null;
  const before = rows.filter((r) => r.date <= date);
  return before.length ? before[before.length - 1].level : rows[0].level;
}

/** The level a completion of this badge counts at. */
function levelForCompletion(db, girl, levelGroup, date) {
  if (levelGroup === 'Pathfinders') return 'Pathfinder';
  if (LEVEL_ORDER.includes(levelGroup)) return levelGroup;
  const at = levelOnDate(db, girl.id, date) || girl.ahg_level;
  // a Pioneer/Patriot badge can't count below Pioneer, whatever an old stamp says
  if (levelGroup === 'Pioneer/Patriot' && at !== 'Pioneer' && at !== 'Patriot') return 'Pioneer';
  return at;
}

module.exports = { wholeAward, wholeAwardForRequirement, levelOnDate, levelForCompletion };
