// Interactive single-model inspector (orbit camera) used in the side panel.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadModel, boundsOf, applyPixelated } from './loader.js';
import { addStudioLighting, frameBox } from './stage.js';

export const BACKGROUNDS = [0x1d2027, 0x5a5f69, 0xd9dbe0];
const CACHE_MAX = 10; // loaded models kept in memory (current + neighbours + recent)

export class Viewer {
  constructor(container) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    container.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.bgIndex = 0;
    this.renderer.setClearColor(BACKGROUNDS[0]);
    this.scene = new THREE.Scene();
    addStudioLighting(this.scene, this.renderer);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.camera.position.set(2, 2, 3);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.autoRotateSpeed = 0.8; // ~75 s per revolution: a gentle idle orbit
    this.autoRotateDefault = true;
    this.userMoved = false;
    // Callbacks set by the app: onViewChange(path, view | null) when the user moves the camera
    // (null = forget the saved view), onAutoRotateChange(on) to keep the toolbar in sync.
    this.onViewChange = null;
    this.onAutoRotateChange = null;
    // Any manual orbit/zoom/pan cancels the idle rotation and makes the view "the user's".
    this.controls.addEventListener('start', () => {
      this.userMoved = true;
      this.setAutoRotate(false);
    });
    this.controls.addEventListener('change', () => {
      this.dirty = true;
      if (this.userMoved && this.current) this.onViewChange?.(this.currentPath, this.getView());
    });
    this.lastTime = performance.now();
    this.current = null;
    this.mixer = null;
    this.grid = null;
    this.showGrid = true;
    this.wireframe = false;
    this.token = 0;
    this.preloadToken = 0;
    this.cache = new Map(); // path -> { promise, res, used, evicted }
    this.wanted = new Set();
    this.target = null;
    this.dirty = true;

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  tick() {
    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    const moved = this.controls.update(dt);
    if (this.mixer && this.playing) { this.mixer.update(dt); this.dirty = true; }
    if (this.controls.autoRotate) this.dirty = true;
    if (moved || this.dirty) {
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
    }
  }

  // ------------------------------------------------------------------ model cache
  // Loaded models are kept in a small LRU cache so that stepping through the library
  // (and stepping back) is instant. Neighbours are loaded ahead of time with preload().

  /** Returns the cache entry for a path, starting its load if needed. */
  entry(path, loadOpts) {
    let e = this.cache.get(path);
    if (!e) {
      e = { res: null, used: 0, evicted: false };
      e.promise = loadModel(path, loadOpts).then((res) => {
        if (e.evicted) { res.dispose(); throw new Error('Model was evicted from the cache'); }
        e.res = res;
        this.warm(res);
        return res;
      });
      e.promise.catch(() => { if (this.cache.get(path) === e) this.cache.delete(path); });
      this.cache.set(path, e);
    }
    e.used = performance.now();
    this.trim();
    return e;
  }

  /** Uploads shaders and textures ahead of time so the first frame doesn't hitch. */
  warm(res) {
    try {
      this.renderer.compile(res.object, this.camera, this.scene);
      res.object.traverse((o) => {
        if (!o.material) return;
        for (const m of [].concat(o.material)) {
          for (const v of Object.values(m)) {
            if (v?.isTexture && v.image && v.image.complete !== false) this.renderer.initTexture(v);
          }
        }
      });
    } catch (err) {
      console.warn('viewer: warm-up failed', err);
    }
  }

  /** Evicts least-recently-used models beyond CACHE_MAX, keeping the shown and wanted ones. */
  trim() {
    while (this.cache.size > CACHE_MAX) {
      let victim = null;
      for (const [path, e] of this.cache) {
        if (path === this.target || this.wanted.has(path) || (e.res && e.res === this.current)) continue;
        if (!victim || e.used < victim[1].used) victim = [path, e];
      }
      if (!victim) return;
      this.cache.delete(victim[0]);
      victim[1].evicted = true;
      victim[1].res?.dispose();
    }
  }

  /** Loads models in the background, one at a time, in the given order. */
  async preload(paths, optsFor) {
    const token = ++this.preloadToken;
    this.wanted = new Set(paths);
    for (const p of paths) {
      if (token !== this.preloadToken) return;
      if (this.cache.has(p)) { this.cache.get(p).used = performance.now(); continue; }
      await this.entry(p, optsFor(p)).promise.catch(() => {});
    }
  }

  /** True when the model is loaded and can be shown without waiting. */
  isReady(path) { return !!this.cache.get(path)?.res; }

  /** Drops every cached model (e.g. after textures change). The shown one stays until replaced. */
  invalidateCache() {
    for (const e of this.cache.values()) {
      e.evicted = true;
      if (e.res && e.res === this.current) e.res.orphan = true;
      else e.res?.dispose();
    }
    this.cache.clear();
  }

