// Share sheet (ARCHITECTURE.md §3 "Share sheet"; handoff screen 4; contracts/scoring.md "Share text").
//
// A spoiler-free card that mirrors the share text: "NeuroGuesser #33", one row per finished round (index,
// 2 × 12 px clue boxes — slate-500 filled = used, outline = unused —, one ✕ per wrong guess then ✓, M = method
// right / · = method wrong or skipped), the streak and the total in mono accent.
//   Copy text  → format.shareText (exact scoring.md format), clipboard (with an execCommand fallback)
//   Share…     → navigator.share({ text }) when available
//   Save image → a canvas PNG of the card (drawn with the Charcoal tokens and web fonts read from CSS)
//
// Exports: openShare(props), default ShareSheet({ onClose, dayNumber?, progress?, streak? }),
// ShareCard, StripView (also used by the day summary rows), stripParts(state), drawShareCard(...), shareImageBlob(...).
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, cx, loadCss } from '../ui/html.js';
import { useStore, openSheet } from '../store.js';
import { Sheet } from '../ui/sheet.js';
import { Button } from '../ui/components.js';
import { shareText } from '../game.js';
import { fmtPts, doneTotal, GLYPH } from '../format.js';
import { haptic } from '../fx/haptics.js';

loadCss('css/reveal.css');

export function openShare(props = {}) { openSheet('share', props); }

/**
 * The parts of one round's strip (scoring.md glyphs), for drawing:
 *   { used: 0–2, wrong: 0–3, right: bool, method: 'M' | '·' | null }
 * method is null until the round is done; right is false while the type stage runs or after the cap.
 */
export function stripParts(state) {
  if (!state) return null;
  const used = Math.min(2, (state.clues_opened || []).length);
  const wrong = Math.min(3, (state.wrong || []).length);
  const right = state.stage !== 'type' && state.type_result === 'correct';
  const method = state.stage === 'done' ? (state.method_correct ? GLYPH.methodRight : GLYPH.methodWrong) : null;
  return { used, wrong, right, method };
}

/** Finished rounds only, in round order (like the share text). */
export function doneRounds(progress) {
  return (progress || [])
    .map((st, i) => (st && st.stage === 'done' ? { index: st.round_index || i + 1, state: st } : null))
    .filter(Boolean);
}

/** "2 named · 12-day streak" (named = first guess, no clue: □□ ✓). */
export function shareCaption(progress, streak) {
  const named = doneRounds(progress).filter(({ state }) => {
    const p = stripParts(state);
    return p.right && p.used === 0 && p.wrong === 0;
  }).length;
  const parts = [`${named} named`];
  if (streak > 0) parts.push(`${streak}-day streak`);
  return parts.join(' · ');
}

/** Compact strip: 2 clue boxes, ✕…✓ glyphs, M/·. size: 'sm' (summary rows) | 'md' (share card, 12 px boxes). */
export function StripView({ state, size = 'md', class: klass }) {
  const p = stripParts(state);
  if (!p) return html`<span class=${cx('strip', `is-${size}`, klass)} aria-label="Not played">—</span>`;
  const label = `${p.used} paid clue${p.used === 1 ? '' : 's'}, ${p.wrong} wrong guess${p.wrong === 1 ? '' : 'es'}${p.right ? ', then right' : p.wrong >= 3 ? ', missed' : ''}${p.method ? (p.method === GLYPH.methodRight ? ', method right' : ', method wrong') : ''}`;
  return html`<span class=${cx('strip', `is-${size}`, klass)} role="img" aria-label=${label}>
    <span class="strip-boxes" aria-hidden="true">
      <i class=${p.used >= 1 ? 'is-used' : ''}></i><i class=${p.used >= 2 ? 'is-used' : ''}></i>
    </span>
    <span class="strip-guess" aria-hidden="true">${GLYPH.wrong.repeat(p.wrong) ? html`<span class="is-wrong">${GLYPH.wrong.repeat(p.wrong)}</span>` : null}${p.right ? html`<span class="is-right">${GLYPH.right}</span>` : null}</span>
    <span class=${cx('strip-method', p.method === GLYPH.methodRight ? 'is-right' : 'is-off')} aria-hidden="true">${p.method || ''}</span>
  </span>`;
}

