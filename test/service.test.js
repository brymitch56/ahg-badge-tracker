'use strict';
// Service-hours page parsers, against INVENTED markup that mirrors the
// captured kartik GridView shapes (filter row in thead, page-summary row in
// its own tbody OR inside the data tbody, pager summary, toggleData
// control). Names and ids here are fictional.
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../lib/grid');
const S = require('../lib/service');

const Y1 = 'utest00000a1';
const Y2 = 'utest00000b2';

const verifiedCell = (recordId, ok) => `<td class="text-center toggle-column"><a class="verified_toggle" href="/fields/toggleServiceVerified/${recordId}?attribute=verified" title="${ok ? 'Verified' : 'Not Verified'}" rel="tooltip" data-pjax="0"><span class="glyphicon ${ok ? 'glyphicon-ok toggle-green' : 'glyphicon-remove toggle-red'}"></span></a></td>`;
const menuCell = (recordId, youthId) => `<td class="skip-export kv-align-center" data-col-seq="13"><a class="skipajax cleanLink fad fa-pencil" href="/fields/activities-update?id=${recordId}&amp;user_id=${youthId}&amp;troop_id=ttest0000001&amp;referrer=troop-activities" title="Update"></a> <a class="cleanLink" id="btn-x1" style="cursor:pointer;"><span class="cleanLink fad fa-trash" title="Delete?"></span></a></td>`;

function activityRow({ youthId, name, recordId, date, activity, type = null, level, hours, ok }) {
  return `<tr class="w0" data-sortable-id="${recordId}" data-key="${recordId}"><td class="w0" data-col-seq="0"><a class="skipajax" href="/profile?id=${youthId}"><img src="https://cdn.example.com/generic_100.png" class="img-circle" alt=""> ${name}</a></td><td class="kv-align-middle w0" data-col-seq="1">${date}</td><td class="w0" data-col-seq="2">${activity}</td><td class="w0" data-col-seq="3">${type === null ? '<span class="not-set">(not set)</span>' : type}</td><td class="w0" data-col-seq="4">${level}</td><td data-col-seq="5">0</td><td data-col-seq="6">0</td><td data-col-seq="7">0</td><td data-col-seq="8">${hours}</td><td data-col-seq="9">0</td><td data-col-seq="10">0</td>${verifiedCell(recordId, ok)}${menuCell(recordId, youthId)}</tr>`;
}

const HEAD = `<thead class="kv-table-header w0">
<tr class="kartik-sheet-style"><th data-col-seq="0"><a href="/activities?sort=user_id" data-sort="user_id">Youth</a></th><th data-col-seq="1"><a href="/activities?sort=event_date">Activity Date</a></th><th data-col-seq="2"><a class="kv-sort-link asc" href="/activities?sort=-event_title">Activity<span class="kv-sort-icon"><i class="glyphicon glyphicon-sort-by-attributes"></i></span></a></th><th data-col-seq="3">Event Type</th><th data-col-seq="4">Event Level</th><th data-col-seq="5">Tent Camping Nights</th><th data-col-seq="6">Cabin Camping Nights</th><th data-col-seq="7">Hiking Miles</th><th data-col-seq="8">Service Hours</th><th data-col-seq="9">Paddling Miles</th><th data-col-seq="10">Cycling Miles</th><th class="toggle-column">Verified<br><i id="check-all" style="cursor: pointer;"></i></th><th class="kv-align-center skip-export" data-col-seq="13">Menu</th></tr>
<tr id="w0-filters" class="kartik-sheet-style filters skip-export"><td data-col-seq="0"><select id="activitiessearch-user_id" class="form-control" name="ActivitiesSearch[user_id]"><option value="">All Youth</option><option value="${Y1}">Anders, Bea</option></select></td><td><input type="text" name="ActivitiesSearch[event_date]" value=""></td><td><input type="text" name="ActivitiesSearch[event_title]" value=""></td><td></td><td></td><td></td><td></td><td></td><td><input type="text" name="ActivitiesSearch[service_hours]" value="1"></td><td></td><td></td><td></td><td></td></tr>
</thead>`;

