// Settings (W2 "social"; ARCHITECTURE.md §3 "Settings"): profile (display name + affiliation), groups (join code
// + Copy, Leave; Create group; Join with code), "Move to a new phone" (transfer code with expiry countdown, and
// "I have a code" with the has_progress confirm → discard: true), Haptics + Celebrations toggles (store + IndexedDB,
// unchanged foundation behaviour), the EM Data saver toggle (session.settings.dataSaver, em-v2-spec.md §8.6), How to
// play, About & data credits (js/credits.js) and the app version.
// Route #/settings; #/settings?group=lab|friends scrolls to Groups with that kind preselected (Ranks CTA).
// Exports: default Settings({ params }) + pure helpers (validName, normaliseCode).
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, cx, loadCss } from '../ui/html.js';
import { store, useStore, setSettings, showToast } from '../store.js';
import * as api from '../api.js';
import * as idb from '../idb.js';
import { Toggle, GhostButton, Button, Segmented, Countdown, useCountdown } from '../ui/components.js';
import { navigate } from '../router.js';
import { initials as initialsOf } from '../format.js';
import { loadMe } from '../game.js';
import { haptic } from '../fx/haptics.js';
import { pulse } from '../fx/celebrate.js';
import { CREDITS, SOFTWARE_CREDITS } from '../credits.js';
import { openOnboarding } from './onboarding.js';
import { VERSION } from '../../version.js';
import { FEEDBACK_ENABLED } from '../../config.js';
import { YourFeedback } from '../feedback.js';
import { XpCard } from '../ui/xp-bar.js'; // v1.3 (§3.4 item 2): level + XP in the profile card

loadCss('css/social.css');

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CODE_ALPHABET = /^[A-HJ-NP-Z2-9]+$/;

/** Display names, affiliations and group names: 1–24 characters after trimming, no control characters (api.md). */
export function validName(s) {
  const t = String(s ?? '').trim();
  if (!t) return { ok: false, value: t, error: 'Use at least one character.' };
  if (Array.from(t).length > 24) return { ok: false, value: t, error: 'Use at most 24 characters.' };
  if (CONTROL.test(t)) return { ok: false, value: t, error: 'Remove the special characters.' };
  return { ok: true, value: t, error: null };
}

/** "k7p 2qx" / "K7P-2QX" → "K7P2QX" (codes are case-insensitive; spaces and dashes are ignored). */
export function normaliseCode(s) {
  return String(s ?? '').toUpperCase().replace(/[\s-]+/g, '');
}
export const isJoinCode = (c) => c.length === 6 && CODE_ALPHABET.test(c);
export const isTransferCode = (c) => c.length === 8 && CODE_ALPHABET.test(c);

function errorText(err, fallback) {
  if (!err) return fallback;
  if (err.isNetwork) return 'No connection. Try again when you are online.';
  if (err.code === 'rate_limited') return 'Too many tries. Wait a few minutes and try again.';
  return fallback || err.message;
}

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true, () => false);
  } catch (_) { /* unsupported */ }
  return Promise.resolve(false);
}

function useCopy() {
  const [copied, setCopied] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (key, text) => copyText(text).then((ok) => {
    if (ok) {
      haptic('light');
      setCopied(key);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 2000);
    } else {
      showToast('Copy is not available here. Select the code instead.', { kind: 'warn' });
    }
  });
  return [copied, copy];
}

function setMe(me) {
  store.update('session', { me });
  idb.set('cache:me', me);
}

function Section({ id, title, children }) {
  return html`<section class="st-section" aria-labelledby=${`st-${id}`} id=${`st-sec-${id}`}>
    <h2 class="overline" id=${`st-${id}`}>${title}</h2>
    ${children}
  </section>`;
}

function Msg({ msg }) {
  if (!msg) return null;
  return html`<span class=${cx('st-msg', msg.kind === 'error' ? 'is-error' : msg.kind === 'warn' ? 'is-warn' : 'is-ok')} role=${msg.kind === 'error' ? 'alert' : 'status'}>
    ${msg.kind === 'error' ? '✕ ' : msg.kind === 'warn' ? '! ' : '✓ '}${msg.text}</span>`;
}

