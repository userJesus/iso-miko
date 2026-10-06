/**
 * Pipeline de sprites: sheets brutas (chroma verde, grade irregular gerada por IA)
 * → frames recortados, alinhados, com ciclo detectado → atlas WebP + manifest JSON.
 *
 *   node tools/build-sprites.ts            gera public/sprites/
 *   node tools/build-sprites.ts --debug    também grava pré-visualizações em .sprite-debug/
 *
 * Etapas por sheet (uma sheet = uma ação numa direção):
 *  1. chroma key com desmistura da cor do fundo + despill            (sprites/image.ts)
 *  2. remoção de ruído e, na conjuração, do fogo desenhado            (sprites/fire.ts)
 *  3. segmentação em frames por projeções                             (sprites/segment.ts)
 *  4. normalização de escala e alinhamento (tronco / pés)             (sprites/align.ts)
 *  5. ações em laço: período do passo, laço de 2 passos e pose de
 *     passagem como início/idle                                       (sprites/cycle.ts)
 *  6. atlas por ação + manifest
 * Efeitos: projétil (sprites/projectile.ts), poeira (sprites/dust.ts), explosão (sprites/explosion.ts).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ATLAS_SCALE, CELL_PAD, DEBUG, DIRECTIONS, OUT, SRC, median, type Dir } from './sprites/common.ts';
import { blit, chromaKey, cropRows, flipH, labelComponents, loadRgb, newImg, removeSpecks, saveImg, setPx, type Img } from './sprites/image.ts';
import { segment, segmentGrid } from './sprites/segment.ts';
import {
  despikeVertical, heightOf, normalizeScale, registerTorso, registerVertical, renderCell,
  type NormFrame, type SheetData,
} from './sprites/align.ts';
import { cellMetrics, detectLoop, lagProfile, poseSignature, sigDist, smoothSubset } from './sprites/cycle.ts';
import { detectFire, eraseMask, isAttached, type FireBlob } from './sprites/fire.ts';
import { writeDebug, writeFeetStrip } from './sprites/debug.ts';
import { processProjectile } from './sprites/projectile.ts';
import { processDust } from './sprites/dust.ts';
import { processExplosion } from './sprites/explosion.ts';
import { centroidAnchors, groundSlope, linkTransitions, normalizeTallestRow, slidePhases } from './sprites/slide.ts';

interface ActionSpec {
  /** Frames esperados por sheet (aviso se diferente). */
  expectedFrames: number;
  /** 'loop' = ciclo de passada; 'once' = disparo único, na ordem da sheet; 'pose' = frame único. */
  kind?: 'loop' | 'once' | 'pose';
  /**
   * Direções substituídas pelo espelho horizontal de outra (destino → origem).
   * Usado quando a sheet original tem defeito que o recorte não corrige.
   */
  mirror?: Partial<Record<Dir, Dir>>;
  /** Direções sem arte própria que reutilizam outra direção (sem linha extra no atlas). */
  alias?: Partial<Record<Dir, Dir>>;
  /**
   * Alinhamento vertical dos frames:
   * - 'feet': pé mais baixo na linha do chão (andar: sempre há um pé apoiado).
   * - 'torso': cabeça/tronco registrados entre si e chão no nível dos frames de contato
   *   (correr: na fase de voo os dois pés estão no ar; alinhar pelo pé faria o corpo
   *   afundar justamente quando deveria subir → "quique").
   */
  vertical?: 'feet' | 'torso';
  /**
   * Escala: 'row' normaliza cada linha da sheet (a IA muda a escala entre linhas);
   * 'sheet' usa uma escala por sheet — para ações em que a altura muda de verdade
   * com a pose (agachar, avançar), o que a normalização por linha apagaria.
   */
  scale?: 'row' | 'sheet' | 'tallestRow';
  /**
   * 'centroid': âncora no centro de massa da silhueta (ações de corpo inteiro, como o
   * deslize), sem o registro do tronco — que só faz sentido entre poses parecidas.
   */
  anchor?: 'torso' | 'centroid';
  /** Sincronia de pose com uma ação em laço (entrada/saída) e com a pose parada. */
  link?: { loop: string; idle: string };
  /**
   * Dimensiona cada direção para a altura da pose de passagem de outra ação em laço
   * (ex.: idle = altura de quem para de andar). Para arte desenhada em outra escala.
   */
  matchHeight?: string;
  /** Apaga o fogo desenhado e registra posição/tamanho por frame (manifest `fire`). */
  extractFire?: boolean;
  /**
   * Para que lado da tela (−1 esquerda, +1 direita) a arte arremessa, quando não dá para
   * deduzir da direção (padrão: sinal do lado da direção; N/S = indefinido).
   */
  throwSide?: Partial<Record<Dir, -1 | 1>>;
  /**
   * Ações em laço: direções em que só `n` frames do laço são usados, escolhidos para
   * minimizar os saltos das mãos (arte com braços incoerentes entre frames).
   */
  subset?: Partial<Record<Dir, number>>;
  /** Grade fixa [colunas, linhas] da sheet: segmentação para frames que se encostam. */
  grid?: [number, number];
}

