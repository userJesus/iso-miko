/** Pré-visualizações de depuração (.sprite-debug/). */
import path from 'node:path';
import { DEBUG_DIR, type Dir } from './common.ts';
import { blit, newImg, saveImg, setPx, type Img } from './image.ts';

export async function writeDebug(action: string, dir: string, cells: Img[], order: number[], idle: number, ax: number, ay: number) {
  const { w, h } = cells[0];
  // Tira com todos os frames + guias (âncora vertical, linha do chão); laço marcado em azul, idle em laranja.
  const strip = newImg(w * cells.length, h);
  cells.forEach((c, i) => {
    blit(c, strip, i * w, 0);
    const inLoop = order.includes(i);
    const mark = i === idle ? [255, 140, 0] : inLoop ? [40, 120, 255] : [160, 160, 160];
    for (let x = 0; x < w; x++) for (const y of [0, 1]) setPx(strip, i * w + x, y, mark);
    for (let y = 0; y < h; y += 2) setPx(strip, i * w + ax, y, [255, 0, 80]);
    for (let x = 0; x < w; x += 2) setPx(strip, i * w + x, ay, [255, 0, 80]);
  });
  await saveImg(strip, path.join(DEBUG_DIR, `${action}_${dir}_strip.png`));

  // Onion skin do laço: tronco nítido = bom alinhamento.
  const onion = newImg(w, h);
  const acc = new Float64Array(w * h * 4);
  for (const i of order) {
    const c = cells[i];
    for (let p = 0; p < w * h; p++) {
      const a = c.px[p * 4 + 3] / 255;
      for (let ch = 0; ch < 3; ch++) acc[p * 4 + ch] += c.px[p * 4 + ch] * a;
      acc[p * 4 + 3] += a;
    }
  }
  for (let p = 0; p < w * h; p++) {
    const a = acc[p * 4 + 3];
    if (a <= 0) continue;
    for (let ch = 0; ch < 3; ch++) onion.px[p * 4 + ch] = acc[p * 4 + ch] / a;
    onion.px[p * 4 + 3] = Math.round((a / order.length) * 255);
  }
  for (let y = 0; y < h; y += 2) setPx(onion, ax, y, [255, 0, 80]);
  await saveImg(onion, path.join(DEBUG_DIR, `${action}_${dir}_onion.png`));
}

/**
 * Pernas de cada frame do laço deslocadas pela distância percorrida até ele (passada × fase).
 * Com a passada certa, o pé de apoio fica na mesma coluna em linhas consecutivas;
 * se ele "anda" para a frente/trás entre linhas, os pés patinam no jogo.
 */
export async function writeFeetStrip(action: string, dir: Dir, cells: Img[], order: number[], stride: number, ay: number, charH: number) {
  const { w } = cells[0];
  const legH = Math.round(charH * 0.3), y0 = ay - legH;
  const sign = dir === 'w' ? -1 : 1;
  const W = Math.ceil(w + stride * 1.1) + 20, rowH = legH + 4;
  const out = newImg(W, rowH * order.length);
  out.px.fill(255);
  for (let y = 0; y < out.h; y++) for (let x = 0; x < W; x += 10) setPx(out, x, y, [205, 205, 215]);
  order.forEach((col, k) => {
    const off = (k / order.length) * stride;
    const left = Math.round(sign > 0 ? 10 + off : W - w - 10 - off);
    const c = cells[col];
    for (let y = 0; y < legH; y++) {
      for (let x = 0; x < w; x++) {
        const s = ((y0 + y) * w + x) * 4;
        const a = c.px[s + 3] / 255;
        if (a <= 0) continue;
        const d = ((k * rowH + y) * W + left + x) * 4;
        for (let ch = 0; ch < 3; ch++) out.px[d + ch] = out.px[d + ch] * (1 - a) + c.px[s + ch] * a;
      }
    }
  });
  await saveImg(out, path.join(DEBUG_DIR, `${action}_${dir}_feet.png`));
}
