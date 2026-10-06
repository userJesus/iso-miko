import type { DirName } from './directions';

export interface CastTiming {
  /** Segundos do início até a bola sair da mão. */
  pre: number;
  /** Segundos da soltura até o fim da recuperação. */
  post: number;
  /** Depois da soltura, a partir de quando um movimento interrompe a recuperação. */
  cancelAfter: number;
}

export interface CastEvents {
  /** A bola saiu da mão neste frame. */
  released: boolean;
  /** A animação terminou. */
  done: boolean;
}

/**
 * Estado da conjuração: avança os frames da sheet com duas velocidades (antes e depois da
 * soltura) para que o tempo até o disparo seja ajustável sem depender de quantos frames
 * a arte usou na preparação.
 */
export class CastState {
  active = false;
  dir: DirName = 'se';
  /** Índice do frame atual na sequência da direção. */
  frame = 0;
  /** E pressionado durante a conjuração: dispara de novo assim que puder. */
  queued = false;
  private t = 0;
  private count = 1;
  private release = 0;
  private didRelease = false;
  private readonly events: CastEvents = { released: false, done: false };

  start(dir: DirName, frameCount: number, releaseFrame: number) {
    Object.assign(this, { active: true, dir, frame: 0, queued: false, t: 0, count: frameCount, didRelease: false });
    this.release = Math.max(1, Math.min(frameCount - 1, releaseFrame));
  }

  stop() {
    this.active = false;
    this.queued = false;
  }

  get released() {
    return this.didRelease;
  }

  /** Pode ser interrompida (por movimento ou novo disparo)? */
  canInterrupt(timing: CastTiming) {
    return this.didRelease && this.t >= timing.pre + timing.cancelAfter;
  }

  update(dt: number, timing: CastTiming): CastEvents {
    const ev = this.events;
    ev.released = false;
    ev.done = false;
    if (!this.active) return ev;
    this.t += dt;
    if (this.t < timing.pre) {
      this.frame = Math.min(this.release - 1, Math.floor((this.t / timing.pre) * this.release));
    } else {
      if (!this.didRelease) {
        this.didRelease = true;
        ev.released = true;
      }
      const after = this.count - this.release;
      this.frame = this.release + Math.floor(((this.t - timing.pre) / timing.post) * after);
      if (this.frame >= this.count) {
        this.frame = this.count - 1;
        ev.done = true;
      }
    }
    return ev;
  }
}
