/**
 * Pipeline do cenário: pintura isométrica → ilha jogável.
 *
 *   node tools/build-level.ts            gera public/level/
 *   node tools/build-level.ts --debug    também grava sobreposições em .sprite-debug/level_*.png
 *
 * 1. Ampliação 4× com Real-ESRGAN (rede neural, GPU via Vulkan). Sem o executável em
 *    .tools/esrgan, cai para Lanczos com aviso. Resultado em cache (.cache/level).
 * 2. Recorte do fundo verde (sem tirar o verde da grama) e fusão da água pintada com o mar.
 * 3. Material por pixel (areia, grama, rocha, água, folhagem…) → onde dá para pisar.
 * 4. Mapa de profundidade por pixel (chave de ordenação + nível): a personagem some atrás
 *    de árvores, torii, rochas e penhascos na ordem certa.
 * 5. Grade do chão (0,1 m): altura, região, passável, campo de distância às barreiras.
 */
import sharp from 'sharp';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ISLAND, type Pt, type Region } from './level/island.level.ts';
import { classify, MAT, MAT_COLORS, WALKABLE_MATS } from './level/material.ts';
import { components, edt, rasterPoly } from './level/geom.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'assets-src', 'level');
const OUT = path.join(ROOT, 'public', 'level');
const CACHE = path.join(ROOT, '.cache', 'level');
const DEBUG_DIR = path.join(ROOT, '.sprite-debug');
const DEBUG = process.argv.includes('--debug');
const ESRGAN = path.join(ROOT, '.tools', 'esrgan', 'realesrgan-ncnn-vulkan.exe');

const L = ISLAND;
const S = L.pxPerMeter;
const SIN = 0.5, COS = Math.sqrt(3) / 2; // elevação de 30° (a mesma da câmera)
const H_IMG = L.height;
const MAX_TEX = 4096;
const CELL = 0.1; // m por célula da grade do chão
const KEY_MIN = -20, KEY_MAX = 100; // faixa da chave de profundidade (m)

// ---------------------------------------------------------------------------
// Projeção imagem ↔ chão

const toGround = (x: number, y: number, h: number) => ({ u: x / S, v: ((H_IMG - y) / S - h * COS) / SIN });
const toImage = (u: number, v: number, h: number) => ({ x: u * S, y: H_IMG - S * (v * SIN + h * COS) });

interface RegionRT extends Region {
  index: number;
  /** Altura num ponto do chão. */
  heightAt(u: number, v: number): number;
  /** Altura de um pixel da imagem (resolve a dependência circular das rampas). */
  heightAtPixel(x: number, y: number): number;
  rampGround?: { bu: number; bv: number; du: number; dv: number };
}

function prepareRegion(r: Region, index: number): RegionRT {
  if (!r.ramp) {
    const h = r.h ?? 0;
    return { ...r, index, heightAt: () => h, heightAtPixel: () => h };
  }
  const { bottom, top, h0, h1 } = r.ramp;
  const mid = (e: [Pt, Pt]) => [(e[0][0] + e[1][0]) / 2, (e[0][1] + e[1][1]) / 2] as Pt;
  const B = toGround(...mid(bottom), h0), T = toGround(...mid(top), h1);
  const du = T.u - B.u, dv = T.v - B.v, len2 = du * du + dv * dv;
  const heightAt = (u: number, v: number) => {
    const t = Math.min(1, Math.max(0, ((u - B.u) * du + (v - B.v) * dv) / len2));
    return h0 + t * (h1 - h0);
  };
  const heightAtPixel = (x: number, y: number) => {
    let h = (h0 + h1) / 2;
    for (let i = 0; i < 6; i++) {
      const g = toGround(x, y, h);
      h = heightAt(g.u, g.v);
    }
    return h;
  };
  return { ...r, index, heightAt, heightAtPixel, rampGround: { bu: B.u, bv: B.v, du, dv } };
}

const regions = L.regions.map(prepareRegion);
const regionById = new Map(regions.map((r) => [r.id, r]));
const levelAt = (r: RegionRT, h: number) => {
  if (!r.ramp || r.level1 === undefined) return r.level;
  return r.level + ((h - r.ramp.h0) / (r.ramp.h1 - r.ramp.h0)) * (r.level1 - r.level);
};

// ---------------------------------------------------------------------------
// 1. Ampliação

async function upscaled(): Promise<string> {
  const out = path.join(CACHE, 'island_x4.png');
  if (fs.existsSync(out)) return out;
  await fsp.mkdir(CACHE, { recursive: true });
  const src = path.join(SRC, L.image);
  if (fs.existsSync(ESRGAN)) {
    console.log('Real-ESRGAN 4× (realesrgan-x4plus)…');
    const r = spawnSync(ESRGAN, ['-i', src, '-o', out, '-n', 'realesrgan-x4plus', '-s', '4'], { stdio: 'inherit' });
    if (r.status === 0 && fs.existsSync(out)) return out;
    console.warn('! Real-ESRGAN falhou; usando Lanczos');
  } else {
    console.warn(`! ${ESRGAN} não encontrado; usando Lanczos (veja o README para instalar o Real-ESRGAN)`);
  }
  await sharp(src).resize({ width: L.width * 4, kernel: 'lanczos3' }).png().toFile(out);
  return out;
}

// ---------------------------------------------------------------------------
// 2. Recorte do fundo

const BG = [3, 249, 5];
/** Alfa pela dominância do verde: o fundo tem ~240, a grama mais clara ~130. */
function keyAlpha(r: number, g: number, b: number) {
  const gd = g - Math.max(r, b);
  return Math.min(1, Math.max(0, (205 - gd) / 55));
}

const ramp = (x: number, a: number, b: number) => Math.min(1, Math.max(0, (x - a) / (b - a)));

