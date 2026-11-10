// Renders model thumbnails with a single, reused offscreen WebGL context.
import * as THREE from 'three';
import { loadModel, boundsOf } from './loader.js';
import { addStudioLighting, frameBox } from './stage.js';

export class Thumbnailer {
  constructor(size = 256) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = size;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(size, size, false);
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    addStudioLighting(this.scene, this.renderer);
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
  }

  /** @returns {Promise<{blob: Blob|null, report}>} */
  async render(modelPath, loadOpts) {
    const res = await loadModel(modelPath, { ...loadOpts, timeoutMs: 15000 });
    try {
      this.scene.add(res.object);
      const box = boundsOf(res.object);
      if (!box) return { blob: null, report: { ...res.report, empty: true } };
      frameBox(this.camera, box);
      this.renderer.render(this.scene, this.camera);
      const blob = await new Promise((r) => this.canvas.toBlob(r, 'image/png'));
      return { blob, report: res.report };
    } finally {
      res.dispose();
    }
  }
}
