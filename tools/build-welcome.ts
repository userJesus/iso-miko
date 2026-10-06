/**
 * Apresentação inicial: retratos da Iso Miko e caixa de diálogo (fundo verde) → imagens recortadas
 * + manifest com as áreas de texto da caixa.
 *
 *   node tools/build-welcome.ts            gera public/welcome/
 *   node tools/build-welcome.ts --debug    também grava .sprite-debug/welcome_box.png (áreas medidas)
 *
 * - Retratos: o mesmo recorte para os quatro (a união das silhuetas). A pose muda, mas cabeça e
 *   corpo estão no mesmo lugar em todos, então a troca entre eles é um crossfade sem salto.
 * - Caixa: a moldura interna (onde vai a fala) e o miolo da aba (onde vai o nome) são medidos
 *   a partir de um ponto dentro de cada uma (SEEDS), até a primeira faixa mais escura que o papel.
 * - Seta ">>>": separada da caixa (o jogo a mostra só quando a fala termina). No lugar dela, o
 *   papel é refeito coluna a coluna, ligando o papel logo acima ao logo abaixo.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEBUG, DEBUG_DIR, ROOT } from './sprites/common.ts';
import { chromaKey, labelComponents, loadRgb, newImg, removeSpecks, saveImg, type Img } from './sprites/image.ts';

const SRC = path.join(ROOT, 'assets-src', 'welcome');
const OUT = path.join(ROOT, 'public', 'welcome');
const PORTRAITS = [1, 2, 3, 4].map((k) => `portrait-${k}`);

/** Pontos dentro do papel (px da arte da caixa): fala e nome. */
const SEEDS = { text: [835, 700], name: [320, 532] } as const;
/** Onde procurar a seta ">>>" (px da arte), entre a fala e o canto da moldura interna. */
const ARROW_SEARCH = [1480, 740, 1584, 826] as const;

type Rect = [x0: number, y0: number, x1: number, y1: number];

const lum = (img: Img, x: number, y: number) => {
  const k = (y * img.w + x) * 4;
  return 0.3 * img.px[k] + 0.59 * img.px[k + 1] + 0.11 * img.px[k + 2];
};

function opaqueBounds(img: Img): Rect {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let i = 0; i < img.w * img.h; i++) {
    if (!img.px[i * 4 + 3]) continue;
    const x = i % img.w, y = (i / img.w) | 0;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function crop(img: Img, [x0, y0, x1, y1]: Rect): Img {
  const out = newImg(x1 - x0 + 1, y1 - y0 + 1);
  for (let y = 0; y < out.h; y++) out.px.set(img.px.subarray(((y + y0) * img.w + x0) * 4, ((y + y0) * img.w + x1 + 1) * 4), y * out.w * 4);
  return out;
}

/**
 * Do ponto (papel) para cada lado, até a primeira faixa mais escura que o papel: o retângulo
 * de papel liso em volta do ponto (bordas inclusivas).
 */
function paperAround(img: Img, sx: number, sy: number): Rect {
  const paper = lum(img, sx, sy);
  const walk = (dx: number, dy: number) => {
    let x = sx, y = sy;
    while (x + dx >= 0 && y + dy >= 0 && x + dx < img.w && y + dy < img.h && lum(img, x + dx, y + dy) >= paper - 25) {
      x += dx;
      y += dy;
    }
    return dx ? x : y;
  };
  return [walk(-1, 0), walk(0, -1), walk(1, 0), walk(0, 1)];
}

/** Cor média do papel (pixels claros) dentro de um retângulo. */
function paperColor(img: Img, [x0, y0, x1, y1]: Rect) {
  const c = [0, 0, 0];
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (lum(img, x, y) < 220) continue;
      const k = (y * img.w + x) * 4;
      for (let ch = 0; ch < 3; ch++) c[ch] += img.px[k + ch];
      n++;
    }
  }
  return c.map((v) => v / n);
}