const SUMMARY_ROW = `<tr class="warning kv-page-summary w0"><td colspan="5">Total Activity Records: 40</td><td>0</td><td>0</td><td>0</td><td>32</td><td>0</td><td>0</td><td></td><td class="skip-export">&nbsp;</td></tr>`;

function activitiesPage({ rows, summaryInsideTbody = false, pagerSummary = 'Showing <b>1-3</b> of <b>40</b> items.' }) {
  return `<html><body><div id="w0-pjax"><div id="w0" class="grid-view is-bs3 kv-grid-bs3 kv-grid-panel" data-krajee-grid="kvGridInit_x">
<div class="panel panel-default"><div class="pull-left"><div class="pull-right"><div class="summary">${pagerSummary}</div></div></div>
<div class="kv-panel-before"><div class="btn-toolbar kv-grid-toolbar"><div class="btn-group"><a id="w0-togdata-page" class="btn btn-default" href="/activities?ActivitiesSearch%5Bservice_hours%5D=1&amp;ActivitiesSearch%5Bverified%5D=&amp;reset=1&amp;_tog1149016d=all" title="Show all data"><i class='glyphicon glyphicon-resize-full'></i> All</a></div><div class="btn-group"><a href="/activities?reset=1" class="btn btn-default" id="reset_btn">Reset</a></div></div></div>
<div class="kv-grid-container"><table class="table-basic kv-grid-table table table-hover"><colgroup><col><col></colgroup>${HEAD}
<tbody>
${rows.join('\n')}
${summaryInsideTbody ? SUMMARY_ROW : ''}
</tbody>${summaryInsideTbody ? '' : `<tbody class="kv-page-summary-container">${SUMMARY_ROW}</tbody>`}</table></div>
<div class="panel-footer"><div class="kv-panel-pager"><ul class="pagination"><li class="first disabled"><span>«</span></li><li class="active"><a href="/activities?page=1&amp;per-page=25" data-page="0">1</a></li><li><a href="/activities?page=2&amp;per-page=25" data-page="1">2</a></li></ul></div></div>
</div></div></div></body></html>`;
}

const ROWS = [
  activityRow({ youthId: Y1, name: 'Anders, Bea', recordId: 'rec000000001', date: '07/12/26', activity: 'Food pantry', level: 'Pioneer', hours: '1', ok: true }),
  activityRow({ youthId: Y1, name: 'Anders, Bea', recordId: 'rec000000002', date: '03/04/25', activity: 'Trail clean-up', type: 'Outdoors', level: 'Explorer', hours: '0', ok: true }), // 0.75 truncated to 0
  activityRow({ youthId: Y2, name: 'Blake, Cora', recordId: 'rec000000003', date: '08/30/26', activity: 'Bake sale', level: 'Pathfinder', hours: '2', ok: false }),
];

test('grid: headers, rows by label, filter + page-summary rows excluded (summary in its own tbody)', () => {
  const tables = G.parseTables(activitiesPage({ rows: ROWS }));
  assert.equal(tables.length, 1);
  const t = tables[0];
  assert.equal(t.id, 'w0');
  assert.deepEqual(t.headers.slice(0, 5), ['Youth', 'Activity Date', 'Activity', 'Event Type', 'Event Level']);
  assert.equal(t.headers[11], 'Verified', 'markup inside <th> is stripped');
  assert.equal(t.rows.length, 3, 'filter row and summary row are not data rows');
  assert.equal(t.summaryRow[0].text, 'Total Activity Records: 40');
  assert.deepEqual(t.summary, { from: 1, to: 3, total: 40 });
  assert.equal(t.toggleParam, '_tog1149016d', 'grid hash discovered from the toggle control');
  assert.equal(t.rows[0].byKey.servicehours.text, '1');
  assert.equal(t.rows[0].byKey.youth.hrefs[0], `/profile?id=${Y1}`);
  assert.match(t.rows[0].byKey.verified.hrefs[0], /toggleServiceVerified/, 'write hrefs are exposed as data, never fetched');
});

