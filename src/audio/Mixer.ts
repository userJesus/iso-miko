export type Bus = 'music' | 'ambience' | 'effects' | 'voice';

const BUSES: Bus[] = ['music', 'ambience', 'effects', 'voice'];

export interface Volumes extends Record<Bus, number> {
  master: number;
}

export interface PlayOptions {
  bus: Bus;
  /** Ganho linear. */
  gain: number;
  /** Trecho do arquivo (s). */
  offset?: number;
  duration?: number;
  /** Espera (s) a partir de agora. */
  delay?: number;
  /** Velocidade de reprodução (muda o tom junto). */
  rate?: number;
  /** Panorâmica de `from` a `to` (−1 esquerda … 1 direita) em `seconds`. */
  pan?: { from: number; to: number; seconds: number };
  /** Fade de saída no fim do trecho (s do arquivo). */
  fadeOut?: number;
}

/** Som tocando: o ganho pode ser modulado ou cortado depois (setVoiceGain, stop). */
export interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** Ganho pedido em play(). */
  level: number;
  /** Tempo de contexto em que começa a soar. */
  start: number;
}

/** Curvas de potência constante (sen/cos): o volume não afunda no meio da emenda. */
const FADE_IN = Float32Array.from({ length: 64 }, (_, i) => Math.sin(((i / 63) * Math.PI) / 2));
const FADE_OUT = FADE_IN.slice().reverse();

/**
 * Grafo de áudio: sons → grupo (música, ambiente, efeitos, voz) → volume geral → limitador → saída.
 * O AudioContext só nasce no primeiro gesto (tecla ou clique), porque os navegadores bloqueiam
 * o som antes disso. A decodificação usa um contexto offline, então os arquivos carregam antes.
 */
export class Mixer {
  ctx: AudioContext | null = null;
  private unlocked!: () => void;
  /** Resolve quando o som fica liberado (contexto rodando, depois do primeiro gesto). */
  readonly ready = new Promise<void>((resolve) => (this.unlocked = resolve));
  private master: GainNode | null = null;
  private readonly buses = {} as Record<Bus, GainNode>;
  private readonly decoder = new OfflineAudioContext(2, 1, 48000);
  /** Último alvo pedido por parâmetro (evita reagendar a mesma rampa a cada frame). */
  private readonly targets = new WeakMap<AudioParam, number>();

  constructor() {
    // Escuta até o som de fato rodar: uma tecla que não conta como gesto (Esc) cria o contexto
    // suspenso, e o próximo gesto o libera.
    const unlock = () => {
      if (!this.ctx) this.createGraph();
      void this.ctx!.resume().then(() => {
        if (this.ctx!.state !== 'running') return;
        window.removeEventListener('keydown', unlock);
        window.removeEventListener('pointerdown', unlock);
        this.unlocked();
      });
    };
    window.addEventListener('keydown', unlock);
    window.addEventListener('pointerdown', unlock);
    // Aba em segundo plano: pausa tudo, e o agendamento dos laços não fica para trás.
    document.addEventListener('visibilitychange', () => {
      if (this.ctx) void (document.hidden ? this.ctx.suspend() : this.ctx.resume());
    });
  }

  private createGraph() {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    // Limitador de segurança: só age quando vários sons fortes se somam (ex.: duas bolas de
    // fogo sobre uma onda quebrando). Os níveis da mixagem ficam abaixo do limiar.
    const limiter = new DynamicsCompressorNode(ctx, { threshold: -6, knee: 4, ratio: 12, attack: 0.002, release: 0.15 });
    this.master = new GainNode(ctx);
    this.master.connect(limiter).connect(ctx.destination);
    for (const b of BUSES) (this.buses[b] = new GainNode(ctx)).connect(this.master);
    this.ctx = ctx;
  }

  get running() {
    return this.ctx?.state === 'running';
  }

  /** Atraso entre agendar e ouvir (s), limitado: os passos são disparados com essa antecedência. */
  get latency() {
    const c = this.ctx;
    return c ? Math.min(0.15, (c.outputLatency || 0) + (c.baseLatency || 0)) : 0;
  }

