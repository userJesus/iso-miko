import * as THREE from 'three';
import { Character, type CastParams, type CharacterParams, type SlideParams } from './character/Character';
import { GameAudio } from './audio/GameAudio';
import { Island } from './level/Island';
import type { Level } from './level/Level';
import { occlusionShared, setupOcclusion } from './level/occlusion';
import { Sea } from './world/Sea';
import type { LocoParams } from './character/Locomotion';
import { config } from './config';
import { Demo } from './core/Demo';
import { Input } from './core/Input';
import { IsoCamera } from './core/IsoCamera';
import { Fireballs, type FireballParams } from './fx/Fireballs';
import type { FxAtlas } from './fx/FxAtlas';
import { Dust, type DustAtlas } from './fx/Dust';
import { Explosions, type ExplosionAtlas, type ExplosionParams } from './fx/Explosions';
import { SpriteAtlas } from './sprites/SpriteAtlas';
import { createDebugPanel } from './ui/DebugPanel';
import { Hud } from './ui/Hud';

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly cam: IsoCamera;
  private island!: Island;
  private sea!: Sea;
  private readonly character: Character;
  private readonly input = new Input();
  private readonly demo = new Demo();
  private readonly hud: Hud;
  private readonly timer = new THREE.Timer();
  private readonly derived = { walkSpeed: 0, runSpeed: 0, walkStride: 0, runStride: 0 };
  private readonly params: LocoParams = {
    walkSpeed: 0, runSpeed: 0, walkStride: 1, runStride: 1,
    accel: 0, decel: 0, turnRate: 0, settleRate: 0, stopSpeed: 0,
  };
  private readonly fireballs: Fireballs | null;
  private readonly dust: Dust | null;
  private readonly explosions: Explosions | null;
  readonly audio = new GameAudio();
  private castPressed = false;
  private slidePressed = false;
  /** Apresentação na tela: o jogo roda por trás, sem responder às teclas. */
  private locked = false;
  private static readonly STILL = { x: 0, y: 0, run: false };

  static async create(
    host: HTMLElement, atlas: SpriteAtlas, fx: FxAtlas | null, dust: DustAtlas | null,
    explosion: ExplosionAtlas | null, level: Level,
  ) {
    const game = new Game(host, atlas, fx, dust, explosion, level);
    await game.buildWorld();
    return game;
  }

  private constructor(
    private readonly host: HTMLElement,
    private readonly atlas: SpriteAtlas,
    fx: FxAtlas | null,
    dust: DustAtlas | null,
    explosion: ExplosionAtlas | null,
    private readonly level: Level,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(config.sea.fogColor);
    this.cam = new IsoCamera(config.camera.pitchDeg, config.camera.yawDeg, atlas.pxPerMeter, config.camera.zoom);
    this.character = new Character(atlas, this.cam, fx);
    this.character.setLevel(level, level.spawn.u, level.spawn.v);
    this.scene.add(this.character.root);
    this.fireballs = fx ? new Fireballs(fx, this.cam) : null;
    if (this.fireballs) this.scene.add(this.fireballs.group);
    this.explosions = explosion ? new Explosions(explosion, this.cam) : null;
    if (this.explosions) this.scene.add(this.explosions.group);
    const fireballs = this.fireballs;
    this.character.onRelease = (e) => {
      const id = fireballs?.spawn({
        position: e.position,
        direction: e.direction,
        level: e.level,
        // Bola do sprite de voo com o raio da bola da arte × escala configurada.
        scale: (e.radius * config.fireball.scale) / fx!.manifest.flight.ballRadius,
        groundY: this.character.position.y,
      });
      const f = config.fireball;
      if (id) this.audio.fireball(id, e.direction.dot(this.cam.right), f.range / f.speed, config.audio);
    };
    if (fireballs) {
      // Bateu numa superfície: explode ali (sem bater, a bola só se dissipa no fim do alcance).
      fireballs.onImpact = (e) => {
        const ex = this.explosions;
        if (ex) {
          // Inteira sobre o que ela atingiu: a chave é a do obstáculo mais à frente na área dela.
          const r = ex.extent(e.ballRadius, this.explosionParams()), s = this.cam.screenOf(e.position);
          const front = level.frontKey(s.x - r.left, s.y - r.down, s.x + r.right, s.y + r.up, e.level);
          ex.spawn({ ...e, occKey: Math.min(e.occKey, front + config.level.occlusionBias) }, this.explosionParams());
        }
        this.audio.impact(e.id, config.audio);
      };
    }
    this.character.onSlideStart = (toContact) => this.audio.slideStart(toContact, config.audio);
    // Sem os sons o jogo continua (mudo).
    this.audio.load(`${import.meta.env.BASE_URL}audio/`).catch((e) => console.warn(e));
    this.dust = dust ? new Dust(dust, this.cam) : null;
    if (this.dust) {
      this.scene.add(this.dust.group);
      const d = this.dust;
      this.character.onDust = (e) => d.spawn(e, config.dust);
    }
    // A personagem só ganha posição no primeiro update: a câmera já começa sobre o ponto de partida.
    const { u, v } = level.spawn;
    this.cam.snapTo(this.cam.groundToWorld(u, v, new THREE.Vector3()).setY(level.heightAt(u, v) || 0));

    this.hud = new Hud(host, `${import.meta.env.BASE_URL}hud/`);
    if (import.meta.env.DEV) this.devTools(level);
    this.input.on('KeyH', () => !this.locked && this.hud.toggle());
    this.input.on('KeyE', () => (this.castPressed = true));
    this.input.on('KeyC', () => (this.slidePressed = true));
    this.input.on('KeyM', () => (config.audio.muted = !config.audio.muted));

    this.renderer.domElement.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.locked) return;
      const z = THREE.MathUtils.clamp(config.camera.zoom * Math.exp(-e.deltaY * 0.0012), config.camera.zoomMin, config.camera.zoomMax);
      config.camera.zoom = z;
      this.cam.setZoom(z);
    }, { passive: false });

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /**
   * Ferramentas de desenvolvimento, fora da tela do jogo: a tecla à esquerda do 1
   * (' no ABNT2, ` no US) mostra o painel de ajustes e a leitura de estado.
   */
  private devTools(level: Level) {
    const gui = createDebugPanel(config, this.demo, {
      derived: this.derived,
      onZoom: (z) => this.cam.setZoom(z),
      onAnchor: (on) => this.character.setAnchorDebug(on),
      onDemo: () => {
        this.demo.restart();
        this.character.setLevel(level, level.spawn.u, level.spawn.v);
      },
      onOcclusion: (on) => (occlusionShared.occEnabled.value = on ? 1 : 0),
      onWalkable: (on) => void this.island?.setOverlay(level, this.cam, on),
      onFog: () => this.sea?.setFog(config.sea.fogStart, config.sea.fogEnd, config.sea.fogBack),
    });
    gui.hide();
    this.input.on('Backquote', () => {
      const show = gui._hidden;
      gui.show(show);
      this.hud.showStatus(show);
    });
  }

  /** Ilha (pintura ampliada), mar com neblina e oclusão. */
  private async buildWorld() {
    const lv = this.level;
    const waterTex = await new THREE.TextureLoader().loadAsync(lv.baseUrl + lv.meta.water.file);
    waterTex.wrapS = waterTex.wrapT = THREE.RepeatWrapping;
    waterTex.colorSpace = THREE.SRGBColorSpace;
    setupOcclusion({
      map: lv.depthTexture, rect: lv.meta.screenRect, keyMin: lv.meta.depth.keyMin, keyMax: lv.meta.depth.keyMax,
      right: this.cam.right, screenUp: this.cam.screenUp, bias: config.level.occlusionBias,
    });
    occlusionShared.occEnabled.value = config.level.occlusion ? 1 : 0;
    this.island = await Island.create(lv, this.cam, waterTex, config.sea.tile);
    this.sea = new Sea(waterTex, lv.meta.fog, {
      tile: config.sea.tile, fogStart: config.sea.fogStart, fogEnd: config.sea.fogEnd, fogBack: config.sea.fogBack,
      fogColor: new THREE.Color(config.sea.fogColor),
    }, this.cam, lv.meta.water.height);
    this.scene.add(this.sea.mesh, this.island.group);
    if (config.level.showWalkable) await this.island.setOverlay(lv, this.cam, true);
  }

  start() {
    this.timer.connect(document);
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  /**
   * Trava o jogo enquanto a apresentação está na tela: a personagem fica parada (as teclas
   * não a movem), o HUD some e a trilha abaixa para as falas.
   */
  lock(on: boolean) {
    this.locked = on;
    this.hud.conceal(on);
    this.audio.duck(on);
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.renderer.setSize(w, h);
    this.cam.resize(w, h);
  }

  /** Converte ciclo (s) + passada (m) da config em velocidades — passada × cadência = velocidade. */
  private updateParams() {
    const L = config.locomotion, p = this.params, d = this.derived;
    d.walkStride = config.walk.strideOverride ?? this.atlas.strideMeters('walk');
    d.runStride = config.run.strideOverride ?? this.atlas.strideMeters('run');
    d.walkSpeed = +(d.walkStride / config.walk.cycleSeconds).toFixed(2);
    d.runSpeed = +(d.runStride / config.run.cycleSeconds).toFixed(2);
    Object.assign(p, {
      walkSpeed: d.walkSpeed, runSpeed: d.runSpeed, walkStride: d.walkStride, runStride: d.runStride,
      accel: L.accel, decel: L.decel, turnRate: THREE.MathUtils.degToRad(L.turnRateDeg),
      settleRate: L.settleRate, stopSpeed: L.stopSpeed,
    });
  }

  private castParams(): CastParams {
    const f = config.fireball;
    return { pre: f.castPre, post: f.castPost, cancelAfter: f.cancelAfter, heldFps: f.heldFps, heldScale: f.heldScale };
  }

  private slideParams(): SlideParams {
    return { ...config.slide, runCycleSeconds: config.run.cycleSeconds };
  }

  private characterParams(): CharacterParams {
    return { loco: this.params, cast: this.castParams(), slide: this.slideParams(), idle: config.idle, terrain: config.terrain };
  }

  private explosionParams(): ExplosionParams {
    return { fps: config.fireball.impactFps, scale: config.fireball.impactScale };
  }

  private fireballParams(): FireballParams {
    const f = config.fireball;
    return { speed: f.speed, range: f.range, fps: f.flightFps, fadeSeconds: f.fadeSeconds };
  }

  private frame(time: number) {
    this.timer.update(time);
    // Limita o passo para não "teletransportar" depois de uma aba em segundo plano.
    const dt = Math.min(this.timer.getDelta(), 1 / 20) * config.debug.timeScale;

    this.updateParams();
    const input = this.locked ? Game.STILL : this.demo.active ? this.demo.update(dt) : this.input.read();
    const actions = this.locked
      ? { cast: false, slide: false }
      : this.demo.active
        ? { cast: this.demo.cast, slide: this.demo.slide }
        : { cast: this.castPressed, slide: this.slidePressed };
    this.castPressed = this.slidePressed = false;
    this.character.update(dt, input, actions, this.characterParams(), this.cam);
    this.fireballs?.update(dt, this.fireballParams(), (pos, v, lvl) => {
      const s = this.cam.screenOf(pos);
      return this.level.projectileHit(s.x, s.y, pos.dot(this.cam.right), v, lvl, config.level.occlusionBias);
    });
    this.explosions?.update(dt, this.explosionParams());
    this.dust?.update(dt, config.dust);
    this.audio.update(dt, this.character, config.audio, this.params);
    this.cam.follow(this.character.position, config.camera.follow, dt);
    const t = this.timer.getElapsed();
    this.island.update(t);
    this.sea.update(t, this.cam.target, this.cam.groundViewRadius);
    this.hud.update(this.timer.getDelta(), this.character);

    this.renderer.render(this.scene, this.cam.camera);
  }
}
