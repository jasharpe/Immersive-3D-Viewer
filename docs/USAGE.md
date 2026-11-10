# User guide

## Opening a library

Click **Open folder…** and choose any folder. Every model under it is listed, including
models in subfolders.

| Supported | Extensions |
|---|---|
| glTF | `.glb`, `.gltf` (Draco and Meshopt compression supported) |
| Autodesk FBX | `.fbx` (binary and ASCII, with skeletal animation) |
| Wavefront | `.obj` with `.mtl` materials |
| Collada | `.dae` |
| 3D Studio | `.3ds` |
| Mesh-only | `.stl`, `.ply` |

The **Recent ▾** menu reopens earlier folders, and the most recent one opens automatically at
startup. The ⟳ button rescans the folder after you add or change files.

## Finding models

- **Search box** (`⌘F` / `Ctrl+F`): matches the model's path relative to the library, so you
  can search by folder name too. Separate words with spaces to require all of them.
  `chair glb` finds GLB files with "chair" in the path.
- **Formats:** click a format chip to show only that format. Click several to combine them.
- **Status:**
  - *Missing textures*: models that reference textures that couldn't be found.
  - *Texture overrides*: models where you've assigned textures yourself.
  - *Has animations*: models that contain animation clips.
  - *Failed to load*: models with broken or unsupported content.
- **Folders:** click a folder to show only models in it and its subfolders. Click ▶ to expand
  a folder without filtering.
- **Sort** by name, folder, size or modification date. The slider changes the card size.

The status counts fill in as the background analysis runs (see *Thumbnails* below).

### Group formats

Asset packs often ship the same model as GLB, FBX, OBJ and DAE. With **Group formats** on
(the default), these show as one card when they share a name and top-level folder. The
format chips on the card switch between the files, and the highlighted chip is the one that
is shown, copied and used in the Zoo. GLB is preferred, then glTF, FBX, OBJ, DAE, 3DS,
STL and PLY.

Texture actions on a grouped card apply to **every format** of that model.

## Copying paths

The app copies absolute paths in your OS's native format (`/Users/…` or `C:\…`).

- Click the copy icon in the top-right corner of a card.
- Click **Copy path** in the inspector, or the copy icon next to any other format listed
  there.
- `⌘C` / `Ctrl+C` copies the active model's path. If several models are selected, it copies
  all their paths, one per line.
- Right-click a card → **Copy path**.
- In the Zoo, look at a model and click.

## Inspecting a model

Click a card to load the model in the inspector on the right.

- **Mouse:** left-drag to orbit, right-drag (or `Shift`+drag) to pan, scroll to zoom.
- **Toolbar** (top right of the viewer): reset camera, auto-rotate, wireframe, grid,
  background colour.
- **Arrow keys** move to the next or previous model in the grid. `Space` selects or
  deselects the active model.
- **Animations:** if the model has animation clips, pick one from the dropdown to play it.
- Drag the divider to the left of the inspector to resize it.

The inspector shows triangle and material counts, every texture the file references and
where each one was found, and every material with its texture slots.

## Selecting several models

| Action | Effect |
|---|---|
| `⌘`/`Ctrl` + click, or click the card's checkbox | Add or remove one model |
| `Shift` + click | Select a range |
| `⌘A` / `Ctrl+A` | Select everything currently shown |
| `Esc` | Clear the selection |

When models are selected, a blue bar appears above the grid with these bulk actions:
**Copy paths**, **Set texture folder…**, **Apply image to all materials…**,
**Reset textures** and **Zoo with selection**. Right-clicking a selected card offers the same
actions.

## Textures

When a model loads, every texture it references is looked up automatically. The
[texture resolution doc](TEXTURES.md) explains how. Textures that can't be found render as
a **magenta and black checkerboard**, and the model's card gets a yellow **N missing**
badge.

There are several ways to fix missing textures, from broadest to most specific:

1. **Missing textures…** (sidebar). This lists every missing texture *file name* across the
   library and how many files use it. **Assign…** picks one image that every model
   referencing that name will use. This is usually the fastest fix, because the same missing
   file tends to be shared by many models. **Show models** filters the grid to the models
   that use it.
2. **Texture search folders…** (sidebar). Add folders outside the library that hold
   textures. Their images are indexed like the library's own.
3. **Set texture folder…** (selection bar, context menu, or inspector). The chosen models
   look in this folder *first*. Use it when the right textures exist but a better-matching
   file with the same name lives somewhere else.
4. **Apply image to all materials…** Every material of the chosen models uses this image as
   its base colour. This is ideal for atlas-textured packs where every model shares one
   texture. You can also drop an image file onto the 3D viewer.
5. **Per-slot overrides** (inspector → Materials). Click **Choose…** on a slot (base colour,
   normal, emissive, roughness, metalness, ambient occlusion) or drag an image onto it.
   Remove an override with **×**.

**Reset** (or **Reset textures**) removes the model's folder, all-materials and per-slot
overrides. Assignments made in the Missing textures dialog are library-wide and are
removed from that dialog.

Thumbnails update automatically when you change a model's textures.

### Pixelated

Turn on **Pixelated** to use nearest-neighbour texture filtering in the inspector and Zoo.
Low-resolution retro and PSX-style textures stay crisp instead of being blurred.

## Thumbnails

Thumbnails render in the background, starting with the cards on screen and then working
through the whole library. Rendering every model also records its texture, animation and
error information, which the status filters and the Missing textures dialog depend on.
**Pause** in the status bar stops the background work. Thumbnails are cached, so later
sessions start instantly. A model is re-rendered when its file changes or you change its
textures. Right-click → **Regenerate thumbnail** forces it.

## The Zoo

Click **Enter Zoo** to walk among the models currently shown in the grid, or select models
and use **Zoo with selection**. The Zoo holds up to 400 models, so for large libraries,
narrow the view first with search, folders or a selection.

Models stand on pedestals in rows, one row (or more) per folder, with a blue sign naming the
folder. Every model is scaled to about two metres so tiny props and huge buildings are all
viewable. Click **Click to walk around** to start.

| Key | Action |
|---|---|
| `W` `A` `S` `D` / arrow keys | Move |
| Mouse | Look |
| `Shift` | Run |
| `Space` | Jump (in fly mode: go up) |
| `F` | Toggle fly / noclip |
| `C` | Fly down |
| Left click | Copy the path of the model under the crosshair |
| `E` | Leave the Zoo and open the model under the crosshair in the inspector |
| `Esc` | Release the mouse and show the menu (Resume, Exit, labels, animation) |

The model you're looking at gets a gold pedestal and its name and path appear below the
crosshair. Animated models play their first animation clip; turn this off in the `Esc` menu
if it costs too much performance.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘F` / `Ctrl+F` | Focus search |
| `⌘C` / `Ctrl+C` | Copy the active (or selected) model paths |
| `⌘A` / `Ctrl+A` | Select all shown models |
| `Esc` | Close dialog / leave search / clear selection |
| Arrow keys | Move between models |
| `Space` | Toggle selection of the active model |