/** The card itself (also what Save image draws). */
export function ShareCard({ dayNumber, progress, streak, cardRef }) {
  const rows = doneRounds(progress);
  return html`<div class="share-card" ref=${cardRef}>
    <div class="row-between"><span class="card-title">NeuroGuesser</span><span class="t-num-11 t-muted">#${dayNumber}</span></div>
    <div class="share-rows">
      ${rows.length ? rows.map(({ index, state }) => html`<div key=${index} class="share-row">
        <span class="t-num-11 t-muted">${index}</span><${StripView} state=${state} />
      </div>`) : html`<span class="t-label t-muted">No finished rounds yet.</span>`}
    </div>
    <div class="share-foot">
      <span class="t-label t-muted">${shareCaption(progress, streak)}</span>
      <span class="share-total">${fmtPts(doneTotal(progress))}</span>
    </div>
  </div>`;
}

// ---- clipboard / native share / image ----

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall back below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

export const canNativeShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    canvas: v('--surface-canvas'), panel: v('--surface-panel'), hairline: v('--hairline'), ink: v('--ink'),
    muted: v('--ink-muted'), accent: v('--accent'), error: v('--state-error'), box: v('--slate-500'),
    sans: v('--font-sans') || 'sans-serif', mono: v('--font-mono') || 'monospace',
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draw the share card on a canvas (CSS px × scale). Same content and layout as <ShareCard>:
 * 20 px padding, title row, one 22 px row per finished round, hairline, caption + total.
 * Returns the canvas.
 */
export function drawShareCard(canvas, { dayNumber, progress, streak, scale = 3 }) {
  const t = tokens();
  const rows = doneRounds(progress);
  const W = 343;
  const pad = 20;
  const rowH = 22;
  const H = pad + 18 + 14 + Math.max(1, rows.length) * rowH + 14 + 1 + 12 + 22 + pad;
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = t.canvas;
  roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 8);
  ctx.fill();
  ctx.strokeStyle = t.hairline;
  ctx.lineWidth = 1;
  ctx.stroke();

  let y = pad + 13;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = t.ink;
  ctx.font = `700 13px ${t.sans}`;
  ctx.textAlign = 'left';
  ctx.fillText('NeuroGuesser', pad, y);
  ctx.fillStyle = t.muted;
  ctx.font = `400 11px ${t.mono}`;
  ctx.textAlign = 'right';
  ctx.fillText(`#${dayNumber}`, W - pad, y);

  y += 14;
  ctx.textAlign = 'left';
  for (const { index, state } of rows) {
    const p = stripParts(state);
    const mid = y + rowH / 2;
    ctx.fillStyle = t.muted;
    ctx.font = `400 11px ${t.mono}`;
    ctx.fillText(String(index), pad, mid + 4);
    let x = pad + 20;
    for (let b = 0; b < 2; b++) {
      ctx.strokeStyle = t.box;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, mid - 6 + 0.5, 11, 11);
      if (b < p.used) { ctx.fillStyle = t.box; ctx.fillRect(x, mid - 6, 12, 12); }
      x += 18;
    }
    x += 6;
    ctx.font = `400 13px ${t.mono}`;
    if (p.wrong) {
      ctx.fillStyle = t.error;
      const s = GLYPH.wrong.repeat(p.wrong);
      ctx.fillText(s, x, mid + 5);
      x += ctx.measureText(s).width;
    }
    if (p.right) { ctx.fillStyle = t.accent; ctx.fillText(GLYPH.right, x, mid + 5); }
    if (p.method) {
      ctx.fillStyle = p.method === GLYPH.methodRight ? t.ink : t.muted;
      ctx.textAlign = 'right';
      ctx.fillText(p.method, W - pad, mid + 5);
      ctx.textAlign = 'left';
    }
    y += rowH;
  }
  if (!rows.length) y += rowH;

  y += 14;
  ctx.fillStyle = t.hairline;
  ctx.fillRect(pad, y, W - 2 * pad, 1);
  y += 12 + 18;
  ctx.fillStyle = t.muted;
  ctx.font = `400 11px ${t.sans}`;
  ctx.fillText(shareCaption(progress, streak), pad, y);
  ctx.fillStyle = t.accent;
  ctx.font = `400 18px ${t.mono}`;
  ctx.textAlign = 'right';
  ctx.fillText(fmtPts(doneTotal(progress)), W - pad, y);
  return canvas;
}

