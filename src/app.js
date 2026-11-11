// Immersive 3D Viewer — renderer entry point. Owns library state and all UI.
import { TextureIndex } from './lib/textureIndex.js';
import { textureContext, SLOTS, isMissingTexture } from './lib/loader.js';
import { Viewer } from './lib/viewer.js';
import { Thumbnailer } from './lib/thumbnailer.js';
import { Zoo } from './lib/zoo.js';
import * as P from './lib/paths.js';
import { icon } from './icons.js';
import { fmtDims } from './lib/format.js';

const api = window.api;
const THUMB_VERSION = 1;
const FORMAT_ORDER = ['.glb', '.gltf', '.fbx', '.obj', '.dae', '.3ds', '.stl', '.ply'];
const ZOO_MAX = 400;
const isMac = api.platform === 'darwin';
const MOD = isMac ? '⌘' : 'Ctrl+';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------------------------------------------------------------------- state
const S = {
  root: null,
  thumbDir: null,
  models: [],
  byPath: new Map(),
  index: new TextureIndex(),
  state: defaultLibState(),
  entries: [],
  entryByKey: new Map(),
  selection: new Set(),
  anchor: -1,
  active: null, // model path shown in the inspector
  activeRes: null,
  curVariant: new Map(), // entry key -> chosen model path
  filters: { q: '', exts: new Set(), folder: '', status: 'all', missingName: null },
  settings: { collapse: true, pixelated: false, cardSize: 150, sort: 'name', thumbsPaused: false, inspW: 420 },
  recent: [],
  expanded: new Set(['']),
  zoo: null,
};

function defaultLibState() {
  return { version: 1, overrides: {}, remap: {}, meta: {}, textureDirs: [], hearts: {} };
}

const lib = () => ({ root: S.root, state: S.state });
const loadOptsFor = (path) => ({
  index: S.index,
  ctx: textureContext(lib(), path),
  overrides: S.state.overrides[path] || {},
});

// ---------------------------------------------------------------------------- utils
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

async function copyPath(path) {
  await api.copy(path);
  toast('Copied path: ' + path);
}

function busy(msg) {
  $('#busy').classList.toggle('hidden', !msg);
  if (msg) $('#busy-msg').textContent = msg;
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));

let saveTimer = null;
function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { if (S.root) api.libSave(S.root, S.state); }, 1200);
}

function saveSettings() {
  api.configSet({ settings: S.settings, recent: S.recent });
}

// ---------------------------------------------------------------------------- library
function mkModel(m) {
  const rel = m.rel;
  const relDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  return {
    ...m,
    name: P.stem(rel),
    ext: P.extname(rel),
    relDir,
    top: rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '',
    relLower: rel.toLowerCase(),
  };
}

async function openLibrary(root) {
  if (!root) return;
  busy('Scanning ' + root + ' …');
  try {
    const { state, thumbDir } = await api.libLoad(root);
    S.root = root;
    S.thumbDir = thumbDir;
    S.state = Object.assign(defaultLibState(), state || {});
    const scan = await api.scan(root, S.state.textureDirs);
    S.models = scan.models.map(mkModel);
    S.byPath = new Map(S.models.map((m) => [m.path, m]));
    S.index = new TextureIndex(scan.images);
    S.selection.clear();
    S.active = null;
    S.filters.folder = '';
    S.filters.missingName = null;
    S.expanded = new Set(['']);
    S.recent = [root, ...S.recent.filter((r) => r !== root)].slice(0, 10);
    saveSettings();
    $('#st-root').textContent = root;
    $('#st-root').title = `${root}\n${S.models.length} models · ${S.index.size} images indexed`;
    document.title = 'Immersive 3D Viewer — ' + P.basename(root);
    buildExtChips();
    buildTree();
    refresh();
    showInspectorEmpty();
    thumbs.reset();
  } catch (e) {
    console.error(e);
    toast('Could not open folder: ' + e.message, 5000);
  } finally {
    busy(null);
  }
}

async function rescan() {
  if (!S.root) return;
  const active = S.active;
  await openLibrary(S.root);
  if (active && S.byPath.has(active)) openInspector(active);
}

// ---------------------------------------------------------------------------- thumbnail meta
function relevantRemap(m) {
  const meta = S.state.meta[m.path];
  const out = {};
  for (const n of meta?.refs || []) if (S.state.remap[n]) out[n] = S.state.remap[n];
  return out;
}

function sigOf(m) {
  return JSON.stringify([THUMB_VERSION, m.size, m.mtime, S.state.overrides[m.path] || null, relevantRemap(m)]);
}

function metaOf(m) {
  const meta = S.state.meta[m.path];
  return meta && meta.sig === sigOf(m) ? meta : null;
}

function thumbUrl(m) {
  const meta = metaOf(m);
  if (!meta?.thumb) return null;
  return P.toUrl(P.join(S.thumbDir, meta.thumb)) + '?v=' + meta.t;
}

// ---------------------------------------------------------------------------- thumbnails queue
const thumbs = {
  renderer: null,
  running: false,
  visible: [],
  cursor: 0,
  current: null,
  reset() { this.cursor = 0; this.pump(); },
  setVisible(models) { this.visible = models; this.pump(); },
  next() {
    for (const m of this.visible) if (!metaOf(m)) return m;
    while (this.cursor < S.models.length) {
      const m = S.models[this.cursor];
      if (!metaOf(m)) return m;
      this.cursor++;
    }
    return null;
  },
  pump() {
    updateThumbStatus();
    if (this.running || S.settings.thumbsPaused || S.zoo || !S.root) return;
    const m = this.next();
    if (!m) return;
    this.running = true;
    this.current = m;
    setTimeout(() => this.run(m), 0);
  },
  async run(m) {
    const root = S.root;
    try {
      if (!this.renderer) this.renderer = new Thumbnailer(256);
      const { blob, report } = await this.renderer.render(m.path, loadOptsFor(m.path));
      if (root !== S.root) return;
      const thumb = blob ? await api.thumbSave(root, m.path, await blob.arrayBuffer()) : null;
      S.state.meta[m.path] = {
        refs: report.refs.map((r) => r.name.toLowerCase()),
        missing: report.missing,
        tris: report.tris,
        mats: report.materials.length,
        anims: report.animations.length,
        empty: !!report.empty,
        thumb,
        t: Date.now(),
      };
    } catch (e) {
      console.warn('thumbnail failed', m.path, e);
      if (root !== S.root) return;
      S.state.meta[m.path] = { error: String(e?.message || e), refs: [], missing: [], t: Date.now() };
    } finally {
      this.running = false;
      this.current = null;
    }
    S.state.meta[m.path].sig = sigOf(m);
    saveStateSoon();
    updateCardsFor(m.path);
    this.pump();
  },
};

let thumbStatusTimer = null;
function updateThumbStatus() {
  if (thumbStatusTimer) return;
  thumbStatusTimer = setTimeout(() => {
    thumbStatusTimer = null;
    if (!S.root) { $('#st-thumbs').textContent = ''; $('#btn-thumbs-pause').classList.add('hidden'); return; }
    let done = 0;
    for (const m of S.models) if (metaOf(m)) done++;
    const all = done === S.models.length;
    updateStatusCounts();
    $('#st-thumbs').textContent = all ? `Thumbnails: all ${done} analysed` : `Thumbnails: ${done}/${S.models.length}${S.settings.thumbsPaused ? ' (paused)' : ''}`;
    const b = $('#btn-thumbs-pause');
    b.classList.toggle('hidden', all);
    b.textContent = S.settings.thumbsPaused ? 'Resume' : 'Pause';
  }, 250);
}

