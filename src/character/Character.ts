import * as THREE from 'three';
import type { IsoCamera } from '../core/IsoCamera';
import type { FxAtlas } from '../fx/FxAtlas';
import type { Level } from '../level/Level';
import { createShadowMaterial, createSpriteMaterial } from '../sprites/SpriteMaterial';
import type { ActionDirection, FirePoint, LoadedAction, SpriteAtlas } from '../sprites/SpriteAtlas';
import { CastState, type CastTiming } from './Cast';
import { DIRECTIONS, angleToDirIndex, dirIndexToAngle, vecToAngle, type DirName } from './directions';
import { Locomotion, type LocoParams, type MoveInput } from './Locomotion';
import { SlideState, type SlideTiming } from './Slide';

/** O que está sendo exibido neste frame (para HUD/debug). */
export interface DisplayInfo {
  action: string;
  dir: DirName;
  /** Posição no laço/sequência e tamanho. */
  loopIndex: number;
  loopLength: number;
  /** Célula no atlas. */
  column: number;
}

export interface CastParams extends CastTiming {
  /** Fps da chama segurada na mão. */
  heldFps: number;
  /** Multiplicador do tamanho da chama na mão em relação à bola desenhada na arte. */
  heldScale: number;
}

export interface IdleParams {
  breathAmplitude: number;
  breathPeriod: number;
}

export interface SlideParams extends Omit<SlideTiming, 'approachFrame'> {
  /** Segundos de um ciclo da corrida (dá a cadência dos frames de entrada). */
  runCycleSeconds: number;
  /** Espera mínima entre deslizes (s). */
  cooldown: number;
  /** Metros entre nuvens de poeira no chão. */
  dustSpacing: number;
}

export interface TerrainParams {
  /** Raio dos pés para colisão (m). */
  radius: number;
  /** Maior desnível vencido de um passo para o outro (m). */
  maxStep: number;
}

export interface CharacterParams {
  loco: LocoParams;
  cast: CastParams;
  slide: SlideParams;
  idle: IdleParams;
  terrain: TerrainParams;
}

/** Ações de toque único pedidas neste frame. */
export interface ActionInput {
  cast: boolean;
  slide: boolean;
}

export interface ReleaseEvent {
  /** Ponto de mundo da mão no frame de soltura. */
  position: THREE.Vector3;
  /** Direção horizontal (unitária) no chão. */
  direction: THREE.Vector3;
  /** Raio típico da bola desenhada na arte, em metros. */
  radius: number;
  /** Nível de oclusão de quem lançou. */
  level: number;
}

export interface DustEvent {
  position: THREE.Vector3;
  level: number;
  dir: DirName;
  kind: 'trail' | 'burst';
  side: number;
  scale: number;
}

const CAST = 'cast';
const SLIDE = 'slide';
const RUN = 'run';

/**
 * Personagem: billboard voltado para a câmera, ancorado nos pés, + sombra no chão.
 * Escolhe ação/direção/frame a partir do estado da locomoção, da conjuração ou do deslize.
 */
export class Character {
  readonly root = new THREE.Group();
  readonly loco = new Locomotion();
  readonly cast = new CastState();
  readonly slide = new SlideState();
  readonly display: DisplayInfo = { action: 'walk', dir: 's', loopIndex: 0, loopLength: 1, column: 0 };
  /** Disparado quando a bola sai da mão. */
  onRelease: ((e: ReleaseEvent) => void) | null = null;
  /** Poeira levantada pelo deslize. */
  onDust: ((e: DustEvent) => void) | null = null;
  /** Começou um deslize; o corpo toca o chão daqui a `toContact` s. */
  onSlideStart: ((toContact: number) => void) | null = null;
  private readonly sprite: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly held: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private current: LoadedAction | null = null;
  /** Último lado (−1 esquerda, +1 direita) pressionado — decide SE/SO quando não há arte para S. */
  private lastSide = 1;
  private heldTime = 0;
  /** Tempo parado na pose de idle (a respiração começa do zero a cada parada). */
  private idleTime = 0;
  /** Deslize pedido esperando o pé da corrida encaixar com o 1º frame do deslize. */
  private slidePending: { target: number; frame: number; dir: DirName; wait: number } | null = null;
  private slideCooldown = 0;
  private dustDistance = 0;
  private level: Level | null = null;
  /** Altura do chão sob os pés (lógica) e a exibida (degraus suavizados). */
  private h = 0;
  private hVis = 0;
  /** Nível de oclusão atual (terraço). */
  occLevel = 1;

