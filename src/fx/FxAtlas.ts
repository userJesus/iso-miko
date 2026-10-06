import * as THREE from 'three';
import { anchoredPlane, cellUv, loadSpriteTexture } from '../sprites/SpriteAtlas';

/** Formato gerado por tools/sprites/projectile.ts. */
export interface FxClip {
  /** Células em laço (chama "viva"). */
  loop: number[];
  /** Células da dissipação (encolhendo). */
  dissipate: number[];
  /** Raio da bola no sprite, em px do atlas de efeito. */
  ballRadius: number;
}

export interface FxManifest {
  image: string;
  cell: [number, number];
  /** Núcleo da bola dentro da célula. */
  anchor: [number, number];
  grid: [number, number];
  /** Voa para +x da tela (o jogo rotaciona para a direção do disparo). */
  flight: FxClip;
  /** Chama segurada (labaredas para cima). */
  held: FxClip;
}

/**
 * Atlas de efeito. A geometria é em "px do efeito" (1 unidade = 1 px), centrada no núcleo;
 * cada instância escala para o tamanho de mundo que precisa.
 */
export class FxAtlas {
  readonly geometry: THREE.PlaneGeometry;

  private constructor(readonly manifest: FxManifest, readonly texture: THREE.Texture) {
    this.geometry = anchoredPlane(manifest.cell, manifest.anchor, 1);
  }

  static async load(url: string): Promise<FxAtlas> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`efeito não encontrado em ${url} (rode "npm run sprites")`);
    const manifest = (await res.json()) as FxManifest;
    const base = url.slice(0, url.lastIndexOf('/') + 1);
    return new FxAtlas(manifest, await loadSpriteTexture(base + manifest.image));
  }

  uvRect(cell: number, out: THREE.Vector4) {
    return cellUv(this.manifest.grid, cell, out);
  }
}

/** Textura de brilho radial (luz aditiva). */
export function createGlowTexture(inner = 'rgba(255,190,90,1)', mid = 'rgba(255,110,30,0.45)') {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, mid);
  g.addColorStop(1, 'rgba(255,60,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
