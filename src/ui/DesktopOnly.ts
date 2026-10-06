import { analyze, attackTime, peakLoudness } from '../audio/analysis';
import { config } from '../config';
import type { HudManifest } from './Hud';

/**
 * O jogo precisa de teclado (WASD, Shift, E, C) e da roda do mouse. Celular e tablet ficam de
 * fora: o navegador se declara móvel, ou o ponteiro principal é o dedo (pointer: coarse, sem
 * hover). O iPad se apresenta como Mac; quem o denuncia é o toque. Notebook com tela de toque
 * passa (o ponteiro principal é o mouse/touchpad).
 */
export function isDesktop() {
  const ua = navigator.userAgent;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile: boolean } }).userAgentData;
  const mobile = uaData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const iPadAsMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const touchOnly = matchMedia('(pointer: coarse)').matches && !matchMedia('(hover: hover)').matches;
  return !mobile && !iPadAsMac && !touchOnly;
}

/** Teclas da ilustração, em linhas (nomes das peças do HUD; tamanho proporcional à arte). */
const KEY_ROWS = [['key-w'], ['key-a', 'key-s', 'key-d'], ['key-shift', 'key-e', 'key-c', 'mouse']];

/**
 * Aviso para quem abre fora do computador: pergaminho (arte do HUD) explicando que o jogo usa
 * teclado e mouse. O jogo não carrega. O X fecha a página.
 */
export async function showDesktopOnly(host: HTMLElement, base: string) {
  const hudUrl = `${base}hud/`;
  const m = (await (await fetch(`${hudUrl}hud.json`)).json()) as HudManifest;
  const d = m.dialog!;
  const [pw, ph] = d.panel.size, [l, t, r, b] = d.panel.frame.map((f) => `${(f * 100).toFixed(2)}%`);
  // Largura das teclas: 0,05 cqw por px da arte (a tecla W fica com ~11% da largura do pergaminho).
  const key = (name: string) => {
    const p = m.parts[name];
    return p ? `<img src="${hudUrl}${p.file}" alt="" style="width:${(p.box[2] * 0.05).toFixed(2)}cqw">` : '';
  };

  const root = document.createElement('div');
  root.className = 'desktop-only';
  root.style.setProperty('--panel-aspect', `${pw} / ${ph}`);
  root.style.setProperty('--panel-ratio', `${pw / ph}`);
  root.innerHTML = `
    <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-text">
      <img class="dialog-panel" src="${hudUrl}${d.panel.file}" alt="">
      <div class="dialog-content" style="inset:${t} ${r} ${b} ${l}">
        <h1 id="dialog-title">Jogue no computador</h1>
        <p id="dialog-text">Iso Miko é controlado com <b>teclado e mouse</b>:</p>
        <div class="dialog-keys">${KEY_ROWS.map((row) => `<div>${row.map(key).join('')}</div>`).join('')}</div>
        <p>Celulares e tablets não têm essas teclas, então o jogo não abre aqui.</p>
        <p class="dialog-hint">Abra este endereço num computador para jogar.</p>
      </div>
      <button class="dialog-close" type="button" aria-label="Fechar a página">
        <img src="${hudUrl}${d.close.file}" alt="">
      </button>
    </div>`;
  host.appendChild(root);
  const close = root.querySelector<HTMLButtonElement>('.dialog-close')!;
  close.addEventListener('click', closePage);
  void playError(base, close).catch((e) => console.warn('som de erro indisponível:', e));
}

/**
 * Fecha a aba. O navegador só deixa um script fechar a aba aberta por script ou que tem uma
 * única página no histórico (link aberto direto). Se ela continuar aberta, volta para a página
 * de onde a pessoa veio; sem página anterior, esvazia a aba.
 */
function closePage() {
  window.close();
  setTimeout(() => {
    if (history.length > 1) history.back();
    else location.replace('about:blank');
  }, 250);
}

/**
 * Som de erro junto com o aviso, a partir do tom (o arquivo começa com um clique e meio segundo
 * de silêncio), no volume de config.audio.levels.error. Celulares só liberam som depois de um
 * toque: se o navegador bloquear, toca no primeiro toque na tela, menos no X (que fecha a página).
 * Web Audio, e não <audio>: o Safari do iPhone ignora o volume de um elemento de áudio.
 */
async function playError(base: string, closeButton: HTMLElement) {
  const ctx = new AudioContext();
  const buffer = await ctx.decodeAudioData(await (await fetch(`${base}audio/error.mp3`)).arrayBuffer());
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const a = analyze({ channels, sampleRate: buffer.sampleRate });
  const gain = 10 ** ((config.audio.levels.error - peakLoudness(a)) / 20);
  const offset = Math.max(0, attackTime(a) - 0.03);
  const play = () => {
    const src = new AudioBufferSourceNode(ctx, { buffer });
    src.connect(new GainNode(ctx, { gain })).connect(ctx.destination);
    src.start(0, offset);
  };
  if (ctx.state === 'running') return play();
  const onTouch = (e: PointerEvent) => {
    if (closeButton.contains(e.target as Node)) return;
    window.removeEventListener('pointerup', onTouch);
    void ctx.resume().then(play);
  };
  // pointerup (não pointerdown): é o que conta como gesto do usuário para toque.
  window.addEventListener('pointerup', onTouch);
}