/**
 * Quanto o pixel parece o fundo verde mesmo sombreado pela ampliação (bolsões entre
 * folhas): verde puro (matiz ~118°), saturado e claro. A grama é amarelada (60–80°) e as
 * folhas de pinheiro são escuras — ficam de fora.
 */
function bgness(r: number, g: number, b: number) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (mx !== g || d === 0) return 0;
  const h = ((b - r) / d + 2) * 60, s = d / mx, v = mx / 255;
  const pure = (1 - ramp(Math.abs(h - 118), 10, 20)) * ramp(s, 0.55, 0.72) * ramp(v, 0.45, 0.6);
  // verde-menta claro: o fundo "clareado" que a IA pintou nos vãos (entre as vigas do torii)
  const mint = (1 - ramp(Math.abs(h - 122), 14, 22)) * ramp(s, 0.18, 0.26) * ramp(v, 0.74, 0.82);
  return Math.max(pure, mint);
}

/** Halo verde-claro que a IA pinta em volta das copas (só vale perto da borda recortada). */
function haloness(r: number, g: number, b: number) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (mx !== g || d === 0) return 0;
  const h = ((b - r) / d + 2) * 60, s = d / mx, v = mx / 255;
  return (1 - ramp(Math.abs(h - 122), 20, 30)) * ramp(s, 0.1, 0.16) * (1 - ramp(s, 0.6, 0.7)) * ramp(v, 0.55, 0.66);
}

