import * as THREE from 'three';

/** Formato gerado por tools/build-level.ts (public/level/island.json). */
export interface LevelMeta {
  pxPerMeter: number;
  imageHeight: number;
  pitchDeg: number;
  /** Retângulo da ilha em coordenadas de tela (m). */
  screenRect: { x: number; y: number; w: number; h: number };
  tiles: { file: string; x0: number; x1: number; px0: number; px1: number; texW: number; texH: number }[];
  texScale: number;
  depth: { file: string; w: number; h: number; keyMin: number; keyMax: number };
  grid: { file: string; u0: number; v0: number; cell: number; w: number; h: number };
  regions: {
    id: string; kind: 'walk' | 'surface'; level: number; level1: number; speed: number;
    ramp: { h0: number; h1: number; steps: number } | null;
  }[];
  blockers: { id: string; u: number; v: number; r: number }[];
  spawn: { u: number; v: number };
  water: { file: string; height: number };
  fog: { cu: number; cv: number; ru: number; rv: number };
  walkOverlay?: string;
}

export interface MoveResult {
  u: number;
  v: number;
  /** Fração do deslocamento pedido feita na direção pedida (0 = parede). */
  ratio: number;
  /** Distância realmente percorrida (inclui escorregar pela parede). */
  moved: number;
}

const NONE = -32768;

/**
 * Cenário em coordenadas do chão (u = direita da tela, v = "para dentro"; metros).
 * Grade de 0,1 m com altura, região e distância até a barreira mais próxima.
 */
export class Level {
  private constructor(
    readonly meta: LevelMeta,
    private readonly heights: Int16Array,
    private readonly clear: Int16Array,
    private readonly region: Uint8Array,
    /** Mapa de profundidade por pixel (RGBA), também na GPU. */
    private readonly depthPx: Uint8ClampedArray,
    readonly depthTexture: THREE.Texture,
    readonly baseUrl: string,
  ) {}

