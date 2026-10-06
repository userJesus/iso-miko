/** Geometria 2D e transformada de distância. */
export type Pt = [number, number];

export function pointInPoly(x: number, y: number, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function bbox(poly: Pt[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/** Rasteriza um polígono numa máscara (callback por pixel dentro), com recorte por bbox. */
export function rasterPoly(poly: Pt[], scale: number, w: number, h: number, fn: (i: number, x: number, y: number) => void) {
  const p = poly.map(([x, y]) => [x * scale, y * scale] as Pt);
  const b = bbox(p);
  const xa = Math.max(0, Math.floor(b.x0)), xb = Math.min(w - 1, Math.ceil(b.x1));
  const ya = Math.max(0, Math.floor(b.y0)), yb = Math.min(h - 1, Math.ceil(b.y1));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) if (pointInPoly(x + 0.5, y + 0.5, p)) fn(y * w + x, x, y);
  }
}

/**
 * Transformada de distância euclidiana exata (Felzenszwalb & Huttenlocher), em células.
 * `seed[i]` = 1 nas células de distância zero. Devolve a distância (não o quadrado).
 */
export function edt(seed: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e20;
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = seed[i] ? 0 : INF;
  const pass = (n: number) => {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    pass(h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(grid[i]);
  return out;
}

/** Componentes 4-conexas de uma máscara; devolve rótulos e áreas. */
export function components(mask: Uint8Array, w: number, h: number) {
  const labels = new Int32Array(w * h).fill(-1);
  const areas: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s] >= 0) continue;
    const id = areas.length;
    let n = 0;
    labels[s] = id;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      n++;
      const x = p % w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
      for (const q of nb) if (q >= 0 && q < w * h && mask[q] && labels[q] < 0) { labels[q] = id; stack.push(q); }
    }
    areas.push(n);
  }
  return { labels, areas };
}
