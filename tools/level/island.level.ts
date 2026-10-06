/**
 * Interpretação da pintura da ilha (assets-src/level/island.png, 1672×941) como cenário 3D.
 * Todas as coordenadas estão em px da imagem ORIGINAL (x para a direita, y para baixo).
 *
 * Projeção: a pintura é tratada como render ortográfico com a mesma câmera do jogo
 * (elevação 30°). Um ponto do chão (u, v) na altura h aparece em
 *   x = S·u,   y = 941 − S·(v·sen30° + h·cos30°)
 * com S px da imagem por metro de tela. As alturas dos terraços são escolhidas para que
 * rampas e escadas fiquem caminháveis; cada terraço é convertido para o chão com a sua
 * altura, então a personagem pisa exatamente sobre a área pintada.
 *
 * Níveis (para oclusão): 0 mar · 1 praia · 2 caminho/platô direito · 3 platô do torii.
 */
export type Pt = [number, number];

export interface Ramp {
  /** Borda de baixo (dois pontos na imagem) e a altura dela. */
  bottom: [Pt, Pt];
  h0: number;
  /** Borda de cima e a altura dela. */
  top: [Pt, Pt];
  h1: number;
  /** Degraus visíveis (a altura exibida sobe em degraus); 0 = rampa contínua. */
  steps?: number;
}

export interface Region {
  id: string;
  /** walk = caminhável · surface = superfície não caminhável (só para profundidade). */
  kind: 'walk' | 'surface';
  poly: Pt[];
  /** Altura constante (m) — ou `ramp`. */
  h?: number;
  ramp?: Ramp;
  /** Nível de oclusão (rampas: nível de baixo → de cima). */
  level: number;
  level1?: number;
  /** Caminhável mesmo sobre pedra (degraus). */
  forceWalk?: boolean;
  /** Fator de velocidade sobre a região. */
  speed?: number;
}

export interface Card {
  id: string;
  /**
   * Partes do objeto (polígonos). `mats`: 'any' = todo pixel opaco do polígono;
   * 'object' = folhagem/flores/tronco/vermelho/escuro; 'torii' = só vermelho e escuro.
   */
  parts: { poly: Pt[]; mats: 'object' | 'any' | 'torii' }[];
  /**
   * Árvores: só fica no cartão o que está ligado ao tronco (ou encosta no céu). Arbustos no
   * chão dentro do polígono ficam de fora e viram obstáculos com base própria.
   */
  trunk?: boolean;
  /** Base no chão (ponto, ou linha — a profundidade é interpolada pela coluna). */
  base: Pt | [Pt, Pt];
  /** Região sobre a qual está (altura da base). */
  on: string;
}

export interface Blocker {
  id: string;
  /** Centro na imagem (no chão da região `on`). */
  at: Pt;
  /** Raio no chão (m). */
  r: number;
  on: string;
}

