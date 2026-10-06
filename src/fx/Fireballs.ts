import * as THREE from 'three';
import type { IsoCamera } from '../core/IsoCamera';
import { createSpriteMaterial } from '../sprites/SpriteMaterial';
import { createGlowTexture, type FxAtlas } from './FxAtlas';

export interface FireballParams {
  /** m/s */
  speed: number;
  /** Metros até começar a dissipar. */
  range: number;
  /** Quadros/s da chama em voo. */
  fps: number;
  /** Duração da dissipação (s). */
  fadeSeconds: number;
}

export interface FireballSpawn {
  /** Ponto de mundo onde a bola sai da mão. */
  position: THREE.Vector3;
  /** Direção horizontal (unitária) no chão. */
  direction: THREE.Vector3;
  /** Metros de mundo por px do atlas de efeito. */
  scale: number;
  /** Nível de oclusão de quem lançou (o projétil voa nessa camada). */
  level: number;
  /** Altura do chão sob a mão de quem lançou (luz no chão). */
  groundY: number;
}

/**
 * Colisão com o cenário: posição no mundo, profundidade v e nível → chave de profundidade
 * da superfície atingida, ou null se não bateu.
 */
export type ProjectileHit = (pos: THREE.Vector3, v: number, level: number) => number | null;

/** A bola bateu em algo (em vez de se dissipar no fim do alcance). */
export interface FireballImpact {
  /** O mesmo id devolvido por spawn(). */
  id: number;
  /** Ponto de contato no mundo. */
  position: THREE.Vector3;
  /** Rumo na tela (rad, y para cima). */
  heading: number;
  /** Raio da bola (m). */
  ballRadius: number;
  /** Chave de profundidade da superfície atingida. */
  occKey: number;
  level: number;
  groundY: number;
}

interface Ball {
  id: number;
  root: THREE.Group;
  sprite: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  glow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  light: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  dir: THREE.Vector3;
  scale: number;
  t: number;
  traveled: number;
  fading: number;
  seed: number;
  level: number;
  groundY: number;
  /** Rumo na tela (rad, y para cima). */
  heading: number;
}

/**
 * Projéteis de bola de fogo. O sprite de voo aponta para +x da tela e é girado no plano
 * da tela para a direção real do disparo (projetada pela câmera), então qualquer ângulo
 * — inclusive as diagonais 2:1 do isométrico — fica coerente com uma única linha de arte.
 * No fim do alcance a bola se dissipa; batendo em algo, some e dispara `onImpact`.
 */
export class Fireballs {
  readonly group = new THREE.Group();
  private readonly balls: Ball[] = [];
  private readonly glowTex = createGlowTexture();
  private readonly lightTex = createGlowTexture('rgba(255,140,40,0.9)', 'rgba(230,70,10,0.3)');
  private readonly glowGeo = new THREE.PlaneGeometry(1, 1);
  private readonly lightGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private readonly rot = new THREE.Quaternion();
  private readonly zAxis = new THREE.Vector3(0, 0, 1);
  private nextId = 1;
  /** A bola bateu: o efeito de explosão fica com quem ouve. */
  onImpact: ((e: FireballImpact) => void) | null = null;

  constructor(private readonly fx: FxAtlas, private readonly cam: IsoCamera) {}

  get count() {
    return this.balls.length;
  }

