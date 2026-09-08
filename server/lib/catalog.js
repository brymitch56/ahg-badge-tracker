'use strict';
/**
 * Catalog import: data/badges/*.json (built by scripts/build-badges.js) →
 * catalog_versions / badges / badge_groups / requirements.
 *
 * Versioned and non-destructive (spec rule 10): every import creates a
 * catalog_versions row; badges and requirements are upserted by id; anything
 * missing from the new build is marked active=0, never deleted, so
 * completions keep their foreign keys. Requirements are additionally matched
 * on ahg_requirement_id so a renumbered item keeps its history. Orphans —
 * inactive requirements that still have live completions — are reported.
 */
const fs = require('fs');
const path = require('path');

const j = (v) => JSON.stringify(v ?? null);

function readBadgesDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ file: f, badge: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

function validateBadge(b) {
  const errs = [];
  for (const k of ['id', 'awardId', 'name', 'levelGroup', 'groups']) if (b[k] === undefined || b[k] === null) errs.push(`missing ${k}`);
  if (!Array.isArray(b.groups)) errs.push('groups not an array');
  else b.groups.forEach((g, gi) => {
    if (!Array.isArray(g.requirements)) errs.push(`group ${gi + 1}: requirements not an array`);
    else g.requirements.forEach((r) => {
      if (typeof r.number !== 'number') errs.push(`requirement without number in group ${gi + 1}`);
      if (!r.ahgFamilyId) errs.push(`requirement ${r.number}${r.letter || ''}: no ahgFamilyId`);
      if (!r.text) errs.push(`requirement ${r.number}${r.letter || ''}: no text`);
    });
  });
  return errs;
}

/** Import a list of built badges. Returns a summary; throws on validation errors. */
function importBadges(db, badges, { actor = 'system', notes = null, sourceGeneratedAt = null } = {}) {
  const errors = [];
  for (const { file, badge } of badges) for (const e of validateBadge(badge)) errors.push(`${file}: ${e}`);
  if (errors.length) { const err = new Error(`catalog import refused:\n  ${errors.join('\n  ')}`); err.errors = errors; throw err; }

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const reqCount = badges.reduce((n, { badge }) => n + badge.groups.reduce((m, g) => m + g.requirements.length, 0), 0);
    const version = db.prepare('INSERT INTO catalog_versions (imported_at, source_generated_at, badge_count, requirement_count, notes) VALUES (?, ?, ?, ?, ?)')
      .run(now, sourceGeneratedAt, badges.length, reqCount, notes).lastInsertRowid;

    const upBadge = db.prepare(`INSERT INTO badges (id, catalog_version_id, ahg_award_id, name, level_group, frontier, levels, classic, pages, image_paths, intro, ahg_history, faith_text, faith_reference, json, active)
      VALUES (@id, @v, @award, @name, @lg, @frontier, @levels, @classic, @pages, @images, @intro, @hist, @ftext, @fref, @json, 1)
      ON CONFLICT(id) DO UPDATE SET catalog_version_id=excluded.catalog_version_id, ahg_award_id=excluded.ahg_award_id, name=excluded.name, level_group=excluded.level_group, frontier=excluded.frontier,
        levels=excluded.levels, classic=excluded.classic, pages=excluded.pages, image_paths=excluded.image_paths, intro=excluded.intro, ahg_history=excluded.ahg_history,
        faith_text=excluded.faith_text, faith_reference=excluded.faith_reference, json=excluded.json, active=1`);
    const upGroup = db.prepare(`INSERT INTO badge_groups (id, badge_id, position, label, rule_type, rule_n) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label, rule_type=excluded.rule_type, rule_n=excluded.rule_n`);
    const findByAhg = db.prepare('SELECT id FROM requirements WHERE ahg_requirement_id = ?');
    const renameReq = db.prepare('UPDATE requirements SET id = ? WHERE id = ?');
    const upReq = db.prepare(`INSERT INTO requirements (id, badge_id, group_id, number, letter, ahg_requirement_id, title, text, sub_items, flags, active)
      VALUES (@id, @badge, @group, @number, @letter, @ahg, @title, @text, @sub, @flags, 1)
      ON CONFLICT(id) DO UPDATE SET badge_id=excluded.badge_id, group_id=excluded.group_id, number=excluded.number, letter=excluded.letter, ahg_requirement_id=excluded.ahg_requirement_id,
        title=excluded.title, text=excluded.text, sub_items=excluded.sub_items, flags=excluded.flags, active=1`);

    const seenBadges = new Set(); const seenReqs = new Set();
    let renumbered = 0;
    for (const { badge: b } of badges) {
      seenBadges.add(b.id);
      const fc = b.faithConnection || {};
      const hb = b.handbook || {};
      upBadge.run({ id: b.id, v: version, award: b.awardId, name: b.name, lg: b.levelGroup, frontier: b.frontier || null, levels: j(b.levels || []), classic: b.classic ? 1 : 0, pages: j(hb.pages || []), images: j(hb.images || []), intro: b.intro || null, hist: b.ahgHistory || null, ftext: fc.text || null, fref: fc.reference || null, json: JSON.stringify(b) });
      b.groups.forEach((g, gi) => {
        const gid = `${b.id}:${gi + 1}`;
        upGroup.run(gid, b.id, gi + 1, g.label || null, g.rule ? g.rule.type : null, g.rule && g.rule.type === 'n_of' ? g.rule.n : null);
        for (const r of g.requirements) {
          const rid = `${b.id}:${r.number}${r.letter || ''}`;
          // same AHGFamily id under a different local id ⇒ renumbered; keep history by renaming
          const prev = findByAhg.get(r.ahgFamilyId);
          if (prev && prev.id !== rid) { renameReq.run(rid, prev.id); renumbered++; }
          upReq.run({ id: rid, badge: b.id, group: gid, number: r.number, letter: r.letter || null, ahg: r.ahgFamilyId, title: r.title || null, text: r.text, sub: j(r.subItems || []), flags: j(r.flags || []) });
          seenReqs.add(rid);
        }
      });
    }
    // deactivate what the new build no longer contains
    const allBadges = db.prepare('SELECT id FROM badges WHERE active = 1').all().map((r) => r.id);
    const deactivatedBadges = allBadges.filter((id) => !seenBadges.has(id));
    for (const id of deactivatedBadges) db.prepare('UPDATE badges SET active = 0 WHERE id = ?').run(id);
    const allReqs = db.prepare('SELECT id FROM requirements WHERE active = 1').all().map((r) => r.id);
    const deactivatedReqs = allReqs.filter((id) => !seenReqs.has(id));
    for (const id of deactivatedReqs) db.prepare('UPDATE requirements SET active = 0 WHERE id = ?').run(id);
    const orphans = db.prepare(`SELECT r.id, COUNT(c.id) AS completions FROM requirements r JOIN completions c ON c.requirement_id = r.id AND c.status <> 'rejected'
      WHERE r.active = 0 GROUP BY r.id`).all();

    db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(now, actor, 'catalog.import', 'catalog_version', String(version), null, j({ badges: badges.length, requirements: reqCount, deactivatedBadges, deactivatedReqs: deactivatedReqs.length, renumbered, orphans: orphans.length }));
    db.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('catalog_version', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by")
      .run(j(version), now, actor);
    return { version: Number(version), badges: badges.length, requirements: reqCount, deactivatedBadges, deactivatedRequirements: deactivatedReqs, renumbered, orphans };
  });
  return tx();
}

