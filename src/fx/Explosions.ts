import * as THREE from 'three';
import type { IsoCamera } from '../core/IsoCamera';
import { anchoredPlane, cellUv, loadSpriteTexture } from '../sprites/SpriteAtlas';
import { createSpriteMaterial } from '../sprites/SpriteMaterial';
import { createGlowTexture } from './FxAtlas';

/** Formato gerado por tools/sprites/explosion.ts. */
export interface ExplosionManifest {
  image: string;
  cell: [number, number];
  /** Núcleo da explosão (ponto de contato) dentro da célula. */
  anchor: [number, number];
  grid: [number, number];
  /** Raio da bola chegando, em px do atlas: régua de tamanho. */
  ballRadius: number;
  /** Uma linha por direção: rumo da bola na tela (rad, y para cima) e frames. */
  rows: { dir: string; heading: number; source: string; frames: number[] }[];
}

export interface ExplosionParams {
  /** Quadros/s. */
  fps: number;
  /** Tamanho em relação à bola que bateu (1 = bola da sheet do tamanho da bola do jogo). */
  scale: number;
}

export interface ExplosionSpawn {
  /** Ponto de contato no mundo. */
  position: THREE.Vector3;
  /** Rumo da bola na tela (rad, y para cima). */
  heading: number;
  /** Raio da bola que bateu (m). */
  ballRadius: number;
  /** Chave de oclusão: a explosão some só atrás do que tiver chave menor (ver Level.frontKey). */
  occKey: number;
  level: number;
  /** Altura do chão sob a bola (luz no chão). */
  groundY: number;
}

interface Blast {
  sprite: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  glow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  light: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  frames: number[];
  ballRadius: number;
  t: number;
}

export class ExplosionAtlas {
  readonly geometry: THREE.PlaneGeometry;

  private constructor(readonly manifest: ExplosionManifest, readonly texture: THREE.Texture) {
    this.geometry = anchoredPlane(manifest.cell, manifest.anchor, 1);
  }

  static async load(url: string): Promise<ExplosionAtlas> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`explosão não encontrada em ${url} (rode "npm run sprites")`);
    const manifest = (await res.json()) as ExplosionManifest;
    const base = url.slice(0, url.lastIndexOf('/') + 1);
    return new ExplosionAtlas(manifest, await loadSpriteTexture(base + manifest.image));
  }
}

const angDist = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/**
 * Explosões da bola de fogo ao bater: toca a linha desenhada para o rumo mais próximo
 * (sem girar o sprite) com o núcleo no ponto de contato, mais um clarão aditivo e a luz
 * no chão, que somem junto com a explosão.
 */
export class Explosions {
  readonly group = new THREE.Group();
  private readonly blasts: Blast[] = [];
  private readonly glowTex = createGlowTexture('rgba(255,225,150,1)', 'rgba(255,120,30,0.5)');
  private readonly lightTex = createGlowTexture('rgba(255,140,40,0.9)', 'rgba(230,70,10,0.3)');
  private readonly glowGeo = new THREE.PlaneGeometry(1, 1);
  private readonly lightGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  constructor(private readonly atlas: ExplosionAtlas, private readonly cam: IsoCamera) {}

  get count() {
    return this.blasts.length;
  }

  /** Quanto a explosão ocupa na tela (m) em volta do ponto de contato. */
  extent(ballRadius: number, p: ExplosionParams) {
    const m = this.atlas.manifest, k = (ballRadius / m.ballRadius) * p.scale;
    const [cw, ch] = m.cell, [ax, ay] = m.anchor;
    return { left: ax * k, right: (cw - ax) * k, up: ay * k, down: (ch - ay) * k };
  }

  spawn(s: ExplosionSpawn, p: ExplosionParams) {
    const m = this.atlas.manifest;
    const row = m.rows.reduce((best, r) => (angDist(r.heading, s.heading) < angDist(best.heading, s.heading) ? r : best));
    const sprite = new THREE.Mesh(this.atlas.geometry, createSpriteMaterial());
    const u = sprite.material.uniforms;
    u.map.value = this.atlas.texture;
    u.occKey.value = s.occKey;
    u.occLevel.value = s.level;
    sprite.quaternion.copy(this.cam.camera.quaternion);
    sprite.scale.setScalar((s.ballRadius / m.ballRadius) * p.scale); // m por px do atlas
    sprite.position.copy(s.position);
    sprite.renderOrder = 10;

    const glow = new THREE.Mesh(this.glowGeo, new THREE.MeshBasicMaterial({
      map: this.glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    glow.quaternion.copy(this.cam.camera.quaternion);
    glow.position.copy(s.position);
    glow.renderOrder = 9;
    const light = new THREE.Mesh(this.lightGeo, new THREE.MeshBasicMaterial({
      map: this.lightTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    light.position.set(s.position.x, s.groundY + 0.004, s.position.z);
    light.renderOrder = 6;

    this.group.add(sprite, glow, light);
    const blast = { sprite, glow, light, frames: row.frames, ballRadius: s.ballRadius, t: 0 };
    this.blasts.push(blast);
    this.apply(blast, p);
  }

  update(dt: number, p: ExplosionParams) {
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.t += dt;
      if (b.t * p.fps >= b.frames.length) {
        this.group.remove(b.sprite, b.glow, b.light);
        b.sprite.material.dispose();
        b.glow.material.dispose();
        b.light.material.dispose();
        this.blasts.splice(i, 1);
        continue;
      }
      this.apply(b, p);
    }
  }

  private apply(b: Blast, p: ExplosionParams) {
    const n = b.frames.length, u = (b.t * p.fps) / n;
    cellUv(this.atlas.manifest.grid, b.frames[Math.min(n - 1, Math.floor(b.t * p.fps))], b.sprite.material.uniforms.uvRect.value);
    // Clarão: cheio no contato, some antes da explosão (as faíscas finais já não iluminam).
    const flash = Math.max(0, 1 - u * 1.4) ** 2;
    b.glow.scale.setScalar(b.ballRadius * (10 + 6 * u));
    b.glow.material.opacity = 0.75 * flash;
    b.light.scale.setScalar(b.ballRadius * 16);
    b.light.material.opacity = 0.45 * Math.max(0, 1 - u);
  }
}
