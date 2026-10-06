import type { Character } from '../character/Character';
import { DIRECTION_LABELS } from '../character/directions';

/** Formato gerado por tools/build-hud.ts (posições em px da arte original). */
export interface HudManifest {
  size: [number, number];
  parts: Record<string, { file: string; box: [number, number, number, number]; origin?: [number, number] }>;
  /** Caixa de aviso: pergaminho (com as margens até a moldura interna, em fração) e botão X. */
  dialog?: {
    panel: { file: string; size: [number, number]; frame: [number, number, number, number] };
    close: { file: string; size: [number, number] };
  };
}

interface Group {
  /** Peças na ordem de desenho: [nome no manifest, papel (classe CSS)]. */
  parts: [string, string][];
  /** Teclas físicas (event.code) que acionam o grupo. */
  codes: string[];
  /** Seta: quanto se afasta da tecla ao pressionar (% do próprio tamanho). */
  nudge?: [number, number];
}

const GROUPS: Record<string, Group> = {
  w: { parts: [['rays-w', 'rays'], ['key-w', 'key'], ['arrow-up', 'arrow']], codes: ['KeyW', 'ArrowUp'], nudge: [0, -18] },
  a: { parts: [['rays-a', 'rays'], ['key-a', 'key'], ['arrow-left', 'arrow']], codes: ['KeyA', 'ArrowLeft'], nudge: [-18, 0] },
  s: { parts: [['rays-s', 'rays'], ['key-s', 'key'], ['arrow-down', 'arrow']], codes: ['KeyS', 'ArrowDown'], nudge: [0, 18] },
  d: { parts: [['rays-d', 'rays'], ['key-d', 'key'], ['arrow-right', 'arrow']], codes: ['KeyD', 'ArrowRight'], nudge: [18, 0] },
  shift: { parts: [['rays-shift', 'rays'], ['key-shift', 'key'], ['icon-run', 'run']], codes: ['ShiftLeft', 'ShiftRight'] },
  e: { parts: [['rays-e', 'rays'], ['key-e', 'key'], ['icon-fire', 'fire']], codes: ['KeyE'] },
  c: { parts: [['rays-c', 'rays'], ['key-c', 'key'], ['icon-slide', 'slide']], codes: ['KeyC'] },
  mouse: {
    parts: [['rays-mouse', 'rays'], ['mouse', 'key'], ['zoom-out', 'zoom-out'], ['spin-out', 'spin-out'], ['zoom-in', 'zoom-in'], ['spin-in', 'spin-in']],
    codes: [],
  },
};

/**
 * Conjuntos na tela: movimento no canto inferior esquerdo; ações e zoom no inferior direito.
 * Cada conjunto mantém o espaçamento da arte (e a mesma escala), e o centro fica livre para a
 * personagem.
 */
const CLUSTERS: { id: string; groups: string[] }[] = [
  { id: 'move', groups: ['w', 'a', 's', 'd'] },
  { id: 'actions', groups: ['shift', 'e', 'c', 'mouse'] },
];

/** Duração do efeito de toque único mais longo (style.css: hud-cast). */
const HIT_MS = 600;

const STATE_LABEL = { idle: 'parada', move: 'em movimento', settle: 'finalizando passo' } as const;
const TERRAIN_LABEL: Record<string, string> = {
  beach: 'praia', descent: 'degraus de pedra', path: 'caminho', stairs: 'escadaria', top: 'platô do torii',
};
const ACTION_LABEL: Record<string, string> = { idle: 'parada', walk: 'andar', run: 'correr', cast: 'bola de fogo', slide: 'deslize' };

/**
 * HUD de comandos: a arte das teclas montada peça por peça (tools/build-hud.ts), cada tecla
 * reagindo quando é pressionada (efeitos em style.css). Também guarda a leitura de estado
 * (ação, direção, frame, terreno), visível só no modo de desenvolvimento.
 */
export class Hud {
  private readonly el: HTMLElement;
  private readonly status: HTMLElement;
  private readonly groups = new Map<string, HTMLElement>();
  /** Teclas seguradas por grupo (W e ↑ acionam o mesmo grupo). */
  private readonly held = new Map<string, Set<string>>();
  private wheelTimer = 0;
  private readonly hitTimers = new Map<string, number>();
  private fpsAcc = 0;
  private fpsFrames = 0;
  private fps = 0;