  async decode(url: string): Promise<AudioBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return this.decoder.decodeAudioData(await res.arrayBuffer());
  }

  /**
   * Leva um parâmetro ao valor com uma rampa (sem estalo ao mexer no painel).
   * @param tau constante de tempo (s): ~95% do caminho em 3 × tau
   */
  setParam(param: AudioParam, value: number, tau = 0.03) {
    if (!this.ctx || this.targets.get(param) === value) return;
    this.targets.set(param, value);
    param.setTargetAtTime(value, this.ctx.currentTime, tau);
  }

  setVolumes(v: Volumes, muted: boolean) {
    if (!this.master) return;
    this.setParam(this.master.gain, muted ? 0 : v.master);
    for (const b of BUSES) this.setParam(this.buses[b].gain, v[b]);
  }

  setVoiceGain(voice: Voice, value: number) {
    if (this.ctx) voice.gain.gain.setTargetAtTime(value, Math.max(this.ctx.currentTime, voice.start + 0.005), 0.03);
  }

  /** Corta um som com um fade curto (ex.: o sopro da bola quando ela explode). */
  stop(voice: Voice, fade = 0.05) {
    if (!this.ctx) return;
    const t = Math.max(this.ctx.currentTime, voice.start);
    voice.gain.gain.cancelScheduledValues(t);
    voice.gain.gain.setTargetAtTime(0, t, fade / 3);
    voice.source.stop(t + fade);
  }

  play(buffer: AudioBuffer, o: PlayOptions): Voice | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return null;
    const rate = o.rate ?? 1, offset = o.offset ?? 0;
    const duration = o.duration ?? buffer.duration - offset;
    const t = ctx.currentTime + (o.delay ?? 0), end = t + duration / rate;
    const src = new AudioBufferSourceNode(ctx, { buffer, playbackRate: rate });
    const gain = new GainNode(ctx, { gain: 0 });
    // Rampa curta na entrada: começar no meio da onda estalaria.
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(o.gain, t + 0.004);
    if (o.fadeOut) {
      gain.gain.setValueAtTime(o.gain, end - o.fadeOut / rate);
      gain.gain.linearRampToValueAtTime(0, end);
    }
    let out: AudioNode = gain;
    if (o.pan) {
      const pan = new StereoPannerNode(ctx, { pan: o.pan.from });
      pan.pan.setValueAtTime(o.pan.from, t);
      pan.pan.linearRampToValueAtTime(o.pan.to, t + o.pan.seconds);
      out = gain.connect(pan);
    }
    src.connect(gain);
    out.connect(this.buses[o.bus]);
    src.onended = () => out.disconnect();
    src.start(t, offset, duration);
    return { source: src, gain, level: o.gain, start: t };
  }

  loop(buffer: AudioBuffer, bus: Bus, range: [number, number], crossfade: number) {
    if (!this.ctx) throw new Error('Mixer.loop antes do primeiro gesto');
    return new Loop(this.ctx, this.buses[bus], buffer, range, crossfade);
  }
}

/**
 * Laço com crossfade de potência constante: cada volta toca o trecho `range` e a próxima entra
 * `crossfade` s antes do fim. Emenda sem estalo mesmo com o arquivo terminando cortado (trilha)
 * ou com fade nas pontas (mar). As voltas são agendadas com 2 s de antecedência.
 */
export class Loop {
  /** Ganho do laço (nível de mixagem). */
  readonly level: GainNode;
  private next = 0;

  constructor(
    private readonly ctx: AudioContext,
    out: AudioNode,
    private readonly buffer: AudioBuffer,
    private readonly range: [number, number],
    private readonly crossfade: number,
  ) {
    this.level = new GainNode(ctx, { gain: 0 });
    this.level.connect(out);
  }

  /** Chamado a cada frame. */
  update() {
    const ctx = this.ctx, [from, to] = this.range, len = to - from;
    const xf = Math.min(this.crossfade, len / 3);
    if (!this.next) this.next = ctx.currentTime + 0.05;
    while (this.next < ctx.currentTime + 2) {
      const t = this.next;
      const src = new AudioBufferSourceNode(ctx, { buffer: this.buffer });
      const g = new GainNode(ctx, { gain: 0 });
      g.gain.setValueCurveAtTime(FADE_IN, t, xf);
      g.gain.setValueCurveAtTime(FADE_OUT, t + len - xf, xf);
      src.connect(g).connect(this.level);
      src.onended = () => g.disconnect();
      src.start(t, from, len);
      this.next = t + len - xf;
    }
  }
}
