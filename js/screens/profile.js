// Neuron profile (feedback QwW2, v0.6.0; ARCHITECTURE.md §3 "Library"): a Library cell's whole reveal, read-only,
// to revisit what it does and how to tell it apart — the 3D cell in its volume, "Did you know?" ("In short" first),
// Ephys / Genes / Graph, How it was made, Papers, Neuroglancer ↗ — opened from the Library sheet's "Open neuron profile".
//
// Route #/library/cell/:date/:n (the Library tab stays selected). Data: GET /v1/day/{date} (round_public of round n),
// /v1/day/{date}/progress (this player's round_state: the verdict chip, the outcome line, the graph clue asset) and
// the reveal through game.loadRevealById (device copy + revalidation; the Worker serves it once the round is done,
// or for a closed day). It reuses reveal.js's RevealView: same layout (two panes on a laptop), no day bar, no
// celebration; "← Library" instead of "Next round →"; the footer gives the cell's review schedule.
// Offline: the reveal (device copy) and the day (immutable once closed) can still show; without /progress the verdict
// reads "Revealed".
import { useEffect, useState } from 'preact/hooks';
import { html } from '../ui/html.js';
import { useStore } from '../store.js';
import * as api from '../api.js';
import { navigate } from '../router.js';
import { haptic } from '../fx/haptics.js';
import { loadRevealById } from '../game.js';
import { Button } from '../ui/components.js';
import { RevealView } from './reveal.js';
import { openReport, useReported } from './report.js';
import { loadLibrary, todayDate } from './library.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

/** "↻ Due for review" / "↻ Review in 3 days" from a Library entry's review schedule; null without one. */
export function reviewLine(entry, today = todayDate()) {
  const review = entry && entry.review;
  if (!review) return null;
  if (review.due) return '↻ Due for review';
  if (!review.next_review_at) return null;
  const n = Math.max(0, Math.round((Date.parse(`${review.next_review_at}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS));
  return n === 0 ? '↻ Due for review' : `↻ Review in ${n} ${n === 1 ? 'day' : 'days'}`;
}

/** Route params → { date, n } or null when they cannot name a round. */
export function profileTarget(params = {}) {
  const date = String(params.date || '');
  const n = Number.parseInt(params.n, 10);
  return DATE_RE.test(date) && n >= 1 && n <= 5 ? { date, n } : null;
}

/** The message for a profile that cannot load (null: show the reveal's own retry card). */
export function profileError(err) {
  if (!err) return null;
  if (err.code === 'not_done') return { title: 'Not in your library yet', text: 'Finish this round to open its neuron profile.' };
  if (err.status === 404 || err.code === 'not_found') return { title: 'No such cell', text: 'This cell is not in your library.' };
  return null;
}

export default function Profile({ params = {} }) {
  const target = profileTarget(params);
  const key = target ? `${target.date}/${target.n}` : '';
  const [data, setData] = useState(null);      // { day, round, state }
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const roundId = data && data.round ? data.round.round_id : null;
  const reveal = useStore((s) => (roundId ? s.reveals[roundId] || null : null));
  const entry = useStore((s) => {
    const es = (s.library.data && s.library.data.entries) || [];
    return target ? es.find((e) => e.date === target.date && e.round_index === target.n) || null : null;
  });
  const libStatus = useStore((s) => s.library.status);
  const online = useStore((s) => s.ui.online);
  const reported = useReported(roundId);

  // the Library entry (its review schedule) after a reload or a deep link
  useEffect(() => { if (libStatus === 'idle') loadLibrary(); }, [libStatus]);

  useEffect(() => {
    if (!target) return undefined;
    let alive = true;
    setError(null);
    (async () => {
      try {
        const day = await api.getDay(target.date);
        const round = (day.rounds || [])[target.n - 1];
        if (!round) throw new api.ApiError(404, 'not_found', 'No such round');
        if (alive) setData((d) => ({ ...(d || {}), day, round }));
        const [progress, rev] = await Promise.all([
          api.getProgress(target.date).catch((err) => (err && err.isNetwork ? null : Promise.reject(err))),
          loadRevealById(round.round_id),
        ]);
        if (!alive) return;
        setData({ day, round, state: progress && progress.rounds ? progress.rounds[target.n - 1] || null : null });
        if (!rev.ok) setError(rev.err || new Error('Could not load this cell.'));
      } catch (err) {
        if (alive) setError(err);
      }
    })();
    return () => { alive = false; };
  }, [key, attempt]);

  // offline → back online: retry what failed for lack of a connection
  useEffect(() => { if (online && error && error.isNetwork && !reveal) setAttempt((a) => a + 1); }, [online]);

  const back = () => { haptic('selection'); navigate('/library'); };
  const fatal = !target ? { title: 'No such cell', text: 'This link does not name a cell.' } : profileError(error);
  if (fatal) {
    return html`<div class="screen profile-missing">
      <div class="card" role="alert">
        <span class="overline is-error">✕ ${fatal.title}</span>
        <span class="t-body t-soft">${fatal.text}</span>
        <${Button} variant="outline" block size="sm" onClick=${back}>← Library</${Button}>
      </div>
    </div>`;
  }

  const n = target.n;
  const dayNumber = (data && data.day && data.day.day_number) || (entry && entry.day_number) || null;
  const state = data ? data.state || null : null;
  const graphAsset = state && state.clues && state.clues.graph ? state.clues.graph.asset : null;
  return html`<${RevealView} key=${key} n=${n} dayNumber=${dayNumber} round=${data ? data.round : null} state=${state}
    reveal=${reveal} error=${reveal ? null : error} onRetry=${() => setAttempt((a) => a + 1)}
    overline=${`Your library · #${dayNumber || '…'} · Round ${n}`} footer=${reviewLine(entry)} cellLabel="this cell"
    nextLabel="← Library" onNext=${back} graphAsset=${graphAsset}
    onReport=${roundId ? () => openReport({ roundIndex: n, roundId, typeName: reveal ? reveal.type.name : null, dayNumber }) : null}
    reported=${reported}
    onFullView=${data && data.round && reveal ? (extra = {}) => import('./fullview.js')
      .then((m) => m.openFullView({ mode: '3d', round: data.round, state, reveal, ...extra })).catch(() => {}) : null} />`;
}
