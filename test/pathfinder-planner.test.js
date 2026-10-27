'use strict';
// The Pathfinder planner and tracker (server/lib/pathfinder.js, migration
// 013): stepping-stone meeting plans, beads proposed from attendance and
// confirmed by a leader, memory verses, the Fanny Crosby / Joining Awards,
// and the bead push that APPENDS one line per bead to AHGFamily's single
// instance. Offline: invented names, ids and award ids; the AHGFamily
// session is a fixture whose save mutates an in-memory form.
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { makeConfig } = require('../server/config');
const { openDb, migrate } = require('../server/db');
const { createApp } = require('../server/app');
const catalog = require('../server/lib/catalog');
const pathfinder = require('../server/lib/pathfinder');
const servicepush = require('../server/lib/servicepush');
const { buildCatalogOnly, loadPathfinderConfig } = require('../scripts/build-badges');

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000002';
const GROUP = '00000000-0000-0000-0000-000000000003';
const KEY = Buffer.from('cd'.repeat(32), 'hex');

// invented award ids (the shape of handbook/pathfinder.json)
const PF = {
  fannyCrosby: 'aw00test0fcl',
  joining: 'aw00test0joi',
  beads: { attendance: 'aw00test0att', verse: 'aw00test0vrs', service: 'aw00test0svc' },
  fannyCrosbyDerived: { stones: 'fctestreq001', service: 'fctestreq002' },
  stones: [1, 2, 3, 4, 5, 6].map((n) => ({ number: n, name: `Stone Name ${n}`, beadAwardId: `aw00test0st${n}`, verse: `Book ${n}:${n}` })),
};
const fcAward = {
  awardId: PF.fannyCrosby, name: 'Fanny Crosby Level Award', levelGroup: 'Pathfinders', retired: false, wholeAwardOnly: false,
  source: { fetchedAt: '2026-09-07T00:00:00Z' },
  groups: [{ label: 'Complete All', rule: { type: 'all' }, edition: 'current', plannable: true, items: [
    { id: 'fctestreq001', number: 1, title: 'One activity from each stepping stone' },
    { id: 'fctestreq002', number: 2, title: 'One service project' },
    { id: 'fctestreq003', number: 3, title: 'One special event' },
  ] }],
};
const joinAward = {
  awardId: PF.joining, name: 'AHG Joining Award', levelGroup: 'All', retired: false, wholeAwardOnly: false,
  groups: [{ label: 'Complete all of the following:', rule: { type: 'all' }, edition: 'current', plannable: true, items: [
    { id: 'jotestreq001', number: 1, title: 'Learn the oath' },
  ] }],
};
const otherAward = {
  awardId: 'aw00test0oth', name: 'Some Badge', levelGroup: 'Tenderheart', retired: false, wholeAwardOnly: false,
  groups: [{ label: 'Complete All', rule: { type: 'all' }, edition: 'current', plannable: true, items: [{ id: 'ottestreq001', number: 1, title: 'Something' }] }],
};

let keys; let db; let cfg; let server; let base; let app;
let pia; let quinn; let tess; let reqFc3; let reqJoin1; let reqOther;

