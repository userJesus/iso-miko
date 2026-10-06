/** Segmentação de uma sheet em frames por projeções (linhas → colunas). */
import { alphaAt, type Img } from './image.ts';

export interface Span { a: number; b: number } // [a, b] inclusivo

export function runs(profile: number[], minGap: number): Span[] {
  const out: Span[] = [];
  let cur: Span | null = null;
  let gap = 0;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i] > 0) {
      if (cur && gap < minGap) cur.b = i;
      else { cur = { a: i, b: i }; out.push(cur); }
      gap = 0;
    } else if (cur) gap++;
  }
  return out;
}

/** Junta faixas estreitas (pedaços soltos: borla, mecha de cabelo) à vizinha mais próxima. */
export function mergeNarrow(spans: Span[], minSize: number): Span[] {
  const s = spans.map((x) => ({ ...x }));
  for (;;) {
    const i = s.findIndex((x) => x.b - x.a + 1 < minSize);
    if (i < 0 || s.length < 2) return s;
    const gapL = i > 0 ? s[i].a - s[i - 1].b : Infinity;
    const gapR = i < s.length - 1 ? s[i + 1].a - s[i].b : Infinity;
    const j = gapL <= gapR ? i - 1 : i + 1;
    const merged = { a: Math.min(s[i].a, s[j].a), b: Math.max(s[i].b, s[j].b) };
    s.splice(Math.min(i, j), 2, merged);
  }
}

export interface RawFrame {
  /** Recorte da sheet (coordenadas da sheet). */
  x0: number; y0: number; x1: number; y1: number;
  /** BBox do personagem dentro da sheet. */
  bx0: number; by0: number; bx1: number; by1: number;
  /** Centro horizontal do tronco (sheet). */
  torsoX: number;
}

export function segment(img: Img): RawFrame[] {
  const { w, h } = img;
  const rowProf = new Array(h).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alphaAt(img, x, y) >= 128) rowProf[y]++;
  const bands = mergeNarrow(runs(rowProf, 6), 80);
  const frames: RawFrame[] = [];
  for (const band of bands) {
    const colProf = new Array(w).fill(0);
    for (let y = band.a; y <= band.b; y++) for (let x = 0; x < w; x++) if (alphaAt(img, x, y) >= 128) colProf[x]++;
    const cols = mergeNarrow(runs(colProf, 4), 60);
    for (const col of cols) {
      const f = measure(img, col.a, band.a, col.b, band.b);
      if (f) frames.push(f);
    }
  }
  return frames;
}

export function measure(img: Img, x0: number, y0: number, x1: number, y1: number): RawFrame | null {
  let bx0 = Infinity, by0 = Infinity, bx1 = -1, by1 = -1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (alphaAt(img, x, y) < 128) continue;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
  }
  if (bx1 < 0) return null;
  // Centro do tronco: centróide da faixa entre 18% e 55% da altura (abaixo da cabeça,
  // onde o cabelo esvoaça, e acima das pernas, que abrem e fecham).
  const hh = by1 - by0 + 1;
  const ta = by0 + Math.round(hh * 0.18), tb = by0 + Math.round(hh * 0.55);
  let sx = 0, n = 0;
  for (let y = ta; y <= tb; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const a = alphaAt(img, x, y);
      if (a >= 128) { sx += x; n++; }
    }
  }
  return { x0, y0, x1, y1, bx0, by0, bx1, by1, torsoX: sx / n };
}

/** Corte no vale (menor perfil) perto de cada fronteira nominal de uma grade uniforme. */
function gridCuts(profile: number[], from: number, to: number, n: number) {
  const len = to - from, cell = len / n, win = Math.round(cell * 0.32);
  const cuts = [from];
  for (let i = 1; i < n; i++) {
    const nominal = Math.round(from + i * cell);
    let best = nominal, bestCost = Infinity;
    for (let x = Math.max(from + 1, nominal - win); x <= Math.min(to - 1, nominal + win); x++) {
      // Leve preferência pela posição nominal entre vales de mesma profundidade.
      const cost = profile[x] + 0.02 * Math.abs(x - nominal);
      if (cost < bestCost) { bestCost = cost; best = x; }
    }
    cuts.push(best);
  }
  cuts.push(to);
  return cuts;
}

/**
 * Segmentação por grade fixa (colunas × linhas) para sheets em que frames vizinhos se
 * encostam (personagem deitada, braços abertos) e a separação por colunas vazias falha.
 * - cortes no vale do perfil de opacidade perto de cada fronteira nominal da grade;
 * - cada componente conexa vai inteira para o frame que contém a maior parte dela
 *   (um pé que invade a célula vizinha continua com o próprio corpo); só componentes
 *   realmente divididas (dois personagens colados) são cortadas na linha de corte;
 * - os frames são reempacotados numa imagem nova, separados, para o resto do pipeline.
 */
