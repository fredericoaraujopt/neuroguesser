// <Sheet>: bottom sheet with scrim (accent-ink @60%), radius 12 top corners, shadow-raised, a 220 ms
// ease-out slide-up, a focus trap and Escape. Scrim tap and Escape close it unless dismissable={false}
// (e.g. a confirm that must be answered). full={true} makes it a full-screen sheet.
//
//   html`<${Sheet} label="Share today's result" onClose=${onClose}>…</${Sheet}>`
import { useEffect, useRef } from 'preact/hooks';
import { html, cx } from './html.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Sheet({ onClose, dismissable = true, label, full = false, strongScrim = false, handle = true, class: klass, children }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prev = document.activeElement;
    // focus the dialog itself (not its first button): the trap keeps Tab inside, and no ring flashes on open
    if (ref.current) ref.current.focus({ preventScroll: true });
    return () => { if (prev && prev.focus && document.contains(prev)) prev.focus({ preventScroll: true }); };
  }, []);

  const onKeyDown = (e) => {
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); closeRef.current && closeRef.current(); return; }
    if (e.key !== 'Tab') return;
    const items = [...ref.current.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!items.length) { e.preventDefault(); return; }
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === firstEl || document.activeElement === ref.current)) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  };

  return html`<div class="sheet-wrap" onKeyDown=${onKeyDown}>
    <div class=${cx('sheet-scrim', strongScrim && 'is-strong')} onClick=${() => dismissable && closeRef.current && closeRef.current()}></div>
    <div ref=${ref} class=${cx('sheet', full && 'is-full', klass)} role="dialog" aria-modal="true" aria-label=${label} tabIndex="-1">
      ${handle && !full ? html`<div class="sheet-handle" aria-hidden="true"></div>` : null}
      ${children}
    </div>
  </div>`;
}

export default Sheet;