  constructor(private readonly atlas: SpriteAtlas, camera: IsoCamera, private readonly fx: FxAtlas | null) {
    const idle = atlas.get(atlas.manifest.idleAction);
    this.sprite = new THREE.Mesh(idle.geometry, createSpriteMaterial());
    this.sprite.quaternion.copy(camera.camera.quaternion);
    this.sprite.renderOrder = 10;
    this.sprite.frustumCulled = false;

    this.held = new THREE.Mesh(fx?.geometry ?? new THREE.PlaneGeometry(), createSpriteMaterial());
    this.held.material.uniforms.map.value = fx?.texture ?? null;
    this.held.quaternion.copy(camera.camera.quaternion);
    this.held.renderOrder = 11; // a mão está sempre à frente do corpo na arte
    this.held.visible = false;
    this.held.frustumCulled = false;

    this.shadow = createBlobShadow(0.42);
    this.root.add(this.shadow, this.sprite, this.held);
  }

  get position() {
    return this.root.position;
  }

  /** Coloca a personagem num cenário, no ponto (u, v) do chão. */
  setLevel(level: Level, u: number, v: number) {
    this.level = level;
    this.loco.reset(u, v);
    this.h = this.hVis = level.heightAt(u, v) || 0;
    this.occLevel = level.levelAt(u, v, this.h);
  }

  get height() {
    return this.h;
  }

  /** Terreno sob os pés (para o HUD). */
  get terrain() {
    const r = this.level?.regionAt(this.loco.x, this.loco.y);
    if (!r) return null;
    if (!r.ramp?.steps) return { id: r.id, step: 0, steps: 0 };
    const t = (this.h - r.ramp.h0) / (r.ramp.h1 - r.ramp.h0);
    return { id: r.id, step: Math.round(Math.min(1, Math.max(0, t)) * r.ramp.steps), steps: r.ramp.steps };
  }

  get canCast() {
    return this.atlas.has(CAST);
  }

  /** Só desliza correndo (ação de corrida, em movimento, sem outra ação em curso). */
  get canSlide() {
    return this.atlas.has(SLIDE) && !this.cast.active && !this.slide.active && this.slideCooldown <= 0
      && this.loco.state === 'move' && this.loco.action === RUN;
  }

  update(dt: number, input: MoveInput, actions: ActionInput, p: CharacterParams, camera: IsoCamera) {
    if (input.x !== 0) this.lastSide = Math.sign(input.x);
    const moving = input.x !== 0 || input.y !== 0;
    this.slideCooldown -= dt;

    if (actions.slide && this.canSlide && !this.slidePending) this.requestSlide(p);
    if (actions.cast && this.canCast && !this.slide.active && !this.slidePending) {
      if (!this.cast.active || this.cast.canInterrupt(p.cast)) this.startCast(input);
      else this.cast.queued = true;
    }
    if (this.cast.active) {
      const ev = this.cast.update(dt, p.cast);
      if (ev.released) this.release(camera);
      if (this.cast.canInterrupt(p.cast) && this.cast.queued) this.startCast(input);
      else if (ev.done || (moving && this.cast.canInterrupt(p.cast))) this.cast.stop();
    }

    if (this.slide.active) this.updateSlide(dt, input, p, camera);
    else if (!this.cast.active) {
      const lv = this.level;
      if (lv) p.loco.speedScale = lv.speedAt(this.loco.x, this.loco.y);
      this.loco.update(dt, input, p.loco, lv ? this.resolver(p.terrain) : undefined);
      this.checkSlidePending(dt, p);
    }

    this.updateHeight();
    camera.groundToWorld(this.loco.x, this.loco.y, this.root.position);
    this.root.position.y = this.hVis;
    this.applyFrame(dt, p.cast, camera);
    this.breathe(dt, p.idle);
    this.updateShadow(camera);
    this.updateOcclusion();
  }

  private resolver(t: TerrainParams) {
    return (x: number, y: number, dx: number, dy: number) => this.level!.move(x, y, this.h, dx, dy, t.radius, t.maxStep);
  }

