/** Imagem RGBA em memória, chroma key, componentes conexos e reamostragem. */
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface Img {
  w: number;
  h: number;
  /** RGBA não pré-multiplicado. */
  px: Uint8ClampedArray;
}

export function newImg(w: number, h: number): Img {
  return { w, h, px: new Uint8ClampedArray(w * h * 4) };
}

export async function loadRgb(file: string) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, rgb: data };
}

export async function saveImg(img: Img, file: string, opts: { lossless?: boolean } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const s = sharp(Buffer.from(img.px.buffer, img.px.byteOffset, img.px.byteLength), {
    raw: { width: img.w, height: img.h, channels: 4 },
  });
  if (file.endsWith('.png')) await s.png({ compressionLevel: 9 }).toFile(file);
  // smartSubsample preserva melhor detalhes vermelhos finos (o VP8 lossy é sempre 4:2:0).
  else await s.webp({ lossless: opts.lossless ?? false, quality: 92, alphaQuality: 100, smartSubsample: true, effort: 4 }).toFile(file);
}

export function alphaAt(img: Img, x: number, y: number) {
  return img.px[(y * img.w + x) * 4 + 3];
}

export function setPx(img: Img, x: number, y: number, c: number[]) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
  const k = (y * img.w + x) * 4;
  img.px[k] = c[0]; img.px[k + 1] = c[1]; img.px[k + 2] = c[2]; img.px[k + 3] = 255;
}

/** Dominância de verde: G - max(R, B). Fundo ≈ 240, personagem ≤ ~20. */
export function greenDominance(r: number, g: number, b: number) {
  return g - Math.max(r, b);
}

export function chromaKey(src: { w: number; h: number; rgb: Buffer }): Img {
  const { w, h, rgb } = src;
  // Cor média do fundo (pixels claramente verdes) para a desmistura.
  let br = 0, bg = 0, bb = 0, bd = 0, n = 0;
  for (let i = 0; i < w * h; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const gd = greenDominance(r, g, b);
    if (gd > 200) { br += r; bg += g; bb += b; bd += gd; n++; }
  }
  br /= n; bg /= n; bb /= n; bd /= n;

  const GD_BG = bd - 18; // acima disso: fundo puro
  const GD_FG = 24; // abaixo disso: personagem opaco
  const out = newImg(w, h);
  const o = out.px;
  for (let i = 0; i < w * h; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const gd = greenDominance(r, g, b);
    let a = (GD_BG - gd) / (GD_BG - GD_FG);
    if (a <= 0) continue;
    if (a > 1) a = 1;
    // Desmistura: observado = a·frente + (1-a)·fundo
    let fr = (r - (1 - a) * br) / a;
    let fg = (g - (1 - a) * bg) / a;
    let fb = (b - (1 - a) * bb) / a;
    fr = Math.min(255, Math.max(0, fr));
    fb = Math.min(255, Math.max(0, fb));
    // Despill: o personagem não tem verde puro; G nunca passa do maior entre R e B.
    fg = Math.min(Math.max(0, fg), Math.max(fr, fb));
    // Contrai levemente a borda suave para eliminar halo verde residual.
    const aa = Math.min(1, Math.max(0, (a - 0.12) / 0.76));
    o[i * 4] = fr;
    o[i * 4 + 1] = fg;
    o[i * 4 + 2] = fb;
    o[i * 4 + 3] = Math.round(aa * 255);
  }
  return out;
}

export function labelComponents(mask: Uint8Array, w: number, h: number) {
  const labels = new Int32Array(w * h).fill(-1);
  const areas: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start] >= 0) continue;
    const id = areas.length;
    let area = 0;
    labels[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      area++;
      const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (mask[q] && labels[q] < 0) { labels[q] = id; stack.push(q); }
        }
      }
    }
    areas.push(area);
  }
  return { labels, areas };
}

