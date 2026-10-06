/**
 * Extração do fogo desenhado nas sheets de conjuração.
 *
 * A bola de fogo da arte é removida (o jogo desenha o sprite de projétil no lugar), mas
 * sua posição e tamanho em cada frame são registrados: assim o efeito do jogo nasce
 * exatamente na mão da personagem e sai no frame em que a arte solta a bola.
 *
 * Detecção: sementes laranja/amarelo intenso (não pega os dourados da roupa, que são
 * mais escuros, nem o branco rosado do robe) → fechamento morfológico → preenchimento
 * do miolo branco (envolto pelo anel laranja) → dilatação para levar o brilho da borda.
 */
import { labelComponents, type Img } from './image.ts';

export interface FireBlob {
  /** Centro e raio equivalente (sheet px). */
  cx: number;
  cy: number;
  r: number;
  area: number;
}

function isFireSeed(r: number, g: number, b: number) {
  if (g - Math.max(r, b) > 60) return false; // fundo verde
  return r >= 215 && g >= 90 && g - b >= 70 && r - b >= 130;
}

function dilate(mask: Uint8Array, w: number, h: number, rad: number) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -rad; dy <= rad; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -rad; dx <= rad; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && dx * dx + dy * dy <= rad * rad) out[yy * w + xx] = 1;
        }
      }
    }
  }
  return out;
}

function erode(mask: Uint8Array, w: number, h: number, rad: number) {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inv[i] = mask[i] ? 0 : 1;
  const d = dilate(inv, w, h, rad);
  for (let i = 0; i < w * h; i++) d[i] = d[i] ? 0 : 1;
  return d;
}

/** Preenche buracos (regiões fora da máscara que não tocam a borda da imagem). */
function fillHoles(mask: Uint8Array, w: number, h: number) {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (p: number) => { if (!mask[p] && !outside[p]) { outside[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = mask[i] || !outside[i] ? 1 : 0;
  return out;
}

/**
 * Cor de chama (laranja-escuro, vermelho-alaranjado da borda e da cauda). O vermelho do
 * robe é carmim (azul ≥ verde) e fica de fora; o dourado pode entrar, mas só perto da bola.
 */
function isFlameColor(r: number, g: number, b: number) {
  if (g - Math.max(r, b) > 60) return false;
  return r >= 140 && g > b + 10 && r - b >= 100;
}

/** Máscara do fogo (1 = remover) e blobs principais, a partir do RGB bruto da sheet. */
export function detectFire(rgb: Buffer, w: number, h: number) {
  const seed = new Uint8Array(w * h);
  const flame = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    seed[i] = isFireSeed(r, g, b) ? 1 : 0;
    flame[i] = isFlameColor(r, g, b) ? 1 : 0;
  }
  const closed = erode(dilate(seed, w, h, 3), w, h, 3);
  const body = fillHoles(closed, w, h);
  for (let i = 0; i < w * h; i++) body[i] |= seed[i];
  // Crescimento geodésico: contorno e cauda da chama ligados à bola (até ~14px).
  for (let it = 0; it < 14; it++) {
    const grown = dilate(body, w, h, 1);
    let added = 0;
    for (let i = 0; i < w * h; i++) if (grown[i] && !body[i] && flame[i]) { body[i] = 1; added++; }
    if (!added) break;
  }

  // Blobs para posição: só os que têm massa de bola (faíscas soltas são apagadas, não medidas).
  const { labels, areas } = labelComponents(body, w, h);
  const acc = areas.map(() => ({ sx: 0, sy: 0, n: 0 }));
  for (let i = 0; i < w * h; i++) {
    const l = labels[i];
    if (l < 0) continue;
    acc[l].sx += i % w;
    acc[l].sy += (i / w) | 0;
    acc[l].n++;
  }
  const blobs: FireBlob[] = acc
    .filter((a) => a.n >= 60)
    .map((a) => ({ cx: a.sx / a.n, cy: a.sy / a.n, r: Math.sqrt(a.n / Math.PI), area: a.n }));

  // Remove também o brilho de borda (pixels de fogo misturados ao verde/robe).
  const mask = dilate(body, w, h, 2);
  return { mask, blobs };
}

export function eraseMask(img: Img, mask: Uint8Array) {
  for (let i = 0; i < img.w * img.h; i++) if (mask[i]) img.px[i * 4 + 3] = 0;
}

/**
 * O fogo está "na mão" se o blob (com folga) encosta na personagem do próprio frame
 * (`box`, o bbox dela na sheet); senão já foi lançado. O bbox evita confundir com o
 * personagem do frame vizinho, que a IA desenha colado.
 */
export function isAttached(img: Img, blob: FireBlob, box: { bx0: number; by0: number; bx1: number; by1: number }, margin = 5) {
  const rad = blob.r + margin;
  const x0 = Math.max(box.bx0, Math.floor(blob.cx - rad)), x1 = Math.min(box.bx1, Math.ceil(blob.cx + rad));
  const y0 = Math.max(box.by0, Math.floor(blob.cy - rad)), y1 = Math.min(box.by1, Math.ceil(blob.cy + rad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - blob.cx, dy = y - blob.cy;
      if (dx * dx + dy * dy > rad * rad) continue;
      if (img.px[(y * img.w + x) * 4 + 3] >= 128) return true;
    }
  }
  return false;
}