async function main() {
  await fsp.mkdir(OUT, { recursive: true });
  const { x0, y0, x1, y1 } = L.crop;
  const CW = x1 - x0, CH = y1 - y0;

  // ---- imagem 4× recortada, RGBA com alfa do chroma
  const x4 = await upscaled();
  const big = await sharp(x4).extract({ left: x0 * 4, top: y0 * 4, width: CW * 4, height: CH * 4 })
    .removeAlpha().raw().toBuffer();
  const W4 = CW * 4, H4 = CH * 4;
  // Recorte em duas passadas: o fundo puro sai; perto dele (anel de 6 px) o pixel pode ser
  // mistura de borda com verde → alfa por uma faixa larga + desmistura + despill. Longe da
  // borda vale a faixa estreita, para não tirar a cor da grama.
  const transparent4 = new Uint8Array(W4 * H4);
  for (let i = 0; i < W4 * H4; i++) transparent4[i] = keyAlpha(big[i * 3], big[i * 3 + 1], big[i * 3 + 2]) === 0 ? 1 : 0;
  const near = dilate(transparent4, W4, H4, 6);
  // A ampliação espalha a mistura com o fundo ~3 px além disso; nessa faixa larga só
  // pixels verde-ciano saturados (mistura de água/folha com o verde) recebem o tratamento.
  const nearWide = dilate(transparent4, W4, H4, 16);
  const greenMix = (r: number, g: number, b: number) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (mx !== g || d === 0) return false;
    const h = ((b - r) / d + 2) * 60;
    return h >= 100 && h <= 165 && d / mx > 0.55;
  };
  // Esmeralda saturado (água + verde do fundo) não existe na pintura: até ~12 px da borda
  // é sempre mistura com o fundo.
  const nearFar = dilate(transparent4, W4, H4, 48);
  const emerald = (r: number, g: number, b: number) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (mx !== g || d === 0 || r > 60) return false;
    const h = ((b - r) / d + 2) * 60;
    return h >= 128 && h <= 168 && d / mx > 0.75;
  };
  const rgba4 = Buffer.alloc(W4 * H4 * 4);
  for (let i = 0; i < W4 * H4; i++) {
    const r = big[i * 3], g = big[i * 3 + 1], b = big[i * 3 + 2];
    const edge = !transparent4[i] && (near[i] || (nearWide[i] && greenMix(r, g, b)) || (nearFar[i] && emerald(r, g, b)));
    let a = edge ? Math.min(1, Math.max(0, (205 - (g - Math.max(r, b))) / 165)) : keyAlpha(r, g, b);
    if (transparent4[i]) a = 0;
    const bgl = nearFar[i] ? Math.max(bgness(r, g, b), haloness(r, g, b)) : bgness(r, g, b);
    let rr = r, gg = g, bb = b;
    if (a > 0 && a < 1) {
      // desmistura da borda com o fundo
      rr = Math.min(255, Math.max(0, (r - (1 - a) * BG[0]) / a));
      gg = Math.min(255, Math.max(0, (g - (1 - a) * BG[1]) / a));
      bb = Math.min(255, Math.max(0, (b - (1 - a) * BG[2]) / a));
    }
    if (edge) gg = Math.min(gg, Math.max(rr, bb) + 18);
    if (bgl > 0) {
      a = Math.min(a, 1 - bgl);
      gg = Math.min(gg, Math.max(rr, bb) + 10);
    }
    if (a < 0.08) a = 0;
    rgba4[i * 4] = rr; rgba4[i * 4 + 1] = gg; rgba4[i * 4 + 2] = bb; rgba4[i * 4 + 3] = Math.round(a * 255);
  }

  // ---- buraquinhos (resto do fundo verde que a ampliação deixou na rocha e nas copas):
  // fechamento morfológico de raio ~2,5 px da imagem original; a cor vem dos vizinhos
  // opacos (propagação em largura). Vãos maiores (entre galhos, vigas) continuam abertos.
  {
    const solid4 = new Uint8Array(W4 * H4);
    for (let i = 0; i < W4 * H4; i++) solid4[i] = rgba4[i * 4 + 3] >= 128 ? 1 : 0;
    const closed4 = erode(dilate(solid4, W4, H4, 10), W4, H4, 10);
    // rocha na escala original: o fechamento (que também alisa recortes do contorno) só vale nela
    const src1 = await sharp(path.join(SRC, L.image)).extract({ left: x0, top: y0, width: CW, height: CH }).removeAlpha().raw().toBuffer();
    const rock1 = new Uint8Array(CW * CH);
    for (let i = 0; i < CW * CH; i++) {
      const m = classify(src1[i * 3], src1[i * 3 + 1], src1[i * 3 + 2]);
      rock1[i] = m === MAT.ROCK || m === MAT.DARK ? 1 : 0;
    }
    const rockNear = dilate(rock1, CW, CH, 4);
    // buracos totalmente cercados e pequenos (até ~12×12 px da original), em qualquer material:
    // furinhos na copa ou na pedra. Recortes do contorno e vãos grandes ficam abertos.
    const transp = new Uint8Array(W4 * H4);
    for (let i = 0; i < W4 * H4; i++) transp[i] = solid4[i] ? 0 : 1;
    const tc = components(transp, W4, H4);
    const enclosed = new Uint8Array(tc.areas.length).fill(1);
    for (let x = 0; x < W4; x++) { const a = tc.labels[x], b = tc.labels[(H4 - 1) * W4 + x]; if (a >= 0) enclosed[a] = 0; if (b >= 0) enclosed[b] = 0; }
    for (let y = 0; y < H4; y++) { const a = tc.labels[y * W4], b = tc.labels[y * W4 + W4 - 1]; if (a >= 0) enclosed[a] = 0; if (b >= 0) enclosed[b] = 0; }
    const known = new Uint8Array(W4 * H4);
    const queue: number[] = [];
    let filled = 0;
    for (let i = 0; i < W4 * H4; i++) {
      if (solid4[i]) { known[i] = 1; continue; }
      const l = tc.labels[i];
      const smallHole = l >= 0 && enclosed[l] && tc.areas[l] <= 2300;
      const x = i % W4, y = (i / W4) | 0;
      if (!smallHole && !(closed4[i] && rockNear[(y >> 2) * CW + (x >> 2)])) continue;
      known[i] = 2; // a preencher
      filled++;
    }
    for (let i = 0; i < W4 * H4; i++) {
      if (known[i] !== 2) continue;
      const x = i % W4;
      if ((x > 0 && known[i - 1] === 1) || (x < W4 - 1 && known[i + 1] === 1) || (i >= W4 && known[i - W4] === 1) || (i + W4 < W4 * H4 && known[i + W4] === 1)) queue.push(i);
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const i = queue[qi];
      if (known[i] !== 2) continue;
      const x = i % W4;
      let r = 0, g = 0, b = 0, n = 0;
      for (const q of [x > 0 ? i - 1 : -1, x < W4 - 1 ? i + 1 : -1, i - W4, i + W4]) {
        if (q < 0 || q >= W4 * H4) continue;
        if (known[q] === 1) { r += rgba4[q * 4]; g += rgba4[q * 4 + 1]; b += rgba4[q * 4 + 2]; n++; }
        else if (known[q] === 2) queue.push(q);
      }
      if (!n) continue;
      rgba4[i * 4] = r / n; rgba4[i * 4 + 1] = g / n; rgba4[i * 4 + 2] = b / n; rgba4[i * 4 + 3] = 255;
      known[i] = 1;
    }
    if (filled) console.log(`  ${filled} px de buraquinhos preenchidos (4×)`);
  }

  // ---- antisserrilhado da borda recortada: média 5×5 do alfa só na faixa da borda
  {
    const alpha = new Uint8Array(W4 * H4);
    for (let i = 0; i < W4 * H4; i++) alpha[i] = rgba4[i * 4 + 3];
    for (let y = 2; y < H4 - 2; y++) {
      for (let x = 2; x < W4 - 2; x++) {
        const i = y * W4 + x;
        if (!near[i]) continue;
        let s = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += alpha[i + dy * W4 + dx];
        rgba4[i * 4 + 3] = Math.min(alpha[i], Math.round(s / 25 + (alpha[i] - s / 25) * 0.35));
      }
    }
  }

  // ---- versão 2× (material, profundidade, grade)
  const W2 = CW * 2, H2 = CH * 2;
  const rgba2 = await sharp(rgba4, { raw: { width: W4, height: H4, channels: 4 } })
    .resize({ width: W2, height: H2, kernel: 'cubic' }).raw().toBuffer();
  const mat = new Uint8Array(W2 * H2);
  const solid = new Uint8Array(W2 * H2);
  for (let i = 0; i < W2 * H2; i++) {
    solid[i] = rgba2[i * 4 + 3] >= 128 ? 1 : 0;
    mat[i] = solid[i] ? classify(rgba2[i * 4], rgba2[i * 4 + 1], rgba2[i * 4 + 2]) : MAT.BG;
  }
  // Pedra cinza-azulada clara parece espuma: espuma só vale ligada a água de verdade.
  {
    const wet = new Uint8Array(W2 * H2);
    for (let i = 0; i < W2 * H2; i++) wet[i] = mat[i] === MAT.WATER || mat[i] === MAT.FOAM ? 1 : 0;
    const wc = components(wet, W2, H2);
    const waterPx = new Int32Array(wc.areas.length);
    for (let i = 0; i < W2 * H2; i++) if (wc.labels[i] >= 0 && mat[i] === MAT.WATER) waterPx[wc.labels[i]]++;
    let moved = 0;
    for (let i = 0; i < W2 * H2; i++) {
      const l = wc.labels[i];
      if (l < 0) continue;
      // "poça" pequena isolada (não há poças na pintura) ou espuma sem água: é pedra
      const smallPool = wc.areas[l] < 400;
      if (smallPool || (mat[i] === MAT.FOAM && waterPx[l] < 0.25 * wc.areas[l])) { mat[i] = MAT.ROCK; moved++; }
    }
    if (moved) console.log(`  ${moved} px de "água/espuma" sem água por perto reclassificados como pedra`);
  }

  // ---- manchas verdes/rosadas minúsculas dentro da água (resto da pintura) → cor da água
  {
    const stray = new Uint8Array(W2 * H2);
    for (let i = 0; i < W2 * H2; i++) stray[i] = mat[i] === MAT.GRASS || mat[i] === MAT.PINK || mat[i] === MAT.FOLIAGE ? 1 : 0;
    const sc = components(stray, W2, H2);
    let fixed = 0;
    const lists = new Map<number, number[]>();
    for (let i = 0; i < W2 * H2; i++) {
      const l = sc.labels[i];
      if (l < 0 || sc.areas[l] > 150) continue;
      if (!lists.has(l)) lists.set(l, []);
      lists.get(l)!.push(i);
    }
    for (const [l, pix] of lists) {
      // só se estiver cercada de água (≥ 85% do contorno)
      let ring = 0, water = 0, sr = 0, sg = 0, sb = 0;
      for (const i of pix) {
        for (const q of [i - 1, i + 1, i - W2, i + W2]) {
          if (q < 0 || q >= W2 * H2 || sc.labels[q] === l) continue;
          ring++;
          if (mat[q] === MAT.WATER || mat[q] === MAT.FOAM) {
            water++; sr += rgba2[q * 4]; sg += rgba2[q * 4 + 1]; sb += rgba2[q * 4 + 2];
          } else if (!solid[q]) ring--; // borda esmaecida da água: o transparente não conta
        }
      }
      if (!water || !ring || water / ring < 0.75) continue;
      const c = [sr / water, sg / water, sb / water];
      for (const i of pix) {
        mat[i] = MAT.WATER;
        const x2 = i % W2, y2 = (i / W2) | 0;
        for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) {
          const X = x2 * 2 + dx, Y = y2 * 2 + dy;
          if (X < 0 || Y < 0 || X >= W4 || Y >= H4) continue;
          const k = (Y * W4 + X) * 4;
          rgba4[k] = c[0]; rgba4[k + 1] = c[1]; rgba4[k + 2] = c[2];
        }
      }
      fixed++;
    }
    if (fixed) console.log(`  ${fixed} manchas soltas dentro da água limpas`);
  }

  // ---- água pintada se dissolve no mar procedural na borda externa
  const transparent = new Uint8Array(W2 * H2);
  for (let i = 0; i < W2 * H2; i++) transparent[i] = solid[i] ? 0 : 1;
  const distOut = edt(transparent, W2, H2); // px 2× até o transparente mais próximo
  const FEATHER = 26; // px 2× (~0,45 m)
  for (let y = 0; y < H4; y++) {
    for (let x = 0; x < W4; x++) {
      const j = (y >> 1) * W2 + (x >> 1);
      if (mat[j] !== MAT.WATER && mat[j] !== MAT.FOAM) continue;
      const t = Math.min(1, distOut[j] / FEATHER);
      const k = (y * W4 + x) * 4 + 3;
      rgba4[k] = Math.round(rgba4[k] * t * t * (3 - 2 * t));
    }
  }

  // ---- blocos de textura (≤ 4096 px), com 2 px de sobreposição para a filtragem
  const nTiles = Math.ceil(W4 / (MAX_TEX - 4));
  const tileW = Math.ceil(W4 / nTiles);
  const tiles: { file: string; x0: number; x1: number; px0: number; px1: number }[] = [];
  for (let t = 0; t < nTiles; t++) {
    const a = t * tileW, b = Math.min(W4, a + tileW);
    const pa = Math.max(0, a - 2), pb = Math.min(W4, b + 2);
    const file = `island_${t}.webp`;
    await sharp(rgba4, { raw: { width: W4, height: H4, channels: 4 } })
      .extract({ left: pa, top: 0, width: pb - pa, height: H4 })
      .webp({ quality: 90, alphaQuality: 100, smartSubsample: true, effort: 4 })
      .toFile(path.join(OUT, file));
    tiles.push({ file, x0: a, x1: b, px0: pa, px1: pb });
  }
  console.log(`→ ilha ${W4}×${H4} em ${nTiles} bloco(s) de textura`);

  // -------------------------------------------------------------------------
  // 3. Regiões, cartões e máscara de caminhada (2×)
  const toPx2 = (p: Pt) => [(p[0] - x0) * 2, (p[1] - y0) * 2] as Pt;
  const regionId = new Int16Array(W2 * H2).fill(-1);
  for (const r of regions) {
    rasterPoly(r.poly.map(toPx2), 1, W2, H2, (i) => { if (regionId[i] < 0) regionId[i] = r.index; });
  }

  // Cartões: objetos altos com base própria (máscara = polígono ∩ material, com fechamento)
  const OBJ_MATS = new Set<number>([MAT.PINK, MAT.FOLIAGE, MAT.TRUNK, MAT.RED, MAT.DARK]);
  const TORII_MATS = new Set<number>([MAT.RED, MAT.DARK, MAT.TRUNK]);
  const cardId = new Int16Array(W2 * H2).fill(-1);
  L.cards.forEach((card, ci) => {
    const m = new Uint8Array(W2 * H2);
    const inPoly = new Uint8Array(W2 * H2);
    const exact = new Uint8Array(W2 * H2); // partes 'any': entram sem fechamento
    for (const part of card.parts) {
      rasterPoly(part.poly.map(toPx2), 1, W2, H2, (i) => {
        inPoly[i] = 1;
        if (!solid[i]) return;
        if (part.mats === 'any') exact[i] = 1;
        else if ((part.mats === 'torii' ? TORII_MATS : OBJ_MATS).has(mat[i])) m[i] = 1;
      });
    }
    // fechamento: folhas claras classificadas como grama não abrem buracos
    let closed = erode(dilate(m, W2, H2, card.trunk ? 4 : 2), W2, H2, card.trunk ? 4 : 2);
    for (let i = 0; i < W2 * H2; i++) closed[i] = (closed[i] && inPoly[i] && solid[i]) || exact[i] ? 1 : 0;
    if (card.trunk) closed = keepTreeParts(closed, W2, H2, (i) => mat[i] === MAT.TRUNK, (i) => !solid[i]);
    for (let i = 0; i < W2 * H2; i++) if (closed[i] && cardId[i] < 0) cardId[i] = ci;
  });

  const walk = new Uint8Array(W2 * H2);
  for (let i = 0; i < W2 * H2; i++) {
    const r = regionId[i] >= 0 ? regions[regionId[i]] : null;
    if (!r || r.kind !== 'walk' || !solid[i]) continue;
    walk[i] = r.forceWalk || WALKABLE_MATS.has(mat[i]) || cardId[i] >= 0 ? 1 : 0;
  }
  // limpeza: pedrinhas/tufos pequenos não bloqueiam; tufos de grama soltos não contam
  {
    const obstacle = new Uint8Array(W2 * H2);
    for (let i = 0; i < W2 * H2; i++) {
      const r = regionId[i] >= 0 ? regions[regionId[i]] : null;
      obstacle[i] = r && r.kind === 'walk' && !walk[i] ? 1 : 0;
    }
    const oc = components(obstacle, W2, H2);
    // ~0,6 m: pedras chatas do caminho e plantinhas não bloqueiam; rochas e arbustos sim
    for (let i = 0; i < W2 * H2; i++) if (oc.labels[i] >= 0 && oc.areas[oc.labels[i]] < 620) walk[i] = 1;
    const wc = components(walk, W2, H2);
    for (let i = 0; i < W2 * H2; i++) if (wc.labels[i] >= 0 && wc.areas[wc.labels[i]] < 160) walk[i] = 0;
  }

  // -------------------------------------------------------------------------
  // 4. Mapa de profundidade (2×): chave = v do chão "dono" do pixel; limiar de nível
  const key = new Float32Array(W2 * H2).fill(NaN);
  const thr = new Uint8Array(W2 * H2);
  const flags = new Uint8Array(W2 * H2);
  const FLAG_CARD = 8, FLAG_SEA = 16, FLAG_FALL = 32, FLAG_VALID = 64;
  const isGround = new Uint8Array(W2 * H2);
  const groundLevel = new Float32Array(W2 * H2);
  const fall = new Uint8Array(W2 * H2);
  rasterPoly(L.waterfall.map(toPx2), 1, W2, H2, (i) => (fall[i] = 1));

  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      const i = y * W2 + x;
      if (!solid[i]) continue;
      const sx = x / 2 + x0, sy = y / 2 + y0;
      const r = regionId[i] >= 0 ? regions[regionId[i]] : null;
      const m = mat[i];
      // Pedrinhas, tufos e sombras pequenas (caminháveis após a limpeza) são chão, não objetos.
      const groundish = r && (r.kind === 'surface' || r.forceWalk || walk[i] || WALKABLE_MATS.has(m));
      if (r && groundish && cardId[i] < 0) {
        const h = r.heightAtPixel(sx, sy);
        key[i] = toGround(sx, sy, h).v;
        groundLevel[i] = levelAt(r, h);
        isGround[i] = 1;
      } else if ((m === MAT.WATER || m === MAT.FOAM) && cardId[i] < 0) {
        key[i] = toGround(sx, sy, L.water).v;
        groundLevel[i] = 0;
        isGround[i] = 1;
        flags[i] |= FLAG_SEA | (fall[i] ? FLAG_FALL : 0);
      }
    }
  }
  // Objetos sem cartão (rochas, faces de penhasco): base = chão logo abaixo na coluna.
  for (let x = 0; x < W2; x++) {
    let belowKey = NaN, belowLevel = 0;
    const lb = new Float32Array(H2).fill(-1);
    for (let y = H2 - 1; y >= 0; y--) {
      const i = y * W2 + x;
      if (isGround[i]) { belowKey = key[i]; belowLevel = groundLevel[i]; continue; }
      if (!solid[i] || cardId[i] >= 0) continue;
      if (!Number.isNaN(belowKey)) { key[i] = belowKey; lb[y] = belowLevel; }
    }
    let aboveLevel = -1;
    for (let y = 0; y < H2; y++) {
      const i = y * W2 + x;
      if (isGround[i]) {
        aboveLevel = groundLevel[i];
        thr[i] = Math.ceil(groundLevel[i] - 1e-3);
        continue;
      }
      if (lb[y] >= 0) thr[i] = Math.ceil(Math.max(aboveLevel, lb[y] + 1) - 1e-3);
    }
  }
  // Cartões: chave pela base (ponto, ou linha interpolada pela coluna)
  L.cards.forEach((card, ci) => {
    const on = regionById.get(card.on)!;
    const base = (Array.isArray(card.base[0]) ? card.base : [card.base, card.base]) as [Pt, Pt];
    const g = base.map((p) => ({ x: p[0], v: toGround(p[0], p[1], on.heightAtPixel(p[0], p[1])).v }));
    const lvl = Math.ceil(levelAt(on, on.heightAtPixel(base[0][0], base[0][1])) - 1e-3) + 1;
    for (let i = 0; i < W2 * H2; i++) {
      if (cardId[i] !== ci) continue;
      const sx = (i % W2) / 2 + x0;
      const t = g[1].x === g[0].x ? 0 : Math.min(1, Math.max(0, (sx - g[0].x) / (g[1].x - g[0].x)));
      key[i] = g[0].v + t * (g[1].v - g[0].v);
      thr[i] = lvl;
      flags[i] |= FLAG_CARD;
    }
  });

  const keymap = Buffer.alloc(W2 * H2 * 4);
  let valid = 0;
  for (let i = 0; i < W2 * H2; i++) {
    keymap[i * 4 + 3] = 255;
    if (Number.isNaN(key[i])) continue;
    const q = Math.round(((key[i] - KEY_MIN) / (KEY_MAX - KEY_MIN)) * 65535);
    const qc = Math.min(65535, Math.max(0, q));
    keymap[i * 4] = qc >> 8;
    keymap[i * 4 + 1] = qc & 255;
    keymap[i * 4 + 2] = (thr[i] & 7) | flags[i] | FLAG_VALID;
    valid++;
  }
  await sharp(keymap, { raw: { width: W2, height: H2, channels: 4 } }).png({ compressionLevel: 9 }).toFile(path.join(OUT, 'depth.png'));
  // sobreposição de depuração (painel → "mostrar área caminhável")
  {
    const ov = Buffer.alloc(W2 * H2 * 4);
    for (let i = 0; i < W2 * H2; i++) {
      const r = regionId[i] >= 0 ? regions[regionId[i]] : null;
      if (!r || r.kind !== 'walk' || !solid[i]) continue;
      if (walk[i]) { ov[i * 4 + 1] = 255; ov[i * 4 + 3] = 150; } else { ov[i * 4] = 255; ov[i * 4 + 3] = 170; }
    }
    await sharp(ov, { raw: { width: W2, height: H2, channels: 4 } }).resize({ width: CW, height: CH, kernel: 'nearest' })
      .png({ compressionLevel: 9, palette: true }).toFile(path.join(OUT, 'walk.png'));
  }
  console.log(`→ profundidade ${W2}×${H2} (${((valid / (W2 * H2)) * 100).toFixed(0)}% com dados)`);

  // -------------------------------------------------------------------------
  // 5. Grade do chão
  const walkRegions = regions.filter((r) => r.kind === 'walk');
  let gu0 = Infinity, gv0 = Infinity, gu1 = -Infinity, gv1 = -Infinity;
  for (const r of walkRegions) {
    for (const [px, py] of r.poly) {
      const g = toGround(px, py, r.heightAtPixel(px, py));
      gu0 = Math.min(gu0, g.u); gu1 = Math.max(gu1, g.u);
      gv0 = Math.min(gv0, g.v); gv1 = Math.max(gv1, g.v);
    }
  }
  gu0 = Math.floor(gu0 - 1); gv0 = Math.floor(gv0 - 1); gu1 = Math.ceil(gu1 + 1); gv1 = Math.ceil(gv1 + 1);
  const GW = Math.round((gu1 - gu0) / CELL), GH = Math.round((gv1 - gv0) / CELL);
  const gHeight = new Float32Array(GW * GH).fill(NaN);
  const gRegion = new Int8Array(GW * GH).fill(-1);
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      const u = gu0 + (i + 0.5) * CELL, v = gv0 + (j + 0.5) * CELL;
      for (const r of walkRegions) {
        const h = r.heightAt(u, v);
        const p = toImage(u, v, h);
        const px = Math.floor((p.x - x0) * 2), py = Math.floor((p.y - y0) * 2);
        if (px < 0 || py < 0 || px >= W2 || py >= H2) continue;
        const k = py * W2 + px;
        if (regionId[k] !== r.index || !walk[k]) continue;
        gHeight[j * GW + i] = h;
        gRegion[j * GW + i] = r.index;
        break;
      }
    }
  }
  // troncos e pilares
  const blockers = L.blockers.map((b) => {
    const on = regionById.get(b.on)!;
    const g = toGround(b.at[0], b.at[1], on.heightAtPixel(b.at[0], b.at[1]));
    return { id: b.id, u: +g.u.toFixed(3), v: +g.v.toFixed(3), r: b.r };
  });
  for (const b of blockers) {
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const u = gu0 + (i + 0.5) * CELL, v = gv0 + (j + 0.5) * CELL;
        if ((u - b.u) ** 2 + (v - b.v) ** 2 <= b.r * b.r) { gHeight[j * GW + i] = NaN; gRegion[j * GW + i] = -1; }
      }
    }
  }
  // só o que é alcançável a partir do ponto inicial (sem degraus > 25 cm entre células)
  const spawnRegion = regionById.get(L.spawn.on)!;
  const sg = toGround(L.spawn.at[0], L.spawn.at[1], spawnRegion.heightAtPixel(...L.spawn.at));
  {
    const si = Math.floor((sg.u - gu0) / CELL), sj = Math.floor((sg.v - gv0) / CELL);
    const seen = new Uint8Array(GW * GH);
    const stack = [sj * GW + si];
    if (Number.isNaN(gHeight[stack[0]])) throw new Error('ponto inicial fora da área caminhável');
    seen[stack[0]] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const ci = c % GW, cj = (c / GW) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= GW || nj >= GH) continue;
        const n = nj * GW + ni;
        if (seen[n] || Number.isNaN(gHeight[n]) || Math.abs(gHeight[n] - gHeight[c]) > 0.25) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    let cut = 0;
    for (let k = 0; k < GW * GH; k++) if (!seen[k] && !Number.isNaN(gHeight[k])) { gHeight[k] = NaN; gRegion[k] = -1; cut++; }
    if (cut) console.log(`  ${cut} células isoladas removidas`);
  }
  smoothGrid(gHeight, gRegion, GW, GH);
  // desníveis entre células vizinhas (beira de terraço) também são parede
  {
    const cut: number[] = [];
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      const k = j * GW + i;
      if (Number.isNaN(gHeight[k])) continue;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= GW || nj >= GH) continue;
        const n = nj * GW + ni;
        if (!Number.isNaN(gHeight[n]) && Math.abs(gHeight[n] - gHeight[k]) > 0.25) { cut.push(k); break; }
      }
    }
    for (const k of cut) { gHeight[k] = NaN; gRegion[k] = -1; }
    if (cut.length) console.log(`  ${cut.length} células de beira de desnível viraram parede`);
  }
  // reachability de novo (a suavização pode isolar pedacinhos)
  {
    const si = Math.floor((sg.u - gu0) / CELL), sj = Math.floor((sg.v - gv0) / CELL);
    const seen = new Uint8Array(GW * GH);
    const stack = [sj * GW + si];
    seen[stack[0]] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const ci = c % GW, cj = (c / GW) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= GW || nj >= GH) continue;
        const n = nj * GW + ni;
        if (seen[n] || Number.isNaN(gHeight[n])) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    for (let k = 0; k < GW * GH; k++) if (!seen[k]) { gHeight[k] = NaN; gRegion[k] = -1; }
  }
  const blockedSeed = new Uint8Array(GW * GH);
  for (let k = 0; k < GW * GH; k++) blockedSeed[k] = Number.isNaN(gHeight[k]) ? 1 : 0;
  const sdf = edt(blockedSeed, GW, GH);
  const bin = Buffer.alloc(GW * GH * 5);
  for (let k = 0; k < GW * GH; k++) {
    const h = Number.isNaN(gHeight[k]) ? -32768 : Math.round(gHeight[k] * 100);
    bin.writeInt16LE(h, k * 2);
    bin.writeInt16LE(Math.min(32767, Math.round(sdf[k] * CELL * 100)), GW * GH * 2 + k * 2);
    bin[GW * GH * 4 + k] = gRegion[k] + 1;
  }
  await fsp.writeFile(path.join(OUT, 'ground.bin'), bin);
  const walkCells = blockedSeed.reduce((a, b) => a + (b ? 0 : 1), 0);
  console.log(`→ chão ${GW}×${GH} células de ${CELL} m · ${(walkCells * CELL * CELL).toFixed(0)} m² caminháveis`);

  // ---- água (textura contínua) e metadados
  await sharp(path.join(SRC, 'water.png')).resize(1024, 1024).webp({ quality: 88, effort: 4 }).toFile(path.join(OUT, 'water.webp'));

  // Pegada da ilha no nível do mar, para a neblina: frente pela borda pintada, fundo pelo platô.
  let frontV = Infinity, minX = Infinity, maxX = -Infinity;
  for (let x = 0; x < W2; x++) {
    for (let y = H2 - 1; y >= 0; y--) {
      if (!solid[y * W2 + x]) continue;
      const sx = x / 2 + x0, sy = y / 2 + y0;
      frontV = Math.min(frontV, toGround(sx, sy, L.water).v);
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
      break;
    }
  }
  const backV = gv1 + 2; // a água continua visível atrás da ilha; a neblina fecha além dela
  const fog = {
    cu: +((minX + maxX) / 2 / S).toFixed(2), cv: +((frontV + backV) / 2).toFixed(2),
    ru: +((maxX - minX) / 2 / S).toFixed(2), rv: +((backV - frontV) / 2).toFixed(2),
  };

  const meta = {
    pxPerMeter: S,
    imageHeight: H_IMG,
    pitchDeg: 30,
    /** Retângulo da ilha em coordenadas de tela (m): x = u, y = v·sen + h·cos. */
    screenRect: { x: x0 / S, y: (H_IMG - y1) / S, w: CW / S, h: CH / S },
    tiles: tiles.map((t) => ({ ...t, texW: t.px1 - t.px0, texH: H4 })),
    texScale: 4,
    depth: { file: 'depth.png', w: W2, h: H2, keyMin: KEY_MIN, keyMax: KEY_MAX },
    grid: { file: 'ground.bin', u0: gu0, v0: gv0, cell: CELL, w: GW, h: GH },
    regions: regions.map((r) => ({
      id: r.id, kind: r.kind, level: r.level, level1: r.level1 ?? r.level, speed: r.speed ?? 1,
      ramp: r.ramp ? { h0: r.ramp.h0, h1: r.ramp.h1, steps: r.ramp.steps ?? 0 } : null,
    })),
    blockers,
    spawn: { u: +sg.u.toFixed(3), v: +sg.v.toFixed(3) },
    water: { file: 'water.webp', height: L.water },
    fog,
    walkOverlay: 'walk.png',
  };
  await fsp.writeFile(path.join(OUT, 'island.json'), JSON.stringify(meta, null, 2));
  console.log(`→ island.json · ponto inicial (${meta.spawn.u}, ${meta.spawn.v}) · neblina ${JSON.stringify(fog)}`);

  if (DEBUG) await writeDebug({ W2, H2, rgba2, mat, walk, regionId, cardId, key, thr, GW, GH, gHeight, sdf });
}