interface CharacterSpec {
  id: string;
  actions: Record<string, ActionSpec>;
  /** Ação exibida parada (pose por direção, ou o 1º frame do laço de uma ação em laço). */
  idleFrom: string;
  /** Ação cuja altura define a escala px → metro da personagem. */
  heightRef: string;
}

const CHARACTERS: CharacterSpec[] = [
  {
    id: 'character',
    actions: {
      // walk/sw e walk/nw: na 3ª linha da sheet a IA girou o corpo (mais perfil / mais costas),
      // o que vira uma "torcida" a cada ciclo. SE e NE são consistentes → espelhados.
      walk: { expectedFrames: 18, mirror: { sw: 'se', nw: 'ne' } },
      // run/s: a arte desenha as mãos em posições quase aleatórias de um frame para o outro
      // (perfil de autocorrelação dos braços plano) → 12 frames com o movimento mais contínuo.
      run: { expectedFrames: 18, vertical: 'torso', subset: { s: 12 } },
      // Conjuração: não há arte virada para S; a de SW troca de orientação no meio e a de W
      // vira de costas (ver assets-src/character/cast/_nao-usadas). SW/W = espelho de SE/E;
      // S reutiliza SE (o jogo escolhe SE ou SW pelo último lado pressionado).
      cast: {
        expectedFrames: 18, kind: 'once', scale: 'sheet', extractFire: true,
        mirror: { sw: 'se', w: 'e' }, alias: { s: 'se' },
        throwSide: { n: -1 }, // a arte de N arremessa para cima e à esquerda
      },
      // Idle: uma pose por direção, desenhada ~3× maior que as outras sheets → dimensionada
      // pela pose de passagem do andar (o frame de onde ela para), sem salto de tamanho.
      idle: { expectedFrames: 1, kind: 'pose', matchHeight: 'walk' },
      // Deslize: corrida (0–2) → chão (3–10) → levanta e volta a correr. Só SE, O e NO têm o
      // deslize "deitada, pés à frente" do começo ao fim; nas outras a IA trocou de estilo no
      // meio (L de frente ajoelhada, NE/N de joelhos para a direita, S de perfil, SO avanço
      // agachado). SO/L/NE = espelhos; S/N usam a diagonal do último lado pressionado.
      slide: {
        expectedFrames: 18, kind: 'once', grid: [6, 3], scale: 'tallestRow', matchHeight: 'run', anchor: 'centroid',
        mirror: { sw: 'se', e: 'w', ne: 'nw' }, alias: { s: 'se', n: 'nw' },
        link: { loop: 'run', idle: 'idle' },
      },
    },
    idleFrom: 'idle',
    heightRef: 'walk',
  },
];

/** Largura máxima segura de textura (WebGL garante ≥ 4096). */
const MAX_ATLAS_W = 4096;

interface DirOut {
  /** Células do atlas (índice = linha × colunas + coluna), na ordem de reprodução. */
  frames: number[];
  idle?: number;
  closure?: number;
  mirrorOf?: Dir;
  aliasOf?: Dir;
  /** Por frame: [x, y, raio] do fogo em px do atlas relativos aos pés (y para cima) e se está na mão. */
  fire?: ([number, number, number, 0 | 1] | null)[];
  /** Índice (em `frames`) do frame em que a bola sai da mão. */
  release?: number;
  /** Raio típico da bola na mão (px do atlas) — tamanho do projétil. */
  ballRadius?: number;
  /** Fases e sincronia de uma ação ligada à corrida (deslize). */
  slide?: {
    contact: number; rise: number; lie: number[];
    entry: [number, number][]; idleExit: number; runExit: number; runExitPhase: number;
  };
}

