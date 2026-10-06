import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const SRC = path.join(ROOT, 'assets-src');
export const OUT = path.join(ROOT, 'public', 'sprites');
export const DEBUG_DIR = path.join(ROOT, '.sprite-debug');
export const DEBUG = process.argv.includes('--debug');

/** Resolução do atlas em relação à altura normalizada da fonte (~300px → ~225px). */
export const ATLAS_SCALE = 0.75;
export const CELL_PAD = 4;

/** Ordem canônica: ângulo de tela, 0 = N (subindo na tela), sentido horário. */
export const DIRECTIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;

export type Dir = (typeof DIRECTIONS)[number];

/** Ângulos de tela (y para cima) das 8 direções no isométrico 2:1. */
export const ISO_ANGLES: [Dir, number][] = (['e', 'ne', 'n', 'nw', 'w', 'sw', 's', 'se'] as Dir[]).map((d, i) => {
  const a = [0, Math.atan(0.5), Math.PI / 2, Math.PI - Math.atan(0.5), Math.PI, -Math.PI + Math.atan(0.5), -Math.PI / 2, -Math.atan(0.5)][i];
  return [d, a];
});

export function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
