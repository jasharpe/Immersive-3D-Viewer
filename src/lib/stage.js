// Shared rendering helpers: lighting rig and camera framing.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * Neutral "studio" lighting that works for both PBR (glTF) and Phong/Lambert (FBX/OBJ)
 * materials. Phong ignores scene.environment, so we also add real lights.
 */
export function addStudioLighting(scene, renderer, { envIntensity = 0.6 } = {}) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = env;
  scene.environmentIntensity = envIntensity;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a96, 1.6);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(3, 6, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.6);
  rim.position.set(-4, 2, -3);
  scene.add(rim);
  return { env, hemi, key, rim };
}

/** Points the camera at a box from direction `dir`, fitting it in view. */
export function frameBox(camera, box, { dir = new THREE.Vector3(1, 0.65, 1.35), margin = 1.08, controls = null } = {}) {
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 1e-4);
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dist = (r / Math.sin(Math.min(vFov, hFov) / 2)) * margin;
  camera.position.copy(sphere.center).addScaledVector(dir.clone().normalize(), dist);
  camera.near = Math.max(dist / 1000, 1e-4);
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(sphere.center);
  if (controls) {
    controls.target.copy(sphere.center);
    controls.minDistance = r * 0.05;
    controls.maxDistance = dist * 20;
    controls.update();
  }
  return { center: sphere.center, radius: r, dist };
}
