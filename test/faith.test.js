'use strict';
// The Faith tab: catalog-only faith builds, the faith plan track beside the
// badge track, standalone studies, linked-badge Faith Award status. Offline;
// every id and name is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { makeConfig } = require('../server/config');
const { openDb, migrate } = require('../server/db');
const { createApp } = require('../server/app');
const catalog = require('../server/lib/catalog');
const faith = require('../server/lib/faith');
const { proposeForEvent } = require('../server/lib/proposals');
const { buildCatalogOnly, faithTag, faithAwardIds } = require('../scripts/build-badges');

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000002';
const GROUP = '00000000-0000-0000-0000-000000000003';

const FAITH = {
  faithAward: { Tenderheart: 'aw00faith0th', Explorer: 'aw00faith0ex', Pioneer: 'aw00faith0pi', Patriot: 'aw00faith0pa' },
  faithBadges: ['Bible Basics'],
  links: { 'Bible Basics Badge': 'Bible Basics' },
};

// catalog awards (the fetched shape)
const awardFor = (level, awardId, prefix) => ({
  awardId, name: `B.Y. Faith Award (${level})`, levelGroup: level, retired: false, wholeAwardOnly: false, imageSlug: 'faith',
  source: { fetchedAt: '2026-09-07T00:00:00Z' },
  groups: [{ label: 'Complete one of the following studies:', rule: { type: 'n_of', n: 1 }, edition: 'current', plannable: true, items: [
    { id: `${prefix}00study01`, number: 1, title: 'Creed Study' },
    { id: `${prefix}00study02`, number: 2, title: 'Old Study (Retired)' },
    { id: `${prefix}00study03`, number: 3, title: 'Bible Basics Badge' },
  ] }],
});
const bibleBasics = (levelGroup, awardId, prefix) => ({
  awardId, name: 'Bible Basics', levelGroup, retired: false, wholeAwardOnly: false, imageSlug: 'bb',
  groups: [{ label: 'Complete All', rule: { type: 'all' }, edition: 'current', plannable: true, items: [
    { id: `${prefix}00bbreq01`, number: 1, title: 'Books of the Bible' },
    { id: `${prefix}00bbreq02`, number: 2, title: 'Memory verse' },
  ] }],
});

let keys; let jwks; let db; let server; let base; let badgesDir; let eventId; let pastEventId;

async function token() {
  return new SignJWT({ scp: 'access_as_leader', groups: [GROUP], preferred_username: 'leader@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(CLIENT)
    .setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
}
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: j };
};
const PIPA = encodeURIComponent('Pioneer/Patriot');

test.before(async () => {
  faith.setFaithConfig(FAITH);
  keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] });
  badgesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faith-badges-'));
  const awards = [
    awardFor('Explorer', FAITH.faithAward.Explorer, 'ex'),
    awardFor('Pioneer', FAITH.faithAward.Pioneer, 'pi'),
    awardFor('Patriot', FAITH.faithAward.Patriot, 'pa'),
    bibleBasics('Explorer', 'aw00bbasicex', 'ex'),
    bibleBasics('Pioneer/Patriot', 'aw00bbasicpp', 'pp'),
    { awardId: 'aw00notfaith', name: 'Camping', levelGroup: 'Explorer', retired: false, wholeAwardOnly: false,
      groups: [{ label: 'Complete All', rule: { type: 'all' }, edition: 'current', plannable: true, items: [{ id: 'ex00camp0001', number: 1, title: 'Tent' }] }] },
  ];
  for (const a of awards) {
    const r = buildCatalogOnly(a, { faith: faithTag(a, FAITH) });
    assert.equal(r.errors, undefined, JSON.stringify(r.errors));
    fs.writeFileSync(path.join(badgesDir, `${r.badge.id}.json`), JSON.stringify(r.badge));
  }
  const cfg = makeConfig({
    MSAL_TENANT_ID: TENANT, MSAL_CLIENT_ID: CLIENT, LEADER_GROUP_ID: GROUP, ADMIN_EMAILS: 'admin@example.com',
    DB_PATH: ':memory:', BADGES_DIR: badgesDir,
  });
  db = openDb(':memory:');
  migrate(db);
  catalog.importFromDir(db, badgesDir, { actor: 'admin@example.com' });
  const ev = (cid, start, end) => Number(db.prepare("INSERT INTO events (checkin_event_id, ical_uid, start_at, end_at, title, updated_at) VALUES (?, ?, ?, ?, 'Weekly Meeting', '2026-09-01T00:00:00Z')")
    .run(cid, `uid-${cid}@example.com`, start, end).lastInsertRowid);
  eventId = ev(501, '2099-09-01T23:00:00.000Z', '2099-09-02T00:30:00.000Z');
  pastEventId = ev(502, '2026-09-08T23:00:00.000Z', '2026-09-09T00:30:00.000Z');
  const app = createApp({ cfg, db, jwks });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); fs.rmSync(badgesDir, { recursive: true, force: true }); });