  constructor(parent: HTMLElement, baseUrl: string) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.status = document.createElement('div');
    this.status.className = 'hud-status';
    this.status.hidden = true;
    this.el.append(this.status);
    parent.appendChild(this.el);
    this.load(baseUrl).catch((e) => console.warn('HUD indisponível:', e));
    this.listen();
  }

  private async load(baseUrl: string) {
    const res = await fetch(`${baseUrl}hud.json`);
    if (!res.ok) throw new Error(`${baseUrl}hud.json não encontrado (rode "npm run hud")`);
    const m = (await res.json()) as HudManifest;
    const pct = (v: number, of: number) => `${(v / of) * 100}%`;
    for (const cluster of CLUSTERS) {
      // Caixa do conjunto: a união das peças dele, em px da arte.
      const boxes = cluster.groups.flatMap((id) => GROUPS[id].parts.map(([name]) => m.parts[name]?.box).filter((b) => !!b));
      const X = Math.min(...boxes.map((b) => b[0])), Y = Math.min(...boxes.map((b) => b[1]));
      const W = Math.max(...boxes.map((b) => b[0] + b[2])) - X, H = Math.max(...boxes.map((b) => b[1] + b[3])) - Y;
      const el = document.createElement('div');
      el.className = `hud-cluster hud-${cluster.id}`;
      // Tamanho em px da arte × --hud-u (px de tela por px da arte, ver style.css).
      Object.assign(el.style, { width: `calc(${W} * var(--hud-u))`, aspectRatio: `${W} / ${H}` });
      for (const id of cluster.groups) {
        const g = GROUPS[id];
        const group = document.createElement('div');
        group.className = `hud-group hud-${id}`;
        for (const [name, role] of g.parts) {
          const p = m.parts[name];
          if (!p) continue;
          const [x, y, w, h] = p.box;
          const img = document.createElement('img');
          img.src = baseUrl + p.file;
          img.alt = '';
          img.draggable = false;
          img.className = `hud-part hud-${role}`;
          Object.assign(img.style, { left: pct(x - X, W), top: pct(y - Y, H), width: pct(w, W), height: pct(h, H) });
          // Raios abrem a partir do centro da tecla.
          if (p.origin) img.style.transformOrigin = `${pct(p.origin[0] - x, w)} ${pct(p.origin[1] - y, h)}`;
          if (role === 'arrow' && g.nudge) img.style.cssText += `--dx:${g.nudge[0]}%;--dy:${g.nudge[1]}%`;
          group.appendChild(img);
        }
        el.appendChild(group);
        this.groups.set(id, group);
      }
      this.el.appendChild(el);
    }
  }

  private listen() {
    const byCode = new Map<string, string>();
    for (const [id, g] of Object.entries(GROUPS)) for (const c of g.codes) byCode.set(c, id);
    const typing = (e: Event) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };
    window.addEventListener('keydown', (e) => {
      const id = byCode.get(e.code);
      if (!id || typing(e)) return;
      const set = this.held.get(id) ?? new Set<string>();
      this.held.set(id, set.add(e.code));
      const g = this.groups.get(id);
      if (!g || e.repeat) return;
      g.classList.add('down');
      // Efeito de toque único: reinicia a cada toque e toca até o fim mesmo num toque rápido.
      g.classList.remove('hit');
      void g.offsetWidth;
      g.classList.add('hit');
      clearTimeout(this.hitTimers.get(id));
      this.hitTimers.set(id, window.setTimeout(() => g.classList.remove('hit'), HIT_MS));
    });
    window.addEventListener('keyup', (e) => {
      const id = byCode.get(e.code);
      if (!id) return;
      const set = this.held.get(id);
      set?.delete(e.code);
      if (!set?.size) this.groups.get(id)?.classList.remove('down');
    });
    // Sem isso, soltar uma tecla com a janela fora de foco a deixaria "pressionada".
    const clear = () => {
      this.held.clear();
      for (const g of this.groups.values()) g.classList.remove('down');
    };
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
    // Roda (zoom do jogo, só sobre o canvas): para cima aproxima (+), para baixo afasta (−).
    window.addEventListener('wheel', (e) => {
      const m = this.groups.get('mouse');
      if (!m || !(e.target instanceof HTMLCanvasElement) || e.deltaY === 0) return;
      const zoomIn = e.deltaY < 0;
      m.classList.toggle('zoom-in', zoomIn);
      m.classList.toggle('zoom-out', !zoomIn);
      clearTimeout(this.wheelTimer);
      this.wheelTimer = window.setTimeout(() => m.classList.remove('zoom-in', 'zoom-out'), 220);
    }, { passive: true });
  }

  toggle() {
    this.el.classList.toggle('hidden');
  }

  /** Some com fade (apresentação na tela) e volta com fade. */
  conceal(on: boolean) {
    this.el.classList.toggle('concealed', on);
  }

  /** Leitura de estado (modo de desenvolvimento). */
  showStatus(show: boolean) {
    this.status.hidden = !show;
  }

  private terrainLabel(ch: Character) {
    const t = ch.terrain;
    if (!t) return 'terreno —';
    const name = TERRAIN_LABEL[t.id] ?? t.id;
    return t.steps ? `${name} <small>(degrau ${t.step}/${t.steps})</small>` : name;
  }

  private stateLabel(ch: Character) {
    if (ch.cast.active) return ch.cast.released ? 'recuperando' : 'conjurando';
    if (ch.slide.active) return ch.slide.grounded ? 'no chão' : ch.slide.lie > 0.05 ? 'levantando' : 'entrando';
    return STATE_LABEL[ch.loco.state];
  }

  update(dt: number, ch: Character) {
    if (this.status.hidden) return;
    this.fpsAcc += dt;
    this.fpsFrames++;
    // ~10 atualizações/s bastam para leitura e evitam reescrever o DOM a cada frame.
    if (this.fpsAcc < 0.1) return;
    this.fps = Math.round(this.fpsFrames / this.fpsAcc);
    this.fpsAcc = 0;
    this.fpsFrames = 0;
    const d = ch.display, l = ch.loco;
    const deg = Math.round((l.facing * 180) / Math.PI);
    this.status.innerHTML = `
      <div><b>${ACTION_LABEL[d.action] ?? d.action}</b> · ${this.stateLabel(ch)}</div>
      <div>direção <b>${DIRECTION_LABELS[d.dir]}</b> <small>(${deg}°)</small></div>
      <div>frame <b>${d.loopIndex + 1}/${d.loopLength}</b> <small>col ${d.column}</small> · fase ${l.phase.toFixed(2)}</div>
      <div>${this.terrainLabel(ch)} · altura ${ch.height.toFixed(2)} m</div>
      <div>${(ch.slide.active ? ch.slide.speed : l.speed).toFixed(2)} m/s · ${this.fps} fps</div>
    `;
  }
}
