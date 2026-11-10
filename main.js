// Immersive 3D Viewer — Electron main process.
// Responsibilities: window, the `mfile://` protocol that serves local files (app UI,
// models, textures, thumbnails), folder scanning, persistence and OS integration.

const { app, BrowserWindow, ipcMain, dialog, protocol, net, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const MODEL_EXTS = new Set(['.glb', '.gltf', '.fbx', '.obj', '.dae', '.stl', '.ply', '.3ds']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.tga', '.bmp', '.gif', '.webp', '.psd', '.tif', '.tiff', '.dds']);
const SKIP_DIRS = new Set(['.git', '.svn', 'node_modules', '__MACOSX', '.Trash', '.Trashes', '$RECYCLE.BIN', 'System Volume Information']);
// Folder names that probably hold textures; used when looking *outside* the library root.
const TEXTURE_DIR_RE = /tex|material|image|img|maps|\.fbm$|sprite/i;
const MAX_NEARBY_IMAGES = 20000;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mfile',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

// ---------------------------------------------------------------------------
// mfile:// <-> filesystem path
// URL layout: mfile://local/<percent-encoded absolute path segments>
//   macOS/Linux: /Users/me/a.glb      -> mfile://local/Users/me/a.glb
//   Windows:     C:\x\a.glb           -> mfile://local/C%3A/x/a.glb
//   Windows UNC: \\server\share\a.glb -> mfile://local/UNC/server/share/a.glb
// Keeping real path segments means relative URLs (glTF .bin, MTL textures) resolve naturally.
function pathToMfile(p) {
  let s = p.replace(/\\/g, '/');
  if (s.startsWith('//')) s = '/UNC/' + s.slice(2);
  else if (!s.startsWith('/')) s = '/' + s;
  return 'mfile://local' + s.split('/').map(encodeURIComponent).join('/');
}

function mfileToPath(u) {
  const url = new URL(u);
  let p = url.pathname.split('/').map(safeDecode).join('/');
  if (process.platform === 'win32') {
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    else if (p.startsWith('/UNC/')) p = '//' + p.slice(5);
    p = p.replace(/\//g, '\\');
  }
  return p;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ---------------------------------------------------------------------------
// Persistence
const userDir = () => app.getPath('userData');
const configPath = () => path.join(userDir(), 'config.json');
const libDir = (root) => path.join(userDir(), 'libraries', crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 16));

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Scanning
async function walk(dir, out, wantModels, limit) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  const subdirs = [];
  for (const e of entries) {
    if (limit && out.images.length >= limit) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) subdirs.push(full);
    } else if (e.isFile() || e.isSymbolicLink()) {
      const ext = path.extname(e.name).toLowerCase();
      if (wantModels && MODEL_EXTS.has(ext)) out.models.push(full);
      else if (IMAGE_EXTS.has(ext)) out.images.push(full);
    }
  }
  // Bounded parallelism keeps huge trees from exhausting file handles.
  for (let i = 0; i < subdirs.length; i += 16) {
    await Promise.all(subdirs.slice(i, i + 16).map((d) => walk(d, out, wantModels, limit)));
  }
}

// Texture folders that sit next to (not inside) the library root, e.g. the user opened
// "Pack/Models" and the textures live in "Pack/Textures". We look up to two levels up,
// but only descend into folders whose names look texture-related, to avoid crawling ~/.
async function scanNearbyTextureDirs(root, out) {
  let child = path.resolve(root);
  let dir = path.dirname(child);
  for (let level = 0; level < 2 && dir !== child; level++) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { /* ignore */ }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (full === child) continue;
      if (e.isDirectory() && TEXTURE_DIR_RE.test(e.name)) {
        await walk(full, out, false, MAX_NEARBY_IMAGES);
      } else if (e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) {
        out.images.push(full);
      }
    }
    child = dir;
    dir = path.dirname(dir);
  }
}

async function scanLibrary(root, extraTextureDirs = []) {
  const out = { models: [], images: [] };
  await walk(root, out, true, 0);
  const nearby = { models: [], images: [] };
  await scanNearbyTextureDirs(root, nearby);
  for (const d of extraTextureDirs) await walk(d, nearby, false, MAX_NEARBY_IMAGES);
  const images = [...new Set([...out.images, ...nearby.images])];

  const models = [];
  for (let i = 0; i < out.models.length; i += 64) {
    const batch = out.models.slice(i, i + 64);
    const stats = await Promise.all(batch.map((p) => fsp.stat(p).catch(() => null)));
    batch.forEach((p, j) => {
      const st = stats[j];
      if (!st || !st.isFile()) return;
      models.push({
        path: p,
        rel: path.relative(root, p).split(path.sep).join('/'),
        size: st.size,
        mtime: Math.round(st.mtimeMs),
      });
    });
  }
  return { root, models, images, sep: path.sep };
}

