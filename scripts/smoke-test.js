// Smoke test: launches the app against a folder of models, lets thumbnails
// generate, opens the first model in the inspector, enters the zoo, saves
// screenshots and prints a JSON summary. Exit code 1 if anything failed.
//
//   npm run smoke -- /path/to/models [seconds]
//   npm run smoke -- /path/to/models 20 --packaged   (test the build in dist/)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const seconds = parseInt(args.find((a) => /^\d+$/.test(a)) || '15', 10);
const packaged = args.includes('--packaged');
if (!folder) {
  console.error('usage: npm run smoke -- <folder-with-models> [seconds] [--packaged]');
  process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'i3dv-smoke-'));
const shots = path.join(work, 'screenshots');
fs.mkdirSync(shots);
const script = path.join(work, 'test.js');
fs.writeFileSync(script, `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
while (!window.app) await sleep(100);
await app.openLibrary(${JSON.stringify(path.resolve(folder))});
const S = app.S;
await sleep(${seconds * 1000});
await api.capture(${JSON.stringify(path.join(shots, '1-library.png'))});
const first = S.entries[0]?.model.path;
let inspectorError = null;
if (first) { try { await app.openInspector(first); } catch (e) { inspectorError = String(e); } }
await sleep(1500);
await api.capture(${JSON.stringify(path.join(shots, '2-inspector.png'))});
app.enterZoo(S.entries.slice(0, 24));
await sleep(8000);
await api.capture(${JSON.stringify(path.join(shots, '3-zoo.png'))});
const metas = S.models.map((m) => S.state.meta[m.path]).filter(Boolean);
const summary = {
  models: S.models.length,
  imagesIndexed: S.index.size,
  analysed: metas.length,
  failed: S.models.filter((m) => S.state.meta[m.path]?.error).map((m) => m.rel),
  withMissingTextures: metas.filter((m) => m.missing?.length).length,
  inspectorError,
  zooLoaded: S.zoo ? S.zoo.loaded + '/' + S.zoo.exhibits.length : null,
};
api.quit();
return summary;
`);

const electronBin = packaged ? findPackaged() : require('electron');
const appArgs = packaged ? [] : [path.join(__dirname, '..')];
const child = spawn(electronBin, appArgs, {
  env: { ...process.env, I3DV_USER_DATA: path.join(work, 'userData'), I3DV_TEST_SCRIPT: script },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
const timer = setTimeout(() => { console.error('smoke: timed out'); child.kill(); }, (seconds + 60) * 1000);
child.on('exit', () => {
  clearTimeout(timer);
  const line = out.split('\n').find((l) => l.startsWith('[test] '));
  if (!line) { console.error(out); console.error('smoke: no result'); process.exit(1); }
  const res = JSON.parse(line.slice(7));
  console.log(JSON.stringify(res, null, 2));
  console.log('screenshots:', shots);
  process.exit(res.failed.length || res.inspectorError || !res.models ? 1 : 0);
});

function findPackaged() {
  const dist = path.join(__dirname, '..', 'dist');
  const candidates = {
    darwin: () => fs.readdirSync(dist).filter((d) => d.startsWith('mac')).map((d) => path.join(dist, d, 'Immersive 3D Viewer.app', 'Contents', 'MacOS', 'Immersive 3D Viewer')),
    win32: () => [path.join(dist, 'win-unpacked', 'Immersive 3D Viewer.exe')],
    linux: () => [path.join(dist, 'linux-unpacked', 'immersive-3d-viewer')],
  }[process.platform]();
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) { console.error('smoke: no packaged app in dist/ — run `npm run pack` first'); process.exit(2); }
  return found;
}
