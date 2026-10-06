/**
 * HUD de comandos: arte única (fundo verde) → uma imagem por peça + manifest com a posição
 * de cada uma, para o jogo animar as peças separadamente (tecla, seta/ícone, raios).
 *
 *   node tools/build-hud.ts            gera public/hud/
 *   node tools/build-hud.ts --debug    também grava .sprite-debug/hud_parts.png (peças coloridas)
 *
 * - Peças: componentes conexos depois de uma erosão de 2 px, que desfaz as pontes finas
 *   entre um raio de brilho e a tecla em que ele encosta.
 * - Nome de cada peça: a semente declarada mais próxima (SEEDS). Raios (amarelos, pequenos)
 *   vão para o grupo da tecla mais próxima; fragmentos soltos, para a peça mais próxima.
 * - Tecla + o que encosta nela (seta, ícone): o corte é a borda escura da tecla, a primeira
 *   linha/coluna, do lado do anexo, com um traço escuro contínuo de ≥ 60% da largura.
 *
 * Também prepara a caixa de aviso (assets-src/hud/dialog.png): pergaminho e botão X separados,
 * com a moldura interna do pergaminho medida (o texto vai dentro dela).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { DEBUG, DEBUG_DIR, ROOT } from './sprites/common.ts';
import { chromaKey, labelComponents, loadRgb, newImg, removeSpecks, saveImg, type Img } from './sprites/image.ts';

const SRC = path.join(ROOT, 'assets-src', 'hud', 'controls.png');
const DIALOG_SRC = path.join(ROOT, 'assets-src', 'hud', 'dialog.png');
const OUT = path.join(ROOT, 'public', 'hud');
/** Resolução das peças em relação à arte (o HUD aparece com ~1/4 da largura dela; 0,5 = nítido em telas 2×). */
const SCALE = 0.5;

/** Centro aproximado de cada peça grande na arte (px). */
const SEEDS: Record<string, [number, number]> = {
  'key-w': [715, 230], 'key-a': [480, 425], 'key-s': [715, 440], 'key-d': [955, 425],
  'key-shift': [260, 880], 'key-e': [620, 880], 'key-c': [930, 880],
  mouse: [1250, 880], 'zoom-out': [1132, 760], 'zoom-in': [1370, 760],
  'spin-out': [1136, 842], 'spin-in': [1363, 842],
};

/** O que encosta em cada tecla e de que lado. */
const ATTACH: Record<string, [name: string, side: 'top' | 'bottom' | 'left' | 'right']> = {
  'key-w': ['arrow-up', 'top'], 'key-a': ['arrow-left', 'left'], 'key-s': ['arrow-down', 'bottom'],
  'key-d': ['arrow-right', 'right'], 'key-shift': ['icon-run', 'top'], 'key-e': ['icon-fire', 'top'],
  'key-c': ['icon-slide', 'top'],
};

/** Grupos que ganham raios: as teclas e o mouse (cada raio vai para o mais próximo). */
const RAY_OWNERS = ['key-w', 'key-a', 'key-s', 'key-d', 'key-shift', 'key-e', 'key-c', 'mouse'];

/**
 * Raios entre duas teclas, à mesma distância das duas: no desenho eles enfeitam o S (como
 * os do W), não o A nem o D. Retângulos [x0, y0, x1, y1] na arte.
 */
const RAY_ZONES: Record<string, [number, number, number, number][]> = {
  'key-s': [[570, 370, 625, 485], [810, 370, 865, 485]],
};

interface Part {
  name: string;
  pixels: number[];
  x0: number; y0: number; x1: number; y1: number;
}

function erode(mask: Uint8Array, w: number, h: number, r: number) {
  const out = new Uint8Array(w * h);
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      let all = 1;
      for (let dy = -r; dy <= r && all; dy++) for (let dx = -r; dx <= r && all; dx++) all = mask[(y + dy) * w + x + dx];
      out[y * w + x] = all;
    }
  }
  return out;
}

/**
 * Devolve a cada componente erodido a borda que a erosão tirou (e a borda suave), até `steps`
 * px. Um raio fino que sumiu inteiro na erosão não é engolido pela tecla vizinha.
 */
function grow(img: Img, seeds: Int32Array, steps: number) {
  const { w, h } = img, owner = Int32Array.from(seeds);
  let frontier: number[] = [];
  for (let i = 0; i < w * h; i++) if (owner[i] >= 0) frontier.push(i);
  for (let step = 0; step < steps && frontier.length; step++) {
    const next: number[] = [];
    for (const p of frontier) {
      const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy, q = yy * w + xx;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || owner[q] >= 0 || img.px[q * 4 + 3] === 0) continue;
          owner[q] = owner[p];
          next.push(q);
        }
      }
    }
    frontier = next;
  }
  return owner;
}