  /** Shows a model (from the cache when possible). Resolves to the load result, or null if superseded. */
  /**
   * @param view optional saved camera view ({ position, target }) to restore; without one the
   *             model is framed and the idle rotation starts (if enabled).
   */
  async show(modelPath, loadOpts, view = null) {
    const token = ++this.token;
    this.target = modelPath;
    let res;
    try {
      res = await this.entry(modelPath, loadOpts).promise;
    } catch (e) {
      if (token === this.token) this.detach();
      throw e;
    }
    if (token !== this.token) return null;
    this.detach();
    this.userMoved = false; // framing the new model isn't a user move
    this.current = res;
    this.currentPath = modelPath;
    this.scene.add(res.object);
    this.setWireframe(this.wireframe);
    applyPixelated(res.object, !!loadOpts.pixelated);
    this.box = boundsOf(res.object);
    this.buildGrid();
    this.frame();
    if (view?.position && view?.target) {
      this.setView(view);
      this.userMoved = !view.autoRotate;
      this.setAutoRotate(!!view.autoRotate);
    } else {
      this.userMoved = false;
      this.setAutoRotate(this.autoRotateDefault);
    }
    this.mixer = res.animations.length ? new THREE.AnimationMixer(res.object) : null;
    this.playing = false;
    this.dirty = true;
    return res;
  }

  /** Takes the current model out of the scene; it stays cached unless it was orphaned. */
  detach() {
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
      this.current?.object.traverse((o) => o.isSkinnedMesh && o.pose());
    }
    if (this.current) {
      this.scene.remove(this.current.object);
      if (this.current.orphan) this.current.dispose();
      this.current = null;
    }
    this.playing = false;
    this.dirty = true;
  }

  /** Empties the viewer and the cache (e.g. when another library is opened). */
  clear() {
    this.token++;
    this.preloadToken++;
    this.target = null;
    this.wanted = new Set();
    this.detach();
    this.invalidateCache();
  }

  buildGrid() {
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose(); this.grid = null; }
    if (!this.box) return;
    const size = this.box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z, size.y * 0.5) * 2.5 || 1;
    const step = Math.pow(10, Math.floor(Math.log10(span / 10)));
    const divisions = Math.min(200, Math.round(span / step));
    this.grid = new THREE.GridHelper(divisions * step, divisions, 0x666b78, 0x3a3e48);
    const c = this.box.getCenter(new THREE.Vector3());
    this.grid.position.set(c.x, this.box.min.y, c.z);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.6;
    this.grid.visible = this.showGrid;
    this.scene.add(this.grid);
  }

  /** Frames the model from the default angle. */
  frame() {
    this.stopInertia();
    if (this.box) frameBox(this.camera, this.box, { controls: this.controls, margin: 1.15 });
    this.dirty = true;
  }

  /** Reset button: default framing, forget the saved view, resume the idle rotation. */
  resetView() {
    this.frame();
    this.userMoved = false;
    this.setAutoRotate(this.autoRotateDefault);
    if (this.current) this.onViewChange?.(this.currentPath, null);
    this.dirty = true;
  }

  setGrid(on) { this.showGrid = on; if (this.grid) this.grid.visible = on; this.dirty = true; }

  setWireframe(on) {
    this.wireframe = on;
    this.current?.object.traverse((o) => {
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.wireframe = on;
    });
    this.dirty = true;
  }

  cycleBackground() {
    this.bgIndex = (this.bgIndex + 1) % BACKGROUNDS.length;
    this.renderer.setClearColor(BACKGROUNDS[this.bgIndex]);
    this.dirty = true;
  }

  setAutoRotate(on) {
    const changed = this.controls.autoRotate !== on;
    this.controls.autoRotate = on;
    this.dirty = true;
    if (changed) this.onAutoRotateChange?.(on);
  }

  /** Toolbar toggle: sets the default for every model and applies it to this one. */
  setAutoRotateDefault(on) {
    this.autoRotateDefault = on;
    if (on) {
      // Rotating again means the user's saved angle no longer applies to this model.
      this.userMoved = false;
      if (this.current) this.onViewChange?.(this.currentPath, null);
    }
    this.setAutoRotate(on);
  }

  /** Drops leftover drag momentum so it doesn't carry over to another model or view. */
  stopInertia() {
    // OrbitControls clears its pending deltas when update() runs without damping.
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
  }

  getView() {
    return { position: this.camera.position.toArray(), target: this.controls.target.toArray() };
  }

  setView(view) {
    this.stopInertia();
    this.camera.position.fromArray(view.position);
    this.controls.target.fromArray(view.target);
    this.controls.update();
    this.dirty = true;
  }

  setPixelated(on) { if (this.current) applyPixelated(this.current.object, on); this.dirty = true; }

  /** Plays animation clip `i`, or stops when i < 0. */
  playClip(i) {
    if (!this.mixer) return;
    this.mixer.stopAllAction();
    this.playing = i >= 0;
    if (this.playing) this.mixer.clipAction(this.current.animations[i]).reset().play();
    else this.current.object.traverse((o) => o.isSkinnedMesh && o.pose());
    this.dirty = true;
  }

  invalidate() { this.dirty = true; }
}