test('grid: page-summary row INSIDE tbody is still excluded (the doubling trap)', () => {
  const t = G.parseTables(activitiesPage({ rows: ROWS, summaryInsideTbody: true }))[0];
  assert.equal(t.rows.length, 3);
  assert.ok(t.summaryRow);
  const sum = t.rows.reduce((n, r) => n + Number(r.byKey.servicehours.text), 0);
  assert.equal(sum, 3, 'the 32 in the summary row is never summed');
});

test('grid: "Total N items." summary (toggleData=all view) and findTable by labels', () => {
  const tables = G.parseTables(activitiesPage({ rows: ROWS, pagerSummary: 'Total <b>671</b> items.' }));
  assert.deepEqual(tables[0].summary, { total: 671 });
  assert.ok(G.findTable(tables, ['youth', 'SERVICE HOURS']));
  assert.equal(G.findTable(tables, ['Time Spent']), null);
});

test('parseActivitiesIndex: identity from the profile link, verified from the icon, hours flagged as truncated', () => {
  const r = S.parseActivitiesIndex(activitiesPage({ rows: ROWS }));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows[0], { youthId: Y1, recordId: 'rec000000001', date: '2026-07-12', activity: 'Food pantry', eventType: null, eventLevel: 'Pioneer', hoursDisplayed: 1, verified: true });
  assert.deepEqual(r.rows[1], { youthId: Y1, recordId: 'rec000000002', date: '2025-03-04', activity: 'Trail clean-up', eventType: 'Outdoors', eventLevel: 'Explorer', hoursDisplayed: 0, verified: true });
  assert.equal(r.rows[2].verified, false);
  assert.equal(r.rows[2].eventLevel, 'Pathfinder');
  assert.deepEqual(r.distinctYouth, [Y1, Y2]);
  assert.equal(r.toggleParam, '_tog1149016d');
  assert.equal(JSON.stringify(r).includes('hundredths'), false, 'the index never offers precise hours');
});

test('parseActivitiesIndex: row-count mismatch against the pager summary is a warning', () => {
  const r = S.parseActivitiesIndex(activitiesPage({ rows: ROWS.slice(0, 2) }));
  assert.match(r.warnings.join('\n'), /summary says 3 rows on this page, parsed 2/);
});

test('hoursToHundredths / formatHundredths: exact, never float', () => {
  assert.equal(S.hoursToHundredths('1.75'), 175);
  assert.equal(S.hoursToHundredths('0.33'), 33);
  assert.equal(S.hoursToHundredths('0.333'), 33);
  assert.equal(S.hoursToHundredths('0.335'), 34);
  assert.equal(S.hoursToHundredths('14.95'), 1495);
  assert.equal(S.hoursToHundredths('2'), 200);
  assert.equal(S.hoursToHundredths('1,234.5'), 123450);
  assert.equal(S.hoursToHundredths(' 0.7 '), 70);
  assert.equal(S.hoursToHundredths(''), null);
  assert.equal(S.hoursToHundredths('(not set)'), null);
  assert.equal(S.hoursToHundredths('–'), null);
  // 0.1 + 0.2 style: three thirds make exactly one hour
  assert.equal(['0.33', '0.33', '0.34'].map(S.hoursToHundredths).reduce((a, b) => a + b, 0), 100);
  assert.equal(S.formatHundredths(1495), '14.95');
  assert.equal(S.formatHundredths(5), '0.05');
  assert.equal(S.formatHundredths(0), '0.00');
});

test('parseVerifiedCell: icon class, title, or Y/N text', () => {
  assert.equal(S.parseVerifiedCell({ html: '<span class="glyphicon glyphicon-ok toggle-green"></span>', text: '' }), true);
  assert.equal(S.parseVerifiedCell({ html: '<a title="Not Verified"><span class="toggle-red"></span></a>', text: '' }), false);
  assert.equal(S.parseVerifiedCell({ html: 'Y', text: 'Y' }), true);
  assert.equal(S.parseVerifiedCell({ html: 'N', text: 'N' }), false);
  assert.equal(S.parseVerifiedCell({ html: '?', text: '?' }), null);
});

