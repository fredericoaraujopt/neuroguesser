// Report-a-problem sheet (ARCHITECTURE.md §3 "Reveal": "Report a problem" text link → report sheet;
// contracts/api.md POST /v1/report).
//
//   reason chips (single choice): wrong_label · bad_mesh · em_problem · fact_wrong · other
//   optional note (≤ 500 chars; line breaks/tabs become spaces, other control characters are dropped,
//   because the Worker rejects strings containing control characters with 400)
//   Cancel (outlined, 1/3) + "Send report" (accent, 2/3, disabled until a reason is picked)
//   → "✓ Report sent" (or "✓ Already reported" on 409 already_reported); other errors keep the form with a
//     status line (403 not_done, 429 rate_limited, network) so the player can retry.
//
// A round reported from this device is remembered in IndexedDB ('report:<round_id>'), so the reveal's link
// reads "✓ Problem reported" and reopening the sheet shows the sent state.
//
// Exports: openReport({ roundIndex, roundId?, typeName?, dayNumber? }), default ReportSheet (app.js sheet
// 'report'), useReported(roundId), markReported(roundId), cleanNote(text), REPORT_REASONS.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, cx, loadCss } from '../ui/html.js';
import { useStore, openSheet } from '../store.js';
import * as api from '../api.js';
import * as idb from '../idb.js';
import { Sheet } from '../ui/sheet.js';
import { Button, Chip } from '../ui/components.js';
import { haptic } from '../fx/haptics.js';
import { checkDraw } from '../fx/celebrate.js';

loadCss('css/reveal.css');

export const NOTE_MAX = 500;

/** Reason codes of POST /v1/report, in display order, with the chip label and a one-line hint. */
export const REPORT_REASONS = Object.freeze([
  { id: 'wrong_label', label: 'Wrong cell type', hint: 'The answer does not match this cell.' },
  { id: 'bad_mesh', label: 'Broken mesh', hint: 'The 3D shape is cut, merged with another cell or garbled.' },
  { id: 'em_problem', label: 'EM problem', hint: 'The EM, mask or XZ view looks wrong.' },
  { id: 'fact_wrong', label: 'Wrong fact', hint: 'A fact, number or citation in the reveal is wrong.' },
  { id: 'other', label: 'Something else', hint: 'Anything else that looks off.' },
]);

const reportKey = (roundId) => `report:${roundId}`;

/**
 * Note text as the Worker accepts it: CR/LF/tab → one space, other control characters (C0, DEL, C1) removed,
 * runs of spaces collapsed, trimmed, at most NOTE_MAX characters. Empty → null (the field is omitted).
 */
export function cleanNote(text) {
  const s = String(text || '')
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (!s) return null;
  return Array.from(s).slice(0, NOTE_MAX).join('');
}

// ---- "reported" memory (this device) ----
const reportedIds = new Set();
const listeners = new Set();

export function markReported(roundId, info = {}) {
  if (!roundId) return;
  reportedIds.add(roundId);
  idb.set(reportKey(roundId), { at: new Date().toISOString(), ...info });
  for (const fn of [...listeners]) { try { fn(); } catch (_) { /* ignore */ } }
}

/** Preact hook: true once this device has sent (or the server already has) a report for roundId. */
export function useReported(roundId) {
  const [reported, setReported] = useState(() => !!roundId && reportedIds.has(roundId));
  useEffect(() => {
    let alive = true;
    const sync = () => { if (alive) setReported(!!roundId && reportedIds.has(roundId)); };
    listeners.add(sync);
    sync();
    if (roundId && !reportedIds.has(roundId)) {
      idb.get(reportKey(roundId)).then((v) => { if (v) { reportedIds.add(roundId); sync(); } });
    }
    return () => { alive = false; listeners.delete(sync); };
  }, [roundId]);
  return reported;
}

export function openReport(props = {}) { openSheet('report', props); }

/** Error status line for a failed POST /v1/report (null = handled elsewhere). */
export function reportErrorText(err) {
  if (!err) return null;
  if (err.isNetwork) return 'Couldn’t reach the server. Check your connection and try again.';
  switch (err.code) {
    case 'not_done': return 'Finish this round first, then report it.';
    case 'rate_limited': return 'Too many requests. Wait a moment and try again.';
    case 'not_found': return 'This round is not available any more.';
    case 'bad_request': return 'The note could not be sent. Shorten it or remove special characters.';
    default: return `Couldn’t send the report (${err.code || err.status || 'error'}). Try again.`;
  }
}

/**
 * <ReportSheet roundIndex roundId? typeName? dayNumber? onClose submit?>
 * submit(body) defaults to api.report (the dev page passes a mock). roundId/typeName/dayNumber default to
 * the Today slice + cached reveal of roundIndex.
 */
