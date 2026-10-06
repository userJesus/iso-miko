import type { Character } from '../character/Character';
import type { LocoParams, MoveAction } from '../character/Locomotion';
import { activeRange, analyze, attackTime, findSteps, integratedLoudness, peakLoudness, type Slice } from './analysis';
import { Mixer, type Loop, type Voice, type Volumes } from './Mixer';

const FILES = {
  music: 'music.mp3',
  ambience: 'ambience.mp3',
  walk: 'walk.mp3',
  run: 'run.mp3',
  slide: 'slide.mp3',
  fireball: 'fireball.mp3',
  impact: 'fireball-impact.mp3',
  idle: 'idle.mp3',
} as const;

export type SoundName = keyof typeof FILES;
type LoopName = 'music' | 'ambience';
const LOOPS: LoopName[] = ['music', 'ambience'];

export interface AudioParams {
  volume: Volumes;
  muted: boolean;
  /** LUFS-alvo de cada som (e das falas da apresentação). */
  levels: Record<SoundName | 'voice', number>;
  /** Fases da passada em que cada pé toca o chão. */
  steps: Record<MoveAction, number[]>;
  stepJitter: { db: number; rate: number };
  crossfade: Record<LoopName, number>;
  idle: { first: number; every: [number, number] };
  /** Trilha e mar abaixados (dB) enquanto a apresentação fala. */
  duck: number;
}

interface Sound {
  buffer: AudioBuffer;
  /** LUFS medidos: integrada (laços) ou pico de 100 ms (efeitos e cada passo). */
  loudness: number;
  /** s até o ataque principal. */
  attack: number;
  /** Trecho com som (s). */
  range: [number, number];
  /** Passos fatiados (arquivos de passos). */
  steps: Slice[];
}

/** Bola de fogo em voo: o sopro (cortado se ela explodir) e a panorâmica que ele segue. */
interface Flight {
  voice: Voice | null;
  start: number;
  screenX: number;
  seconds: number;
}

/** Explosões soando ao mesmo tempo, no máximo (o crepitar dura ~2,5 s e se acumularia). */
const MAX_IMPACTS = 3;

const dbToGain = (db: number) => 10 ** (db / 20);
const jitter = (amount: number) => (Math.random() * 2 - 1) * amount;

/**
 * Mede um arquivo ao carregar: o ganho de cada som sai da diferença entre o alvo e a medida.
 * Laços e falas: sonoridade integrada. Efeitos: pico de 100 ms.
 */
function measure(buffer: AudioBuffer, loudness: 'integrated' | 'peak', steps = false): Sound {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const a = analyze({ channels, sampleRate: buffer.sampleRate });
  return {
    buffer,
    loudness: loudness === 'integrated' ? integratedLoudness(a) : peakLoudness(a),
    attack: attackTime(a),
    range: activeRange(a),
    steps: steps ? findSteps(a) : [],
  };
}

/**
 * Sons do jogo, dirigidos pelo estado da personagem (passos, parada, deslize) e por eventos
 * (soltura da bola de fogo, início do deslize). Trilha e mar tocam em laço por baixo.
 */
export class GameAudio {
  private readonly mixer = new Mixer();
  private readonly sounds = new Map<SoundName, Sound>();
  private readonly loops = new Map<LoopName, Loop>();
  /** Fase da passada no frame anterior (adiantada pela latência); < 0 = sem referência. */
  private stepPhase = -1;
  private lastStepAt = 0;
  private readonly lastSlice: Record<MoveAction, number> = { walk: -1, run: -1 };
  private stillTime = 0;
  private nextFidget = 0;
  private slideVoice: Voice | null = null;
  private slideMod = 1;
  private readonly flights = new Map<number, Flight>();
  private readonly impacts: Voice[] = [];
  /** Falas da apresentação (só carregadas quando ela aparece) e a que está tocando. */
  private voices: (Sound | null)[] = [];
  private speech: Voice | null = null;
  /** Tempo de contexto em que a fala atual termina. */
  private speechEnd = 0;
  private ducked = false;

  /** Resolve quando o som fica liberado (primeiro gesto). */
  get ready() {
    return this.mixer.ready;
  }

  /** Carrega e mede todos os sons; um arquivo com erro só fica mudo. */
  async load(baseUrl: string) {
    const names = Object.keys(FILES) as SoundName[];
    const results = await Promise.allSettled(names.map(async (name) => {
      const kind = (LOOPS as SoundName[]).includes(name) ? 'integrated' : 'peak';
      this.sounds.set(name, measure(await this.mixer.decode(baseUrl + FILES[name]), kind, name === 'walk' || name === 'run'));
    }));
    results.forEach((r, i) => r.status === 'rejected' && console.warn(`som "${names[i]}" indisponível:`, r.reason));
  }

