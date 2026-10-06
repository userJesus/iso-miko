import * as THREE from 'three';
import type { DirName } from '../character/directions';
import type { SlideData } from '../character/Slide';

/** [x, y, raio] em px do atlas relativos aos pés (y para cima) e se está na mão (1) ou solta (0). */
export type FirePoint = [number, number, number, 0 | 1];

/** Formato gerado por tools/build-sprites.ts. */
export interface ActionDirection {
  /** Células do atlas na ordem de reprodução; em laços, frames[0] é a pose de passagem (fase 0). */
  frames: number[];
  idle?: number;
  closure?: number;
  mirrorOf?: DirName;
  /** Direção sem arte própria: usa as células de outra. */
  aliasOf?: DirName;
  /** Fogo desenhado (removido da arte) por frame — onde o jogo desenha o efeito. */
  fire?: (FirePoint | null)[];
  /** Índice em `frames` em que a bola sai da mão. */
  release?: number;
  /** Raio típico da bola na mão (px do atlas) — tamanho do projétil. */
  ballRadius?: number;
  /** Fases e sincronia com a corrida (deslize). */
  slide?: SlideData;
}

export interface ActionData {
  kind: 'loop' | 'once';
  image: string;
  cell: [number, number];
  anchor: [number, number];
  grid: [number, number];
  /** Altura média da personagem nesta ação, em px do atlas. */
  height: number;
  /** Px do atlas percorridos (na horizontal da tela) por ciclo (só ações em laço). */
  stride?: number;
  directions: Record<DirName, ActionDirection>;
}

export interface CharacterManifest {
  id: string;
  directions: DirName[];
  /** Ação exibida parada. */
  idleAction: string;
  /** Ação cuja altura define a escala px → metro. */
  heightRef?: string;
  actions: Record<string, ActionData>;
}

export interface LoadedAction {
  name: string;
  data: ActionData;
  texture: THREE.Texture;
  /** Plano já deslocado para que a âncora (pés) fique na origem. */
  geometry: THREE.PlaneGeometry;
}

/**
 * Textura de sprite: cores em sRGB "cru" (sem iluminação) e alfa pré-multiplicado para que
 * a filtragem linear/mipmaps não crie franja escura nas bordas.
 */
export async function loadSpriteTexture(url: string): Promise<THREE.Texture> {
  const texture = await new THREE.TextureLoader().loadAsync(url);
  texture.colorSpace = THREE.NoColorSpace;
  texture.premultiplyAlpha = true;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Plano de `w×h` px com a âncora (ax, ay) na origem, em unidades de mundo. */
export function anchoredPlane(cell: [number, number], anchor: [number, number], pxPerMeter: number) {
  const [cw, ch] = cell, [ax, ay] = anchor;
  const w = cw / pxPerMeter, h = ch / pxPerMeter;
  return new THREE.PlaneGeometry(w, h).translate(-(ax / cw - 0.5) * w, -(0.5 - ay / ch) * h, 0);
}

/** Retângulo UV (u0, v0, largura, altura) de uma célula numa grade [colunas, linhas]. */
export function cellUv(grid: [number, number], cell: number, out: THREE.Vector4): THREE.Vector4 {
  const [cols, rows] = grid;
  const col = cell % cols, row = Math.floor(cell / cols);
  // flipY: v = 0 na base da imagem.
  return out.set(col / cols, 1 - (row + 1) / rows, 1 / cols, 1 / rows);
}

/** Atlas de uma personagem: texturas, geometrias e cálculo de UV por frame. */
export class SpriteAtlas {
  readonly actions = new Map<string, LoadedAction>();

  private constructor(
    readonly manifest: CharacterManifest,
    /** Px do atlas por metro de mundo (comum a todas as ações da personagem). */
    readonly pxPerMeter: number,
  ) {}

  static async load(baseUrl: string, characterHeight: number): Promise<SpriteAtlas> {
    const res = await fetch(`${baseUrl}/manifest.json`);
    if (!res.ok) throw new Error(`manifest não encontrado em ${baseUrl} (rode "npm run sprites")`);
    const manifest = (await res.json()) as CharacterManifest;
    const ref = manifest.actions[manifest.heightRef ?? manifest.idleAction];
    const atlas = new SpriteAtlas(manifest, ref.height / characterHeight);
    await Promise.all(
      Object.entries(manifest.actions).map(async ([name, data]) => {
        const texture = await loadSpriteTexture(`${baseUrl}/${data.image}`);
        const geometry = anchoredPlane(data.cell, data.anchor, atlas.pxPerMeter);
        atlas.actions.set(name, { name, data, texture, geometry });
      }),
    );
    return atlas;
  }

  get(name: string): LoadedAction {
    const a = this.actions.get(name);
    if (!a) throw new Error(`ação "${name}" não existe no atlas`);
    return a;
  }

  has(name: string) {
    return this.actions.has(name);
  }

  uvRect(action: LoadedAction, cell: number, out: THREE.Vector4): THREE.Vector4 {
    return cellUv(action.data.grid, cell, out);
  }

  /** Metros percorridos por ciclo de uma ação em laço, segundo o pipeline. */
  strideMeters(name: string): number {
    return (this.get(name).data.stride ?? 0) / this.pxPerMeter;
  }
}
