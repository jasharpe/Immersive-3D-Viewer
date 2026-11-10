# Texture resolution

Model files rarely carry textures that "just work" on another machine. Here are real
references from FBX files in a typical asset pack:

```
C:\Users\artist\Documents\Assets for sale\PSX\Pack\Textures\Fence.jpg
G:\Other computers\My Computer\Assets\Pack\Models\FBX\wall_1.fbm\wall_3.png
C:/ceiling_1.png                                   (from an OBJ's .mtl file)
C:\Users\artist\Downloads\pixelated-image (52).png (a file that was never shipped)
```

This document describes how the app turns references like these into files on disk. The
code is in `src/lib/textureIndex.js` and `src/lib/loader.js`.

## 1. The image index

When a library is opened, the main process (`scanLibrary` in `main.js`) collects images
(`png jpg jpeg tga bmp gif webp psd tif tiff dds`) from three places:

1. **Everything under the library folder.**
2. **Nearby texture folders.** In each of the two folders above the library, it scans
   subfolders whose names look texture-related (`/tex|material|image|img|maps|\.fbm$|sprite/i`)
   and loose image files. If you open `Pack/Models`, this finds `Pack/Textures`, but it never
   crawls your whole home folder. At most 20,000 images are taken from these folders.
3. **Extra texture search folders** that the user adds in the UI, saved per library.

`TextureIndex` keys each image by lower-cased full path, file name and file stem. Matching
is case-insensitive on every OS. That's deliberate, because assets made on Windows often
reference `Wall.PNG` while the file is `wall.png`.

## 2. Hooking the loaders

Each model load gets its own `THREE.LoadingManager` with two hooks.

- **A handler for every image extension** (`SmartTextureLoader`). Three r187's FBX, glTF and
  MTL loaders all ask the manager for an extension handler before loading a texture, so
  every texture request goes through this one class.
- **A URL modifier** catches loaders that load textures without asking for a handler
  (Collada, 3DS). It can only substitute browser-decodable images.

Both hooks call `TextureIndex.resolve(requested, ctx)`.

## 3. Resolving one reference

`resolve()` tries these steps in order and stops at the first hit:

| Step | Result label (shown in the inspector) |
|---|---|
| The user mapped this **file name** library-wide (Missing textures → Assign…) | *mapped by you* |
| The exact requested path exists in the index | *at original path* |
| Images with the same **file name** exist; pick the best (below) | *found nearby* / *in texture folder* |
| Images with the same **stem** but a loadable format exist (`.psd`/`.tif`/`.dds` requested, `.png` present); pick the best | *same name, different format* |
| Nothing found: a magenta checkerboard texture is used and the name is recorded as missing | *not found* |

"Loadable" means png, jpg, gif, webp, bmp or tga. tga goes through `TGALoader`.

### Choosing between candidates

Packs often contain several images with the same name, such as `wall_1.png` in
`Textures/` and also in an old `.fbm` folder. Each candidate is scored as follows:

- **+1000** if it's inside one of the model's *texture folder* overrides.
- **+20 per matching trailing path segment** between the requested path and the candidate.
  A request for `…\HouseV1\HouseMainTex.png` prefers `Textures/HouseV1/HouseMainTex.png`
  over `Textures/Old/HouseMainTex.png`.
- **+5 per leading path segment shared with the model's folder**, minus the number of
  folders you'd have to walk up and down to get from one to the other. Closer is better.

The highest score wins.

## 4. Materials with no texture at all

Some files reference no texture but name their materials sensibly. After loading, every
material whose base colour map is missing or unresolved gets one more lookup,
`matchByName()`:

- The names tried are the material name, the stem of the missing texture (if any), and the
  model's file name (only for single-material models).
- Names are normalised by lower-casing them, dropping Blender's `.001` suffixes and common
  prefixes and suffixes (`M_`, `Mat_`, `T_`, `_mat`), and removing punctuation.
- Candidate textures are classified by suffix (`_BaseColor`, `_Albedo`, `_D`, `_Normal`,
  `_N`, `_Emission`, …). Only base-colour candidates are considered.
- The search is limited to the model's **pack**, meaning the first folder under the library
  root that contains it, plus any texture-folder overrides. That stops a material called
  `Wall` from picking up a `wall.png` from an unrelated pack.

Textures found this way are tagged **AUTO** in the inspector.

## 5. User overrides

Overrides are stored per library in `state.json` (see [ARCHITECTURE.md](ARCHITECTURE.md#persistence)).

```jsonc
{
  "overrides": {
    "/abs/path/model.fbx": {
      "dirs": ["/abs/textures"],                 // searched first (+1000 score)
      "all":  { "map": "/abs/atlas.png" },       // every material's base colour
      "mats": { "Wall": { "normalMap": "/abs/wall_n.png" } }  // per material, per slot
    }
  },
  "remap": { "pixelated-image (52).png": "/abs/outlet.png" }  // library-wide, by file name
}
```

Precedence for each material slot is `mats[material][slot]`, then `all[slot]`, then whatever
the file and resolver produced. Materials are keyed by name, or by `#index` when unnamed.
Every material with the same name shares its overrides.

When an override sets a base colour map, the material's colour is reset to white so the
texture shows unmodified. Many FBX exporters write a grey diffuse colour that would
otherwise darken it. Emissive maps on materials with a black emissive colour get a white
emissive colour.

## 6. Sharing textures on the GPU

Textures are cached by resolved path in a `Map` of `THREE.TextureSource` objects. Each
request gets its own `THREE.Texture` (so wrap, repeat and offset can differ), but they share
the source, so WebGL uploads each image once. The inspector and thumbnailer use a fresh
cache per model. The Zoo uses one cache for the whole session, which matters when hundreds
of models share a handful of textures.

## 7. Thumbnail invalidation

Each thumbnail stores a signature made of the thumbnail format version, the file size and
mtime, the model's overrides, and any library remaps of names the model references. If
anything in that signature changes, the thumbnail is re-rendered. Adding a remap for
`foo.png` re-renders only models whose last analysis referenced `foo.png`.