  static async load(url: string): Promise<Level> {
    const base = url.slice(0, url.lastIndexOf('/') + 1);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cenário não encontrado em ${url} (rode "npm run level")`);
    const meta = (await res.json()) as LevelMeta;
    const [bin, depth] = await Promise.all([
      fetch(base + meta.grid.file).then((r) => r.arrayBuffer()),
      loadPixels(base + meta.depth.file),
    ]);
    const n = meta.grid.w * meta.grid.h;
    const heights = new Int16Array(bin, 0, n);
    const clear = new Int16Array(bin, n * 2, n);
    const region = new Uint8Array(bin, n * 4, n);
    const tex = new THREE.DataTexture(flipRows(depth.data, depth.width, depth.height), depth.width, depth.height, THREE.RGBAFormat);
    tex.magFilter = tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return new Level(meta, heights, clear, region, depth.data, tex, base);
  }

  get spawn() {
    return this.meta.spawn;
  }

  // -------------------------------------------------------------------------
  // Grade

  private cellAt(u: number, v: number) {
    const g = this.meta.grid;
    const i = Math.floor((u - g.u0) / g.cell), j = Math.floor((v - g.v0) / g.cell);
    if (i < 0 || j < 0 || i >= g.w || j >= g.h) return -1;
    return j * g.w + i;
  }

  /** Interpolação bilinear só entre células válidas (sem misturar com o "vazio"). */
  private sample(arr: Int16Array, u: number, v: number, needHeight: boolean) {
    const g = this.meta.grid;
    const fx = (u - g.u0) / g.cell - 0.5, fy = (v - g.v0) / g.cell - 0.5;
    const i0 = Math.floor(fx), j0 = Math.floor(fy);
    const tx = fx - i0, ty = fy - j0;
    let sum = 0, wsum = 0;
    for (let dj = 0; dj < 2; dj++) {
      for (let di = 0; di < 2; di++) {
        const i = i0 + di, j = j0 + dj;
        if (i < 0 || j < 0 || i >= g.w || j >= g.h) continue;
        const k = j * g.w + i;
        if (needHeight && this.heights[k] === NONE) continue;
        const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty);
        sum += arr[k] * w;
        wsum += w;
      }
    }
    return wsum > 1e-6 ? sum / wsum / 100 : NaN;
  }

  /** Altura do chão caminhável (NaN fora). */
  heightAt(u: number, v: number) {
    const k = this.cellAt(u, v);
    if (k < 0 || this.heights[k] === NONE) return NaN;
    return this.sample(this.heights, u, v, true);
  }

  /** Distância (m) até a barreira mais próxima (0 fora da área caminhável). */
  clearance(u: number, v: number) {
    const k = this.cellAt(u, v);
    if (k < 0 || this.heights[k] === NONE) return 0;
    return this.sample(this.clear, u, v, false);
  }

  regionAt(u: number, v: number) {
    const k = this.cellAt(u, v);
    if (k < 0 || !this.region[k]) return null;
    return this.meta.regions[this.region[k] - 1];
  }

  /** Nível de oclusão (rampas e escadas interpolam entre os terraços). */
  levelAt(u: number, v: number, h: number) {
    const r = this.regionAt(u, v);
    if (!r) return 1;
    if (!r.ramp) return r.level;
    const t = (h - r.ramp.h0) / (r.ramp.h1 - r.ramp.h0);
    return r.level + Math.min(1, Math.max(0, t)) * (r.level1 - r.level);
  }

  /**
   * Altura exibida: nas escadas os pés ficam no plano de cada degrau e sobem o espelho
   * suavemente na faixa central entre dois degraus — pela posição, então a subida
   * acompanha a passada (sem estalo por tempo) e é igual na ida e na volta.
   */
  displayHeight(u: number, v: number, h: number) {
    const r = this.regionAt(u, v);
    if (!r?.ramp || !r.ramp.steps) return { h, stairs: false };
    const { h0, h1, steps } = r.ramp;
    const s = Math.min(1, Math.max(0, (h - h0) / (h1 - h0))) * steps;
    const k = Math.floor(s), f = s - k;
    const e = Math.min(1, Math.max(0, (f - 0.2) / 0.6));
    return { h: h0 + ((k + e * e * (3 - 2 * e)) / steps) * (h1 - h0), stairs: true };
  }

  speedAt(u: number, v: number) {
    return this.regionAt(u, v)?.speed ?? 1;
  }

  // -------------------------------------------------------------------------
  // Movimento

  /** Normal da barreira (aponta para longe dela), pelo gradiente do campo de distância. */
  private wallNormal(u: number, v: number) {
    const e = 0.08;
    const gx = this.clearance(u + e, v) - this.clearance(u - e, v);
    const gy = this.clearance(u, v + e) - this.clearance(u, v - e);
    const len = Math.hypot(gx, gy);
    return len > 1e-6 ? { x: gx / len, y: gy / len } : null;
  }

  /**
   * Move com colisão em subpassos de ≤ 4 cm. Encostando numa parede, o ponto é empurrado
   * para fora dela pela normal do campo de distância: o que sobra do movimento é a
   * componente tangente, então ela escorrega rente à parede sem enroscar no serrilhado.
   * Para só quando não há para onde ir (de frente para a parede, desnível, corredor estreito).
   */
  move(u: number, v: number, h: number, du: number, dv: number, radius: number, maxStep: number): MoveResult {
    const want = Math.hypot(du, dv);
    if (want < 1e-9) return { u, v, ratio: 1, moved: 0 };
    const n = Math.max(1, Math.ceil(want / 0.04));
    const su = du / n, sv = dv / n;
    let cu = u, cv = v, ch = h;
    for (let k = 0; k < n; k++) {
      let nu = cu + su, nv = cv + sv;
      for (let it = 0; it < 3; it++) {
        const c = this.clearance(nu, nv);
        if (c >= radius) break;
        const g = this.wallNormal(nu, nv);
        if (!g) break;
        const push = radius - c + 1e-3;
        nu += g.x * push;
        nv += g.y * push;
      }
      const hh = this.heightAt(nu, nv);
      if (Number.isNaN(hh) || Math.abs(hh - ch) > maxStep) break;
      // ainda dentro da folga mínima e sem melhorar: não avança
      const cNew = this.clearance(nu, nv);
      if (cNew < radius * 0.8 && cNew <= this.clearance(cu, cv)) break;
      // o empurrão não pode levar para trás do ponto de partida do subpasso
      if ((nu - cu) * su + (nv - cv) * sv <= 0) break;
      cu = nu;
      cv = nv;
      ch = hh;
    }
    const moved = Math.hypot(cu - u, cv - v);
    return { u: cu, v: cv, ratio: Math.max(0, ((cu - u) * du + (cv - v) * dv) / (want * want)), moved };
  }

  // -------------------------------------------------------------------------
  // Profundidade

  /** Dados do mapa de profundidade num ponto de tela (m). */
  depthAt(sx: number, sy: number) {
    const r = this.meta.screenRect, d = this.meta.depth;
    const px = Math.floor(((sx - r.x) / r.w) * d.w), py = Math.floor((1 - (sy - r.y) / r.h) * d.h);
    if (px < 0 || py < 0 || px >= d.w || py >= d.h) return null;
    const k = (py * d.w + px) * 4;
    const b = this.depthPx[k + 2];
    if (!(b & 64)) return null;
    const key = ((this.depthPx[k] * 256 + this.depthPx[k + 1]) / 65535) * (d.keyMax - d.keyMin) + d.keyMin;
    return { key, thr: b & 7, card: !!(b & 8), sea: !!(b & 16) };
  }

  /**
   * Projétil bate quando algo da pintura fica na frente dele (penhasco, rocha) ou ao
   * atravessar um tronco/pilar. Atrás de copas ele só some (não bate).
   * Devolve a chave de profundidade do que foi atingido (a explosão aparece sobre essa
   * superfície e atrás do que estiver na frente dela) ou null.
   */
  /**
   * Menor chave dos obstáculos (rochas, penhascos; sem copas nem mar) acima de `level` num
   * retângulo de tela (m). A colisão do projétil acontece quando ele passa para trás da
   * silhueta de algo mais alto, e a base dessa rocha pode estar metros mais perto da câmera
   * que o ponto de contato: com esta chave a explosão aparece inteira sobre ela.
   */
  frontKey(sx0: number, sy0: number, sx1: number, sy1: number, level: number, step = 0.08) {
    let key = Infinity;
    for (let sy = sy0; sy <= sy1; sy += step) {
      for (let sx = sx0; sx <= sx1; sx += step) {
        const d = this.depthAt(sx, sy);
        if (d && !d.sea && !d.card && d.thr > level + 1e-3 && d.key < key) key = d.key;
      }
    }
    return key;
  }

  projectileHit(sx: number, sy: number, u: number, v: number, level: number, bias: number): number | null {
    for (const b of this.meta.blockers) if ((u - b.u) ** 2 + (v - b.v) ** 2 < b.r * b.r) return v;
    const d = this.depthAt(sx, sy);
    return d && !d.sea && !d.card && d.thr > level + 1e-3 && d.key < v - bias ? d.key : null;
  }
}

async function loadPixels(url: string) {
  const blob = await (await fetch(url)).blob();
  // Sem conversão de cor nem pré-multiplicação: os canais são dados, não cor.
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })!;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

/** DataTexture tem a linha 0 embaixo; a imagem tem em cima. */
function flipRows(src: Uint8ClampedArray, w: number, h: number) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) out.set(src.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4);
  return out;
}