function bounds(name: string, pixels: number[], w: number): Part {
  const p: Part = { name, pixels, x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
  for (const i of pixels) {
    const x = i % w, y = (i / w) | 0;
    if (x < p.x0) p.x0 = x;
    if (x > p.x1) p.x1 = x;
    if (y < p.y0) p.y0 = y;
    if (y > p.y1) p.y1 = y;
  }
  return p;
}

/** Amarelo dos raios de brilho (o creme da tecla tem mais azul; a faísca, menos vermelho). */
const isRayColor = (r: number, g: number, b: number) => r > 200 && g > 170 && b < 190 && r - b > 50;

/**
 * Raios que encostam na tecla (a erosão de 2 px não separa): trechos amarelos que tocam o
 * fundo transparente. O dourado e o creme da tecla ficam dentro do contorno escuro dela.
 */
function peelRays(img: Img, part: Part): { body: Part; rays: Part[] } {
  const { w } = img;
  const inPart = new Set(part.pixels);
  const yellow = (i: number) => img.px[i * 4 + 3] >= 128 && isRayColor(img.px[i * 4], img.px[i * 4 + 1], img.px[i * 4 + 2]);
  const seen = new Set<number>(), rays: Part[] = [], taken = new Set<number>();
  for (const start of part.pixels) {
    if (seen.has(start) || !yellow(start)) continue;
    const blob: number[] = [];
    let touchesOutside = false;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const p = stack.pop()!;
      blob.push(p);
      const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const q = (y + dy) * w + x + dx;
          if (img.px[q * 4 + 3] < 128) touchesOutside = true;
          if (seen.has(q) || !inPart.has(q) || !yellow(q)) continue;
          seen.add(q);
          stack.push(q);
        }
      }
    }
    if (!touchesOutside || blob.length < 40) continue;
    // Junto vai a borda suave em volta (até 2 px), que é do raio, não da tecla.
    const grown = new Set(blob);
    for (let k = 0; k < 2; k++) {
      for (const p of [...grown]) {
        const x = p % w, y = (p / w) | 0;
        for (const q of [p - 1, p + 1, p - w, p + w, (y + 1) * w + x + 1, (y - 1) * w + x - 1, (y + 1) * w + x - 1, (y - 1) * w + x + 1]) {
          if (inPart.has(q) && !grown.has(q) && img.px[q * 4 + 3] < 128) grown.add(q);
        }
      }
    }
    for (const p of grown) taken.add(p);
    rays.push(bounds('#peel', [...grown], w));
  }
  // O que sobrou da borda dos raios e não está ligado ao corpo da tecla vai para o raio mais
  // próximo (senão andaria junto com a tecla ao pressionar, como um contorno fantasma).
  const rest = part.pixels.filter((i) => !taken.has(i));
  const restSet = new Set(rest), body = new Set<number>();
  const heaviest = rest.reduce((a, i) => (img.px[i * 4 + 3] === 255 && lum(img, i) < 110 ? i : a), rest[0]);
  const stack = [heaviest];
  body.add(heaviest);
  while (stack.length) {
    const p = stack.pop()!, x = p % w, y = (p / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const q = (y + dy) * w + x + dx;
        if (restSet.has(q) && !body.has(q) && img.px[q * 4 + 3] >= 24) { body.add(q); stack.push(q); }
      }
    }
  }
  for (const i of rest) {
    if (body.has(i) || !rays.length) continue;
    const x = i % w, y = (i / w) | 0;
    const near = rays.reduce((a, r) => (Math.hypot(Math.max(0, r.x0 - x, x - r.x1), Math.max(0, r.y0 - y, y - r.y1))
      < Math.hypot(Math.max(0, a.x0 - x, x - a.x1), Math.max(0, a.y0 - y, y - a.y1)) ? r : a));
    if (Math.hypot(Math.max(0, near.x0 - x, x - near.x1), Math.max(0, near.y0 - y, y - near.y1)) > 6) { body.add(i); continue; }
    near.pixels.push(i);
  }
  return { body: bounds(part.name, rest.filter((i) => body.has(i)), w), rays: rays.map((r) => bounds(r.name, r.pixels, w)) };
}

const lum = (img: Img, i: number) => 0.3 * img.px[i * 4] + 0.59 * img.px[i * 4 + 1] + 0.11 * img.px[i * 4 + 2];

