// Path helpers that work on both POSIX and Windows paths inside the renderer.
// Internally we compare "keys": forward-slash, lower-cased paths.

export const norm = (p) => p.replace(/\\/g, '/');
export const key = (p) => norm(p).toLowerCase();

export function basename(p) {
  const s = norm(p);
  return s.slice(s.lastIndexOf('/') + 1);
}

export function dirname(p) {
  const s = norm(p);
  const i = s.lastIndexOf('/');
  if (i < 0) return '';
  if (i === 0) return '/';
  return s.slice(0, i);
}

export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i).toLowerCase() : '';
}

export function stem(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}

export function join(dir, rel) {
  const d = norm(dir).replace(/\/+$/, '');
  return d + '/' + norm(rel).replace(/^\/+/, '');
}

/** Converts a native path to the app's mfile:// URL (see main.js for the layout). */
export function toUrl(p) {
  let s = norm(p);
  if (s.startsWith('//')) s = '/UNC/' + s.slice(2);
  else if (!s.startsWith('/')) s = '/' + s;
  return 'mfile://local' + s.split('/').map(encodeURIComponent).join('/');
}

const PREFIX = 'mfile://local';

/**
 * Converts an mfile:// URL back to a forward-slash path. Loaders sometimes append raw,
 * un-encoded file names (with spaces, '#', '%'...) to a base URL, so decode per segment.
 */
export function fromUrl(u) {
  if (!u.startsWith(PREFIX)) return null;
  const rest = u.slice(PREFIX.length);
  let p = rest.split('/').map(safeDecode).join('/');
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  else if (p.startsWith('/UNC/')) p = '//' + p.slice(5);
  return p;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Converts a forward-slash path back to the platform's native form (for clipboard etc.). */
export function toNative(p) {
  return window.api?.platform === 'win32' ? p.replace(/\//g, '\\') : p;
}

/** Segments of a path key, for proximity scoring. */
export const segments = (p) => key(p).split('/').filter(Boolean);
