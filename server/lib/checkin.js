'use strict';
/**
 * Read-only client for the check-in app's Integration API
 * (troop-checkin docs/13-integration-api.md, tc-v60+).
 *
 * Server-to-server on the same box: base is http://127.0.0.1:3000 by
 * default, auth is `Authorization: Bearer tci_…` from config. The contract
 * has no write endpoints — this client can only ever GET.
 */

class CheckinError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

function makeCheckinClient(checkinCfg, { fetchImpl = fetch } = {}) {
  const base = (checkinCfg.base || '').replace(/\/$/, '');
  const configured = Boolean(base && checkinCfg.apiKey);

  async function get(pathWithQuery) {
    if (!configured) throw new CheckinError(0, 'check-in API not configured (CHECKIN_BASE / CHECKIN_API_KEY)');
    let res;
    try {
      res = await fetchImpl(base + pathWithQuery, {
        headers: { Authorization: `Bearer ${checkinCfg.apiKey}`, Accept: 'application/json' },
      });
    } catch (e) {
      throw new CheckinError(0, `check-in API unreachable: ${e.message}`);
    }
    if (res.status !== 200) {
      // 401 = key revoked/disabled; 404 = unknown event; 503 = setup wizard.
      throw new CheckinError(res.status, `check-in API ${pathWithQuery.split('?')[0]} returned ${res.status}`);
    }
    return res.json();
  }

  return {
    configured,
    ping: () => get('/api/integration/ping'),
    /** Events whose local start date falls in [from, to] (YYYY-MM-DD). */
    events: ({ from, to }) => get(`/api/integration/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    people: () => get('/api/integration/people'),
    attendance: (checkinEventId) => get(`/api/integration/events/${checkinEventId}/attendance`),
    attendanceByIdentity: (icalUid, startAt) =>
      get(`/api/integration/attendance?ical_uid=${encodeURIComponent(icalUid)}&start_at=${encodeURIComponent(startAt)}`),
  };
}

module.exports = { makeCheckinClient, CheckinError };
