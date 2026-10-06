import * as THREE from 'three';
import type { IsoCamera } from '../core/IsoCamera';

export interface FogShape {
  cu: number;
  cv: number;
  ru: number;
  rv: number;
}

export interface SeaParams {
  /** Metros por repetição da textura. */
  tile: number;
  /** Distância normalizada da ilha (1 = borda) onde a neblina começa e fecha. */
  fogStart: number;
  fogEnd: number;
  /** Multiplicador do raio da área de mar para trás da ilha (topo da tela). */
  fogBack: number;
  fogColor: THREE.Color;
}

/**
 * Mar ao redor da ilha: textura contínua em duas camadas que correm em direções diferentes
 * (com distorção), e neblina branca em bancos animados a partir da borda da ilha —
 * o horizonte some e nada além do cenário aparece.
 */
export class Sea {
  readonly mesh: THREE.Mesh;
  private readonly uniforms;

  constructor(waterTex: THREE.Texture, fog: FogShape, p: SeaParams, cam: IsoCamera, height: number) {
    waterTex.wrapS = waterTex.wrapT = THREE.RepeatWrapping;
    waterTex.colorSpace = THREE.SRGBColorSpace;
    waterTex.anisotropy = 8;
    this.uniforms = {
      waterTex: { value: waterTex },
      time: { value: 0 },
      tile: { value: p.tile },
      fogColor: { value: p.fogColor.clone() },
      fogRange: { value: new THREE.Vector2(p.fogStart, p.fogEnd) },
      fogShape: { value: new THREE.Vector4(fog.cu, fog.cv, fog.ru, fog.rv) },
      fogBack: { value: p.fogBack },
      axisU: { value: cam.right.clone() },
      axisV: { value: cam.upGround.clone() },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D waterTex;
        uniform float time;
        uniform float tile;
        uniform vec3 fogColor;
        uniform vec2 fogRange;
        uniform vec4 fogShape;
        uniform float fogBack;
        uniform vec3 axisU;
        uniform vec3 axisV;
        varying vec3 vWorld;

        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
        }
        float fbm(vec2 p) {
          float s = 0.0, a = 0.5;
          for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; }
          return s;
        }

        void main() {
          vec2 g = vec2(dot(vWorld, axisU), dot(vWorld, axisV));
          vec2 uv = g / tile;
          vec2 warp = vec2(fbm(uv * 1.7 + time * 0.05), fbm(uv * 1.7 - time * 0.04 + 9.0)) - 0.5;
          vec3 a = texture2D(waterTex, uv + warp * 0.06 + vec2(time * 0.010, time * 0.006)).rgb;
          vec3 b = texture2D(waterTex, uv * 0.73 - warp * 0.05 - vec2(time * 0.007, -time * 0.009) + 0.37).rgb;
          vec3 water = mix(a, b, 0.45);
          // brilho onde as duas camadas coincidem (cristas)
          water += vec3(0.9, 1.0, 1.0) * smoothstep(1.35, 1.75, a.g + b.g + a.b * 0.3) * 0.25;

          // elipse mais funda para trás (topo da tela): mais mar visível acima da ilha
          vec2 rad = vec2(fogShape.z, fogShape.w * (g.y > fogShape.y ? fogBack : 1.0));
          vec2 e = (g - fogShape.xy) / rad;
          float d = length(e);
          float bank = fbm(g * 0.08 + vec2(time * 0.03, time * 0.012)) - 0.5;
          float fog = smoothstep(fogRange.x, fogRange.y, d + bank * 0.35);
          vec3 col = mix(water, fogColor, fog);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
    this.mesh.position.y = height - 0.02;
    this.mesh.renderOrder = -20;
    this.mesh.frustumCulled = false;
  }

  /** Acompanha a câmera (plano "infinito"). */
  update(time: number, center: THREE.Vector3, viewRadius: number) {
    this.uniforms.time.value = time;
    const size = viewRadius * 2.6;
    this.mesh.position.x = center.x;
    this.mesh.position.z = center.z;
    this.mesh.scale.set(size, 1, size);
  }

  setFog(start: number, end: number, back: number) {
    this.uniforms.fogRange.value.set(start, end);
    this.uniforms.fogBack.value = back;
  }
}
