'use strict';
// Synthetic HTML fixtures. Every id here is INVENTED (no real youth, record,
// award or requirement ids). Names are placeholders, never roster names.

const YOUTH = 'u0000test001';
const REC = 'ad0000test01';
const REC2 = 'ad0000test02';
const LEVEL = 'le0000test01';

const indexPage = `
<html><head><meta name="csrf-param" content="_csrf"><meta name="csrf-token" content="tok-fake-123"></head>
<body>
<select id="level-select" name="level-select">
  <option value="all" selected>All Girls</option>
  <option value="pipa">Pioneer/Patriot</option>
</select>
<select id="youth-select" name="youth-select[]" multiple>
  <option value="">Select…</option>
  <option value="${YOUTH}">Placeholder Girl</option>
  <option value="u0000test002">Another Placeholder</option>
</select>
<select id="badge-select" name="badge-select">
  <option value="">Select a badge</option>
  <optgroup label="All">
    <option value="aw0000test01">Attendance (Blue Round Bead)|attendance_blue</option>
  </optgroup>
  <optgroup label="Pioneer/Patriot">
    <option value="aw0000test02">Nature &amp; Wildlife|nature_and_wildlife_white</option>
    <option value="aw0000test03">Our Flag|our_flag_white</option>
    <option value="aw0000test08">Old Badge (Retired)|old_badge</option>
  </optgroup>
</select>
</body></html>`;

// Layout A: title before inputs, table rows, group headings as rows.
function item(n, title, id) {
  return `<tr><td>${n}.</td><td><label>${title}</label></td>
  <td><input type="checkbox" name="checkbox-${id}" value="1"></td>
  <td><input type="text" name="date-${id}" value="09/07/2026"></td>
  <td><input type="text" name="comment-${id}" value=""></td></tr>`;
}
const R = ['r00000test01', 'r00000test02', 'r00000test03', 'r00000test04', 'r00000test05', 'r00000test06', 'r00000test07', 'r00000test08', 'r00000test09', 'r00000test10', 'r00000test11'];
const fragmentTitleFirst = `
<h4>Placeholder Girl</h4>
<input type="hidden" name="level_id" value="${LEVEL}">
<input type="hidden" name="youth_id" value="${YOUTH}">
<div class="panel"><div class="panel-heading">Nature &amp; Wildlife</div>
<table>
<tr><th colspan="5">Complete All</th></tr>
${item(1, 'Tree identification hike', R[0])}
${item(2, 'Edge of a pond, lake or stream', R[1])}
${item(3, 'Take a younger Unit on a nature hike', R[2])}
${item(4, 'Three ways your Troop can help conserve nature', R[3])}
${item(5, 'Respecting local wildlife', R[4])}
<tr><th colspan="5">Complete Three</th></tr>
${item(6, 'Visit a wildlife refuge or nature center', R[5])}
${item(7, 'Conservation project', R[6])}
${item(8, 'Careers involving nature and wildlife', R[7])}
${item(9, 'Help a younger Unit', R[8])}
${item(10, 'Organizations and foundations that protect the environment', R[9])}
${item(11, 'Local endangered species', R[10])}
</table>
<label>Completed on</label><input name="completed_on-aw0000test02" value="">
<label>Awarded on</label><input name="awarded_on-aw0000test02" value="">
<input type="checkbox" name="purchased-aw0000test02" value="1">
<textarea name="comment-aw0000test02"></textarea>
</div>`;

// Layout B: checkbox first, then title; lettered leaves under numbered parents;
// two handbook-edition groups and an instruction paragraph.
function leaf(letter, title, id) {
  return `<div class="leaf"><input type="checkbox" name="checkbox-${id}"><span>${letter}. ${title}</span>
  <input name="date-${id}" value=""><input name="comment-${id}" value=""></div>`;
}
function plain(n, title, id) {
  return `<div class="req"><input type="checkbox" name="checkbox-${id}"><span>${n}. ${title}</span>
  <input name="date-${id}" value=""><input name="comment-${id}" value=""></div>`;
}
const fragmentLettered = `
<p>Choose to complete either items 1-3 under the current handbook OR items 1-2 under the 2016 handbook. Important: Only check the items for the handbook version you choose.</p>
<div class="advance-icon" data-level="${LEVEL}" data-yt="${YOUTH}"></div>
<h5>Complete All (Current Handbook)</h5>
${plain(1, 'Be an active, registered Troop Member.', 'l00000test01')}
<div class="parent"><span>2. Participate in a flag ceremony each year.</span>
${leaf('a', '1st Year', 'l00000test02')}
${leaf('b', '2nd Year', 'l00000test03')}
</div>
${plain(3, 'Participate in a Board of Review.', 'l00000test04')}
<h5>Complete All (2016 Handbook)</h5>
${plain(1, 'Complete one Badge from each Frontier', 'l00000test05')}
${plain(2, 'Successful Board of Review', 'l00000test06')}
<input name="completed_on-aw0000test09" value="">`;

// Whole-award-only, repeatable: no checkboxes, panels keyed by record id.
const fragmentBead = `
<div class="advance-icon" data-level="${LEVEL}"></div>
<div class="instance"><input type="hidden" name="new-${REC}" value="true">
<input name="completed_on-${REC}" value=""><input name="awarded_on-${REC}" value="">
<input type="checkbox" name="purchased-${REC}"><textarea name="comment-${REC}"></textarea><a href="#">Delete</a></div>
<div class="instance" style="display:none"><input type="hidden" name="new-${REC2}" value="true">
<input name="completed_on-${REC2}" value=""><input name="awarded_on-${REC2}" value="">
<input type="checkbox" name="purchased-${REC2}"><textarea name="comment-${REC2}"></textarea><a href="#">Delete</a></div>
<button>Add Awards Instance</button>`;

// Grid-style fragment (level id lives here; data-value is per-girl state)
const fragmentGrid = `<table><tr><th>Item</th><th>Placeholder Girl</th></tr>
<tr><td>1</td><td><div class="advance-icon" data-id="${R[0]}" data-yt="${YOUTH}" data-level="${LEVEL}" data-value="0"></div></td></tr>
<tr><td>2</td><td><div class="advance-icon" data-id="${R[1]}" data-yt="${YOUTH}" data-level="${LEVEL}" data-value="1" title="Earned on: 09/01/2026"></div></td></tr>
<tr><td>Purchased</td><td><div class="advance-icon purchased_level" data-id="p_${YOUTH}_${LEVEL}" data-yt="${YOUTH}" data-level="${LEVEL}" data-value="0"></div></td></tr>
</table>`;

module.exports = { fragmentGrid, YOUTH, REC, REC2, LEVEL, R, indexPage, fragmentTitleFirst, fragmentLettered, fragmentBead };
