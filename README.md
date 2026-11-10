# Immersive 3D Viewer

A desktop app for browsing big folders of 3D models on **macOS, Windows and Linux**.
Point it at a folder and you get a searchable thumbnail library of every model inside it,
an inspector to orbit each one, tools for fixing missing textures in bulk, and a
first-person **Zoo** you can walk around in, with the models on pedestals.

- **Formats:** GLB, glTF, FBX, OBJ (+MTL), DAE (Collada), 3DS, STL, PLY
- **Finds textures automatically.** FBX and OBJ files often point at texture paths from the
  artist's own machine (`C:\Users\artist\…\Textures\wall.png`). The viewer searches the
  library and nearby folders for those files by name.
- **Fixes textures in bulk.** You can assign a texture folder or one image to many models at
  once, or point a missing file name at a replacement image for every model that uses it.
- **Copies paths in one click.** Every card has a copy-path button. In the Zoo, clicking a
  model copies its path.

---

## Building from source

### 1. Install the prerequisites

| Tool | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org/) | 22 LTS or newer (tested with 24) | npm comes with it |
| [Git](https://git-scm.com/) | any recent | |

You don't need anything else to build for your own platform. Linux needs a few extra
packages to *run* the app (see [Linux notes](#linux)).

### 2. Get the code and install dependencies

```sh
git clone git@github.com:jasharpe/Immersive-3D-Viewer.git
cd Immersive-3D-Viewer
npm install
```

`npm install` downloads Electron and Three.js. It then runs a `postinstall` step that copies
the parts of Three.js the app needs into `src/vendor/three/`. If that folder ever goes
missing, run `npm run vendor`.

### 3. Run it in development

```sh
npm start
```

Click **Open folder…** and choose a folder that contains models. Subfolders are included.

### 4. Build an installable app

Run the command for the platform you want. The output goes to `dist/`.

| Platform | Command | Output in `dist/` |
|---|---|---|
| macOS | `npm run dist:mac` | `Immersive 3D Viewer-0.1.0-arm64.dmg` (Intel builds: `Immersive 3D Viewer-0.1.0.dmg`) |
| Windows | `npm run dist:win` | `Immersive 3D Viewer Setup 0.1.0.exe` (installer) and `Immersive 3D Viewer 0.1.0.exe` (portable, no install) |
| Linux | `npm run dist:linux` | `Immersive 3D Viewer-0.1.0.AppImage` and `immersive-3d-viewer_0.1.0_amd64.deb` |
| Current OS, unpacked (fastest; for testing) | `npm run pack` | `dist/<platform>-unpacked/` or `dist/mac-arm64/` |

By default each build is for the CPU of the machine you build on. To build for a different
CPU, add flags after `--`:

```sh
npm run dist:mac -- --x64          # Intel Mac
npm run dist:mac -- --universal    # one app for Intel + Apple Silicon
npm run dist:linux -- --arm64      # ARM Linux (e.g. Raspberry Pi 5)
npm run dist:win -- --arm64        # Windows on ARM
```

**Cross-building:** a Mac can build all three platforms (`npm run dist:win` and
`npm run dist:linux` both work there). Windows and Linux can build each other's packages,
but **only a Mac can build the macOS app**.

### 5. Check the build (optional)

```sh
npm run smoke -- /path/to/some/models              # tests the dev app
npm run pack && npm run smoke -- /path/to/models 20 --packaged   # tests the packaged app
```

The smoke test opens the folder and generates thumbnails. It then opens a model in the
inspector, walks into the Zoo, and prints a summary and the location of its screenshots. It
exits non-zero if any model fails to load.

---

## Platform notes

### macOS

- If you have an Apple Developer ID certificate in your keychain, the build is signed with
  it automatically. To skip signing, run `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac`.
- An unsigned or un-notarized app downloaded from elsewhere is blocked by Gatekeeper.
  To open it, right-click the app → **Open** → **Open**. Or remove the quarantine flag:
  `xattr -dr com.apple.quarantine "/Applications/Immersive 3D Viewer.app"`.
- Notarization isn't set up. See
  [electron-builder's notarization guide](https://www.electron.build/code-signing-mac) if you
  want to distribute the app publicly.

### Windows

- The installer isn't code-signed, so SmartScreen may warn on first run. Click
  **More info → Run anyway**. The portable `.exe` doesn't need installing.

### Linux

- **AppImage:** `chmod +x "Immersive 3D Viewer-0.1.0.AppImage"` and run it. On Ubuntu 22.04
  and newer, AppImages need FUSE 2: `sudo apt install libfuse2` (on 24.04 the package is
  `libfuse2t64`).
- **Debian/Ubuntu package:** `sudo apt install ./immersive-3d-viewer_0.1.0_amd64.deb`, then
  launch **Immersive 3D Viewer** from your app menu.
- To run `npm start` on a minimal system you may need Electron's runtime libraries:
  `sudo apt install libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 libasound2 libgbm1`.
- The app needs WebGL. Under VMs or remote desktops without GPU acceleration, Chromium uses a
  software renderer, which works but is slow.

---

## Using the app

The basics:

| Do this | How |
|---|---|
| Open a library | **Open folder…** (the last folder reopens automatically) |
| Find models | Type in the search box (`⌘F` / `Ctrl+F`), click format chips, or pick a folder in the tree |
| Copy a model's path | Copy button on the card, **Copy path** in the inspector, or `⌘C` / `Ctrl+C` |
| Inspect a model | Click its card. Drag to orbit, scroll to zoom, right-drag to pan |
| Select several models | `⌘`/`Ctrl`+click, `Shift`+click, or `⌘A` / `Ctrl+A` |
| Fix textures | See *Textures* below |
| Walk around | **Enter Zoo**: WASD + mouse, click a model to copy its path, `E` to inspect it, `Esc` for the menu |

**Textures.** Models with unresolved textures get a yellow **N missing** badge and show a
magenta checkerboard where the texture should be. You can fix them in several ways:

- **Missing textures…** (sidebar) lists every missing file name in the library. Use
  **Assign…** to pick one image for that name in every model that references it.
- Select models, then **Set texture folder…** to have them look in a specific folder first.
- Select models, then **Apply image to all materials…** for texture-atlas packs.
- In the inspector, set a texture on one material slot with **Choose…**, or drag an image
  onto the slot.

The full guide, including all shortcuts and options, is in [docs/USAGE.md](docs/USAGE.md).

Your settings, texture fixes and the thumbnail cache are stored in the app's data folder.
The app never writes into your model folders.

| OS | Data folder |
|---|---|
| macOS | `~/Library/Application Support/Immersive 3D Viewer/` |
| Windows | `%APPDATA%\Immersive 3D Viewer\` |
| Linux | `~/.config/Immersive 3D Viewer/` |

---

## Documentation

- [docs/USAGE.md](docs/USAGE.md): the full user guide
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the app is put together
- [docs/TEXTURES.md](docs/TEXTURES.md): how textures are found and how overrides work
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): project layout, scripts, testing and releasing

## License

Not yet licensed; all rights reserved by the author. Three.js is MIT-licensed (see
`node_modules/three/LICENSE`).
