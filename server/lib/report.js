'use strict';
/**
 * The push run report (spec §7): what was pushed to AHGFamily, when, for
 * whom, with what result — e-mailed after every run to REPORT_EMAILS and
 * kept as the `last_push_report` setting for the admin page.
 *
 * `report_mode` setting: 'always' (default — a run that pushed nothing
 * still sends a one-line "nothing to push", so silence is never ambiguous)
 * or 'errors_only' (mail only when something was held/failed or the
 * AHGFamily latch is set). Mail goes through SMTP_URL / REPORT_FROM; when
 * those are unset the report is still built and stored, just not sent, and
 * the log says so.
 *
 * The mailer is injectable so tests never touch a network.
 */
const { getSetting, setSetting } = require('./settings');
const mapping = require('./mapping');

const MODE_KEY = 'report_mode';
const LAST_KEY = 'last_push_report';
const reportMode = (db) => (getSetting(db, MODE_KEY) === 'errors_only' ? 'errors_only' : 'always');
const setReportMode = (db, mode, actor) => { const m = mode === 'errors_only' ? 'errors_only' : 'always'; setSetting(db, MODE_KEY, m, actor); return m; };

const fmtWhen = (iso, tz) => { try { return new Date(iso).toLocaleString('en-US', { timeZone: tz }); } catch { return iso; } };

function buildPushReport(db, { stars = null, requirements = null, trigger = 'manual', tz = 'UTC', at = new Date().toISOString() } = {}) {
  const name = (id) => { const g = db.prepare('SELECT first_name, last_name FROM girls WHERE id = ?').get(id); return g ? `${g.last_name}, ${g.first_name}` : `girl #${id}`; };
  const latch = mapping.getLatch(db);
  const lines = [];
  const counts = { pushed: 0, held: 0, failed: 0, skippedRows: 0 };
  for (const [label, s] of [['Service Stars', stars], ['Requirements', requirements]]) {
    if (!s) continue;
    if (s.skipped) { lines.push(`${label}: not run (${s.skipped})`); continue; }
    counts.pushed += s.pushed || 0; counts.held += s.held || 0; counts.failed += s.failed || 0; counts.skippedRows += s.skippedRows || 0;
    lines.push(`${label}: ${s.queued} queued → ${s.pushed || 0} sent, ${s.held || 0} held, ${s.failed || 0} failed${s.skippedRows ? `, ${s.skippedRows} skipped` : ''}`);
    for (const it of s.items || []) {
      const what = it.badge ? `${it.badge} ${it.label}` : `Service Star${it.level ? ` (${it.level})` : ''}`;
      lines.push(`  ${it.status.toUpperCase().padEnd(7)} ${name(it.girlId)} — ${what}${it.error ? ` — ${it.error}` : ''}`);
    }
    for (const w of s.warnings || []) lines.push(`  ! ${w}`);
  }
  const outstanding = db.prepare("SELECT status, COUNT(*) AS n FROM push_queue WHERE status IN ('queued', 'held') GROUP BY status").all();
  const problems = counts.held + counts.failed > 0 || !!latch;
  const ran = (stars && !stars.skipped) || (requirements && !requirements.skipped);
  const headline = !ran ? 'push did not run' : counts.pushed + counts.held + counts.failed + counts.skippedRows === 0 ? 'nothing to push'
    : `${counts.pushed} sent${counts.held ? `, ${counts.held} HELD` : ''}${counts.failed ? `, ${counts.failed} FAILED` : ''}`;
  const subject = `[badge tracker] AHGFamily push (${trigger}): ${headline}${latch ? ' — LATCHED' : ''}`;
  const text = [
    `AHGFamily push — ${trigger} run at ${fmtWhen(at, tz)}`,
    latch ? `\nAHGFamily is LATCHED since ${fmtWhen(latch.latchedAt, tz)}: ${latch.error}\nRe-enter the credentials on the admin page to clear it.` : '',
    '',
    ...(lines.length ? lines : ['Nothing to push.']),
    '',
    `Queue now: ${outstanding.map((o) => `${o.n} ${o.status}`).join(', ') || 'empty'}.`,
    'Held rows need a look on AHGFamily before they can be cleared; the tracker never retries them on its own.',
  ].filter((l) => l !== null).join('\n');
  return { subject, text, problems, ran };
}

async function defaultMailer(cfg, { to, subject, text }) {
  const nodemailer = require('nodemailer'); // lazy: an unconfigured install never needs it
  const transport = nodemailer.createTransport(cfg.mail.smtpUrl);
  await transport.sendMail({ from: cfg.mail.from, to: to.join(', '), subject, text });
}

async function sendPushReport(db, cfg, summaries, { mailer = defaultMailer, trigger = 'manual', log = (m) => console.log(m), actor = 'system' } = {}) {
  const at = new Date().toISOString();
  const report = buildPushReport(db, { ...summaries, trigger, tz: cfg.tz, at });
  const mode = reportMode(db);
  const wanted = mode === 'always' ? report.ran : report.problems;
  const configured = !!(cfg.mail && cfg.mail.smtpUrl && cfg.mail.from && cfg.mail.to && cfg.mail.to.length);
  let sent = false; let error = null;
  if (wanted && configured) {
    try { await mailer(cfg, { to: cfg.mail.to, subject: report.subject, text: report.text }); sent = true; } catch (e) { error = e.message; log(`[tracker] push report mail failed: ${e.message}`); }
  } else if (wanted && !configured) {
    log('[tracker] push report not mailed: SMTP_URL / REPORT_FROM / REPORT_EMAILS are not all set');
  }
  setSetting(db, LAST_KEY, { at, trigger, subject: report.subject, text: report.text, sent, error, mode, wanted, configured }, actor);
  return { sent, wanted, configured, error, subject: report.subject };
}

const lastPushReport = (db) => getSetting(db, LAST_KEY);

module.exports = { buildPushReport, sendPushReport, reportMode, setReportMode, lastPushReport };