interface SourceDir {
  sheet: SheetData;
  norm: NormFrame[];
  /** Blob de fogo por frame (coordenadas da sheet). */
  fire: (FireBlob & { attached: boolean } | null)[];
}

async function loadSheet(spec: CharacterSpec, action: string, aspec: ActionSpec, dir: Dir) {
  const file = path.join(SRC, spec.id, action, `${dir}.webp`);
  const raw = await loadRgb(file);
  const img = chromaKey(raw);
  let fireBlobs: FireBlob[] = [];
  if (aspec.extractFire) {
    const fire = detectFire(raw.rgb, raw.w, raw.h);
    eraseMask(img, fire.mask);
    fireBlobs = fire.blobs;
  }
  removeSpecks(img);
  let frames;
  let sheetImg = img;
  if (aspec.grid) {
    const mask = new Uint8Array(img.w * img.h);
    for (let i = 0; i < mask.length; i++) mask[i] = img.px[i * 4 + 3] >= 128 ? 1 : 0;
    const { labels, areas } = labelComponents(mask, img.w, img.h);
    ({ img: sheetImg, frames } = segmentGrid(img, aspec.grid[0], aspec.grid[1], labels, areas));
  } else frames = segment(img);
  if (frames.length !== aspec.expectedFrames) {
    console.warn(`! ${action}/${dir}: ${frames.length} frames (esperado ${aspec.expectedFrames})`);
  }
  // Dono de cada bola: se encosta em exatamente um personagem, é dele (bola na mão).
  // Se está solta ou encosta em dois (a IA desenha os frames colados), é do personagem
  // que está atrás dela no sentido do arremesso — a bola lançada para a esquerda invade
  // a célula do frame anterior, então a célula nominal da grade não serve.
  const side = aspec.throwSide?.[dir] ?? Math.sign(Math.round(Math.sin((DIRECTIONS.indexOf(dir) * Math.PI) / 4) * 1000));
  // Distância vertical até a faixa (linha da sheet) do frame — todos da linha empatam.
  const bandDist = (f: (typeof frames)[number], y: number) => (y < f.y0 ? f.y0 - y : y > f.y1 ? y - f.y1 : 0);
  const fire = frames.map(() => null as (FireBlob & { attached: boolean }) | null);
  for (const b of fireBlobs) {
    const touching = frames.filter((f) => isAttached(img, b, f));
    let owner: (typeof frames)[number] | undefined = touching.length === 1 ? touching[0] : undefined;
    if (!owner) {
      const nearestBand = Math.min(...frames.map((f) => bandDist(f, b.cy)));
      const pool = touching.length > 1 ? touching : frames.filter((f) => bandDist(f, b.cy) === nearestBand);
      const behind = pool.filter((f) => side === 0 || (b.cx - f.torsoX) * side >= 0);
      owner = (behind.length ? behind : pool).reduce((a, f) => (Math.abs(b.cx - f.torsoX) < Math.abs(b.cx - a.torsoX) ? f : a));
    }
    const k = frames.indexOf(owner);
    if (!fire[k] || fire[k]!.area < b.area) fire[k] = { ...b, attached: touching.includes(owner) };
  }
  return { sheet: { action, dir, img: sheetImg, frames } as SheetData, fire };
}

function normalizeSheetScale(sheet: SheetData, targetH: number): NormFrame[] {
  const s = targetH / median(sheet.frames.map(heightOf));
  return sheet.frames.map((raw) => ({ raw, s, ax: raw.torsoX, ay: raw.by1 + 1 }));
}

interface ActionResult {
  manifest: Record<string, unknown>;
  /** Altura da pose de passagem (px do atlas), mediana das direções — só ações em laço. */
  passingHeight?: number;
  /** Células renderizadas por direção (para sincronia de pose entre ações). */
  cellsByDir: Map<Dir, Img[]>;
  /** Ordem de reprodução (índices em cellsByDir) por direção. */
  orderByDir: Map<Dir, number[]>;
  anchor: [number, number];
}

