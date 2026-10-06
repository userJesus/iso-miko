import GUI from 'lil-gui';
import type { Config } from '../config';
import type { Demo, DemoMode } from '../core/Demo';

export interface DebugHooks {
  /** Velocidades derivadas (m/s), recalculadas pelo jogo. */
  derived: { walkSpeed: number; runSpeed: number; walkStride: number; runStride: number };
  onZoom: (z: number) => void;
  onAnchor: (on: boolean) => void;
  onDemo: () => void;
  onOcclusion: (on: boolean) => void;
  onWalkable: (on: boolean) => void;
  onFog: () => void;
}

/** Painel de ajuste fino (fechado por padrão, canto superior direito). */
export function createDebugPanel(cfg: Config, demo: Demo, hooks: DebugHooks): GUI {
  const gui = new GUI({ title: 'Ajustes' });
  gui.close();

  const mv = gui.addFolder('Movimento');
  const strideProxy = {
    get walkStride() { return hooks.derived.walkStride; },
    set walkStride(v: number) { cfg.walk.strideOverride = v; },
    get runStride() { return hooks.derived.runStride; },
    set runStride(v: number) { cfg.run.strideOverride = v; },
  };
  mv.add(cfg.walk, 'cycleSeconds', 0.5, 2, 0.01).name('andar: ciclo (s)');
  mv.add(strideProxy, 'walkStride', 0.4, 3, 0.01).name('andar: passada (m)').listen();
  mv.add(hooks.derived, 'walkSpeed').name('andar: m/s').disable().listen();
  mv.add(cfg.run, 'cycleSeconds', 0.3, 1.5, 0.01).name('correr: ciclo (s)');
  mv.add(strideProxy, 'runStride', 0.4, 4, 0.01).name('correr: passada (m)').listen();
  mv.add(hooks.derived, 'runSpeed').name('correr: m/s').disable().listen();
  mv.add(cfg.locomotion, 'turnRateDeg', 90, 1800, 10).name('giro (°/s)');
  mv.add(cfg.locomotion, 'accel', 2, 30, 0.5).name('aceleração');
  mv.add(cfg.locomotion, 'decel', 2, 40, 0.5).name('frenagem');
  mv.add(cfg.locomotion, 'settleRate', 0.5, 6, 0.1).name('fechar passo (ciclos/s)');
  mv.add({ reset: () => { cfg.walk.strideOverride = null; cfg.run.strideOverride = null; } }, 'reset')
    .name('passadas do pipeline');

  const idle = gui.addFolder('Parada');
  idle.add(cfg.idle, 'breathAmplitude', 0, 0.03, 0.001).name('respiração (amplitude)');
  idle.add(cfg.idle, 'breathPeriod', 1, 8, 0.1).name('respiração (s)');

  const sl = gui.addFolder('Deslize');
  sl.add(cfg.slide, 'groundSeconds', 0.2, 1.5, 0.01).name('no chão (s)');
  sl.add(cfg.slide, 'recoverSeconds', 0.15, 1.2, 0.01).name('levantar (s)');
  sl.add(cfg.slide, 'boost', 1, 2, 0.05).name('impulso no contato');
  sl.add(cfg.slide, 'endRatio', 0.05, 0.8, 0.01).name('velocidade ao levantar');
  sl.add(cfg.slide, 'dustSpacing', 0.1, 1, 0.01).name('poeira a cada (m)');
  sl.add(cfg.dust, 'size', 0.3, 2, 0.05).name('tamanho da poeira (m)');
  sl.add(cfg.dust, 'life', 0.2, 1.5, 0.05).name('duração da poeira (s)');

  const fb = gui.addFolder('Bola de fogo');
  fb.add(cfg.fireball, 'castPre', 0.1, 1.2, 0.01).name('até soltar (s)');
  fb.add(cfg.fireball, 'castPost', 0.1, 1.2, 0.01).name('recuperação (s)');
  fb.add(cfg.fireball, 'speed', 2, 30, 0.5).name('velocidade (m/s)');
  fb.add(cfg.fireball, 'range', 2, 30, 0.5).name('alcance (m)');
  fb.add(cfg.fireball, 'scale', 0.5, 3, 0.05).name('tamanho');
  fb.add(cfg.fireball, 'heldScale', 0.5, 3, 0.05).name('tamanho na mão');
  fb.add(cfg.fireball, 'impactScale', 0.3, 3, 0.05).name('explosão: tamanho');
  fb.add(cfg.fireball, 'impactFps', 4, 30, 1).name('explosão: quadros/s');

  const lv = gui.addFolder('Cenário');
  lv.add(cfg.level, 'occlusion').name('sumir atrás de objetos').onChange(hooks.onOcclusion);
  lv.add(cfg.level, 'showWalkable').name('mostrar área caminhável').onChange(hooks.onWalkable);
  lv.add(cfg.sea, 'fogStart', 0.8, 3, 0.01).name('mar: começa a enevoar').onChange(hooks.onFog);
  lv.add(cfg.sea, 'fogEnd', 1.0, 4, 0.01).name('mar: neblina fecha').onChange(hooks.onFog);
  lv.add(cfg.sea, 'fogBack', 1, 4, 0.05).name('mar atrás da ilha').onChange(hooks.onFog);

  const snd = gui.addFolder('Som');
  snd.add(cfg.audio, 'muted').name('mudo (M)').listen();
  snd.add(cfg.audio.volume, 'master', 0, 1, 0.01).name('volume geral');
  snd.add(cfg.audio.volume, 'music', 0, 1, 0.01).name('música');
  snd.add(cfg.audio.volume, 'ambience', 0, 1, 0.01).name('mar');
  snd.add(cfg.audio.volume, 'effects', 0, 1, 0.01).name('efeitos');
  snd.add(cfg.audio.volume, 'voice', 0, 1, 0.01).name('voz (apresentação)');
  const mix = snd.addFolder('Mixagem (LUFS-alvo)').close();
  const LEVEL_LABEL = {
    impact: 'explosão', fireball: 'bola de fogo', slide: 'deslize', run: 'passo correndo', walk: 'passo andando',
    idle: 'parada (roupa)', music: 'música', ambience: 'mar', voice: 'voz (apresentação)',
  } as const;
  for (const k of Object.keys(LEVEL_LABEL) as (keyof typeof LEVEL_LABEL)[]) {
    mix.add(cfg.audio.levels, k, -40, -4, 0.5).name(LEVEL_LABEL[k]);
  }

  const cam = gui.addFolder('Câmera');
  cam.add(cfg.camera, 'zoom', cfg.camera.zoomMin, cfg.camera.zoomMax, 0.01).name('zoom').listen().onChange(hooks.onZoom);
  cam.add(cfg.camera, 'follow', 1, 20, 0.5).name('acompanhamento');

  const dbg = gui.addFolder('Validação');
  dbg.add(cfg.debug, 'timeScale', 0, 1.5, 0.05).name('velocidade do tempo');
  dbg.add(cfg.debug, 'showAnchor').name('âncora e célula').onChange(hooks.onAnchor);
  const modes: DemoMode[] = ['desligado', 'círculo', 'rosa dos ventos', 'bola de fogo 8 direções', 'deslize 8 direções'];
  dbg.add(demo, 'mode', modes).name('demo automático').onChange(hooks.onDemo);
  dbg.add(demo, 'run').name('demo correndo');

  return gui;
}
