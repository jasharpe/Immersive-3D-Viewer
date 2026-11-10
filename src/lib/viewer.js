// Interactive single-model inspector (orbit camera) used in the side panel.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadModel, boundsOf, applyPixelated } from './loader.js';
import { addStudioLighting, frameBox } from './stage.js';

export const BACKGROUNDS = [0x1d2027, 0x5a5f69, 0xd9dbe0];

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
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.lastTime = performance.now();
    this.current = null;
    this.mixer = null;
    this.grid = null;
    this.showGrid = true;
    this.wireframe = false;
    this.token = 0;
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
    const moved = this.controls.update();
    if (this.mixer && this.playing) { this.mixer.update(dt); this.dirty = true; }
    if (this.controls.autoRotate) this.dirty = true;
    if (moved || this.dirty) {
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
    }
  }

  /** Loads and shows a model. Resolves to the load result, or null if superseded. */
  async show(modelPath, loadOpts) {
    const token = ++this.token;
    let res;
    try {
      res = await loadModel(modelPath, loadOpts);
    } catch (e) {
      if (token === this.token) this.clear();
      throw e;
    }
    if (token !== this.token) { res.dispose(); return null; }
    this.clear();
    this.current = res;
    this.scene.add(res.object);
    if (this.wireframe) this.setWireframe(true);
    this.box = boundsOf(res.object);
    this.buildGrid();
    this.resetView();
    this.mixer = res.animations.length ? new THREE.AnimationMixer(res.object) : null;
    this.playing = false;
    this.dirty = true;
    return res;
  }

  clear() {
    if (this.current) { this.current.dispose(); this.current = null; }
    if (this.mixer) { this.mixer.stopAllAction(); this.mixer = null; }
    this.playing = false;
    this.dirty = true;
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

  resetView() {
    if (this.box) frameBox(this.camera, this.box, { controls: this.controls, margin: 1.15 });
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

  setAutoRotate(on) { this.controls.autoRotate = on; this.dirty = true; }

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