/**
 * Mantém só as partes da máscara de uma árvore ligadas ao tronco (ou que encostam no céu):
 * arbustos no chão sob a copa não são parte da árvore.
 */
function keepTreeParts(m: Uint8Array, w: number, h: number, isTrunk: (i: number) => boolean, isSky: (i: number) => boolean) {
  const { labels, areas } = components(m, w, h);
  const keep = new Uint8Array(areas.length);
  for (let i = 0; i < w * h; i++) {
    const l = labels[i];
    if (l < 0 || keep[l]) continue;
    if (isTrunk(i)) { keep[l] = 1; continue; }
    const x = i % w;
    if ((x > 0 && isSky(i - 1)) || (x < w - 1 && isSky(i + 1)) || (i >= w && isSky(i - w)) || (i + w < w * h && isSky(i + w))) keep[l] = 1;
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (labels[i] >= 0 && keep[labels[i]]) out[i] = 1;
  return out;
}

/**
 * Suaviza a borda da área caminhável (filtro de maioria 3×3, 2 passadas): serrilhado de
 * 1–2 células da classificação por pixel vira parede lisa, onde o personagem escorrega
 * em vez de enroscar. Células novas herdam a altura dos vizinhos (só se forem coerentes).
 */
function smoothGrid(hgt: Float32Array, reg: Int8Array, w: number, h: number) {
  for (let pass = 0; pass < 2; pass++) {
    const nh = hgt.slice(), nr = reg.slice();
    let added = 0, removed = 0;
    for (let j = 1; j < h - 1; j++) {
      for (let i = 1; i < w - 1; i++) {
        const k = j * w + i;
        let n = 0, sum = 0, mn = Infinity, mx = -Infinity, r = -1;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const q = (j + dj) * w + i + di;
          if (Number.isNaN(hgt[q])) continue;
          n++; sum += hgt[q]; mn = Math.min(mn, hgt[q]); mx = Math.max(mx, hgt[q]);
          if (q !== k) r = reg[q];
        }
        const valid = !Number.isNaN(hgt[k]);
        if (valid && n < 4) { nh[k] = NaN; nr[k] = -1; removed++; }
        else if (!valid && n >= 6 && mx - mn < 0.12) { nh[k] = sum / n; nr[k] = r; added++; }
      }
    }
    hgt.set(nh);
    reg.set(nr);
    if (pass === 0) console.log(`  suavização da borda: +${added} / −${removed} células`);
  }
}

