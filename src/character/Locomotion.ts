import { angleDelta, vecToAngle } from './directions';

export type MoveAction = 'walk' | 'run';
export type LocoState = 'idle' | 'move' | 'settle';

export interface LocoParams {
  walkSpeed: number;
  runSpeed: number;
  /** Metros por ciclo (2 passos). */
  walkStride: number;
  runStride: number;
  accel: number;
  decel: number;
  /** rad/s */
  turnRate: number;
  /** Cadência mínima (ciclos/s) ao terminar o passo depois de soltar as teclas. */
  settleRate: number;
  stopSpeed: number;
  /** Multiplicador de velocidade do terreno (escadas mais lentas). */
  speedScale?: number;
}

/** Colisão: devolve a posição alcançada e a fração do passo que aconteceu. */
export type MoveResolver = (x: number, y: number, dx: number, dy: number) => { u: number; v: number; ratio: number; moved: number };

export interface MoveInput {
  /** Direção em espaço de tela: x = direita, y = cima. Comprimento 0 ou 1. */
  x: number;
  y: number;
  run: boolean;
}

const TAU = Math.PI * 2;

/**
 * Locomoção em 2D no plano do chão, na base da câmera (x = direita da tela, y = "para cima"
 * da tela projetado no chão). Sem dependência de three.js.
 *
 * - O facing gira com velocidade angular finita → curvas e inversões passam pelas direções
 *   intermediárias em vez de "estalar".
 * - A velocidade segue o facing (nunca anda de lado/de costas em relação ao sprite) e cai
 *   enquanto o desvio entre facing e input é grande → numa inversão ela freia, gira e sai.
 * - A fase da animação avança pela distância percorrida (passada em m/ciclo) → os pés não
 *   patinam, inclusive acelerando e freando.
 * - Fase 0 e 0,5 são poses de passagem; ao parar, a animação termina o passo até a próxima.
 */
export class Locomotion {
  x = 0;
  y = 0;
  /** 0 = N (cima da tela), horário. Começa de frente para a câmera. */
  facing = Math.PI;
  targetFacing = Math.PI;
  speed = 0;
  /** Fase do ciclo em [0, 1). */
  phase = 0;
  action: MoveAction = 'walk';
  state: LocoState = 'idle';
  /** Tempo empurrando uma parede (passo quase todo bloqueado); decai ao se soltar. */
  blockedTime = 0;
  /** Empurrando uma parede (com histerese: não pisca entre andar e parar). */
  pushing = false;
  private settleTarget = 0;

  update(dt: number, input: MoveInput, p: LocoParams, resolve?: MoveResolver) {
    const hasInput = input.x !== 0 || input.y !== 0;
    if (hasInput) this.targetFacing = vecToAngle(input.x, input.y);

    // Giro. Numa inversão exata (180°) gira pelo lado que passa de frente para a câmera.
    let delta = angleDelta(this.facing, this.targetFacing);
    if (Math.abs(Math.abs(delta) - Math.PI) < 0.02) {
      const viaCw = Math.abs(angleDelta(this.facing + Math.PI / 2, Math.PI));
      const viaCcw = Math.abs(angleDelta(this.facing - Math.PI / 2, Math.PI));
      delta = viaCw <= viaCcw ? Math.PI : -Math.PI;
    }
    const maxTurn = p.turnRate * dt;
    this.facing += Math.max(-maxTurn, Math.min(maxTurn, delta));
    this.facing = ((this.facing % TAU) + TAU) % TAU;

    // Velocidade escalar ao longo do facing
    let target = 0;
    if (hasInput) {
      const align = Math.max(0, Math.cos(angleDelta(this.facing, this.targetFacing)));
      target = (input.run ? p.runSpeed : p.walkSpeed) * Math.sqrt(align) * (p.speedScale ?? 1);
    }
    const k = target > this.speed ? p.accel : p.decel;
    this.speed += (target - this.speed) * (1 - Math.exp(-k * dt));
    if (!hasInput && this.speed < p.stopSpeed) this.speed = 0;

    let dist = this.speed * dt;
    const dx = Math.sin(this.facing) * dist, dy = Math.cos(this.facing) * dist;
    if (resolve && dist > 0) {
      const r = resolve(this.x, this.y, dx, dy);
      this.x = r.u;
      this.y = r.v;
      // Escorregando pela parede a velocidade se mantém; só de frente para ela (quase sem
      // avanço) perde embalo — a animação para em vez de "correr no lugar".
      if (r.moved < 0.2 * dist) {
        this.blockedTime += dt;
        this.speed *= Math.exp(-10 * dt);
      } else this.blockedTime = Math.max(0, this.blockedTime - 3 * dt);
      dist = r.moved;
    } else {
      this.x += dx;
      this.y += dy;
      if (!hasInput) this.blockedTime = 0;
    }

    if (!hasInput) this.blockedTime = 0;
    if (!this.pushing && this.blockedTime > 0.12) this.pushing = true;
    else if (this.pushing && this.blockedTime < 0.04) this.pushing = false;

    // Andar ↔ correr pelo meio do caminho entre as velocidades (com histerese)
    const mid = (p.walkSpeed + p.runSpeed) / 2;
    if (this.action === 'walk' && this.speed > mid * 1.04) this.action = 'run';
    else if (this.action === 'run' && this.speed < mid * 0.96) this.action = 'walk';
    const stride = this.action === 'run' ? p.runStride : p.walkStride;

    // Fase da animação
    if (hasInput) {
      this.state = 'move';
      this.phase += dist / stride;
    } else if (this.state === 'move') {
      this.state = 'settle';
      // Próxima pose de passagem; se acabou de passar por uma (≤ 6% do ciclo), volta a ela.
      const half = Math.floor(this.phase / 0.5) * 0.5;
      this.settleTarget = this.phase - half < 0.06 ? half : half + 0.5;
    }
    if (this.state === 'settle') {
      // min() também cobre o caso de voltar à passagem que acabou de ficar para trás.
      this.phase = Math.min(this.settleTarget, this.phase + Math.max(dist / stride, p.settleRate * dt));
      if (this.phase >= this.settleTarget && this.speed === 0) this.state = 'idle';
    }
    if (this.phase >= 1) {
      this.phase -= 1;
      this.settleTarget -= 1;
    }
    if (this.state === 'idle') this.action = 'walk';
  }

  /** Para no lugar (ex.: ao conjurar), virando para `facing`. */
  halt(facing: number) {
    this.facing = this.targetFacing = facing;
    this.speed = 0;
    this.phase = 0;
    this.state = 'idle';
    this.action = 'walk';
  }

  /** Retoma o movimento vindo de outra ação (deslize), mantendo velocidade e fase da passada. */
  resume(facing: number, speed: number, phase: number) {
    this.facing = this.targetFacing = facing;
    this.speed = speed;
    this.phase = phase;
    this.state = 'move';
    this.action = 'run';
  }

  /** Teleporta e zera o movimento (usado pelo demo). */
  reset(x = 0, y = 0) {
    this.x = x;
    this.y = y;
    this.speed = 0;
    this.phase = 0;
    this.state = 'idle';
    this.action = 'walk';
  }
}
