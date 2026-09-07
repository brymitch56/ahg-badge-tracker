'use strict';
/**
 * Mirror of the check-in app's events, roster and attendance
 * (spec §4 "People and events", §7 jobs, contract docs/13-integration-api.md).
 *
 * The check-in app owns attendance; this module only snapshots its answers.
 * Every sync records a sync_runs row. Webhook deliveries are de-duplicated
 * on txn id (at-least-once contract) and only ever trigger re-polls — the
 * payload itself is never treated as the attendance truth.
 */
const { CheckinError } = require('./checkin');

const AHG_LEVELS = ['Pathfinder', 'Tenderheart', 'Explorer', 'Pioneer', 'Patriot'];
const YOUTH_ID_RE = /^u[a-z0-9]{11}$/i;

const now = () => new Date().toISOString();
const isoDate = (d) => d.toISOString().slice(0, 10);

/** Exact match against the five program levels (blank = adult/unknown). */
function normalizeLevel(s) {
  const t = String(s || '').trim().toLowerCase();
  return AHG_LEVELS.find((l) => l.toLowerCase() === t) || null;
}

/** Wrap an async sync in a sync_runs row. Returns the run's summary. */
async function recordRun(db, kind, fn) {
  const { lastInsertRowid: id } = db.prepare('INSERT INTO sync_runs (kind, started_at) VALUES (?, ?)').run(kind, now());
  try {
    const summary = (await fn()) || {};
    db.prepare('UPDATE sync_runs SET finished_at = ?, ok = 1, summary = ? WHERE id = ?').run(now(), JSON.stringify(summary), id);
    return summary;
  } catch (e) {
    db.prepare('UPDATE sync_runs SET finished_at = ?, ok = 0, error = ? WHERE id = ?').run(now(), e.message, id);
    throw e;
  }
}

// ------------------------------------------------------------------ events --
/**
 * Upsert one Integration-API event row. Identity is ical_uid + start_at
 * (the same UNIQUE both apps use); manual events (ical_uid null) fall back
 * to checkin_event_id. A rescheduled feed event is a NEW identity on both
 * sides, so matching by checkin_event_id first is safe and keeps the mirror
 * aligned when the check-in app is reinstalled (ids change, identities don't).
 */
