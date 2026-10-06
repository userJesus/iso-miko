import type { DirName } from './directions';

/** Dados por direção gerados pelo pipeline (manifest `slide`). */
export interface SlideData {
  /** Primeiro frame da descida ao chão. */
  contact: number;
  /** Primeiro frame da subida. */
  rise: number;
  /** Quanto o corpo está deitado por frame (0 em pé … 1 no chão). */
  lie: number[];
  /** Por posição do laço da corrida: [frames a esperar, frame de entrada]. */
  entry: [number, number][];
  /** Sem direção pressionada, fica parada depois deste frame. */
  idleExit: number;
  /** Com direção pressionada, volta a correr depois deste frame… */
  runExit: number;
  /** …nesta fase do laço da corrida. */
  runExitPhase: number;
}

export interface SlideTiming {
  /** s por frame na entrada (a mesma cadência da corrida). */
  approachFrame: number;
  /** s no chão (contato → começo da subida). */
  groundSeconds: number;
  /** s da subida até o fim. */
  recoverSeconds: number;
  /** Velocidade no contato ÷ velocidade de entrada (o impulso do mergulho). */
  boost: number;
  /** Velocidade ao começar a levantar ÷ velocidade de entrada (o atrito). */
  endRatio: number;
  /** Taxa (1/s) com que retoma a velocidade de corrida ao levantar. */
  accel: number;
}

export interface SlideEvents {
  /** O corpo tocou o chão neste frame. */
  contact: boolean;
  /** Levantou e está saindo correndo. */
  pushOff: boolean;
  exit: null | 'idle' | 'move';
}

/**
 * Deslize: entrada correndo → corpo no chão com atrito → levanta e volta a correr (ou para).
 * A velocidade é física: impulso no contato, desaceleração constante no chão (atrito de
 * Coulomb → queda linear), quase parada ao levantar e aceleração ao sair correndo.
 * Os frames da entrada seguem a cadência da corrida; os do chão e da subida, o tempo
 * configurado — o corpo deitado quase não muda de pose, o movimento é o deslocamento.
 */
export class SlideState {
  active = false;
  dir: DirName = 'e';
  /** Direção do movimento (ângulo de facing, contínuo). */
  angle = 0;
  frame = 0;
  speed = 0;
  /** Quanto o corpo está deitado agora (interpolado entre frames). */
  lie = 0;
  /** Fase da corrida para continuar ao sair andando/correndo. */
  exitPhase = 0;
  private data: SlideData | null = null;
  private count = 1;
  private t = 0;
  private v0 = 0;
  private readonly events: SlideEvents = { contact: false, pushOff: false, exit: null };

  start(dir: DirName, angle: number, data: SlideData, frameCount: number, entryFrame: number, speed: number) {
    Object.assign(this, { active: true, dir, angle, data, count: frameCount, frame: entryFrame, t: 0, speed, v0: speed });
    this.lie = data.lie[entryFrame] ?? 0;
  }

  stop() {
    this.active = false;
  }

  /** No chão (para efeitos: poeira, sombra). */
  get grounded() {
    const d = this.data;
    return !!d && this.active && this.frame >= d.contact && this.frame < d.rise;
  }

  /** Velocidade de referência do deslize (para escalar a poeira). */
  get peakSpeed() {
    return this.v0;
  }

  private duration(k: number, tm: SlideTiming) {
    const d = this.data!;
    if (k < d.contact) return tm.approachFrame;
    if (k < d.rise) return tm.groundSeconds / (d.rise - d.contact);
    return tm.recoverSeconds / Math.max(1, this.count - d.rise);
  }

  /**
   * @param wantsMove direção pressionada
   * @param moveSpeed velocidade a retomar (corrida ou caminhada, conforme Shift)
   */
  update(dt: number, tm: SlideTiming, wantsMove: boolean, moveSpeed: number): SlideEvents {
    const ev = this.events;
    ev.contact = ev.pushOff = false;
    ev.exit = null;
    const d = this.data;
    if (!this.active || !d) return ev;

    this.t += dt;
    while (this.t >= this.duration(this.frame, tm)) {
      this.t -= this.duration(this.frame, tm);
      const k = this.frame;
      if (k >= d.idleExit && !wantsMove) { ev.exit = 'idle'; break; }
      if (k >= d.runExit && wantsMove) { ev.exit = 'move'; break; }
      if (k === this.count - 1) { ev.exit = wantsMove ? 'move' : 'idle'; break; }
      if (k === d.idleExit && wantsMove) ev.pushOff = true;
      this.frame++;
      if (this.frame === d.contact) ev.contact = true;
    }
    if (ev.exit) {
      this.exitPhase = d.runExitPhase;
      this.t = 0;
    }

    // Velocidade
    const k = this.frame;
    const u = Math.min(1, this.t / this.duration(k, tm));
    let target: number, rate: number;
    if (k < d.contact) {
      target = this.v0;
      rate = 20;
    } else if (k < d.rise) {
      // Atrito constante: queda linear do impulso até a fração final.
      const p = (k - d.contact + u) / (d.rise - d.contact);
      target = this.v0 * (tm.boost - (tm.boost - tm.endRatio) * p);
      rate = 18; // o impulso do contato entra em ~50 ms, não num estalo
    } else if (k <= d.idleExit) {
      // Levantando: o corpo freia contra o chão.
      target = this.v0 * tm.endRatio * (wantsMove ? 0.7 : 0.25);
      rate = 10;
    } else {
      target = wantsMove ? moveSpeed : 0;
      rate = wantsMove ? tm.accel : 12;
    }
    this.speed += (target - this.speed) * (1 - Math.exp(-rate * dt));

    const next = Math.min(this.count - 1, k + 1);
    this.lie = (d.lie[k] ?? 0) + ((d.lie[next] ?? 0) - (d.lie[k] ?? 0)) * u;
    return ev;
  }
}