  /** Altura do terreno; nas escadas a exibida acompanha cada degrau (ver Level.displayHeight). */
  private updateHeight() {
    const lv = this.level;
    if (!lv) return;
    const h = lv.heightAt(this.loco.x, this.loco.y);
    if (!Number.isNaN(h)) this.h = h;
    this.hVis = lv.displayHeight(this.loco.x, this.loco.y, this.h).h;
    this.occLevel = lv.levelAt(this.loco.x, this.loco.y, this.h);
  }

  /** Chave de oclusão = profundidade (v) dos pés; vale para corpo, sombra e chama na mão. */
  private updateOcclusion() {
    for (const m of [this.sprite.material, this.held.material, this.shadow.material]) {
      m.uniforms.occKey.value = this.loco.y;
      m.uniforms.occLevel.value = this.occLevel;
    }
  }

  /** Respiração sutil na pose parada: escala vertical ancorada nos pés. */
  private breathe(dt: number, ip: IdleParams) {
    const idle = !this.cast.active && !this.slide.active && this.loco.state === 'idle';
    this.idleTime = idle ? this.idleTime + dt : 0;
    const k = idle ? Math.sin((this.idleTime / ip.breathPeriod) * Math.PI * 2) : 0;
    this.sprite.scale.y = 1 + ip.breathAmplitude * k;
  }

  setAnchorDebug(on: boolean) {
    this.sprite.material.uniforms.anchorDebug.value = on ? 1 : 0;
  }

  /** Direção sem arte própria (apelido) → vizinha com arte, do lado pressionado por último. */
  private resolveDir(action: string, index: number): DirName {
    const dirs = this.atlas.get(action).data.directions;
    const dir = DIRECTIONS[index];
    if (!dirs[dir].aliasOf) return dir;
    const a = DIRECTIONS[(index + 1) % 8], b = DIRECTIONS[(index + 7) % 8];
    const side = (d: DirName) => Math.sign(Math.round(Math.sin(dirIndexToAngle(DIRECTIONS.indexOf(d))) * 1000));
    const candidates = [a, b].filter((d) => !dirs[d].aliasOf);
    return candidates.find((d) => side(d) === this.lastSide) ?? candidates[0] ?? dirs[dir].aliasOf!;
  }

  // -------------------------------------------------------------------------
  // Deslize

  /**
   * Encaixe de pé: a tabela do pipeline diz, para a posição atual da passada, quantos frames
   * da corrida esperar (0–2, ≤ ~70 ms) e em qual frame do deslize entrar — a pose de saída
   * da corrida e a de entrada do deslize ficam o mais parecidas possível.
   */
  private requestSlide(p: CharacterParams) {
    const dir = this.resolveDir(SLIDE, angleToDirIndex(this.loco.facing));
    const entry = this.atlas.get(SLIDE).data.directions[dir].slide!.entry;
    const j = Math.floor(this.loco.phase * entry.length) % entry.length;
    const [wait, frame] = entry[j];
    if (wait === 0) this.startSlide(dir, frame, p);
    else this.slidePending = { target: (j + wait) % entry.length, frame, dir, wait: 0 };
  }

  private checkSlidePending(dt: number, p: CharacterParams) {
    const s = this.slidePending;
    if (!s) return;
    s.wait += dt;
    if (this.loco.state !== 'move' || this.loco.action !== RUN) { this.slidePending = null; return; }
    const len = this.atlas.get(SLIDE).data.directions[s.dir].slide!.entry.length;
    const j = Math.floor(this.loco.phase * len) % len;
    if (j === s.target || s.wait > 2.5 * (p.slide.runCycleSeconds / len)) this.startSlide(s.dir, s.frame, p);
  }

  private startSlide(dir: DirName, frame: number, p: CharacterParams) {
    this.slidePending = null;
    const d = this.atlas.get(SLIDE).data.directions[dir];
    // Direção do movimento = a da corrida (contínua); o sprite usa a direção com arte.
    this.slide.start(dir, this.loco.facing, d.slide!, d.frames.length, frame, this.loco.speed);
    this.dustDistance = 0;
    this.onSlideStart?.(Math.max(0, d.slide!.contact - frame) * this.approachFrame(dir, p));
  }