function invalidateThumbs(paths) {
  for (const p of paths) updateCardsFor(p);
  thumbs.cursor = 0; // background pass re-checks everything; up-to-date files are skipped cheaply
  thumbs.pump();
}

// ---------------------------------------------------------------------------- filtering
function statusOk(m, status) {
  if (status === 'all') return true;
  const meta = S.state.meta[m.path];
  switch (status) {
    case 'missing': return !!meta?.missing?.length;
    case 'missingName': return !!meta?.missing?.some((n) => n.toLowerCase() === S.filters.missingName);
    case 'overrides': return !!S.state.overrides[m.path];
    case 'failed': return !!meta?.error;
    case 'anims': return meta?.anims > 0;
    case 'hearted': return !!S.state.hearts[m.path];
    default: return true;
  }
}

function filteredModels() {
  const f = S.filters;
  const tokens = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const folder = f.folder;
  return S.models.filter((m) =>
    (!f.exts.size || f.exts.has(m.ext)) &&
    (!folder || m.relDir === folder || m.relDir.startsWith(folder + '/')) &&
    tokens.every((t) => m.relLower.includes(t)) &&
    statusOk(m, f.status),
  );
}

function refresh() {
  const models = filteredModels();
  const groups = new Map();
  for (const m of models) {
    const k = S.settings.collapse ? m.top + '|' + m.name.toLowerCase() : m.path;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { key: k, variants: [] }));
    g.variants.push(m);
  }
  const entries = [...groups.values()];
  for (const e of entries) {
    e.variants.sort((a, b) => fmtRank(a.ext) - fmtRank(b.ext) || collator.compare(a.rel, b.rel));
    const chosen = S.curVariant.get(e.key);
    e.model = e.variants.find((v) => v.path === chosen) || e.variants[0];
  }
  const sort = S.settings.sort;
  const cmp = {
    name: (a, b) => collator.compare(a.model.name, b.model.name) || collator.compare(a.model.rel, b.model.rel),
    folder: (a, b) => collator.compare(a.model.rel, b.model.rel),
    size: (a, b) => b.model.size - a.model.size,
    date: (a, b) => b.model.mtime - a.model.mtime,
  }[sort];
  entries.sort(cmp);
  S.entries = entries;
  S.entryByKey = new Map(entries.map((e, i) => { e.index = i; return [e.key, e]; }));
  for (const k of [...S.selection]) if (!S.entryByKey.has(k)) S.selection.delete(k);

  $('#empty').classList.toggle('hidden', !!S.root);
  $('#st-count').textContent = S.root
    ? `${entries.length.toLocaleString()} shown · ${S.models.length.toLocaleString()} files`
    : '';
  updateStatusCounts();
  updateSelbar();
  layoutGrid(true);
}

const fmtRank = (ext) => { const i = FORMAT_ORDER.indexOf(ext); return i < 0 ? 99 : i; };

// ---------------------------------------------------------------------------- sidebar
function buildExtChips() {
  const counts = new Map();
  for (const m of S.models) counts.set(m.ext, (counts.get(m.ext) || 0) + 1);
  const el = $('#ext-chips');
  el.innerHTML = '';
  for (const ext of [...counts.keys()].sort((a, b) => fmtRank(a) - fmtRank(b))) {
    const c = document.createElement('span');
    c.className = 'chip' + (S.filters.exts.has(ext) ? ' on' : '');
    c.innerHTML = `${esc(ext.slice(1).toUpperCase())}<small>${counts.get(ext)}</small>`;
    c.onclick = () => {
      if (S.filters.exts.has(ext)) S.filters.exts.delete(ext); else S.filters.exts.add(ext);
      c.classList.toggle('on');
      refresh();
    };
    el.appendChild(c);
  }
}

const STATUSES = [
  ['all', 'All models'],
  ['hearted', '♥ Hearted'],
  ['missing', 'Missing textures'],
  ['overrides', 'Texture overrides'],
  ['anims', 'Has animations'],
  ['failed', 'Failed to load'],
];

function updateStatusCounts() {
  const el = $('#status-list');
  const counts = {};
  for (const [k] of STATUSES) counts[k] = 0;
  for (const m of S.models) for (const [k] of STATUSES) if (statusOk(m, k)) counts[k]++;
  const rows = STATUSES.map(([k, label]) =>
    `<div class="row ${S.filters.status === k ? 'on' : ''}" data-status="${k}">${esc(label)}<span class="n">${counts[k]}</span></div>`);
  if (S.filters.status === 'missingName') {
    rows.push(`<div class="row on" data-status="missingName">Uses “${esc(S.filters.missingName)}”<span class="n">×</span></div>`);
  }
  el.innerHTML = rows.join('');
}

$('#status-list').addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const st = row.dataset.status;
  S.filters.status = st === 'missingName' ? 'all' : st;
  if (st !== 'missingName') S.filters.missingName = null;
  refresh();
});

function buildTree() {
  const root = { name: '', path: '', children: new Map(), count: 0 };
  for (const m of S.models) {
    root.count++;
    let node = root;
    if (!m.relDir) continue;
    let acc = '';
    for (const part of m.relDir.split('/')) {
      acc = acc ? acc + '/' + part : part;
      let c = node.children.get(part);
      if (!c) node.children.set(part, (c = { name: part, path: acc, children: new Map(), count: 0 }));
      c.count++;
      node = c;
    }
  }
  S.tree = root;
  renderTree();
}

function renderTree() {
  const out = [];
  const walk = (node, depth) => {
    const kids = [...node.children.values()].sort((a, b) => collator.compare(a.name, b.name));
    const open = S.expanded.has(node.path);
    const label = depth === 0 ? 'All folders' : node.name;
    out.push(`<div class="row ${S.filters.folder === node.path ? 'on' : ''}" data-path="${esc(node.path)}" style="padding-left:${6 + depth * 12}px" title="${esc(node.path || S.root || '')}">
      <span class="caret" data-toggle="1">${kids.length ? (open ? '▼' : '▶') : ''}</span><span class="label">${esc(label)}</span><span class="n">${node.count}</span></div>`);
    if (open) for (const k of kids) walk(k, depth + 1);
  };
  if (S.tree) walk(S.tree, 0);
  $('#tree').innerHTML = out.join('');
}

$('#tree').addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const p = row.dataset.path;
  if (e.target.dataset.toggle && p !== '') {
    if (S.expanded.has(p)) S.expanded.delete(p); else S.expanded.add(p);
  } else {
    S.filters.folder = p;
    S.expanded.add(p);
    refresh();
  }
  renderTree();
});

// ---------------------------------------------------------------------------- virtual grid
const grid = { cols: 1, cardW: 150, cardH: 190, gap: 10, cards: new Map() };
const scrollEl = $('#grid-scroll');
const gridEl = $('#grid');