/**
 * Seta ">>>" sobre o papel: os componentes longe da cor do papel que não tocam a borda da busca
 * (o canto arredondado da moldura entra pela borda), com 3 px de folga para a borda suave.
 * A transparência sai da distância até o papel (matte por diferença): ≥ 60 é opaco; a borda
 * suave fica translúcida, com a cor desmisturada.
 */
function extractArrow(img: Img, paper: number[]) {
  const [sx0, sy0, sx1, sy1] = ARROW_SEARCH;
  const sw = sx1 - sx0 + 1, sh = sy1 - sy0 + 1;
  const dist = (x: number, y: number) => {
    const k = (y * img.w + x) * 4;
    return Math.hypot(img.px[k] - paper[0], img.px[k + 1] - paper[1], img.px[k + 2] - paper[2]);
  };
  const mask = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) mask[y * sw + x] = dist(sx0 + x, sy0 + y) >= 30 ? 1 : 0;
  const { labels, areas } = labelComponents(mask, sw, sh);
  const border = new Set<number>();
  for (let x = 0; x < sw; x++) border.add(labels[x]).add(labels[(sh - 1) * sw + x]);
  for (let y = 0; y < sh; y++) border.add(labels[y * sw]).add(labels[y * sw + sw - 1]);
  const arrow = new Uint8Array(sw * sh);
  for (let i = 0; i < arrow.length; i++) if (labels[i] >= 0 && !border.has(labels[i]) && areas[labels[i]] >= 30) arrow[i] = 1;
  // Folga de 3 px para a borda suave (sem passar do que já é da moldura).
  const R = 3, near = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (!arrow[y * sw + x]) continue;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx, yy = y + dy, q = yy * sw + xx;
          if (xx >= 0 && yy >= 0 && xx < sw && yy < sh && (labels[q] < 0 || arrow[q])) near[q] = 1;
        }
      }
    }
  }
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let i = 0; i < near.length; i++) {
    if (!near[i]) continue;
    const x = sx0 + (i % sw), y = sy0 + ((i / sw) | 0);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  if (x1 < 0) throw new Error('seta ">>>" não encontrada na caixa');
  const rect: Rect = [x0, y0, x1, y1];
  const out = newImg(x1 - x0 + 1, y1 - y0 + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!near[(y - sy0) * sw + x - sx0]) continue;
      const a = Math.min(1, dist(x, y) / 60);
      if (a < 0.08) continue;
      const k = (y * img.w + x) * 4, o = ((y - y0) * out.w + x - x0) * 4;
      for (let ch = 0; ch < 3; ch++) out.px[o + ch] = paper[ch] + (img.px[k + ch] - paper[ch]) / a;
      out.px[o + 3] = Math.round(a * 255);
    }
  }
  const inside = (x: number, y: number) => x >= sx0 && y >= sy0 && x <= sx1 && y <= sy1 && near[(y - sy0) * sw + x - sx0] === 1;
  return { img: out, rect, inside };
}

/**
 * Refaz o papel onde estava a seta: em cada coluna, mistura linear do papel logo acima com o
 * logo abaixo dela. Se a ponta cair na moldura (não é papel), usa a cor média do papel.
 */
function inpaint(img: Img, [x0, y0, x1, y1]: Rect, inside: (x: number, y: number) => boolean, paper: number[]) {
  const sample = (x: number, y: number) => {
    const k = (y * img.w + x) * 4, c = [img.px[k], img.px[k + 1], img.px[k + 2]];
    return Math.hypot(c[0] - paper[0], c[1] - paper[1], c[2] - paper[2]) < 12 ? c : paper;
  };
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (!inside(x, y)) continue;
      let a = y, b = y;
      while (inside(x, a - 1)) a--;
      while (inside(x, b + 1)) b++;
      const top = sample(x, a - 1), bottom = sample(x, b + 1);
      for (let yy = a; yy <= b; yy++) {
        const t = (yy - a + 1) / (b - a + 2), k = (yy * img.w + x) * 4;
        for (let ch = 0; ch < 3; ch++) img.px[k + ch] = top[ch] * (1 - t) + bottom[ch] * t;
      }
      y = b;
    }
  }
}

