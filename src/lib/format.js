// Small display formatters shared by the library UI and the zoo.

/** Formats [x, y, z] metres as "1.49 × 1.07 × 0.99 m" (or cm for small objects). */
export function fmtDims(size) {
  const max = Math.max(...size);
  const [unit, f] = max < 1 ? ['cm', 100] : ['m', 1];
  const n = (v) => { const x = v * f; return x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2); };
  return `${size.map(n).join(' × ')} ${unit}`;
}