export default function ReportSheet({ roundIndex, roundId: roundIdProp, typeName: typeNameProp, dayNumber: dayProp, onClose, submit = api.report }) {
  const round = useStore((s) => (roundIndex ? s.today.rounds[roundIndex - 1] || null : null));
  const online = useStore((s) => s.ui.online);
  const roundId = roundIdProp || (round && round.round_id) || null;
  const cachedName = useStore((s) => (roundId && s.reveals[roundId] ? s.reveals[roundId].type.name : null));
  const typeName = typeNameProp || cachedName;
  const dayNumber = dayProp || (round && round.day_number) || null;
  const already = useReported(roundId);

  const [reason, setReason] = useState(null);
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState('form'); // form | sending | sent | duplicate
  const [error, setError] = useState(null);
  const markRef = useRef(null);

  useEffect(() => { if (already && phase === 'form') setPhase('duplicate'); }, [already]);
  useEffect(() => { if ((phase === 'sent' || phase === 'duplicate') && markRef.current) checkDraw(markRef.current); }, [phase]);

  const chars = Array.from(note).length;
  const canSend = !!reason && !!roundId && phase === 'form' && online;

  const send = async () => {
    if (!canSend) return;
    setPhase('sending');
    setError(null);
    const body = { round_id: roundId, reason_code: reason };
    const clean = cleanNote(note);
    if (clean) body.note = clean;
    try {
      await submit(body);
      markReported(roundId, { reason_code: reason });
      haptic('success');
      setPhase('sent');
    } catch (err) {
      if (err && err.code === 'already_reported') {
        markReported(roundId, { reason_code: reason });
        haptic('light');
        setPhase('duplicate');
        return;
      }
      haptic('error');
      setError(reportErrorText(err));
      setPhase('form');
    }
  };

  const where = [dayNumber ? `#${dayNumber}` : null, roundIndex ? `Round ${roundIndex}` : null].filter(Boolean).join(' · ');

  if (phase === 'sent' || phase === 'duplicate') {
    const sent = phase === 'sent';
    return html`<${Sheet} label="Report a problem" onClose=${onClose}>
      <div class="report-done" role="status">
        <span class="overline is-accent"><span class="report-mark" ref=${markRef} aria-hidden="true"></span>${sent ? 'Report sent' : 'Already reported'}</span>
        <span class="sheet-title">${sent ? 'Thanks for flagging it' : 'We have your report'}</span>
        <span class="t-body t-soft">${sent
          ? 'It goes to the weekly content review, which checks the cell and its facts. Reports never change scores.'
          : 'This round already has a report from you. The weekly content review will look at it.'}</span>
      </div>
      <${Button} block onClick=${onClose}>Close</${Button}>
    </${Sheet}>`;
  }

  const sending = phase === 'sending';
  const hint = reason ? REPORT_REASONS.find((r) => r.id === reason).hint : 'Pick what looks wrong.';
  return html`<${Sheet} label="Report a problem" onClose=${onClose}>
    <div class="stack-4">
      ${where ? html`<span class="overline">${where}</span>` : null}
      <span class="sheet-title">Report a problem</span>
      ${typeName ? html`<span class="t-label t-muted">${typeName}</span>` : null}
    </div>
    <div class="field">
      <span class="t-label t-muted" id="report-reason-label">What is wrong?</span>
      <div class="chips report-reasons" role="radiogroup" aria-labelledby="report-reason-label">
        ${REPORT_REASONS.map((r) => html`<${Chip} key=${r.id} active=${reason === r.id} role="radio"
          aria-checked=${reason === r.id ? 'true' : 'false'} disabled=${sending}
          onClick=${() => { setReason(r.id); setError(null); }}>${reason === r.id ? '✓ ' : ''}${r.label}</${Chip}>`)}
      </div>
      <span class="t-micro t-muted">${hint}</span>
    </div>
    <div class="field">
      <label for="report-note">Details (optional)</label>
      <textarea id="report-note" class="input report-note" rows="3" maxlength=${NOTE_MAX} disabled=${sending}
        placeholder="What did you notice?" value=${note} onInput=${(e) => setNote(e.currentTarget.value)}></textarea>
      <span class=${cx('t-micro t-num report-count', chars >= NOTE_MAX && 't-warn')}>${chars} / ${NOTE_MAX}</span>
    </div>
    ${error ? html`<span class="status-line" role="alert">✕ ${error}</span>` : null}
    <div class="grid-1-2">
      <${Button} variant="outline" onClick=${onClose} disabled=${sending}>Cancel</${Button}>
      <${Button} haptic="selection" disabled=${!canSend} aria-busy=${sending ? 'true' : null} onClick=${send}>
        ${!online ? 'Offline' : sending ? 'Sending…' : 'Send report'}
      </${Button}>
    </div>
  </${Sheet}>`;
}

