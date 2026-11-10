// First-person "zoo": every model in the current view stands on a pedestal, grouped
// into rows by folder. Walk around with WASD + mouse; click a model to copy its path.
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { loadModel, boundsOf, createTextureCache, applyPixelated } from './loader.js';

const CELL = 4.5; // spacing between exhibits along a row
const ROW_GAP = 8; // spacing between rows
const PER_ROW = 12;
const TARGET = 2.0; // normalised exhibit size (largest dimension, metres)
const PED_R = 1.3;
const PED_H = 0.3;
const EYE = 1.7;
const PLAYER_R = 0.35;
const SKY = 0xb9c7d6;

export class Zoo {
  /**
   * @param host     element to fill
   * @param items    [{path, name, group, rel}]
   * @param options  { makeLoadOpts(path), pixelated, onCopy(item), onInspect(item), onExit() }
   */
  constructor(host, items, options) {
    this.host = host;
    this.items = items;
    this.opts = options;
    this.texCache = createTextureCache();
    this.exhibits = [];
    this.keys = new Set();
    this.velocity = new THREE.Vector3();
    this.fly = false;
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
  }

  // ---------------------------------------------------------------- DOM / HUD
  buildDom() {
    const el = document.createElement('div');
    el.className = 'zoo';
    el.innerHTML = `
      <canvas></canvas>
      <div class="zoo-crosshair"></div>
      <div class="zoo-top"><b>Zoo</b> · <span class="zoo-count"></span> <span class="zoo-loading"></span></div>
      <div class="zoo-help">WASD move · Shift run · Space jump · F fly (Space/C up/down) · Click copy path · E inspect · Esc menu</div>
      <div class="zoo-hover hidden"><div class="zoo-hover-name"></div><div class="zoo-hover-path"></div><div class="zoo-hover-hint">Click to copy path · E to inspect</div></div>
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
            <tr><td>Space</td><td>Jump (fly: up)</td></tr>
            <tr><td>F</td><td>Toggle fly / noclip</td></tr>
            <tr><td>C</td><td>Fly down</td></tr>
            <tr><td>Click</td><td>Copy model path</td></tr>
            <tr><td>E</td><td>Inspect model in viewer</td></tr>
            <tr><td>Esc</td><td>This menu</td></tr>
          </table>
          <button class="btn zoo-exit">Exit zoo</button>
        </div>
      </div>`;
    this.host.appendChild(el);
    this.el = el;
    this.canvas = el.querySelector('canvas');
    this.$ = (s) => el.querySelector(s);
    this.$('.zoo-count').textContent = `${this.items.length} exhibits`;
    this.$('.zoo-menu-sub').textContent = `${this.items.length} models from the current view, grouped by folder.`;
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
    scene.fog = new THREE.Fog(SKY, 35, 140);
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 500);
    this.controls = new PointerLockControls(this.camera, this.canvas);
    this.controls.addEventListener('lock', () => this.el.classList.add('locked'));
    this.controls.addEventListener('unlock', () => { this.el.classList.remove('locked'); this.keys.clear(); });

    scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x6b6250, 1.9));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -28;
    sc.right = sc.top = 28;
    sc.near = 1;
    sc.far = 120;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    scene.add(sun, sun.target);
    this.sun = sun;

    this.pedGeo = new THREE.CylinderGeometry(PED_R, PED_R + 0.1, PED_H, 40);
    this.pedMat = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.85 });
    this.pedHot = new THREE.MeshStandardMaterial({ color: 0xffc94d, roughness: 0.6, emissive: 0x6b4a00 });
    this.placeholderGeo = new THREE.BoxGeometry(1, 1, 1);
    this.placeholderMat = new THREE.MeshBasicMaterial({ color: 0x7a8aa0, wireframe: true });
    this.failedMat = new THREE.MeshBasicMaterial({ color: 0xd04545, wireframe: true });

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

  layout() {
    // Group by folder, keep order stable.
    const groups = new Map();
    for (const it of this.items) {
      if (!groups.has(it.group)) groups.set(it.group, []);
      groups.get(it.group).push(it);
    }
    let row = 0;
    let maxX = 0;
    for (const [name, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      this.addSign(name || '(library root)', -CELL * 0.9, row * ROW_GAP);
      list.forEach((item, i) => {
        if (i > 0 && i % PER_ROW === 0) row++;
        const x = (i % PER_ROW) * CELL + CELL * 0.6;
        const z = row * ROW_GAP;
        maxX = Math.max(maxX, x);
        this.addExhibit(item, x, z);
      });
      row++;
    }
    const depth = Math.max(row, 1) * ROW_GAP;
    this.bounds = { minX: -CELL * 3, maxX: maxX + CELL * 2, minZ: -ROW_GAP, maxZ: depth };
    this.addGround();

    this.camera.position.set(CELL * 1.5, EYE, -ROW_GAP * 0.9);
    this.camera.lookAt(CELL * 2.2, EYE * 0.8, 0);
  }

  addGround() {
    const b = this.bounds;
    const w = b.maxX - b.minX + 80;
    const d = b.maxZ - b.minZ + 80;
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
    tex.repeat.set(w / 2, d / 2);
    tex.anisotropy = 8;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  addSign(text, x, z) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.4, 0.12), new THREE.MeshStandardMaterial({ color: 0x4a4f57 }));
    post.position.set(x, 1.2, z);
    post.castShadow = true;
    this.scene.add(post);
    const tex = textTexture(text, { font: 'bold 44px system-ui, sans-serif', bg: '#2b6cb0', fg: '#ffffff', pad: 22 });
    const h = 0.6;
    // Two single-sided faces back to back so the text reads correctly from either side.
    const geo = new THREE.PlaneGeometry(h * tex.userData.aspect, h);
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    const front = new THREE.Mesh(geo, mat);
    front.position.set(x, 2.3, z + 0.08);
    const back = new THREE.Mesh(geo, mat);
    back.rotation.y = Math.PI;
    back.position.set(x, 2.3, z - 0.08);
    this.scene.add(front, back);
  }

  addExhibit(item, x, z) {
    const ped = new THREE.Mesh(this.pedGeo, this.pedMat);
    ped.position.set(x, PED_H / 2, z);
    ped.castShadow = ped.receiveShadow = true;
    this.scene.add(ped);

    const holder = new THREE.Group();
    holder.position.set(x, PED_H, z);
    this.scene.add(holder);

    const ph = new THREE.Mesh(this.placeholderGeo, this.placeholderMat);
    ph.position.y = 0.5;
    holder.add(ph);

    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture(item.name, { font: '600 34px system-ui, sans-serif', bg: 'rgba(20,22,28,0.78)', fg: '#fff', pad: 14 }), depthWrite: false }));
    const lh = 0.28;
    label.scale.set(lh * label.material.map.userData.aspect, lh, 1);
    label.position.set(x, PED_H + 1.4, z);
    this.scene.add(label);

    const hitBox = new THREE.Box3(new THREE.Vector3(x - PED_R, 0, z - PED_R), new THREE.Vector3(x + PED_R, PED_H + 1.1, z + PED_R));
    this.exhibits.push({ item, x, z, ped, holder, placeholder: ph, label, hitBox, mixer: null, result: null });
  }

  // ---------------------------------------------------------------- loading
  async loadAll() {
    const order = [...this.exhibits].sort((a, b) => dist2(a, this.camera.position) - dist2(b, this.camera.position));
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
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = TARGET / Math.max(size.x, size.y, size.z, 1e-6);
    const inner = new THREE.Group();
    obj.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
    inner.add(obj);
    inner.scale.setScalar(scale);
    // Most assets face +Z; turn them toward the visitor, who starts on the -Z side of each row.
    inner.rotation.y = Math.PI;
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = !o.isSkinnedMesh; } });
    if (this.opts.pixelated) applyPixelated(obj);

    ex.holder.remove(ex.placeholder);
    ex.holder.add(inner);
    ex.result = res;
    if (res.animations.length) {
      ex.mixer = new THREE.AnimationMixer(obj);
      ex.mixer.clipAction(res.animations[0]).play();
    }
    const h = size.y * scale;
    ex.label.position.y = PED_H + h + 0.35;
    ex.hitBox.max.y = Math.max(ex.hitBox.max.y, PED_H + h + 0.1);
    const halfW = Math.max(size.x, size.z) * scale * 0.5;
    ex.hitBox.min.x = Math.min(ex.hitBox.min.x, ex.x - halfW);
    ex.hitBox.max.x = Math.max(ex.hitBox.max.x, ex.x + halfW);
    ex.hitBox.min.z = Math.min(ex.hitBox.min.z, ex.z - halfW);
    ex.hitBox.max.z = Math.max(ex.hitBox.max.z, ex.z + halfW);
  }

  // ---------------------------------------------------------------- input
  bindEvents() {
    this.onKeyDown = (e) => {
      if (!this.controls.isLocked) {
        if (e.code === 'Escape' && !e.repeat) { e.preventDefault(); }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.keys.add(e.code);
      if (e.repeat) return;
      if (e.code === 'KeyF') { this.fly = !this.fly; this.velocity.y = 0; this.toast(this.fly ? 'Fly mode on' : 'Fly mode off'); }
      if (e.code === 'Space' && !this.fly && this.onGround) { this.velocity.y = 5.5; this.onGround = false; }
      if (e.code === 'KeyE' && this.hovered) { const it = this.hovered.item; this.exit(); this.opts.onInspect?.(it); }
    };
    this.onKeyUp = (e) => { this.keys.delete(e.code); };
    this.onMouseDown = (e) => {
      if (!this.controls.isLocked || e.button !== 0) return;
      if (this.hovered) {
        this.opts.onCopy?.(this.hovered.item);
        this.toast('Copied: ' + this.hovered.item.name);
        this.flash = 0.25;
      }
    };
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('keyup', this.onKeyUp, true);
    document.addEventListener('mousedown', this.onMouseDown, true);
  }

  lock() {
    try {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => { /* re-lock too soon after Esc; user can click again */ });
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- frame
  tick() {
    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.05);
    this.lastTime = now;
    if (this.controls.isLocked) this.move(dt);
    this.updateHover();

    const cam = this.camera.position;
    this.sun.position.set(cam.x + 20, 40, cam.z + 15);
    this.sun.target.position.set(cam.x, 0, cam.z);

    const near2 = 16 * 16;
    for (const ex of this.exhibits) {
      const d2 = dist2(ex, cam);
      ex.label.visible = this.showLabels && (d2 < near2 || ex === this.hovered);
      if (ex.mixer && this.animate && d2 < 40 * 40) ex.mixer.update(dt);
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
    const minD = PED_R + 0.1 + PLAYER_R;
    for (const ex of this.exhibits) {
      const dx = p.x - ex.x;
      const dz = p.z - ex.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD * minD && p.y - EYE < PED_H) {
        const d = Math.sqrt(d2) || 1e-4;
        p.x = ex.x + (dx / d) * minD;
        p.z = ex.z + (dz / d) * minD;
      }
    }
    const b = this.bounds;
    p.x = THREE.MathUtils.clamp(p.x, b.minX - 20, b.maxX + 20);
    p.z = THREE.MathUtils.clamp(p.z, b.minZ - 20, b.maxZ + 20);
  }

  updateHover() {
    const ray = new THREE.Ray();
    ray.origin.copy(this.camera.position);
    this.camera.getWorldDirection(ray.direction);
    const hit = new THREE.Vector3();
    let best = null;
    let bestD = 30;
    for (const ex of this.exhibits) {
      if (dist2(ex, ray.origin) > 40 * 40) continue;
      if (ray.intersectBox(ex.hitBox, hit)) {
        const d = hit.distanceTo(ray.origin);
        if (d < bestD) { bestD = d; best = ex; }
      }
    }
    if (best === this.hovered) return;
    if (this.hovered) this.hovered.ped.material = this.pedMat;
    this.hovered = best;
    const box = this.$('.zoo-hover');
    if (best) {
      best.ped.material = this.pedHot;
      this.$('.zoo-hover-name').textContent = best.item.name;
      this.$('.zoo-hover-path').textContent = best.item.rel;
      box.classList.remove('hidden');
    } else {
      box.classList.add('hidden');
    }
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

function dist2(ex, p) {
  const dx = ex.x - p.x;
  const dz = ex.z - p.z;
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
