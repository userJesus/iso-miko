import { config } from '../config';
import type { Game } from '../Game';

type Rect = [left: number, top: number, right: number, bottom: number];

/** Formato gerado por tools/build-welcome.ts (retângulos em fração da caixa). */
interface WelcomeManifest {
  portraits: { files: string[]; size: [number, number] };
  box: { file: string; size: [number, number]; text: Rect; name: Rect; next: { file: string; rect: Rect } };
}

/** Falas (assets-src/welcome/falas.txt): retrato, voz (public/audio/welcome-N.mp3) e texto, com **negrito**. */
const LINES = [
  { portrait: 0, text: 'Olá! Tudo bem? Seja muito bem-vindo!\nEu me chamo **Iso Miko** e vou acompanhar você por aqui!' },
  { portrait: 1, text: 'Estou aqui para te apresentar esta pequena ilha, criada pelo **Jesus** com a ajuda da Inteligência Artificial.' },
  {
    portrait: 2,
    text: 'Ah, e uma curiosidade: todos os assets, animações e efeitos sonoros deste projeto foram criados com o auxílio de Inteligência Artificial.\n'
      + 'Este é um projeto independente, desenvolvido exclusivamente para estudo, experimentação e aprendizado.',
  },
  { portrait: 3, text: 'Agora é com você! Explore a ilha, divirta-se e aproveite a experiência.\nEspero que goste!' },
];

const SPEAKER = 'Iso Miko';
/** Gravado quando a pessoa passa pela última fala. Mudar a versão faz a apresentação voltar para todo mundo. */
const STORAGE_KEY = 'iso-miko:welcome:v1';
/** `?apresentacao` no endereço mostra de novo (sem apagar o registro). */
const FORCE_PARAM = 'apresentacao';
/** Duração da saída (style.css: .welcome.leaving). */
const LEAVE_MS = 650;

/**
 * A apresentação aparece até a pessoa chegar ao fim dela uma vez. Atualizar a página no meio
 * recomeça do início. Sem localStorage (navegação privada bloqueada etc.) ela aparece sempre.
 */
export function welcomePending() {
  if (new URLSearchParams(location.search).has(FORCE_PARAM)) return true;
  try {
    return localStorage.getItem(STORAGE_KEY) === null;
  } catch {
    return true;
  }
}

function markSeen() {
  try {
    localStorage.setItem(STORAGE_KEY, new Date().toISOString());
  } catch {
    // Sem armazenamento: aparece de novo na próxima visita.
  }
}

type State = 'gate' | 'typing' | 'done' | 'leaving';

/**
 * Apresentação inicial: a Iso Miko (retrato) fala na caixa de pergaminho, por cima da ilha já
 * carregada. O jogo fica travado (a personagem parada, sem HUD) até a última fala.
 *
 * - Começa num convite ("clique ou aperte Espaço"): o navegador só libera som depois de um
 *   gesto, e as falas têm voz. O mesmo gesto já inicia a primeira fala.
 * - Cada fala troca o retrato (crossfade), toca a voz e escreve o texto letra a letra, com
 *   pausas na pontuação. Avançar no meio completa o texto; avançar com ele completo vai para
 *   a próxima fala (cortando a voz). A seta ">>>" da caixa pulsa quando dá para avançar.
 * - Avança com clique, Espaço, Enter ou →.
 * - Termina ao avançar na última fala: só então fica gravado (localStorage) que ela foi vista.
 */
export class Welcome {
  private readonly root: HTMLElement;
  private readonly portraits: HTMLImageElement[];
  private readonly figure: HTMLElement;
  private readonly text: HTMLElement;
  /** Texto inteiro da fala, para leitores de tela (o texto visível é letra a letra). */
  private readonly spoken: HTMLElement;
  private chars: HTMLElement[] = [];
  private shown = 0;
  private nextAt = 0;
  private clock = 0;
  private index = -1;
  /** Fala cuja voz já começou (a voz pode chegar depois do texto: som liberado ou arquivo carregado). */
  private voiced = -1;
  private state: State = 'gate';
  private raf = 0;
  private game!: Game;
  private finish!: () => void;
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Carrega o manifest e já decodifica as imagens (a apresentação abre sem piscar). */
  static async load(base: string) {
    const url = `${base}welcome/`;
    const res = await fetch(`${url}welcome.json`);
    if (!res.ok) throw new Error(`${url}welcome.json não encontrado (rode "npm run welcome")`);
    const m = (await res.json()) as WelcomeManifest;
    const image = async (file: string) => {
      const img = new Image();
      img.src = url + file;
      img.alt = '';
      img.draggable = false;
      await img.decode();
      return img;
    };
    const [box, next, ...portraits] = await Promise.all([m.box.file, m.box.next.file, ...m.portraits.files].map(image));
    return new Welcome(m, box, next, portraits, base);
  }