// ---------------------------------------------------------------------------
// Window

let mainWindow = null;

async function createWindow() {
  const cfg = await readJson(configPath(), {});
  const b = cfg.window || {};
  mainWindow = new BrowserWindow({
    width: b.width || 1500,
    height: b.height || 920,
    x: b.x,
    y: b.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#15171c',
    title: 'Immersive 3D Viewer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (b.maximized) mainWindow.maximize();

  const saveBounds = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const c = await readJson(configPath(), {});
    c.window = { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() };
    await writeJsonAtomic(configPath(), c).catch(() => {});
  };
  mainWindow.on('close', saveBounds);

  // External links open in the OS browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(pathToMfile(path.join(__dirname, 'src', 'index.html')));
  runDevHooks(mainWindow);
}

// Developer/test hooks, active only when the env vars are set (see docs/DEVELOPMENT.md).
function runDevHooks(win) {
  const script = process.env.MODELZOO_TEST_SCRIPT;
  if (!script) return;
  const code = fs.readFileSync(script, 'utf8');
  win.webContents.executeJavaScript(`(async () => { ${code} })()`).then(
    (r) => { if (r !== undefined) console.log('[test]', typeof r === 'string' ? r : JSON.stringify(r)); },
    (e) => console.error('[test] error', e),
  );
}

// ---------------------------------------------------------------------------
// IPC

function registerIpc() {
  ipcMain.handle('pick-folder', async (_e, title) => {
    const r = await dialog.showOpenDialog(mainWindow, { title: title || 'Choose folder', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('pick-image', async (_e, { title, multi } = {}) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: title || 'Choose texture',
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'tga', 'bmp', 'gif', 'webp'] }],
    });
    return r.canceled ? null : r.filePaths;
  });

  ipcMain.handle('scan', (_e, root, extraDirs) => scanLibrary(root, extraDirs || []));

  ipcMain.handle('lib-load', async (_e, root) => {
    const dir = libDir(root);
    await fsp.mkdir(path.join(dir, 'thumbs'), { recursive: true });
    const state = await readJson(path.join(dir, 'state.json'), null);
    return { state, thumbDir: path.join(dir, 'thumbs') };
  });

  ipcMain.handle('lib-save', (_e, root, state) => writeJsonAtomic(path.join(libDir(root), 'state.json'), state));

  ipcMain.handle('thumb-save', async (_e, root, modelPath, bytes) => {
    const name = crypto.createHash('sha1').update(modelPath).digest('hex').slice(0, 24) + '.png';
    const file = path.join(libDir(root), 'thumbs', name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, Buffer.from(bytes));
    return name;
  });

  ipcMain.handle('thumbs-clear', async (_e, root) => {
    const dir = path.join(libDir(root), 'thumbs');
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
  });

  ipcMain.handle('clipboard', (_e, text) => { clipboard.writeText(String(text)); return true; });
  ipcMain.handle('reveal', (_e, p) => { shell.showItemInFolder(p); return true; });
  ipcMain.handle('config-get', () => readJson(configPath(), {}));
  ipcMain.handle('config-set', async (_e, patch) => {
    const c = await readJson(configPath(), {});
    Object.assign(c, patch);
    await writeJsonAtomic(configPath(), c);
    return c;
  });
  ipcMain.handle('exists', async (_e, p) => { try { await fsp.access(p); return true; } catch { return false; } });
  ipcMain.handle('capture', async (_e, file) => {
    const img = await mainWindow.webContents.capturePage();
    await fsp.writeFile(file, img.toPNG());
    return file;
  });
  ipcMain.handle('quit', () => app.quit());
}

// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  protocol.handle('mfile', async (req) => {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    let p;
    try { p = mfileToPath(req.url); } catch { return new Response('Bad URL', { status: 400, headers: cors }); }
    try {
      const st = await fsp.stat(p);
      if (!st.isFile()) throw new Error('not a file');
      const res = await net.fetch(pathToFileURL(p).toString());
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'no-cache');
      return new Response(res.body, { status: 200, headers });
    } catch {
      return new Response('Not found', { status: 404, headers: cors });
    }
  });

  registerIpc();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
