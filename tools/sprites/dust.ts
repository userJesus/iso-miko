/**
 * Sheet de poeira (8 linhas × 8 frames, fundo verde): cada linha é a mesma nuvem vista
 * numa direção de movimento. A direção de cada linha é medida (rastro → nuvem) para o jogo
 * escolher a mais próxima do deslize; os frames são alinhados pela nuvem (parada no chão,
 * o rastro estica para trás).
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { CELL_PAD, DEBUG, DEBUG_DIR, ISO_ANGLES, median, type Dir } from './common.ts';
import { blit, chromaKey, labelComponents, loadRgb, newImg, removeSpecks, saveImg, type Img } from './image.ts';
import { segmentGrid } from './segment.ts';

interface DustFrame {
  img: Img;
  /** Centro da nuvem (parte densa e clara) dentro do recorte. */
  cx: number;
  cy: number;
  /** Base da nuvem (y), para apoiá-la no chão. */
  bottom: number;
  /** Centro de massa de tudo (nuvem + rastro). */
  mx: number;
  my: number;
  area: number;
  width: number;
}

function crop(src: Img, x0: number, y0: number, x1: number, y1: number): Img {
  const out = newImg(x1 - x0 + 1, y1 - y0 + 1);
  for (let y = y0; y <= y1; y++) out.px.set(src.px.subarray((y * src.w + x0) * 4, (y * src.w + x1 + 1) * 4), (y - y0) * out.w * 4);
  return out;
}

/**
 * Despill forte: poeira é bege/marrom (R > G > B). O verde do fundo que sobra nas bordas e
 * nas partículas finas vira oliva; G fica limitado à média de R e B (+12%).
 */
function despillEarth(img: Img) {
  for (let i = 0; i < img.w * img.h; i++) {
    const k = i * 4;
    if (img.px[k + 3] === 0) continue;
    const lim = ((img.px[k] + img.px[k + 2]) / 2) * 1.12;
    if (img.px[k + 1] > lim) img.px[k + 1] = lim;
  }
}

/**
 * Direção de uma linha: eixo principal (PCA) da forma — o rastro é longo e fino — com o
 * sentido apontando para a nuvem (parte clara). O realce no topo da nuvem não entra no
 * ângulo, só no sentido.
 */
function heading(f: DustFrame) {
  let sxx = 0, syy = 0, sxy = 0, n = 0;
  for (let y = 0; y < f.img.h; y++) {
    for (let x = 0; x < f.img.w; x++) {
      if (f.img.px[(y * f.img.w + x) * 4 + 3] < 128) continue;
      const dx = x - f.mx, dy = f.my - y;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy; n++;
    }
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ux = Math.cos(ang), uy = Math.sin(ang);
  if ((f.cx - f.mx) * ux + (f.my - f.cy) * uy < 0) { ux = -ux; uy = -uy; }
  return { x: ux, y: uy };
}

function analyze(img: Img): DustFrame | null {
  const lum: number[] = [];
  let mx = 0, my = 0, n = 0, x0 = Infinity, x1 = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const k = (y * img.w + x) * 4;
      if (img.px[k + 3] < 128) continue;
      lum.push(0.3 * img.px[k] + 0.59 * img.px[k + 1] + 0.11 * img.px[k + 2]);
      mx += x; my += y; n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
    }
  }
  if (n < 20) return null;
  // Nuvem: 30% mais claros (o rastro é de partículas marrons).
  const thr = [...lum].sort((a, b) => b - a)[Math.floor(lum.length * 0.3)];
  let cx = 0, cy = 0, c = 0;
  const ys: number[] = [];
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const k = (y * img.w + x) * 4;
      if (img.px[k + 3] < 128) continue;
      if (0.3 * img.px[k] + 0.59 * img.px[k + 1] + 0.11 * img.px[k + 2] < thr) continue;
      cx += x; cy += y; c++;
      ys.push(y);
    }
  }
  ys.sort((a, b) => a - b);
  return {
    img, cx: cx / c, cy: cy / c, bottom: ys[Math.floor(ys.length * 0.9)],
    mx: mx / n, my: my / n, area: n, width: x1 - x0 + 1,
  };
}

export interface DustMap {
  byDir: Partial<Record<Dir, number>>;
  burst: { right: number; left: number };
}