function layoutGrid(resetCards) {
  const W = scrollEl.clientWidth - 24;
  const target = S.settings.cardSize;
  grid.cols = Math.max(1, Math.floor((W + grid.gap) / (target + grid.gap)));
  grid.cardW = Math.floor((W - grid.gap * (grid.cols - 1)) / grid.cols);
  grid.cardH = grid.cardW + (S.settings.collapse ? 48 : 30);
  const rows = Math.ceil(S.entries.length / grid.cols);
  gridEl.style.height = Math.max(0, rows * (grid.cardH + grid.gap) - grid.gap) + 'px';
  if (resetCards) { for (const el of grid.cards.values()) el.remove(); grid.cards.clear(); }
  renderVisible();
}

function renderVisible() {
  const rowH = grid.cardH + grid.gap;
  const top = scrollEl.scrollTop - 12;
  const first = Math.max(0, Math.floor(top / rowH) - 1);
  const last = Math.ceil((top + scrollEl.clientHeight) / rowH) + 1;
  const want = new Set();
  const visibleModels = [];
  for (let i = first * grid.cols; i < Math.min(S.entries.length, (last + 1) * grid.cols); i++) {
    const e = S.entries[i];
    want.add(e.key);
    let el = grid.cards.get(e.key);
    if (!el) {
      el = createCard(e);
      grid.cards.set(e.key, el);
      gridEl.appendChild(el);
    }
    const r = Math.floor(i / grid.cols);
    const c = i % grid.cols;
    el.style.transform = `translate(${c * (grid.cardW + grid.gap)}px, ${r * rowH}px)`;
    el.style.width = grid.cardW + 'px';
    el.style.height = grid.cardH + 'px';
    updateCard(el, e);
    // Only rows actually on screen get thumbnail priority.
    if (r * rowH + rowH > top && r * rowH < top + scrollEl.clientHeight + 12) visibleModels.push(e.model);
  }
  for (const [k, el] of grid.cards) if (!want.has(k)) { el.remove(); grid.cards.delete(k); }
  thumbs.setVisible(visibleModels);
}

scrollEl.addEventListener('scroll', () => requestAnimationFrame(renderVisible), { passive: true });
new ResizeObserver(() => layoutGrid(false)).observe(scrollEl);

function createCard(e) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.key = e.key;
  el.innerHTML = `
    <div class="thumb"><img alt="" draggable="false" class="hidden"><div class="ph"></div>
      <label class="check" title="Select (${MOD}click, Shift+click for range)"><input type="checkbox" tabindex="-1"></label>
      <button class="heart" title="Heart (H)">${icon('heart')}</button>
      <button class="copy" title="Copy path to clipboard">${icon('copy')}</button>
      <div class="badges"></div>
    </div>
    <div class="meta"><div class="name"></div><div class="fmts"></div></div>`;
  return el;
}

function updateCard(el, e) {
  const m = e.model;
  el.classList.toggle('active', !!S.active && e.variants.some((v) => v.path === S.active));
  el.classList.toggle('selected', S.selection.has(e.key));
  el.querySelector('.check input').checked = S.selection.has(e.key);
  const name = el.querySelector('.name');
  if (name.textContent !== m.name) name.textContent = m.name;
  el.title = m.rel;

  const img = el.querySelector('img');
  const ph = el.querySelector('.ph');
  const url = thumbUrl(m);
  const meta = metaOf(m);
  if (url) {
    if (img.dataset.src !== url) { img.src = url; img.dataset.src = url; }
    img.classList.remove('hidden');
    ph.classList.add('hidden');
  } else {
    img.classList.add('hidden');
    img.removeAttribute('src');
    img.dataset.src = '';
    ph.classList.remove('hidden');
    ph.textContent = meta?.error ? 'ERROR' : meta?.empty ? 'EMPTY' : m.ext.slice(1).toUpperCase();
    ph.classList.toggle('busy', !meta);
  }

  const badges = [];
  if (meta?.missing?.length) badges.push(`<span class="badge warn" title="Missing textures:\n${esc(meta.missing.join('\n'))}">${meta.missing.length} missing</span>`);
  const hearted = e.variants.some((v) => isHearted(v.path));
  el.classList.toggle('hearted', hearted);
  el.querySelector('.heart').title = hearted ? 'Remove heart (H)' : 'Heart (H)';
  if (S.state.overrides[m.path]) badges.push('<span class="badge info" title="Has texture overrides">TEX</span>');
  if (meta?.anims) badges.push(`<span class="badge" title="${meta.anims} animation(s)">▶ ${meta.anims}</span>`);
  if (meta?.error) badges.push(`<span class="badge bad" title="${esc(meta.error)}">failed</span>`);
  const b = badges.join('');
  const bEl = el.querySelector('.badges');
  if (bEl.innerHTML !== b) bEl.innerHTML = b;

  const fmts = el.querySelector('.fmts');
  if (S.settings.collapse) {
    const html = e.variants.map((v) => `<span class="fmt ${v === m ? 'cur' : ''}" data-path="${esc(v.path)}" title="${esc(v.rel)}">${esc(v.ext.slice(1).toUpperCase())}</span>`).join('');
    if (fmts.innerHTML !== html) fmts.innerHTML = html;
    fmts.classList.remove('hidden');
  } else {
    fmts.classList.add('hidden');
  }
}

function updateCardsFor(path) {
  for (const [k, el] of grid.cards) {
    const e = S.entryByKey.get(k);
    if (e && e.variants.some((v) => v.path === path)) updateCard(el, e);
  }
}

function updateAllCards() {
  for (const [k, el] of grid.cards) { const e = S.entryByKey.get(k); if (e) updateCard(el, e); }
}

gridEl.addEventListener('click', (ev) => {
  const el = ev.target.closest('.card');
  if (!el) return;
  const e = S.entryByKey.get(el.dataset.key);
  if (!e) return;
  if (ev.target.closest('.copy')) { copyPath(e.model.path); return; }
  if (ev.target.closest('.heart')) { toggleHeart(e.model.path); return; }
  const fmt = ev.target.closest('.fmt');
  if (fmt) {
    S.curVariant.set(e.key, fmt.dataset.path);
    e.model = S.byPath.get(fmt.dataset.path);
    updateCard(el, e);
    openInspector(e.model.path);
    return;
  }
  const modKey = isMac ? ev.metaKey : ev.ctrlKey;
  if (ev.target.closest('.check')) {
    ev.preventDefault();
    if (ev.shiftKey && S.anchor >= 0) selectRange(S.anchor, e.index);
    else toggleSelect(e);
    S.anchor = e.index;
    return;
  }
  if (ev.shiftKey && S.anchor >= 0) { selectRange(S.anchor, e.index); return; }
  if (modKey) { toggleSelect(e); S.anchor = e.index; return; }
  S.anchor = e.index;
  openInspector(e.model.path);
});

gridEl.addEventListener('contextmenu', (ev) => {
  const el = ev.target.closest('.card');
  if (!el) return;
  ev.preventDefault();
  const e = S.entryByKey.get(el.dataset.key);
  if (e) showCardMenu(e, ev.clientX, ev.clientY);
});

