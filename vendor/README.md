# Vendored libraries

No build step: these ES modules are loaded through the import map in `index.html`
(and `dev/*.html`). Each folder keeps its upstream licence file.

| Path | Package | Version | Licence | Source in the npm tarball |
|---|---|---|---|---|
| `preact/preact.module.js` | preact | 11.0.0 | MIT (`preact/LICENSE`) | `dist/preact.mjs` (unmodified) |
| `preact/hooks.module.js` | preact/hooks | 11.0.0 | MIT | `hooks/dist/hooks.mjs` (unmodified; imports `preact`) |
| `htm/htm.module.js` | htm | 3.1.1 | Apache-2.0 (`htm/LICENSE`) | `dist/htm.module.js` (unmodified) |
| `three/three.module.min.js` | three | 0.186.1 | MIT (`three/LICENSE`) | see below |
| `three/addons/loaders/GLTFLoader.js` | three | 0.186.1 | MIT | `examples/jsm/loaders/` (unmodified) |
| `three/addons/utils/BufferGeometryUtils.js`, `SkeletonUtils.js` | three | 0.186.1 | MIT | `examples/jsm/utils/` (imported by GLTFLoader) |
| `three/addons/lines/{Line2,LineGeometry,LineMaterial,LineSegments2,LineSegmentsGeometry}.js` | three | 0.186.1 | MIT | `examples/jsm/lines/` (unmodified) |
| `three/addons/libs/meshopt_decoder.module.js` | meshoptimizer (via three) | 1.1 | MIT (`LICENSE-meshoptimizer.txt`) | `examples/jsm/libs/` (unmodified) |

**three.module.min.js:** since r17x the npm package no longer ships minified builds, and
`build/three.module.js` imports `./three.core.js`. The file here is
`build/three.module.js` + `build/three.core.js` bundled into one ES module and minified with
esbuild (no source changes; the licence banner is kept):

```
npm pack three@0.186.1 && tar xzf three-0.186.1.tgz
npx esbuild package/build/three.module.js --bundle --minify --format=esm \
  --legal-comments=inline --outfile=vendor/three/three.module.min.js
```

Addons import `three` (bare) or relative paths, so they resolve through the import map
entries `"three"` and `"three/addons/"`. `dev/vendor-check.html` imports every module above
and renders a test mesh, so a broken path shows up immediately.