function upsertEvent(db, ev) {
  const ts = now();
  const found = db.prepare('SELECT id FROM events WHERE checkin_event_id = ?').get(ev.id)
    || (ev.ical_uid ? db.prepare('SELECT id FROM events WHERE ical_uid = ? AND start_at = ?').get(ev.ical_uid, ev.start_at) : null);
  if (found) {
    db.prepare(`UPDATE events SET checkin_event_id = ?, ical_uid = ?, start_at = ?, end_at = ?, title = ?, location = ?,
                all_day = ?, removed_from_feed = ?, updated_at = ? WHERE id = ?`)
      .run(ev.id, ev.ical_uid, ev.start_at, ev.end_at, ev.title, ev.location || null,
        ev.all_day ? 1 : 0, ev.removed_from_feed ? 1 : 0, ts, found.id);
    return { id: found.id, created: false };
  }
  const r = db.prepare(`INSERT INTO events (checkin_event_id, ical_uid, start_at, end_at, title, location, all_day, removed_from_feed, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ev.id, ev.ical_uid, ev.start_at, ev.end_at, ev.title, ev.location || null, ev.all_day ? 1 : 0, ev.removed_from_feed ? 1 : 0, ts);
  return { id: r.lastInsertRowid, created: true };
}

/** Pull the event window (spec §7: today−7 … today+90) and upsert. */
async function syncEvents(db, client, { from, to } = {}) {
  const today = new Date();
  from = from || isoDate(new Date(today.getTime() - 7 * 86400e3));
  to = to || isoDate(new Date(today.getTime() + 90 * 86400e3));
  return recordRun(db, 'checkin_events', async () => {
    const rows = await client.events({ from, to });
    let created = 0;
    for (const ev of rows) if (upsertEvent(db, ev).created) created += 1;
    return { from, to, fetched: rows.length, created, updated: rows.length - created };
  });
}

// ------------------------------------------------------------------- girls --
/**
 * Find the mirrored girl for an Integration-API person, by the contract's
 * matching order: member_id first, tlc_user_id second, person_id last.
 */
function findGirl(db, p) {
  return (p.member_id && db.prepare('SELECT * FROM girls WHERE member_id = ?').get(String(p.member_id)))
    || (p.tlc_user_id && YOUTH_ID_RE.test(p.tlc_user_id) && db.prepare('SELECT * FROM girls WHERE ahg_youth_id = ?').get(p.tlc_user_id.toLowerCase()))
    || db.prepare('SELECT * FROM girls WHERE checkin_person_id = ?').get(p.id ?? p.person_id)
    || null;
}

/**
 * Upsert one girl from a person/attendance row. Fill-when-empty rule for
 * ahg_youth_id (decision: never overwrite an existing mapping — sources are
 * checkin badge scans, the mapping screen, then manual).
 */
function upsertGirl(db, p, { status } = {}) {
  const ts = now();
  const personId = p.id ?? p.person_id;
  const st = status || p.status || 'active';
  const active = st === 'inactive' ? 0 : 1;
  const level = p.level || null;
  const g = findGirl(db, p);
  const youthId = p.tlc_user_id && YOUTH_ID_RE.test(p.tlc_user_id) ? p.tlc_user_id.toLowerCase() : null;
  if (g) {
    db.prepare(`UPDATE girls SET checkin_person_id = ?, member_id = COALESCE(?, member_id), first_name = ?, last_name = ?,
                nickname = ?, level = ?, ahg_level = ?, status = ?, active = ?, updated_at = ? WHERE id = ?`)
      .run(personId, p.member_id ? String(p.member_id) : null, p.first_name, p.last_name, p.nickname || null,
        level, normalizeLevel(level), st, active, ts, g.id);
    if (!g.ahg_youth_id && youthId && !db.prepare('SELECT 1 FROM girls WHERE ahg_youth_id = ?').get(youthId)) {
      db.prepare("UPDATE girls SET ahg_youth_id = ?, ahg_youth_id_source = 'checkin' WHERE id = ?").run(youthId, g.id);
    }
    return { id: g.id, created: false };
  }
  const canUseYouthId = youthId && !db.prepare('SELECT 1 FROM girls WHERE ahg_youth_id = ?').get(youthId);
  const r = db.prepare(`INSERT INTO girls (checkin_person_id, member_id, first_name, last_name, nickname, level, ahg_level,
                        ahg_youth_id, ahg_youth_id_source, status, active, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(personId, p.member_id ? String(p.member_id) : null, p.first_name, p.last_name, p.nickname || null,
      level, normalizeLevel(level), canUseYouthId ? youthId : null, canUseYouthId ? 'checkin' : null, st, active, ts);
  return { id: r.lastInsertRowid, created: true };
}

/**
 * Pull /people and upsert every youth (adults never enter this database).
 * Previously-synced girls who vanished from the answer (the API excludes
 * inactive people) are deactivated, never deleted.
 */
async function syncPeople(db, client) {
  return recordRun(db, 'checkin_people', async () => {
    const rows = await client.people();
    const youth = rows.filter((p) => p.is_youth);
    let created = 0; let visitors = 0;
    const seen = new Set();
    for (const p of youth) {
      const { id, created: c } = upsertGirl(db, p);
      seen.add(id);
      if (c) created += 1;
      if (p.status === 'visitor') visitors += 1;
    }
    const stale = db.prepare('SELECT id FROM girls WHERE checkin_person_id IS NOT NULL AND active = 1').all()
      .filter((g) => !seen.has(g.id));
    for (const g of stale) {
      db.prepare("UPDATE girls SET active = 0, status = 'inactive', updated_at = ? WHERE id = ?").run(now(), g.id);
    }
    return { fetched: rows.length, youth: youth.length, created, visitors, deactivated: stale.length };
  });
}

// -------------------------------------------------------------- attendance --
/**
 * Snapshot one event's attendance from the check-in answer (replacing the
 * previous snapshot). Adults are skipped; a youth row with no mirrored girl
 * (visitor, or roster not yet synced) is upserted so history keeps its FK.
 * `open` comes straight from the API — rule 4b (attended ⇔ open:0) is
 * applied by the proposals step, not here.
 */
async function refreshAttendance(db, client, eventRow) {
  return recordRun(db, 'attendance', async () => {
    const ans = await client.attendance(eventRow.checkin_event_id);
    const ts = now();
    const write = db.transaction(() => {
      db.prepare('DELETE FROM attendance WHERE event_id = ?').run(eventRow.id);
      let rows = 0; let open = 0;
      for (const a of ans.attendance) {
        if (!a.is_youth) continue;
        const { id: girlId } = upsertGirl(db, a, { status: a.status });
        const txns = [a.sign_in_txn_id, a.sign_out_txn_id].filter((x) => x != null);
        db.prepare(`INSERT INTO attendance (event_id, girl_id, signed_in_at, signed_out_at, open, source_txn_ids, fetched_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(eventRow.id, girlId, a.signed_in_at || null, a.signed_out_at || null, a.open ? 1 : 0, JSON.stringify(txns), ts);
        rows += 1;
        if (a.open) open += 1;
      }
      return { eventId: eventRow.id, checkinEventId: eventRow.checkin_event_id, rows, open };
    });
    return write();
  });
}

// ---------------------------------------------------------------- webhooks --
/**
 * Act on a verified, de-duplicated check-in webhook payload. Never throws —
 * a webhook must never be able to crash the service.
 */
async function handleWebhook(db, client, payload, { log = () => {} } = {}) {
  try {
    if (payload.type === 'test') return { acted: 'none' };
    if (payload.type === 'ical.synced') {
      const s = await syncEvents(db, client);
      return { acted: 'events', ...s };
    }
    if (payload.type === 'txn.created' || payload.type === 'txn.voided') {
      const txn = payload.txn || {};
      let ev = txn.event_id != null ? db.prepare('SELECT * FROM events WHERE checkin_event_id = ?').get(txn.event_id) : null;
      if (!ev && txn.ical_uid && txn.start_at) ev = db.prepare('SELECT * FROM events WHERE ical_uid = ? AND start_at = ?').get(txn.ical_uid, txn.start_at);
      if (!ev) {
        await syncEvents(db, client);
        ev = txn.event_id != null ? db.prepare('SELECT * FROM events WHERE checkin_event_id = ?').get(txn.event_id) : null;
      }
      if (!ev) return { acted: 'none', reason: 'event not in mirror' };
      const s = await refreshAttendance(db, client, ev);
      return { acted: 'attendance', ...s };
    }
    return { acted: 'none', reason: `unknown type ${payload.type}` };
  } catch (e) {
    log(`[tracker] webhook processing failed: ${e.message}`);
    return { acted: 'error', error: e instanceof CheckinError ? e.message : 'internal' };
  }
}

/** Full check-in refresh: events, roster, attendance for recent events. */
async function syncCheckin(db, client, { attendanceDays = 14 } = {}) {
  const events = await syncEvents(db, client);
  const people = await syncPeople(db, client);
  const since = new Date(Date.now() - attendanceDays * 86400e3).toISOString();
  const recent = db.prepare('SELECT * FROM events WHERE start_at >= ? AND start_at <= ? AND checkin_event_id IS NOT NULL ORDER BY start_at')
    .all(since, now());
  const attendance = [];
  for (const ev of recent) {
    try {
      attendance.push(await refreshAttendance(db, client, ev));
    } catch (e) {
      if (e instanceof CheckinError && e.status === 404) continue; // event gone on the check-in side
      throw e;
    }
  }
  return { events, people, attendance };
}

module.exports = {
  AHG_LEVELS, normalizeLevel, recordRun,
  upsertEvent, upsertGirl, findGirl, syncEvents, syncPeople, refreshAttendance, syncCheckin, handleWebhook,
};