// ---------------------------------------------------------------------------------------------------------
// Profile

function Profile({ me, online }) {
  const [name, setName] = useState(me ? me.display_name : '');
  const [aff, setAff] = useState(me && me.affiliation ? me.affiliation : '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const affRef = useRef(null);
  const seeded = useRef(!!me);

  useEffect(() => { // fill the fields once /me arrives (never overwrite what the player is typing)
    if (me && !seeded.current) { seeded.current = true; setName(me.display_name); setAff(me.affiliation || ''); }
  }, [me]);

  if (!me) {
    return html`<div class="card"><span class="t-body t-soft">${online ? 'Loading your profile…' : 'Your profile needs a connection.'}</span></div>`;
  }
  const n = validName(name);
  const affTrim = aff.trim();
  const a = affTrim ? validName(aff) : { ok: true, value: null };
  const changedName = n.ok && n.value !== me.display_name;
  const changedAff = a.ok && (a.value || null) !== (me.affiliation || null);
  const dirty = changedName || changedAff;
  const invalid = !n.ok || !a.ok;

  const save = async () => {
    if (!dirty || invalid || busy) return;
    const body = {};
    if (changedName) body.display_name = n.value;
    if (changedAff) body.affiliation = a.value || null;
    setBusy(true);
    setMsg(null);
    try {
      const resp = await api.updateMe(body);
      setMe(resp);
      setName(resp.display_name);
      setAff(resp.affiliation || '');
      haptic('success');
      setMsg({ kind: 'ok', text: 'Saved. Ranks show your new name.' });
    } catch (err) {
      haptic('error');
      setMsg({ kind: 'error', text: errorText(err, err && err.status === 400 ? 'That name is not allowed. Use 1–24 plain characters.' : 'Could not save. Try again.') });
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };

  return html`<div class="card st-card">
    <div class="st-id">
      <span class="st-avatar" aria-hidden="true">${initialsOf(n.ok ? n.value : me.display_name) || '?'}</span>
      <span class="stack-4"><span class="t-card">${n.ok ? n.value : me.display_name}</span>
        <span class="t-micro t-muted">${[affTrim || null, me.streak > 0 ? `${me.streak} d streak` : null, me.best_streak > 0 ? `best ${me.best_streak}` : null].filter(Boolean).join(' · ') || 'Shown on Ranks next to your score'}</span></span>
    </div>
    ${typeof me.xp_total === 'number' ? html`<${XpCard} xp=${me.xp_total} variant="profile" class="st-xp" />` : null}
    <div class="field">
      <label for="st-name">Display name</label>
      <input id="st-name" class="input" type="text" maxlength="24" autocomplete="nickname" spellcheck="false"
        value=${name} onInput=${(e) => { setName(e.currentTarget.value); setMsg(null); }} onKeyDown=${onKey}
        aria-invalid=${!n.ok ? 'true' : 'false'} aria-describedby="st-name-hint" />
      <span id="st-name-hint" class=${cx('t-micro', n.ok ? 't-muted' : 't-error')}>${n.ok ? '1–24 characters. Everyone on your boards sees it.' : `✕ ${n.error}`}</span>
    </div>
    <div class="field">
      <label for="st-aff">Affiliation <span class="t-muted">(optional)</span></label>
      <span class="st-input-wrap">
        <input id="st-aff" ref=${affRef} class="input" type="text" maxlength="24" autocomplete="organization" spellcheck="false"
          placeholder="Lab or institute" value=${aff} onInput=${(e) => { setAff(e.currentTarget.value); setMsg(null); }} onKeyDown=${onKey}
          aria-invalid=${!a.ok ? 'true' : 'false'} />
        ${aff ? html`<${GhostButton} label="Clear affiliation" class="st-clear" onClick=${() => { setAff(''); setMsg(null); if (affRef.current) affRef.current.focus(); }}>✕</${GhostButton}>` : null}
      </span>
      ${!a.ok ? html`<span class="t-micro t-error">✕ ${a.error}</span>` : null}
    </div>
    <${Button} block disabled=${!online || !dirty || invalid || busy} haptic="selection" onClick=${save}>
      ${!online ? 'Offline' : busy ? 'Saving…' : dirty ? 'Save profile' : 'Saved'}</${Button}>
    <${Msg} msg=${msg} />
  </div>`;
}

// ---------------------------------------------------------------------------------------------------------
// Groups

/** Drop a group from the cached /me at once (loadMe() then refreshes; it may fail offline). */
function dropGroup(groupId) {
  const me = store.get().session.me;
  if (me && Array.isArray(me.groups)) setMe({ ...me, groups: me.groups.filter((x) => x.group_id !== groupId) });
}

/** Keep keyboard focus when an inline confirm replaces the button that opened it (and back on Cancel). */
function useConfirmFocus(confirm, confirmRef, returnRef, returnSelector) {
  const opened = useRef(false);
  useEffect(() => {
    if (confirm) {
      opened.current = true;
      const b = confirmRef.current && confirmRef.current.querySelector('button:not([disabled])');
      if (b) b.focus();
    } else if (opened.current) {
      opened.current = false;
      const el = returnRef.current && (returnSelector ? returnRef.current.querySelector(returnSelector) : returnRef.current);
      if (el && !el.disabled) el.focus();
    }
  }, [confirm]);
}

function GroupItem({ g, online, copied, onCopy }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const topRef = useRef(null);
  const confirmRef = useRef(null);
  useConfirmFocus(confirm, confirmRef, topRef, '.st-leave');
  const leave = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.leaveGroup(g.group_id);
      haptic('light');
      showToast(`Left ${g.name}`, { glyph: '✓' });
      dropGroup(g.group_id);
      await loadMe();
    } catch (e) {
      if (e && e.status === 404) { dropGroup(g.group_id); await loadMe(); return; } // already gone
      setErr(errorText(e, 'Could not leave. Try again.'));
      setBusy(false);
    }
  };
  return html`<li class="st-group">
    <div class="st-group-top" ref=${topRef}>
      <span class="stack-4 st-group-name"><span class="t-card">${g.name}</span>
        <span class="t-micro t-muted">${g.kind === 'lab' ? 'Lab' : 'Friends'} · ${g.n_members} ${g.n_members === 1 ? 'member' : 'members'}</span></span>
      ${confirm ? null : html`<${Button} variant="outline" size="sm" class="st-leave" disabled=${!online} onClick=${() => setConfirm(true)}>Leave</${Button}>`}
    </div>
    <div class="st-code-row">
      <span class="t-micro t-muted">Join code</span>
      <span class="st-code t-num-13" aria-label=${`Join code ${g.join_code.split('').join(' ')}`}>${g.join_code}</span>
      <${Button} variant="text" onClick=${() => onCopy(g.group_id, g.join_code)}>${copied ? '✓ Copied' : 'Copy'}</${Button}>
    </div>
    ${confirm ? html`<div class="st-confirm" role="group" aria-label=${`Leave ${g.name}?`} ref=${confirmRef}>
      <span class="t-label t-soft">${g.n_members <= 1
    ? `You are the only member: leaving deletes ${g.name} and its join code.`
    : `Leave ${g.name}? You leave its board; your scores stay, and you can rejoin with the code.`}</span>
      <div class="grid-1-2">
        <${Button} variant="outline" size="sm" onClick=${() => { setConfirm(false); setErr(null); }}>Cancel</${Button}>
        <${Button} variant="outline" size="sm" class="st-danger" disabled=${busy || !online} onClick=${leave}>${busy ? 'Leaving…' : `✕ Leave ${g.kind === 'lab' ? 'lab' : 'group'}`}</${Button}>
      </div>
    </div>` : null}
    ${err ? html`<${Msg} msg=${{ kind: 'error', text: err }} />` : null}
  </li>`;
}

