import type { MoveInput } from '../character/Locomotion';

export type DemoMode = 'desligado' | 'círculo' | 'rosa dos ventos' | 'bola de fogo 8 direções' | 'deslize 8 direções';

const ROSE: [number, number][] = [
  [0, 1], [0, -1], [1, 1], [-1, -1], [1, 0], [-1, 0], [1, -1], [-1, 1],
];
const CLOCKWISE: [number, number][] = [
  [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1],
];

/**
 * Movimento automático para validar sem tocar no teclado.
 * - círculo: o input gira continuamente → passa por todas as direções e pelas transições.
 * - rosa dos ventos: ida e volta em cada eixo (N/S, NE/SO, L/O, SE/NO), com pausa entre trechos.
 * - bola de fogo 8 direções: vira para cada direção (sentido horário) e lança.
 * - deslize 8 direções: corre em cada direção e desliza; alterna sair correndo e parar.
 */
export class Demo {
  mode: DemoMode = 'desligado';
  run = false;
  /** Disparo pedido neste frame (só no modo bola de fogo). */
  cast = false;
  /** Deslize pedido neste frame (só no modo deslize). */
  slide = false;
  private slid = false;
  private t = 0;
  private lastSlot = -1;
  private readonly out: MoveInput = { x: 0, y: 0, run: false };

  get active() {
    return this.mode !== 'desligado';
  }

  restart() {
    this.t = 0;
    this.lastSlot = -1;
  }

  update(dt: number): MoveInput {
    this.t += dt;
    this.cast = false;
    this.slide = false;
    this.out.run = this.run;
    if (this.mode === 'círculo') {
      const a = this.t * (this.run ? 0.9 : 0.55);
      this.out.x = Math.sin(a);
      this.out.y = Math.cos(a);
    } else if (this.mode === 'deslize 8 direções') {
      // corre 0,9 s → desliza → (pares) continua correndo / (ímpares) solta → pausa
      const slotLen = 3.2;
      const slot = Math.floor(this.t / slotLen), u = this.t % slotLen;
      const [x, y] = CLOCKWISE[slot % 8];
      const len = Math.hypot(x, y);
      if (slot !== this.lastSlot) { this.lastSlot = slot; this.slid = false; }
      const keepRunning = slot % 2 === 0;
      const held = u < 1.05 || (keepRunning && u < 2.4);
      this.out.x = held ? x / len : 0;
      this.out.y = held ? y / len : 0;
      this.out.run = true;
      if (u >= 0.9 && !this.slid) { this.slid = true; this.slide = true; this.out.x = x / len; this.out.y = y / len; }
    } else if (this.mode === 'bola de fogo 8 direções') {
      const slotLen = 1.3;
      const slot = Math.floor(this.t / slotLen);
      const [x, y] = CLOCKWISE[slot % 8];
      const len = Math.hypot(x, y);
      // Toque curto na direção (só vira, quase não anda) e dispara no mesmo frame.
      const tap = this.t % slotLen < 0.06;
      this.out.x = tap ? x / len : 0;
      this.out.y = tap ? y / len : 0;
      this.out.run = false;
      if (slot !== this.lastSlot) {
        this.lastSlot = slot;
        this.cast = true;
      }
    } else {
      const leg = 1.6, pause = 0.6, slot = leg + pause;
      const i = Math.floor(this.t / slot) % ROSE.length;
      const moving = this.t % slot < leg;
      const [x, y] = ROSE[i];
      const len = Math.hypot(x, y);
      this.out.x = moving ? x / len : 0;
      this.out.y = moving ? y / len : 0;
    }
    return this.out;
  }
}