// ---------------------------------------------------------------------------- selection
function toggleSelect(e) {
  if (S.selection.has(e.key)) S.selection.delete(e.key); else S.selection.add(e.key);
  updateSelbar();
  updateAllCards();
}

function selectRange(a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) S.selection.add(S.entries[i].key);
  updateSelbar();
  updateAllCards();
}

function selectAll() {
  for (const e of S.entries) S.selection.add(e.key);
  updateSelbar();
  updateAllCards();
}

function clearSelection() {
  S.selection.clear();
  updateSelbar();
  updateAllCards();
}

function updateSelbar() {
  const n = S.selection.size;
  $('#selbar').classList.toggle('hidden', n === 0);
  document.body.classList.toggle('selecting', n > 0);
  $('#selcount').textContent = `${n} selected`;
}

const selectedEntries = () => [...S.selection].map((k) => S.entryByKey.get(k)).filter(Boolean);
/** All files behind a set of entries (every format variant), for texture operations. */
const allVariantPaths = (entries) => entries.flatMap((e) => e.variants.map((v) => v.path));

// ---------------------------------------------------------------------------- hearts
// Hearts are stored per file path in the library state. With "Group formats" on, a model
// counts as hearted if any of its formats is, and un-hearting clears every format.
const isHearted = (path) => !!S.state.hearts[path];

/** The files shown together with `path` on one card (all formats when grouping). */
function variantsOf(path) {
  const m = S.byPath.get(path);
  if (!m) return [];
  if (!S.settings.collapse) return [m];
  const name = m.name.toLowerCase();
  return S.models.filter((x) => x.top === m.top && x.name.toLowerCase() === name);
}

const isHeartedAny = (path) => variantsOf(path).some((v) => isHearted(v.path));

/** Toggles the heart for a model; returns the new state. */
function toggleHeart(path, { quiet = false } = {}) {
  const on = !isHeartedAny(path);
  if (on) S.state.hearts[path] = Date.now();
  else for (const v of variantsOf(path)) delete S.state.hearts[v.path];
  afterHeartChange();
  if (!quiet) toast(on ? `♥ Hearted ${S.byPath.get(path)?.name}` : `Removed heart from ${S.byPath.get(path)?.name}`);
  return on;
}

/** Hearts every given model, or un-hearts them all if they're all hearted already. */
function heartMany(paths) {
  const on = !paths.every(isHeartedAny);
  for (const p of paths) {
    if (on) { if (!isHeartedAny(p)) S.state.hearts[p] = Date.now(); }
    else for (const v of variantsOf(p)) delete S.state.hearts[v.path];
  }
  afterHeartChange();
  toast(on ? `♥ Hearted ${paths.length} model(s)` : `Removed hearts from ${paths.length} model(s)`);
}

function afterHeartChange() {
  saveStateSoon();
  if (S.filters.status === 'hearted') refresh();
  else { updateAllCards(); updateStatusCounts(); }
  const btn = insp.querySelector('[data-act="heart"]');
  if (btn && S.active) {
    const on = isHeartedAny(S.active);
    btn.classList.toggle('on', on);
    btn.innerHTML = `${icon('heart')} ${on ? 'Hearted' : 'Heart'}`;
  }
}

// ---------------------------------------------------------------------------- texture operations
async function opSetTextureFolder(paths) {
  const dir = await api.pickFolder(`Texture folder for ${paths.length} model file(s)`);
  if (!dir) return;
  // Make sure images in the folder are indexed even if it's outside the library.
  if (!S.state.textureDirs.includes(dir) && !P.key(dir).startsWith(P.key(S.root) + '/')) {
    S.state.textureDirs.push(dir);
    const scan = await api.scan(dir, []);
    for (const p of scan.images) S.index.add(p);
  }
  for (const p of paths) {
    const ov = (S.state.overrides[p] ||= {});
    ov.dirs = [dir];
  }
  afterOverrideChange(paths, `Texture folder set for ${paths.length} file(s)`);
}

async function opApplyImage(paths, imgPath) {
  if (!imgPath) {
    const r = await api.pickImage({ title: `Image for all materials of ${paths.length} model file(s)` });
    if (!r) return;
    imgPath = r[0];
  }
  for (const p of paths) {
    const ov = (S.state.overrides[p] ||= {});
    ov.all = { ...(ov.all || {}), map: imgPath };
  }
  afterOverrideChange(paths, `Applied ${P.basename(imgPath)} to ${paths.length} file(s)`);
}

function opReset(paths) {
  let n = 0;
  for (const p of paths) if (S.state.overrides[p]) { delete S.state.overrides[p]; n++; }
  afterOverrideChange(paths, n ? `Reset textures on ${n} file(s)` : 'No overrides to reset');
}

async function opSetSlot(path, matKey, slot, imgPath) {
  if (!imgPath) {
    const r = await api.pickImage({ title: `Texture for ${matKey} · ${slot}` });
    if (!r) return;
    imgPath = r[0];
  }
  const ov = (S.state.overrides[path] ||= {});
  ov.mats ||= {};
  ov.mats[matKey] = { ...(ov.mats[matKey] || {}), [slot]: imgPath };
  afterOverrideChange([path], `Assigned ${P.basename(imgPath)}`);
}

function opClearSlot(path, matKey, slot) {
  const ov = S.state.overrides[path];
  if (!ov) return;
  if (ov.mats?.[matKey]) {
    delete ov.mats[matKey][slot];
    if (!Object.keys(ov.mats[matKey]).length) delete ov.mats[matKey];
    if (!Object.keys(ov.mats).length) delete ov.mats;
  }
  if (ov.all?.[slot]) { delete ov.all[slot]; if (!Object.keys(ov.all).length) delete ov.all; }
  if (!Object.keys(ov).length) delete S.state.overrides[path];
  afterOverrideChange([path], 'Override removed');
}

/** Library-wide: every reference to `name` (by file name) resolves to `imgPath`. */
async function opRemap(name, imgPath) {
  if (!imgPath) {
    const r = await api.pickImage({ title: `Replacement for “${name}” (all models)` });
    if (!r) return;
    imgPath = r[0];
  }
  S.state.remap[name.toLowerCase()] = imgPath;
  const affected = S.models.filter((m) => S.state.meta[m.path]?.refs?.includes(name.toLowerCase())).map((m) => m.path);
  afterOverrideChange(affected, `“${name}” → ${P.basename(imgPath)} (${affected.length} model file(s))`);
}

function opUnmap(name) {
  delete S.state.remap[name.toLowerCase()];
  const affected = S.models.filter((m) => S.state.meta[m.path]?.refs?.includes(name.toLowerCase())).map((m) => m.path);
  afterOverrideChange(affected, `Removed mapping for “${name}”`);
}

function afterOverrideChange(paths, msg) {
  viewer?.invalidateCache(); // cached models were loaded with the old textures
  saveStateSoon();
  toast(msg);
  invalidateThumbs(paths);
  updateStatusCounts();
  if (S.active && (paths.includes(S.active) || !paths.length)) openInspector(S.active, { keepView: true });
}

