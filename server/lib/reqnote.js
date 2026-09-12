'use strict';
/**
 * The note the requirement push writes into AHGFamily's per-requirement
 * comment field, so the record on AHGFamily carries the whole story a
 * leader would otherwise have to dig out of the tracker:
 *
 *   - every planned meeting for the requirement THE GIRL ATTENDED, in date
 *     order, with that meeting's plan notes (item notes first, plan notes
 *     as fallback) — a requirement spanning several meetings lists several
 *     dates; a meeting she missed is left out of HER note;
 *   - a home completion's date and the leader's note;
 *   - and, when a planned session was missed, the leader's verification
 *     that the full requirement was still completed — dated and signed —
 *     because that is the decision a later reader most needs to see.
 *
 * Plain text, ' | '-separated, prefixed `tracker:` so hand-written comments
 * on AHGFamily are distinguishable from ours on the next pull. Capped, since
 * the field's limit on AHGFamily is unknown (step 5b measures it).
 */
const { sessionsFor, localDate } = require('./proposals');

const MAX_LEN = 1000;
const mdy = (isoDate) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate || '')); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(isoDate || ''); };
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function requirementNote(db, completion, { tz = 'UTC' } = {}) {
  const c = typeof completion === 'object' ? completion : db.prepare('SELECT * FROM completions WHERE id = ?').get(completion);
  if (!c) return '';
  const parts = [];

  if (c.source === 'attendance' || c.plan_item_id) {
    for (const s of sessionsFor(db, c.girl_id, c.requirement_id)) {
      if (!s.attended) continue; // her note lists only the meetings she was at
      const notes = clean(s.itemNotes || s.planNotes);
      parts.push(`${mdy(localDate(s.date, tz))} ${clean(s.title)}${notes ? ` — ${notes}` : ''}`);
    }
  }
  if (c.source === 'manual') {
    parts.push(`Completed at home ${mdy(c.completed_on)}${c.notes ? ` — ${clean(c.notes)}` : ''}`);
  } else if (c.notes) {
    parts.push(clean(c.notes));
  }
  const v = c.verification ? (typeof c.verification === 'string' ? JSON.parse(c.verification) : c.verification) : null;
  if (v && v.missed && v.missed.length) {
    const who = clean(v.verifiedBy || c.decided_by || 'leader');
    const when = mdy((v.verifiedAt || c.decided_at || '').slice(0, 10));
    parts.push(`Leader verified full completion (missed planned session${v.missed.length === 1 ? '' : 's'} ${v.missed.map(mdy).join(', ')})${v.note ? `: ${clean(v.note)}` : ''} — ${who}, ${when}`);
  }
  if (!parts.length) return '';
  let text = `tracker: ${parts.join(' | ')}`;
  if (text.length > MAX_LEN) text = `${text.slice(0, MAX_LEN - 1)}…`;
  return text;
}

module.exports = { requirementNote, MAX_LEN };
