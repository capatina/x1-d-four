import { random } from './shared';

// The rune atlas: 16 abstract glyphs (3–5 strokes on a 3×5 grid, seeded) and
// the four deck sigils ◆ ▲ ● ■, drawn once into one canvas. Gate rings, loop
// rings and the waveform strip all read from it. Runes are strokes, never letters.

export const ATLAS_COLS = 5;
export const ATLAS_ROWS = 4;
export const ATLAS_CELL = 128;
export const RUNES = 16;
/** Atlas cell of deck n's sigil. */
export const SIGIL_CELL = (deck: number) => RUNES + deck;

/** Deck sigils as SVG path data on a 0..24 box: diamond, triangle, circle, square. */
export const SIGIL_PATHS = [
  'M12 2 L22 12 L12 22 L2 12 Z',
  'M12 3 L22 20.5 L2 20.5 Z',
  'M12 2.5 A9.5 9.5 0 1 1 11.99 2.5 Z',
  'M3.5 3.5 H20.5 V20.5 H3.5 Z',
] as const;

let atlas: HTMLCanvasElement | null = null;

/** White strokes on transparent; tint at use. Built once, on first use. */
export function runeAtlas(): HTMLCanvasElement {
  if (atlas) return atlas;
  const c = document.createElement('canvas');
  c.width = ATLAS_COLS * ATLAS_CELL;
  c.height = ATLAS_ROWS * ATLAS_CELL;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');
  const r = random(1979);
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (let i = 0; i < RUNES; i++) {
    const ox = (i % ATLAS_COLS) * ATLAS_CELL,
      oy = Math.floor(i / ATLAS_COLS) * ATLAS_CELL;
    // A 3×5 grid inside the cell: x 34..94, y 14..114.
    const px = (gx: number) => ox + 34 + gx * 30;
    const py = (gy: number) => oy + 14 + gy * 25;
    g.lineWidth = 13;
    // Every rune has a stave, so they read as one script.
    const stave = Math.floor(r() * 3);
    g.beginPath();
    g.moveTo(px(stave), py(0));
    g.lineTo(px(stave), py(4));
    const strokes = 2 + Math.floor(r() * 3);
    for (let s = 0; s < strokes; s++) {
      const x0 = Math.floor(r() * 3),
        y0 = Math.floor(r() * 5);
      // Short diagonal or horizontal strokes off the grid points.
      let x1 = Math.max(0, Math.min(2, x0 + (r() < 0.5 ? -1 : 1) * (1 + Math.floor(r() * 2))));
      let y1 = Math.max(0, Math.min(4, y0 + Math.floor(r() * 3) - 1));
      if (x1 === x0 && y1 === y0) x1 = x0 === 2 ? 0 : 2;
      if (r() < 0.25) y1 = y0;
      g.moveTo(px(x0), py(y0));
      g.lineTo(px(x1), py(y1));
    }
    g.stroke();
  }
  for (let d = 0; d < 4; d++) {
    const cell = SIGIL_CELL(d);
    const ox = (cell % ATLAS_COLS) * ATLAS_CELL,
      oy = Math.floor(cell / ATLAS_COLS) * ATLAS_CELL;
    g.save();
    g.translate(ox + 16, oy + 16);
    g.scale(96 / 24, 96 / 24);
    g.fill(new Path2D(SIGIL_PATHS[d]));
    g.restore();
  }
  atlas = c;
  return c;
}

/** A small tinted copy of one atlas cell (for the 2D strip), made at setup, not per frame. */
export function tintedCell(cell: number, size: number, color: string): HTMLCanvasElement {
  const src = runeAtlas();
  const c = document.createElement('canvas');
  c.width = c.height = Math.max(1, Math.round(size));
  const g = c.getContext('2d');
  if (!g) return c;
  g.drawImage(
    src,
    (cell % ATLAS_COLS) * ATLAS_CELL,
    Math.floor(cell / ATLAS_COLS) * ATLAS_CELL,
    ATLAS_CELL,
    ATLAS_CELL,
    0,
    0,
    c.width,
    c.height,
  );
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}