// ---------------------------------------------------------------------------- bulk bar
$('#selbar').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-bulk]');
  if (!b) return;
  const entries = selectedEntries();
  switch (b.dataset.bulk) {
    case 'heart': heartMany(entries.map((e) => e.model.path)); break;
    case 'copy': {
      const text = entries.map((e) => e.model.path).join('\n');
      await api.copy(text);
      toast(`Copied ${entries.length} path(s)`);
      break;
    }
    case 'texdir': await opSetTextureFolder(allVariantPaths(entries)); break;
    case 'teximg': await opApplyImage(allVariantPaths(entries)); break;
    case 'reset': opReset(allVariantPaths(entries)); break;
    case 'zoo': enterZoo(entries); break;
    case 'none': clearSelection(); break;
  }
});

// ---------------------------------------------------------------------------- context menu
function showMenu(items, x, y) {
  const el = $('#ctx');
  el.innerHTML = items.map((it, i) => (it === '-' ? '<div class="sep"></div>' : it.head ? `<div class="head">${esc(it.head)}</div>` : `<div class="item" data-i="${i}">${esc(it.label)}</div>`)).join('');
  el.classList.remove('hidden');
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  el.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  el.onclick = (ev) => {
    const i = ev.target.closest('.item')?.dataset.i;
    hideMenu();
    if (i !== undefined) items[i].run();
  };
}
const hideMenu = () => $('#ctx').classList.add('hidden');
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctx')) hideMenu(); });

function showCardMenu(e, x, y) {
  const multi = S.selection.has(e.key) && S.selection.size > 1;
  const targets = multi ? selectedEntries() : [e];
  const paths = allVariantPaths(targets);
  const reveal = isMac ? 'Reveal in Finder' : api.platform === 'win32' ? 'Show in Explorer' : 'Show in file manager';
  const items = [
    { head: multi ? `${targets.length} selected models` : e.model.name },
    { label: multi ? 'Copy paths' : 'Copy path', run: async () => { await api.copy(targets.map((t) => t.model.path).join('\n')); toast(multi ? `Copied ${targets.length} paths` : 'Copied path: ' + e.model.path); } },
  ];
  if (!multi) {
    items.push({ label: reveal, run: () => api.reveal(e.model.path) });
    items.push({ label: S.selection.has(e.key) ? 'Deselect' : 'Select', run: () => toggleSelect(e) });
  }
  items.push('-',
    { label: multi ? (targets.every((t) => isHeartedAny(t.model.path)) ? 'Remove hearts' : 'Heart all') : (isHeartedAny(e.model.path) ? 'Remove heart' : 'Heart'), run: () => (multi ? heartMany(targets.map((t) => t.model.path)) : toggleHeart(e.model.path)) },
    '-',
    { label: 'Set texture folder…', run: () => opSetTextureFolder(paths) },
    { label: 'Apply image to all materials…', run: () => opApplyImage(paths) },
    { label: 'Reset textures', run: () => opReset(paths) },
    { label: 'Regenerate thumbnail' + (multi ? 's' : ''), run: () => { for (const p of paths) delete S.state.meta[p]; invalidateThumbs(paths); } },
    '-',
    { label: 'Walk around in zoo', run: () => enterZoo(targets) },
  );
  showMenu(items, x, y);
}

// ---------------------------------------------------------------------------- inspector
let viewer = null;
const insp = $('#insp');

function ensureViewer() {
  if (!viewer) viewer = new Viewer($('#viewer-host'));
  return viewer;
}

function showInspectorEmpty() {
  S.active = null;
  S.activeRes = null;
  viewer?.clear();
  $('#viewer-msg').textContent = S.root ? 'Select a model' : '';
  $('#viewer-msg').classList.remove('hidden');
  insp.innerHTML = S.root
    ? `<p class="hint">Click a model to inspect it. ${MOD}click or Shift+click to select several for bulk actions (copy paths, assign textures).</p>
       <p class="hint">Right-click a card for more options. Press <b>${MOD}C</b> to copy the active model's path.</p>`
    : '';
}

async function openInspector(path, { keepView = false } = {}) {
  const m = S.byPath.get(path);
  if (!m) return;
  S.active = path;
  updateAllCards();
  const v = ensureViewer();
  const saved = keepView && viewer.current ? { pos: v.camera.position.clone(), target: v.controls.target.clone() } : null;
  // Preloaded models resolve within the same frame, so only show a loading state for
  // models that actually need loading, and only after a short delay.
  let slow = null;
  if (!v.isReady(path)) {
    renderInspector(m, null);
    slow = setTimeout(() => {
      if (S.active !== path) return;
      $('#viewer-msg').textContent = 'Loading…';
      $('#viewer-msg').classList.remove('hidden');
    }, 150);
  }
  try {
    const res = await v.show(path, { ...loadOptsFor(path), pixelated: S.settings.pixelated });
    clearTimeout(slow);
    if (!res || S.active !== path) return;
    S.activeRes = res;
    if (saved) { v.camera.position.copy(saved.pos); v.controls.target.copy(saved.target); v.controls.update(); }
    $('#viewer-msg').classList.add('hidden');
    renderInspector(m, res);
  } catch (e) {
    clearTimeout(slow);
    console.error(e);
    if (S.active !== path) return;
    $('#viewer-msg').textContent = 'Failed to load: ' + (e?.message || e);
    $('#viewer-msg').classList.remove('hidden');
    S.activeRes = null;
    renderInspector(m, null, e);
  }
  preloadNeighbours(path);
}

/** Loads the models the arrow keys can reach next (right, left, down, up). */
function preloadNeighbours(path) {
  if (!viewer || S.active !== path) return;
  const i = S.entries.findIndex((x) => x.variants.some((v) => v.path === path));
  if (i < 0) return;
  const paths = [i + 1, i - 1, i + grid.cols, i - grid.cols]
    .filter((j) => j >= 0 && j < S.entries.length && j !== i)
    .map((j) => S.entries[j].model.path);
  viewer.preload([...new Set(paths)], (p) => ({ ...loadOptsFor(p), pixelated: S.settings.pixelated }));
}

