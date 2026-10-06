/**
 * Ações de corpo inteiro que saem da corrida e voltam a ela (deslize): escala pelas poses
 * em pé, âncora no centro de massa, fases detectadas pela altura e sincronia de pose com
 * a ação em laço (entrada e saída sem "estalo").
 */
import { DIRECTIONS, median, type Dir } from './common.ts';
import type { NormFrame, SheetData } from './align.ts';
import { anchoredSignature, sigDist } from './cycle.ts';
import { alphaAt, type Img } from './image.ts';

const heightOf = (nf: NormFrame) => nf.raw.by1 - nf.raw.by0 + 1;

/**
 * Escala por linha da sheet medida no frame mais alto da linha (pose em pé). A IA muda a
 * escala entre linhas; linhas sem pose em pé (personagem deitada) usam a média das outras.
 */
export function normalizeTallestRow(sheet: SheetData, targetH: number): NormFrame[] {
  const rows = new Map<number, number[]>();
  sheet.frames.forEach((f, i) => {
    if (!rows.has(f.y0)) rows.set(f.y0, []);
    rows.get(f.y0)!.push(i);
  });
  const h = sheet.frames.map((f) => f.by1 - f.by0 + 1);
  const hMax = Math.max(...h);
  const rowScale = new Map<number, number>();
  for (const [y0, idx] of rows) {
    const tallest = Math.max(...idx.map((i) => h[i]));
    if (tallest >= 0.85 * hMax) rowScale.set(y0, targetH / tallest);
  }
  const mean = [...rowScale.values()].reduce((a, b) => a + b, 0) / rowScale.size;
  return sheet.frames.map((raw) => ({ raw, s: rowScale.get(raw.y0) ?? mean, ax: raw.torsoX, ay: raw.by1 + 1 }));
}

/** Inclinação na tela (dy/dx, y para baixo) de uma linha no chão na direção `dir` (isométrico 2:1). */
export function groundSlope(dir: Dir) {
  const a = (DIRECTIONS.indexOf(dir) * Math.PI) / 4;
  const dx = Math.sin(a), dy = -Math.cos(a) * 0.5;
  return Math.abs(dx) < 1e-6 ? 0 : dy / dx;
}

/**
 * Âncora no centro de massa da silhueta (o quadril, no corpo deitado): é o ponto que
 * desliza de forma contínua; as pernas avançando à frente dele fazem parte da pose.
 * - x: centróide, com correção linear para coincidir com o tronco no 1º e no último frame
 *   (que emendam com a corrida, ancorada no tronco);
 * - y: chão sob o centróide. Deitada numa diagonal, o pé à frente fica mais baixo na tela
 *   que o quadril; a linha do chão passa pelo ponto mais baixo com a inclinação da direção.
 */
export function centroidAnchors(sheet: SheetData, frames: NormFrame[], dir: Dir) {
  const { img } = sheet;
  const slope = groundSlope(dir);
  const hMax = Math.max(...frames.map(heightOf));
  const cy: number[] = [];
  const cx = frames.map((nf) => {
    const f = nf.raw;
    let sx = 0, sy = 0, n = 0;
    for (let y = f.by0; y <= f.by1; y++) {
      for (let x = f.bx0; x <= f.bx1; x++) {
        const a = alphaAt(img, x, y);
        if (a >= 128) { sx += x; sy += y; n++; }
      }
    }
    cy.push(sy / n);
    return sx / n;
  });
  const last = frames.length - 1;
  const off0 = frames[0].raw.torsoX - cx[0], offN = frames[last].raw.torsoX - cx[last];
  frames.forEach((nf, k) => {
    const f = nf.raw;
    nf.ax = cx[k] + off0 + ((offN - off0) * k) / last;
    // x médio dos pixels mais baixos (3 px) — o ponto de contato com o chão
    let sx = 0, n = 0;
    for (let y = f.by1 - 2; y <= f.by1; y++) {
      for (let x = f.bx0; x <= f.bx1; x++) if (alphaAt(img, x, y) >= 128) { sx += x; n++; }
    }
    const xLow = sx / n;
    // Só nas poses baixas (corpo no chão); em pé o pé está sob o corpo.
    const lying = Math.min(1, Math.max(0, (0.9 - heightOf(nf) / hMax) / 0.2));
    nf.ay = f.by1 + 1 + (nf.ax - xLow) * slope * lying;
  });
  // No chão o quadril desliza a uma altura quase constante: um frame em que o "ponto mais
  // baixo" é uma mão esticada não deve afundar o corpo. Mediana de 3 na altura do centro
  // de massa dos frames deitados (desvios > 3 px).
  const lift = frames.map((nf, k) => (nf.ay - cy[k]) * nf.s);
  frames.forEach((nf, k) => {
    if (k === 0 || k === last || heightOf(nf) > 0.75 * hMax) return;
    const m = median([lift[k - 1], lift[k], lift[k + 1]]);
    if (Math.abs(m - lift[k]) > 3) nf.ay += (m - lift[k]) / nf.s;
  });
}

