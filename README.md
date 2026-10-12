# NeuroGuesser

A daily guessing game for neurons, built for researchers at the MRC LMB. Every day brings five real neurons
from public connectomes. For each one you name the cell type from its 3D mesh, then say how its EM was
imaged. Think GeoGuessr, but for cell types.

This repository is the **app shell**: a Progressive Web App written in plain HTML, CSS and ES modules, with no
build step. It is served from GitHub Pages. Rounds, answers and scores live on the NeuroGuesser Worker API, so
nothing in this repo gives the answers away.

## Install it on your phone

The same URL works in any browser. On a phone you can install it to the Home Screen, where it opens full
screen like an app.

- **iPhone / iPad (iOS 16.4+):** open the site in Safari (or Chrome, Edge or Firefox), tap **Share** and then
  **Add to Home Screen**. Before iOS 16.4, only Safari could do this.
- **Android (Chrome):** open the site, tap the **⋮** menu and then **Install app** (or **Add to Home screen**).
  Chrome may also offer an install banner.
- **Desktop (Chrome / Edge):** use the install icon in the address bar. Otherwise it runs in a normal tab, as
  a centred column.

There are no accounts and no analytics. The first launch creates a random device ID, which stays on the
device in IndexedDB. To move your progress to a new phone, go to **Ranks → Profile → Move to a new phone**.

## Local development

```sh
# app only (the Today tab shows the error state with Retry until the Worker is running)
python3 -m http.server 5173 --directory neuroguesser
open http://localhost:5173

# full stack: fixtures + Worker on :8787 + this app on :5173
../neuroguesser-content/scripts/dev-up.sh
```

These dev overrides work only on `localhost` / `127.0.0.1` (see `config.js`):

| Query | Effect |
|---|---|
| `?api=http://localhost:8787` | API base URL (the default on localhost) |
| `?now=2026-10-03T23:59:30Z` | sends `X-NG-Debug-Now` (the Worker honours it only with `ALLOW_DEBUG_NOW=1`); the clock starts there on page load and then advances in real time, so rollover and grace play out |
| `?sw=1` | registers the service worker. It is off by default in dev, so edited files are never served stale |

Before deploying, set `PRODUCTION_API` in `config.js` to the Worker's origin. The Worker's `ALLOWED_ORIGINS`
must include the Pages origin.

### Tests

```sh
cd neuroguesser && node --test        # or: npm test (no dependencies are installed)
```

These cover the pure modules: `format.js` (the share text is checked against `scoring.md`), the `game.js`
helpers, `scalebar.js`, `time.js` and `fx/overtake.js`. Behaviour tests run against fakes: `api.js` (every
endpoint's method, path, body and headers; `ApiError`; assets) and the `game.js` actions (state from responses
and 409 bodies, the busy guard, stale `/progress` reads racing actions, grace, offline) with a mocked `fetch`;
`sw.js` in a `vm` with fake caches (what is and is never cached, `X-From-Cache`, install/activate); `useStore`
re-renders, rendered with Preact on the minimal DOM in `tests/_dom.js`; haptics and celebrations
(`tests/fx.test.js`); and the §4 module interfaces W2 tracks rely on (`tests/interfaces.test.js`). There are
also shell checks: import-map targets, the service worker's precache list against the files on disk,
`VERSION` agreement, the manifest and the `config.js` dev-override rules. App modules that import `preact`
are loaded through `tests/_importmap.js`, which resolves bare specifiers with the import map from
`index.html`. This needs Node ≥ 22.15.

### Dev pages

- `dev/fx.html`: every celebration and haptic (open it on a phone to feel the haptics).
- `dev/components.html`: the Charcoal classes and components, assembled into the handoff's round screen.
- `dev/vendor-check.html`: imports every vendored module and renders a WebGL test mesh.

## How the code is laid out

```
index.html            import map, iOS/PWA meta, #app, #fx-layer
sw.js, version.js     versioned caches; bump VERSION in both together (a test enforces it)
config.js             API base + localhost-only dev overrides
css/tokens.css        Charcoal app-dark tokens + type scale
css/app.css           base styles and shared component classes (tab bar, buttons, chips, segmented,
                      overlines, cards, option cards, viewer chrome, clue bar, lock bar, sheet, toast, fx)
js/main.js            boot: session, render, Today, /me, online/offline, rollover, service worker
js/app.js             router outlet, tab bar, overlay host (store.ui.sheet / fullView), toast
js/router.js          hash routes (#/today, #/today/round/n, #/today/reveal/n, #/library, #/review, #/ranks, #/settings)
js/store.js           app store + useStore hook + setSettings / showToast / openSheet helpers
js/api.js             every Worker endpoint (contracts/api.md v1.1), ApiError, gated asset helpers
js/game.js            round actions → { ok, resp, err } + pure helpers (optionStates, currentView, …)
js/time.js            server clock offset, UTC helpers, rollover/resume watcher
js/format.js          numbers, method names/blurbs, countdown, strip + share text
js/fx/                haptics, celebrations, overtakes, streak counter, milestone sheet
js/ui/                html (htm), shared components, <Sheet>
js/viewer/            three.js plumbing, scale bars, viewer modules
js/screens/           Today controller and the screens
vendor/               Preact 11, htm, three.js r186 (+ addons), each with its licence (vendor/README.md)
```

### Notes for screen authors

- A screen module default-exports `({ params }) => vnode`. Add CSS with `loadCss('css/<screen>.css')` from
  `js/ui/html.js`. `index.html` does not need to change.
- Open overlays through the store: `openSheet('share', props)` (or `openShare(props)`). The registry is at the
  top of `js/app.js`. A sheet component receives `{ ...props, onClose }` and renders `<Sheet>`.
- Round actions never reject: `const r = await guess(n, 'c')`. Then use `r.ok`, `r.resp.correct`, or
  `r.err.code` (`'already_guessed'` and similar; `err.state` has already been applied to the store).
- Feedback goes through `js/fx` (see `dev/fx.html`). Call `haptic('selection')` synchronously in the tap
  handler, because iOS only fires haptics inside a user gesture. Fire the result haptic as soon as the
  response arrives. Celebrations already respect reduced motion and Settings → Celebrations.
- Offline: `store.ui.online === false`. Disable Guess / Open / Lock (label them "Offline") and show
  `<OfflineChip/>` in the viewer overlay.

## Offline

The service worker precaches the shell. It serves `/v1/day/{date}` network-first, falling back to the cache
(with `X-From-Cache: 1`), and serves content-hashed `/v1/asset/*` cache-first, storing only successful
responses. It never caches `/today`, `/progress`, `/me`, `/library`, `/ranks`, `/stats`, `/review` or POSTs.
The app also keeps the last Today, day and progress in IndexedDB, so Today can render read-only offline.

## Data and attribution

Every neuron comes from a public connectome released under its own licence. Each reveal names the dataset,
the papers and the required attribution. The full list of datasets, with credits and licences, is in the app
under **Settings → About & data credits** (`js/credits.js`). <!-- TODO(W2 social): mirror the credits list here once js/credits.js is filled. -->

## Licence

MIT (see `LICENSE`). Vendored libraries and fonts keep their own licences: Preact (MIT), htm (Apache-2.0),
three.js (MIT), meshoptimizer (MIT) and the Liberation fonts (SIL OFL 1.1, `fonts/OFL.txt`).
