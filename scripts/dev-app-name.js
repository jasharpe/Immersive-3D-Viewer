// macOS only: when running from source (`npm start`), the Dock and menu bar show the name of
// the Electron.app bundle inside node_modules ("Electron"). Rename that bundle's display
// name so development runs show "Immersive 3D Viewer". Packaged builds are named by
// electron-builder and don't need this. Runs automatically after `npm install`.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') process.exit(0);

const NAME = require('../package.json').productName;
const app = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app');
const plist = path.join(app, 'Contents', 'Info.plist');
if (!fs.existsSync(plist)) {
  console.log('dev-app-name: Electron.app not found, skipping');
  process.exit(0);
}

for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  execFileSync('plutil', ['-replace', key, '-string', NAME, plist]);
}
// Ask Launch Services to re-read the bundle so the Dock picks up the new name.
const now = new Date();
fs.utimesSync(app, now, now);
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
try { execFileSync(lsregister, ['-f', app]); } catch { /* not fatal */ }
console.log(`dev-app-name: development app bundle renamed to "${NAME}"`);