export interface SlidePhases {
  /** Primeiro frame da descida ao chão. */
  contact: number;
  /** Primeiro frame da subida. */
  rise: number;
  /** Quanto o corpo está deitado em cada frame (0 em pé … 1 no ponto mais baixo). */
  lie: number[];
}

/** Fases pela altura da silhueta: entrada (alta) → chão (baixa) → subida. */
export function slidePhases(heights: number[]): SlidePhases {
  const hMax = Math.max(...heights), hMin = Math.min(...heights);
  const kMin = heights.indexOf(hMin);
  const contactThr = hMin + 0.6 * (hMax - hMin), riseThr = hMin + 0.35 * (hMax - hMin);
  let contact = heights.findIndex((h) => h < contactThr);
  if (contact < 1) contact = 1;
  let rise = kMin;
  while (rise + 1 < heights.length && heights[rise + 1] < riseThr) rise++;
  rise = Math.min(heights.length - 2, rise + 1);
  const lie = heights.map((h) => +Math.min(1, Math.max(0, (hMax - h) / (hMax - hMin))).toFixed(2));
  return { contact, rise, lie };
}

export interface LinkInput {
  cells: Img[];
  anchor: [number, number];
  height: number;
  phases: SlidePhases;
  loopCells: Img[];
  /** Índices em `loopCells`, na ordem do laço (fase 0 = posição 0). */
  loopOrder: number[];
  loopAnchor: [number, number];
  idleCell: Img | null;
  idleAnchor: [number, number];
}

export interface LinkOut {
  /** Para cada posição do laço: [frames do laço a esperar, frame de entrada]. */
  entry: [number, number][];
  /** Frame depois do qual, sem direção pressionada, ela fica parada. */
  idleExit: number;
  /** Frame depois do qual, com direção pressionada, ela volta a correr… */
  runExit: number;
  /** …nesta fase do laço. */
  runExitPhase: number;
  /** Distâncias de pose (diagnóstico). */
  quality: { entry: number; runExit: number; idleExit: number; step: number };
}

/**
 * Sincronia com o laço da corrida, por semelhança de pose numa janela ancorada nos pés.
 * - entrada: ao apertar na posição j do laço, espera até 2 frames (troca latência por
 *   encaixe) e entra no frame e da entrada do deslize mais parecido;
 * - saída: par (frame final do deslize, posição do laço) mais parecido;
 * - parada: frame da subida mais parecido com a pose parada.
 */
export function linkTransitions(o: LinkInput): LinkOut {
  const H = o.height;
  const sig = o.cells.map((c) => anchoredSignature(c, o.anchor[0], o.anchor[1], H));
  const loopSig = o.loopOrder.map((i) => anchoredSignature(o.loopCells[i], o.loopAnchor[0], o.loopAnchor[1], H));
  const L = loopSig.length, n = sig.length;
  const steps = loopSig.map((s, j) => sigDist(s, loopSig[(j + 1) % L]));
  const step = median(steps);

  const entry: [number, number][] = [];
  const entryD: number[] = [];
  for (let j = 0; j < L; j++) {
    let best: [number, number] = [0, 0], bestCost = Infinity, bestD = Infinity;
    for (let d = 0; d <= 2; d++) {
      for (let e = 0; e < o.phases.contact; e++) {
        const dist = sigDist(loopSig[(j + d) % L], sig[e]);
        const cost = dist + 0.25 * step * d;
        if (cost < bestCost) { bestCost = cost; best = [d, e]; bestD = dist; }
      }
    }
    entry.push(best);
    entryD.push(bestD);
  }

  let runExit = n - 1, runJ = 0, runBest = Infinity, runD = Infinity;
  for (let k = Math.max(o.phases.rise, n - 4); k < n; k++) {
    for (let j = 0; j < L; j++) {
      const dist = sigDist(sig[k], loopSig[j]);
      const cost = dist + 0.15 * step * (n - 1 - k);
      if (cost < runBest) { runBest = cost; runExit = k; runJ = j; runD = dist; }
    }
  }

  // Parada: o primeiro frame da subida já em pé (os seguintes são passadas de corrida).
  let idleExit = o.phases.lie.findIndex((l, k) => k >= o.phases.rise && l <= 0.3);
  if (idleExit < 0) idleExit = n - 1;
  const idleD = o.idleCell
    ? sigDist(sig[idleExit], anchoredSignature(o.idleCell, o.idleAnchor[0], o.idleAnchor[1], H))
    : Infinity;

  return {
    entry, idleExit, runExit,
    // O frame de saída equivale à posição runJ; o próximo exibido é runJ + 1.
    runExitPhase: +(((runJ + 1) % L) / L).toFixed(4),
    quality: { entry: median(entryD) / step, runExit: runD / step, idleExit: idleD / step, step },
  };
}