  /** Lança uma bola; devolve o id que volta em onImpact. */
  spawn(s: FireballSpawn) {
    const camQ = this.cam.camera.quaternion;
    // Ângulo na tela: projeção da direção nos eixos da câmera (a vertical do chão sai encurtada).
    const sx = s.direction.dot(this.cam.right);
    const sy = s.direction.dot(this.cam.screenUp);
    const sprite = new THREE.Mesh(this.fx.geometry, createSpriteMaterial());
    sprite.material.uniforms.map.value = this.fx.texture;
    const heading = Math.atan2(sy, sx);
    sprite.quaternion.copy(camQ).multiply(this.rot.setFromAxisAngle(this.zAxis, heading));
    sprite.scale.setScalar(s.scale);
    sprite.renderOrder = 10;

    const glowMat = new THREE.MeshBasicMaterial({
      map: this.glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Mesh(this.glowGeo, glowMat);
    glow.quaternion.copy(camQ);
    glow.renderOrder = 9;

    const light = new THREE.Mesh(this.lightGeo, new THREE.MeshBasicMaterial({
      map: this.lightTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    light.renderOrder = 6;

    const root = new THREE.Group();
    root.position.copy(s.position);
    root.add(sprite, glow);
    this.group.add(root, light);
    const id = this.nextId++;
    this.balls.push({
      id, root, sprite, glow, light, dir: s.direction.clone(), scale: s.scale,
      t: 0, traveled: 0, fading: -1, seed: Math.random() * 10, level: s.level, groundY: s.groundY, heading,
    });
    sprite.material.uniforms.occLevel.value = s.level;
    return id;
  }

  update(dt: number, p: FireballParams, hit?: ProjectileHit) {
    const m = this.fx.manifest;
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      b.t += dt;
      const speed = b.fading < 0 ? p.speed : p.speed * 0.3;
      const step = speed * dt;
      b.root.position.addScaledVector(b.dir, step);
      b.traveled += step;
      const v = b.root.position.dot(this.cam.upGround);
      b.sprite.material.uniforms.occKey.value = v;
      // Bateu em penhasco/rocha/tronco: explode ali (no fim do alcance, só se dissipa).
      if (b.fading < 0 && hit && hit(b.root.position, v, b.level) !== null) {
        this.impact(b, step, hit);
        this.remove(i);
        continue;
      }
      if (b.fading < 0 && b.traveled >= p.range) b.fading = 0;

      let cell: number;
      let fade = 1;
      if (b.fading < 0) {
        cell = m.flight.loop[Math.floor(b.t * p.fps) % m.flight.loop.length];
      } else {
        b.fading += dt / p.fadeSeconds;
        if (b.fading >= 1) {
          this.remove(i);
          continue;
        }
        const k = m.flight.dissipate;
        cell = k[Math.min(k.length - 1, Math.floor(b.fading * k.length))];
        fade = 1 - b.fading;
      }
      this.fx.uvRect(cell, b.sprite.material.uniforms.uvRect.value);

      // Brilho tremulando + luz no chão logo abaixo da bola.
      const flicker = 0.85 + 0.15 * Math.sin(b.t * 31 + b.seed) * Math.sin(b.t * 17 + b.seed * 2);
      const ballWorld = m.flight.ballRadius * b.scale;
      b.glow.scale.setScalar(ballWorld * 7 * (0.9 + 0.1 * flicker));
      b.glow.material.opacity = 0.55 * flicker * fade;
      b.light.position.set(b.root.position.x, b.groundY + 0.004, b.root.position.z);
      b.light.scale.setScalar(ballWorld * 10);
      b.light.material.opacity = 0.32 * flicker * fade;
    }
  }

  /**
   * Ponto de contato: o teste só pega a bola já dentro da superfície (anda ~18 cm por frame);
   * bissecção no último passo acha onde ela tocou (precisão de ~3 mm).
   */
  private impact(b: Ball, step: number, hit: ProjectileHit) {
    const a = b.root.position.clone().addScaledVector(b.dir, -step), z = b.root.position.clone();
    const mid = new THREE.Vector3();
    let key = hit(z, z.dot(this.cam.upGround), b.level)!;
    for (let k = 0; k < 6; k++) {
      mid.lerpVectors(a, z, 0.5);
      const h = hit(mid, mid.dot(this.cam.upGround), b.level);
      if (h === null) a.copy(mid);
      else { z.copy(mid); key = h; }
    }
    const m = this.fx.manifest;
    this.onImpact?.({
      id: b.id, position: z, heading: b.heading, ballRadius: m.flight.ballRadius * b.scale,
      occKey: key, level: b.level, groundY: b.groundY,
    });
  }

  private remove(i: number) {
    const b = this.balls[i];
    this.group.remove(b.root, b.light);
    b.sprite.material.dispose();
    b.glow.material.dispose();
    b.light.material.dispose();
    this.balls.splice(i, 1);
  }
}
