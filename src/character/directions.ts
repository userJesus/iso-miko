/**
 * 8 direções em espaço de tela, na ordem do manifest: 0 = N (subindo na tela), sentido horário.
 * Ângulos de facing usam a mesma convenção: 0 = N, π/2 = E.
 */
export const DIRECTIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export type DirName = (typeof DIRECTIONS)[number];

export const DIRECTION_LABELS: Record<DirName, string> = {
  n: 'N ↑', ne: 'NE ↗', e: 'L →', se: 'SE ↘', s: 'S ↓', sw: 'SO ↙', w: 'O ←', nw: 'NO ↖',
};

const SECTOR = Math.PI / 4;

/** Ângulo (0 = cima, horário) → índice da direção mais próxima. */
export function angleToDirIndex(angle: number): number {
  return ((Math.round(angle / SECTOR) % 8) + 8) % 8;
}

export function dirIndexToAngle(i: number): number {
  return i * SECTOR;
}

/** Vetor 2D (x = direita, y = cima) → ângulo de facing. */
export function vecToAngle(x: number, y: number): number {
  return Math.atan2(x, y);
}

/** Diferença angular com sinal, no intervalo (-π, π]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}
