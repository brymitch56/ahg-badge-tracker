'use strict';
// Synthetic check-in Integration API (contract: troop-checkin
// docs/13-integration-api.md v0.4.35+). All names, ids and hashids are
// INVENTED — never real roster data (see CLAUDE.md). Tests mutate the
// returned state to simulate sign-ins/outs and roster changes.

function makeState() {
  return {
    people: [
      { id: 1, member_id: '0000001', tlc_user_id: 'utest0000001', last_name: 'Anders', first_name: 'Bea', nickname: null, is_youth: 1, level: 'Explorer', patrol: null, status: 'active', membership_expires: '2027-06-30' },
      { id: 2, member_id: '0000002', tlc_user_id: null, last_name: 'Blake', first_name: 'Cora', nickname: 'Cee', is_youth: 1, level: 'Pioneer', patrol: null, status: 'active', membership_expires: '2027-06-30' },
      { id: 3, member_id: null, tlc_user_id: null, last_name: 'Cole', first_name: 'Dot', nickname: null, is_youth: 1, level: null, patrol: null, status: 'visitor', membership_expires: null },
      { id: 4, member_id: '0000004', tlc_user_id: null, last_name: 'Dane', first_name: 'Eve', nickname: null, is_youth: 0, level: null, patrol: null, status: 'active', membership_expires: '2027-06-30' },
    ],
    events: [
      { id: 42, ical_uid: 'uid-meeting-1@example.com', tlc_event_id: null, source: 'ical', title: 'Weekly Meeting', location: 'Hall', start_at: '2026-09-01T23:00:00.000Z', end_at: '2026-09-02T00:30:00.000Z', all_day: 0, track_adults: 0, removed_from_feed: 0, requires_permission_form: 0 },
      { id: 43, ical_uid: null, tlc_event_id: null, source: 'manual', title: 'Service Day', location: null, start_at: '2026-09-05T14:00:00.000Z', end_at: '2026-09-05T17:00:00.000Z', all_day: 0, track_adults: 0, removed_from_feed: 0, requires_permission_form: 0 },
    ],
    attendance: {
      42: [
        { person_id: 1, member_id: '0000001', tlc_user_id: 'utest0000001', last_name: 'Anders', first_name: 'Bea', nickname: null, is_youth: 1, level: 'Explorer', patrol: null, status: 'active', signed_in_at: '2026-09-01T23:02:00.000Z', signed_out_at: '2026-09-02T00:31:00.000Z', open: 0, forced: 0, permission_override: 0, sign_in_txn_id: 9001, sign_out_txn_id: 9017 },
        { person_id: 2, member_id: '0000002', tlc_user_id: null, last_name: 'Blake', first_name: 'Cora', nickname: 'Cee', is_youth: 1, level: 'Pioneer', patrol: null, status: 'active', signed_in_at: '2026-09-01T23:03:00.000Z', signed_out_at: null, open: 1, forced: 0, permission_override: 0, sign_in_txn_id: 9002, sign_out_txn_id: null },
        { person_id: 4, member_id: '0000004', tlc_user_id: null, last_name: 'Dane', first_name: 'Eve', nickname: null, is_youth: 0, level: null, patrol: null, status: 'active', signed_in_at: '2026-09-01T23:00:00.000Z', signed_out_at: null, open: 1, forced: 0, permission_override: 0, sign_in_txn_id: 9003, sign_out_txn_id: null },
      ],
      43: [],
    },
    calls: [], // every path the client requested, for assertions
  };
}

/** A fetch() stand-in that serves the fixture state. */
function makeFakeCheckin(state, { key = 'tci_test-key' } = {}) {
  return async (url, opts = {}) => {
    const u = new URL(url);
    state.calls.push(u.pathname + u.search);
    const res = (status, body) => ({ status, json: async () => body });
    if ((opts.headers || {}).Authorization !== `Bearer ${key}`) return res(401, { error: 'invalid api key' });
    if (u.pathname === '/api/integration/ping') return res(200, { ok: true, app: 'troop-checkin', version: '0.4.37' });
    if (u.pathname === '/api/integration/events') return res(200, state.events);
    if (u.pathname === '/api/integration/people') return res(200, state.people);
    const m = u.pathname.match(/^\/api\/integration\/events\/(\d+)\/attendance$/);
    if (m) {
      const ev = state.events.find((e) => e.id === Number(m[1]));
      if (!ev || !(m[1] in state.attendance)) return res(404, { error: 'not found' });
      return res(200, {
        event: { id: ev.id, ical_uid: ev.ical_uid, tlc_event_id: ev.tlc_event_id, title: ev.title, start_at: ev.start_at, end_at: ev.end_at, track_adults: ev.track_adults },
        generated_at: new Date().toISOString(),
        attendance: state.attendance[m[1]],
      });
    }
    return res(404, { error: 'not found' });
  };
}

module.exports = { makeState, makeFakeCheckin };