export function segmentGrid(img: Img, cols: number, rows: number, labels: Int32Array, areas: number[]) {
  const { w, h } = img;
  const opaque = (i: number) => img.px[i * 4 + 3] >= 128;
  const rowProf = new Array(h).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (opaque(y * w + x)) rowProf[y]++;
  const yCuts = gridCuts(rowProf, 0, h, rows);
  const xCuts: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const colProf = new Array(w).fill(0);
    for (let y = yCuts[r]; y < yCuts[r + 1]; y++) for (let x = 0; x < w; x++) if (opaque(y * w + x)) colProf[x]++;
    xCuts.push(gridCuts(colProf, 0, w, cols));
  }
  const slotAt = (x: number, y: number) => {
    let r = 0;
    while (r < rows - 1 && y >= yCuts[r + 1]) r++;
    let c = 0;
    while (c < cols - 1 && x >= xCuts[r][c + 1]) c++;
    return r * cols + c;
  };

  // Votos de cada componente por célula
  const votes = areas.map(() => new Map<number, number>());
  for (let i = 0; i < w * h; i++) {
    const l = labels[i];
    if (l < 0 || !opaque(i)) continue;
    const s = slotAt(i % w, (i / w) | 0);
    votes[l].set(s, (votes[l].get(s) ?? 0) + 1);
  }
  const owner = votes.map((v, l) => {
    let best = -1, n = 0;
    for (const [s, c] of v) if (c > n) { n = c; best = s; }
    return n >= 0.75 * areas[l] ? best : -1; // -1 = dividir pela grade
  });
  const slot = new Int32Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) {
    if (!opaque(i)) continue;
    const l = labels[i];
    slot[i] = l >= 0 && owner[l] >= 0 ? owner[l] : slotAt(i % w, (i / w) | 0);
  }
  // Borda semitransparente segue o pixel opaco mais próximo (raio 2).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (slot[i] >= 0 || img.px[i * 4 + 3] === 0) continue;
      let s = -1;
      for (let d = 1; d <= 2 && s < 0; d++) {
        for (let dy = -d; dy <= d && s < 0; dy++) {
          for (let dx = -d; dx <= d && s < 0; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h && slot[yy * w + xx] >= 0 && opaque(yy * w + xx)) s = slot[yy * w + xx];
          }
        }
      }
      slot[i] = s >= 0 ? s : slotAt(x, y);
    }
  }

  // Reempacota: cada frame numa célula própria, mesmo y0 por linha original.
  const n = cols * rows;
  const bb = Array.from({ length: n }, () => ({ x0: Infinity, y0: Infinity, x1: -1, y1: -1 }));
  for (let i = 0; i < w * h; i++) {
    const s = slot[i];
    if (s < 0) continue;
    const x = i % w, y = (i / w) | 0, b = bb[s];
    if (x < b.x0) b.x0 = x;
    if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y;
    if (y > b.y1) b.y1 = y;
  }
  const pad = 8;
  const cw = Math.max(...bb.map((b) => (b.x1 >= 0 ? b.x1 - b.x0 + 1 : 0))) + 2 * pad;
  const ch = Math.max(...bb.map((b) => (b.y1 >= 0 ? b.y1 - b.y0 + 1 : 0))) + 2 * pad;
  const out: Img = { w: cw * cols, h: ch * rows, px: new Uint8ClampedArray(cw * cols * ch * rows * 4) };
  for (let i = 0; i < w * h; i++) {
    const s = slot[i];
    if (s < 0) continue;
    const b = bb[s];
    const ox = (s % cols) * cw + pad + (i % w) - b.x0;
    // Base dos pés alinhada na célula (o y absoluto não importa para o pipeline).
    const oy = Math.floor(s / cols) * ch + pad + ((i / w) | 0) - b.y0 + (ch - 2 * pad - (b.y1 - b.y0 + 1));
    out.px.set(img.px.subarray(i * 4, i * 4 + 4), (oy * out.w + ox) * 4);
  }
  const frames: RawFrame[] = [];
  /** Célula da grade (linha × colunas + coluna) de cada frame encontrado. */
  const slots: number[] = [];
  for (let s = 0; s < n; s++) {
    if (bb[s].x1 < 0) continue;
    const cx = (s % cols) * cw, cy = Math.floor(s / cols) * ch;
    const f = measure(out, cx, cy, cx + cw - 1, cy + ch - 1);
    if (f) { frames.push(f); slots.push(s); }
  }
  return { img: out, frames, slots };
}