function Groups({ me, online, presetKind }) {
  const [copied, copy] = useCopy();
  const [kind, setKind] = useState(presetKind || 'lab');
  const [gname, setGname] = useState('');
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState(null);
  const [created, setCreated] = useState(null);
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinMsg, setJoinMsg] = useState(null);

  useEffect(() => { if (presetKind) setKind(presetKind); }, [presetKind]);

  const groups = (me && me.groups) || [];
  const gn = validName(gname);
  const codeN = normaliseCode(code);

  const create = async () => {
    if (!gn.ok || creating) return;
    setCreating(true);
    setCreateMsg(null);
    try {
      const resp = await api.createGroup({ name: gn.value, kind });
      haptic('success');
      setCreated({ name: gn.value, kind, join_code: resp.join_code, group_id: resp.group_id });
      setGname('');
      await loadMe();
    } catch (err) {
      haptic('error');
      setCreateMsg({ kind: 'error', text: err && err.code === 'too_many_groups' ? 'You are in 20 groups, the most allowed. Leave one first.'
        : errorText(err, err && err.status === 400 ? 'That name is not allowed. Use 1–24 plain characters.' : 'Could not create the group. Try again.') });
    } finally {
      setCreating(false);
    }
  };

  const join = async () => {
    if (joining) return;
    if (!isJoinCode(codeN)) { setJoinMsg({ kind: 'error', text: 'Join codes are 6 letters and digits, like K7P2QX.' }); return; }
    setJoining(true);
    setJoinMsg(null);
    const already = groups.some((g) => g.join_code === codeN);
    try {
      const resp = await api.joinGroup(codeN);
      haptic('success');
      setCode('');
      setJoinMsg({ kind: 'ok', text: already ? `You are already in ${resp.name}.` : `Joined ${resp.name}. It has its own board on Ranks.` });
      await loadMe();
    } catch (err) {
      haptic('error');
      setJoinMsg({ kind: 'error', text: err && err.status === 404 ? 'No group has that code. Check it with whoever shared it.'
        : err && err.code === 'too_many_groups' ? 'You are in 20 groups, the most allowed. Leave one first.'
          : errorText(err, 'Could not join. Try again.') });
    } finally {
      setJoining(false);
    }
  };

  return html`<div class="card st-card">
    ${!me ? html`<span class="t-body t-soft">${online ? 'Loading your groups…' : 'Groups need a connection.'}</span>`
    : groups.length ? html`<ul class="st-groups">${groups.map((g) => html`<${GroupItem} key=${g.group_id} g=${g} online=${online}
        copied=${copied === g.group_id} onCopy=${copy} />`)}</ul>`
      : html`<span class="t-body t-soft">You are not in a group yet. Each group gets its own board on Ranks: Lab for your lab or
        department, Friends for anyone else.</span>`}
  </div>
  <div class="card st-card" id="st-create">
    <span class="card-title">Create a group</span>
    <${Segmented} label="Group kind" options=${[{ id: 'lab', label: 'Lab' }, { id: 'friends', label: 'Friends' }]} value=${kind} onChange=${setKind} />
    <div class="field">
      <label for="st-gname">${kind === 'lab' ? 'Lab name' : 'Group name'}</label>
      <input id="st-gname" class="input" type="text" maxlength="24" spellcheck="false" placeholder=${kind === 'lab' ? 'e.g. MRC LMB Neurobiology' : 'e.g. Tuesday journal club'}
        value=${gname} onInput=${(e) => { setGname(e.currentTarget.value); setCreateMsg(null); }}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } }} />
    </div>
    <${Button} block disabled=${!online || !gn.ok || creating} onClick=${create}>${!online ? 'Offline' : creating ? 'Creating…' : 'Create group'}</${Button}>
    <${Msg} msg=${createMsg} />
    ${created ? html`<div class="st-created" role="status">
      <span class="overline is-accent">✓ Created · ${created.kind === 'lab' ? 'lab' : 'friends'}</span>
      <span class="t-label t-soft">Share this code so others can join ${created.name}:</span>
      <div class="st-code-row">
        <span class="st-code st-code-lg t-num-18">${created.join_code}</span>
        <${Button} variant="outline" size="sm" onClick=${() => copy(`new:${created.group_id}`, created.join_code)}>${copied === `new:${created.group_id}` ? '✓ Copied' : 'Copy code'}</${Button}>
      </div>
    </div>` : null}
  </div>
  <div class="card st-card">
    <span class="card-title">Join with a code</span>
    <div class="st-inline">
      <label class="sr-only" for="st-join">Join code</label>
      <input id="st-join" class="input st-code-input" type="text" inputmode="text" autocapitalize="characters" autocomplete="off" spellcheck="false"
        maxlength="9" placeholder="K7P2QX" value=${code} onInput=${(e) => { setCode(e.currentTarget.value.toUpperCase()); setJoinMsg(null); }}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); join(); } }} />
      <${Button} disabled=${!online || !codeN || joining} onClick=${join}>${!online ? 'Offline' : joining ? 'Joining…' : 'Join'}</${Button}>
    </div>
    <${Msg} msg=${joinMsg} />
  </div>`;
}

