// First-person "zoo": every model in the current view stands on a pedestal, grouped
// into rows by folder. Models are shown at their real size; +/- scales all of them.
// Walk around with WASD + mouse; click a model to copy its path.
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { loadModel, boundsOf, createTextureCache, applyPixelated } from './loader.js';
import { fmtDims } from './format.js';

const PER_ROW = 12;
const GAP_X = 1.0; // space between neighbouring pedestals
const AISLE = 4.5; // walking space between rows
const PED_H = 0.3;
const MIN_PED_R = 0.35;
// Models float this far above the pedestal so flat bases don't z-fight with its top.
const HOVER = 0.02;
const PLACEHOLDER = 0.5; // size of the stand-in box shown until a model loads
const EYE = 1.7;
const PLAYER_R = 0.35;
const SKY = 0xb9c7d6;
const SCALE_STEP = 1.25;
const SCALE_MIN = 1 / 64;
const SCALE_MAX = 64;

export class Zoo {
  /**
   * @param host     element to fill
   * @param items    [{path, name, group, rel, size?, scale?}]  size: [x, y, z] metres if already known (lays the
   *                   rows out at their final spacing before anything loads); scale: display scale (1 = real size)
   * @param options  { makeLoadOpts(path), startAt (path to spawn in front of), autoLock (skip the start menu; call from a
   *                   key/click handler so pointer lock is allowed), pixelated, onScale(item, scale), onCopy(item),
   *                   isHearted(item), onToggleHeart(item) → bool, onInspect(item), onSize(item, [x, y, z]), onExit() }
   */
  constructor(host, items, options) {
    this.host = host;
    this.items = items;
    this.opts = options;
    this.texCache = createTextureCache();
    this.exhibits = [];
    this.rows = [];
    this.keys = new Set();
    this.velocity = new THREE.Vector3();
    this.fly = true; // walking (gravity, jump) is one F away
    this.onGround = true;
    this.showLabels = true;
    this.animate = true;
    this.hovered = null;
    this.loaded = 0;
    this.disposed = false;
    this.lastTime = performance.now();

    this.buildDom();
    this.buildScene();
    this.layout();
    this.bindEvents();
    this.renderer.setAnimationLoop(() => this.tick());
    this.loadAll();
    if (options.autoLock) {
      // Hide the menu while pointer lock is pending; it comes back if the lock is refused.
      this.el.classList.add('entering');
      this.lock();
    }
  }

  // ---------------------------------------------------------------- DOM / HUD
  buildDom() {
    const el = document.createElement('div');
    el.className = 'zoo';
    el.innerHTML = `
      <canvas></canvas>
      <div class="zoo-crosshair"></div>
      <div class="zoo-top"><b>Zoo</b> · <span class="zoo-count"></span> <span class="zoo-loading"></span></div>
      <div class="zoo-help">WASD move · Shift run · Space/C up/down · F walk/fly · +/− resize model · Click copy path · H / right-click heart · E inspect · Z exit · Esc menu</div>
      <div class="zoo-hover hidden"><div class="zoo-hover-name"></div><div class="zoo-hover-path"></div><div class="zoo-hover-size"></div><div class="zoo-hover-hint">Click to copy path · H to heart · E to inspect</div></div>
      <div class="zoo-toast hidden"></div>
      <div class="zoo-menu">
        <div class="zoo-menu-card">
          <h2>Zoo</h2>
          <p class="zoo-menu-sub"></p>
          <button class="btn primary zoo-resume">Click to walk around</button>
          <div class="zoo-menu-row">
            <label><input type="checkbox" class="zoo-labels" checked> Labels</label>
            <label><input type="checkbox" class="zoo-anim" checked> Animate</label>
          </div>
          <table class="zoo-keys">
            <tr><td>W A S D</td><td>Move</td></tr>
            <tr><td>Mouse</td><td>Look</td></tr>
            <tr><td>Shift</td><td>Run</td></tr>
            <tr><td>Space / C</td><td>Fly up / down (walking: Space jumps)</td></tr>
            <tr><td>F</td><td>Switch between flying and walking</td></tr>
            <tr><td>= +</td><td>Make the model you're looking at bigger</td></tr>
            <tr><td>- _</td><td>Make it smaller</td></tr>
            <tr><td>0</td><td>Back to real size</td></tr>
            <tr><td>Click</td><td>Copy model path</td></tr>
            <tr><td>H / Right-click</td><td>Heart / un-heart model</td></tr>
            <tr><td>E</td><td>Inspect model in viewer</td></tr>
            <tr><td>Z</td><td>Exit zoo</td></tr>
            <tr><td>Esc</td><td>This menu</td></tr>
          </table>
          <button class="btn zoo-exit">Exit zoo (Z)</button>
        </div>
      </div>`;
    this.host.appendChild(el);
    this.el = el;
    this.canvas = el.querySelector('canvas');
    this.$ = (s) => el.querySelector(s);
    this.$('.zoo-count').textContent = `${this.items.length} exhibits`;
    this.$('.zoo-menu-sub').textContent = `${this.items.length} models from the current view at real size, grouped by folder.`;
    this.$('.zoo-resume').onclick = () => this.lock();
    this.$('.zoo-exit').onclick = () => this.exit();
    this.$('.zoo-labels').onchange = (e) => { this.showLabels = e.target.checked; };
    this.$('.zoo-anim').onchange = (e) => { this.animate = e.target.checked; };
  }