// ---- profile page (advancement tab): three grids on one page -------------
function profilePage({ ledgerRows, eligibilityRows, awardRows, ledgerSummary = 'Showing <b>1-3</b> of <b>3</b> items.', awardsSummary = 'Showing <b>1-4</b> of <b>4</b> items.' }) {
  return `<html><body><div class="profile"><a href="/profile/${Y1}?tab=overview">Overview</a>
<div id="tab-advancement" class="tab-pane active">
  <div id="advancement_grid-pjax"><div id="advancement_grid" class="grid-view kv-grid-panel"><div class="summary">${awardsSummary}</div>
  <table class="kv-grid-table table"><thead><tr><th>Program</th><th>Awards Title</th><th>Progress</th><th>Completed On</th><th>Menu</th></tr></thead>
  <tbody>${awardRows.join('')}<tr class="warning kv-page-summary"><td colspan="5">Total Awards: 4</td></tr></tbody></table></div></div>
</div>
<div id="tab-service" class="tab-pane" style="display:none">
  <div id="service_grid" class="grid-view kv-grid-panel"><div class="summary">${ledgerSummary}</div>
  <table class="kv-grid-table table"><thead><tr><th>Service Date</th><th>Act of Service</th><th>Time Spent</th><th>Girl Level</th><th>Verified<br><i></i></th><th>Menu</th></tr>
  <tr class="filters"><td><input name="x"></td><td></td><td></td><td></td><td></td><td></td></tr></thead>
  <tbody>${ledgerRows.join('')}<tr class="warning kv-page-summary"><td colspan="2">Total Service Records: 3</td><td>99.99</td><td></td><td></td><td></td></tr></tbody></table></div>
  <h4>Total Service Hours &amp; Eligible Stars</h4>
  <table class="table"><thead><tr><th>Girl Level</th><th>On-Level Hours</th><th>Total Hours</th><th>Extra Hours</th><th>Stars Eligible</th><th>Already Recorded</th></tr></thead>
  <tbody>${eligibilityRows.join('')}</tbody></table>
</div></div></body></html>`;
}
const ledgerRow = (id, date, desc, hours, level, ok) => `<tr data-key="${id}"><td>${date}</td><td>${desc}</td><td>${hours}</td><td>${level}</td>${verifiedCell(id, ok)}<td><a href="/fields/service-update?id=${id}">edit</a> <span title="Delete?"></span></td></tr>`;
const eligRow = (level, on, total, extra, stars, rec) => `<tr><td>${level}</td><td>${on}</td><td>${total}</td><td>${extra}</td><td>${stars}</td><td>${rec}</td></tr>`;
const awardRow = (adId, awardId, program, title, progress, dates) => `<tr data-key="${adId}"><td>${program}</td><td><a href="/advancement/index?award_id=${awardId}&amp;user_id=${Y1}">${title}</a></td><td>${progress}</td><td>${dates}</td><td><a href="/advancement/update?id=${adId}">edit</a> <a class="cleanLink"><span title="Delete?"></span></a></td></tr>`;