// ---------------------------------------------------------------------------------------------------------
// Move to a new phone

function TransferCode({ code, onRenew, online, copied, onCopy }) {
  const ms = useCountdown(code.expires_at);
  const expired = ms <= 0;
  return html`<div class=${cx('st-transfer', expired && 'is-expired')} role="group" aria-label="Transfer code">
    <span class="st-code st-code-xl t-num-18" aria-label=${expired ? 'Expired code' : `Transfer code ${code.code.split('').join(' ')}`}>${code.code.slice(0, 4)} ${code.code.slice(4)}</span>
    ${expired
    ? html`<span class="t-micro t-error">✕ Code expired</span>`
    : html`<span class="t-micro t-muted">Expires in <${Countdown} to=${code.expires_at} /> · single use</span>`}
    <div class="grid-2">
      <${Button} variant="outline" size="sm" disabled=${expired} onClick=${() => onCopy('transfer', code.code)}>${copied ? '✓ Copied' : 'Copy code'}</${Button}>
      <${Button} variant="outline" size="sm" disabled=${!online} onClick=${onRenew}>New code</${Button}>
    </div>
  </div>`;
}

// Per-player IndexedDB state that must not leak into the player this phone switches to (the device id,
// settings, onboarding, Ranks view prefs, reveal acks and cached thumbnails stay).
export const USER_KEY_PREFIXES = ['cache:', 'lastRanks:', 'graceSkip:', 'summary:', 'report:', 'library:atlasSeen', 'library:reviewDone'];