test('catalog-only build: titles as text, retired study flagged, faith tagged, scaffold-compatible id', () => {
  const a = awardFor('Explorer', FAITH.faithAward.Explorer, 'ex');
  const { badge } = buildCatalogOnly(a, { faith: faithTag(a, FAITH) });
  assert.equal(badge.id, 'b-y-faith-award-explorer-expl');
  assert.equal(badge.textSource, 'ahgfamily');
  assert.equal(badge.faith, 'award');
  assert.deepEqual(badge.groups[0].requirements.map((r) => [r.number, r.text, r.flags]),
    [[1, 'Creed Study', []], [2, 'Old Study (Retired)', ['retired']], [3, 'Bible Basics Badge', []]]);
  assert.equal(buildCatalogOnly(bibleBasics('Pioneer/Patriot', 'aw00bbasicpp', 'pp')).badge.id, 'bible-basics-pipa');
  assert.ok(buildCatalogOnly({ ...a, wholeAwardOnly: true }).errors.some((e) => /whole-award/.test(e)));
  assert.equal(faithTag({ awardId: 'x', name: 'BIBLE  basics' }, FAITH), 'badge', 'loose name match');
  assert.equal(faithTag({ awardId: 'x', name: 'Camping' }, FAITH), null);
  assert.deepEqual(faithAwardIds([{ awardId: 'aw00bbasicex', name: 'Bible Basics' }, { awardId: 'aw0retired01', name: 'Bible Basics', retired: true }], FAITH).sort(),
    [...Object.values(FAITH.faithAward), 'aw00bbasicex'].sort());
});

test('import keeps the faith tag; /badges?faith= filters; /faith resolves links per level', async () => {
  const r = await call('GET', '/api/v1/badges?faith=any');
  assert.deepEqual(r.body.map((b) => [b.id, b.faith]).sort(), [
    ['b-y-faith-award-explorer-expl', 'award'], ['b-y-faith-award-patriot-patr', 'award'], ['b-y-faith-award-pioneer-pion', 'award'],
    ['bible-basics-expl', 'badge'], ['bible-basics-pipa', 'badge'],
  ]);
  assert.equal(r.body[0].textSource, 'ahgfamily');
  const c = (await call('GET', '/api/v1/faith')).body;
  assert.deepEqual(c.missing, ['Tenderheart']);
  const pio = c.awards.find((a) => a.level === 'Pioneer');
  assert.deepEqual(pio.items.map((i) => [i.number, i.retired, i.linkedBadges.map((b) => b.badgeId)]),
    [[1, false, []], [2, true, []], [3, false, ['bible-basics-pipa']]]);
  assert.deepEqual(c.badges.map((b) => b.badgeId), ['bible-basics-expl', 'bible-basics-pipa']);
});