async function token(claims = {}) {
  return new SignJWT({ scp: 'access_as_leader', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(CLIENT)
    .setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
}
const leaderT = () => token({ groups: [GROUP], preferred_username: 'leader@example.com' });
const adminT = () => token({ groups: [GROUP], preferred_username: 'admin@example.com' });
const call = async (method, p, body, t) => {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${await (t || leaderT)()}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: j };
};

const ts = () => new Date().toISOString();
const daysAgo = (n, hour = 18) => { const d = new Date(Date.now() - n * 86400000); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
const ymd = (iso) => iso.slice(0, 10);
const addGirl = (first, level, youthId = null) => Number(db.prepare(
  "INSERT INTO girls (first_name, last_name, ahg_level, ahg_youth_id, ahg_youth_id_source, active, updated_at) VALUES (?, 'Example', ?, ?, 'manual', 1, ?)",
).run(first, level, youthId, ts()).lastInsertRowid);
const addEvent = (title, startAt) => Number(db.prepare('INSERT INTO events (ical_uid, start_at, end_at, title, updated_at) VALUES (?, ?, ?, ?, ?)')
  .run(`uid-${title}-${startAt}`, startAt, new Date(Date.parse(startAt) + 5400000).toISOString(), title, ts()).lastInsertRowid);
const attend = (eventId, girlId, open = 0) => db.prepare("INSERT INTO attendance (event_id, girl_id, open, fetched_at) VALUES (?, ?, ?, ?)").run(eventId, girlId, open, ts());
const beads = (girlId, kind) => db.prepare('SELECT * FROM pf_beads WHERE girl_id = ? AND kind = ? ORDER BY id').all(girlId, kind);
const queueFor = (beadId) => db.prepare('SELECT * FROM push_queue WHERE pf_bead_id = ?').get(beadId);

test.before(async () => {
  keys = await generateKeyPair('RS256');
  const jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'test', alg: 'RS256', use: 'sig' }] });
  cfg = makeConfig({ MSAL_TENANT_ID: TENANT, MSAL_CLIENT_ID: CLIENT, LEADER_GROUP_ID: GROUP, ADMIN_EMAILS: 'admin@example.com', DB_PATH: ':memory:', CRED_KEY: KEY.toString('hex'), TZ: 'UTC', PATHFINDER_DIR: '/nonexistent-pathfinder-dir' });
  db = openDb(':memory:');
  migrate(db);
  pathfinder.setPfConfig(PF);
  const built = [fcAward, joinAward, otherAward].map((a) => buildCatalogOnly(a).badge);
  catalog.importBadges(db, built.map((badge) => ({ file: `${badge.id}.json`, badge })));
  const reqId = (ahg) => db.prepare('SELECT id FROM requirements WHERE ahg_requirement_id = ?').get(ahg).id;
  reqFc3 = reqId('fctestreq003'); reqJoin1 = reqId('jotestreq001'); reqOther = reqId('ottestreq001');
  pia = addGirl('Pia', 'Pathfinder', 'utestpf00001');
  quinn = addGirl('Quinn', 'Pathfinder', 'utestpf00002');
  tess = addGirl('Tess', 'Tenderheart', 'utestpf00003');
  require('../server/lib/mapping').storeCredentials(db, { email: 'x@example.com', password: 'fake-password-never-real' }, 'admin@example.com', KEY);
  app = createApp({ cfg, db, jwks, ahgSessionFactory: (...a) => fakeSessionFactory(...a) });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

// ------------------------------------------------------------ program --
test('handbook/pathfinder.json: six numbered, named stones with their bead awards; build emits Fanny Crosby catalog-only', () => {
  const real = loadPathfinderConfig();
  assert.deepEqual(real.stones.map((s) => s.number), [1, 2, 3, 4, 5, 6]);
  for (const s of real.stones) {
    assert.ok(s.name && /^aw[a-z0-9]{10}$/.test(s.beadAwardId) && s.verse, `stone ${s.number} complete`);
  }
  assert.ok(/^aw[a-z0-9]{10}$/.test(real.fannyCrosby) && /^aw[a-z0-9]{10}$/.test(real.joining));
  const b = buildCatalogOnly(fcAward).badge;
  assert.equal(b.id, 'fanny-crosby-level-award-path');
  assert.deepEqual(b.levels, ['Pathfinder']);
  assert.equal(b.requirementCount, 3);
});

test('GET /pathfinder: stones by number and name, both awards, settings; outlines only when data/ has them', async () => {
  const r = await call('GET', '/api/v1/pathfinder');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.stones.map((s) => [s.number, s.name]), PF.stones.map((s) => [s.number, s.name]));
  assert.equal(r.body.fannyCrosby.requirements.length, 3);
  assert.equal(r.body.joining.requirements.length, 1);
  assert.equal(r.body.attendanceSource, 'planned');
  assert.equal(r.body.outlinesLoaded, false);
  assert.equal(r.body.stones[0].goal, null);
});

