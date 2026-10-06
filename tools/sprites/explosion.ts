/**
 * Sheet de explosão (8 linhas × 8 frames, fundo verde): cada linha é a bola chegando numa
 * direção (`approach` frames) e explodindo ao bater (o resto). A direção de cada linha é
 * medida na bola (cauda → núcleo branco); para cada uma das 8 direções do isométrico vai
 * para o atlas a linha, ou o espelho dela, que mais se aproxima. A sheet não tem todas:
 * duas linhas apontam para SE e nenhuma para SO.
 * Frames alinhados pelo núcleo branco: no 1º frame da explosão é onde a bola tocou, e a
 * distância núcleo → base quase não muda (a explosão fica plantada na superfície).
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { CELL_PAD, DEBUG, DEBUG_DIR, ISO_ANGLES, median, type Dir } from './common.ts';
import { blit, chromaKey, flipH, labelComponents, loadRgb, newImg, removeSpecks, saveImg, type Img } from './image.ts';
import { segmentGrid } from './segment.ts';

interface ExpFrame {
  img: Img;
  /** Núcleo dentro do recorte (null = sem miolo branco: frames finais, quase só faíscas). */
  core: { x: number; y: number } | null;
  /** Centro de massa e base (y do 95º percentil). */
  mx: number;
  my: number;
  base: number;
  area: number;
}

function crop(src: Img, x0: number, y0: number, x1: number, y1: number): Img {
  const out = newImg(x1 - x0 + 1, y1 - y0 + 1);
  for (let y = y0; y <= y1; y++) out.px.set(src.px.subarray((y * src.w + x0) * 4, (y * src.w + x1 + 1) * 4), (y - y0) * out.w * 4);
  return out;
}

function analyze(img: Img): ExpFrame | null {
  let mx = 0, my = 0, n = 0, kx = 0, ky = 0, kn = 0;
  const ys: number[] = [];
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const k = (y * img.w + x) * 4;
      if (img.px[k + 3] < 128) continue;
      mx += x; my += y; n++;
      ys.push(y);
      // Núcleo: quase branco (mesmo critério do projétil).
      if (0.3 * img.px[k] + 0.59 * img.px[k + 1] + 0.11 * img.px[k + 2] > 232 && img.px[k + 2] > 150) { kx += x; ky += y; kn++; }
    }
  }
  if (n < 30) return null;
  return {
    img, core: kn >= 40 ? { x: kx / kn, y: ky / kn } : null,
    mx: mx / n, my: my / n, base: ys[Math.floor(ys.length * 0.95)], area: n,
  };
}

/** Raio da bola: do núcleo até a borda, na direção da cabeça. */
function ballRadius(f: ExpFrame, hx: number, hy: number) {
  let r = 0;
  for (let t = 0; t < 200; t++) {
    const x = Math.round(f.core!.x + hx * t), y = Math.round(f.core!.y + hy * t);
    if (x < 0 || y < 0 || x >= f.img.w || y >= f.img.h) break;
    if (f.img.px[(y * f.img.w + x) * 4 + 3] >= 128) r = t;
  }
  return r;
}

/**
 * Despill de fogo: no fogo o verde nunca passa do vermelho. Faíscas misturadas com o fundo
 * ficam lima/oliva; nos tons amarelados (pouco azul) G fica limitado a 92% de R. O miolo
 * branco (muito azul) não muda.
 */