test('faith track: own items, notes and studies; the badge plan never sees them', async () => {
  const study = await call('POST', '/api/v1/faith/studies', { title: 'Psalms for Girls', units: ['Explorer'] });
  assert.equal(study.status, 201);
  assert.equal((await call('POST', '/api/v1/faith/studies', { title: ' ' })).status, 400);
  assert.equal((await call('POST', '/api/v1/faith/studies', { title: 'x', units: ['Pathfinders'] })).status, 400);

  let r = await call('PUT', `/api/v1/events/${eventId}/faith-plans/Explorer`, {
    notes: 'devotion first',
    items: [
      { requirementId: 'bible-basics-expl:1', role: 'start' },
      { studyId: study.body.id, lesson: 'Lesson 1 — Psalm 23' },
      { requirementId: 'b-y-faith-award-explorer-expl:1', role: 'start' },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.notes, 'devotion first');
  assert.deepEqual(r.body.items.map((i) => [i.requirementId, i.position]), [['bible-basics-expl:1', 0], ['b-y-faith-award-explorer-expl:1', 2]]);
  assert.deepEqual(r.body.studies.map((s) => [s.title, s.lesson, s.position]), [['Psalms for Girls', 'Lesson 1 — Psalm 23', 1]]);

  // the badge planner sees no plan, and its own save leaves faith alone
  assert.deepEqual((await call('GET', `/api/v1/events/${eventId}/plans`)).body, []);
  const ev = (await call('GET', '/api/v1/events?from=2099-09-01&to=2099-09-01')).body[0];
  assert.deepEqual([ev.planLevelGroups, ev.faithLevelGroups], [[], ['Explorer']]);
  r = await call('PUT', `/api/v1/events/${eventId}/plans/Explorer`, { notes: 'camp prep', items: [{ requirementId: 'camping-expl:1', role: 'session' }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.notes, 'camp prep');
  assert.deepEqual(r.body.items.map((i) => i.requirementId), ['camping-expl:1']);
  r = await call('PUT', `/api/v1/events/${eventId}/plans/Explorer`, { items: [] });
  assert.equal(r.body.deleted, true);
  const fp = (await call('GET', `/api/v1/events/${eventId}/faith-plans`)).body;
  assert.equal(fp.length, 1, 'the faith plan survives deleting the badge plan');
  assert.equal(fp[0].items.length, 2);
  assert.equal(fp[0].notes, 'devotion first');
});

test('faith track refuses: non-faith badges, retired studies, wrong-unit studies, a requirement on the other track', async () => {
  let r = await call('PUT', `/api/v1/events/${eventId}/faith-plans/Explorer`, { items: [{ requirementId: 'camping-expl:1', role: 'session' }] });
  assert.equal(r.status, 400); assert.match(r.body.error, /not a faith badge/);
  r = await call('PUT', `/api/v1/events/${eventId}/faith-plans/Explorer`, { items: [{ requirementId: 'b-y-faith-award-explorer-expl:2', role: 'session' }] });
  assert.equal(r.status, 400); assert.match(r.body.error, /retired on AHGFamily/);
  const st = (await call('GET', '/api/v1/faith/studies')).body[0];
  r = await call('PUT', `/api/v1/events/${eventId}/faith-plans/${PIPA}`, { items: [{ studyId: st.id }] });
  assert.equal(r.status, 400); assert.match(r.body.error, /not a Pioneer\/Patriot study/);
  r = await call('PUT', `/api/v1/events/${eventId}/plans/Explorer`, { items: [{ requirementId: 'bible-basics-expl:1', role: 'session' }] });
  assert.equal(r.status, 409); assert.match(r.body.error, /already on this meeting's Faith plan/);
  r = await call('PUT', `/api/v1/events/${eventId}/plans/Explorer`, { items: [{ studyId: st.id }] });
  assert.equal(r.status, 400, 'studies only on the faith track');
});

test('a one-level award item in the Pioneer/Patriot plan proposes only to girls at that level', () => {
  const girl = (first, level) => Number(db.prepare("INSERT INTO girls (first_name, last_name, ahg_level, active, updated_at) VALUES (?, 'Example', ?, 1, '2026-09-01T00:00:00Z')").run(first, level).lastInsertRowid);
  const pio = girl('Pia', 'Pioneer');
  const pat = girl('Pat', 'Patriot');
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(pastEventId);
  const plan = Number(db.prepare("INSERT INTO plans (event_id, level_group, created_by, created_at) VALUES (?, 'Pioneer/Patriot', 'leader@example.com', '2026-09-01T00:00:00Z')").run(pastEventId).lastInsertRowid);
  db.prepare("INSERT INTO plan_items (plan_id, requirement_id, role, position, track) VALUES (?, 'b-y-faith-award-pioneer-pion:1', 'session', 0, 'faith')").run(plan);
  db.prepare("INSERT INTO plan_items (plan_id, requirement_id, role, position, track) VALUES (?, 'b-y-faith-award-patriot-patr:1', 'session', 1, 'faith')").run(plan);
  for (const g of [pio, pat]) db.prepare("INSERT INTO attendance (event_id, girl_id, signed_in_at, signed_out_at, open, fetched_at) VALUES (?, ?, '2026-09-08T23:00:00Z', '2026-09-09T00:30:00Z', 0, '2026-09-09T01:00:00Z')").run(pastEventId, g);
  const s = proposeForEvent(db, ev, 'America/New_York');
  assert.equal(s.proposed, 2);
  const rows = db.prepare('SELECT girl_id, requirement_id FROM completions ORDER BY girl_id').all();
  assert.deepEqual(rows.map((x) => [x.girl_id, x.requirement_id]), [[pio, 'b-y-faith-award-pioneer-pion:1'], [pat, 'b-y-faith-award-patriot-patr:1']]);
  db.prepare('DELETE FROM completions').run();
  db.prepare('DELETE FROM plans WHERE id = ?').run(plan);
  db.prepare('DELETE FROM attendance').run();
});

test('Faith Award: a completed linked badge is ready to record; recording earns it once', async () => {
  const pia = db.prepare("SELECT id FROM girls WHERE first_name = 'Pia'").get().id;
  const pat = db.prepare("SELECT id FROM girls WHERE first_name = 'Pat'").get().id;
  const done = (g, req, day, lvl) => db.prepare("INSERT INTO completions (girl_id, requirement_id, status, completed_on, source, level_at_completion, proposed_at) VALUES (?, ?, 'confirmed', ?, 'manual', ?, '2026-09-01T00:00:00Z')").run(g, req, day, lvl);
  done(pia, 'bible-basics-pipa:1', '2026-09-15', 'Pioneer');
  let st = (await call('GET', '/api/v1/faith/awards')).body;
  const of = (who, level) => st.girls.find((g) => g.girlId === who).awards.find((a) => a.level === level);
  assert.equal(of(pia, 'Pioneer').status, 'in_progress');
  assert.equal(of(pia, 'Pioneer').underway[0].viaBadgeName, 'Bible Basics');
  assert.equal(st.girls.find((g) => g.girlId === pia).awards.some((a) => a.level === 'Patriot'), false, 'no award above her level');

  done(pia, 'bible-basics-pipa:2', '2026-09-22', 'Pioneer');
  // the same Pioneer/Patriot badge earned as a Patriot counts at Patriot only
  done(pat, 'bible-basics-pipa:1', '2026-09-15', 'Patriot');
  done(pat, 'bible-basics-pipa:2', '2026-09-29', 'Patriot');
  st = (await call('GET', '/api/v1/faith/awards')).body;
  assert.equal(of(pia, 'Pioneer').status, 'ready');
  assert.deepEqual(of(pia, 'Pioneer').ready.map((x) => [x.requirementId, x.completedOn]), [['b-y-faith-award-pioneer-pion:3', '2026-09-22']]);
  assert.equal(of(pat, 'Pioneer').status, 'not_started');
  assert.equal(of(pat, 'Patriot').status, 'ready');

  let r = await call('POST', '/api/v1/faith/awards/record', [{ girlId: pia, requirementId: 'b-y-faith-award-pioneer-pion:3' }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.recorded[0].completedOn, '2026-09-22');
  st = (await call('GET', '/api/v1/faith/awards')).body;
  assert.equal(of(pia, 'Pioneer').status, 'earned');
  assert.equal(of(pia, 'Pioneer').earned[0].notes, 'Earned the Bible Basics badge');
  r = await call('POST', '/api/v1/faith/awards/record', [{ girlId: pia, requirementId: 'b-y-faith-award-pioneer-pion:3' }]);
  assert.equal(r.status, 409);
  r = await call('POST', '/api/v1/faith/awards/record', [{ girlId: pat, requirementId: 'b-y-faith-award-pioneer-pion:3' }]);
  assert.equal(r.status, 409, 'her badge counts at Patriot, not Pioneer');
  r = await call('POST', '/api/v1/faith/awards/record', [{ girlId: pat, requirementId: 'bible-basics-pipa:1' }]);
  assert.equal(r.status, 400, 'only Faith Award items');
});

test('faith year: meetings per unit in date order, study lessons per unit, faith coverage', async () => {
  const y = (await call('GET', '/api/v1/faith/year?from=2099-08-01&to=2099-12-31')).body;
  const ex = y.units.find((u) => u.unit === 'Explorer');
  assert.equal(ex.meetings.length, 1);
  assert.deepEqual(ex.meetings[0].studies.map((s) => s.lesson), ['Lesson 1 — Psalm 23']);
  assert.equal(ex.meetings[0].notes, 'devotion first');
  assert.equal(y.studies[0].byUnit.Explorer.next.lesson, 'Lesson 1 — Psalm 23');
  assert.equal(y.studies[0].byUnit.Explorer.lastHeld, null);
  assert.deepEqual(y.coverage.find((u) => u.unit === 'Explorer').badges.map((b) => b.badgeId).sort(), ['b-y-faith-award-explorer-expl', 'bible-basics-expl']);
  assert.equal((await call('GET', '/api/v1/faith/year?from=x&to=y')).status, 400);
});

test('studies: edit, retire; a retired study stays on its plan but is not newly planned', async () => {
  const st = (await call('GET', '/api/v1/faith/studies')).body[0];
  let r = await call('PATCH', `/api/v1/faith/studies/${st.id}`, { active: false, description: 'finished in spring' });
  assert.equal(r.status, 200);
  assert.equal(r.body.active, false);
  assert.deepEqual((await call('GET', '/api/v1/faith/studies')).body, []);
  assert.equal((await call('GET', '/api/v1/faith/studies?all=1')).body.length, 1);
  const fp = (await call('GET', `/api/v1/events/${eventId}/faith-plans`)).body[0];
  r = await call('PUT', `/api/v1/events/${eventId}/faith-plans/Explorer`, { items: fp.studies.map((s) => ({ studyId: s.studyId, lesson: s.lesson })) });
  assert.equal(r.status, 200, 'kept on the plan it was already on');
  const other = Number(db.prepare("INSERT INTO events (checkin_event_id, ical_uid, start_at, title, updated_at) VALUES (503, 'uid-503@example.com', '2099-09-08T23:00:00.000Z', 'Weekly Meeting', '2026-09-01T00:00:00Z')").run().lastInsertRowid);
  r = await call('PUT', `/api/v1/events/${other}/faith-plans/Explorer`, { items: [{ studyId: st.id }] });
  assert.equal(r.status, 400); assert.match(r.body.error, /retired/);
  assert.equal((await call('PATCH', '/api/v1/faith/studies/9999', { title: 'x' })).status, 404);
});

// ------------------------------------------------ Faith Award studies ---
const STUDIES = { studies: [
  { slug: 'creed', name: 'Creed Study', awardItem: 'Creed Study', about: 'invented', variants: [
    { levelGroup: 'Explorer', groups: [
      { label: 'Verses', rule: { type: 'all' }, steps: [{ title: 'Verse study 1', placeholder: true }, { title: 'Verse study 2', placeholder: true }] },
      { label: 'Choose 1 of 2', rule: { type: 'n_of', n: 1 }, steps: [{ title: 'Skit' }, { title: 'Poster' }] },
    ] },
  ] },
  { slug: 'seven', name: 'Seven Things', awardItem: null, variants: [
    { levelGroup: 'Pioneer/Patriot', groups: [{ label: 'Units', rule: { type: 'all' }, steps: [{ title: 'Unit 1' }, { title: 'Unit 2' }] }] },
  ] },
] };

test('studies load insert-only, survive a catalog re-import, and link to their award item', async () => {
  const r = faith.importStudies(db, STUDIES, 'admin@example.com');
  assert.deepEqual(r.added, ['study-creed-expl', 'study-seven-pipa']);
  assert.deepEqual(faith.importStudies(db, STUDIES, 'admin@example.com'), { added: [], kept: ['study-creed-expl', 'study-seven-pipa'] });
  assert.throws(() => faith.importStudies(db, { studies: [{ slug: 'Bad Slug', name: 'x', variants: [] }] }, 'x'), /refused/);
  assert.throws(() => faith.importStudies(db, { studies: [{ slug: 'x', name: 'x', variants: [{ levelGroup: 'Explorer', groups: [{ label: 'g', rule: { type: 'n_of', n: 3 }, steps: [{ title: 'a' }] }] }] }] }, 'x'), /n out of range/);
  catalog.importFromDir(db, badgesDir, { actor: 'admin@example.com' });
  assert.equal(db.prepare("SELECT active FROM badges WHERE id = 'study-creed-expl'").get().active, 1, 'the build never deactivates studies');
  const b = (await call('GET', '/api/v1/badges/study-creed-expl')).body;
  assert.deepEqual(b.groups.flatMap((g) => g.requirements.map((q) => q.trackerId)), ['study-creed-expl:1', 'study-creed-expl:2', 'study-creed-expl:3', 'study-creed-expl:4']);
  const c = (await call('GET', '/api/v1/faith')).body;
  assert.deepEqual(c.awardStudies.map((s) => [s.badgeId, s.awardItem, s.stepCount, s.placeholders]),
    [['study-creed-expl', 'Creed Study', 4, 2], ['study-seven-pipa', null, 2, 0]]);
  const item = c.awards.find((a) => a.level === 'Explorer').items.find((i) => i.title === 'Creed Study');
  assert.deepEqual(item.linkedBadges.map((x) => [x.badgeId, x.kind]), [['study-creed-expl', 'study']]);
});

test('study steps go on the faith plan and never toward AHGFamily', async () => {
  const r = await call('PUT', `/api/v1/events/${eventId}/faith-plans/Explorer`, { items: [{ requirementId: 'study-creed-expl:3', role: 'session' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.items[0].badgeFaith, 'study');
  const servicepush = require('../server/lib/servicepush');
  const exa = Number(db.prepare("INSERT INTO girls (first_name, last_name, ahg_level, ahg_youth_id, active, updated_at) VALUES ('Exa', 'Example', 'Explorer', 'u0000faith01', 1, '2026-09-01T00:00:00Z')").run().lastInsertRowid);
  const before = servicepush.unqueuedConfirmedCount(db);
  db.prepare("INSERT INTO completions (girl_id, requirement_id, status, completed_on, source, level_at_completion, proposed_at) VALUES (?, 'study-creed-expl:1', 'confirmed', '2026-10-01', 'manual', 'Explorer', '2026-10-01T00:00:00Z')").run(exa);
  assert.equal(servicepush.unqueuedConfirmedCount(db), before, 'a study step never waits for the push');
});

test('a finished study is ready to record on its award item; an unlisted one counts as earned here', async () => {
  const exa = db.prepare("SELECT id FROM girls WHERE first_name = 'Exa'").get().id;
  const done = (g, req, day, lvl) => db.prepare("INSERT INTO completions (girl_id, requirement_id, status, completed_on, source, level_at_completion, proposed_at) VALUES (?, ?, 'confirmed', ?, 'manual', ?, '2026-10-01T00:00:00Z')").run(g, req, day, lvl);
  let st = (await call('GET', '/api/v1/faith/awards')).body;
  const of = (who, level) => st.girls.find((g) => g.girlId === who).awards.find((a) => a.level === level);
  assert.equal(of(exa, 'Explorer').status, 'in_progress');
  assert.equal(of(exa, 'Explorer').underway[0].viaKind, 'study');
  done(exa, 'study-creed-expl:2', '2026-10-08', 'Explorer');
  done(exa, 'study-creed-expl:4', '2026-10-15', 'Explorer'); // the "choose 1"
  st = (await call('GET', '/api/v1/faith/awards')).body;
  assert.equal(of(exa, 'Explorer').status, 'ready');
  assert.deepEqual(of(exa, 'Explorer').ready.map((x) => [x.requirementId, x.completedOn, x.viaKind]), [['b-y-faith-award-explorer-expl:1', '2026-10-15', 'study']]);
  const r = await call('POST', '/api/v1/faith/awards/record', [{ girlId: exa, requirementId: 'b-y-faith-award-explorer-expl:1' }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  st = (await call('GET', '/api/v1/faith/awards')).body;
  assert.equal(of(exa, 'Explorer').earned[0].notes, 'Completed the Creed Study study');

  const pat = db.prepare("SELECT id FROM girls WHERE first_name = 'Pat'").get().id;
  done(pat, 'study-seven-pipa:1', '2026-10-01', 'Patriot');
  done(pat, 'study-seven-pipa:2', '2026-10-08', 'Patriot');
  st = (await call('GET', '/api/v1/faith/awards')).body;
  assert.equal(of(pat, 'Patriot').status, 'earned');
  assert.deepEqual(of(pat, 'Patriot').offline.map((x) => [x.viaBadgeName, x.completedOn]), [['Seven Things', '2026-10-08']]);
  assert.equal(of(pat, 'Pioneer').offline.length, 0, 'finished as a Patriot, it counts at Patriot only');
});

test('renaming a step: placeholders become real steps; only study steps', async () => {
  let r = await call('PATCH', '/api/v1/faith/steps/study-creed-expl:1', { title: 'Psalm 119:105' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.title, r.body.text, r.body.placeholder], ['Psalm 119:105', 'Psalm 119:105', false]);
  const b = (await call('GET', '/api/v1/badges/study-creed-expl')).body;
  assert.equal(b.groups[0].requirements[0].title, 'Psalm 119:105', 'the planner sees the new name');
  assert.equal((await call('GET', '/api/v1/faith')).body.awardStudies[0].placeholders, 1);
  assert.equal((await call('PATCH', '/api/v1/faith/steps/bible-basics-expl:1', { title: 'x' })).status, 404);
});