test('defaultVerseDate: the latest event on or before today, never a future one', () => {
  const nowIso = '2026-10-27T15:00:00Z';
  const e1 = addEvent('Verse A', '2026-10-20T22:00:00Z');
  const e2 = addEvent('Verse B', '2026-10-27T12:00:00Z');
  const e3 = addEvent('Verse C', '2026-10-30T22:00:00Z');
  assert.equal(pathfinder.defaultVerseDate(db, 'UTC', { nowIso }), '2026-10-27');
  assert.equal(pathfinder.defaultVerseDate(db, 'UTC', { nowIso: '2026-10-26T15:00:00Z' }), '2026-10-20');
  db.prepare('DELETE FROM events WHERE id IN (?, ?, ?)').run(e1, e2, e3);
});

// --------------------------------------------------------------- plans --
test('putPlan validates slots, stones and requirements; only Fanny Crosby / Joining items are plannable; empty deletes', async () => {
  const ev = addEvent('Plan Validation', daysAgo(-3));
  const put = (body) => call('PUT', `/api/v1/events/${ev}/pathfinder-plan`, body);
  assert.equal((await put({ parts: [{ slot: 'snack' }] })).status, 400);
  assert.equal((await put({ parts: [{ slot: 'activity', stone: 7 }] })).status, 400);
  assert.equal((await put({ parts: [{ slot: 'activity', requirementId: reqOther }] })).status, 400, 'a badge requirement is not plannable here');
  assert.equal((await put({ parts: [], finishesStones: [9] })).status, 400);
  const ok = await put({ kind: 'meeting', notes: 'Bring glue', finishesStones: [2],
    parts: [{ slot: 'intro', stone: 2, what: 'Practice the verse' }, { slot: 'activity', stone: 2, what: 'Craft', supplies: 'Paper', who: 'Leader A' }, { slot: 'activity', requirementId: reqJoin1, what: 'Oath game' }, { slot: 'closing' }] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.parts.map((p) => [p.slot, p.stone, p.stoneName]), [['intro', 2, 'Stone Name 2'], ['activity', 2, 'Stone Name 2'], ['activity', null, null], ['closing', null, null]]);
  assert.equal(ok.body.parts[2].requirement.badgeName, 'AHG Joining Award');
  assert.deepEqual(ok.body.finishesStones, [2]);
  assert.equal(ok.body.proposals.skipped, 'event has not started');
  const ev2 = (await call('GET', '/api/v1/events')).body.find((e) => e.id === ev);
  assert.equal(ev2.pathfinderPlan, true, 'the events list marks the meeting');
  const year = await call('GET', `/api/v1/pathfinder/plans?from=${ymd(daysAgo(10))}&to=${ymd(daysAgo(-10))}`);
  assert.equal(year.body.length, 1);
  assert.equal(year.body[0].plan.notes, 'Bring glue');
  assert.deepEqual((await put({ parts: [] })).body, { deleted: true, proposals: { skipped: 'event has not started' } });
  assert.equal(await call('GET', `/api/v1/events/${ev}/pathfinder-plan`).then((r) => r.body), null);
});

let evMeet; let evService;
test('a planned meeting that happened proposes attendance + stone beads and the planned award items — Pathfinders who attended only', async () => {
  evMeet = addEvent('Pathfinder Meeting One', daysAgo(6));
  attend(evMeet, pia); attend(evMeet, tess); attend(evMeet, quinn, 1); // Quinn still signed in: not attended yet (rule 4b)
  const r = await call('PUT', `/api/v1/events/${evMeet}/pathfinder-plan`, {
    finishesStones: [1], parts: [{ slot: 'activity', stone: 1, what: 'Name chain' }, { slot: 'activity', requirementId: reqFc3, what: 'Visit the fair' }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(beads(pia, 'attendance').map((b) => [b.status, b.source, b.earned_on]), [['proposed', 'attendance', ymd(daysAgo(6))]]);
  assert.deepEqual(beads(pia, 'stone').map((b) => [b.stone, b.status]), [[1, 'proposed']]);
  assert.equal(beads(quinn, 'attendance').length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pf_beads WHERE girl_id = ?').get(tess).n, 0, 'a Tenderheart earns no beads');
  const c = db.prepare('SELECT * FROM completions WHERE girl_id = ? AND requirement_id = ?').get(pia, reqFc3);
  assert.equal(c.status, 'proposed');
  assert.match(c.notes, /Visit the fair/);

  // re-running is idempotent; Quinn signs out → proposed too
  db.prepare('UPDATE attendance SET open = 0 WHERE event_id = ? AND girl_id = ?').run(evMeet, quinn);
  const again = pathfinder.proposeForEvent(db, db.prepare('SELECT * FROM events WHERE id = ?').get(evMeet), 'UTC');
  assert.deepEqual(again, { beads: 2, completions: 1, withdrawn: 0 });
  assert.equal(beads(pia, 'attendance').length, 1);

  // the plan no longer finishes stone 1 → the proposed stone beads are withdrawn
  await call('PUT', `/api/v1/events/${evMeet}/pathfinder-plan`, { parts: [{ slot: 'activity', stone: 1 }, { slot: 'activity', requirementId: reqFc3 }] });
  assert.equal(beads(pia, 'stone').length, 0);
  assert.equal(beads(pia, 'attendance').length, 1, 'attendance stays');
});

test('a service-project meeting proposes a white star for each Pathfinder there', async () => {
  evService = addEvent('Food Drive', daysAgo(5));
  attend(evService, pia);
  await call('PUT', `/api/v1/events/${evService}/pathfinder-plan`, { kind: 'service', serviceProject: 'Food pantry sort', parts: [] });
  assert.deepEqual(beads(pia, 'service').map((b) => [b.status, b.label]), [['proposed', 'Food pantry sort']]);
});

test('attendance source: "planned" counts only Pathfinder-planned meetings; "all" (admin) counts every event she checked in to', async () => {
  const other = addEvent('Troop Campout', daysAgo(4));
  attend(other, pia);
  pathfinder.proposeForEvent(db, db.prepare('SELECT * FROM events WHERE id = ?').get(other), 'UTC');
  assert.equal(beads(pia, 'attendance').filter((b) => b.event_id === other).length, 0);
  assert.equal((await call('POST', '/api/v1/admin/pathfinder/settings', { attendanceSource: 'all' })).status, 403, 'leaders cannot change it');
  assert.equal((await call('POST', '/api/v1/admin/pathfinder/settings', { attendanceSource: 'some' }, adminT)).status, 400);
  assert.equal((await call('POST', '/api/v1/admin/pathfinder/settings', { attendanceSource: 'all' }, adminT)).status, 200);
  await call('POST', '/api/v1/pathfinder/rescan', { from: ymd(daysAgo(30)) });
  assert.equal(beads(pia, 'attendance').filter((b) => b.event_id === other).length, 1);
  await call('POST', '/api/v1/admin/pathfinder/settings', { attendanceSource: 'planned' }, adminT);
  await call('POST', '/api/v1/pathfinder/rescan', { from: ymd(daysAgo(30)) });
  assert.equal(beads(pia, 'attendance').filter((b) => b.event_id === other).length, 0, 'the proposal is withdrawn again');
});

// ------------------------------------------------------- deciding beads --
test('confirming beads queues one push row each, numbered in her count; a rejected bead is never proposed again', async () => {
  const pend = (await call('GET', '/api/v1/pathfinder/pending')).body;
  const att = pend.beads.find((b) => b.girlId === pia && b.kind === 'attendance');
  const qAtt = pend.beads.find((b) => b.girlId === quinn && b.kind === 'attendance');
  assert.ok(pend.completions.some((c) => c.girlId === pia && c.requirementId === reqFc3));
  const r = await call('POST', '/api/v1/pathfinder/decide', { beads: [{ beadId: att.id, decision: 'confirm' }, { beadId: qAtt.id, decision: 'reject' }] });
  assert.equal(r.status, 200);
  const q = queueFor(att.id);
  assert.deepEqual({ action: q.action, status: q.status, award: q.ahg_award_id, date: q.date }, { action: 'bead', status: 'queued', award: PF.beads.attendance, date: ymd(daysAgo(6)) });
  assert.equal(JSON.parse(q.detail).line, `Bead 1 of 1 to date: ${ymd(daysAgo(6))} (tracker)`);
  // a second meeting → bead 2
  const ev = addEvent('Pathfinder Meeting Two', daysAgo(3));
  attend(ev, pia); attend(ev, quinn);
  await call('PUT', `/api/v1/events/${ev}/pathfinder-plan`, { parts: [{ slot: 'activity', stone: 2 }] });
  const b2 = beads(pia, 'attendance').find((b) => b.event_id === ev);
  await call('POST', '/api/v1/pathfinder/decide', { beads: [{ beadId: b2.id, decision: 'confirm' }] });
  assert.equal(JSON.parse(queueFor(b2.id).detail).line, `Bead 2 of 2 to date: ${ymd(daysAgo(3))} (tracker)`);
  // Quinn's rejected bead stays rejected across a re-scan
  await call('POST', '/api/v1/pathfinder/rescan', { from: ymd(daysAgo(30)) });
  assert.deepEqual(beads(quinn, 'attendance').filter((b) => b.event_id === evMeet).map((b) => b.status), ['rejected']);
  assert.equal((await call('POST', '/api/v1/pathfinder/decide', { beads: [{ beadId: att.id, decision: 'confirm' }] })).status, 409);
});

test('memory verses: a heart per stone verse (once each) or a bonus verse by reference; the note line names the verse', async () => {
  const day = ymd(daysAgo(2));
  const r = await call('POST', '/api/v1/pathfinder/beads', { girlId: pia, kind: 'verse', stone: 3, earnedOn: day });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'confirmed');
  assert.equal(JSON.parse(queueFor(r.body.id).detail).line, `Heart 1 of 1 to date: ${day}, Book 3:3 (tracker)`);
  assert.equal((await call('POST', '/api/v1/pathfinder/beads', { girlId: pia, kind: 'verse', stone: 3, earnedOn: day })).status, 409);
  assert.equal((await call('POST', '/api/v1/pathfinder/beads', { girlId: pia, kind: 'verse', earnedOn: day })).status, 400, 'a bonus verse needs its reference');
  const bonus = await call('POST', '/api/v1/pathfinder/beads', { girlId: pia, kind: 'verse', verse: 'Psalm 23:1', earnedOn: day });
  assert.equal(JSON.parse(queueFor(bonus.body.id).detail).line, `Heart 2 of 2 to date: ${day}, Psalm 23:1 (tracker)`);
  assert.equal((await call('POST', '/api/v1/pathfinder/beads', { girlId: tess, kind: 'verse', stone: 1, earnedOn: day })).status, 400, 'Pathfinders only');
  assert.equal((await call('POST', '/api/v1/pathfinder/beads', { girlId: pia, kind: 'verse', stone: 1, earnedOn: '10/01/2026' })).status, 400);
});

test('six stone beads propose Fanny Crosby requirement 1, a service star proposes requirement 2; confirming them is a normal completion', async () => {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const r = await call('POST', '/api/v1/pathfinder/beads', { girlId: pia, kind: 'stone', stone: n, earnedOn: ymd(daysAgo(10 - n)) });
    assert.equal(r.status, 201, `stone ${n}`);
  }
  const stoneLine = JSON.parse(queueFor(beads(pia, 'stone')[2].id).detail).line;
  assert.equal(stoneLine, `Stepping Stone 3 - Stone Name 3: ${ymd(daysAgo(7))} (tracker)`);
  const svc = beads(pia, 'service')[0];
  await call('POST', '/api/v1/pathfinder/decide', { beads: [{ beadId: svc.id, decision: 'confirm' }] });
  assert.equal(JSON.parse(queueFor(svc.id).detail).line, `Star 1 of 1 to date: ${ymd(daysAgo(5))}, Food pantry sort (tracker)`);

  const pend = (await call('GET', '/api/v1/pathfinder/pending')).body.completions.filter((c) => c.girlId === pia);
  assert.deepEqual(pend.map((c) => c.number).sort(), [1, 2, 3]);
  const r = await call('POST', '/api/v1/pathfinder/decide', { completions: pend.map((c) => ({ completionId: c.completionId, decision: 'confirm' })) });
  assert.equal(r.status, 200);
  const t = (await call('GET', '/api/v1/pathfinder/tracker')).body;
  const g = t.girls.find((x) => x.id === pia);
  assert.deepEqual(g.counts, { attendance: 2, verse: 2, service: 1, stone: 6 });
  assert.equal(g.fannyCrosby.done, 3);
  assert.equal(g.fannyCrosby.complete, true);
  assert.equal(g.joining.done, 0);
  assert.equal(Object.keys(g.stones).length, 6);
  assert.ok(g.verses['Book 3:3']);
  assert.equal(t.girls.some((x) => x.id === tess), false, 'only Pathfinders are listed');
  // a badge completion can't be decided from the Pathfinder page
  const other = db.prepare("INSERT INTO completions (girl_id, requirement_id, status, completed_on, source, proposed_at) VALUES (?, ?, 'proposed', '2026-01-01', 'manual', ?)").run(tess, reqOther, ts()).lastInsertRowid;
  assert.equal((await call('POST', '/api/v1/pathfinder/decide', { completions: [{ completionId: Number(other), decision: 'confirm' }] })).status, 400);
});

test('removing a bead: queued → skipped; one already sent to AHGFamily needs alreadyFixed', async () => {
  const b = beads(pia, 'verse')[1];
  db.prepare("UPDATE push_queue SET status = 'sent' WHERE pf_bead_id = ?").run(b.id);
  assert.equal((await call('DELETE', `/api/v1/pathfinder/beads/${b.id}`)).status, 409);
  assert.equal((await call('DELETE', `/api/v1/pathfinder/beads/${b.id}?alreadyFixed=1`)).status, 200);
  const s = beads(pia, 'stone')[5];
  await call('DELETE', `/api/v1/pathfinder/beads/${s.id}`);
  assert.equal(queueFor(s.id).status, 'skipped');
  db.prepare("UPDATE push_queue SET status = 'skipped' WHERE action = 'bead'").run(); // clean slate for the push tests
});

// ---------------------------------------------------------------- push --
// fake AHGFamily: per (award) a form that is either record-keyed (blank
// slots until one instance is saved) or award-keyed (stone logo beads)
const forms = new Map(); // awardId → { keyed: 'record'|'award', saved: [{ adId, completedOn, comment }], award: { completedOn, comment } }
const fx = { saves: 0, swallow: false, fetches: 0 };
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
function formHtml(awardId) {
  const f = forms.get(awardId);
  if (f.keyed === 'award') {
    return `<form><input type="text" name="completed_on-${awardId}" value="${f.award.completedOn || ''}"><input type="text" name="awarded_on-${awardId}" value="">
      <input type="text" name="purchased-${awardId}" value="0"><textarea name="comment-${awardId}">${esc(f.award.comment)}</textarea></form>`;
  }
  fx.fetches += 1;
  const panels = f.saved.map((p) => `<input type="text" name="completed_on-${p.adId}" value="${p.completedOn}"><input type="text" name="awarded_on-${p.adId}" value="">
      <input type="text" name="purchased-${p.adId}" value="0"><textarea name="comment-${p.adId}">${esc(p.comment)}</textarea>`);
  const blanks = f.saved.length ? [] : [0, 1].map((i) => `adbk${String(fx.fetches).padStart(4, '0')}${i}zzz`.slice(0, 12)).map((id) => `<input type="hidden" name="new-${id}" value="false">
      <input type="text" name="completed_on-${id}" value=""><input type="text" name="awarded_on-${id}" value=""><input type="text" name="purchased-${id}" value="0"><textarea name="comment-${id}"></textarea>`);
  return `<form>${panels.join('')}${blanks.join('')}</form>`;
}
const fakeSessionFactory = async () => ({
  async standard(awardId) { return formHtml(awardId); },
  async page() { return '<form><input type="hidden" name="_csrf" value="tok"></form>'; },
  async save(pairs) {
    fx.saves += 1;
    if (fx.swallow) return { status: 200 };
    const m = new Map(pairs);
    const f = forms.get(m.get('badge-select'));
    if (f.keyed === 'award') {
      const id = m.get('badge-select');
      f.award = { completedOn: m.get(`completed_on-${id}`), comment: m.get(`comment-${id}`) };
      return { status: 302 };
    }
    for (const p of f.saved) { p.completedOn = m.get(`completed_on-${p.adId}`); p.comment = m.get(`comment-${p.adId}`); }
    const slot = pairs.find(([n, v]) => /^new-ad/.test(n) && v === 'true');
    if (slot) {
      const id = slot[0].slice(4);
      f.saved.push({ adId: 'adsaved00001', completedOn: m.get(`completed_on-${id}`), comment: m.get(`comment-${id}`) });
    }
    return { status: 302 };
  },
  async close() {},
});

const queueBeadRow = (awardId, line, date = ymd(daysAgo(6)), beadId = beads(pia, 'attendance')[0].id) => Number(db.prepare(
  "INSERT INTO push_queue (girl_id, action, date, status, created_at, ahg_award_id, detail, pf_bead_id) VALUES (?, 'bead', ?, 'queued', ?, ?, ?, ?)",
).run(pia, date, ts(), awardId, JSON.stringify({ kind: 'attendance', line }), beadId).lastInsertRowid);
const status = (id) => db.prepare('SELECT status, last_error FROM push_queue WHERE id = ?').get(id);

test('bead push is OFF until both push_enabled and push_pathfinder_enabled are on', async () => {
  const r = await servicepush.pushBeadNotes(db, cfg, { sessionFactory: fakeSessionFactory, key: KEY });
  assert.equal(r.skipped, 'push disabled');
  require('../server/lib/settings').setSetting(db, 'push_enabled', true);
  assert.equal((await servicepush.pushBeadNotes(db, cfg, { sessionFactory: fakeSessionFactory, key: KEY })).skipped, 'Pathfinder bead push disabled');
  const on = await call('POST', '/api/v1/admin/push-pathfinder-enabled', { enabled: true }, adminT);
  assert.deepEqual(on.body, { pushPathfinderEnabled: true });
  assert.equal((await call('GET', '/api/v1/sync/status')).body.pushPathfinderEnabled, true);
});

test('first bead fills the blank slot; later beads keep AHGFamily\'s date and APPEND their line', async () => {
  forms.set(PF.beads.attendance, { keyed: 'record', saved: [] });
  const d1 = ymd(daysAgo(6)); const d2 = ymd(daysAgo(3));
  const a = queueBeadRow(PF.beads.attendance, `Bead 1 of 1 to date: ${d1} (tracker)`, d1);
  const b = queueBeadRow(PF.beads.attendance, `Bead 2 of 2 to date: ${d2} (tracker)`, d2);
  const r = await servicepush.pushBeadNotes(db, cfg, { sessionFactory: fakeSessionFactory, key: KEY });
  assert.equal(r.pushed, 2, JSON.stringify(r.items));
  assert.deepEqual([status(a).status, status(b).status], ['sent', 'sent']);
  const f = forms.get(PF.beads.attendance);
  assert.equal(f.saved.length, 1, 'still ONE instance');
  assert.equal(f.saved[0].completedOn, servicepush.toFormDate(d1, 'UTC'), 'the first bead\'s date stays');
  assert.equal(f.saved[0].comment, `Bead 1 of 1 to date: ${d1} (tracker)\nBead 2 of 2 to date: ${d2} (tracker)`);
});

test('a hand-written comment on AHGFamily is kept; a line already there is not written twice', async () => {
  const f = forms.get(PF.beads.attendance);
  f.saved[0].comment = 'Given at fall ceremony';
  const line = 'Bead 3 of 3 to date: 2026-01-02 (tracker)';
  const a = queueBeadRow(PF.beads.attendance, line, '2026-01-02');
  await servicepush.pushBeadNotes(db, cfg, { sessionFactory: fakeSessionFactory, key: KEY });
  assert.equal(status(a).status, 'sent');
  assert.equal(f.saved[0].comment, `Given at fall ceremony\n${line}`);
  const saves = fx.saves;
  const again = queueBeadRow(PF.beads.attendance, line, '2026-01-02');
  await servicepush.pushBeadNotes(db, cfg, { sessionFactory: fakeSessionFactory, key: KEY });
  assert.deepEqual(status(again), { status: 'skipped', last_error: 'line already in the AHGFamily note' });
  assert.equal(fx.saves, saves, 'no save for a line already there');
});

test('stone logo beads are award-keyed: date set when blank, line appended', async () => {
  const awardId = PF.stones[0].beadAwardId;
  forms.set(awardId, { keyed: 'award', saved: [], award: { completedOn: '', comment: '' } });
  const a = queueBeadRow(awardId, 'Stepping Stone 1 - Stone Name 1: 2026-01-05 (tracker)', '2026-01-05');
  await servicepush.pushBeadNotes(db, cfg, { sessionFactory: fakeSessionFactory, key: KEY });
  assert.equal(status(a).status, 'sent');
  assert.deepEqual(forms.get(awardId).award, { completedOn: '01/05/2026', comment: 'Stepping Stone 1 - Stone Name 1: 2026-01-05 (tracker)' });
});

test('an unconfirmed save is HELD, never retried; several instances on AHGFamily are held for a human', async () => {
  fx.swallow = true;
  const a = queueBeadRow(PF.beads.attendance, 'Bead 4 of 4 to date: 2026-01-09 (tracker)', '2026-01-09');
  await servicepush.pushBeadNotes(db, cfg, { sessionFactory: fakeSessionFactory, key: KEY });
  assert.equal(status(a).status, 'held');
  fx.swallow = false;
  const f = forms.get(PF.beads.attendance);
  f.saved.push({ adId: 'adsaved00002', completedOn: '01/01/2026', comment: '' });
  const b = queueBeadRow(PF.beads.attendance, 'Bead 5 of 5 to date: 2026-01-10 (tracker)', '2026-01-10');
  await servicepush.pushBeadNotes(db, cfg, { sessionFactory: fakeSessionFactory, key: KEY });
  assert.match(status(b).last_error, /2 instances/);
  assert.equal(status(b).status, 'held');
});

test('confirming a bead with the push on sends it straight away', async () => {
  forms.set(PF.beads.verse, { keyed: 'record', saved: [] });
  const r = await call('POST', '/api/v1/pathfinder/beads', { girlId: pia, kind: 'verse', stone: 5, earnedOn: ymd(daysAgo(1)) });
  assert.equal(r.status, 201);
  await app.locals.beadPushWork;
  assert.equal(queueFor(r.body.id).status, 'sent');
  assert.match(forms.get(PF.beads.verse).saved[0].comment, /Book 5:5 \(tracker\)$/);
});