  /** Segundos por frame na entrada do deslize: a cadência da corrida. */
  private approachFrame(dir: DirName, p: CharacterParams) {
    return p.slide.runCycleSeconds / this.atlas.get(RUN).data.directions[dir].frames.length;
  }

  private updateSlide(dt: number, input: MoveInput, p: CharacterParams, camera: IsoCamera) {
    const s = this.slide;
    const wantsMove = input.x !== 0 || input.y !== 0;
    const moveSpeed = input.run ? p.loco.runSpeed : p.loco.walkSpeed;
    const ev = s.update(dt, { ...p.slide, approachFrame: this.approachFrame(s.dir, p) }, wantsMove, moveSpeed);

    let dist = s.speed * dt;
    const du = Math.sin(s.angle) * dist, dv = Math.cos(s.angle) * dist;
    if (this.level) {
      const r = this.level.move(this.loco.x, this.loco.y, this.h, du, dv, p.terrain.radius, p.terrain.maxStep);
      this.loco.x = r.u;
      this.loco.y = r.v;
      // Bateu de frente numa barreira deslizando: perde o embalo (de raspão, escorrega).
      if (r.moved < 0.3 * dist) s.speed *= Math.exp(-14 * dt);
      dist = r.moved;
    } else {
      this.loco.x += du;
      this.loco.y += dv;
    }

    const side = Math.sign(Math.sin(s.angle)) || this.lastSide;
    if (ev.contact) {
      // Impacto: estouro de partículas + primeira nuvem do rastro.
      this.emitDust(camera, 'burst', side, 1.0);
      this.emitDust(camera, 'trail', side, 1.0);
      this.dustDistance = 0;
    } else if (s.grounded) {
      this.dustDistance += dist;
      if (this.dustDistance >= p.slide.dustSpacing) {
        this.dustDistance -= p.slide.dustSpacing;
        this.emitDust(camera, 'trail', side, 0.5 + 0.5 * Math.min(1, s.speed / s.peakSpeed));
      }
    }
    if (ev.pushOff) this.emitDust(camera, 'trail', side, 0.45);

    if (ev.exit) {
      const facing = dirIndexToAngle(DIRECTIONS.indexOf(s.dir));
      if (ev.exit === 'idle') this.loco.halt(facing);
      else this.loco.resume(facing, s.speed, s.exitPhase);
      s.stop();
      this.slideCooldown = p.slide.cooldown;
    }
  }

  private emitDust(camera: IsoCamera, kind: 'trail' | 'burst', side: number, scale: number) {
    if (!this.onDust) return;
    const position = camera.groundToWorld(this.loco.x, this.loco.y, new THREE.Vector3());
    position.y = this.hVis;
    this.onDust({ position, level: this.occLevel, dir: this.slide.dir, kind, side, scale });
  }

  /** Sombra: alonga na direção do movimento quando o corpo está deitado. */
  private updateShadow(camera: IsoCamera) {
    const lie = this.slide.active ? this.slide.lie : 0;
    if (lie <= 0) {
      this.shadow.scale.set(1, 1, 1);
      return;
    }
    const a = this.slide.angle;
    const dir = camera.groundToWorld(Math.sin(a), Math.cos(a), new THREE.Vector3());
    this.shadow.rotation.y = Math.atan2(-dir.z, dir.x);
    this.shadow.scale.set(1 + 1.4 * lie, 1, 1 - 0.15 * lie);
  }

  // -------------------------------------------------------------------------
  // Conjuração

  /** Mira: direção pressionada no momento do E, senão para onde já está virada. */
  private startCast(input: MoveInput) {
    const moving = input.x !== 0 || input.y !== 0;
    const angle = moving ? vecToAngle(input.x, input.y) : this.loco.facing;
    const dir = this.resolveDir(CAST, angleToDirIndex(angle));
    const d = this.castData(dir);
    this.loco.halt(dirIndexToAngle(DIRECTIONS.indexOf(dir)));
    this.cast.start(dir, d.frames.length, d.release ?? Math.floor(d.frames.length / 2));
    this.heldTime = 0;
  }

  private castData(dir: DirName): ActionDirection {
    return this.atlas.get(CAST).data.directions[dir];
  }