const frac = (r: Rect, w: number, h: number) =>
  [r[0] / w, r[1] / h, (r[2] + 1) / w, (r[3] + 1) / h].map((v) => +v.toFixed(4));

async function buildPortraits() {
  const imgs = await Promise.all(PORTRAITS.map(async (name) => {
    const img = chromaKey(await loadRgb(path.join(SRC, `${name}.png`)));
    removeSpecks(img, 60);
    return img;
  }));
  // Um recorte só para os quatro: a união das silhuetas (+2 px).
  const b = imgs.map(opaqueBounds);
  const r: Rect = [
    Math.max(0, Math.min(...b.map((v) => v[0])) - 2), Math.max(0, Math.min(...b.map((v) => v[1])) - 2),
    Math.min(imgs[0].w - 1, Math.max(...b.map((v) => v[2])) + 2), Math.min(imgs[0].h - 1, Math.max(...b.map((v) => v[3])) + 2),
  ];
  const files: string[] = [];
  for (const [k, img] of imgs.entries()) {
    const file = `${PORTRAITS[k]}.webp`;
    await saveImg(crop(img, r), path.join(OUT, file));
    files.push(file);
  }
  const size: [number, number] = [r[2] - r[0] + 1, r[3] - r[1] + 1];
  console.log(`retratos: ${files.length} × ${size[0]}×${size[1]} (recorte x ${r[0]}–${r[2]}, y ${r[1]}–${r[3]})`);
  return { files, size };
}

async function buildBox() {
  const src = chromaKey(await loadRgb(path.join(SRC, 'dialog.png')));
  removeSpecks(src, 20);
  const bounds = opaqueBounds(src);
  const text = paperAround(src, ...SEEDS.text);
  const name = paperAround(src, ...SEEDS.name);
  const paper = paperColor(src, text);
  const arrow = extractArrow(src, paper);
  inpaint(src, arrow.rect, arrow.inside, paper);

  const img = crop(src, bounds);
  const [bx, by] = bounds;
  const local = (r: Rect): Rect => [r[0] - bx, r[1] - by, r[2] - bx, r[3] - by];
  await saveImg(img, path.join(OUT, 'box.webp'));
  await saveImg(arrow.img, path.join(OUT, 'next.webp'));
  const box = {
    file: 'box.webp',
    size: [img.w, img.h],
    /** Papel da fala, do nome e posição da seta: [esquerda, topo, direita, base] em fração da caixa. */
    text: frac(local(text), img.w, img.h),
    name: frac(local(name), img.w, img.h),
    next: { file: 'next.webp', rect: frac(local(arrow.rect), img.w, img.h) },
  };
  console.log(`caixa: ${img.w}×${img.h}; fala ${text.join(',')}; nome ${name.join(',')}; seta ${arrow.rect.join(',')} (px da arte)`);

  if (DEBUG) {
    const dbg = crop(src, bounds);
    const outline = (r: Rect, c: number[]) => {
      const [x0, y0, x1, y1] = local(r);
      for (let x = x0; x <= x1; x++) for (const y of [y0, y1]) dbg.px.set([...c, 255], (y * dbg.w + x) * 4);
      for (let y = y0; y <= y1; y++) for (const x of [x0, x1]) dbg.px.set([...c, 255], (y * dbg.w + x) * 4);
    };
    outline(text, [0, 160, 255]);
    outline(name, [255, 0, 160]);
    outline(arrow.rect, [0, 200, 0]);
    await saveImg(dbg, path.join(DEBUG_DIR, 'welcome_box.png'));
  }
  return box;
}

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });
const portraits = await buildPortraits();
const box = await buildBox();
await fs.writeFile(path.join(OUT, 'welcome.json'), JSON.stringify({ portraits, box }, null, 2));
console.log('→ public/welcome/');
