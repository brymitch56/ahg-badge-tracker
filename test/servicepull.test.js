'use strict';
// Service Stars read side (build steps 2–4): migration, weekly pull into
// the service_hours / award_instances mirrors, baseline on first sight,
// star proposals, conflicts, the Stars view and bulk decisions. Entirely
// offline: the AHGFamily session is an injected fixture serving INVENTED
// markup and ids (utest…, adtest…) — no network, ever.
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { makeConfig } = require('../server/config');
const { openDb, migrate } = require('../server/db');
const { createApp } = require('../server/app');
const mapping = require('../server/lib/mapping');
const servicepull = require('../server/lib/servicepull');
const { makeCheckinClient } = require('../server/lib/checkin');
const { makeScheduler } = require('../server/lib/scheduler');
const A = require('../lib/ahgfamily');
const stars = require('../lib/stars');

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000002';
const GROUP = '00000000-0000-0000-0000-000000000003';
const KEY = Buffer.from('cd'.repeat(32), 'hex');
const Y_BEA = 'utest0000001';
const Y_CORA = 'utest0000002';

let keys; let jwks; let db; let cfg; let server; let base;
let bea; let cora; let dot;

async function token(claims = {}) {
  return new SignJWT({ scp: 'access_as_leader', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`).setAudience(CLIENT)
    .setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
}
const get = (p, t, init = {}) => fetch(base + p, { ...init, headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), 'Content-Type': 'application/json', ...(init.headers || {}) } });

// ---- synthetic AHGFamily pages -------------------------------------------
const verifiedCell = (id, ok) => `<td class="toggle-column"><a class="verified_toggle" href="/fields/toggleServiceVerified/${id}?attribute=verified" title="${ok ? 'Verified' : 'Not Verified'}"><span class="glyphicon ${ok ? 'glyphicon-ok toggle-green' : 'glyphicon-remove toggle-red'}"></span></a></td>`;
const ledgerRow = ({ id, date, desc, hours, level, ok = true }) => `<tr data-key="${id}"><td>${date}</td><td>${desc}</td><td>${hours}</td><td>${level}</td>${verifiedCell(id, ok)}<td><span title="Delete?"></span></td></tr>`;

/** profile page: ledger rows for this page, pager summary, optional next-page hrefs */
function profilePage(youthId, { rows, from = 1, total = rows.length, pager = [], eligibility = [] }) {
  const to = from + rows.length - 1;
  const pagerHtml = pager.length ? `<ul class="pagination">${pager.map((h, i) => `<li><a href="${h}" data-page="${i}">${i + 1}</a></li>`).join('')}</ul>` : '';
  return `<html><body><a href="/profile/${youthId}?tab=overview">Overview</a>
<div id="tab-advancement" class="tab-pane active"><div id="advancement_grid" class="grid-view"><div class="summary">Showing <b>1-0</b> of <b>0</b> items.</div>
<table class="kv-grid-table"><thead><tr><th>Program</th><th>Awards Title</th><th>Progress</th><th>Completed On</th><th>Menu</th></tr></thead><tbody></tbody></table></div></div>
<div id="tab-service" class="tab-pane"><div id="service_grid" class="grid-view"><div class="summary">Showing <b>${from}-${to}</b> of <b>${total}</b> items.</div>
<table class="kv-grid-table"><thead><tr><th>Service Date</th><th>Act of Service</th><th>Time Spent</th><th>Girl Level</th><th>Verified</th><th>Menu</th></tr></thead>
<tbody>${rows.map(ledgerRow).join('')}<tr class="warning kv-page-summary"><td colspan="2">Total Service Records: ${total}</td><td>999.99</td><td></td><td></td><td></td></tr></tbody></table>
<div class="panel-footer">${pagerHtml}</div></div>
<table class="table"><thead><tr><th>Girl Level</th><th>On-Level Hours</th><th>Total Hours</th><th>Extra Hours</th><th>Stars Eligible</th><th>Already Recorded</th></tr></thead>
<tbody>${eligibility.map((e) => `<tr><td>${e.level}</td><td>${e.on}</td><td>${e.total}</td><td>${e.extra}</td><td>${e.stars}</td><td></td></tr>`).join('')}</tbody></table>
</div></body></html>`;
}

const panel = (adId, { isNew = false, completedOn = '', comment = '' } = {}) => `<div>${isNew ? `<input type="hidden" name="new-${adId}" value="true">` : ''}
  <input type="text" name="completed_on-${adId}" value="${completedOn}"><input type="text" name="awarded_on-${adId}" value=""><input type="text" name="purchased-${adId}" value=""><input type="text" name="comment-${adId}" value="${comment}"></div>`;
/** Standard fragment: N saved instances + N blank slots (the live shape) */
const standardHtml = (saved) => `<form>${saved.map((s, i) => panel(s.adId, { completedOn: s.completedOn })).join('')}${saved.map((s, i) => panel(`adblank000${String(i).padStart(2, '0')}`, { isNew: true })).join('')}${saved.length ? '' : panel('adblank00000', { isNew: true })}</form>`;

// mutable scenario the fake session serves
const scenario = { profiles: {}, standard: {}, pageCalls: [], standardCalls: [], closed: 0, fail: null };
const fakeSessionFactory = async () => {
  if (scenario.fail) throw scenario.fail;
  return {
    async page(p) {
      scenario.pageCalls.push(p);
      A.assertAllowed(A.makeConfig({}), p, 'GET'); // the live session would enforce this too
      const [path, query] = p.split('?');
      const yid = path.split('/')[2];
      const prof = scenario.profiles[yid];
      if (!prof) return '<html><body>nothing here</body></html>';
      const page = /page=(\d+)/.exec(query || '');
      return prof[page ? Number(page[1]) : 1] || prof[1];
    },
    async standard(awardId, youthId) {
      scenario.standardCalls.push([awardId, youthId]);
      return standardHtml((scenario.standard[youthId] || {})[awardId] || []);
    },
    async close() { scenario.closed += 1; },
  };
};

test.before(async () => {
  keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] });
  cfg = makeConfig({ MSAL_TENANT_ID: TENANT, MSAL_CLIENT_ID: CLIENT, LEADER_GROUP_ID: GROUP, ADMIN_EMAILS: 'admin@example.com', DB_PATH: ':memory:', CRED_KEY: KEY.toString('hex'), TZ: 'UTC' });
  db = openDb(':memory:');
  migrate(db);
  const addGirl = (first, last, level, youthId) => Number(db.prepare(
    "INSERT INTO girls (first_name, last_name, ahg_level, ahg_youth_id, ahg_youth_id_source, active, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
  ).run(first, last, level, youthId, youthId ? 'manual' : null, new Date().toISOString()).lastInsertRowid);
  bea = addGirl('Bea', 'Anders', 'Pioneer', Y_BEA);
  cora = addGirl('Cora', 'Blake', 'Patriot', Y_CORA);
  dot = addGirl('Dot', 'Cole', 'Explorer', null); // unmapped — never fetched
  const app = createApp({ cfg, db, jwks, ahgSessionFactory: fakeSessionFactory });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

test('migration 006: tables exist, push_queue accepts add_instance and still rejects unknown actions', () => {
  for (const t of ['service_hours', 'award_instances', 'star_baseline', 'star_proposals']) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
  }
  const ins = (action) => db.prepare("INSERT INTO push_queue (girl_id, action, created_at, ahg_award_id) VALUES (?, ?, '2026-09-08T00:00:00Z', 'awfhjudhre98')").run(bea, action);
  const r = ins('add_instance');
  db.prepare('DELETE FROM push_queue WHERE id = ?').run(r.lastInsertRowid);
  assert.throws(() => ins('explode'), /CHECK constraint/);
});

test('allow-list: profile/activities reads pass; the write endpoints are refused even as GET', () => {
  const c = A.makeConfig({});
  assert.doesNotThrow(() => A.assertAllowed(c, `/profile/${Y_BEA}?tab=advancement`, 'GET'));
  assert.doesNotThrow(() => A.assertAllowed(c, `/profile?id=${Y_BEA}`, 'GET'));
  assert.doesNotThrow(() => A.assertAllowed(c, '/activities?ActivitiesSearch%5Bservice_hours%5D=1', 'GET'));
  assert.throws(() => A.assertAllowed(c, `/profile/${Y_BEA}`, 'POST'), /not in the read-only allow-list/);
  assert.throws(() => A.assertAllowed(c, '/fields/toggleServiceVerified/abc123?attribute=verified', 'GET'), /changes data on AHGFamily and is never called/);
  assert.throws(() => A.assertAllowed(c, '/advancement/delete?id=x', 'GET'), /never called/);
  assert.throws(() => A.assertAllowed(c, '/fields/activities-update?id=x', 'GET'), /never called/);
  assert.throws(() => A.assertAllowed(c, '/advancement/index', 'POST'), /not in the read-only allow-list/);
});

test('starLevelsFor: levels a girl can hold', () => {
  assert.deepEqual(servicepull.starLevelsFor('Pathfinder'), []);
  assert.deepEqual(servicepull.starLevelsFor('Explorer'), ['Tenderheart', 'Explorer']);
  assert.deepEqual(servicepull.starLevelsFor(null), stars.STAR_LEVELS);
});

test('pull: paged ledger + star fragments → mirrors, first-sight baseline, proposals; unmapped girl untouched', async () => {
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  // Bea (Pioneer): TH 7.50 approved (1 star, carries 2.50) — 1 TH star on record already;
  // Explorer: nothing; Pioneer 12.50 approved + 2.50 carry = 15.00 → 1 star, none on record.
  // Her ledger spans two pages (100-row grids on the live site — here 2 + 1).
  scenario.profiles[Y_BEA] = {
    1: profilePage(Y_BEA, {
      rows: [
        { id: 'svc00000001', date: '10/03/2021', desc: 'Food pantry', hours: '5.00', level: 'Tenderheart' },
        { id: 'svc00000002', date: '11/14/2021', desc: 'Coat drive', hours: '2.50', level: 'Tenderheart' },
      ],
      total: 4, pager: [`/profile/${Y_BEA}?tab=advancement&page=1`, `/profile/${Y_BEA}?tab=advancement&page=2`],
      eligibility: [{ level: 'Tenderheart', on: '7.50', total: '7.50', extra: '2.50', stars: '1' }, { level: 'Pioneer', on: '12.50', total: '15.00', extra: '0.00', stars: '1' }],
    }),
    2: profilePage(Y_BEA, {
      rows: [
        { id: 'svc00000003', date: '04/22/2026', desc: 'Park clean-up', hours: '12.50', level: 'Pioneer' },
        { id: 'svc00000004', date: '05/01/2026', desc: 'Bake sale (pending)', hours: '3.00', level: 'Pioneer', ok: false },
      ],
      from: 3, total: 4, pager: [`/profile/${Y_BEA}?tab=advancement&page=1`, `/profile/${Y_BEA}?tab=advancement&page=2`],
    }),
  };
  scenario.standard[Y_BEA] = { [stars.STAR_AWARD_IDS.Tenderheart]: [{ adId: 'adtest0000t1', completedOn: '12/05/2021' }] };
  // Cora (Patriot): 3 legacy Explorer stars, no hours behind them; Patriot 41.00 h → 2 stars, 1 on record.
  scenario.profiles[Y_CORA] = {
    1: profilePage(Y_CORA, {
      rows: [
        { id: 'svc00000011', date: '01/10/2026', desc: 'Shelter meals', hours: '20.50', level: 'Patriot' },
        { id: 'svc00000012', date: '03/15/2026', desc: 'Shelter meals', hours: '20.50', level: 'Patriot' },
        { id: 'svc00000013', date: '02/02/2019', desc: 'Old Pathfinder row', hours: '4.00', level: 'Pathfinder' },
      ],
    }),
  };
  scenario.standard[Y_CORA] = {
    [stars.STAR_AWARD_IDS.Explorer]: [{ adId: 'adtest0000e1', completedOn: '05/10/2020' }, { adId: 'adtest0000e2', completedOn: '05/10/2020' }, { adId: 'adtest0000e3', completedOn: '05/10/2020' }],
    [stars.STAR_AWARD_IDS.Patriot]: [{ adId: 'adtest0000p1', completedOn: '04/01/2026' }],
  };

  const r = await get('/api/v1/sync/service', adminT, { method: 'POST' });
  const body = await r.text();
  assert.equal(r.status, 200, body);
  const s = JSON.parse(body);
  assert.equal(s.kind, 'service');
  // requests: Bea 2 profile pages + 3 star levels (TH/EX/PI); Cora 1 page + 4 levels
  assert.deepEqual({ girls: s.girls, requests: s.requests, ledgerRows: s.ledgerRows, instances: s.instances }, { girls: 2, requests: 10, ledgerRows: 7, instances: 5 });
  assert.deepEqual({ baselines: s.baselines, proposed: s.proposed, conflicts: s.conflicts, withdrawn: s.withdrawn }, { baselines: 7, proposed: 2, conflicts: 0, withdrawn: 0 });
  assert.equal(scenario.closed, 1, 'logout after the run');
  assert.ok(scenario.pageCalls.every((p) => p.startsWith('/profile/')), 'only profile pages were fetched');
  assert.ok(!scenario.pageCalls.some((p) => /toggleServiceVerified|Delete/.test(p)), 'never follows write hrefs');
  assert.deepEqual(scenario.standardCalls.filter(([, y]) => y === Y_BEA).map(([a]) => stars.LEVEL_BY_AWARD_ID[a]), ['Tenderheart', 'Explorer', 'Pioneer'], 'star levels up to her own only');

  // mirrors
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM service_hours WHERE girl_id = ?').get(bea).n, 4);
  assert.equal(db.prepare('SELECT hundredths FROM service_hours WHERE ahg_record_id = ?').get('svc00000003').hundredths, 1250);
  assert.equal(db.prepare('SELECT verified FROM service_hours WHERE ahg_record_id = ?').get('svc00000004').verified, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM service_hours WHERE girl_id = ?').get(dot).n, 0, 'unmapped girl never touched');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM award_instances WHERE girl_id = ? AND ahg_award_id = ?").get(cora, stars.STAR_AWARD_IDS.Explorer).n, 3, 'same-date instances counted by record id');
  assert.equal(db.prepare('SELECT completed_on FROM award_instances WHERE ad_record_id = ?').get('adtest0000t1').completed_on, '2021-12-05');

  // proposals: Bea's Pioneer #1; Cora's Patriot #2 (her 3 legacy Explorer stars are baseline, not conflicts)
  const props = db.prepare("SELECT girl_id, level, ordinal, hours_hundredths, carry_in FROM star_proposals WHERE status = 'proposed' ORDER BY girl_id").all();
  assert.deepEqual(props, [
    { girl_id: bea, level: 'Pioneer', ordinal: 1, hours_hundredths: 1500, carry_in: 250 },
    { girl_id: cora, level: 'Patriot', ordinal: 2, hours_hundredths: 4100, carry_in: 0 },
  ]);
  assert.deepEqual(db.prepare('SELECT on_record, earnable FROM star_baseline WHERE girl_id = ? AND level = ?').get(cora, 'Explorer'), { on_record: 3, earnable: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM conflicts WHERE status = 'open'").get().n, 0);

  // idempotent: same data again → nothing new
  const s2 = await (await get('/api/v1/sync/service', adminT, { method: 'POST' })).json();
  assert.deepEqual({ baselines: s2.baselines, proposed: s2.proposed, conflicts: s2.conflicts, withdrawn: s2.withdrawn }, { baselines: 0, proposed: 0, conflicts: 0, withdrawn: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM star_proposals WHERE status = 'proposed'").get().n, 2);
});

test('stars view: hours, carry, on record, pending hours, next-star progress; proposals list', async () => {
  const leaderT = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  const v = await (await get('/api/v1/stars', leaderT)).json();
  assert.ok(v.lastPull && v.lastPull.ok);
  assert.deepEqual(v.rates, { Tenderheart: 5, Explorer: 10, Pioneer: 15, Patriot: 20 });
  const b = v.girls.find((g) => g.id === bea);
  const th = b.levels.find((l) => l.level === 'Tenderheart');
  const pi = b.levels.find((l) => l.level === 'Pioneer');
  assert.deepEqual({ hours: th.hours, earnable: th.earnable, onRecord: th.onRecord, carryOut: th.carryOut, newStars: th.newStars }, { hours: 7.5, earnable: 1, onRecord: 1, carryOut: 2.5, newStars: 0 });
  assert.deepEqual({ carryIn: pi.carryIn, available: pi.available, earnable: pi.earnable, onRecord: pi.onRecord, newStars: pi.newStars, pending: pi.proposedPending, pendingHours: pi.pendingHours, current: pi.current },
    { carryIn: 2.5, available: 15, earnable: 1, onRecord: 0, newStars: 1, pending: 1, pendingHours: 3, current: true });
  assert.equal(b.totalApprovedHours, 20);
  const d = v.girls.find((g) => g.id === dot);
  assert.equal(d.mapped, false);
  assert.equal(d.levels.every((l) => l.hours === 0), true);
  const c = v.girls.find((g) => g.id === cora);
  assert.equal(c.levels.find((l) => l.level === 'Explorer').legacy, 3);
  assert.deepEqual(c.pathfinderHours, { entries: 1, approved: 4, pending: 0 }, 'Pathfinder rows surfaced for review on AHGFamily');
  assert.equal(b.pathfinderHours, null);
  assert.equal(c.levels.find((l) => l.level === 'Patriot').toNextHours, 19, '41 h → 2 stars, 1.00 carry → 19.00 to the next');

  const props = await (await get('/api/v1/stars/proposals', leaderT)).json();
  assert.equal(props.length, 2);
  assert.deepEqual({ girl: props[0].firstName, level: props[0].level, ordinal: props[0].ordinal, hours: props[0].hoursDisplay, rate: props[0].rate }, { girl: 'Bea', level: 'Pioneer', ordinal: 1, hours: '15.00', rate: 15 });
});

test('decide: bulk confirm/reject; confirm stamps today and queues an idle add_instance with a provenance comment', async () => {
  const leaderT = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  const props = await (await get('/api/v1/stars/proposals', leaderT)).json();
  const beaP = props.find((p) => p.girlId === bea);
  const coraP = props.find((p) => p.girlId === cora);
  let r = await get('/api/v1/stars/proposals/decide', leaderT, { method: 'POST', body: JSON.stringify([{ id: beaP.id, decision: 'maybe' }]) });
  assert.equal(r.status, 400);
  r = await get('/api/v1/stars/proposals/decide', leaderT, { method: 'POST', body: JSON.stringify([
    { id: beaP.id, decision: 'confirm' },
    { id: coraP.id, decision: 'reject', note: 'hours were logged twice' },
  ]) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), [{ id: beaP.id, status: 'confirmed' }, { id: coraP.id, status: 'rejected' }]);
  const today = new Date().toISOString().slice(0, 10);
  const p = db.prepare('SELECT * FROM star_proposals WHERE id = ?').get(beaP.id);
  assert.deepEqual({ status: p.status, by: p.decided_by, on: p.completed_on }, { status: 'confirmed', by: 'leader@example.com', on: today });
  const q = db.prepare("SELECT * FROM push_queue WHERE star_proposal_id = ?").get(beaP.id);
  assert.deepEqual({ action: q.action, status: q.status, award: q.ahg_award_id, date: q.date, girl: q.girl_id }, { action: 'add_instance', status: 'queued', award: stars.STAR_AWARD_IDS.Pioneer, date: today, girl: bea });
  assert.equal(JSON.parse(q.detail).comment, `tracker: 15.00h Pioneer, confirmed ${today}`);
  assert.equal((await get('/api/v1/stars/proposals/decide', leaderT, { method: 'POST', body: JSON.stringify([{ id: beaP.id, decision: 'confirm' }]) })).status, 409, 'already decided');
  const queue = await (await get('/api/v1/sync/queue', leaderT)).json();
  assert.equal(queue.find((x) => x.action === 'add_instance').detail.level, 'Pioneer');
  // a rejected ordinal is not re-proposed by the next pull
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  const s = await (await get('/api/v1/sync/service', adminT, { method: 'POST' })).json();
  assert.equal(s.proposed, 0);
});

test('pull: movement after baseline — hand-added star records the confirmed one; an unexplained extra is a conflict; removal is a conflict', async () => {
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  const leaderT = await token({ groups: [GROUP], preferred_username: 'leader@example.com' });
  // Bea's Pioneer star now appears on AHGFamily (a leader added it by hand, or the future push did)
  scenario.standard[Y_BEA][stars.STAR_AWARD_IDS.Pioneer] = [{ adId: 'adtest0000p9', completedOn: '09/08/2026' }];
  // Cora gains a 4th Explorer star with no hours behind it, and loses one Patriot instance
  scenario.standard[Y_CORA][stars.STAR_AWARD_IDS.Explorer].push({ adId: 'adtest0000e4', completedOn: '09/01/2026' });
  scenario.standard[Y_CORA][stars.STAR_AWARD_IDS.Patriot] = [];
  const s = await (await get('/api/v1/sync/service', adminT, { method: 'POST' })).json();
  assert.deepEqual({ recorded: s.recorded, conflicts: s.conflicts, proposed: s.proposed }, { recorded: 1, conflicts: 2, proposed: 0 });
  assert.equal(db.prepare("SELECT status FROM star_proposals WHERE girl_id = ? AND level = 'Pioneer'").get(bea).status, 'recorded');
  assert.equal(db.prepare("SELECT status FROM push_queue WHERE girl_id = ? AND action = 'add_instance'").get(bea).status, 'skipped', 'queued push no longer needed');
  assert.equal(db.prepare('SELECT missing_since FROM award_instances WHERE ad_record_id = ?').get('adtest0000p1').missing_since !== null, true);
  const open = await (await get('/api/v1/conflicts', leaderT)).json();
  assert.deepEqual(open.map((c) => [c.firstName, c.kind, c.detail.level]).sort(), [['Cora', 'star_instance_removed', 'Patriot'], ['Cora', 'star_more_on_record', 'Explorer']]);
  assert.equal(open[0].requirementId, null);
  // accepting AHGFamily re-baselines the level; the next pull stays quiet
  const ex = open.find((c) => c.kind === 'star_more_on_record');
  const r = await get(`/api/v1/conflicts/${ex.id}/resolve`, leaderT, { method: 'POST', body: JSON.stringify({ resolution: 'accept_ahgfamily', note: 'paper record found' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(db.prepare('SELECT on_record, earnable FROM star_baseline WHERE girl_id = ? AND level = ?').get(cora, 'Explorer'), { on_record: 4, earnable: 0 });
  const s2 = await (await get('/api/v1/sync/service', adminT, { method: 'POST' })).json();
  assert.equal(s2.conflicts, 0, 'removal conflict still open (not re-raised), Explorer explained');
  // same pull twice → still the same single open removal conflict
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM conflicts WHERE status = 'open'").get().n, 1);
});

test('pull: an unreadable or incomplete ledger aborts the run and writes NOTHING', async () => {
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  const before = db.prepare('SELECT COUNT(*) AS n, MAX(fetched_at) AS t FROM service_hours').get();
  // Cora's profile now claims 5 rows but renders 3 with no pager
  scenario.profiles[Y_CORA] = { 1: profilePage(Y_CORA, { rows: [
    { id: 'svc00000011', date: '01/10/2026', desc: 'Shelter meals', hours: '20.50', level: 'Patriot' },
    { id: 'svc00000012', date: '03/15/2026', desc: 'Shelter meals', hours: '20.50', level: 'Patriot' },
    { id: 'svc00000013', date: '02/02/2019', desc: 'Old Pathfinder row', hours: '4.00', level: 'Pathfinder' },
  ], total: 5 }) };
  let r = await get('/api/v1/sync/service', adminT, { method: 'POST' });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /no next-page link — run aborted/);
  // an approved row with unreadable hours
  scenario.profiles[Y_CORA] = { 1: profilePage(Y_CORA, { rows: [{ id: 'svc00000011', date: '01/10/2026', desc: 'x', hours: 'n/a', level: 'Patriot' }] }) };
  r = await get('/api/v1/sync/service', adminT, { method: 'POST' });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /unreadable hours/);
  // a profile with no ledger at all (role scoping / layout change)
  scenario.profiles[Y_CORA] = { 1: '<html><body><p>Access denied</p></body></html>' };
  r = await get('/api/v1/sync/service', adminT, { method: 'POST' });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /no service ledger/);
  const after = db.prepare('SELECT COUNT(*) AS n, MAX(fetched_at) AS t FROM service_hours').get();
  assert.deepEqual(after, before, 'nothing written by a failed run');
  assert.equal(db.prepare("SELECT ok FROM sync_runs ORDER BY id DESC LIMIT 1").get().ok, 0, 'failure recorded');
});

test('rule 8: auth failure latches the service pull too; scheduler runs it weekly on its own cadence', async () => {
  const adminT = await token({ groups: [GROUP], preferred_username: 'admin@example.com' });
  scenario.fail = new A.FetchError(A.EXIT.AUTH, 'Login rejected.');
  let r = await get('/api/v1/sync/service', adminT, { method: 'POST' });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).latched, true);
  scenario.fail = null;
  const calls = scenario.pageCalls.length;
  r = await get('/api/v1/sync/service', adminT, { method: 'POST' });
  assert.equal(r.status, 409, 'still latched');
  assert.equal(scenario.pageCalls.length, calls, 'no traffic while latched');
  mapping.storeCredentials(db, { email: 'leader@example.com', password: 'fake-password-never-real' }, 'admin@example.com', KEY);

  // scheduler on a fresh db: weekly service pull beside the badge pull
  const sdb = openDb(':memory:');
  migrate(sdb);
  sdb.prepare("INSERT INTO girls (first_name, last_name, ahg_level, ahg_youth_id, active, updated_at) VALUES ('Bea', 'Anders', 'Pioneer', ?, 1, '2026-09-01T00:00:00Z')").run(Y_BEA);
  mapping.storeCredentials(sdb, { email: 'leader@example.com', password: 'fake-password-never-real' }, 'admin@example.com', KEY);
  const client = makeCheckinClient({ base: '', apiKey: '' });
  const sched = makeScheduler({ cfg, db: sdb, client, credKey: KEY, ahgSessionFactory: fakeSessionFactory, log: () => {} });
  const nowMs = Date.now();
  let out = await sched.tick(nowMs);
  assert.equal(out.service && out.service.kind, 'service');
  assert.equal(sdb.prepare('SELECT COUNT(*) AS n FROM service_hours').get().n, 4);
  const pages = scenario.pageCalls.length;
  out = await sched.tick(nowMs + 60e3);
  assert.equal(out.service, undefined, 'weekly cadence');
  assert.equal(scenario.pageCalls.length, pages);
  out = await sched.tick(nowMs + 8 * 24 * 3600e3);
  assert.equal(out.service && out.service.kind, 'service');
  sdb.close();
});