function renderInspector(m, res, err) {
  const ov = S.state.overrides[m.path];
  const entry = [...S.entryByKey.values()].find((e) => e.variants.includes(m));
  const r = res?.report;
  const stats = [
    `<span class="stat">${esc(m.ext.slice(1).toUpperCase())}</span>`,
    `<span class="stat">${fmtSize(m.size)}</span>`,
  ];
  if (r) {
    if (r.size) stats.push(`<span class="stat" title="Width × height × depth">${fmtDims(r.size)}</span>`);
    stats.push(`<span class="stat">${fmtNum(r.tris)} tris</span>`, `<span class="stat">${r.materials.length} material${r.materials.length === 1 ? '' : 's'}</span>`);
    if (r.animations.length) stats.push(`<span class="stat">${r.animations.length} animation${r.animations.length === 1 ? '' : 's'}</span>`);
    if (r.missing.length) stats.push(`<span class="stat warn">${r.missing.length} missing texture${r.missing.length === 1 ? '' : 's'}</span>`);
  }
  const anim = r?.animations.length
    ? `<div class="actions" style="margin-top:8px"><select id="anim-sel"><option value="-1">Animation: none (bind pose)</option>${r.animations.map((a, i) => `<option value="${i}">${esc(a.name || 'Clip ' + (i + 1))} · ${a.duration.toFixed(1)}s</option>`).join('')}</select></div>`
    : '';
  const variants = entry && entry.variants.length > 1
    ? `<h3>Other formats</h3><div class="variants">${entry.variants.map((v) => `<div class="v"><span class="fmt ${v === m ? 'cur' : ''}" data-open="${esc(v.path)}">${esc(v.ext.slice(1).toUpperCase())}</span><code title="${esc(v.path)}">${esc(v.rel)}</code><button class="btn icon xs" data-copy="${esc(v.path)}" title="Copy path">${icon('copy')}</button></div>`).join('')}</div>`
    : '';

  insp.innerHTML = `
    <h2>${esc(m.name)}</h2>
    <div class="path-row"><code>${esc(m.path)}</code></div>
    <div class="actions">
      <button class="btn primary" data-act="copy">${icon('copy')} Copy path</button>
      <button class="btn heart-btn ${isHeartedAny(m.path) ? 'on' : ''}" data-act="heart" title="Heart (H)">${icon('heart')} ${isHeartedAny(m.path) ? 'Hearted' : 'Heart'}</button>
      <button class="btn" data-act="reveal">${icon('folder')} ${isMac ? 'Reveal' : 'Show in folder'}</button>
    </div>
    <div class="stats">${stats.join('')}</div>
    ${anim}
    ${err ? `<p class="hint" style="color:var(--bad)">${esc(err.message || err)}</p>` : ''}
    ${variants}
    <h3>Textures</h3>
    <div class="actions">
      <button class="btn" data-act="texdir" title="Look for this model's textures in a specific folder first">${icon('folder')} Texture folder…</button>
      <button class="btn" data-act="teximg" title="Use one image (e.g. an atlas) as base colour for every material">${icon('image')} Image for all…</button>
      ${ov ? '<button class="btn danger" data-act="reset">Reset</button>' : ''}
    </div>
    ${ov?.dirs ? `<p class="hint">Searching first in: <code>${esc(ov.dirs.join(', '))}</code></p>` : ''}
    ${ov?.all?.map ? `<p class="hint">All materials use: <code>${esc(P.basename(ov.all.map))}</code></p>` : ''}
    ${res ? renderRefs(r) : '<p class="hint">Loading…</p>'}
    ${res ? renderMaterials(m, res) : ''}
  `;
}

function renderRefs(r) {
  if (!r.refs.length) return '<p class="hint">This file references no external textures (they may be embedded).</p>';
  const how = { exact: 'at original path', found: 'found nearby', substitute: 'same name, different format', folder: 'in texture folder', remap: 'mapped by you', known: 'found' };
  return `<div class="refs">${r.refs.map((ref) => {
    const ok = !!ref.path;
    return `<div class="ref"><span class="ic ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</span>
      <div class="txt"><div title="${esc(ref.requested)}">${esc(ref.name)}</div><small title="${esc(ref.path || '')}">${ok ? esc(how[ref.how] || ref.how) + ' · ' + esc(relToRoot(ref.path)) : 'not found'}</small></div>
      ${ok && ref.how !== 'remap'
        ? ''
        : `<button class="btn xs" data-remap="${esc(ref.name)}" title="Pick an image to use wherever “${esc(ref.name)}” is referenced, in every model">${ok ? 'Change…' : 'Assign…'}</button>`}
      ${ref.how === 'remap' ? `<button class="btn xs ghost" data-unmap="${esc(ref.name)}" title="Remove mapping">×</button>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function relToRoot(p) {
  const k = P.norm(p);
  const r = P.norm(S.root) + '/';
  return k.toLowerCase().startsWith(r.toLowerCase()) ? k.slice(r.length) : k;
}

function renderMaterials(m, res) {
  const ov = S.state.overrides[m.path] || {};
  const autoSet = new Set(res.report.auto.map((a) => a.key + '|' + a.slot));
  const blocks = res.materials.map(({ key: mk, material: mat }) => {
    const isStd = !!mat.isMeshStandardMaterial;
    const slots = SLOTS.filter(({ slot }) => slot in mat && (['map', 'normalMap', 'emissiveMap'].includes(slot) || (isStd && slot !== 'alphaMap') || mat[slot]));
    const rows = slots.map(({ slot, label }) => {
      const tex = mat[slot];
      const ovPath = ov.mats?.[mk]?.[slot] || ov.all?.[slot];
      let sw = '';
      let val = '<div class="muted">—</div>';
      if (tex) {
        const p = tex.userData?.path;
        if (isMissingTexture(tex)) {
          sw = 'missing';
          val = `<div>${esc(tex.userData.requested || 'missing')}<span class="tag miss">MISSING</span></div>`;
        } else if (p) {
          val = `<div title="${esc(p)}">${esc(P.basename(p))}${ovPath ? '<span class="tag ov">OVERRIDE</span>' : autoSet.has(mk + '|' + slot) ? '<span class="tag auto">AUTO</span>' : ''}</div><small>${esc(relToRoot(P.dirname(p)))}</small>`;
        } else {
          val = `<div>${esc(tex.name || 'embedded')}</div><small>embedded in file</small>`;
        }
      }
      const swStyle = tex?.userData?.path && /\.(png|jpe?g|gif|webp|bmp)$/i.test(tex.userData.path) ? `style="background-image:url('${P.toUrl(tex.userData.path)}')"` : '';
      return `<div class="slot" data-mat="${esc(mk)}" data-slot="${slot}">
        <span class="lbl">${esc(label)}</span>
        <span class="sw ${sw}" ${swStyle}></span>
        <div class="val">${val}</div>
        <button class="btn xs" data-pick title="Choose image (or drop one here)">Choose…</button>
        ${ov.mats?.[mk]?.[slot] || ov.all?.[slot] ? '<button class="btn xs ghost" data-clear title="Remove override">×</button>' : ''}
      </div>`;
    }).join('');
    return `<div class="mat"><div class="mat-head"><b title="${esc(mk)}">${esc(mat.name || mk)}</b><small>${esc(mat.type.replace('Material', ''))}</small></div>${rows}</div>`;
  });
  return `<h3>Materials</h3><p class="hint">Drop an image onto a slot to assign it.</p>${blocks.join('')}`;
}

insp.addEventListener('click', async (ev) => {
  const path = S.active;
  if (!path) return;
  const t = ev.target.closest('button, .fmt');
  if (!t) return;
  if (t.dataset.act === 'copy') return copyPath(path);
  if (t.dataset.act === 'heart') return toggleHeart(path);
  if (t.dataset.act === 'reveal') return api.reveal(path);
  if (t.dataset.act === 'texdir') return opSetTextureFolder([path]);
  if (t.dataset.act === 'teximg') return opApplyImage([path]);
  if (t.dataset.act === 'reset') return opReset([path]);
  if (t.dataset.copy) return copyPath(t.dataset.copy);
  if (t.dataset.open) {
    const e = [...S.entryByKey.values()].find((x) => x.variants.some((v) => v.path === t.dataset.open));
    if (e) { S.curVariant.set(e.key, t.dataset.open); e.model = S.byPath.get(t.dataset.open); updateAllCards(); }
    return openInspector(t.dataset.open);
  }
  if (t.dataset.remap) return opRemap(t.dataset.remap);
  if (t.dataset.unmap) return opUnmap(t.dataset.unmap);
  const slotEl = t.closest('.slot');
  if (slotEl && t.hasAttribute('data-pick')) return opSetSlot(path, slotEl.dataset.mat, slotEl.dataset.slot);
  if (slotEl && t.hasAttribute('data-clear')) return opClearSlot(path, slotEl.dataset.mat, slotEl.dataset.slot);
});

insp.addEventListener('change', (ev) => {
  if (ev.target.id === 'anim-sel') viewer?.playClip(parseInt(ev.target.value, 10));
});

// Drag & drop images onto material slots or the viewer.
const imageFromDrop = (ev) => {
  const f = [...(ev.dataTransfer?.files || [])].find((x) => /\.(png|jpe?g|tga|bmp|gif|webp)$/i.test(x.name));
  return f ? api.pathForFile(f) : null;
};
insp.addEventListener('dragover', (ev) => {
  const slot = ev.target.closest('.slot');
  if (!slot) return;
  ev.preventDefault();
  insp.querySelectorAll('.slot.drop').forEach((s) => s.classList.remove('drop'));
  slot.classList.add('drop');
});
insp.addEventListener('dragleave', (ev) => ev.target.closest?.('.slot')?.classList.remove('drop'));
insp.addEventListener('drop', (ev) => {
  const slot = ev.target.closest('.slot');
  if (!slot || !S.active) return;
  ev.preventDefault();
  const p = imageFromDrop(ev);
  if (p) opSetSlot(S.active, slot.dataset.mat, slot.dataset.slot, p);
});
const vwrap = document.querySelector('.viewer-wrap');
vwrap.addEventListener('dragover', (ev) => { if (S.active) { ev.preventDefault(); vwrap.classList.add('drop'); } });
vwrap.addEventListener('dragleave', () => vwrap.classList.remove('drop'));
vwrap.addEventListener('drop', (ev) => {
  vwrap.classList.remove('drop');
  if (!S.active) return;
  ev.preventDefault();
  const p = imageFromDrop(ev);
  if (p) opApplyImage([S.active], p);
});
// Prevent the window from navigating to dropped files elsewhere.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// Viewer toolbar
const vtState = { rotate: false, wire: false, grid: true };
document.querySelectorAll('[data-vt]').forEach((b) => {
  const k = b.dataset.vt;
  b.innerHTML = icon({ reset: 'target', rotate: 'rotate', wire: 'wire', grid: 'grid', bg: 'contrast' }[k]);
  if (k === 'grid') b.classList.add('on');
  b.onclick = () => {
    const v = ensureViewer();
    if (k === 'reset') v.resetView();
    if (k === 'bg') v.cycleBackground();
    if (k === 'rotate') { vtState.rotate = !vtState.rotate; v.setAutoRotate(vtState.rotate); b.classList.toggle('on', vtState.rotate); }
    if (k === 'wire') { vtState.wire = !vtState.wire; v.setWireframe(vtState.wire); b.classList.toggle('on', vtState.wire); }
    if (k === 'grid') { vtState.grid = !vtState.grid; v.setGrid(vtState.grid); b.classList.toggle('on', vtState.grid); }
  };
});

// Inspector splitter
(() => {
  const sp = $('#splitter');
  let startX = 0;
  let startW = 0;
  const move = (e) => {
    const w = Math.max(300, Math.min(window.innerWidth * 0.6, startW - (e.clientX - startX)));
    document.documentElement.style.setProperty('--insp-w', w + 'px');
    S.settings.inspW = w;
  };
  const up = () => {
    sp.classList.remove('drag');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    layoutGrid(false);
    saveSettings();
  };
  sp.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startW = $('#inspector').offsetWidth;
    sp.classList.add('drag');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
})();

// ---------------------------------------------------------------------------- modals
function modal(title, bodyHtml, { onClick, foot = '' } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal"><div class="modal-head"><h3>${esc(title)}</h3><span class="spacer"></span><button class="btn ghost" data-close>✕</button></div><div class="modal-body">${bodyHtml}</div><div class="modal-foot">${foot}<button class="btn" data-close>Close</button></div></div>`;
  const close = () => back.remove();
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return close();
    onClick?.(e, close, back);
  });
  $('#modal-root').appendChild(back);
  return { close, el: back };
}