function importFromDir(db, dir, opts = {}) {
  const badges = readBadgesDir(dir);
  if (!badges.length) throw new Error(`no badge JSON files in ${dir} — run scripts/build-badges.js first`);
  const newest = badges.map(({ badge }) => badge.source && badge.source.builtAt).filter(Boolean).sort().pop() || null;
  return importBadges(db, badges, { ...opts, sourceGeneratedAt: newest, notes: opts.notes || `import from ${dir}` });
}

// ---------------------------------------------------------------- reads ---
function currentVersion(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'catalog_version'").get();
  if (!row) return null;
  return db.prepare('SELECT * FROM catalog_versions WHERE id = ?').get(JSON.parse(row.value)) || null;
}

function listBadges(db, { levelGroup = null, frontier = null, includeInactive = false } = {}) {
  const where = [];
  const args = [];
  if (!includeInactive) where.push('b.active = 1');
  if (levelGroup) { where.push('b.level_group = ?'); args.push(levelGroup); }
  if (frontier) { where.push('b.frontier = ?'); args.push(frontier); }
  const rows = db.prepare(`SELECT b.id, b.ahg_award_id, b.name, b.level_group, b.frontier, b.levels, b.classic, b.pages, b.active,
      (SELECT COUNT(*) FROM requirements r WHERE r.badge_id = b.id AND r.active = 1) AS requirement_count
    FROM badges b ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.level_group, b.name`).all(...args);
  return rows.map((r) => ({ id: r.id, awardId: r.ahg_award_id, name: r.name, levelGroup: r.level_group, frontier: r.frontier, levels: JSON.parse(r.levels), classic: !!r.classic, pages: JSON.parse(r.pages), requirementCount: r.requirement_count, active: !!r.active }));
}

function getBadge(db, id) {
  const row = db.prepare('SELECT json, active, catalog_version_id FROM badges WHERE id = ?').get(id);
  if (!row) return null;
  const b = JSON.parse(row.json);
  // attach the tracker's own requirement ids so the UI can reference them
  for (const [gi, g] of b.groups.entries()) {
    g.trackerGroupId = `${id}:${gi + 1}`;
    for (const r of g.requirements) r.trackerId = `${id}:${r.number}${r.letter || ''}`;
  }
  return { ...b, active: !!row.active, catalogVersion: row.catalog_version_id };
}

module.exports = { readBadgesDir, validateBadge, importBadges, importFromDir, currentVersion, listBadges, getBadge };
