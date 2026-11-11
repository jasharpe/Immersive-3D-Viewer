# Development

## Project layout

```
main.js                 Electron main process (protocol, scanning, IPC, persistence)
preload.js              window.api bridge exposed to the renderer
src/
  index.html            UI shell + import map (three → src/vendor/three)
  styles.css            all styles (dark theme)
  app.js                renderer entry: library state and all UI behaviour
  icons.js              inline SVG icons
  lib/
    paths.js            path ⇄ mfile:// helpers, cross-platform path utils
    textureIndex.js     image index, reference resolution, name matching
    loader.js           loadModel() for every format, overrides, disposal
    stage.js            lighting rig and camera framing
    viewer.js           inspector orbit viewer
    thumbnailer.js      offscreen thumbnail renderer
    zoo.js              first-person zoo
  vendor/three/         (generated, gitignored) copy of Three.js build + addons
scripts/
  vendor-three.js       copies Three.js into src/vendor (postinstall)
  dev-app-name.js       macOS: names the dev Electron.app for the Dock (postinstall)
  smoke-test.js         end-to-end check against a real model folder
docs/                   this documentation
```

There's no build step for the renderer. Edit a file and reload the window with
`⌘R` / `Ctrl+R`, or restart `npm start` for changes to `main.js` or `preload.js`. Open
DevTools with `⌥⌘I` / `Ctrl+Shift+I`.

## npm scripts

| Script | What it does |
|---|---|
| `npm start` | Run the app from source |
| `npm run vendor` | Re-copy Three.js into `src/vendor/three` (also runs on `postinstall`) |
| `node scripts/dev-app-name.js` | macOS: rename the development Electron.app so the Dock shows "Immersive 3D Viewer" (also runs on `postinstall`) |
| `npm run pack` | Build an unpacked app for the current OS into `dist/` (fast) |
| `npm run dist:mac` / `dist:win` / `dist:linux` | Build installers (see README) |
| `npm run dist` | Build for the current OS's default targets |
| `npm run smoke -- <folder> [seconds] [--packaged]` | End-to-end smoke test |

## Upgrading Three.js

```sh
npm install three@latest
npm run vendor
npm start   # check the console for deprecation warnings
```

Things that have broken across Three.js versions before:

- The `THREE.Source` → `THREE.TextureSource` rename (handled in `loader.js`).
- `THREE.Clock` deprecation (we use `performance.now()`).
- Removal of `PCFSoftShadowMap`.
- Changes to how FBX, glTF and MTL loaders call `manager.getHandler()`. If a loader stops
  asking for a handler, textures would bypass the resolver; check the *Textures* list in
  the inspector.

## Test hooks

Two environment variables make the app scriptable. They are inert unless set.

| Variable | Effect |
|---|---|
| `I3DV_USER_DATA=/some/dir` | Use this directory instead of the real `userData`, keeping settings and caches isolated |
| `I3DV_TEST_SCRIPT=/path/test.js` | After the window loads, run the file's contents as the body of an `async` function in the renderer. A returned value is printed to stdout as `[test] <json>`. Renderer warnings and errors are echoed as `[renderer:level]` |

The renderer exposes `window.app` (state `S`, `openLibrary`, `openInspector`, `enterZoo`,
`refresh`, texture operations, …) and `window.api` (including `api.capture(file)` for
screenshots and `api.quit()`).

Example script:

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
while (!window.app) await sleep(100);
await app.openLibrary('/path/to/models');
await sleep(10000);
await api.capture('/tmp/library.png');
const S = app.S;
api.quit();
return { models: S.models.length, failed: S.models.filter((m) => S.state.meta[m.path]?.error).length };
```

```sh
I3DV_USER_DATA=/tmp/i3dv I3DV_TEST_SCRIPT=/tmp/test.js npx electron .
```

`scripts/smoke-test.js` wraps exactly this. It opens a folder, waits for thumbnails, opens
the first model, enters the Zoo with 24 models, screenshots each step and fails on load
errors. Use `--packaged` to run the same checks against the app in `dist/`. That catches
packaging problems such as missing files in the asar.

The Zoo's pointer lock can't be engaged from a script, so walking and clicking need manual
testing. `app.S.zoo.camera` can be positioned from a script to take screenshots.

## Manual test checklist

- Open a folder with FBX files whose textures live in a sibling `Textures/` folder. The
  thumbnails should be textured.
- Find a model with a *missing* badge. In the inspector, **Assign…** an image. The model
  and every other model that uses that file name should update.
- Select several models → **Apply image to all materials…** → **Reset textures**.
- Drag an image onto a material slot, then onto the 3D viewer.
- Copy a path with the card button, with `⌘C`/`Ctrl+C`, and from the Zoo (click). Paste it
  somewhere to check.
- In the Zoo: WASD, jump, `F` fly, `E` to inspect, `Esc` → Exit.
- On Windows: paths with drive letters, UNC paths (`\\server\share`) and folder names with
  spaces or `#`.

## Releasing

1. Bump `version` in `package.json`.
2. Build on each OS you want signed artefacts for. Unsigned cross-builds from macOS also work:
   ```sh
   npm run dist:mac && npm run dist:win && npm run dist:linux
   ```
3. Smoke-test the packaged app: `npm run smoke -- <folder> 20 --packaged`.
4. Attach the files in `dist/` to a GitHub release.

Code signing is picked up from the standard electron-builder environment variables
(`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, …). See
[electron-builder's code signing docs](https://www.electron.build/code-signing).