async function processAction(spec: CharacterSpec, action: string, aspec: ActionSpec, done: Map<string, ActionResult>): Promise<ActionResult> {
  const kind = aspec.kind ?? 'loop';
  const derived = { ...aspec.mirror, ...aspec.alias };
  const sourceDirs = DIRECTIONS.filter((d) => !(d in derived));
  const sources = new Map<Dir, SourceDir>();
  for (const dir of sourceDirs) {
    const { sheet, fire } = await loadSheet(spec, action, aspec, dir);
    sources.set(dir, { sheet, fire, norm: [] });
  }

  // Escala: altura-alvo = mediana de todas as alturas da ação, ou a pose de passagem de outra.
  const all = [...sources.values()];
  let targetH = median(all.flatMap((s) => s.sheet.frames.map(heightOf)));
  if (aspec.matchHeight) {
    const ref = done.get(aspec.matchHeight)?.passingHeight;
    if (!ref) throw new Error(`${action}: matchHeight "${aspec.matchHeight}" precisa ser uma ação em laço processada antes`);
    targetH = ref / ATLAS_SCALE;
  }
  for (const src of all) {
    src.norm = aspec.scale === 'tallestRow' ? normalizeTallestRow(src.sheet, targetH)
      : aspec.scale === 'sheet' || aspec.matchHeight ? normalizeSheetScale(src.sheet, targetH)
      : normalizeScale(src.sheet, targetH);
    if (aspec.anchor === 'centroid') {
      centroidAnchors(src.sheet, src.norm, src.sheet.dir);
      continue;
    }
    registerTorso(src.sheet, src.norm, targetH);
    if (aspec.vertical === 'torso') {
      const lift = registerVertical(src.sheet, src.norm, targetH);
      registerTorso(src.sheet, src.norm, targetH);
      if (DEBUG) console.log(`  ${action}/${src.sheet.dir} pés acima do chão (px): ${lift.join(' ')}`);
    } else if (kind === 'loop') {
      const fixes = despikeVertical(src.norm);
      if (DEBUG && fixes.some((f) => f !== 0)) console.log(`  ${action}/${src.sheet.dir} correção vertical (px): ${fixes.join(' ')}`);
    }
  }

  // Célula: maior extensão a partir da âncora, em px do atlas
  let left = 0, right = 0, up = 0, down = 0;
  for (const src of all) for (const nf of src.norm) {
    const f = nf.raw, k = nf.s * ATLAS_SCALE;
    left = Math.max(left, (nf.ax - f.bx0) * k);
    right = Math.max(right, (f.bx1 + 1 - nf.ax) * k);
    up = Math.max(up, (nf.ay - f.by0) * k);
    down = Math.max(down, (f.by1 + 1 - nf.ay) * k);
  }
  const half = Math.ceil(Math.max(left, right)) + CELL_PAD;
  const cellW = half * 2, anchorX = half;
  const anchorY = Math.ceil(up) + CELL_PAD;
  const cellH = anchorY + Math.ceil(down) + CELL_PAD;
  const nFrames = Math.max(...all.map((s) => s.sheet.frames.length));

  // Direções com linha própria no atlas (origens + espelhos); apelidos reutilizam outra.
  const atlasDirs = DIRECTIONS.filter((d) => !aspec.alias?.[d]);
  // Uma linha por direção; se não couber, divide os frames da direção em linhas iguais.
  const rowsPerDir = Math.ceil(nFrames / Math.floor(MAX_ATLAS_W / cellW));
  const cols = Math.ceil(nFrames / rowsPerDir);
  const atlas = newImg(cellW * cols, cellH * rowsPerDir * atlasDirs.length);
  const cellIndex = (slot: number, f: number) => slot * rowsPerDir * cols + f;

  const cellsByDir = new Map<Dir, Img[]>();
  const fireByDir = new Map<Dir, DirOut['fire']>();
  for (const [dir, src] of sources) {
    cellsByDir.set(dir, src.norm.map((nf) => renderCell(src.sheet, nf, cellW, cellH, anchorX, anchorY)));
    if (aspec.extractFire) {
      fireByDir.set(dir, src.fire.map((b, i) => {
        if (!b) return null;
        const nf = src.norm[i], k = nf.s * ATLAS_SCALE;
        return [+((b.cx - nf.ax) * k).toFixed(1), +((nf.ay - b.cy) * k).toFixed(1), +(b.r * k).toFixed(1), b.attached ? 1 : 0];
      }));
    }
  }
  for (const [dst, src] of Object.entries(aspec.mirror ?? {}) as [Dir, Dir][]) {
    cellsByDir.set(dst, cellsByDir.get(src)!.map(flipH));
    const f = fireByDir.get(src);
    if (f) fireByDir.set(dst, f.map((v) => (v ? [-v[0], v[1], v[2], v[3]] : null)));
    console.log(`${action}/${dst}: espelho de ${src}`);
  }
  atlasDirs.forEach((dir, slot) => cellsByDir.get(dir)!.forEach((c, i) => {
    const idx = cellIndex(slot, i);
    blit(c, atlas, (idx % cols) * cellW, Math.floor(idx / cols) * cellH);
  }));

  const dirs: Partial<Record<Dir, DirOut>> = {};
  let stride: number | undefined;
  const passingHeights: number[] = [];
  const orderByDir = new Map<Dir, number[]>();

  if (kind === 'loop') {
    // Período do passo: média dos perfis de autocorrelação das pernas de todas as direções
    const legY0 = Math.round(anchorY * 0.6);
    const lagMean: number[] = [];
    for (const dir of atlasDirs) {
      const legs = cellsByDir.get(dir)!.map((c) => poseSignature(cropRows(c, legY0, anchorY)));
      const prof = lagProfile(legs.map((a) => legs.map((b) => sigDist(a, b))), 13);
      prof.forEach((v, k) => (lagMean[k] = (lagMean[k] ?? 0) + v / prof[0] / atlasDirs.length));
    }
    let period = 5;
    for (let k = 5; k <= 13; k++) if (lagMean[k - 1] < lagMean[period - 1]) period = k;
    console.log(`${action}: período do passo = ${period} frames (ciclo = ${2 * period})`);

    const strideSamples: number[] = [];
    const sideViews: { dir: Dir; cells: Img[]; order: number[] }[] = [];
    for (const [slot, dir] of atlasDirs.entries()) {
      const cells = cellsByDir.get(dir)!;
      const sigs = cells.map((c) => poseSignature(c));
      const dist = sigs.map((a) => sigs.map((b) => sigDist(a, b)));
      const loop = detectLoop(dist, period);
      const inLoop = Array.from({ length: loop.length }, (_, i) => loop.start + i);

      // Pose de passagem (silhueta mais alta, pés mais juntos) → idle e início do laço,
      // para que todas as direções e ações comecem na mesma fase da passada.
      const metrics = cells.map((c) => cellMetrics(c, anchorY));
      const hMax = Math.max(...inLoop.map((i) => metrics[i].height));
      const spanMax = Math.max(...inLoop.map((i) => metrics[i].feetSpan));
      const score = (i: number) => metrics[i].height / hMax - 0.6 * (metrics[i].feetSpan / spanMax);
      const idle = inLoop.reduce((best, i) => (score(i) > score(best) ? i : best), inLoop[0]);
      const k0 = inLoop.indexOf(idle);
      let order = [...inLoop.slice(k0), ...inLoop.slice(0, k0)];
      passingHeights.push(metrics[idle].height);
      const keep = aspec.subset?.[dir];
      if (keep && keep < order.length) {
        const sub = smoothSubset(cells, order, keep, anchorY, Math.round(targetH * ATLAS_SCALE));
        console.log(`  ${action}/${dir}: subconjunto de ${keep}/${order.length} frames [${sub.order.join(',')}] · ` +
          `salto médio das mãos ${(sub.before * 1000).toFixed(1)} → ${(sub.after * 1000).toFixed(1)}`);
        order = sub.order;
      }

      if (dir === 'e' || dir === 'w') {
        // Ciclo = 2 passos; cada passo ≈ abertura máxima − mínima dos pés.
        const spans = order.map((i) => metrics[i].feetSpan);
        strideSamples.push(2 * (Math.max(...spans) - Math.min(...spans)));
        sideViews.push({ dir, cells, order });
        console.log(`  passada ${action}/${dir}: ${strideSamples.at(-1)}px do atlas por ciclo`);
      }

      // Estabilidade da cabeça: salto entre frames consecutivos do laço (px do atlas).
      const heads = order.map((i) => metrics[i].height);
      const headJump = Math.max(...heads.map((h, k) => Math.abs(h - heads[(k + 1) % heads.length])));
      const flags = [loop.closure > 1.8 ? '⚠ fechamento ruim' : '', headJump > 6 ? '⚠ cabeça pulando' : ''].filter(Boolean);
      console.log(`${action}/${dir}: laço ${loop.start}..${loop.start + loop.length - 1} (${loop.length}f) ` +
        `fecha ${loop.closure.toFixed(2)}× · cabeça ±${Math.max(...heads) - Math.min(...heads)}px (salto ${headJump}) · ` +
        `início/idle=${idle} ${flags.join(' ')}`);
      orderByDir.set(dir, order);
      dirs[dir] = {
        frames: order.map((i) => cellIndex(slot, i)), idle: cellIndex(slot, idle),
        closure: +loop.closure.toFixed(3), mirrorOf: aspec.mirror?.[dir],
      };
      if (DEBUG) await writeDebug(action, dir, cells, order, idle, anchorX, anchorY);
    }
    stride = Math.round(strideSamples.reduce((a, b) => a + b, 0) / strideSamples.length);
    console.log(`  passada média: ${stride}px do atlas por ciclo`);
    if (DEBUG) for (const v of sideViews) await writeFeetStrip(action, v.dir, v.cells, v.order, stride, anchorY, Math.round(targetH * ATLAS_SCALE));
  } else {
    for (const [slot, dir] of atlasDirs.entries()) {
      const cells = cellsByDir.get(dir)!;
      const order = cells.map((_, i) => i);
      orderByDir.set(dir, order);
      const out: DirOut = { frames: order.map((i) => cellIndex(slot, i)), mirrorOf: aspec.mirror?.[dir] };
      if (aspec.link) {
        const loop = done.get(aspec.link.loop), idle = done.get(aspec.link.idle);
        if (!loop) throw new Error(`${action}: link.loop "${aspec.link.loop}" precisa ser processada antes`);
        const phases = slidePhases(cells.map((c) => cellMetrics(c, anchorY).height));
        const idleCells = idle?.cellsByDir.get(dir);
        const link = linkTransitions({
          cells, anchor: [anchorX, anchorY], height: loop.passingHeight ?? Math.round(targetH * ATLAS_SCALE), phases,
          loopCells: loop.cellsByDir.get(dir)!, loopOrder: loop.orderByDir.get(dir)!, loopAnchor: loop.anchor,
          idleCell: idleCells?.[0] ?? null, idleAnchor: idle?.anchor ?? [0, 0],
        });
        out.slide = {
          contact: phases.contact, rise: phases.rise, lie: phases.lie,
          entry: link.entry, idleExit: link.idleExit, runExit: link.runExit, runExitPhase: link.runExitPhase,
        };
        const q = link.quality;
        const waits = link.entry.filter((e) => e[0] > 0).length;
        console.log(`${action}/${dir}: chão ${phases.contact}..${phases.rise - 1} · parada após f${link.idleExit} ` +
          `· volta a correr após f${link.runExit} (fase ${link.runExitPhase}) · inclinação ${groundSlope(dir).toFixed(2)}
` +
          `    encaixe (distância ÷ passo da corrida): entrada ${q.entry.toFixed(2)} · saída ${q.runExit.toFixed(2)} · ` +
          `parada ${q.idleExit.toFixed(2)} · espera p/ encaixar em ${waits}/${link.entry.length} posições`);
      }
      const fire = fireByDir.get(dir);
      if (fire) {
        // Raio típico da bola (mediana das bolas na mão que não são só faísca).
        const heldR = fire.filter((f) => f?.[3] === 1).map((f) => f![2]);
        const ball = median(heldR.filter((r) => r >= 0.5 * Math.max(...heldR)));
        out.ballRadius = +ball.toFixed(1);
        // Soltura: primeiro frame com uma bola (não faísca) fora da mão depois de ela ter estado na mão.
        const firstHeld = fire.findIndex((f) => f?.[3] === 1 && f[2] >= 0.5 * ball);
        const rel = fire.findIndex((f, i) => i > firstHeld && f !== null && f[3] === 0 && f[2] >= 0.5 * ball);
        out.release = rel >= 0 ? rel : Math.max(0, fire.findLastIndex((f) => f !== null));
        // Depois da soltura o jogo desenha o projétil; antes dela, só interessa a bola na mão.
        // Lacunas entre frames com bola na mão (a arte "esquece" a bola) são interpoladas.
        for (let i = 0; i < fire.length; i++) {
          if (i >= out.release) { if (i > out.release) fire[i] = null; continue; }
          if (fire[i]) continue;
          const a = fire.slice(0, i).findLastIndex((f) => f?.[3] === 1);
          const b = fire.findIndex((f, j) => j > i && j < out.release! && f?.[3] === 1);
          if (a < 0 || b < 0) continue;
          const t = (i - a) / (b - a), A = fire[a]!, B = fire[b]!;
          fire[i] = [0, 1, 2].map((c) => +(A[c] + (B[c] - A[c]) * t).toFixed(1)).concat(1) as [number, number, number, 1];
        }
        out.fire = fire;
        const r = fire[out.release];
        console.log(`${action}/${dir}: ${order.length}f · fogo na mão ${fire.filter((f) => f?.[3] === 1).length}f · ` +
          `soltura no frame ${out.release} em (${r?.[0]}, ${r?.[1]}) · bola r=${out.ballRadius}` +
          `${rel < 0 ? ' ⚠ soltura não detectada (último frame com fogo)' : ''}`);
      }
      dirs[dir] = out;
      if (DEBUG) {
        const marked = cells.map((c, i) => {
          const f = out.fire?.[i];
          if (!f) return c;
          const m = { w: c.w, h: c.h, px: new Uint8ClampedArray(c.px) };
          const cx = anchorX + f[0], cy = anchorY - f[1];
          for (let a = 0; a < 64; a++) {
            const t = (a / 64) * Math.PI * 2;
            setPx(m, Math.round(cx + Math.cos(t) * f[2]), Math.round(cy + Math.sin(t) * f[2]), f[3] ? [0, 200, 255] : [255, 0, 200]);
          }
          return m;
        });
        await writeDebug(action, dir, marked, order, out.release ?? out.slide?.contact ?? -1, anchorX, anchorY);
      }
    }
  }
  for (const [dst, src] of Object.entries(aspec.alias ?? {}) as [Dir, Dir][]) {
    dirs[dst] = { ...dirs[src]!, aliasOf: src };
    console.log(`${action}/${dst}: usa ${src}`);
  }

  await saveImg(atlas, path.join(OUT, spec.id, `${action}.webp`));
  const passingHeight = passingHeights.length ? median(passingHeights) : undefined;
  console.log(`→ ${action}.webp ${atlas.w}×${atlas.h} (célula ${cellW}×${cellH}, âncora ${anchorX},${anchorY}, ` +
    `altura ${Math.round(targetH * ATLAS_SCALE)}${passingHeight ? `, pose de passagem ${passingHeight}` : ''})
`);
  return { passingHeight, cellsByDir, orderByDir, anchor: [anchorX, anchorY], manifest: {
    kind,
    image: `${action}.webp`,
    cell: [cellW, cellH],
    anchor: [anchorX, anchorY],
    grid: [cols, rowsPerDir * atlasDirs.length],
    /** Altura média da personagem nesta ação, em px do atlas. */
    height: Math.round(targetH * ATLAS_SCALE),
    /** Distância horizontal (px do atlas) percorrida por ciclo do laço. */
    stride,
    directions: dirs,
  } };
}

