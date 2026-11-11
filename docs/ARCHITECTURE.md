# Architecture

Immersive 3D Viewer is an [Electron](https://www.electronjs.org/) app. The UI is plain
JavaScript ES modules with no framework and no bundler. Rendering uses
[Three.js](https://threejs.org/) (r187).

```
┌──────────────────────── main process (main.js) ────────────────────────┐
│ window · mfile:// protocol · folder scan · dialogs · clipboard ·      │
│ per-library state.json + thumbnail PNGs in userData                  │
└───────────────▲─────────────────────────────────────────────────────────┘
                │ IPC (preload.js → window.api)
┌───────────────┴──────────── renderer (src/) ────────────────────────────┐
│ app.js         library state, virtual grid, filters, selection,        │
│                inspector panel, bulk texture operations, dialogs       │
│ lib/loader.js  load any format → Object3D, texture hooks, overrides    │
│ lib/textureIndex.js   image index + reference resolution              │
│ lib/viewer.js  orbit inspector (own WebGL context)                     │
│ lib/thumbnailer.js    offscreen renderer (own WebGL context)          │
│ lib/zoo.js     first-person zoo (own WebGL context, created on entry)   │
│ lib/stage.js   shared lighting + camera framing                        │
│ lib/paths.js   cross-platform path ⇄ mfile:// URL helpers              │
└─────────────────────────────────────────────────────────────────────────┘
```

## Processes and security

- `contextIsolation: true` and `nodeIntegration: false`. The renderer has no Node access.
- `preload.js` exposes a small, explicit `window.api`: folder and image pickers, scan,
  load/save library state, save thumbnails, clipboard, reveal in file manager, config,
  `exists`, and `webUtils.getPathForFile` for drag-and-drop.
- External links open in the system browser. The app never navigates to remote content.

## The `mfile://` protocol

The app and every user file it reads are served through one custom, privileged scheme:

```
macOS/Linux  /Users/me/Pack/a.fbx      → mfile://local/Users/me/Pack/a.fbx
Windows      C:\Pack\a.fbx             → mfile://local/C%3A/Pack/a.fbx
Windows UNC  \\nas\share\a.fbx         → mfile://local/UNC/nas/share/a.fbx
```

The reasons for this design:

- **Relative references keep working.** URLs keep real path segments, so a glTF's `.bin`
  file or an MTL's `map_Kd textures/x.png` resolve relative to the model, the way they would
  on a web server.
- **There are no cross-origin problems.** The UI (`src/index.html`) is loaded from
  `mfile://local/…` too, so ES modules, the import map, `fetch`, Draco's WASM worker and
  WebGL texture uploads are all same-origin.
- **It works in packaged builds.** The handler uses `net.fetch(file://…)`, which understands
  paths inside Electron's `app.asar`.

`paths.js` (`toUrl`/`fromUrl`) and `main.js` (`pathToMfile`/`mfileToPath`) are the two
halves of the mapping. Loaders sometimes append raw, unencoded file names to a base URL
(for example `pixelated-image (52).png`), so decoding happens one segment at a time and is
tolerant of stray `%` characters.

## Three.js vendoring

electron-builder always strips `node_modules/*/examples` from packages, and Three.js keeps
its loaders and controls in `examples/jsm`. `scripts/vendor-three.js` runs on `postinstall`
and copies `build/three.module.js`, `build/three.core.js` and `examples/jsm/` into
`src/vendor/three/`. That folder is gitignored and regenerated on install. The import map in
`index.html` points `three` and `three/addons/` there, and `node_modules` is excluded from
the packaged app.

## Library data flow

1. **Scan.** `scanLibrary(root)` in the main process returns models (`path`, `rel`, `size`,
   `mtime`) and image paths (see [TEXTURES.md](TEXTURES.md#1-the-image-index)).
2. **Model.** `app.js` adds derived fields to each model: `name` (stem), `ext`, `relDir`,
   `top` (first folder under the root) and `relLower` for search.
3. **Filter → group → sort.** `refresh()` filters models (search tokens, formats, folder,
   status) and groups them into *entries*. With *Group formats* on, the group key is
   `top|stem`; otherwise each file is its own entry. Then it sorts. Selection is a set of
   entry keys.
4. **Render.** The grid is virtualised. Only cards in or near the viewport exist in the DOM,
   absolutely positioned from `(index → row, col)`. Scrolling re-renders the visible window
   and tells the thumbnail queue what's on screen.

## Thumbnail pipeline

`thumbs` in `app.js` is a single-worker queue:

- On-screen models go first. After that, a cursor walks the whole library so that every
  model is eventually analysed. The status filters and the Missing textures dialog need that
  analysis.
- Each job loads the model through `loadModel()` in the `Thumbnailer`'s offscreen WebGL
  context, frames it, renders a 256×256 PNG with a transparent background, and saves it via
  IPC to `userData/libraries/<hash>/thumbs/<sha1(path)>.png`.
- The job's report (missing texture names, referenced names, triangle, material and
  animation counts, errors) is stored in `state.meta[path]` along with a signature (see
  [TEXTURES.md §7](TEXTURES.md#7-thumbnail-invalidation)).
- The queue pauses while the Zoo is open so they don't compete for the GPU.

## Model loading (`lib/loader.js`)

`loadModel(path, { index, ctx, overrides, texCache, pixelated })`:

1. Creates a `LoadingManager`. Its `itemStart`/`itemEnd` are wrapped to count outstanding
   requests so callers can wait for the textures as well as the geometry.
2. Installs the texture handler and URL modifier
   (see [TEXTURES.md §2](TEXTURES.md#2-hooking-the-loaders)).
3. Dispatches on the file extension:
   - **GLB/glTF:** `GLTFLoader` with Draco and Meshopt decoders.
   - **FBX:** `FBXLoader`, then the file's `UnitScaleFactor` is applied (FBX stores
     centimetres per unit; FBXLoader reads the value but doesn't apply it), so models
     come out in metres.
   - **OBJ:** reads the text, finds `mtllib` lines (falling back to `<name>.mtl`), loads
     the materials with `MTLLoader`, then parses with `OBJLoader`.
   - **DAE:** `ColladaLoader`.
   - **3DS:** `TDSLoader`.
   - **STL/PLY:** the geometry gets a default material. PLY files without faces become
     points.
4. Runs name-based auto-matching and applies overrides.
5. Waits for outstanding loads (with a timeout). It then checks every blended
   (transparent) material's texture alpha. Exporters often mark solid materials as
   "alpha blend", which stops them writing depth and makes hidden parts show through.
   Materials whose texture has no real translucency become opaque, and pure on/off alpha
   becomes an alpha-tested cut-out. Genuinely translucent ones (glass, cobwebs) stay
   blended. Finally it computes statistics.

It returns `{ object, animations, report, materials, loadTexture, dispose }`. `dispose()`
frees geometries, materials and textures.

## Viewer, thumbnailer and Zoo

Each of these has its own `WebGLRenderer` and therefore its own WebGL context. That's at
most three at once, well within Chromium's limit.

- **Viewer.** `OrbitControls`, studio lighting (a `RoomEnvironment` PMREM for PBR materials
  plus hemisphere and directional lights for Phong/Lambert ones), and a grid sized to the
  model. It renders only when something changes: the camera moves, an animation plays, or
  auto-rotate is on.
  - **Model cache:** loaded models are kept in an LRU cache of `CACHE_MAX` (10). After a
    model is shown, `preloadNeighbours()` in `app.js` loads the entries the arrow keys
    can reach (right, left, down, up), one at a time. Shaders and textures are uploaded
    up front (`warm()`), so stepping to a neighbour or back is instant. The cache is
    dropped whenever textures change (`invalidateCache()`) or another library is opened.
    "Loading…" only appears if a model takes more than 150 ms.
- **Zoo.** Created when you enter and fully disposed when you leave (`forceContextLoss`).
  - Layout: entries are grouped by `relDir`, `PER_ROW` per row, with rows spaced along Z.
    Models are shown at real size, turned 180° to face the spawn side.
  - Each pedestal is a unit cylinder scaled to the model's footprint at that exhibit's
    display scale (`+`/`-`/`0` change the scale of the exhibit under the crosshair, saved in
    `zooScales`). `relayout()` recomputes target positions whenever a model loads or is
    resized, and exhibits glide to their targets in `tick()`.
  - Footprints come from `meta[path].size`, recorded by the thumbnailer and by the Zoo
    itself (`onSize`), so the layout is usually final before anything loads.
  - The layout is anchored: after each `relayout()` everything is shifted so the anchor
    exhibit (the start model, then the last one resized) keeps its position. The camera
    eases into place in front of the start model until the player moves or looks.
  - Models load three at a time, nearest first, with wireframe placeholders until then. They
    share one texture cache.
  - The player uses `PointerLockControls` for looking. Movement, gravity, jumping, fly mode
    and pedestal collision (circle tests) are handled in `Zoo.move()`.
  - Picking intersects the centre ray with each exhibit's expanded bounding box. That's
    cheap and forgiving for small props.
  - The shadow-casting sun follows the player so a 56 m shadow frustum is enough.

## Persistence

| What | Where | Format |
|---|---|---|
| App config (window bounds, recent folders, UI settings) | `userData/config.json` | JSON |
| Library state | `userData/libraries/<sha1(root)[0:16]>/state.json` | `{ version, overrides, remap, meta, textureDirs, hearts, views, zooScales }`. `hearts` maps model path → time hearted, `views` maps model path → saved camera `{ position, target }`, and `zooScales` maps model path → Zoo display scale (absent = real size). `meta[path].size` is the model's `[x, y, z]` size in metres |
| Thumbnails | `userData/libraries/<…>/thumbs/<sha1(modelPath)[0:24]>.png` | 256×256 PNG |

Writes are atomic (write to a temp file, then rename). Library state is saved with a short
debounce, and any pending save is flushed synchronously (`lib-save-sync`) when the window
closes. The app never writes inside the user's model folders.

`userData` is `~/Library/Application Support/Immersive 3D Viewer` on macOS,
`%APPDATA%\Immersive 3D Viewer` on Windows and `~/.config/Immersive 3D Viewer` on Linux.
`I3DV_USER_DATA` overrides it (see [DEVELOPMENT.md](DEVELOPMENT.md)).

## Cross-platform notes

- Paths are kept native everywhere they leave the app (clipboard, reveal, dialogs) and are
  normalised (forward slashes, lower case) only for comparisons and keys.
- `Cmd` vs `Ctrl` for shortcuts and selection is chosen from `api.platform`.
- Linux packages are built as AppImage and `.deb`, Windows as an NSIS installer and a
  portable `.exe`, macOS as a `.dmg`. The configuration is in the `build` section of
  `package.json`.
