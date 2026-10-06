import './style.css';
import { config } from './config';
import { FxAtlas } from './fx/FxAtlas';
import { DustAtlas } from './fx/Dust';
import { ExplosionAtlas } from './fx/Explosions';
import { Level } from './level/Level';
import { occlusionShared } from './level/occlusion';
import { Game } from './Game';
import { SpriteAtlas } from './sprites/SpriteAtlas';
import { isDesktop, showDesktopOnly } from './ui/DesktopOnly';
import { Welcome, welcomePending } from './ui/Welcome';

const host = document.getElementById('app')!;
const base = import.meta.env.BASE_URL;

// Sem "Salvar imagem como…": nem menu de contexto (botão direito, tecla de menu, toque longo no
// Android) nem arrastar imagem para fora. O balão do iPhone sai pelo CSS (-webkit-touch-callout).
// Só afasta o salvamento casual: os arquivos continuam acessíveis pelas ferramentas do navegador.
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('dragstart', (e) => e.preventDefault());

// Fora do computador (sem teclado e mouse) o jogo nem carrega: só o aviso.
if (isDesktop()) await start();
else await showDesktopOnly(host, base);

async function start() {
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.textContent = 'carregando sprites…';
  host.appendChild(loading);

  // Apresentação na primeira visita: as imagens dela carregam junto com o jogo. Sem ela
  // (arquivo faltando), o jogo abre direto.
  const welcome = welcomePending() ? Welcome.load(base).catch((e) => (console.warn('apresentação indisponível:', e), null)) : null;

  try {
    const [atlas, fx, dust, explosion, level] = await Promise.all([
      SpriteAtlas.load(`${base}sprites/character`, config.characterHeight),
      // Sem os efeitos o jogo continua (só sem bola de fogo / poeira).
      FxAtlas.load(`${base}sprites/fx/fireball.json`).catch((e) => (console.warn(e), null)),
      DustAtlas.load(`${base}sprites/fx/dust.json`).catch((e) => (console.warn(e), null)),
      ExplosionAtlas.load(`${base}sprites/fx/explosion.json`).catch((e) => (console.warn(e), null)),
      Level.load(`${base}${config.level.url}`),
    ]);
    const game = await Game.create(host, atlas, fx, dust, explosion, level);
    const intro = await welcome;
    loading.remove();
    game.start();
    if (intro) void intro.run(host, game);
    // Acesso pelo console durante o desenvolvimento (ex.: __game.character.loco, __config.fireball).
    if (import.meta.env.DEV) Object.assign(window, { __game: game, __config: config, __setOcc: (v: number) => (occlusionShared.occEnabled.value = v) });
  } catch (err) {
    loading.textContent = `Erro: ${(err as Error).message}`;
    loading.classList.add('error');
    throw err;
  }
}
