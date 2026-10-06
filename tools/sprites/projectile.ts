/**
 * Sheet de projétil (grade de efeitos, fundo verde): extrai a linha de voo para a direita
 * (o jogo rotaciona o sprite para a direção real na tela) e a linha de chama "segurada"
 * (labaredas para cima), alinhando cada frame pelo núcleo branco da bola.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { CELL_PAD, DEBUG, DEBUG_DIR, median } from './common.ts';
import { blit, chromaKey, loadRgb, newImg, removeSpecks, saveImg, type Img } from './image.ts';
import { mergeNarrow, runs } from './segment.ts';

interface FxFrame {
  img: Img;
  /** Núcleo (centro da bola) dentro do recorte. */
  cx: number;
  cy: number;
  area: number;
  /** Direção cauda → cabeça (unitária), em px de imagem (y para baixo). */
  hx: number;
  hy: number;
}

function crop(src: Img, x0: number, y0: number, x1: number, y1: number): Img {
  const out = newImg(x1 - x0 + 1, y1 - y0 + 1);
  for (let y = y0; y <= y1; y++) {
    out.px.set(src.px.subarray((y * src.w + x0) * 4, (y * src.w + x1 + 1) * 4), (y - y0) * out.w * 4);
  }
  return out;
}

function analyze(img: Img): FxFrame | null {
  let ax = 0, ay = 0, an = 0, kx = 0, ky = 0, kn = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const k = (y * img.w + x) * 4;
      const a = img.px[k + 3] / 255;
      if (a < 0.5) continue;
      ax += x; ay += y; an++;
      const lum = 0.3 * img.px[k] + 0.59 * img.px[k + 1] + 0.11 * img.px[k + 2];
      // Núcleo: quase branco (o miolo da bola).
      if (lum > 232 && img.px[k + 2] > 150) { kx += x; ky += y; kn++; }
    }
  }
  if (an < 30) return null;
  const mx = ax / an, my = ay / an;
  const cx = kn >= 8 ? kx / kn : mx, cy = kn >= 8 ? ky / kn : my;
  const hl = Math.hypot(cx - mx, cy - my) || 1;
  return { img, cx, cy, area: an, hx: (cx - mx) / hl, hy: (cy - my) / hl };
}

/** Raio da bola: distância do núcleo até a borda na direção da cabeça. */
function ballRadius(f: FxFrame) {
  let r = 0;
  for (let t = 0; t < 200; t++) {
    const x = Math.round(f.cx + f.hx * t), y = Math.round(f.cy + f.hy * t);
    if (x < 0 || y < 0 || x >= f.img.w || y >= f.img.h) break;
    if (f.img.px[(y * f.img.w + x) * 4 + 3] >= 128) r = t;
  }
  return r;
}

export async function processProjectile(file: string, outDir: string, name: string) {
  const sheet = chromaKey(await loadRgb(file));
  removeSpecks(sheet, 6);
  const { w, h } = sheet;

  const rowProf = new Array(h).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (sheet.px[(y * w + x) * 4 + 3] >= 128) rowProf[y]++;
  const bands = mergeNarrow(runs(rowProf, 4), 40);

  // Colunas: projeção dentro de cada faixa; partículas soltas da cauda são juntadas ao vizinho.
  const rows: FxFrame[][] = bands.map((band) => {
    const colProf = new Array(w).fill(0);
    for (let y = band.a; y <= band.b; y++) for (let x = 0; x < w; x++) if (sheet.px[(y * w + x) * 4 + 3] >= 128) colProf[x]++;
    const cols = mergeNarrow(runs(colProf, 10), 40);
    return cols
      .map((c) => analyze(crop(sheet, c.a, band.a, c.b, band.b)))
      .filter((f): f is FxFrame => !!f);
  });

  // Direção média cauda → cabeça de cada linha.
  const heading = rows.map((fs) => {
    const big = fs.filter((f) => f.area >= 0.6 * Math.max(...fs.map((g) => g.area)));
    const hx = median(big.map((f) => f.hx)), hy = median(big.map((f) => f.hy));
    return { hx, hy };
  });
  // Voo: cabeça mais apontada para a direita. Segurada: cabeça (núcleo) para baixo, chamas para cima.
  const flightRow = heading.reduce((b, d, i) => (d.hx > heading[b].hx ? i : b), 0);
  const heldRow = heading.reduce((b, d, i) => (d.hy > heading[b].hy ? i : b), 0);
  console.log(`fx/${name}: ${rows.length} linhas; voo = linha ${flightRow} (${rows[flightRow].length}f), ` +
    `segurada = linha ${heldRow} (${rows[heldRow].length}f)`);

  const pick = [rows[flightRow], rows[heldRow]];
  // Célula comum ancorada no núcleo.
  let left = 0, right = 0, up = 0, down = 0;
  for (const f of pick.flat()) {
    left = Math.max(left, f.cx); right = Math.max(right, f.img.w - f.cx);
    up = Math.max(up, f.cy); down = Math.max(down, f.img.h - f.cy);
  }
  const ax = Math.ceil(left) + CELL_PAD, ay = Math.ceil(up) + CELL_PAD;
  const cellW = ax + Math.ceil(right) + CELL_PAD, cellH = ay + Math.ceil(down) + CELL_PAD;
  const cols = Math.max(...pick.map((r) => r.length));
  const atlas = newImg(cellW * cols, cellH * pick.length);
  pick.forEach((r, ri) => r.forEach((f, ci) => {
    blit(f.img, atlas, ci * cellW + Math.round(ax - f.cx), ri * cellH + Math.round(ay - f.cy));
  }));

  // Frames "cheios" formam o laço; os que encolhem (< 65% da área) são a dissipação.
  const describe = (r: FxFrame[], ri: number) => {
    const maxA = Math.max(...r.map((f) => f.area));
    const cells = r.map((_, ci) => ri * cols + ci);
    const loop = cells.filter((_, ci) => r[ci].area >= 0.65 * maxA);
    const fade = cells.filter((_, ci) => r[ci].area < 0.65 * maxA);
    const radius = median(r.filter((f) => f.area >= 0.65 * maxA).map(ballRadius));
    return { loop, dissipate: fade, ballRadius: radius };
  };
  const manifest = {
    image: `${name}.webp`,
    cell: [cellW, cellH],
    anchor: [ax, ay],
    grid: [cols, pick.length],
    /** Voa para a direita (+x da tela); o jogo rotaciona para a direção do disparo. */
    flight: describe(pick[0], 0),
    /** Chama segurada na mão (labaredas para cima). */
    held: describe(pick[1], 1),
  };
  await saveImg(atlas, path.join(outDir, `${name}.webp`));
  await fs.writeFile(path.join(outDir, `${name}.json`), JSON.stringify(manifest, null, 2));
  if (DEBUG) await saveImg(atlas, path.join(DEBUG_DIR, `fx_${name}.png`));
  console.log(`→ fx/${name}.webp ${atlas.w}×${atlas.h} (célula ${cellW}×${cellH}) voo ${JSON.stringify(manifest.flight)} segurada ${JSON.stringify(manifest.held)}\n`);
}