/**
 * Separa tecla e anexo (ver cabeçalho): o corpo da tecla é a maior sequência de linhas
 * cobertas de lado a lado (≥ 85% da linha mais larga); a seta ou o ícone são mais estreitos.
 * Do início desse corpo, recua pelo chanfro e pela borda escura da tecla (a tecla é um
 * trapézio: o topo tem ~75% da largura da base, então largura sozinha não separa).
 */
function split(img: Img, part: Part, attachName: string, side: 'top' | 'bottom' | 'left' | 'right') {
  const { w } = img;
  const set = new Set(part.pixels);
  const vertical = side === 'top' || side === 'bottom';
  const [a, b] = vertical ? [part.x0, part.x1] : [part.y0, part.y1];
  const span = b - a + 1;
  // Linhas do lado do anexo para o lado oposto.
  const lines: number[] = [];
  if (side === 'top') for (let y = part.y0; y <= part.y1; y++) lines.push(y);
  else if (side === 'bottom') for (let y = part.y1; y >= part.y0; y--) lines.push(y);
  else if (side === 'left') for (let x = part.x0; x <= part.x1; x++) lines.push(x);
  else for (let x = part.x1; x >= part.x0; x--) lines.push(x);
  const at = (line: number, t: number) => (vertical ? line * w + t : t * w + line);
  const coverage = lines.map((l) => {
    let n = 0;
    for (let t = a; t <= b; t++) if (set.has(at(l, t))) n++;
    return n / span;
  });
  // Largura da tecla: a cobertura máxima (a caixa da peça pode ter bordas suaves soltas).
  const full = Math.max(...coverage);
  const darkRun = (l: number) => {
    let run = 0, best = 0;
    for (let t = a; t <= b; t++) {
      const i = at(l, t);
      run = set.has(i) && img.px[i * 4 + 3] >= 128 && lum(img, i) < 110 ? run + 1 : 0;
      if (run > best) best = run;
    }
    return best / span / full;
  };
  // Corpo da tecla: a maior sequência de linhas quase tão cobertas quanto a mais larga.
  let k = 0, bestLen = 0;
  for (let i = 0, start = 0; i <= coverage.length; i++) {
    if (i < coverage.length && coverage[i] >= 0.85 * full) continue;
    if (i - start > bestLen) { bestLen = i - start; k = start; }
    start = i + 1;
  }
  // Do corpo em direção ao anexo: chanfro claro (ainda largo), depois a borda escura da tecla.
  // Para no fim dessa primeira faixa escura: um ícone pode ter contorno escuro grosso e largo
  // (o rastro do C), mas fica depois de um vão.
  while (k > 0 && darkRun(lines[k - 1]) < 0.5 && coverage[k - 1] >= 0.6 * full) k--;
  while (k > 0 && darkRun(lines[k - 1]) >= 0.4) k--;
  if (k <= 0) throw new Error(`${part.name}: borda da tecla não encontrada (${side})`);
  const border = lines[k];
  const stepDir = side === 'top' || side === 'left' ? 1 : -1;
  const beyond = (i: number) => {
    const c = vertical ? (i / w) | 0 : i % w;
    return stepDir > 0 ? c < border : c > border;
  };
  return {
    key: bounds(part.name, part.pixels.filter((i) => !beyond(i)), w),
    attach: bounds(attachName, part.pixels.filter(beyond), w),
    border,
  };
}

async function savePart(img: Img, p: Part, file: string, pad = 2) {
  const x0 = Math.max(0, p.x0 - pad), y0 = Math.max(0, p.y0 - pad);
  const pw = Math.min(img.w - 1, p.x1 + pad) - x0 + 1, ph = Math.min(img.h - 1, p.y1 + pad) - y0 + 1;
  const out = newImg(pw, ph);
  for (const i of p.pixels) {
    const x = (i % img.w) - x0, y = ((i / img.w) | 0) - y0;
    out.px.set(img.px.subarray(i * 4, i * 4 + 4), (y * pw + x) * 4);
  }
  await saveImg(out, path.join(OUT, file));
  return out;
}

/**
 * Moldura interna do pergaminho: do centro (papel uniforme) para cada borda, a primeira faixa
 * mais escura que o papel. Antes dela, vindo de fora, há outra faixa (a borda entre as folhas
 * empilhadas), por isso a busca parte de dentro. Devolve as margens até a borda interna da
 * moldura (fração do tamanho).
 */