async function processCharacter(spec: CharacterSpec) {
  // O idle de cada direção é o 1º frame do laço da ação `idleAction` (pose de passagem).
  const manifest = {
    id: spec.id, directions: DIRECTIONS, idleAction: spec.idleFrom, heightRef: spec.heightRef,
    actions: {} as Record<string, unknown>,
  };
  const done = new Map<string, ActionResult>();
  for (const [action, aspec] of Object.entries(spec.actions)) {
    const res = await processAction(spec, action, aspec, done);
    done.set(action, res);
    manifest.actions[action] = res.manifest;
  }
  await fsp.writeFile(path.join(OUT, spec.id, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

async function main() {
  for (const spec of CHARACTERS) await processCharacter(spec);
  const fxFile = path.join(SRC, 'fx', 'fireball.png');
  if (fs.existsSync(fxFile)) await processProjectile(fxFile, path.join(OUT, 'fx'), 'fireball');
  // Explosão ao bater: 2 frames da bola chegando + 6 da explosão por linha.
  const explosionFile = path.join(SRC, 'fx', 'explosion.png');
  if (fs.existsSync(explosionFile)) await processExplosion(explosionFile, path.join(OUT, 'fx'), 'explosion', { approach: 2 });
  const dustFile = path.join(SRC, 'fx', 'dust.png');
  // Linhas da sheet de poeira (conferidas no atlas): rastros por direção e dois estouros.
  if (fs.existsSync(dustFile)) {
    await processDust(dustFile, path.join(OUT, 'fx'), 'dust', {
      byDir: { e: 0, w: 1, se: 4, sw: 5, ne: 6, nw: 7 },
      burst: { right: 2, left: 3 },
    });
  }
}

await main();
