/** Normalização de escala e alinhamento (registro) dos frames de uma direção. */
import { ATLAS_SCALE, median, type Dir } from './common.ts';
import { alphaAt, blitScaled, newImg, type Img } from './image.ts';
import type { RawFrame } from './segment.ts';

export interface SheetData {
  action: string;
  dir: Dir;
  img: Img;
  frames: RawFrame[];
}

export interface NormFrame {
  raw: RawFrame;
  /** Escala fonte → espaço normalizado (altura-alvo da ação). */
  s: number;
  /** Âncora na sheet: centro do tronco (x) e linha do chão (y). */
  ax: number;
  ay: number;
}

export function heightOf(f: RawFrame) {
  return f.by1 - f.by0 + 1;
}

/**
 * A IA desenha cada linha da sheet numa escala um pouco diferente (até ~8%).
 * Normaliza cada linha pela mediana da sua altura → todas as linhas, e todas as
 * direções da ação, ficam com a mesma altura média. A variação dentro da linha
 * (sobe-e-desce natural da passada) é preservada.
 */
export function normalizeScale(sheet: SheetData, targetH: number): NormFrame[] {
  const rows = new Map<number, RawFrame[]>();
  for (const f of sheet.frames) {
    if (!rows.has(f.y0)) rows.set(f.y0, []);
    rows.get(f.y0)!.push(f);
  }
  const rowMed = new Map<number, number>();
  for (const [k, fs] of rows) rowMed.set(k, median(fs.map(heightOf)));
  return sheet.frames.map((raw) => ({
    raw,
    s: targetH / rowMed.get(raw.y0)!,
    ax: raw.torsoX,
    ay: raw.by1 + 1,
  }));
}

/**
 * Silhueta (alfa) de uma faixa horizontal em coordenadas normalizadas relativas à âncora,
 * entre y0 e y1 (negativos = acima do chão). Usada para registrar frames entre si.
 */
export function silhouetteBand(img: Img, nf: NormFrame, y0: number, y1: number, halfW: number) {
  const w = halfW * 2, h = y1 - y0;
  const out = new Float32Array(w * h);
  const f = nf.raw;
  for (let j = 0; j < h; j++) {
    const sy = Math.floor(nf.ay + (y0 + j + 0.5) / nf.s);
    if (sy < f.y0 || sy > f.y1) continue;
    for (let i = 0; i < w; i++) {
      const sx = Math.floor(nf.ax + (i - halfW + 0.5) / nf.s);
      if (sx < f.x0 || sx > f.x1) continue;
      out[j * w + i] = alphaAt(img, sx, sy) / 255;
    }
  }
  return { data: out, w, h };
}

/**
 * Registro horizontal: alinha o tronco de cada frame à silhueta média da direção.
 * Remove o "tremido" lateral da IA sem depender do balanço dos braços (que puxa um centróide).
 */
export function registerTorso(sheet: SheetData, frames: NormFrame[], targetH: number) {
  const halfW = 90, maxShift = 14;
  for (let iter = 0; iter < 3; iter++) {
    // Tronco: 15%–55% da altura (abaixo do cabelo esvoaçante, acima das pernas).
    const y0 = Math.round(-targetH * 0.85), y1 = Math.round(-targetH * 0.45);
    const bands = frames.map((nf) => silhouetteBand(sheet.img, nf, y0, y1, halfW + maxShift));
    const { w, h } = bands[0];
    const mean = new Float32Array(w * h);
    for (const b of bands) for (let i = 0; i < mean.length; i++) mean[i] += b.data[i] / bands.length;
    frames.forEach((nf, k) => {
      const b = bands[k];
      let best = 0, bestErr = Infinity;
      for (let dx = -maxShift; dx <= maxShift; dx++) {
        let err = 0;
        for (let y = 0; y < h; y++) {
          for (let x = maxShift; x < w - maxShift; x++) {
            err += Math.abs(b.data[y * w + x + dx] - mean[y * w + x]);
          }
        }
        if (err < bestErr) { bestErr = err; best = dx; }
      }
      // Desloca a âncora: o conteúdo em +dx deve ir para 0.
      nf.ax += best / nf.s;
    });
  }
}

/**
 * Registro vertical pela metade de cima (cabeça, ombros, tronco) contra a média da direção,
 * depois linha do chão no nível dos pés dos frames de contato: no voo os pés sobem,
 * a cabeça não afunda.
 */
export function registerVertical(sheet: SheetData, frames: NormFrame[], targetH: number) {
  const halfW = 90, maxDy = 28;
  const y0 = Math.round(-targetH * 1.04) - maxDy, y1 = Math.round(-targetH * 0.5) + maxDy;
  for (let iter = 0; iter < 3; iter++) {
    const bands = frames.map((nf) => silhouetteBand(sheet.img, nf, y0, y1, halfW));
    const { w, h } = bands[0];
    const mean = new Float32Array(w * h);
    for (const b of bands) for (let i = 0; i < mean.length; i++) mean[i] += b.data[i] / bands.length;
    frames.forEach((nf, k) => {
      const b = bands[k];
      let best = 0, bestErr = Infinity;
      for (let dy = -maxDy; dy <= maxDy; dy++) {
        let err = 0;
        for (let y = maxDy; y < h - maxDy; y++) {
          const ro = (y + dy) * w, rm = y * w;
          for (let x = 0; x < w; x++) err += Math.abs(b.data[ro + x] - mean[rm + x]);
        }
        if (err < bestErr) { bestErr = err; best = dy; }
      }
      nf.ay += best / nf.s;
    });
  }
  // Profundidade do pé mais baixo em relação à âncora (positivo = abaixo).
  const foot = frames.map((nf) => (nf.raw.by1 + 1 - nf.ay) * nf.s);
  // Chão = nível típico dos frames de contato (os ~30% com pé mais baixo).
  const sorted = [...foot].sort((a, b) => a - b);
  const ground = sorted[Math.floor(sorted.length * 0.7)];
  frames.forEach((nf) => (nf.ay += ground / nf.s));
  return foot.map((f) => +(ground - f).toFixed(1));
}

/**
 * Para ações alinhadas pelos pés: remove saltos isolados da cabeça (glitch da IA num frame)
 * puxando a altura de cada frame para a mediana dos 5 vizinhos na sequência da sheet.
 * Desvios pequenos (o sobe-e-desce natural da passada) são mantidos.
 */
export function despikeVertical(frames: NormFrame[], tolerance = 2) {
  const n = frames.length;
  const head = frames.map((nf) => (nf.ay - nf.raw.by0) * nf.s);
  const fixes: number[] = [];
  frames.forEach((nf, k) => {
    const win = [-2, -1, 0, 1, 2].map((o) => head[(k + o + n) % n]);
    const d = median(win) - head[k];
    if (Math.abs(d) > tolerance) {
      const c = d - Math.sign(d) * tolerance;
      nf.ay += c / nf.s;
      fixes.push(Math.round(c));
    } else fixes.push(0);
  });
  return fixes;
}

/** Renderiza um frame normalizado numa célula do atlas. */
export function renderCell(sheet: SheetData, nf: NormFrame, cellW: number, cellH: number, anchorX: number, anchorY: number): Img {
  const cell = newImg(cellW, cellH);
  const f = nf.raw;
  blitScaled(sheet.img, cell, nf.ax, nf.ay, anchorX, anchorY, nf.s * ATLAS_SCALE, { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 });
  return cell;
}