function missingTexturesModal() {
  if (!S.root) return;
  const byName = new Map();
  let analysed = 0;
  for (const m of S.models) {
    const meta = metaOf(m);
    if (!meta) continue;
    analysed++;
    for (const n of meta.missing || []) {
      const k = n.toLowerCase();
      if (!byName.has(k)) byName.set(k, { name: n, models: [] });
      byName.get(k).models.push(m.path);
    }
  }
  const rows = [...byName.values()].sort((a, b) => b.models.length - a.models.length);
  const mapped = Object.entries(S.state.remap);
  const body = `
    <p class="hint">Texture files referenced by models that couldn't be found anywhere in the library or nearby folders.
    Assigning an image here fixes it for <b>every</b> model that references that file name.
    ${analysed < S.models.length ? `<br><b>${analysed} of ${S.models.length}</b> files analysed so far — the list grows as thumbnails are generated.` : ''}</p>
    ${rows.length ? `<table class="mtable">${rows.map((r) => `<tr><td><code>${esc(r.name)}</code></td><td class="num">${r.models.length} file${r.models.length === 1 ? '' : 's'}</td>
      <td class="act"><button class="btn xs" data-show="${esc(r.name)}">Show models</button> <button class="btn xs primary" data-assign="${esc(r.name)}">Assign…</button></td></tr>`).join('')}</table>`
      : '<p>No missing textures found' + (analysed < S.models.length ? ' yet.' : '. 🎉') + '</p>'}
    ${mapped.length ? `<h3 style="margin-top:18px">Your mappings</h3><table class="mtable">${mapped.map(([n, p]) => `<tr><td><code>${esc(n)}</code></td><td><code class="muted">${esc(p)}</code></td><td class="act"><button class="btn xs ghost" data-unmap="${esc(n)}">Remove</button></td></tr>`).join('')}</table>` : ''}`;
  modal('Missing textures', body, {
    onClick: async (e, close) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.show) {
        S.filters.status = 'missingName';
        S.filters.missingName = t.dataset.show.toLowerCase();
        close();
        refresh();
      } else if (t.dataset.assign) {
        await opRemap(t.dataset.assign);
        close();
        missingTexturesModal();
      } else if (t.dataset.unmap) {
        opUnmap(t.dataset.unmap);
        close();
        missingTexturesModal();
      }
    },
  });
}

function textureDirsModal() {
  if (!S.root) return;
  const dirs = S.state.textureDirs;
  const body = `
    <p class="hint">Images are indexed from the library folder, texture-like folders up to two levels above it (e.g. a sibling <code>Textures</code> folder), and these extra folders.
    Models look up textures by file name, preferring the closest match. ${S.index.size.toLocaleString()} images are indexed.</p>
    ${dirs.length ? `<table class="mtable">${dirs.map((d, i) => `<tr><td><code>${esc(d)}</code></td><td class="act"><button class="btn xs ghost" data-rm="${i}">Remove</button></td></tr>`).join('')}</table>` : '<p class="muted">No extra folders.</p>'}`;
  modal('Texture search folders', body, {
    foot: '<button class="btn primary" data-add>Add folder…</button>',
    onClick: async (e, close) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.hasAttribute('data-add')) {
        const d = await api.pickFolder('Add texture search folder');
        if (!d || dirs.includes(d)) return;
        dirs.push(d);
      } else if (t.dataset.rm !== undefined) {
        dirs.splice(parseInt(t.dataset.rm, 10), 1);
      } else return;
      saveStateSoon();
      close();
      await api.libSave(S.root, S.state);
      await rescan();
      textureDirsModal();
    },
  });
}

