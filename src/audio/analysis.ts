/**
 * Medidas para equilibrar a mixagem e fatiar os arquivos (sem Web Audio, testável em Node).
 * Sonoridade segundo a ITU-R BS.1770: filtro K (prateleira de +4 dB acima de ~1,5 kHz e
 * passa-altas em 38 Hz), energia somada dos canais, −0,691 dB.
 */

export interface Pcm {
  channels: Float32Array[];
  sampleRate: number;
}

/** Resolução das análises (s). */
export const HOP = 0.01;

export interface Analysis {
  /** Energia K-ponderada por janela de HOP (soma dos canais). */
  power: Float64Array;
  /** Nível RMS (dBFS, mono) por janela de HOP, sem ponderação: ataques e silêncio. */
  env: Float64Array;
}

/** Fatia de um arquivo, em segundos, com a sua sonoridade (LUFS). */
export interface Slice {
  start: number;
  duration: number;
  loudness: number;
}

type Biquad = [b0: number, b1: number, b2: number, a1: number, a2: number];

/** Coeficientes do filtro K (mesmas fórmulas da referência pyloudnorm, para qualquer taxa). */
function kFilters(fs: number): [Biquad, Biquad] {
  const norm = (b: number[], a: number[]): Biquad => [b[0] / a[0], b[1] / a[0], b[2] / a[0], a[1] / a[0], a[2] / a[0]];
  let w = (2 * Math.PI * 1500) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2);
  const A = 10 ** (4 / 40), sa = 2 * Math.sqrt(A) * al;
  const shelf = norm(
    [A * (A + 1 + (A - 1) * c + sa), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - sa)],
    [A + 1 - (A - 1) * c + sa, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - sa],
  );
  w = (2 * Math.PI * 38) / fs;
  c = Math.cos(w);
  al = Math.sin(w) / (2 * 0.5);
  const highpass = norm([(1 + c) / 2, -(1 + c), (1 + c) / 2], [1 + al, -2 * c, 1 - al]);
  return [shelf, highpass];
}

export function analyze(pcm: Pcm): Analysis {
  const h = Math.round(pcm.sampleRate * HOP);
  const len = pcm.channels[0].length, n = Math.floor(len / h);
  const power = new Float64Array(n), env = new Float64Array(n);
  const mono = new Float64Array(n * h);
  const [s, p] = kFilters(pcm.sampleRate);
  for (const x of pcm.channels) {
    // Duas biquads em cascata (forma direta I), amostra a amostra.
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
    for (let i = 0; i < n * h; i++) {
      const x0 = x[i];
      const y0 = s[0] * x0 + s[1] * x1 + s[2] * x2 - s[3] * y1 - s[4] * y2;
      const z0 = p[0] * y0 + p[1] * y1 + p[2] * y2 - p[3] * z1 - p[4] * z2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0; z2 = z1; z1 = z0;
      power[(i / h) | 0] += (z0 * z0) / h;
      mono[i] += x0 / pcm.channels.length;
    }
  }
  for (let k = 0; k < n; k++) {
    let e = 0;
    for (let i = k * h; i < (k + 1) * h; i++) e += mono[i] * mono[i];
    env[k] = 10 * Math.log10(e / h + 1e-12);
  }
  return { power, env };
}

const lufs = (meanSquare: number) => -0.691 + 10 * Math.log10(meanSquare + 1e-12);

function mean(xs: ArrayLike<number>, from: number, to: number) {
  let s = 0;
  for (let i = from; i < to; i++) s += xs[i];
  return s / Math.max(1, to - from);
}

/** Sonoridade integrada (BS.1770-4): blocos de 400 ms com 75% de sobreposição, portas absoluta (−70) e relativa (−10). */
export function integratedLoudness(a: Analysis): number {
  const blocks: number[] = [];
  for (let i = 0; i + 40 <= a.power.length; i += 10) blocks.push(mean(a.power, i, i + 40));
  const abs = blocks.filter((z) => lufs(z) > -70);
  if (!abs.length) return -Infinity;
  const gate = lufs(mean(abs, 0, abs.length)) - 10;
  const rel = abs.filter((z) => lufs(z) > gate);
  return lufs(mean(rel, 0, rel.length));
}

/**
 * Pico de sonoridade em janela deslizante de 100 ms no trecho [from, to) (índices de HOP).
 * Para sons curtos: o ouvido soma a energia de um som breve em ~100 ms, então um passo de
 * 50 ms e um sopro de 300 ms com o mesmo pico de 100 ms soam com volume parecido.
 */
export function peakLoudness(a: Analysis, from = 0, to = a.power.length, window = 10): number {
  if (to - from <= window) return lufs(mean(a.power, from, to));
  let sum = 0, best = 0;
  for (let i = from; i < to; i++) {
    sum += a.power[i] - (i - window >= from ? a.power[i - window] : 0);
    if (i - from >= window - 1 && sum > best) best = sum;
  }
  return lufs(best / window);
}

/** Início do ataque principal (s): primeira janela a 6 dB do nível máximo. */
export function attackTime(a: Analysis): number {
  const top = Math.max(...a.env);
  return a.env.findIndex((e) => e >= top - 6) * HOP;
}

/** Trecho com som (s): da primeira à última janela acima de `floorDb` dBFS (corta o silêncio do codificador). */
export function activeRange(a: Analysis, floorDb = -60): [number, number] {
  const first = a.env.findIndex((e) => e > floorDb);
  let last = a.env.length - 1;
  while (last > first && a.env[last] <= floorDb) last--;
  return first < 0 ? [0, a.env.length * HOP] : [first * HOP, (last + 1) * HOP];
}

/**
 * Passos de um arquivo com vários passos em sequência. Um passo é um pico do envelope que é
 * o maior num raio de `radius` s (o toque da ponta do pé logo depois do calcanhar fica dentro
 * do mesmo passo) e está a até 15 dB do passo mais forte (o ruído entre passos fica fora).
 * Cada passo começa na última janela 12 dB abaixo do seu pico e vai até o próximo
 * (no máximo `maxLength` s).
 */
export function findSteps(a: Analysis, radius = 0.18, maxLength = 0.35): Slice[] {
  const env = a.env, n = env.length, r = Math.round(radius / HOP);
  const top = Math.max(...env);
  const peaks: number[] = [];
  for (let i = 0; i < n; i++) {
    if (env[i] < top - 15 || (peaks.length && i - peaks[peaks.length - 1] <= r)) continue;
    let isMax = true;
    for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r) && isMax; j++) if (env[j] > env[i]) isMax = false;
    if (isMax) peaks.push(i);
  }
  const starts = peaks.map((i) => {
    let j = i - 1;
    while (j > Math.max(0, i - 10) && env[j] >= env[i] - 12) j--;
    return Math.max(0, j);
  });
  return starts.map((s, k) => {
    const e = Math.min(starts[k + 1] ?? n, s + Math.round(maxLength / HOP));
    return { start: s * HOP, duration: (e - s) * HOP, loudness: peakLoudness(a, s, e) };
  });
}
