// Texture discovery.
//
// Model files frequently reference textures by paths from the author's machine, e.g.
//   C:\Users\artist\Documents\Pack\Textures\Fence.jpg
// None of that exists here, so we index every image under the library (plus nearby
// texture folders) and resolve references by file name, preferring the candidate that
// is "closest" to the model and that best matches the tail of the original path.
// See docs/TEXTURES.md for the full algorithm.

import { key, basename, dirname, extname, stem, segments } from './paths.js';

export const NATIVE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
export const LOADABLE_EXTS = new Set([...NATIVE_EXTS, '.tga']);
export const IMAGE_EXTS = new Set([...LOADABLE_EXTS, '.psd', '.tif', '.tiff', '.dds']);

// Suffixes that identify which material slot a texture belongs to.
const SLOT_SUFFIXES = [
  ['normalMap', /[_\-\s.](normal|nrm|nor|norm|nml|n)$/],
  ['emissiveMap', /[_\-\s.](emission|emissive|emit|glow|e)$/],
  ['roughnessMap', /[_\-\s.](roughness|rough|rgh|r)$/],
  ['metalnessMap', /[_\-\s.](metallic|metalness|metal|m)$/],
  ['aoMap', /[_\-\s.](ao|ambientocclusion|occlusion|occ)$/],
  ['map', /[_\-\s.](basecolor|base_color|albedo|diffuse|diff|color|colour|col|bc|alb|d|tex|texture)$/],
];

/** Normalises a material / model / texture name for fuzzy equality. */
export function nameKey(s) {
  return s
    .toLowerCase()
    .replace(/\.\d{3}$/, '') // Blender duplicates: Wall.001
    .replace(/^(mat|mtl|material|mi|m|t|tex|tx)[_\-\s]+/, '')
    .replace(/[_\-\s]+(mat|mtl|material)$/, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Splits a texture stem into {slot, base} using common naming conventions. */
export function classifyTexture(fileStem) {
  const s = fileStem.toLowerCase();
  for (const [slot, re] of SLOT_SUFFIXES) {
    const m = s.match(re);
    if (m) return { slot, base: nameKey(s.slice(0, m.index)) };
  }
  return { slot: 'map', base: nameKey(s) };
}

export class TextureIndex {
  constructor(paths = []) {
    this.byName = new Map(); // "fence.jpg" -> entries
    this.byStem = new Map(); // "fence" -> entries
    this.byKey = new Map(); // full path key -> entry
    this.entries = [];
    for (const p of paths) this.add(p);
  }

  add(p) {
    const k = key(p);
    if (this.byKey.has(k)) return;
    const name = basename(k);
    const e = {
      path: p,
      key: k,
      dir: dirname(k),
      name,
      stem: stem(name),
      ext: extname(name),
      segs: k.split('/').filter(Boolean),
      cls: null, // lazily computed classifyTexture()
    };
    this.entries.push(e);
    this.byKey.set(k, e);
    push(this.byName, name, e);
    push(this.byStem, e.stem, e);
  }

  get size() { return this.entries.length; }

  /**
   * Resolves a texture reference to an existing file.
   * @param requested  path/URL-ish string as written in the model file
   * @param ctx        { modelDir, dirs: [override dir keys], remap: {lowerName: path} }
   * @param nativeOnly only return browser-decodable formats (png/jpg/...)
   * @returns {{path, how}|null}
   */
  resolve(requested, ctx = {}, nativeOnly = false) {
    const reqKey = key(requested);
    const name = basename(reqKey);
    const okExt = (e) => (nativeOnly ? NATIVE_EXTS : LOADABLE_EXTS).has(e.ext);

    const remapped = ctx.remap?.[name];
    if (remapped) return { path: remapped, how: 'remap' };

    const exact = this.byKey.get(reqKey);
    if (exact && okExt(exact)) return { path: exact.path, how: 'exact' };

    let cands = (this.byName.get(name) || []).filter(okExt);
    let how = 'found';
    if (!cands.length) {
      // Same name, different format: .psd/.tif/.dds referenced but a .png exists.
      cands = (this.byStem.get(stem(name)) || []).filter(okExt);
      how = 'substitute';
    }
    if (!cands.length) return null;
    const best = this.best(cands, reqKey, ctx);
    return { path: best.path, how: best.inOverride ? 'folder' : how };
  }

  best(cands, reqKey, ctx) {
    const reqSegs = reqKey.split(/[\\/]/).filter(Boolean);
    const modelSegs = ctx.modelDir ? segments(ctx.modelDir) : [];
    let best = null;
    let bestScore = -Infinity;
    for (const e of cands) {
      let score = 0;
      let inOverride = false;
      for (const d of ctx.dirs || []) {
        if (e.key.startsWith(d + '/')) { score += 1000; inOverride = true; break; }
      }
      // Tail match with the original path: ".../Textures/HouseV1/HouseMainTex.png"
      let t = 1;
      while (t < reqSegs.length && t < e.segs.length && reqSegs[reqSegs.length - 1 - t] === e.segs[e.segs.length - 1 - t]) t++;
      score += (t - 1) * 20;
      // Proximity to the model's folder.
      let c = 0;
      while (c < modelSegs.length && c < e.segs.length - 1 && modelSegs[c] === e.segs[c]) c++;
      score += c * 5 - (modelSegs.length - c) - (e.segs.length - 1 - c);
      if (score > bestScore) { bestScore = score; best = { ...e, inOverride }; }
    }
    return best;
  }

  /**
   * Finds a texture for a material that has none, by name convention
   * (material "Wall" -> "Wall.png", "T_Wall_BaseColor.png", ...).
   * Only searches inside `ctx.scopeDir` (the model's pack) and override dirs.
   */
  matchByName(names, slot, ctx) {
    const keys = names.map(nameKey).filter((k) => k.length >= 2);
    if (!keys.length) return null;
    const scopes = [...(ctx.dirs || []), ctx.scopeDir].filter(Boolean);
    const cands = [];
    for (const e of this.entries) {
      if (!LOADABLE_EXTS.has(e.ext)) continue;
      if (!scopes.some((s) => e.key.startsWith(s + '/'))) continue;
      if (!e.cls) e.cls = classifyTexture(e.stem);
      if (e.cls.slot !== slot) continue;
      if (keys.includes(e.cls.base) || keys.includes(nameKey(e.stem))) cands.push(e);
    }
    if (!cands.length) return null;
    const best = this.best(cands, '', ctx);
    return { path: best.path, how: 'name' };
  }
}

function push(map, k, v) {
  const a = map.get(k);
  if (a) a.push(v);
  else map.set(k, [v]);
}