export async function processDust(file: string, outDir: string, name: string, map: DustMap) {
  const sheet = chromaKey(await loadRgb(file));
  removeSpecks(sheet, 4);
  const mask = new Uint8Array(sheet.w * sheet.h);
  for (let i = 0; i < mask.length; i++) mask[i] = sheet.px[i * 4 + 3] >= 128 ? 1 : 0;
  const { labels, areas } = labelComponents(mask, sheet.w, sheet.h);
  const COLS = 8, ROWS = 8;
  const { img, frames, slots } = segmentGrid(sheet, COLS, ROWS, labels, areas);
  despillEarth(img);

  const rows: (DustFrame | null)[][] = Array.from({ length: ROWS }, () => new Array(COLS).fill(null));
  frames.forEach((f, i) => {
    rows[Math.floor(slots[i] / COLS)][slots[i] % COLS] = analyze(crop(img, f.bx0, f.by0, f.bx1, f.by1));
  });

  // Célula comum ancorada na nuvem.
  let left = 0, right = 0, up = 0, down = 0;
  for (const f of rows.flat()) {
    if (!f) continue;
    left = Math.max(left, f.cx); right = Math.max(right, f.img.w - f.cx);
    up = Math.max(up, f.cy); down = Math.max(down, f.img.h - f.cy);
  }
  const ax = Math.ceil(left) + CELL_PAD, ay = Math.ceil(up) + CELL_PAD;
  const cellW = ax + Math.ceil(right) + CELL_PAD, cellH = ay + Math.ceil(down) + CELL_PAD;
  const atlas = newImg(cellW * COLS, cellH * ROWS);

  const outRows = rows.map((r, ri) => {
    const cells: number[] = [];
    r.forEach((f, ci) => {
      if (!f) return;
      blit(f.img, atlas, ci * cellW + Math.round(ax - f.cx), ri * cellH + Math.round(ay - f.cy));
      cells.push(ri * COLS + ci);
    });
    // Direção: média (frames grandes) do eixo rastro → nuvem, em tela com y para cima.
    const big = r.filter((f): f is DustFrame => !!f && f.area >= 0.5 * Math.max(...r.map((g) => g?.area ?? 0)));
    const hs = big.map(heading);
    const measured = Math.atan2(hs.reduce((a, h) => a + h.y, 0), hs.reduce((a, h) => a + h.x, 0));
    const peak = big.reduce((a, f) => (f.area > a.area ? f : a));
    return {
      measured,
      heading: +measured.toFixed(4),
      frames: cells,
      /** Largura da nuvem no frame mais cheio (px do atlas de efeito). */
      peakWidth: peak.width,
      /** Base da nuvem abaixo do centro (px): o jogo apoia a nuvem no chão. */
      lift: Math.round(median(big.map((f) => f.bottom - f.cy))),
    };
  });
  // Mapeamento declarado (verificado no atlas) + checagem pela direção medida.
  for (const [d, i] of Object.entries(map.byDir) as [Dir, number][]) {
    const want = ISO_ANGLES.find(([dd]) => dd === d)![1];
    const diff = Math.abs(Math.atan2(Math.sin(outRows[i].measured - want), Math.cos(outRows[i].measured - want)));
    if (diff > (25 * Math.PI) / 180) console.warn(`! dust: linha ${i} mapeada para ${d}, mas aponta ${Math.round((outRows[i].measured * 180) / Math.PI)}°`);
  }
  const manifest = {
    image: `${name}.webp`, cell: [cellW, cellH], anchor: [ax, ay], grid: [COLS, ROWS],
    rows: outRows.map(({ measured: _m, ...r }) => r),
    /** Linha de rastro por direção de movimento (desenhada para aquela direção: sem girar). */
    byDir: map.byDir,
    /** Estouro de impacto (partículas subindo) para quem se move para a direita/esquerda. */
    burst: map.burst,
  };
  await saveImg(atlas, path.join(outDir, `${name}.webp`));
  await fs.writeFile(path.join(outDir, `${name}.json`), JSON.stringify(manifest, null, 2));
  if (DEBUG) await saveImg(atlas, path.join(DEBUG_DIR, `fx_${name}.png`));
  console.log(`→ fx/${name}.webp ${atlas.w}×${atlas.h} (célula ${cellW}×${cellH}); direções das linhas: ` +
    outRows.map((r, i) => `L${i} ${Math.round((r.heading * 180) / Math.PI)}°`).join(' · ') +
    `\n  linha por direção: ${Object.entries(map.byDir).map(([d, i]) => `${d}=L${i}`).join(' ')} · impacto: L${map.burst.right}/L${map.burst.left}\n`);
}