test('parseProfileAdvancement: precise ledger, eligibility cross-check, per-instance awards with aw…/ad… ids', () => {
  const html = profilePage({
    ledgerRows: [
      ledgerRow('svc00000001', '07/12/2026', 'Food pantry', '1.75', 'Pioneer', true),
      ledgerRow('svc00000002', '03/04/2025', 'Trail clean-up', '0.75', 'Explorer', true),
      ledgerRow('svc00000003', '08/30/2026', 'Bake sale (pending)', '2.00', 'Pioneer', false),
    ],
    eligibilityRows: [
      eligRow('Tenderheart', '–', '–', '–', '0', ''),
      eligRow('Explorer', '0.75', '0.75', '0.75', '0', ''),
      eligRow('Pioneer', '3.75', '4.50', '4.50', '0', ''),
      eligRow('Patriot', '–', '–', '–', '0', ''),
    ],
    awardRows: [
      awardRow('adtest00i001', 'awmhu7yetwrh', 'Explorer', 'Service Star (Explorer)', '1/1100%', 'Completed on: 05/10/2024 Awarded on: 12/31/1969 Purchased: <span class="glyphicon glyphicon-ok"></span>'),
      awardRow('adtest00i002', 'awmhu7yetwrh', 'Explorer', 'Service Star (Explorer)', '1/1100%', 'Completed on: 05/10/2024 Awarded on: 06/01/2024'),
      awardRow('adtest00i003', 'awmhu7yetwrh', 'Explorer', 'Service Star (Explorer)', '1/1100%', 'Completed on: 05/10/2024'),
      awardRow('adtest00i004', 'aw0000test02', 'Pioneer/Patriot', 'Nature &amp; Wildlife', '4/1233%', ''),
    ],
  });
  const p = S.parseProfileAdvancement(html);
  assert.deepEqual(p.warnings, []);
  assert.equal(p.youthId, Y1);
  assert.equal(p.ledger.complete, true);
  assert.deepEqual(p.ledger.rows, [
    { recordId: 'svc00000001', date: '2026-07-12', description: 'Food pantry', hundredths: 175, level: 'Pioneer', verified: true },
    { recordId: 'svc00000002', date: '2025-03-04', description: 'Trail clean-up', hundredths: 75, level: 'Explorer', verified: true },
    { recordId: 'svc00000003', date: '2026-08-30', description: 'Bake sale (pending)', hundredths: 200, level: 'Pioneer', verified: false },
  ]);
  assert.deepEqual(p.eligibility.rows[2], { level: 'Pioneer', onLevel: 375, total: 450, extra: 450, starsEligible: 0 });
  assert.deepEqual(p.eligibility.rows[0], { level: 'Tenderheart', onLevel: null, total: null, extra: null, starsEligible: 0 });
  assert.equal(p.awards.complete, true);
  assert.equal(p.awards.rows.length, 4, 'same-date instances are separate rows');
  assert.deepEqual(p.awards.rows[0], { awardId: 'awmhu7yetwrh', adId: 'adtest00i001', program: 'Explorer', title: 'Service Star (Explorer)', progress: { done: 1, total: 1, pct: 100 }, completedOn: '2024-05-10', awardedOn: null, purchased: true });
  assert.equal(p.awards.rows[1].awardedOn, '2024-06-01');
  assert.equal(p.awards.rows[1].purchased, false);
  assert.deepEqual(p.awards.rows[3].progress, { done: 4, total: 12, pct: 33 });
  assert.equal(p.awards.rows[3].title, 'Nature & Wildlife');
  assert.equal(p.awards.rows[3].completedOn, null);
  assert.equal(JSON.stringify(p).includes('alreadyRecorded'), false, 'the lossy Already Recorded column is never exposed');
});

test('parseProfileAdvancement: a paged ledger is reported incomplete (never trust a partial read)', () => {
  const html = profilePage({
    ledgerRows: [ledgerRow('svc00000001', '07/12/2026', 'Food pantry', '1.75', 'Pioneer', true)],
    ledgerSummary: 'Showing <b>1-1</b> of <b>101</b> items.',
    eligibilityRows: [],
    awardRows: [],
    awardsSummary: 'Showing <b>0-0</b> of <b>0</b> items.',
  });
  const p = S.parseProfileAdvancement(html);
  assert.equal(p.ledger.complete, false);
  assert.match(p.warnings.join('\n'), /ledger: 101 rows in total, this page ends at 1 — PAGE/);
});

test('parseProgress: adjacent "done/total pct%" renderings', () => {
  assert.deepEqual(S.parseProgress('10/12 83%'), { done: 10, total: 12, pct: 83 });
  assert.deepEqual(S.parseProgress('10/1283%'), { done: 10, total: 12, pct: 83 });
  assert.deepEqual(S.parseProgress('1/1100%'), { done: 1, total: 1, pct: 100 });
  assert.deepEqual(S.parseProgress('0/100%'), { done: 0, total: 10, pct: 0 });
  assert.equal(S.parseProgress(''), null);
});