  private release(camera: IsoCamera) {
    const d = this.castData(this.cast.dir);
    const fire = d.fire ?? [];
    const rel = d.release ?? 0;
    // Posição da bola no frame de soltura (ou a última na mão, se a arte não a mostrar).
    let fp: FirePoint | null = fire[rel] ?? null;
    for (let k = rel; !fp && k >= 0; k--) fp = fire[k] ?? null;
    const ppm = this.atlas.pxPerMeter;
    const [x, y, r] = fp ?? [0, this.atlas.get(CAST).data.height * 0.55, 15];
    const position = camera.addBillboardOffset(this.root.position.clone(), x / ppm, y / ppm);
    const a = this.loco.facing;
    const direction = camera.groundToWorld(Math.sin(a), Math.cos(a), new THREE.Vector3()).normalize();
    // Tamanho: raio típico da bola na mão (o do frame de soltura pode ser só um rastro).
    this.onRelease?.({ position, direction, radius: (d.ballRadius ?? r) / ppm, level: this.occLevel });
  }

  // -------------------------------------------------------------------------
  // Exibição

  private applyFrame(dt: number, cp: CastParams, camera: IsoCamera) {
    const loco = this.loco;
    let name: string, dir: DirName, k: number, d: ActionDirection;
    if (this.cast.active) {
      name = CAST;
      dir = this.cast.dir;
      d = this.castData(dir);
      k = this.cast.frame;
    } else if (this.slide.active) {
      name = SLIDE;
      dir = this.slide.dir;
      d = this.atlas.get(SLIDE).data.directions[dir];
      k = this.slide.frame;
    } else {
      // Empurrando uma parede: fica na pose parada, virada para ela.
      const pushing = loco.state === 'move' && loco.pushing;
      name = loco.state === 'idle' || pushing ? this.atlas.manifest.idleAction : loco.action;
      dir = DIRECTIONS[angleToDirIndex(loco.facing)];
      d = this.atlas.get(name).data.directions[dir];
      // Fase 0 e 0,5 caem nas duas poses de passagem do laço (idle usa uma delas).
      k = pushing ? 0 : Math.floor(loco.phase * d.frames.length + 1e-6) % d.frames.length;
    }

    const action = this.atlas.get(name);
    if (action !== this.current) {
      this.current = action;
      this.sprite.geometry = action.geometry;
      const u = this.sprite.material.uniforms;
      u.map.value = action.texture;
      const [cw, ch] = action.data.cell, [ax, ay] = action.data.anchor;
      u.anchorUv.value.set(ax / cw, 1 - ay / ch);
    }
    const cell = d.frames[k];
    this.atlas.uvRect(action, cell, this.sprite.material.uniforms.uvRect.value);
    Object.assign(this.display, { action: name, dir, loopIndex: k, loopLength: d.frames.length, column: cell });

    this.updateHeld(dt, cp, camera, d, k);
  }

  /** Chama na mão: onde a arte tinha a bola desenhada, até a soltura. */
  private updateHeld(dt: number, cp: CastParams, camera: IsoCamera, d: ActionDirection, k: number) {
    const fp = this.cast.active && !this.cast.released ? d.fire?.[k] : null;
    this.held.visible = !!fp && !!this.fx;
    if (!fp || !this.fx) return;
    this.heldTime += dt;
    const ppm = this.atlas.pxPerMeter;
    const clip = this.fx.manifest.held;
    this.held.position.set(0, 0, 0);
    camera.addBillboardOffset(this.held.position, fp[0] / ppm, fp[1] / ppm);
    // Bola do sprite (ballRadius px de efeito) com o raio da bola da arte (fp[2] px do atlas),
    // limitado a pouco acima da bola típica (a arte tem clarões de carga bem maiores).
    const r = Math.min(fp[2], (d.ballRadius ?? fp[2]) * 1.15);
    this.held.scale.setScalar((r * cp.heldScale) / clip.ballRadius / ppm);
    const cell = clip.loop[Math.floor(this.heldTime * cp.heldFps) % clip.loop.length];
    this.fx.uvRect(cell, this.held.material.uniforms.uvRect.value);
  }
}

function createBlobShadow(radius: number): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.32)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2).rotateX(-Math.PI / 2), createShadowMaterial(tex));
  mesh.position.y = 0.002;
  mesh.renderOrder = 5;
  return mesh;
}
