/**
 * Classificação de material por pixel da pintura da ilha. Define onde dá para pisar
 * (areia, grama, pétalas no chão) e o que é obstáculo (rocha, folhagem, tronco, torii, água).
 */
export const MAT = {
  BG: 0, // fundo verde (fora da ilha)
  WATER: 1,
  FOAM: 2,
  SAND: 3,
  GRASS: 4,
  PINK: 5, // flores/pétalas
  ROCK: 6,
  FOLIAGE: 7, // folhagem escura (pinheiros, arbustos)
  TRUNK: 8,
  RED: 9, // torii
  DARK: 10, // sombras profundas, telhado do torii
} as const;
export type Mat = (typeof MAT)[keyof typeof MAT];

export const MAT_COLORS: Record<number, [number, number, number]> = {
  [MAT.BG]: [0, 0, 0],
  [MAT.WATER]: [30, 120, 220],
  [MAT.FOAM]: [180, 230, 255],
  [MAT.SAND]: [240, 200, 120],
  [MAT.GRASS]: [90, 200, 60],
  [MAT.PINK]: [255, 120, 200],
  [MAT.ROCK]: [130, 130, 140],
  [MAT.FOLIAGE]: [20, 90, 50],
  [MAT.TRUNK]: [120, 60, 20],
  [MAT.RED]: [230, 30, 30],
  [MAT.DARK]: [40, 30, 50],
};

export const WALKABLE_MATS = new Set<number>([MAT.SAND, MAT.GRASS, MAT.PINK]);

function rgbToHsv(r: number, g: number, b: number) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx === 0 ? 0 : d / mx, v: mx / 255 };
}

export function classify(r: number, g: number, b: number): Mat {
  if (g - Math.max(r, b) > 90 && g > 180) return MAT.BG;
  const { h, s, v } = rgbToHsv(r, g, b);
  // Espuma: quase branco, levemente azulado
  if (v > 0.82 && s < 0.18 && b >= r) return MAT.FOAM;
  // Água: ciano/azul bem saturado. Pedra azul-acinzentada (s ≈ 0,3–0,5, escura) fica de fora.
  if (h >= 165 && h <= 215 && v > 0.2 && ((s > 0.45 && v > 0.35) || s > 0.6)) return MAT.WATER;
  // Torii: vermelho saturado
  if ((h < 12 || h > 345) && s > 0.62 && v > 0.45) return MAT.RED;
  // Rosa: flores (alto valor, matiz magenta/rosa)
  if ((h > 300 || h < 15) && s > 0.12 && s < 0.62 && v > 0.62) return MAT.PINK;
  if (v < 0.17) return MAT.DARK;
  // Tronco: marrom escuro avermelhado
  if (h >= 0 && h < 40 && s > 0.35 && v < 0.5) return MAT.TRUNK;
  // Areia: bege/laranja claro
  if (h >= 22 && h < 50 && s > 0.2 && s < 0.7 && v > 0.55) return MAT.SAND;
  // Grama clara (verde-amarelado) vs folhagem escura (verde-azulado, escuro)
  if (h >= 50 && h < 100 && s > 0.3 && v > 0.35) return MAT.GRASS;
  if (h >= 75 && h < 175 && s > 0.25 && v <= 0.5) return MAT.FOLIAGE;
  if (h >= 100 && h < 165 && s > 0.3) return v > 0.55 ? MAT.GRASS : MAT.FOLIAGE;
  if (s < 0.22) return MAT.ROCK;
  if (h >= 40 && h < 75 && s >= 0.22 && v <= 0.35) return MAT.FOLIAGE;
  if (h >= 15 && h < 50 && v > 0.4) return MAT.SAND;
  return MAT.ROCK;
}
