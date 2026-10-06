import * as THREE from 'three';

/**
 * Oclusão contra a pintura: cada pixel da ilha guarda a "chave" (profundidade v do chão
 * a que pertence) e um limiar de nível. Um sprite com chave k e nível n some onde
 * pixel.limiar > n e pixel.chave < k − viés — atrás de árvores, torii, rochas e penhascos.
 * Uniforms compartilhados por todos os materiais de sprite.
 */
export const occlusionShared = {
  occMap: { value: null as THREE.Texture | null },
  /** Retângulo do mapa em coordenadas de tela (x, y, largura, altura) em metros. */
  occRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  occRange: { value: new THREE.Vector2(0, 1) },
  occAxisX: { value: new THREE.Vector3(1, 0, 0) },
  occAxisY: { value: new THREE.Vector3(0, 1, 0) },
  occBias: { value: 0.3 },
  occEnabled: { value: 0 },
};

/** Uniforms de um material: os compartilhados + chave e nível próprios. */
export function occlusionUniforms() {
  return { ...occlusionShared, occKey: { value: 0 }, occLevel: { value: 1 } };
}

export const OCC_VERTEX_PARS = /* glsl */ `
  uniform vec4 occRect;
  uniform vec3 occAxisX;
  uniform vec3 occAxisY;
  varying vec2 vOccUv;
`;

/** Depois de calcular a posição: precisa de `vec4 occWorld` (posição no mundo). */
export const OCC_VERTEX = /* glsl */ `
  vOccUv = (vec2(dot(occWorld.xyz, occAxisX), dot(occWorld.xyz, occAxisY)) - occRect.xy) / occRect.zw;
`;

export const OCC_FRAGMENT_PARS = /* glsl */ `
  uniform sampler2D occMap;
  uniform vec2 occRange;
  uniform float occBias;
  uniform float occEnabled;
  uniform float occKey;
  uniform float occLevel;
  varying vec2 vOccUv;

  bool occluded() {
    if (occEnabled < 0.5) return false;
    if (vOccUv.x < 0.0 || vOccUv.y < 0.0 || vOccUv.x > 1.0 || vOccUv.y > 1.0) return false;
    vec4 t = floor(texture2D(occMap, vOccUv) * 255.0 + 0.5);
    if (t.b < 64.0) return false;              // pixel sem dados
    float flags = t.b - 64.0;
    if (mod(floor(flags / 16.0), 2.0) > 0.5) return false; // mar
    float thr = mod(flags, 8.0);
    float key = (t.r * 256.0 + t.g) / 65535.0 * (occRange.y - occRange.x) + occRange.x;
    return thr > occLevel + 0.001 && key < occKey - occBias;
  }
`;

/** Configura os uniforms compartilhados para um cenário. */
export function setupOcclusion(o: {
  map: THREE.Texture; rect: { x: number; y: number; w: number; h: number };
  keyMin: number; keyMax: number; right: THREE.Vector3; screenUp: THREE.Vector3; bias: number;
}) {
  occlusionShared.occMap.value = o.map;
  occlusionShared.occRect.value.set(o.rect.x, o.rect.y, o.rect.w, o.rect.h);
  occlusionShared.occRange.value.set(o.keyMin, o.keyMax);
  occlusionShared.occAxisX.value.copy(o.right);
  occlusionShared.occAxisY.value.copy(o.screenUp);
  occlusionShared.occBias.value = o.bias;
  occlusionShared.occEnabled.value = 1;
}