  /** Medidas de cada som (para conferir no console). */
  get report() {
    return Object.fromEntries([...this.sounds].map(([name, s]) => [name, {
      loudness: +s.loudness.toFixed(1), attack: s.attack, range: s.range, steps: s.steps.length || undefined,
    }]));
  }

  update(dt: number, ch: Character, p: AudioParams, loco: LocoParams) {
    const m = this.mixer;
    m.setVolumes(p.volume, p.muted);
    if (!m.running) {
      this.stepPhase = -1;
      return;
    }
    // Abaixada com a apresentação na tela e até a última fala terminar (ela pode seguir depois).
    const ducked = this.ducked || (this.speech !== null && m.ctx!.currentTime < this.speechEnd);
    for (const name of LOOPS) {
      const s = this.sounds.get(name);
      if (!s) continue;
      let loop = this.loops.get(name);
      if (!loop) this.loops.set(name, (loop = m.loop(s.buffer, name, s.range, p.crossfade[name])));
      // Rampa lenta: a trilha entra com fade e abaixa/volta sem degrau quando a apresentação fala.
      m.setParam(loop.level.gain, dbToGain(p.levels[name] - s.loudness + (ducked ? p.duck : 0)), 0.4);
      loop.update();
    }
    this.footsteps(ch, p, loco);
    // O farfalhar da roupa não entra por cima das falas.
    if (!ducked) this.fidget(dt, ch, p);
    this.slideFriction(ch);
  }

  /** Carrega e mede as falas da apresentação; uma fala com erro só fica muda. */
  async loadVoices(urls: string[]) {
    this.voices = await Promise.all(urls.map((url) => this.mixer.decode(url).then(
      (buffer) => measure(buffer, 'integrated'),
      (e) => (console.warn(`fala ${url} indisponível:`, e), null),
    )));
  }

  /** Abaixa a trilha e o mar enquanto a apresentação está na tela. */
  duck(on: boolean) {
    this.ducked = on;
  }

  /**
   * Toca a fala `index` a partir do começo da voz (o silêncio inicial do arquivo fica de fora).
   * Devolve se tocou: antes do primeiro gesto ou com a fala ainda carregando, não toca.
   */
  speak(index: number, p: AudioParams) {
    this.hush();
    const s = this.voices[index];
    if (!s) return false;
    const offset = Math.max(0, s.range[0] - 0.05);
    this.speech = this.mixer.play(s.buffer, { bus: 'voice', gain: dbToGain(p.levels.voice - s.loudness), offset });
    if (this.speech) this.speechEnd = this.speech.start + s.range[1] - offset;
    return this.speech !== null;
  }

  /** Corta a fala que estiver tocando, com fade curto. */
  hush(fade = 0.12) {
    if (this.speech) this.mixer.stop(this.speech, fade);
    this.speech = null;
  }

  /**
   * Um passo cada vez que a fase da passada cruza o contato de um pé. A fase avança pela
   * distância percorrida, então os passos seguem a cadência (acelerando, freando, nas escadas
   * e no fim do passo ao parar) e somem quando ela empurra uma parede.
   */
  private footsteps(ch: Character, p: AudioParams, lp: LocoParams) {
    const loco = ch.loco;
    if (ch.cast.active || ch.slide.active || loco.state === 'idle') {
      this.stepPhase = -1;
      return;
    }
    // Adianta pela latência de saída: o som chega quando o pé toca, não depois.
    const stride = loco.action === 'run' ? lp.runStride : lp.walkStride;
    const phase = (loco.phase + (loco.speed * this.mixer.latency) / stride) % 1;
    const prev = this.stepPhase;
    this.stepPhase = phase;
    const delta = (phase - prev + 1) % 1;
    // Sem referência ou salto de fase (saída do deslize): só registra.
    if (prev < 0 || delta === 0 || delta > 0.25) return;
    for (const c of p.steps[loco.action]) {
      const d = (c - prev + 1) % 1;
      if (d > 0 && d <= delta) this.step(loco.action, p, loco.state === 'settle');
    }
  }

  private step(action: MoveAction, p: AudioParams, settling: boolean) {
    const s = this.sounds.get(action), now = this.mixer.ctx!.currentTime;
    // Troca andar ↔ correr bem entre os dois contatos: não dobra o passo.
    if (!s?.steps.length || now - this.lastStepAt < 0.1) return;
    this.lastStepAt = now;
    // Nunca a mesma fatia duas vezes seguidas; volume e tom variam um pouco a cada passo.
    let i = Math.floor(Math.random() * s.steps.length);
    if (i === this.lastSlice[action] && s.steps.length > 1) i = (i + 1) % s.steps.length;
    this.lastSlice[action] = i;
    const slice = s.steps[i];
    // Fechando o passo ao parar: o pé pousa mais leve.
    const db = p.levels[action] - slice.loudness + jitter(p.stepJitter.db) - (settling ? 4 : 0);
    this.mixer.play(s.buffer, {
      bus: 'effects', gain: dbToGain(db), offset: slice.start, duration: slice.duration,
      rate: 1 + jitter(p.stepJitter.rate), fadeOut: Math.min(0.06, slice.duration / 3),
    });
  }

