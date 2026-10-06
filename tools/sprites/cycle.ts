/** Assinaturas de pose, período do passo e detecção de laço. */
import { median } from './common.ts';
import type { Img } from './image.ts';

/** Assinatura de pose (frame inteiro reduzido) para medir distância entre frames. */
export function poseSignature(frame: Img, gw = 40, gh = 64) {
  const sig = new Float32Array(gw * gh * 2);
  const cw = frame.w / gw, ch = frame.h / gh;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let a = 0, l = 0, n = 0;
      for (let y = Math.floor(gy * ch); y < Math.floor((gy + 1) * ch); y++) {
        for (let x = Math.floor(gx * cw); x < Math.floor((gx + 1) * cw); x++) {
          const k = (y * frame.w + x) * 4;
          const al = frame.px[k + 3] / 255;
          a += al;
          l += al * (0.3 * frame.px[k] + 0.59 * frame.px[k + 1] + 0.11 * frame.px[k + 2]) / 255;
          n++;
        }
      }
      sig[(gy * gw + gx) * 2] = a / n;
      sig[(gy * gw + gx) * 2 + 1] = l / n;
    }
  }
  return sig;
}

export function sigDist(a: Float32Array, b: Float32Array) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

export interface LoopResult { start: number; length: number; closure: number; step: number }

/**
 * Período de um passo (em frames): mínimo da autocorrelação da região das pernas.
 * Em vista lateral a perna esquerda e a direita quase se confundem, então a pose
 * se repete a cada passo — o ciclo completo tem 2 passos.
 */
export function lagProfile(dist: number[][], maxLag: number) {
  const prof: number[] = [];
  for (let k = 1; k <= maxLag; k++) {
    let s = 0, n = 0;
    for (let i = 0; i + k < dist.length; i++) { s += dist[i][i + k]; n++; }
    prof.push(n ? s / n : Infinity);
  }
  return prof;
}

/**
 * Laço de ciclo completo (2 passos): comprimento entre 2P−2 e 2P frames, escolhendo
 * o início/fim cujo fechamento (último → primeiro) mais se parece com um passo normal.
 */
export function detectLoop(dist: number[][], period: number): LoopResult {
  const n = dist.length;
  const steps = [];
  for (let i = 0; i + 1 < n; i++) steps.push(dist[i][i + 1]);
  const step = median(steps);
  const maxL = Math.min(n, 2 * period), minL = Math.max(4, maxL - 2);
  let best: LoopResult = { start: 0, length: maxL, closure: Infinity, step };
  let bestScore = Infinity;
  for (let L = minL; L <= maxL; L++) {
    for (let s = 0; s + L <= n; s++) {
      const closure = dist[s + L - 1][s] / step;
      // Leve preferência por laços com mais frames (mais suaves).
      const score = closure + 0.08 * (maxL - L);
      if (score < bestScore) { bestScore = score; best = { start: s, length: L, closure, step }; }
    }
  }
  return best;
}

/**
 * Altura da silhueta (âncora → topo) e largura da faixa dos pés, medidas na célula.
 * A faixa dos pés é relativa ao ponto mais baixo do próprio frame (no voo os pés
 * estão acima da linha do chão).
 */
export function cellMetrics(cell: Img, anchorY: number) {
  let top = Infinity, bottom = -1;
  const opaque = (x: number, y: number) => cell.px[(y * cell.w + x) * 4 + 3] >= 128;
  for (let y = 0; y < cell.h; y++) {
    for (let x = 0; x < cell.w; x++) {
      if (!opaque(x, y)) continue;
      if (y < top) top = y;
      bottom = y;
    }
  }
  let fx0 = Infinity, fx1 = -1;
  for (let y = Math.round(bottom - cell.h * 0.06); y <= bottom; y++) {
    for (let x = 0; x < cell.w; x++) if (opaque(x, y)) { if (x < fx0) fx0 = x; if (x > fx1) fx1 = x; }
  }
  return { height: anchorY - top, feetSpan: fx1 >= 0 ? fx1 - fx0 + 1 : 0 };
}

