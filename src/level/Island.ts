import * as THREE from 'three';
import type { IsoCamera } from '../core/IsoCamera';
import { loadSpriteTexture } from '../sprites/SpriteAtlas';
import type { Level } from './Level';
import { occlusionShared } from './occlusion';

/**
 * A pintura da ilha (ampliada 4×) como planos voltados para a câmera, alinhados de forma
 * que cada pixel caia exatamente sobre o ponto do mundo que ele representa.
 * A água pintada ganha movimento (ondulação + brilho) e a cascata escorre.
 */
export class Island {
  readonly group = new THREE.Group();
  private readonly uniforms = {
    time: { value: 0 },
    waterTex: { value: null as THREE.Texture | null },
    occMap: occlusionShared.occMap,
    occRect: occlusionShared.occRect,
    occAxisX: occlusionShared.occAxisX,
    occAxisY: occlusionShared.occAxisY,
    sinPitch: { value: 0.5 },
    waterTile: { value: 7 },
  };
  private overlay: THREE.Mesh | null = null;

  private constructor() {}

  static async create(level: Level, cam: IsoCamera, waterTex: THREE.Texture, waterTile: number): Promise<Island> {
    const isl = new Island();
    isl.uniforms.waterTex.value = waterTex;
    isl.uniforms.waterTile.value = waterTile;
    isl.uniforms.sinPitch.value = Math.sin(THREE.MathUtils.degToRad(level.meta.pitchDeg));
    const m = level.meta;
    const texPerMeter = m.pxPerMeter * m.texScale;
    const textures = await Promise.all(m.tiles.map((t) => loadSpriteTexture(level.baseUrl + t.file)));
    m.tiles.forEach((t, i) => {
      const tex = textures[i];
      tex.anisotropy = 4;
      const w = (t.x1 - t.x0) / texPerMeter, h = m.screenRect.h;
      const geo = new THREE.PlaneGeometry(w, h);
      // UV da parte útil (o bloco tem 2 px extras dos vizinhos para a filtragem)
      const ua = (t.x0 - t.px0) / t.texW, ub = (t.x1 - t.px0) / t.texW;
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) < 0.5 ? ua : ub);
      // deslocamento de UV do bloco → deslocamento de UV do mapa de profundidade
      const uvToOcc = new THREE.Vector2(w / ((ub - ua) * m.screenRect.w), 1);
      const mesh = new THREE.Mesh(geo, isl.material(tex, uvToOcc));
      const sx = m.screenRect.x + t.x0 / texPerMeter + w / 2, sy = m.screenRect.y + h / 2;
      cam.screenToWorld(sx, sy, mesh.position);
      mesh.quaternion.copy(cam.camera.quaternion);
      mesh.renderOrder = -10;
      mesh.frustumCulled = false;
      isl.group.add(mesh);
    });
    return isl;
  }

  update(time: number) {
    this.uniforms.time.value = time;
  }

  /** Sobreposição de depuração: verde = caminhável, vermelho = barreira. */
  async setOverlay(level: Level, cam: IsoCamera, on: boolean) {
    if (on && !this.overlay && level.meta.walkOverlay) {
      const tex = await new THREE.TextureLoader().loadAsync(level.baseUrl + level.meta.walkOverlay);
      tex.colorSpace = THREE.SRGBColorSpace;
      const r = level.meta.screenRect;
      this.overlay = new THREE.Mesh(
        new THREE.PlaneGeometry(r.w, r.h),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false }),
      );
      cam.screenToWorld(r.x + r.w / 2, r.y + r.h / 2, this.overlay.position);
      this.overlay.quaternion.copy(cam.camera.quaternion);
      this.overlay.renderOrder = -9;
      this.group.add(this.overlay);
    }
    if (this.overlay) this.overlay.visible = on;
  }

  private material(map: THREE.Texture, uvToOcc: THREE.Vector2) {
    return new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, map: { value: map }, uvToOcc: { value: uvToOcc } },
      vertexShader: /* glsl */ `
        uniform vec4 occRect;
        uniform vec3 occAxisX;
        uniform vec3 occAxisY;
        varying vec2 vUv;
        varying vec2 vOccUv;
        varying vec2 vScreen;
        void main() {
          vUv = uv;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vScreen = vec2(dot(w.xyz, occAxisX), dot(w.xyz, occAxisY));
          vOccUv = (vScreen - occRect.xy) / occRect.zw;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform sampler2D occMap;
        uniform sampler2D waterTex;
        uniform float time;
        uniform float sinPitch;
        uniform float waterTile;
        uniform vec2 uvToOcc;
        varying vec2 vUv;
        varying vec2 vOccUv;
        varying vec2 vScreen;

        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
        }

        vec2 seaFall(vec2 occUv) {
          vec4 t = floor(texture2D(occMap, occUv) * 255.0 + 0.5);
          float flags = t.b >= 64.0 ? t.b - 64.0 : 0.0;
          return vec2(mod(floor(flags / 16.0), 2.0), mod(floor(flags / 32.0), 2.0));
        }

        void main() {
          vec2 sf = seaFall(vOccUv);
          float sea = sf.x;
          float fall = sf.y;
          vec2 uv = vUv;
          // chão da água (h = 0) visto deste pixel
          vec2 ground = vec2(vScreen.x, vScreen.y / sinPitch);
          if (sea > 0.5 && fall < 0.5) {
            // ondulação da água pintada: só se a amostra deslocada também for água
            // (senão a pedra da margem "escorre" para dentro da água)
            vec2 n = vec2(noise(ground * 1.3 + time * 0.35), noise(ground * 1.3 - time * 0.3 + 17.0)) - 0.5;
            vec2 d = n * vec2(0.0012, 0.0009);
            vec2 sf2 = seaFall(vOccUv + d * uvToOcc);
            if (sf2.x > 0.5 && sf2.y < 0.5) uv += d;
          }
          if (fall > 0.5) {
            vec2 d = vec2(0.0, (noise(vec2(ground.x * 6.0, time * 0.7)) - 0.5) * 0.0012);
            if (seaFall(vOccUv + d * uvToOcc).y > 0.5) uv += d;
          }
          vec4 c = texture2D(map, uv);
          if (c.a < 0.004) discard;
          if (sea > 0.5 && fall < 0.5) {
            // brilho da textura do mar correndo por cima da água pintada
            vec2 wuv = ground / waterTile;
            float lum = dot(texture2D(waterTex, wuv + vec2(time * 0.012, time * 0.007)).rgb, vec3(0.33));
            float lum2 = dot(texture2D(waterTex, wuv * 1.37 - vec2(time * 0.009, -time * 0.011)).rgb, vec3(0.33));
            float sparkle = smoothstep(0.62, 0.9, (lum + lum2) * 0.5);
            c.rgb += vec3(0.85, 0.97, 1.0) * sparkle * 0.22 * c.a;
          }
          if (fall > 0.5) {
            // filetes descendo
            float s = noise(vec2(ground.x * 18.0, vScreen.y * 3.0 + time * 6.0));
            c.rgb += vec3(0.9, 0.97, 1.0) * smoothstep(0.6, 0.95, s) * 0.28 * c.a;
          }
          gl_FragColor = c;
        }
      `,
      transparent: true,
      premultipliedAlpha: true,
      depthTest: false,
      depthWrite: false,
    });
  }
}
