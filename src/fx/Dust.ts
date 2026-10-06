import * as THREE from 'three';
import type { DirName } from '../character/directions';
import type { IsoCamera } from '../core/IsoCamera';
import { anchoredPlane, cellUv, loadSpriteTexture } from '../sprites/SpriteAtlas';
import { createSpriteMaterial } from '../sprites/SpriteMaterial';

/** Formato gerado por tools/sprites/dust.ts. */
export interface DustManifest {
  image: string;
  cell: [number, number];
  /** Centro da nuvem dentro da célula. */
  anchor: [number, number];
  grid: [number, number];
  rows: { heading: number; frames: number[]; peakWidth: number; lift: number }[];
  /** Linha de rastro por direção de movimento. */
  byDir: Partial<Record<DirName, number>>;
  /** Estouro de impacto para movimento para a direita / esquerda. */
  burst: { right: number; left: number };
}

export interface DustParams {
  /** Largura da nuvem (m) no frame mais cheio, com escala 1. */
  size: number;
  /** Duração de cada nuvem (s). */
  life: number;
  opacity: number;
}

export interface DustSpawn {
  /** Ponto no chão. */
  position: THREE.Vector3;
  /** Nível de oclusão (terraço). */
  level: number;
  dir: DirName;
  kind: 'trail' | 'burst';
  /** Lado do movimento na tela (+1 direita, −1 esquerda) — escolhe o estouro. */
  side: number;
  scale: number;
}

interface Puff {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  frames: number[];
  t: number;
}

export class DustAtlas {
  readonly geometry: THREE.PlaneGeometry;

  private constructor(readonly manifest: DustManifest, readonly texture: THREE.Texture) {
    this.geometry = anchoredPlane(manifest.cell, manifest.anchor, 1);
  }

  static async load(url: string): Promise<DustAtlas> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`poeira não encontrada em ${url} (rode "npm run sprites")`);
    const manifest = (await res.json()) as DustManifest;
    const base = url.slice(0, url.lastIndexOf('/') + 1);
    return new DustAtlas(manifest, await loadSpriteTexture(base + manifest.image));
  }
}

/**
 * Nuvens de poeira presas ao chão: cada uma toca a sua linha (cresce e dissipa) onde
 * nasceu, então o deslize deixa um rastro. A linha já é desenhada para a direção do
 * movimento (sem girar o sprite). Mesma ordem de desenho da personagem (renderOrder 10):
 * o three.js ordena pela profundidade, então a poeira atrás dela fica atrás.
 */
export class Dust {
  readonly group = new THREE.Group();
  private readonly puffs: Puff[] = [];
  private readonly pool: Puff['mesh'][] = [];

  /** Direção que se afasta da câmera (para o recuo de profundidade). */
  private readonly away: THREE.Vector3;

  constructor(private readonly atlas: DustAtlas, private readonly cam: IsoCamera) {
    this.away = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.camera.quaternion);
  }

  get count() {
    return this.puffs.length;
  }

  spawn(s: DustSpawn, p: DustParams) {
    const m = this.atlas.manifest;
    const fallback = s.side >= 0 ? m.byDir.e : m.byDir.w;
    const rowIndex = s.kind === 'burst' ? (s.side >= 0 ? m.burst.right : m.burst.left) : (m.byDir[s.dir] ?? fallback ?? 0);
    const row = m.rows[rowIndex];
    const mesh = this.pool.pop() ?? this.createMesh();
    // Variação de tamanho para o rastro não parecer carimbado.
    const k = (p.size * s.scale * (0.85 + Math.random() * 0.3)) / row.peakWidth; // metros por px do efeito
    mesh.scale.setScalar(k);
    // Recuo de profundidade (não muda a posição na tela): no mesmo ponto da personagem,
    // a poeira fica atrás do corpo — deslizando na horizontal da tela as duas empatam.
    mesh.position.copy(s.position).addScaledVector(this.away, 0.12);
    // A âncora é o centro da nuvem; a base dela fica `lift` px abaixo → apoia no chão.
    this.cam.addBillboardOffset(mesh.position, 0, row.lift * k);
    mesh.material.uniforms.opacity.value = p.opacity;
    mesh.material.uniforms.occKey.value = s.position.dot(this.cam.upGround);
    mesh.material.uniforms.occLevel.value = s.level;
    mesh.visible = true;
    this.group.add(mesh);
    this.puffs.push({ mesh, frames: row.frames, t: 0 });
    this.apply(this.puffs[this.puffs.length - 1], p);
  }

  update(dt: number, p: DustParams) {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const puff = this.puffs[i];
      puff.t += dt;
      if (puff.t >= p.life) {
        this.group.remove(puff.mesh);
        this.pool.push(puff.mesh);
        this.puffs.splice(i, 1);
        continue;
      }
      this.apply(puff, p);
    }
  }

  private apply(puff: Puff, p: DustParams) {
    const n = puff.frames.length;
    // Cresce rápido e dissipa devagar (como poeira de verdade).
    const u = Math.pow(puff.t / p.life, 0.8);
    const cell = puff.frames[Math.min(n - 1, Math.floor(u * n))];
    cellUv(this.atlas.manifest.grid, cell, puff.mesh.material.uniforms.uvRect.value);
    const fade = Math.min(1, (p.life - puff.t) / (p.life * 0.25));
    puff.mesh.material.uniforms.opacity.value = p.opacity * fade;
  }

  private createMesh() {
    const mesh = new THREE.Mesh(this.atlas.geometry, createSpriteMaterial());
    mesh.material.uniforms.map.value = this.atlas.texture;
    mesh.quaternion.copy(this.cam.camera.quaternion);
    mesh.renderOrder = 10;
    return mesh;
  }
}