/**
 * Subconjunto cíclico ordenado de `keep` frames do laço que minimiza o salto frame a frame
 * dos braços (e, com peso menor, das pernas). Para direções em que a arte desenha as mãos
 * em posições incoerentes de um frame para o outro: descarta os frames que mais "saltam",
 * mantendo a ordem temporal (a passada continua progredindo). O 1º frame (pose de
 * passagem, fase 0) é mantido. Pula no máximo 2 frames seguidos.
 */
export function smoothSubset(cells: Img[], order: number[], keep: number, anchorY: number, height: number) {
  const n = order.length;
  const band = (c: Img, f0: number, f1: number) => {
    const y0 = Math.max(0, Math.round(anchorY - height * f1)), y1 = Math.min(c.h, Math.round(anchorY - height * f0));
    const out: Img = { w: c.w, h: y1 - y0, px: c.px.subarray(y0 * c.w * 4, y1 * c.w * 4) as unknown as Uint8ClampedArray };
    return poseSignature(out, 24, 16);
  };
  const arms = order.map((i) => band(cells[i], 0.35, 0.68));
  const legs = order.map((i) => band(cells[i], 0, 0.3));
  const D = (i: number, j: number) => sigDist(arms[i], arms[j]) + 0.7 * sigDist(legs[i], legs[j]);
  const MAX_GAP = 3;
  const dp = Array.from({ length: keep }, () => new Array(n).fill(Infinity));
  const from = Array.from({ length: keep }, () => new Array(n).fill(-1));
  dp[0][0] = 0;
  for (let k = 1; k < keep; k++) {
    for (let j = k; j < n; j++) {
      for (let i = Math.max(k - 1, j - MAX_GAP); i < j; i++) {
        const c = dp[k - 1][i] + D(i, j);
        if (c < dp[k][j]) { dp[k][j] = c; from[k][j] = i; }
      }
    }
  }
  let bestJ = -1, best = Infinity;
  for (let j = Math.max(keep - 1, n - MAX_GAP); j < n; j++) {
    const c = dp[keep - 1][j] + D(j, 0);
    if (c < best) { best = c; bestJ = j; }
  }
  const seq = [bestJ];
  for (let k = keep - 1; k > 0; k--) seq.unshift(from[k][seq[0]]);
  const armJump = (s: number[]) => s.reduce((acc, x, i) => acc + sigDist(arms[x], arms[s[(i + 1) % s.length]]), 0) / s.length;
  return {
    order: seq.map((x) => order[x]),
    before: armJump(order.map((_, i) => i)),
    after: armJump(seq),
  };
}

/**
 * Assinatura de pose numa janela fixa em torno da âncora (pés), em unidades da altura da
 * personagem — comparável entre ações com células de tamanhos diferentes.
 */
export function anchoredSignature(cell: Img, ax: number, ay: number, height: number, gw = 22, gh = 26) {
  const x0 = ax - 0.6 * height, x1 = ax + 0.6 * height;
  const y0 = ay - 1.12 * height, y1 = ay + 0.04 * height;
  const sig = new Float32Array(gw * gh * 2);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let a = 0, l = 0, n = 0;
      const ya = Math.floor(y0 + (gy * (y1 - y0)) / gh), yb = Math.floor(y0 + ((gy + 1) * (y1 - y0)) / gh);
      const xa = Math.floor(x0 + (gx * (x1 - x0)) / gw), xb = Math.floor(x0 + ((gx + 1) * (x1 - x0)) / gw);
      for (let y = ya; y < yb; y++) {
        for (let x = xa; x < xb; x++) {
          n++;
          if (x < 0 || y < 0 || x >= cell.w || y >= cell.h) continue;
          const k = (y * cell.w + x) * 4;
          const al = cell.px[k + 3] / 255;
          a += al;
          l += (al * (0.3 * cell.px[k] + 0.59 * cell.px[k + 1] + 0.11 * cell.px[k + 2])) / 255;
        }
      }
      sig[(gy * gw + gx) * 2] = n ? a / n : 0;
      sig[(gy * gw + gx) * 2 + 1] = n ? l / n : 0;
    }
  }
  return sig;
}
