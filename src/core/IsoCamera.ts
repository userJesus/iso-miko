import * as THREE from 'three';

/**
 * Câmera ortográfica dimétrica que segue um alvo.
 * A escala é definida em px de tela por px do atlas (zoom), então o sprite tem tamanho
 * previsível na tela independentemente do tamanho da janela.
 */
export class IsoCamera {
  readonly camera: THREE.OrthographicCamera;
  readonly target = new THREE.Vector3();
  /** Direita da tela projetada no chão (unitário). */
  readonly right = new THREE.Vector3();
  /** "Cima" da tela projetado no chão (unitário) — para onde W leva. */
  readonly upGround = new THREE.Vector3();
  /** Eixo vertical da tela no mundo (inclinado): plano dos billboards = right × screenUp. */
  readonly screenUp = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private viewW = 1;
  private viewH = 1;

  constructor(
    pitchDeg: number,
    yawDeg: number,
    private pxPerMeter: number,
    public zoom: number,
  ) {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    const p = THREE.MathUtils.degToRad(pitchDeg), y = THREE.MathUtils.degToRad(yawDeg);
    this.offset.set(Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)).multiplyScalar(100);
    this.camera.position.copy(this.offset);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    // Base do chão derivada da própria câmera (robusto a mudanças de ângulo).
    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion).setY(0).normalize();
    this.upGround.set(0, 0, -1).applyQuaternion(this.camera.quaternion).setY(0).normalize();
    this.screenUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
  }

  /** Px de tela (CSS) por metro. */
  get ppu() {
    return this.pxPerMeter * this.zoom;
  }

  /** Ponto do mundo (no plano que passa pela origem) com coordenadas de tela (x, y) em metros. */
  screenToWorld(x: number, y: number, out: THREE.Vector3) {
    return out.copy(this.right).multiplyScalar(x).addScaledVector(this.screenUp, y);
  }

  /** Coordenadas de tela (m) de um ponto do mundo. */
  screenOf(p: THREE.Vector3) {
    return { x: p.dot(this.right), y: p.dot(this.screenUp) };
  }

  /** Desloca `out` por (x, y) metros no plano do billboard (x direita, y para cima na tela). */
  addBillboardOffset(out: THREE.Vector3, x: number, y: number) {
    return out.addScaledVector(this.right, x).addScaledVector(this.screenUp, y);
  }

  /** Converte coordenadas 2D da base da tela (x direita, y cima) em ponto do chão. */
  groundToWorld(x: number, y: number, out: THREE.Vector3) {
    return out.copy(this.right).multiplyScalar(x).addScaledVector(this.upGround, y);
  }

  resize(w: number, h: number) {
    this.viewW = w;
    this.viewH = h;
    this.applyFrustum();
  }

  setZoom(z: number) {
    this.zoom = z;
    this.applyFrustum();
  }

  /** Raio (m, no chão) que cobre a tela inteira — usado no fade do chão. */
  get groundViewRadius() {
    // O eixo vertical da tela é encurtado pelo seno da elevação no chão.
    const sinP = this.offset.y / this.offset.length();
    return Math.hypot(this.viewW / 2, this.viewH / 2 / sinP) / this.ppu;
  }

  private applyFrustum() {
    const hw = this.viewW / 2 / this.ppu, hh = this.viewH / 2 / this.ppu;
    Object.assign(this.camera, { left: -hw, right: hw, top: hh, bottom: -hh });
    this.camera.updateProjectionMatrix();
  }

  /** Segue o alvo com amortecimento exponencial. */
  follow(pos: THREE.Vector3, stiffness: number, dt: number) {
    this.target.lerp(pos, 1 - Math.exp(-stiffness * dt));
    this.camera.position.copy(this.target).add(this.offset);
  }

  snapTo(pos: THREE.Vector3) {
    this.target.copy(pos);
    this.camera.position.copy(this.target).add(this.offset);
  }
}
