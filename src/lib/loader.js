// Loads any supported model file into a THREE.Object3D, resolving textures through
// the TextureIndex and applying the user's texture overrides.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { TDSLoader } from 'three/addons/loaders/TDSLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { toUrl, fromUrl, key, basename, dirname, extname, stem, join } from './paths.js';
import { IMAGE_EXTS } from './textureIndex.js';

// r18x renamed THREE.Source to THREE.TextureSource.
const TextureSource = THREE.TextureSource || THREE.Source;

export const MODEL_EXTS = ['.glb', '.gltf', '.fbx', '.obj', '.dae', '.stl', '.ply', '.3ds'];

export const SLOTS = [
  { slot: 'map', label: 'Base color', color: true },
  { slot: 'normalMap', label: 'Normal' },
  { slot: 'emissiveMap', label: 'Emissive', color: true },
  { slot: 'roughnessMap', label: 'Roughness' },
  { slot: 'metalnessMap', label: 'Metalness' },
  { slot: 'aoMap', label: 'Ambient occlusion' },
  { slot: 'alphaMap', label: 'Alpha' },
];

let draco = null;
function getDraco() {
  if (!draco) {
    draco = new DRACOLoader();
    draco.setDecoderPath(new URL('../vendor/three/addons/libs/draco/gltf/', import.meta.url).href);
  }
  return draco;
}

// --- Missing-texture placeholder ------------------------------------------------------
let checkerSource = null;
function checkerTexture() {
  if (!checkerSource) {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const g = c.getContext('2d');
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      g.fillStyle = (x + y) % 2 ? '#ff00ff' : '#202020';
      g.fillRect(x, y, 1, 1);
    }
    checkerSource = new TextureSource(c);
  }
  const t = new THREE.Texture();
  t.source = checkerSource;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.userData.missing = true;
  t.version++;
  return t;
}
export const isMissingTexture = (t) => !!t?.userData?.missing;

// --- Shared texture cache ---------------------------------------------------------------
// Map<pathKey, {source, loaded, failed, waiting: Texture[]}>. Sharing a THREE.Source lets the
// renderer upload each image once even when many models (e.g. in the zoo) use it.
export function createTextureCache() { return new Map(); }

/**
 * Builds the texture-resolution context for a model.
 * @param lib  { index: TextureIndex, root, state: {overrides, remap} }
 */
export function textureContext(lib, modelPath) {
  const ov = lib.state.overrides[modelPath] || {};
  const modelDir = dirname(key(modelPath));
  // "Scope" = the top-level folder of the library the model lives in (its asset pack).
  const rootKey = key(lib.root).replace(/\/+$/, '');
  let scopeDir = modelDir;
  if (modelDir.startsWith(rootKey + '/')) {
    const first = modelDir.slice(rootKey.length + 1).split('/')[0];
    scopeDir = rootKey + '/' + first;
  }
  return {
    modelDir,
    scopeDir,
    dirs: (ov.dirs || []).map((d) => key(d).replace(/\/+$/, '')),
    remap: lib.state.remap || {},
  };
}

/**
 * Loads a model.
 * @param filePath native absolute path
 * @param opts { index, ctx, overrides, texCache, pixelated, timeoutMs }
 * @returns {Promise<{object, animations, report, dispose}>}
 */