  toast(msg) {
    const t = this.$('.zoo-toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.add('hidden'), 1800);
  }

  // ---------------------------------------------------------------- scene
  buildScene() {
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = r;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 40, 220);
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.02, 1000);
    this.controls = new PointerLockControls(this.camera, this.canvas);
    this.controls.addEventListener('lock', () => { this.el.classList.add('locked'); this.el.classList.remove('entering'); });
    this.controls.addEventListener('change', () => { this.following = false; }); // mouse look
    this.controls.addEventListener('unlock', () => { this.el.classList.remove('locked'); this.keys.clear(); });

    scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x6b6250, 1.9));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -40;
    sc.right = sc.top = 40;
    sc.near = 1;
    sc.far = 250;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    scene.add(sun, sun.target);
    this.sun = sun;

    // Unit-radius pedestal, scaled in X/Z to fit each model's footprint.
    this.pedGeo = new THREE.CylinderGeometry(1, 1.04, PED_H, 48);
    this.pedMat = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.85 });
    this.pedHot = new THREE.MeshStandardMaterial({ color: 0xffc94d, roughness: 0.6, emissive: 0x6b4a00 });
    this.placeholderGeo = new THREE.BoxGeometry(PLACEHOLDER, PLACEHOLDER, PLACEHOLDER);
    this.placeholderMat = new THREE.MeshBasicMaterial({ color: 0x7a8aa0, wireframe: true });
    this.failedMat = new THREE.MeshBasicMaterial({ color: 0xd04545, wireframe: true });

    this.addGround();
    new ResizeObserver(() => this.resize()).observe(this.host);
    this.resize();
  }

  resize() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  addGround() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#9fa39a';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(60,60,55,0.35)';
    g.lineWidth = 3;
    g.strokeRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(60,60,55,0.12)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(128, 0); g.lineTo(128, 256); g.moveTo(0, 128); g.lineTo(256, 128); g.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const size = 4000; // effectively endless; fog hides the edge
    tex.repeat.set(size / 2, size / 2);
    tex.anisotropy = 8;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  // ---------------------------------------------------------------- layout
  layout() {
    // One or more rows per folder, folders in name order.
    const groups = new Map();
    for (const it of this.items) {
      if (!groups.has(it.group)) groups.set(it.group, []);
      groups.get(it.group).push(it);
    }
    for (const [name, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (let i = 0; i < list.length; i += PER_ROW) {
        const row = { exhibits: [], sign: i === 0 ? this.makeSign(name || '(library root)') : null, z: 0, cz: null };
        for (const item of list.slice(i, i + PER_ROW)) row.exhibits.push(this.makeExhibit(item));
        this.rows.push(row);
      }
    }
    // Spawn facing the model that was selected in the library. The layout is anchored on it
    // (see relayout), so it never moves; only the camera distance may settle once its real
    // size is known, until the visitor first moves or looks around.
    this.startEx = this.exhibits.find((ex) => ex.item.path === this.opts.startAt) || null;
    this.relayout(true);
    this.camera.position.set(3, EYE, -AISLE * 0.8);
    this.camera.lookAt(5, EYE * 0.6, 2);
    this.following = !!this.startEx;
    if (this.following) this.faceStart(1);
  }

  /**
   * Moves the camera toward the visitor's side of the start exhibit, far enough back to see it
   * whole. `k` is the fraction of the way to go (1 = jump there).
   */
  faceStart(k) {
    const ex = this.startEx;
    const g = ex.s;
    const s = ex.size || ex.hint;
    const h = s ? s.y * g : PLACEHOLDER;
    const w = s ? Math.max(s.x, s.z) * g : PLACEHOLDER;
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const midY = PED_H + HOVER + h * 0.5;
    const fit = (Math.max(h, w) * 0.65) / Math.tan(halfFov);
    // Standing eye height, clear of the pedestal (also when starting in fly mode).
    const back = Math.max(ex.tr + 1.2, fit);
    const cam = this.camera.position;
    this.lookY ??= midY;
    cam.x += (ex.tx - cam.x) * k;
    cam.y += (EYE - cam.y) * k;
    cam.z += (ex.tz - back - cam.z) * k;
    this.lookY += (midY - this.lookY) * k;
    this.camera.lookAt(ex.tx, this.lookY, ex.tz);
  }

  /** Pedestal radius that fits the model's footprint at its display scale. */
  pedRadius(ex) {
    const s = ex.size || ex.hint;
    if (!s) return MIN_PED_R + 0.1;
    const half = Math.hypot(s.x, s.z) * 0.5 * ex.s;
    return Math.max(MIN_PED_R, half * 1.05 + 0.08);
  }

  /** Computes target positions; exhibits glide there in tick() (or snap when asked). */
  relayout(snap = false) {
    let z = 0;
    let maxX = 0;
    for (const row of this.rows) {
      let depth = 0;
      for (const ex of row.exhibits) { ex.tr = this.pedRadius(ex); depth = Math.max(depth, ex.tr * 2); }
      row.z = z + depth / 2;
      let x = 0;
      for (const ex of row.exhibits) {
        ex.tx = x + ex.tr;
        ex.tz = row.z;
        x += ex.tr * 2 + GAP_X;
      }
      maxX = Math.max(maxX, x);
      z += depth + AISLE;
    }
    // Keep the anchor exhibit (the start one, then whichever was last resized) where it stands
    // and shift everything else around it, so models arriving or being resized don't slide the
    // world past the visitor.
    let dx = 0;
    let dz = 0;
    this.anchorEx ??= this.startEx;
    const a = this.anchorEx;
    if (a) {
      this.anchor ??= { x: a.tx, z: a.tz };
      dx = this.anchor.x - a.tx;
      dz = this.anchor.z - a.tz;
      for (const ex of this.exhibits) { ex.tx += dx; ex.tz += dz; }
      for (const row of this.rows) row.z += dz;
    }
    for (const row of this.rows) row.x = -1.5 + dx;
    this.bounds = { minX: -10 + dx, maxX: maxX + 10 + dx, minZ: -AISLE * 3 + dz, maxZ: z + 5 + dz };
    if (snap) {
      for (const ex of this.exhibits) { ex.cx = ex.tx; ex.cz = ex.tz; ex.r = ex.tr; ex.g = ex.s; this.place(ex); }
      for (const row of this.rows) { row.cx = row.x; row.cz = row.z; this.placeSign(row); }
    }
  }

  makeSign(text) {
    const group = new THREE.Group();
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.4, 0.12), new THREE.MeshStandardMaterial({ color: 0x4a4f57 }));
    post.position.y = 1.2;
    post.castShadow = true;
    const tex = textTexture(text, { font: 'bold 44px system-ui, sans-serif', bg: '#2b6cb0', fg: '#ffffff', pad: 22 });
    const h = 0.6;
    // Two single-sided faces back to back so the text reads correctly from either side.
    const geo = new THREE.PlaneGeometry(h * tex.userData.aspect, h);
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    const front = new THREE.Mesh(geo, mat);
    front.position.set(0, 2.3, 0.08);
    const back = new THREE.Mesh(geo, mat);
    back.rotation.y = Math.PI;
    back.position.set(0, 2.3, -0.08);
    group.add(post, front, back);
    this.scene.add(group);
    return group;
  }

  placeSign(row) {
    if (row.sign) row.sign.position.set(row.cx, 0, row.cz);
  }

  makeExhibit(item) {
    const ped = new THREE.Mesh(this.pedGeo, this.pedMat);
    ped.castShadow = ped.receiveShadow = true;
    this.scene.add(ped);

    const holder = new THREE.Group(); // scaled by the zoo scale; holds the model at real size
    this.scene.add(holder);

    const placeholder = new THREE.Mesh(this.placeholderGeo, this.placeholderMat);
    this.scene.add(placeholder);

    const label = new THREE.Sprite(new THREE.SpriteMaterial({ depthWrite: false }));
    this.scene.add(label);

    const ex = { item, ped, holder, placeholder, label, hearted: !!this.opts.isHearted?.(item), size: null, hint: item.size ? new THREE.Vector3().fromArray(item.size) : null, hitBox: new THREE.Box3(), mixer: null, result: null, cx: 0, cz: 0, tx: 0, tz: 0, r: 0, tr: 0, s: 1, g: 1 };
    ex.s = ex.g = clampScale(item.scale || 1);
    this.updateLabel(ex);
    this.exhibits.push(ex);
    return ex;
  }

  /** (Re)draws an exhibit's floating name tag; hearted models get a pink ♥ tag. */
  updateLabel(ex) {
    const old = ex.label.material.map;
    const text = ex.hearted ? '♥ ' + ex.item.name : ex.item.name;
    ex.label.material.map = textTexture(text, { font: '600 34px system-ui, sans-serif', bg: ex.hearted ? 'rgba(190,30,70,0.88)' : 'rgba(20,22,28,0.78)', fg: '#fff', pad: 14 });
    ex.label.material.needsUpdate = true;
    old?.dispose();
    const lh = 0.28;
    ex.label.scale.set(lh * ex.label.material.map.userData.aspect, lh, 1);
  }

  toggleHeart(ex) {
    const on = this.opts.onToggleHeart?.(ex.item);
    if (typeof on !== 'boolean') return;
    ex.hearted = on;
    this.updateLabel(ex);
    this.showHover(ex);
    this.toast(on ? '♥ Hearted ' + ex.item.name : 'Removed heart from ' + ex.item.name);
  }

  /** Applies an exhibit's current position/scale to its objects and hit box. */
  place(ex) {
    const { cx, cz, r, g } = ex;
    ex.ped.position.set(cx, PED_H / 2, cz);
    ex.ped.scale.set(r, 1, r);
    ex.holder.position.set(cx, PED_H + HOVER, cz);
    ex.holder.scale.setScalar(g);
    ex.placeholder.position.set(cx, PED_H + HOVER + PLACEHOLDER / 2, cz);
    const h = ex.size ? ex.size.y * g : PLACEHOLDER;
    const hx = ex.size ? Math.max(ex.size.x * g * 0.5, r) : r;
    const hz = ex.size ? Math.max(ex.size.z * g * 0.5, r) : r;
    const top = PED_H + HOVER + h;
    ex.label.position.set(cx, top + 0.3, cz);
    ex.hitBox.min.set(cx - hx, 0, cz - hz);
    ex.hitBox.max.set(cx + hx, Math.max(top, PED_H + 0.3), cz + hz);
  }

  /** Resizes one exhibit; it stays put and its neighbours make room. */
  setScale(ex, s) {
    if (!ex) { this.toast('Look at a model to resize it'); return; }
    const next = clampScale(s);
    if (next === ex.s) return;
    ex.s = next;
    this.anchorEx = ex;
    this.anchor = { x: ex.tx, z: ex.tz };
    this.relayout(false);
    this.toast(`${ex.item.name}: ${next === 1 ? 'real size' : `×${fmtScale(next)}  (0 = real size)`}`);
    this.opts.onScale?.(ex.item, next);
  }

  // ---------------------------------------------------------------- loading
  async loadAll() {
    const cam = this.camera.position;
    const order = [...this.exhibits].sort((a, b) => dist2(a.tx, a.tz, cam) - dist2(b.tx, b.tz, cam));
    let next = 0;
    const worker = async () => {
      while (!this.disposed && next < order.length) {
        const ex = order[next++];
        await this.loadExhibit(ex);
        this.loaded++;
        this.updateLoading();
      }
    };
    this.updateLoading();
    await Promise.all([worker(), worker(), worker()]);
  }

  updateLoading() {
    const n = this.exhibits.length;
    this.$('.zoo-loading').textContent = this.loaded < n ? `· loading ${this.loaded}/${n}` : '';
  }

  async loadExhibit(ex) {
    let res;
    try {
      res = await loadModel(ex.item.path, { ...this.opts.makeLoadOpts(ex.item.path), texCache: this.texCache, pixelated: this.opts.pixelated, timeoutMs: 20000 });
    } catch (e) {
      console.warn('zoo: failed to load', ex.item.path, e);
      ex.placeholder.material = this.failedMat;
      return;
    }
    if (this.disposed) { res.dispose(); return; }
    const obj = res.object;
    const box = boundsOf(obj);
    if (!box) { res.dispose(); ex.placeholder.material = this.failedMat; return; }
    const center = box.getCenter(new THREE.Vector3());
    // Centre the footprint on the pedestal with the model's lowest point at the top.
    const inner = new THREE.Group();
    obj.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
    inner.add(obj);
    // Most assets face +Z; turn them toward the visitor, who starts on the -Z side of each row.
    inner.rotation.y = Math.PI;
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = !o.isSkinnedMesh; } });
    if (this.opts.pixelated) applyPixelated(obj);

    this.scene.remove(ex.placeholder);
    ex.holder.add(inner);
    ex.result = res;
    ex.size = box.getSize(new THREE.Vector3());
    this.opts.onSize?.(ex.item, ex.size.toArray());
    if (res.animations.length) {
      ex.mixer = new THREE.AnimationMixer(obj);
      ex.mixer.clipAction(res.animations[0]).play();
    }
    // Footprints are only known once loaded, so neighbours make room as models arrive.
    this.relayout(false);
    if (this.hovered === ex) this.showHover(ex);
  }

  // ---------------------------------------------------------------- input
  bindEvents() {
    this.onKeyDown = (e) => {
      // Z leaves straight away, from the menu or while walking. Stop it reaching the library's
      // own Z handler, which would re-enter.
      if (e.code === 'KeyZ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) this.exit();
        return;
      }
      if (!this.controls.isLocked) {
        if (e.code === 'Escape' && !e.repeat) { e.preventDefault(); }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.keys.add(e.code);
      // Scale keys repeat while held.
      const ex = this.hovered;
      if (e.code === 'Equal' || e.code === 'NumpadAdd') this.setScale(ex, ex && ex.s * SCALE_STEP);
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') this.setScale(ex, ex && ex.s / SCALE_STEP);
      if (e.repeat) return;
      if (e.code === 'Digit0' || e.code === 'Numpad0') this.setScale(ex, 1);
      if (e.code === 'KeyF') { this.fly = !this.fly; this.velocity.y = 0; this.toast(this.fly ? 'Fly mode on' : 'Fly mode off'); }
      if (e.code === 'Space' && !this.fly && this.onGround) { this.velocity.y = 5.5; this.onGround = false; }
      if (e.code === 'KeyH' && this.hovered) this.toggleHeart(this.hovered);
      if (e.code === 'KeyE' && this.hovered) { const it = this.hovered.item; this.exit(); this.opts.onInspect?.(it); }
    };
    this.onKeyUp = (e) => { this.keys.delete(e.code); };
    this.onMouseDown = (e) => {
      if (!this.controls.isLocked) return;
      if (e.button === 2) { if (this.hovered) this.toggleHeart(this.hovered); return; }
      if (e.button !== 0) return;
      if (this.hovered) {
        this.opts.onCopy?.(this.hovered.item);
        this.toast('Copied: ' + this.hovered.item.name);
        this.flash = 0.25;
      }
    };
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('keyup', this.onKeyUp, true);
    document.addEventListener('mousedown', this.onMouseDown, true);
    this.onContextMenu = (e) => e.preventDefault();
    this.el.addEventListener('contextmenu', this.onContextMenu);
  }

  lock() {
    try {
      const p = this.canvas.requestPointerLock();
      // Refused (e.g. re-lock too soon after Esc, or no user gesture): show the menu so the
      // user can click to start.
      if (p && p.catch) p.catch(() => this.el.classList.remove('entering'));
    } catch { this.el.classList.remove('entering'); }
  }

  // ---------------------------------------------------------------- frame
  tick() {
    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.05);
    this.lastTime = now;
    if (this.controls.isLocked) this.move(dt);

    // Glide exhibits and signs toward their layout targets.
    const k = 1 - Math.exp(-dt * 10);
    for (const ex of this.exhibits) {
      if (Math.abs(ex.tx - ex.cx) + Math.abs(ex.tz - ex.cz) + Math.abs(ex.tr - ex.r) + Math.abs(ex.s - ex.g) < 1e-4) continue;
      ex.cx += (ex.tx - ex.cx) * k;
      ex.cz += (ex.tz - ex.cz) * k;
      ex.r += (ex.tr - ex.r) * k;
      ex.g += (ex.s - ex.g) * k;
      if (Math.abs(ex.s - ex.g) < 1e-4 * ex.s) ex.g = ex.s;
      this.place(ex);
    }
    for (const row of this.rows) {
      if (Math.abs(row.z - row.cz) + Math.abs(row.x - row.cx) < 1e-4) continue;
      row.cx += (row.x - row.cx) * k;
      row.cz += (row.z - row.cz) * k;
      this.placeSign(row);
    }

    if (this.following) this.faceStart(k);
    this.updateHover();

    const cam = this.camera.position;
    this.sun.position.set(cam.x + 30, 80, cam.z + 20);
    this.sun.target.position.set(cam.x, 0, cam.z);

    for (const ex of this.exhibits) {
      const d = ex.hitBox.distanceToPoint(cam);
      ex.label.visible = this.showLabels && (d < 12 || ex === this.hovered);
      if (ex.mixer && this.animate && d < 60) ex.mixer.update(dt);
      if (!ex.result) ex.placeholder.rotation.y += dt * 0.6;
    }
    if (this.flash > 0) this.flash -= dt;
    this.$('.zoo-crosshair').classList.toggle('flash', this.flash > 0);
    this.renderer.render(this.scene, this.camera);
  }

  move(dt) {
    const k = this.keys;
    const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 11 : 5) * (this.fly ? 1.6 : 1);
    // WASD always moves horizontally (also in fly mode, where Space/C handle height).
    // Use the camera's yaw so looking straight up or down doesn't stall movement.
    const yaw = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ').y;
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const wish = new THREE.Vector3();
    if (k.has('KeyW') || k.has('ArrowUp')) wish.add(fwd);
    if (k.has('KeyS') || k.has('ArrowDown')) wish.sub(fwd);
    if (k.has('KeyD') || k.has('ArrowRight')) wish.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) wish.sub(right);
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
    if (wish.lengthSq() > 0 || k.has('Space') || k.has('KeyC')) this.following = false;

    const p = this.camera.position;
    if (this.fly) {
      if (k.has('Space')) wish.y += speed;
      if (k.has('KeyC') || k.has('ControlLeft')) wish.y -= speed;
      p.addScaledVector(wish, dt);
      p.y = Math.max(p.y, 0.3);
      return;
    }

    p.x += wish.x * dt;
    p.z += wish.z * dt;
    this.velocity.y -= 18 * dt;
    p.y += this.velocity.y * dt;
    if (p.y <= EYE) { p.y = EYE; this.velocity.y = 0; this.onGround = true; }

    // Pedestal collisions (circles).
    if (p.y - EYE < PED_H) {
      for (const ex of this.exhibits) {
        const minD = ex.r + PLAYER_R;
        const dx = p.x - ex.cx;
        const dz = p.z - ex.cz;
        const d2 = dx * dx + dz * dz;
        if (d2 < minD * minD) {
          const d = Math.sqrt(d2) || 1e-4;
          p.x = ex.cx + (dx / d) * minD;
          p.z = ex.cz + (dz / d) * minD;
        }
      }
    }
    const b = this.bounds;
    p.x = THREE.MathUtils.clamp(p.x, b.minX - 30, b.maxX + 30);
    p.z = THREE.MathUtils.clamp(p.z, b.minZ - 30, b.maxZ + 30);
  }

  updateHover() {
    const ray = new THREE.Ray();
    ray.origin.copy(this.camera.position);
    this.camera.getWorldDirection(ray.direction);
    const hit = new THREE.Vector3();
    let best = null;
    let bestD = 80;
    for (const ex of this.exhibits) {
      if (ex.hitBox.distanceToPoint(ray.origin) > bestD) continue;
      if (ray.intersectBox(ex.hitBox, hit)) {
        const d = hit.distanceTo(ray.origin);
        if (d < bestD) { bestD = d; best = ex; }
      }
    }
    if (best === this.hovered) return;
    if (this.hovered) this.hovered.ped.material = this.pedMat;
    this.hovered = best;
    if (best) {
      best.ped.material = this.pedHot;
      this.showHover(best);
    } else {
      this.$('.zoo-hover').classList.add('hidden');
    }
  }

  showHover(ex) {
    this.$('.zoo-hover-name').textContent = (ex.hearted ? '♥ ' : '') + ex.item.name;
    this.$('.zoo-hover-name').classList.toggle('hearted', ex.hearted);
    this.$('.zoo-hover-path').textContent = ex.item.rel;
    this.$('.zoo-hover-size').textContent = ex.size ? fmtDims(ex.size.toArray()) + (ex.s === 1 ? '' : ` (shown ×${fmtScale(ex.s)})`) : '';
    this.$('.zoo-hover').classList.remove('hidden');
  }

  // ---------------------------------------------------------------- teardown
  exit() {
    if (this.disposed) return;
    this.disposed = true;
    if (document.pointerLockElement) document.exitPointerLock();
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('keyup', this.onKeyUp, true);
    document.removeEventListener('mousedown', this.onMouseDown, true);
    this.controls.disconnect();
    this.renderer.setAnimationLoop(null);
    for (const ex of this.exhibits) ex.result?.dispose();
    this.scene.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) for (const m of [].concat(o.material)) { m.map?.dispose(); m.dispose(); }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.el.remove();
    this.opts.onExit?.();
  }
}

function clampScale(s) {
  // Snap back to exactly 1 when stepping returns to real size.
  if (Math.abs(Math.log(s)) < 1e-6) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, s));
}

function fmtScale(s) {
  return s >= 10 ? s.toFixed(0) : s >= 1 ? s.toFixed(2).replace(/\.?0+$/, '') : s.toPrecision(2);
}

function dist2(x, z, p) {
  const dx = x - p.x;
  const dz = z - p.z;
  return dx * dx + dz * dz;
}

function textTexture(text, { font, bg, fg, pad }) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = font;
  const label = text.length > 48 ? text.slice(0, 46) + '…' : text;
  const w = Math.ceil(g.measureText(label).width) + pad * 2;
  const h = parseInt(font.match(/(\d+)px/)[1], 10) + pad * 2;
  c.width = w;
  c.height = h;
  g.font = font;
  g.fillStyle = bg;
  roundRect(g, 0, 0, w, h, Math.min(16, h / 3));
  g.fill();
  g.fillStyle = fg;
  g.textBaseline = 'middle';
  g.fillText(label, pad, h / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.userData.aspect = w / h;
  return tex;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