  private constructor(
    m: WelcomeManifest,
    box: HTMLImageElement,
    next: HTMLImageElement,
    portraits: HTMLImageElement[],
    private readonly base: string,
  ) {
    const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
    const inset = ([l, t, r, b]: Rect) => `${pct(t)} ${pct(1 - r)} ${pct(1 - b)} ${pct(l)}`;
    this.portraits = portraits;
    this.root = document.createElement('div');
    this.root.className = 'welcome';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Apresentação');
    this.root.innerHTML = `
      <div class="welcome-stage">
        <div class="welcome-figure" style="aspect-ratio:${m.portraits.size[0]} / ${m.portraits.size[1]}">
          <div class="welcome-portraits"></div>
        </div>
        <div class="welcome-box" style="aspect-ratio:${m.box.size[0]} / ${m.box.size[1]}">
          <div class="welcome-name" style="inset:${inset(m.box.name)}">${SPEAKER}</div>
          <div class="welcome-text" aria-hidden="true"></div>
          <p class="welcome-spoken" aria-live="polite"></p>
        </div>
      </div>`;
    this.figure = this.root.querySelector('.welcome-figure')!;
    this.root.querySelector('.welcome-portraits')!.append(...portraits);
    const boxEl = this.root.querySelector<HTMLElement>('.welcome-box')!;
    box.className = 'welcome-box-art';
    boxEl.prepend(box);
    // A fala ocupa o papel da moldura interna, sem passar por cima da coluna da seta.
    const [l, t, r, b] = m.box.text, [nl, nt, nr, nb] = m.box.next.rect;
    this.text = this.root.querySelector('.welcome-text')!;
    this.text.style.inset = inset([l, t, Math.min(r, nl - 0.01), b]);
    next.className = 'welcome-next';
    Object.assign(next.style, { left: pct(nl), top: pct(nt), width: pct(nr - nl), height: pct(nb - nt) });
    boxEl.append(next);
    this.spoken = this.root.querySelector('.welcome-spoken')!;
  }

  /** Mostra a apresentação sobre o jogo; resolve quando ela fecha. */
  run(host: HTMLElement, game: Game) {
    this.game = game;
    game.lock(true);
    // Carrega as vozes enquanto o convite está na tela.
    const voices = game.audio.loadVoices(LINES.map((_, k) => `${this.base}audio/welcome-${k + 1}.mp3`));
    void Promise.all([voices, game.audio.ready]).then(() => {
      if (this.state === 'typing' || this.state === 'done') this.voice(this.index);
    });
    this.portraits[0].classList.add('active');
    this.gate();
    host.appendChild(this.root);
    this.root.addEventListener('click', this.onClick);
    window.addEventListener('keydown', this.onKey);
    return new Promise<void>((resolve) => (this.finish = resolve));
  }

  /** Convite inicial: o primeiro gesto libera o som e começa a primeira fala. */
  private gate() {
    this.text.innerHTML = '<span class="welcome-hint">Clique ou aperte <b>Espaço</b> para começar</span>';
    this.spoken.textContent = 'Clique ou aperte Espaço para começar.';
    this.root.classList.add('ready');
  }

  private readonly onClick = () => this.advance();

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code !== 'Space' && e.code !== 'Enter' && e.code !== 'NumpadEnter' && e.code !== 'ArrowRight') return;
    e.preventDefault();
    if (!e.repeat) this.advance();
  };

  private advance() {
    switch (this.state) {
      case 'gate':
      case 'done':
        if (this.index + 1 < LINES.length) this.show(this.index + 1);
        else this.leave();
        break;
      case 'typing':
        this.reveal(this.chars.length);
        break;
    }
  }

  private show(i: number) {
    const line = LINES[i];
    this.index = i;
    this.state = 'typing';
    this.root.classList.remove('ready');
    this.portraits.forEach((img, k) => img.classList.toggle('active', k === line.portrait));
    // Pulo curto do retrato a cada fala (reinicia a animação).
    this.figure.classList.remove('talk');
    void this.figure.offsetWidth;
    this.figure.classList.add('talk');
    this.voice(i);

    this.text.replaceChildren();
    this.chars = [];
    // Partes alternadas: texto normal, **negrito**, normal…
    for (const [k, part] of line.text.split('**').entries()) {
      const parent = k % 2 ? this.text.appendChild(document.createElement('b')) : this.text;
      for (const ch of part) {
        if (ch === '\n') {
          parent.appendChild(document.createElement('br'));
          continue;
        }
        const span = document.createElement('span');
        span.className = 'welcome-char';
        span.textContent = ch;
        parent.appendChild(span);
        this.chars.push(span);
      }
    }
    this.spoken.textContent = line.text.replaceAll('**', '').replaceAll('\n', ' ');
    this.shown = 0;
    this.clock = this.nextAt = 0;
    if (this.reducedMotion) return this.reveal(this.chars.length);
    cancelAnimationFrame(this.raf);
    let last = performance.now();
    const tick = (now: number) => {
      this.clock += Math.min(0.1, (now - last) / 1000);
      last = now;
      this.type();
      if (this.state === 'typing') this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private voice(i: number) {
    if (this.voiced !== i && this.game.audio.speak(i, config.audio)) this.voiced = i;
  }

  /** Letra a letra no ritmo de config.welcome, com pausa depois da pontuação. */
  private type() {
    const w = config.welcome;
    let n = this.shown;
    while (n < this.chars.length && this.clock >= this.nextAt) {
      const ch = this.chars[n++].textContent!;
      this.nextAt += 1 / w.charsPerSecond + ('.!?'.includes(ch) ? w.pauseSentence : ',;:'.includes(ch) ? w.pauseComma : 0);
    }
    this.reveal(n);
  }

  private reveal(n: number) {
    for (let k = this.shown; k < n; k++) this.chars[k].classList.add('on');
    this.shown = n;
    if (n < this.chars.length) return;
    cancelAnimationFrame(this.raf);
    this.state = 'done';
    this.root.classList.add('ready');
  }

  /**
   * Fim: grava que a apresentação foi vista, devolve o jogo e sai com animação. A última fala
   * ("Espero que goste!") termina por cima do jogo, em vez de ser cortada.
   */
  private leave() {
    this.state = 'leaving';
    markSeen();
    this.game.lock(false);
    window.removeEventListener('keydown', this.onKey);
    this.root.classList.add('leaving');
    setTimeout(() => {
      this.root.remove();
      this.finish();
    }, this.reducedMotion ? 0 : LEAVE_MS);
  }
}
