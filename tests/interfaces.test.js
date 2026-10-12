// The fixed module interfaces of ARCHITECTURE.md §4 that W2 tracks implement or consume. Stubs may be
// replaced, but these names (and the screen/overlay entry points app.js and router.js load) must stay.
import './_importmap.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const fnNames = (mod, names) => names.filter((n) => typeof mod[n] !== 'function');

test('§4.2 api.js: one function per endpoint + asset helpers + ApiError', async () => {
  const api = await import('../js/api.js');
  assert.deepEqual(fnNames(api, [
    'getHealth', 'getToday', 'getDay', 'getProgress', 'openClue', 'guess', 'chooseMethod', 'getReveal', 'report',
    'getMe', 'updateMe', 'createTransferCode', 'claimTransferCode', 'createGroup', 'joinGroup', 'leaveGroup',
    'getLibrary', 'getReviewQueue', 'submitReview', 'getRanks', 'getDayStats',
    'assetArrayBuffer', 'assetBlob', 'assetJSON', 'assetObjectURL',
  ]), []);
  const e = new api.ApiError(409, 'conflict', 'x', { stage: 'type' });
  assert.ok(e instanceof Error);
  assert.deepEqual([e.status, e.code, e.state.stage], [409, 'conflict', 'type']);
});

test('§4.1 store.js, §4.3 game.js, §4.6 format.js', async () => {
  const s = await import('../js/store.js');
  assert.deepEqual(fnNames(s.store, ['get', 'set', 'subscribe']), []);
  assert.deepEqual(fnNames(s, ['createStore', 'useStore']), []);
  const g = await import('../js/game.js');
  assert.deepEqual(fnNames(g, [
    'loadToday', 'openClue', 'guess', 'chooseMethod', 'loadReveal', 'ackReveal',
    'optionStates', 'optionsLeft', 'guessesLeft', 'currentView', 'dayTotal', 'strip', 'shareText', 'outcomeOf',
  ]), []);
  const f = await import('../js/format.js');
  assert.deepEqual(fnNames(f, ['fmtPts', 'initials', 'countdown']), []);
  assert.deepEqual(Object.keys(f.METHOD_NAMES).sort(), Object.keys(f.METHOD_BLURBS).sort());
  for (const b of Object.values(f.METHOD_BLURBS)) assert.ok(!/\d/.test(b), `blurbs carry no numbers: ${b}`);
});

test('§4.4 viewers: MeshViewer / EmViewer methods, GraphView, niceScale', async () => {
  const { MeshViewer } = await import('../js/viewer/mesh-viewer.js');
  const { EmViewer } = await import('../js/viewer/em-viewer.js');
  const { GraphView } = await import('../js/viewer/graph-view.js');
  const { niceScale } = await import('../js/viewer/scalebar.js');
  const missing = (cls, names) => names.filter((n) => typeof cls.prototype[n] !== 'function');
  assert.deepEqual(missing(MeshViewer, ['loadNeuron', 'setContext', 'setSiblings', 'setLayers', 'setView', 'getView', 'setDragMode', 'zoomBy', 'resetView', 'stopAutoRotate', 'onChange', 'onTap', 'resize', 'dispose']), []);
  assert.deepEqual(missing(EmViewer, ['load', 'setPlane', 'setSlice', 'getSlice', 'step', 'setMaskVisible', 'zoomBy', 'resetView', 'onChange', 'onTap', 'resize', 'dispose']), []);
  assert.equal(typeof GraphView, 'function');
  assert.equal(typeof niceScale, 'function');
});

test('§4.5 screens default-export components; overlay openers and sheet components app.js loads exist', async () => {
  for (const s of ['today', 'round', 'reveal', 'summary', 'share', 'report', 'library', 'review', 'ranks', 'settings', 'onboarding', 'fullview']) {
    const m = await import(`../js/screens/${s}.js`);
    assert.equal(typeof m.default, 'function', `${s}.js default export`);
  }
  const named = {
    'share.js': ['openShare'], 'report.js': ['openReport'], 'fullview.js': ['openFullView'],
    'round.js': ['openClueConfirm', 'ClueConfirmSheet'], 'library.js': ['openLibraryDetail', 'LibraryDetailSheet'],
    'onboarding.js': ['openOnboarding'],
  };
  for (const [file, names] of Object.entries(named)) {
    assert.deepEqual(fnNames(await import(`../js/screens/${file}`), names), [], file);
  }
  const ms = await import('../js/fx/milestone.js');
  assert.deepEqual(fnNames(ms, ['openMilestone', 'MilestoneSheet']), []);
});

test('§4.7 fx exports', async () => {
  const c = await import('../js/fx/celebrate.js');
  assert.deepEqual(fnNames(c, ['burst', 'checkDraw', 'shake', 'strike', 'pulse', 'floatUp', 'countUp', 'useCountUp', 'flip']), []);
  assert.ok(Array.isArray(c.STREAK_MILESTONES));
  const h = await import('../js/fx/haptics.js');
  assert.equal(typeof h.haptic, 'function');
  const o = await import('../js/fx/overtake.js');
  assert.deepEqual(fnNames(o, ['checkOvertakes', 'lastRanksSnapshot']), []);
});