export async function loadModel(filePath, opts) {
  const { index, ctx, overrides = {}, texCache = createTextureCache(), pixelated = false } = opts;
  const ext = extname(filePath);
  const manager = new THREE.LoadingManager();

  // Track outstanding loads so we can wait until textures have arrived.
  let pending = 0;
  let idle = [];
  const start = manager.itemStart.bind(manager);
  const end = manager.itemEnd.bind(manager);
  manager.itemStart = (u) => { pending++; start(u); };
  manager.itemEnd = (u) => {
    pending = Math.max(0, pending - 1);
    end(u);
    if (pending === 0) idle.splice(0).forEach((r) => r());
  };
  const waitIdle = () => (pending === 0 ? Promise.resolve() : new Promise((r) => idle.push(r)));

  const refs = new Map(); // lower basename -> {name, requested, path, how}
  const known = new Set(); // path keys we produced ourselves (pass through untouched)

  const resolveTex = (requestedPath, nativeOnly) => {
    const k = key(requestedPath);
    if (known.has(k)) return { path: requestedPath, how: 'known' };
    const r = index.resolve(requestedPath, ctx, nativeOnly);
    const name = basename(requestedPath);
    if (!refs.has(name.toLowerCase())) refs.set(name.toLowerCase(), { name, requested: requestedPath, path: r?.path || null, how: r?.how || 'missing' });
    if (r) known.add(key(r.path));
    return r;
  };

  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    const p = fromUrl(url);
    if (p === null || !IMAGE_EXTS.has(extname(p))) return url;
    const r = resolveTex(p, true);
    return r ? toUrl(r.path) : checkerDataUrl();
  });

  const imageLoader = new THREE.ImageLoader(manager);
  const tgaLoader = new TGALoader(manager);

  /** Loads a texture from a resolved, existing file path. */
  function loadFile(path, onLoad, onError) {
    known.add(key(path));
    if (extname(path) === '.tga') {
      return tgaLoader.load(toUrl(path), onLoad, undefined, onError);
    }
    const k = key(path);
    let entry = texCache.get(k);
    if (!entry) {
      entry = { source: new TextureSource(null), loaded: false, failed: false, waiting: [] };
      texCache.set(k, entry);
      imageLoader.load(
        toUrl(path),
        (img) => {
          entry.source.data = img;
          entry.loaded = true;
          for (const w of entry.waiting.splice(0)) { w.tex.needsUpdate = true; w.onLoad?.(w.tex); }
        },
        undefined,
        (err) => {
          entry.failed = true;
          for (const w of entry.waiting.splice(0)) { w.onError?.(err); }
        },
      );
    }
    const tex = new THREE.Texture();
    tex.source = entry.source;
    tex.userData.path = path;
    if (entry.loaded) { tex.version++; if (onLoad) queueMicrotask(() => onLoad(tex)); }
    else if (entry.failed) { return checkerTexture(); }
    else entry.waiting.push({ tex, onLoad, onError });
    return tex;
  }

  // Handler used by FBX/GLTF/MTL loaders for every image request.
  class SmartTextureLoader extends THREE.Loader {
    load(url, onLoad, onProgress, onError) {
      let full = url;
      if (!/^(data:|blob:|mfile:)/.test(url) && this.path) full = this.path + url;
      if (/^(data:|blob:)/.test(full)) return new THREE.TextureLoader(manager).load(full, onLoad, onProgress, onError);
      const p = fromUrl(full) ?? full;
      const r = resolveTex(p, false);
      if (!r) {
        const t = checkerTexture();
        t.userData.requested = basename(p);
        if (onLoad) queueMicrotask(() => onLoad(t));
        return t;
      }
      return loadFile(r.path, onLoad, onError);
    }
  }
  manager.addHandler(/\.(png|jpe?g|gif|webp|bmp|tga|psd|tiff?|dds)$/i, new SmartTextureLoader(manager));

  const url = toUrl(filePath);
  let object;
  let animations = [];

  switch (ext) {
    case '.glb':
    case '.gltf': {
      const l = new GLTFLoader(manager);
      l.setDRACOLoader(getDraco());
      l.setMeshoptDecoder(MeshoptDecoder);
      const g = await l.loadAsync(url);
      object = g.scene || g.scenes?.[0] || new THREE.Group();
      animations = g.animations || [];
      break;
    }
    case '.fbx': {
      object = await new FBXLoader(manager).loadAsync(url);
      animations = object.animations || [];
      // FBX stores UnitScaleFactor as centimetres per file unit (100 = metres). FBXLoader
      // reads it but doesn't apply it, so centimetre files came out 100x too large.
      const usf = object.userData.unitScaleFactor;
      if (typeof usf === 'number' && usf > 0 && usf !== 100) object.scale.multiplyScalar(usf / 100);
      break;
    }
    case '.obj': {
      const text = await new THREE.FileLoader(manager).loadAsync(url);
      const objLoader = new OBJLoader(manager);
      const libs = [...text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map((m) => m[1]);
      // Fall back to "<name>.mtl" next to the OBJ, which many exporters produce.
      if (!libs.length) libs.push(stem(filePath) + '.mtl');
      for (const lib of libs) {
        try {
          const mtlPath = join(dirname(filePath), basename(lib));
          if (!(await window.api.exists(mtlPath))) continue;
          const mats = await new MTLLoader(manager).loadAsync(toUrl(mtlPath));
          mats.preload();
          objLoader.setMaterials(mats);
          break;
        } catch (e) {
          console.warn('MTL load failed', lib, e);
        }
      }
      object = objLoader.parse(text);
      break;
    }
    case '.dae': {
      const c = await new ColladaLoader(manager).loadAsync(url);
      object = c.scene;
      animations = c.scene.animations || [];
      break;
    }
    case '.stl': {
      const geo = await new STLLoader(manager).loadAsync(url);
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: 0xc8c8c8, roughness: 0.6, vertexColors: !!geo.hasColors });
      object = new THREE.Mesh(geo, mat);
      break;
    }
    case '.ply': {
      const geo = await new PLYLoader(manager).loadAsync(url);
      const hasColor = !!geo.attributes.color;
      if (geo.index) {
        if (!geo.attributes.normal) geo.computeVertexNormals();
        object = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: hasColor ? 0xffffff : 0xc8c8c8, vertexColors: hasColor }));
      } else {
        object = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.01, vertexColors: hasColor, color: hasColor ? 0xffffff : 0xc8c8c8 }));
      }
      break;
    }
    case '.3ds': {
      const l = new TDSLoader(manager);
      l.setResourcePath(toUrl(dirname(filePath)) + '/');
      object = await l.loadAsync(url);
      break;
    }
    default:
      throw new Error('Unsupported format: ' + ext);
  }

  // --- Materials, auto-matching and overrides -----------------------------------------
  const materials = collectMaterials(object);
  const auto = []; // {material, slot, path}

  // Materials with no base-color texture (or a missing one): try to match by name.
  const singleMaterial = materials.length === 1;
  for (const m of materials) {
    if (!('map' in m.material)) continue;
    const cur = m.material.map;
    if (cur && !isMissingTexture(cur)) continue;
    const names = [m.material.name];
    if (cur?.userData?.requested) names.push(stem(cur.userData.requested));
    if (singleMaterial) names.push(stem(filePath));
    const hit = index.matchByName(names.filter(Boolean), 'map', ctx);
    if (hit) {
      setSlot(m.material, 'map', loadFile(hit.path), !cur);
      auto.push({ key: m.key, slot: 'map', path: hit.path });
    }
  }

  // User overrides: per-material beats "all materials".
  for (const m of materials) {
    for (const { slot } of SLOTS) {
      const p = overrides.mats?.[m.key]?.[slot] || overrides.all?.[slot];
      if (p && slot in m.material) setSlot(m.material, slot, loadFile(p), true);
    }
  }

  await Promise.race([waitIdle(), sleep(opts.timeoutMs ?? 30000)]);

  if (pixelated) applyPixelated(object);

  object.updateMatrixWorld(true);
  const stats = computeStats(object);
  const box = boundsOf(object);
  const size = box ? box.getSize(new THREE.Vector3()).toArray() : null; // metres
  const refList = [...refs.values()];
  const report = {
    refs: refList,
    missing: refList.filter((r) => !r.path).map((r) => r.name),
    auto,
    materials: materials.map((m) => ({ key: m.key, name: m.material.name, type: m.material.type })),
    animations: animations.map((a) => ({ name: a.name, duration: a.duration })),
    size,
    ...stats,
  };

  return {
    object,
    animations,
    report,
    materials,
    loadTexture: (p) => loadFile(p),
    dispose: () => disposeObject(object),
  };
}