/** PNG Blob of the card (waits for the web fonts so the canvas never falls back to a system face). */
export async function shareImageBlob(opts) {
  try {
    if (document.fonts && document.fonts.load) {
      const t = tokens(); // the same stacks the canvas draws with ("NG Sans" / "NG Mono" first)
      await Promise.all([
        document.fonts.load(`700 13px ${t.sans}`),
        document.fonts.load(`400 11px ${t.sans}`),
        document.fonts.load(`400 18px ${t.mono}`),
      ]);
    }
  } catch (_) { /* draw with whatever is available */ }
  const canvas = drawShareCard(document.createElement('canvas'), opts);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Flash a button label for 1.6 s ("✓ Copied"). */
function useFlash() {
  const [flash, setFlash] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (key) => {
    setFlash(key);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(null), 1600);
  };
  return [flash, show];
}

/**
 * <ShareSheet onClose dayNumber? progress? streak?> — props default to the Today slice (app.js passes only
 * onClose plus whatever openShare() was given).
 */
export default function ShareSheet({ onClose, dayNumber: dayProp, progress: progProp, streak: streakProp }) {
  const t = useStore((s) => s.today);
  const dayNumber = dayProp ?? t.dayNumber;
  const progress = progProp ?? t.progress;
  const streak = streakProp ?? t.streak ?? 0;
  const text = shareText(dayNumber, progress, streak);
  const [flash, show] = useFlash();
  const [error, setError] = useState(null);
  const native = canNativeShare();

  const copy = async () => {
    setError(null);
    if (await copyToClipboard(text)) { haptic('success'); show('copied'); } else { haptic('error'); setError('Couldn’t copy. Select the text below and copy it by hand.'); }
  };
  const nativeShare = async () => {
    setError(null);
    try {
      await navigator.share({ title: `NeuroGuesser #${dayNumber}`, text });
      haptic('success');
    } catch (err) {
      if (err && err.name === 'AbortError') return; // the player closed the system sheet
      setError('Sharing failed. Use Copy text instead.');
    }
  };
  const save = async () => {
    setError(null);
    try {
      const blob = await shareImageBlob({ dayNumber, progress, streak });
      downloadBlob(blob, `neuroguesser-${dayNumber}.png`);
      haptic('success');
      show('saved');
    } catch (_) {
      haptic('error');
      setError('Couldn’t make the image on this device.');
    }
  };

  return html`<${Sheet} label="Share today's result" onClose=${onClose} strongScrim=${true}>
    <span class="card-title">Share today's result</span>
    <${ShareCard} dayNumber=${dayNumber} progress=${progress} streak=${streak} />
    <span class="t-micro t-muted">No spoilers: the cells' names stay hidden until your friends play.</span>
    ${error ? html`<div class="stack-4"><span class="status-line" role="alert">✕ ${error}</span>
      <pre class="share-text t-num-11">${text}</pre></div>` : null}
    <div class="grid-2">
      <${Button} haptic="selection" onClick=${copy}>${flash === 'copied' ? '✓ Copied' : 'Copy text'}</${Button}>
      ${native
        ? html`<${Button} variant="outline" haptic="selection" onClick=${nativeShare}>Share…</${Button}>`
        : html`<${Button} variant="outline" haptic="selection" onClick=${save}>${flash === 'saved' ? '✓ Saved' : 'Save image'}</${Button}>`}
    </div>
    ${native
      ? html`<div class="grid-2">
          <${Button} variant="outline" haptic="selection" onClick=${save}>${flash === 'saved' ? '✓ Saved' : 'Save image'}</${Button}>
          <${Button} variant="outline" onClick=${onClose}>Done</${Button}>
        </div>`
      : html`<${Button} variant="outline" block onClick=${onClose}>Done</${Button}>`}
  </${Sheet}>`;
}