function innerFrame(img: Img): [left: number, top: number, right: number, bottom: number] {
  const at = (x: number, y: number) => lum(img, y * img.w + x);
  const find = (len: number, sample: (t: number) => number) => {
    const mid = Math.floor(len / 2), paper = sample(mid);
    for (let t = mid; t > 0; t--) if (sample(t) < paper - 25) return t + 1;
    throw new Error('moldura interna do pergaminho não encontrada');
  };
  const my = Math.round(img.h / 2), mx = Math.round(img.w / 2);
  return [
    find(img.w, (t) => at(t, my)) / img.w,
    find(img.h, (t) => at(mx, t)) / img.h,
    find(img.w, (t) => at(img.w - 1 - t, my)) / img.w,
    find(img.h, (t) => at(mx, img.h - 1 - t)) / img.h,
  ];
}

async function processDialog() {
  const img = chromaKey(await loadRgb(DIALOG_SRC));
  removeSpecks(img, 20);
  const { w, h } = img;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = img.px[i * 4 + 3] > 0 ? 1 : 0;
  const { labels, areas } = labelComponents(mask, w, h);
  // Maior peça: pergaminho; a segunda: o botão X.
  const order = areas.map((a, l) => [a, l]).sort((p, q) => q[0] - p[0]).slice(0, 2).map(([, l]) => l);
  const [panel, close] = order.map((l, k) => {
    const px: number[] = [];
    for (let i = 0; i < labels.length; i++) if (labels[i] === l) px.push(i);
    return bounds(k ? 'close' : 'panel', px, w);
  });
  const panelImg = await savePart(img, panel, 'panel.webp');
  const closeImg = await savePart(img, close, 'close.webp');
  const frame = innerFrame(panelImg).map((f) => +f.toFixed(4)) as [number, number, number, number];
  console.log(`caixa de aviso: pergaminho ${panelImg.w}×${panelImg.h} (moldura a ${frame.map((f) => `${Math.round(f * 100)}%`).join(' ')}), X ${closeImg.w}×${closeImg.h}`);
  return {
    panel: { file: 'panel.webp', size: [panelImg.w, panelImg.h], frame },
    close: { file: 'close.webp', size: [closeImg.w, closeImg.h] },
  };
}

const boxDist = (a: Part, b: Part) =>
  Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.y0 - b.y1, b.y0 - a.y1));