async function clearUserCaches() {
  try {
    const keys = (await Promise.all(USER_KEY_PREFIXES.map((p) => idb.keys(p)))).flat();
    await Promise.all(keys.map((k) => idb.del(k)));
  } catch (_) { /* best effort */ }
}

function Transfer({ me, online }) {
  const [copied, copy] = useCopy();
  const [code, setCode] = useState(null);
  const [issuing, setIssuing] = useState(false);
  const [issueMsg, setIssueMsg] = useState(null);
  const [claimOpen, setClaimOpen] = useState(false);
  const [input, setInput] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [claimMsg, setClaimMsg] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const inputRef = useRef(null);
  const confirmRef = useRef(null);
  useConfirmFocus(confirm, confirmRef, inputRef, null);

  const issue = async () => {
    setIssuing(true);
    setIssueMsg(null);
    try {
      const resp = await api.createTransferCode();
      haptic('success');
      setCode(resp);
    } catch (err) {
      setIssueMsg({ kind: 'error', text: errorText(err, 'Could not create a code. Try again.') });
    } finally {
      setIssuing(false);
    }
  };

  const claim = async (discard = false) => {
    const c = normaliseCode(input);
    if (!isTransferCode(c)) { setClaimMsg({ kind: 'error', text: 'Transfer codes are 8 letters and digits.' }); return; }
    setClaiming(true);
    setClaimMsg(null);
    try {
      const resp = await api.claimTransferCode(c, { discard });
      if (me && resp.user_id === me.user_id) {
        setClaiming(false);
        setConfirm(false);
        setClaimMsg({ kind: 'warn', text: 'That code belongs to this phone’s player already. Enter it on your new phone.' });
        return;
      }
      haptic('success');
      setClaimMsg({ kind: 'ok', text: 'Moved. Loading your games…' });
      await clearUserCaches();
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      setClaiming(false);
      if (err && err.code === 'has_progress') { haptic('light'); setConfirm(true); return; }
      haptic('error');
      setConfirm(false);
      setClaimMsg({ kind: 'error', text: err && err.status === 404 ? 'That code is unknown, used or expired. Make a new one on the other phone.'
        : errorText(err, err && err.status === 400 ? 'Transfer codes are 8 letters and digits.' : 'Could not move. Try again.') });
    }
  };

  return html`<div class="card st-card">
    <span class="t-body t-soft">Your scores, streak, library and groups are kept on the server for this phone. To carry on
      somewhere else, make a code here and enter it on the other phone within 15 minutes.</span>
    ${code ? html`<${TransferCode} code=${code} online=${online} copied=${copied === 'transfer'} onCopy=${copy} onRenew=${issue} />`
    : html`<${Button} variant="outline" block disabled=${!online || issuing || !me} onClick=${issue}>${!online ? 'Offline' : issuing ? 'Creating…' : 'Create a transfer code'}</${Button}>`}
    <${Msg} msg=${issueMsg} />
    <div class="hairline-top st-claim">
      ${!claimOpen ? html`<${Button} variant="text" onClick=${() => { setClaimOpen(true); setTimeout(() => inputRef.current && inputRef.current.focus(), 0); }}>I have a code</${Button}>`
    : html`<div class="field">
        <label for="st-claim">Code from your other phone</label>
        <div class="st-inline">
          <input id="st-claim" ref=${inputRef} class="input st-code-input" type="text" autocapitalize="characters" autocomplete="one-time-code" spellcheck="false"
            maxlength="11" placeholder="ABCD 2345" value=${input} disabled=${claiming || confirm}
            onInput=${(e) => { setInput(e.currentTarget.value.toUpperCase()); setClaimMsg(null); }}
            onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); claim(false); } }} />
          ${confirm ? null : html`<${Button} disabled=${!online || claiming || !normaliseCode(input)} onClick=${() => claim(false)}>${!online ? 'Offline' : claiming ? 'Moving…' : 'Move here'}</${Button}>`}
        </div>
      </div>`}
      ${confirm ? html`<div class="st-confirm is-warn" role="group" aria-labelledby="st-hp-title" aria-describedby="st-hp-body" ref=${confirmRef}>
        <span class="overline is-warn" id="st-hp-title">! This phone has its own progress</span>
        <span class="t-label t-soft" id="st-hp-body">Moving here switches this phone to the player from your other phone.
          This phone’s player${me ? ` (${me.display_name})` : ''} and its scores, streak, library and groups will be discarded.</span>
        <div class="grid-1-2">
          <${Button} variant="outline" size="sm" onClick=${() => { setConfirm(false); setClaimMsg(null); }}>Cancel</${Button}>
          <${Button} variant="outline" size="sm" class="st-danger" disabled=${claiming || !online} onClick=${() => claim(true)}>${claiming ? 'Moving…' : 'Discard and move'}</${Button}>
        </div>
      </div>` : null}
      <${Msg} msg=${claimMsg} />
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------------------
// Feedback, about, credits

function Feedback({ settings }) {
  const celebRef = useRef(null);
  return html`<div class="card st-card st-toggles">
    <${Toggle} label="Haptics" hint="Vibration and taps on supported phones" checked=${settings.haptics}
      onChange=${(v) => { setSettings({ haptics: v }); if (v) haptic('selection'); }} />
    <div ref=${celebRef} class="st-toggle-wrap">
      <${Toggle} label="Celebrations" hint="Off = reduced motion" checked=${settings.celebrations}
        onChange=${(v) => setSettings({ celebrations: v }).then(() => { if (v) pulse(celebRef.current, { rings: 1 }); })} />
    </div>
  </div>`;
}

/** EM format 2 data saver (em-v2-spec.md §8.6): levels 0 and L, the side views and outlines first; the finer levels,
 *  the sections and the side-view context only when the viewer needs them. Read when a round's EM opens. */
function DataUse({ settings }) {
  return html`<div class="card st-card st-toggles">
    <${Toggle} label="Data saver" hint="Electron micrographs load their finest detail only when you zoom or scroll to it"
      checked=${!!settings.dataSaver} onChange=${(v) => { setSettings({ dataSaver: v }); haptic('selection'); }} />
  </div>`;
}

function About() {
  return html`<div class="card st-card">
    <span class="t-body t-soft">Five real neurons a day from public connectomes: name each cell from its 3D shape, then
      guess how its electron microscopy was imaged.</span>
    <${Button} variant="outline" block onClick=${() => openOnboarding({ replay: true })}>How to play</${Button}>
    <span class="t-micro t-muted">No accounts and no analytics: an anonymous ID kept on this phone is the only identifier.</span>
  </div>
  <div class="card st-card">
    <span class="card-title">Data credits</span>
    <span class="t-micro t-muted">Every neuron, mesh and EM image comes from these public datasets. Thank you to the teams who made them open.</span>
    <ul class="st-credits">
      ${CREDITS.map((c) => html`<li key=${c.dataset_id} class="st-credit">
        <span class="row-between"><span class="t-card">${c.name}</span><span class="t-num-11 t-muted st-release">${c.release}</span></span>
        <span class="t-micro t-muted st-species">${c.species}</span>
        <span class="t-label t-soft">${c.attribution}</span>
        <span class="t-micro t-muted">Licence: ${c.licence}</span>
        <a class="st-link" href=${c.url} target="_blank" rel="noopener noreferrer">${c.citation} ↗</a>
      </li>`)}
    </ul>
    <div class="st-software"><span class="t-micro t-muted">Built with</span>
      ${SOFTWARE_CREDITS.map((s) => html`<a key=${s.name} class="st-soft-link" href=${s.url} target="_blank" rel="noopener noreferrer"><span>${s.name}</span><span class="t-muted">${s.licence}</span></a>`)}
    </div>
    <span class="t-micro t-muted">NeuroGuesser <span class="t-num">${VERSION}</span></span>
  </div>`;
}

export default function Settings() {
  const me = useStore((s) => s.session.me);
  const settings = useStore((s) => s.session.settings);
  const online = useStore((s) => s.ui.online);
  const [presetKind, setPresetKind] = useState(null);

  useEffect(() => {
    loadMe();
    const q = new URLSearchParams((location.hash.split('?')[1]) || '');
    const k = q.get('group');
    if (k === 'lab' || k === 'friends') {
      setPresetKind(k);
      requestAnimationFrame(() => {
        const el = document.getElementById('st-sec-groups');
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
      });
    }
  }, []);

  return html`<div class="screen st"><div class="screen-pad">
    <div class="st-head">
      <${GhostButton} label="Back to ranks" onClick=${() => navigate('/ranks')}>←</${GhostButton}>
      <span class="t-title">Settings</span>
    </div>
    <${Section} id="profile" title="Profile"><${Profile} me=${me} online=${online} /></${Section}>
    <${Section} id="groups" title="Groups"><${Groups} me=${me} online=${online} presetKind=${presetKind} /></${Section}>
    <${Section} id="move" title="Move to a new phone"><${Transfer} me=${me} online=${online} /></${Section}>
    <${Section} id="feedback" title="Haptics & celebrations"><${Feedback} settings=${settings} /></${Section}>
    <${Section} id="data" title="Data use"><${DataUse} settings=${settings} /></${Section}>
    ${FEEDBACK_ENABLED ? html`<${Section} id="yourfeedback" title="Your feedback"><${YourFeedback} /></${Section}>` : null}
    <${Section} id="about" title="About & data credits"><${About} /></${Section}>
  </div></div>`;
}
