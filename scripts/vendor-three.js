// Copies the parts of Three.js the renderer imports into src/vendor/three.
// Why: electron-builder always strips `node_modules/*/examples`, which is where
// Three's loaders and controls live, so packaged apps can't import them from
// node_modules. Runs automatically after `npm install` (postinstall).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', 'three');
const dest = path.join(root, 'src', 'vendor', 'three');

if (!fs.existsSync(src)) {
  console.error('vendor-three: node_modules/three not found — run `npm install` first.');
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(path.join(dest, 'build'), { recursive: true });
for (const f of ['three.module.js', 'three.core.js']) {
  fs.copyFileSync(path.join(src, 'build', f), path.join(dest, 'build', f));
}
fs.cpSync(path.join(src, 'examples', 'jsm'), path.join(dest, 'addons'), { recursive: true });
fs.copyFileSync(path.join(src, 'LICENSE'), path.join(dest, 'LICENSE'));
const version = require(path.join(src, 'package.json')).version;
fs.writeFileSync(path.join(dest, 'VERSION'), version + '\n');
console.log(`vendor-three: copied three@${version} to src/vendor/three`);