let checkerUrl = null;
function checkerDataUrl() {
  if (!checkerUrl) {
    checkerTexture();
    checkerUrl = checkerSource.data.toDataURL('image/png');
  }
  return checkerUrl;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Unique materials in traversal order, each with a stable key (its name, or #index). */
export function collectMaterials(object) {
  const seen = new Map();
  object.traverse((o) => {
    if (!o.material) return;
    for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
      if (seen.has(mat)) continue;
      seen.set(mat, true);
    }
  });
  const list = [];
  let i = 0;
  for (const mat of seen.keys()) {
    // Different material objects sharing a name share overrides; that's intentional.
    const k = mat.name || `#${i}`;
    mat.userData.key = k;
    list.push({ key: k, material: mat });
    i++;
  }
  return list;
}

/** Assigns a texture to a material slot. `force` resets tint so the texture shows as-is. */
export function setSlot(mat, slot, tex, force) {
  if (!(slot in mat)) return false;
  if (slot === 'map' || slot === 'emissiveMap') tex.colorSpace = THREE.SRGBColorSpace;
  const prev = mat[slot];
  mat[slot] = tex;
  if (force && slot === 'map' && mat.color) mat.color.set(0xffffff);
  if (slot === 'emissiveMap' && mat.emissive && mat.emissive.getHex() === 0) mat.emissive.set(0xffffff);
  if (slot === 'alphaMap') mat.transparent = true;
  if (prev && prev !== tex) {
    tex.wrapS = prev.wrapS;
    tex.wrapT = prev.wrapT;
    tex.repeat.copy(prev.repeat);
    tex.offset.copy(prev.offset);
  } else {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  }
  mat.needsUpdate = true;
  return true;
}

export function applyPixelated(object, on = true) {
  object.traverse((o) => {
    if (!o.material) return;
    for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const { slot } of SLOTS) {
        const t = mat[slot];
        if (!t || isMissingTexture(t)) continue;
        t.magFilter = on ? THREE.NearestFilter : THREE.LinearFilter;
        t.minFilter = on ? THREE.NearestMipmapLinearFilter : THREE.LinearMipmapLinearFilter;
        t.needsUpdate = true;
      }
    }
  });
}

export function computeStats(object) {
  let tris = 0;
  let verts = 0;
  let meshes = 0;
  object.traverse((o) => {
    if (!o.isMesh && !o.isPoints) return;
    const g = o.geometry;
    if (!g?.attributes?.position) return;
    meshes++;
    verts += g.attributes.position.count;
    if (o.isMesh) tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return { tris: Math.round(tris), verts, meshes };
}

export function disposeObject(object) {
  const textures = new Set();
  object.traverse((o) => {
    o.geometry?.dispose?.();
    if (!o.material) return;
    for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const v of Object.values(mat)) if (v && v.isTexture) textures.add(v);
      mat.dispose();
    }
  });
  textures.forEach((t) => t.dispose());
  object.removeFromParent();
}

/** Bounding box that tolerates empty objects. */
export function boundsOf(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty() || !Number.isFinite(box.min.x)) return null;
  return box;
}