function despillFire(img: Img) {
  for (let i = 0; i < img.w * img.h; i++) {
    const k = i * 4;
    if (img.px[k + 3] === 0 || img.px[k + 2] > 0.6 * img.px[k + 1]) continue;
    img.px[k + 1] = Math.min(img.px[k + 1], 0.92 * img.px[k]);
  }
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = (a: number) => Math.round((a * 180) / Math.PI);

export async function processExplosion(file: string, outDir: string, name: string, opts: { approach: number }) {
  const sheet = chromaKey(await loadRgb(file));
  removeSpecks(sheet, 4);
  const mask = new Uint8Array(sheet.w * sheet.h);
  for (let i = 0; i < mask.length; i++) mask[i] = sheet.px[i * 4 + 3] >= 128 ? 1 : 0;
  const { labels, areas } = labelComponents(mask, sheet.w, sheet.h);
  const COLS = 8, ROWS = 8;
  const { img, frames, slots } = segmentGrid(sheet, COLS, ROWS, labels, areas);
  despillFire(img);
  const rows: (ExpFrame | null)[][] = Array.from({ length: ROWS }, () => new Array(COLS).fill(null));
  frames.forEach((f, i) => (rows[Math.floor(slots[i] / COLS)][slots[i] % COLS] = analyze(crop(img, f.bx0, f.by0, f.bx1, f.by1))));

  const measured = rows.map((r, ri) => {
    const ball = r.slice(0, opts.approach).filter((f): f is ExpFrame => !!f?.core);
    if (!ball.length) throw new Error(`explosão: linha ${ri} sem a bola chegando`);
    // Rumo (tela, y para cima): do centro de massa (cauda) para o núcleo (cabeça).
    const hx = median(ball.map((f) => f.core!.x - f.mx)), hy = median(ball.map((f) => f.core!.y - f.my));
    const len = Math.hypot(hx, hy) || 1;
    const blast = r.slice(opts.approach).filter((f): f is ExpFrame => !!f);
    // Frames sem miolo: núcleo na mesma altura acima da base que os outros frames da linha.
    const lift = median(blast.filter((f) => f.core).map((f) => f.base - f.core!.y));
    for (const f of blast) f.core ??= { x: f.mx, y: f.base - lift };
    return {
      heading: Math.atan2(-hy, hx),
      radius: median(ball.map((f) => ballRadius(f, hx / len, hy / len))),
      blast,
    };
  });

  // Para cada direção do isométrico: a linha (ou o espelho, rumo π − θ) mais próxima.
  // Em empate (até 2°), fica a arte da própria direção.
  const chosen = ISO_ANGLES.map(([dir, want]) => {
    let best = { row: 0, mirror: false, heading: 0, err: Infinity };
    const mirrorPenalty = (2 * Math.PI) / 180;
    measured.forEach((m, row) => {
      for (const mirror of [false, true]) {
        const heading = mirror ? wrap(Math.PI - m.heading) : m.heading;
        const err = Math.abs(wrap(heading - want));
        if (err + (mirror ? mirrorPenalty : 0) < best.err + (best.mirror ? mirrorPenalty : 0)) best = { row, mirror, heading, err };
      }
    });
    if (best.err > (20 * Math.PI) / 180) console.warn(`! explosão: ${dir} sem linha próxima (melhor: ${deg(best.err)}° de erro)`);
    return { dir: dir as Dir, ...best };
  });

  const blasts = chosen.map((c) => measured[c.row].blast.map((f) => (c.mirror
    ? { img: flipH(f.img), cx: f.img.w - 1 - f.core!.x, cy: f.core!.y }
    : { img: f.img, cx: f.core!.x, cy: f.core!.y })));

  // Célula comum ancorada no núcleo.
  let left = 0, right = 0, up = 0, down = 0;
  for (const f of blasts.flat()) {
    left = Math.max(left, f.cx); right = Math.max(right, f.img.w - f.cx);
    up = Math.max(up, f.cy); down = Math.max(down, f.img.h - f.cy);
  }
  const ax = Math.ceil(left) + CELL_PAD, ay = Math.ceil(up) + CELL_PAD;
  const cellW = ax + Math.ceil(right) + CELL_PAD, cellH = ay + Math.ceil(down) + CELL_PAD;
  const cols = Math.max(...blasts.map((b) => b.length));
  const atlas = newImg(cellW * cols, cellH * blasts.length);
  blasts.forEach((b, ri) => b.forEach((f, ci) => blit(f.img, atlas, ci * cellW + Math.round(ax - f.cx), ri * cellH + Math.round(ay - f.cy))));

  const manifest = {
    image: `${name}.webp`, cell: [cellW, cellH], anchor: [ax, ay], grid: [cols, blasts.length],
    /** Raio da bola chegando, em px do atlas: régua para a explosão ter o tamanho da bola do jogo. */
    ballRadius: median(chosen.map((c) => measured[c.row].radius)),
    /** Uma linha por direção: rumo da bola na tela (rad, y para cima) e frames da explosão. */
    rows: chosen.map((c, ri) => ({
      dir: c.dir, heading: +c.heading.toFixed(4), source: `L${c.row}${c.mirror ? ' espelhada' : ''}`,
      frames: blasts[ri].map((_, ci) => ri * cols + ci),
    })),
  };
  await saveImg(atlas, path.join(outDir, `${name}.webp`));
  await fs.writeFile(path.join(outDir, `${name}.json`), JSON.stringify(manifest, null, 2));
  if (DEBUG) await saveImg(atlas, path.join(DEBUG_DIR, `fx_${name}.png`));
  console.log(`→ fx/${name}.webp ${atlas.w}×${atlas.h} (célula ${cellW}×${cellH}, bola r=${manifest.ballRadius}px); ` +
    `rumo das linhas: ${measured.map((m, i) => `L${i} ${deg(m.heading)}°`).join(' · ')}\n  por direção: ` +
    chosen.map((c) => `${c.dir}=L${c.row}${c.mirror ? '↔' : ''} (${deg(c.err)}°)`).join(' ') + '\n');
}