async function main() {
  const img = chromaKey(await loadRgb(SRC));
  removeSpecks(img, 20);
  const { w, h } = img;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = img.px[i * 4 + 3] >= 128 ? 1 : 0;
  const { labels, areas } = labelComponents(erode(mask, w, h, 2), w, h);
  let owner = grow(img, labels, 3);
  // O que a erosão apagou e ficou longe de tudo (raios finos) vira componente próprio.
  const rest = new Uint8Array(w * h);
  for (let i = 0; i < rest.length; i++) rest[i] = mask[i] && owner[i] < 0 ? 1 : 0;
  const extra = labelComponents(rest, w, h);
  for (let i = 0; i < rest.length; i++) if (extra.labels[i] >= 0) owner[i] = areas.length + extra.labels[i];
  areas.push(...extra.areas);
  owner = grow(img, owner, 3);
  const comps: number[][] = areas.map(() => []);
  for (let i = 0; i < w * h; i++) if (owner[i] >= 0) comps[owner[i]].push(i);

  const parts = new Map<string, Part>();
  const rays: Part[] = [], loose: Part[] = [];
  comps.forEach((pixels, l) => {
    if (!pixels.length) return;
    const p = bounds(`#${l}`, pixels, w);
    let r = 0, g = 0, b = 0;
    for (const i of pixels) { r += img.px[i * 4]; g += img.px[i * 4 + 1]; b += img.px[i * 4 + 2]; }
    r /= pixels.length; g /= pixels.length; b /= pixels.length;
    // Raios: amarelos e pequenos. O resto pequeno (faísca, pedaço de rastro) vai para a peça mais próxima.
    if (pixels.length >= 30 && pixels.length < 2500 && isRayColor(r, g, b)) return void rays.push(p);
    if (pixels.length < 800) return void loose.push(p);
    const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2;
    const name = Object.entries(SEEDS).reduce((a, s) => (Math.hypot(s[1][0] - cx, s[1][1] - cy) < Math.hypot(a[1][0] - cx, a[1][1] - cy) ? s : a))[0];
    if (parts.has(name)) throw new Error(`duas peças grandes perto de ${name}`);
    parts.set(name, { ...p, name });
  });
  for (const name of Object.keys(SEEDS)) if (!parts.has(name)) throw new Error(`peça ${name} não encontrada`);

  for (const [key, [attachName, side]] of Object.entries(ATTACH)) {
    const s = split(img, parts.get(key)!, attachName, side);
    parts.set(key, s.key);
    parts.set(attachName, s.attach);
    console.log(`${key}: borda ${side === 'top' || side === 'bottom' ? 'y' : 'x'}=${s.border} → ${attachName} (${s.attach.pixels.length} px)`);
  }
  for (const name of RAY_OWNERS) {
    const { body, rays: peeled } = peelRays(img, parts.get(name)!);
    parts.set(name, body);
    // Amarelo colado no anexo (o brilho sob a bola de fogo) é do anexo, não raio.
    const attach = ATTACH[name] && parts.get(ATTACH[name][0]);
    for (const r of peeled) {
      if (attach && boxDist(r, attach) <= 3) parts.set(attach.name, bounds(attach.name, [...attach.pixels, ...r.pixels], w));
      else rays.push(r);
    }
  }
  for (const l of loose) {
    const near = [...parts.values()].reduce((a, p) => (boxDist(l, p) < boxDist(l, a) ? p : a));
    near.pixels.push(...l.pixels);
    parts.set(near.name, bounds(near.name, near.pixels, w));
  }
  for (const r of rays) {
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    const zone = Object.entries(RAY_ZONES).find(([, rects]) => rects.some(([x0, y0, x1, y1]) => cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1));
    const ownerName = zone?.[0] ?? RAY_OWNERS.reduce((a, n) => (boxDist(r, parts.get(n)!) < boxDist(r, parts.get(a)!) ? n : a));
    const name = `rays-${ownerName.replace('key-', '')}`;
    const prev = parts.get(name);
    parts.set(name, bounds(name, [...(prev?.pixels ?? []), ...r.pixels], w));
  }

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  const manifest: { size: [number, number]; parts: Record<string, { file: string; box: number[]; origin?: number[] }> } = {
    size: [w, h], parts: {},
  };
  const PAD = 2;
  for (const p of parts.values()) {
    const x0 = Math.max(0, p.x0 - PAD), y0 = Math.max(0, p.y0 - PAD);
    const pw = Math.min(w - 1, p.x1 + PAD) - x0 + 1, ph = Math.min(h - 1, p.y1 + PAD) - y0 + 1;
    const out = newImg(pw, ph);
    for (const i of p.pixels) {
      const x = (i % w) - x0, y = ((i / w) | 0) - y0;
      out.px.set(img.px.subarray(i * 4, i * 4 + 4), (y * pw + x) * 4);
    }
    const file = `${p.name}.webp`;
    await sharp(Buffer.from(out.px.buffer), { raw: { width: pw, height: ph, channels: 4 } })
      .resize(Math.max(1, Math.round(pw * SCALE)), Math.max(1, Math.round(ph * SCALE)), { kernel: 'lanczos3' })
      .webp({ lossless: true }).toFile(path.join(OUT, file));
    manifest.parts[p.name] = { file, box: [x0, y0, pw, ph] };
    // Raios abrem a partir do centro da tecla (ou do mouse).
    if (p.name.startsWith('rays-')) {
      const k = parts.get(p.name === 'rays-mouse' ? 'mouse' : `key-${p.name.slice(5)}`)!;
      manifest.parts[p.name].origin = [Math.round((k.x0 + k.x1) / 2), Math.round((k.y0 + k.y1) / 2)];
    }
  }
  const dialog = await processDialog();
  await fs.writeFile(path.join(OUT, 'hud.json'), JSON.stringify({ ...manifest, dialog }, null, 2));
  console.log(`→ public/hud/: ${parts.size} peças (${[...parts.keys()].join(', ')})`);

  if (DEBUG) {
    // Cada peça com uma cor: confere cortes e raios atribuídos.
    const dbg = newImg(w, h);
    [...parts.values()].forEach((p, k) => {
      const hue = (k * 137.5) % 360, c = [Math.cos((hue * Math.PI) / 180), Math.cos(((hue - 120) * Math.PI) / 180), Math.cos(((hue + 120) * Math.PI) / 180)];
      for (const i of p.pixels) {
        for (let ch = 0; ch < 3; ch++) dbg.px[i * 4 + ch] = 0.45 * img.px[i * 4 + ch] + 0.55 * (128 + 127 * c[ch]);
        dbg.px[i * 4 + 3] = img.px[i * 4 + 3];
      }
    });
    await saveImg(dbg, path.join(DEBUG_DIR, 'hud_parts.png'));
  }
}

await main();