export const ISLAND = {
  image: 'island.png',
  width: 1672,
  height: 941,
  /** px da imagem original por metro de tela. Menor = cenário maior em relação à personagem. */
  pxPerMeter: 28,
  /** Recorte útil da imagem (a ilha + água pintada). */
  crop: { x0: 250, y0: 30, x1: 1430, y1: 912 },
  /** Altura da água (m). */
  water: 0,

  regions: [
    {
      id: 'top', kind: 'walk', h: 2.95, level: 3,
      poly: [
        [650, 268], [662, 236], [690, 212], [730, 200], [775, 192], [815, 190], [860, 200], [895, 218],
        [930, 222], [990, 226], [1035, 240], [1062, 262], [1066, 300], [1048, 314], [1002, 312], [913, 320],
        [880, 330], [830, 338], [780, 336], [730, 326], [690, 310], [662, 292],
      ],
    },
    {
      id: 'stairs', kind: 'walk', level: 2, level1: 3, forceWalk: true, speed: 0.82,
      poly: [[913, 320], [1002, 312], [1040, 404], [1041, 419], [955, 421], [916, 334]],
      ramp: { bottom: [[955, 420], [1041, 418]], h0: 1.2, top: [[913, 321], [1002, 313]], h1: 2.95, steps: 5 },
    },
    {
      id: 'path', kind: 'walk', h: 1.2, level: 2,
      poly: [
        [955, 420], [1041, 418], [1043, 404], [1065, 380], [1150, 368], [1165, 330], [1175, 296], [1215, 288],
        [1245, 300], [1290, 330], [1320, 370], [1342, 420], [1348, 470], [1340, 520], [1312, 552], [1272, 584],
        [1225, 606], [1175, 616], [1120, 612], [1075, 607], [1040, 598], [1005, 590], [985, 584],
        [838, 582], [858, 570], [878, 548], [884, 505], [893, 472], [905, 448], [925, 428],
      ],
    },
    {
      id: 'descent', kind: 'walk', level: 1, level1: 2, forceWalk: true, speed: 0.88,
      poly: [[840, 582], [985, 584], [962, 598], [958, 664], [822, 664], [818, 612], [828, 592]],
      ramp: { bottom: [[822, 664], [958, 664]], h0: 0.3, top: [[840, 582], [985, 584]], h1: 1.2, steps: 3 },
    },
    {
      id: 'beach', kind: 'walk', h: 0.3, level: 1,
      poly: [
        [822, 664], [958, 664], [962, 690], [1000, 690], [1008, 720], [985, 745], [958, 770], [950, 795],
        [905, 790], [870, 777], [840, 762], [805, 745], [770, 730], [735, 715], [700, 702], [660, 694],
        [640, 690], [650, 672], [690, 660], [705, 640], [725, 615], [760, 606], [790, 612], [815, 630],
      ],
    },
    // Encosta gramada à esquerda da escadaria: mesma inclinação dos degraus (profundidade correta).
    {
      id: 'slopeL', kind: 'surface', level: 2, level1: 3,
      poly: [[840, 330], [913, 322], [916, 334], [955, 421], [925, 428], [905, 448], [880, 440], [850, 400], [835, 360]],
      ramp: { bottom: [[905, 432], [955, 421]], h0: 1.2, top: [[840, 330], [913, 322]], h1: 2.95 },
    },
    {
      id: 'leftPlateau', kind: 'surface', h: 2.6, level: 3,
      poly: [
        [330, 400], [360, 380], [420, 370], [480, 350], [540, 330], [590, 300], [610, 330], [600, 390],
        [575, 430], [540, 470], [480, 480], [420, 470], [360, 460], [330, 440],
      ],
    },
  ] satisfies Region[] as Region[],

  cards: [
    {
      // Base = centro do plinto de cada pilar (a profundidade é interpolada entre eles).
      id: 'torii', on: 'top', base: [[905, 251], [1004, 289]],
      parts: [
        // telhado: o céu atrás é transparente, então o polígono pode ser folgado
        { mats: 'any', poly: [[852, 78], [870, 70], [1072, 132], [1072, 165], [1062, 168], [858, 112]] },
        // vigas: só pixels vermelhos/escuros (as pedras e moitas atrás ficam de fora)
        { mats: 'torii', poly: [[850, 95], [1072, 150], [1072, 207], [1032, 207], [875, 162], [860, 130]] },
        // pilar esquerdo (medido na pintura): poste 896–917, base preta 891–919, plinto 884–926
        { mats: 'any', poly: [[896, 140], [917, 140], [917, 221], [919, 221], [919, 244], [926, 244], [926, 258], [884, 258], [884, 244], [891, 244], [891, 221], [896, 221]] },
        // pilar direito: poste 991–1013, base preta 989–1017, plinto 985–1023
        { mats: 'any', poly: [[991, 160], [1013, 160], [1013, 257], [1017, 257], [1017, 280], [1023, 280], [1023, 297], [985, 297], [985, 280], [989, 280], [989, 257], [991, 257]] },
      ],
    },
    {
      id: 'cherryL', trunk: true, on: 'top', base: [747, 214],
      parts: [{ mats: 'object', poly: [[570, 150], [600, 80], [650, 45], [730, 35], [800, 45], [860, 85], [870, 120], [840, 165], [800, 185], [775, 192], [772, 214], [722, 214], [715, 192], [660, 198], [610, 190], [575, 170]] }],
    },
    {
      id: 'smallPine', trunk: true, on: 'top', base: [805, 320],
      parts: [{ mats: 'object', poly: [[765, 275], [790, 252], [830, 255], [855, 280], [845, 300], [815, 305], [812, 322], [798, 322], [795, 305], [770, 300]] }],
    },
    {
      id: 'cherryR', trunk: true, on: 'path', base: [1268, 448],
      parts: [{ mats: 'object', poly: [[1165, 330], [1200, 300], [1260, 295], [1320, 305], [1352, 340], [1340, 375], [1290, 390], [1285, 450], [1250, 450], [1255, 395], [1210, 395], [1170, 370]] }],
    },
    {
      id: 'pineR', trunk: true, on: 'path', base: [1208, 538],
      parts: [{ mats: 'object', poly: [[1110, 455], [1140, 415], [1200, 400], [1260, 415], [1320, 440], [1330, 480], [1300, 510], [1230, 512], [1222, 540], [1195, 540], [1190, 505], [1130, 500]] }],
    },
    {
      id: 'pineTR', trunk: true, on: 'path', base: [1168, 288],
      parts: [{ mats: 'object', poly: [[1075, 210], [1100, 165], [1150, 140], [1210, 150], [1240, 190], [1285, 230], [1270, 262], [1220, 270], [1178, 290], [1160, 290], [1130, 240], [1090, 240]] }],
    },
    {
      id: 'pineL', trunk: true, on: 'leftPlateau', base: [447, 390],
      parts: [{ mats: 'object', poly: [[318, 320], [360, 260], [400, 215], [460, 195], [520, 205], [565, 250], [560, 300], [490, 310], [470, 330], [468, 390], [430, 392], [425, 340], [360, 355], [325, 350]] }],
    },
  ] satisfies Card[] as Card[],

  /** Troncos e pilares (o resto das barreiras vem do material da pintura). */
  blockers: [
    // plintos dos pilares (~40 px de largura na pintura = 1,4 m)
    { id: 'toriiL', at: [905, 251], r: 0.6, on: 'top' },
    { id: 'toriiR', at: [1004, 289], r: 0.6, on: 'top' },
    { id: 'cherryL', at: [747, 212], r: 0.5, on: 'top' },
    { id: 'smallPine', at: [805, 318], r: 0.42, on: 'top' },
    { id: 'cherryR', at: [1268, 446], r: 0.38, on: 'path' },
    { id: 'pineR', at: [1208, 536], r: 0.38, on: 'path' },
    { id: 'pineTR', at: [1168, 288], r: 0.38, on: 'path' },
  ] satisfies Blocker[] as Blocker[],

  /** Cascata + rio (a água ali corre para baixo). */
  waterfall: [[585, 288], [645, 288], [705, 350], [705, 528], [636, 528], [598, 400]] as Pt[],

  spawn: { at: [860, 712] as Pt, on: 'beach' },
};