  /** Parada: farfalhar da roupa logo depois de parar e, de tempos em tempos, enquanto fica parada. */
  private fidget(dt: number, ch: Character, p: AudioParams) {
    const still = !ch.cast.active && !ch.slide.active && ch.loco.state === 'idle';
    if (!still) {
      this.stillTime = 0;
      return;
    }
    if (this.stillTime === 0) this.nextFidget = p.idle.first;
    this.stillTime += dt;
    const s = this.sounds.get('idle');
    if (!s || this.stillTime < this.nextFidget) return;
    const [a, b] = p.idle.every;
    this.nextFidget = this.stillTime + a + Math.random() * (b - a);
    this.mixer.play(s.buffer, { bus: 'effects', gain: dbToGain(p.levels.idle - s.loudness + jitter(1.5)), rate: 1 + jitter(0.04) });
  }

  /**
   * Bola de fogo, na soltura: começa no ataque do arquivo (o sopro antes dele é curto e fraco)
   * e a panorâmica acompanha o voo; atirando para a direita, o som vai para a direita.
   * @param id o mesmo id do projétil (Fireballs.spawn), para o impacto achar o sopro
   * @param screenX componente horizontal (na tela) da direção do disparo, −1…1
   * @param seconds segundos de voo até dissipar
   */
  fireball(id: number, screenX: number, seconds: number, p: AudioParams) {
    const s = this.sounds.get('fireball'), ctx = this.mixer.ctx;
    if (!s || !ctx) return;
    const voice = this.mixer.play(s.buffer, {
      bus: 'effects', gain: dbToGain(p.levels.fireball - s.loudness + jitter(1)),
      offset: Math.max(0, s.attack - 0.02), rate: 1 + jitter(0.04),
      pan: { from: 0.15 * screenX, to: 0.6 * screenX, seconds },
    });
    this.flights.set(id, { voice, start: ctx.currentTime, screenX, seconds });
    // Bolas que se dissiparam sem bater: esquece depois que o sopro acabou.
    for (const [k, f] of this.flights) if (ctx.currentTime - f.start > f.seconds + 1) this.flights.delete(k);
  }

  /**
   * A bola explodiu numa superfície: corta o sopro dela e toca o impacto a partir do ataque,
   * na panorâmica em que o sopro estava naquele instante.
   */
  impact(id: number, p: AudioParams) {
    const s = this.sounds.get('impact'), ctx = this.mixer.ctx;
    const f = this.flights.get(id);
    this.flights.delete(id);
    if (f?.voice) this.mixer.stop(f.voice, 0.06);
    if (!s || !ctx) return;
    const u = f ? Math.min(1, (ctx.currentTime - f.start) / f.seconds) : 0;
    const pan = f ? f.screenX * (0.15 + 0.45 * u) : 0;
    while (this.impacts.length >= MAX_IMPACTS) this.mixer.stop(this.impacts.shift()!, 0.15);
    const voice = this.mixer.play(s.buffer, {
      bus: 'effects', gain: dbToGain(p.levels.impact - s.loudness + jitter(1)),
      offset: Math.max(0, s.attack - 0.02), rate: 1 + jitter(0.05),
      pan: { from: pan, to: pan, seconds: 0 },
    });
    if (voice) {
      this.impacts.push(voice);
      voice.source.addEventListener('ended', () => {
        const k = this.impacts.indexOf(voice);
        if (k >= 0) this.impacts.splice(k, 1);
      });
    }
  }

  /**
   * Deslize: agenda o arquivo para o ataque (impacto) cair no frame em que o corpo toca o chão;
   * o arrasto que vem depois dura o tempo deitada.
   * @param toContact segundos até o contato com o chão
   */
  slideStart(toContact: number, p: AudioParams) {
    const s = this.sounds.get('slide');
    if (!s) return;
    const wait = toContact - this.mixer.latency - s.attack;
    this.slideVoice = this.mixer.play(s.buffer, {
      bus: 'effects', gain: dbToGain(p.levels.slide - s.loudness),
      delay: Math.max(0, wait), offset: Math.max(0, -wait), rate: 1 + jitter(0.03),
    });
    this.slideMod = 1;
  }

  /** Bateu numa parede deslizando: o arrasto some junto com a velocidade. */
  private slideFriction(ch: Character) {
    const v = this.slideVoice;
    if (!v) return;
    if (!ch.slide.active) {
      this.slideVoice = null;
      return;
    }
    const k = Math.min(1, ch.slide.speed / (0.5 * ch.slide.peakSpeed));
    if (Math.abs(k - this.slideMod) < 0.05) return;
    this.slideMod = k;
    this.mixer.setVoiceGain(v, v.level * k);
  }
}