$('#btn-missing').onclick = missingTexturesModal;
$('#btn-texdirs').onclick = textureDirsModal;

// ---------------------------------------------------------------------------- zoo
function enterZoo(entries = S.entries) {
  if (!S.root || !entries.length) { toast('Nothing to show — open a folder or clear filters'); return; }
  let list = entries;
  if (list.length > ZOO_MAX) {
    toast(`Showing the first ${ZOO_MAX} of ${list.length} models — narrow the view with search, folders or a selection`, 5000);
    list = list.slice(0, ZOO_MAX);
  }
  const items = list.map((e) => ({ path: e.model.path, name: e.model.name, rel: e.model.rel, group: e.model.relDir }));
  const host = $('#zoo-host');
  host.classList.remove('hidden');
  hideMenu();
  S.zoo = new Zoo(host, items, {
    makeLoadOpts: loadOptsFor,
    pixelated: S.settings.pixelated,
    scale: S.settings.zooScale || 1,
    onScale: (scale) => { S.settings.zooScale = scale; saveSettings(); },
    onCopy: (it) => api.copy(it.path),
    isHearted: (it) => isHeartedAny(it.path),
    onToggleHeart: (it) => toggleHeart(it.path, { quiet: true }),
    onInspect: (it) => {
      const e = S.entries.find((x) => x.variants.some((v) => v.path === it.path));
      if (e) scrollToEntry(e);
      openInspector(it.path);
    },
    onExit: () => {
      S.zoo = null;
      host.classList.add('hidden');
      thumbs.pump();
    },
  });
}

function scrollToEntry(e) {
  const rowH = grid.cardH + grid.gap;
  const y = Math.floor(e.index / grid.cols) * rowH;
  if (y < scrollEl.scrollTop || y + rowH > scrollEl.scrollTop + scrollEl.clientHeight) {
    scrollEl.scrollTop = y - scrollEl.clientHeight / 2 + rowH / 2;
  }
}

// ---------------------------------------------------------------------------- top bar
$('#btn-open').onclick = $('#btn-open-empty').onclick = async () => {
  const d = await api.pickFolder('Open a folder of 3D models');
  if (d) openLibrary(d);
};
$('#btn-rescan').innerHTML = icon('refresh');
$('#btn-rescan').onclick = rescan;
$('#btn-zoo').onclick = () => enterZoo();
$('#btn-recent').onclick = (e) => {
  e.stopPropagation();
  const menu = $('#menu-recent');
  menu.innerHTML = S.recent.length
    ? S.recent.map((r, i) => `<div class="item" data-i="${i}" title="${esc(r)}">${esc(P.basename(r))}<small>${esc(r)}</small></div>`).join('')
    : '<div class="item muted">No recent folders</div>';
  menu.classList.toggle('hidden');
};
$('#menu-recent').onclick = (e) => {
  const i = e.target.closest('.item')?.dataset.i;
  $('#menu-recent').classList.add('hidden');
  if (i !== undefined) openLibrary(S.recent[i]);
};
document.addEventListener('click', (e) => { if (!e.target.closest('.dropdown')) $('#menu-recent').classList.add('hidden'); });

let searchTimer = null;
$('#search').placeholder = `Search models… (${MOD}F)`;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { S.filters.q = e.target.value; refresh(); scrollEl.scrollTop = 0; }, 90);
});

$('#opt-collapse').onchange = (e) => { S.settings.collapse = e.target.checked; S.selection.clear(); saveSettings(); refresh(); };
$('#opt-pixel').onchange = (e) => { S.settings.pixelated = e.target.checked; saveSettings(); viewer?.setPixelated(S.settings.pixelated); };
$('#opt-sort').onchange = (e) => { S.settings.sort = e.target.value; saveSettings(); refresh(); };
$('#opt-size').oninput = (e) => { S.settings.cardSize = parseInt(e.target.value, 10); layoutGrid(false); };
$('#opt-size').onchange = saveSettings;
$('#btn-thumbs-pause').onclick = () => { S.settings.thumbsPaused = !S.settings.thumbsPaused; saveSettings(); thumbs.pump(); updateThumbStatus(); };

// ---------------------------------------------------------------------------- keyboard
document.addEventListener('keydown', (e) => {
  if (S.zoo) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const inInput = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  if (e.key === 'Escape') {
    if (document.querySelector('.modal-back')) { document.querySelector('.modal-back').remove(); return; }
    if (inInput) { document.activeElement.blur(); return; }
    hideMenu();
    clearSelection();
    return;
  }
  if (inInput) return;
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }
  if (!mod && !e.altKey && e.key.toLowerCase() === 'h' && S.active) { e.preventDefault(); toggleHeart(S.active); return; }
  if (mod && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) {
    e.preventDefault();
    if (S.selection.size > 1) { const t = selectedEntries().map((x) => x.model.path).join('\n'); api.copy(t); toast(`Copied ${S.selection.size} paths`); }
    else if (S.active) copyPath(S.active);
    return;
  }
  const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -grid.cols, ArrowDown: grid.cols };
  if (moves[e.key] !== undefined && S.entries.length) {
    e.preventDefault();
    const cur = S.entries.findIndex((x) => x.variants.some((v) => v.path === S.active));
    const i = Math.max(0, Math.min(S.entries.length - 1, (cur < 0 ? 0 : cur + moves[e.key])));
    scrollToEntry(S.entries[i]);
    S.anchor = i;
    openInspector(S.entries[i].model.path);
  }
  if (e.key === ' ' && S.active) {
    e.preventDefault();
    const en = S.entries.find((x) => x.variants.some((v) => v.path === S.active));
    if (en) toggleSelect(en);
  }
});

// ---------------------------------------------------------------------------- startup
(async () => {
  const cfg = await api.configGet();
  Object.assign(S.settings, cfg.settings || {});
  S.settings.thumbsPaused = false;
  S.recent = cfg.recent || [];
  $('#opt-collapse').checked = S.settings.collapse;
  $('#opt-pixel').checked = S.settings.pixelated;
  $('#opt-sort').value = S.settings.sort;
  $('#opt-size').value = S.settings.cardSize;
  document.documentElement.style.setProperty('--insp-w', S.settings.inspW + 'px');
  refresh();
  if (S.recent[0] && (await api.exists(S.recent[0]))) await openLibrary(S.recent[0]);
})();

// Exposed for automated tests / debugging (see docs/DEVELOPMENT.md).
window.app = { S, toggleHeart, openLibrary, openInspector, enterZoo, refresh, thumbs, opRemap, opApplyImage, opSetTextureFolder, missingTexturesModal, textureDirsModal, selectAll, clearSelection };
