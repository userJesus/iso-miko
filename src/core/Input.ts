import type { MoveInput } from '../character/Locomotion';

const UP = ['KeyW', 'ArrowUp'];
const DOWN = ['KeyS', 'ArrowDown'];
const LEFT = ['KeyA', 'ArrowLeft'];
const RIGHT = ['KeyD', 'ArrowRight'];
const RUN = ['ShiftLeft', 'ShiftRight'];
const DIR_KEYS = new Set([...UP, ...DOWN, ...LEFT, ...RIGHT]);

/**
 * Ao soltar uma diagonal, as duas teclas nunca sobem no mesmo instante; sem tolerância
 * a personagem giraria para N/S/L/O no último frame. Uma tecla de direção solta continua
 * valendo por este tempo enquanto outra direção ainda estiver pressionada.
 */
const DIAGONAL_RELEASE_MS = 90;

/**
 * Teclado por `event.code` (posição física da tecla) → funciona igual em ABNT2, US etc.
 * WASD/setas = direção em espaço de tela; Shift segurado = correr.
 */
export class Input {
  private readonly down = new Set<string>();
  private readonly releasedAt = new Map<string, number>();
  private readonly handlers = new Map<string, () => void>();
  private readonly state: MoveInput = { x: 0, y: 0, run: false };

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (DIR_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat) this.handlers.get(e.code)?.();
      this.down.add(e.code);
      this.releasedAt.delete(e.code);
    });
    target.addEventListener('keyup', (e) => {
      if (!this.down.delete(e.code) || !DIR_KEYS.has(e.code)) return;
      // Só soltura parcial de uma combinação ganha tolerância (toques isolados não).
      if ([...this.down].some((c) => DIR_KEYS.has(c))) this.releasedAt.set(e.code, performance.now());
    });
    // Sem isso, soltar uma tecla com a janela fora de foco a deixaria "presa".
    const clear = () => { this.down.clear(); this.releasedAt.clear(); };
    target.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
  }

  /** Registra uma ação de toque único (sem repetição) para uma tecla. */
  on(code: string, fn: () => void) {
    this.handlers.set(code, fn);
  }

  /** Direção normalizada (diagonais com comprimento 1) + correr. */
  read(): MoveInput {
    const now = performance.now();
    const anyDirDown = [...this.down].some((c) => DIR_KEYS.has(c));
    const held = (codes: string[]) => codes.some((c) => {
      if (this.down.has(c)) return true;
      const t = this.releasedAt.get(c);
      return anyDirDown && t !== undefined && now - t < DIAGONAL_RELEASE_MS;
    });
    const x = +held(RIGHT) - +held(LEFT);
    const y = +held(UP) - +held(DOWN);
    const len = Math.hypot(x, y) || 1;
    this.state.x = x / len;
    this.state.y = y / len;
    this.state.run = RUN.some((c) => this.down.has(c));
    return this.state;
  }
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
