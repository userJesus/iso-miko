import * as THREE from 'three';
import { OCC_FRAGMENT_PARS, OCC_VERTEX, OCC_VERTEX_PARS, occlusionUniforms } from '../level/occlusion';

/**
 * Material de billboard para atlas pré-multiplicado.
 * Saída em sRGB direto (sem conversão de espaço de cor): o sprite não recebe luz,
 * então a cor desenhada é exatamente a da arte. Some atrás dos objetos do cenário
 * (uniforms occKey/occLevel por material; ver level/occlusion.ts).
 */
export function createSpriteMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null },
      uvRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      opacity: { value: 1 },
      /** Linha de debug na âncora (pés): 0 desliga. */
      anchorDebug: { value: 0 },
      anchorUv: { value: new THREE.Vector2(0.5, 0) },
      ...occlusionUniforms(),
    },
    vertexShader: /* glsl */ `
      uniform vec4 uvRect;
      varying vec2 vUv;
      varying vec2 vLocal;
      ${OCC_VERTEX_PARS}
      void main() {
        vLocal = uv;
        vUv = uvRect.xy + uv * uvRect.zw;
        vec4 occWorld = modelMatrix * vec4(position, 1.0);
        ${OCC_VERTEX}
        gl_Position = projectionMatrix * viewMatrix * occWorld;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform float opacity;
      uniform float anchorDebug;
      uniform vec2 anchorUv;
      varying vec2 vUv;
      varying vec2 vLocal;
      ${OCC_FRAGMENT_PARS}
      void main() {
        vec4 c = texture2D(map, vUv);
        if (anchorDebug > 0.5) {
          vec2 px = fwidth(vLocal);
          float vx = 1.0 - step(px.x * 1.0, abs(vLocal.x - anchorUv.x));
          float hy = 1.0 - step(px.y * 1.0, abs(vLocal.y - anchorUv.y));
          float line = max(vx, hy);
          c = mix(c, vec4(1.0, 0.1, 0.35, 1.0), line * 0.85);
          // contorno da célula
          vec2 e = min(vLocal, 1.0 - vLocal) / px;
          if (min(e.x, e.y) < 1.0) c = mix(c, vec4(0.2, 0.6, 1.0, 1.0), 0.6);
        }
        if (c.a < 0.004) discard;
        if (occluded()) discard;
        gl_FragColor = c * opacity;
      }
    `,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    // Sem teste de profundidade: o plano do billboard é inclinado e, quando a arte desce
    // abaixo da âncora (corpo deitado numa diagonal), essa parte fica "sob o chão" em 3D e
    // seria cortada. A ordem entre sprites vem da ordenação; contra o cenário, da oclusão.
    depthTest: false,
  });
}

/** Sombra arredondada no chão, com a mesma oclusão dos sprites. */
export function createShadowMaterial(map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, opacity: { value: 1 }, ...occlusionUniforms() },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      ${OCC_VERTEX_PARS}
      void main() {
        vUv = uv;
        vec4 occWorld = modelMatrix * vec4(position, 1.0);
        ${OCC_VERTEX}
        gl_Position = projectionMatrix * viewMatrix * occWorld;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform float opacity;
      varying vec2 vUv;
      ${OCC_FRAGMENT_PARS}
      void main() {
        vec4 c = texture2D(map, vUv);
        if (c.a < 0.004 || occluded()) discard;
        gl_FragColor = vec4(0.0, 0.0, 0.0, c.a * opacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
}