export function removeSpecks(img: Img, minArea = 60) {
  const { w, h, px } = img;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = px[i * 4 + 3] >= 128 ? 1 : 0;
  const { labels, areas } = labelComponents(mask, w, h);
  // Mantém componentes grandes e uma faixa de 2px de borda suave ao redor deles.
  const keep = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (labels[i] >= 0 && areas[labels[i]] >= minArea) keep[i] = 1;
  const R = 2;
  const grown = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!keep[y * w + x]) continue;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) grown[yy * w + xx] = 1;
        }
      }
    }
  }
  for (let i = 0; i < w * h; i++) if (!grown[i]) px[i * 4 + 3] = 0;
}

/** Amostra bilinear de RGBA pré-multiplicado (evita franja escura nas bordas). */
export function samplePremul(img: Img, fx: number, fy: number, out: Float64Array) {
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  out.fill(0);
  for (let j = 0; j < 2; j++) {
    const y = y0 + j;
    if (y < 0 || y >= img.h) continue;
    const wy = j ? ty : 1 - ty;
    for (let i = 0; i < 2; i++) {
      const x = x0 + i;
      if (x < 0 || x >= img.w) continue;
      const wgt = wy * (i ? tx : 1 - tx);
      if (wgt === 0) continue;
      const k = (y * img.w + x) * 4;
      const a = img.px[k + 3] / 255;
      out[0] += img.px[k] * a * wgt;
      out[1] += img.px[k + 1] * a * wgt;
      out[2] += img.px[k + 2] * a * wgt;
      out[3] += a * wgt;
    }
  }
}

/**
 * Reamostra uma região da sheet para um destino com escala `s` (área média quando reduz).
 * (sx, sy) é o ponto da sheet que cai em (dx, dy) no destino.
 */
export function blitScaled(src: Img, dst: Img, sx: number, sy: number, dx: number, dy: number, s: number,
  clip: { x0: number; y0: number; x1: number; y1: number }) {
  const taps = s < 1 ? Math.ceil(1 / s) : 1;
  const acc = new Float64Array(4);
  const tmp = new Float64Array(4);
  for (let y = 0; y < dst.h; y++) {
    for (let x = 0; x < dst.w; x++) {
      acc.fill(0);
      for (let jy = 0; jy < taps; jy++) {
        for (let jx = 0; jx < taps; jx++) {
          const ox = (x + (jx + 0.5) / taps - dx) / s + sx - 0.5;
          const oy = (y + (jy + 0.5) / taps - dy) / s + sy - 0.5;
          if (ox < clip.x0 - 1 || ox > clip.x1 + 1 || oy < clip.y0 - 1 || oy > clip.y1 + 1) continue;
          samplePremul(src, ox, oy, tmp);
          for (let c = 0; c < 4; c++) acc[c] += tmp[c];
        }
      }
      const n = taps * taps;
      const a = acc[3] / n;
      if (a <= 0.003) continue;
      const k = (y * dst.w + x) * 4;
      dst.px[k] = acc[0] / n / a;
      dst.px[k + 1] = acc[1] / n / a;
      dst.px[k + 2] = acc[2] / n / a;
      dst.px[k + 3] = Math.round(a * 255);
    }
  }
}

export function blit(src: Img, dst: Img, dx: number, dy: number) {
  for (let y = 0; y < src.h; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= dst.h) continue;
    for (let x = 0; x < src.w; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= dst.w) continue;
      const s = (y * src.w + x) * 4, d = (ty * dst.w + tx) * 4;
      for (let c = 0; c < 4; c++) dst.px[d + c] = src.px[s + c];
    }
  }
}

/** Espelho horizontal (a âncora fica no centro da célula, então continua no lugar). */
export function flipH(img: Img): Img {
  const out = newImg(img.w, img.h);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const s = (y * img.w + x) * 4, d = (y * img.w + (img.w - 1 - x)) * 4;
      for (let c = 0; c < 4; c++) out.px[d + c] = img.px[s + c];
    }
  }
  return out;
}

export function cropRows(img: Img, y0: number, y1: number): Img {
  const out = newImg(img.w, y1 - y0);
  out.px.set(img.px.subarray(y0 * img.w * 4, y1 * img.w * 4));
  return out;
}