// ---------------------------------------------------------------------------
// Morfologia simples (máscaras)

function dilate(m: Uint8Array, w: number, h: number, r: number) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = -1;
    for (let x = 0; x < w; x++) { if (m[y * w + x]) run = x; if (run >= 0 && x - run <= r) tmp[y * w + x] = 1; }
    run = -1;
    for (let x = w - 1; x >= 0; x--) { if (m[y * w + x]) run = x; if (run >= 0 && run - x <= r) tmp[y * w + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let run = -1;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) run = y; if (run >= 0 && y - run <= r) out[y * w + x] = 1; }
    run = -1;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) run = y; if (run >= 0 && run - y <= r) out[y * w + x] = 1; }
  }
  return out;
}

function erode(m: Uint8Array, w: number, h: number, r: number) {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inv[i] = m[i] ? 0 : 1;
  const d = dilate(inv, w, h, r);
  for (let i = 0; i < w * h; i++) d[i] = d[i] ? 0 : 1;
  return d;
}

// ---------------------------------------------------------------------------
// Depuração

async function writeDebug(o: {
  W2: number; H2: number; rgba2: Buffer; mat: Uint8Array; walk: Uint8Array; regionId: Int16Array; cardId: Int16Array;
  key: Float32Array; thr: Uint8Array; GW: number; GH: number; gHeight: Float32Array; sdf: Float32Array;
}) {
  await fsp.mkdir(DEBUG_DIR, { recursive: true });
  const { W2, H2 } = o;
  // sobreposição: caminhável (verde), cartões (magenta), regiões não caminháveis (azul)
  const ov = Buffer.alloc(W2 * H2 * 3);
  const matv = Buffer.alloc(W2 * H2 * 3);
  const keyv = Buffer.alloc(W2 * H2 * 3);
  for (let i = 0; i < W2 * H2; i++) {
    const a = o.rgba2[i * 4 + 3] / 255;
    let r = o.rgba2[i * 4] * a * 0.55, g = o.rgba2[i * 4 + 1] * a * 0.55, b = o.rgba2[i * 4 + 2] * a * 0.55;
    if (o.walk[i]) { g += 110; }
    else if (o.regionId[i] >= 0 && regions[o.regionId[i]].kind === 'walk') { r += 120; }
    if (o.cardId[i] >= 0) { r += 70; b += 90; }
    ov[i * 3] = Math.min(255, r); ov[i * 3 + 1] = Math.min(255, g); ov[i * 3 + 2] = Math.min(255, b);
    const c = MAT_COLORS[o.mat[i]];
    matv[i * 3] = c[0]; matv[i * 3 + 1] = c[1]; matv[i * 3 + 2] = c[2];
    if (!Number.isNaN(o.key[i])) {
      const t = Math.min(1, Math.max(0, o.key[i] / 60));
      const lv = o.thr[i];
      keyv[i * 3] = Math.round(255 * t);
      keyv[i * 3 + 1] = lv * 50;
      keyv[i * 3 + 2] = Math.round(255 * (1 - t));
    }
  }
  const save = (buf: Buffer, w: number, h: number, name: string) =>
    sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(path.join(DEBUG_DIR, name));
  await save(ov, W2, H2, 'level_walk.png');
  await save(matv, W2, H2, 'level_material.png');
  await save(keyv, W2, H2, 'level_depth.png');
  // grade do chão: altura (cor) + campo de distância (brilho), v para cima
  const g = Buffer.alloc(o.GW * o.GH * 3);
  for (let j = 0; j < o.GH; j++) {
    for (let i = 0; i < o.GW; i++) {
      const k = j * o.GW + i, d = ((o.GH - 1 - j) * o.GW + i) * 3;
      const h = o.gHeight[k];
      if (Number.isNaN(h)) { g[d] = 25; g[d + 1] = 25; g[d + 2] = 35; continue; }
      const t = h / 3, s = Math.min(1, (o.sdf[k] * CELL) / 1.2);
      g[d] = Math.round(255 * t * (0.5 + 0.5 * s)); g[d + 1] = Math.round(200 * (0.5 + 0.5 * s)); g[d + 2] = Math.round(255 * (1 - t) * (0.5 + 0.5 * s));
    }
  }
  await save(g, o.GW, o.GH, 'level_ground.png');
  console.log('  depuração: .sprite-debug/level_{walk,material,depth,ground}.png');
}

await main();


