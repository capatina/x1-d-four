import { ATLAS_COLS, ATLAS_ROWS, random } from './shared';

export { ATLAS_COLS, ATLAS_ROWS };

// The rune atlas: 16 abstract glyphs (3–5 strokes on a 3×5 grid, seeded) and
// the four deck sigils ◆ ▲ ● ■, drawn once into one canvas. Gate rings, loop
// rings and the waveform strip all read from it. Runes are strokes, never letters.

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

/** Keeper cells: 4 hooded figures seen from behind, 128 × 192 each. */
export const KEEPER_W = 128;
export const KEEPER_H = 192;
/** Where each Keeper's hand holds the pole (cell px), and which side it reaches to. */
export const KEEPER_HANDS = [
  [95, 96],
  [33, 100],
  [97, 101],
  [31, 95],
] as const;

let keepers: HTMLCanvasElement | null = null;

/**
 * Four Keepers: hooded cloaks from behind, one arm out to the lantern pole.
 * No faces, no hats. Red = cloak shade, green = the rim the lantern lights,
 * alpha = coverage; the shader adds pole, lantern and light.
 */
export function keeperAtlas(): HTMLCanvasElement {
  if (keepers) return keepers;
  const c = document.createElement('canvas');
  c.width = KEEPER_W * 4;
  c.height = KEEPER_H;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');
  const r = random(4021);
  for (let k = 0; k < 4; k++) {
    const ox = k * KEEPER_W;
    const [hx, hy] = KEEPER_HANDS[k];
    const side = hx > KEEPER_W / 2 ? 1 : -1;
    const cx = ox + 64 + (r() - 0.5) * 6;
    const head = 34 + r() * 10;
    const shoulder = 24 + r() * 5;
    const hem = 33 + r() * 8;
    const lean = (r() - 0.5) * 6;
    const body = new Path2D();
    // Hood: a soft peak that falls to the shoulders.
    body.moveTo(cx + lean * 0.4, head);
    body.bezierCurveTo(cx + 15, head + 2, cx + 18, head + 22, cx + shoulder * 0.62, head + 36);
    body.bezierCurveTo(cx + shoulder, head + 40, cx + shoulder + 3, head + 52, cx + shoulder + 4, head + 64);
    // Cloak to a ragged hem.
    body.bezierCurveTo(cx + hem - 2, 130, cx + hem + 2, 168, cx + hem, 186);
    const teeth = 7;
    for (let t = 1; t <= teeth; t++) {
      const x = cx + hem - ((2 * hem) * t) / teeth;
      body.lineTo(x + (r() - 0.5) * 5, 186 - (t % 2) * (3 + r() * 5));
    }
    body.bezierCurveTo(cx - hem - 2, 168, cx - hem + 2, 130, cx - shoulder - 4, head + 64);
    body.bezierCurveTo(cx - shoulder - 3, head + 52, cx - shoulder, head + 40, cx - shoulder * 0.62, head + 36);
    body.bezierCurveTo(cx - 18, head + 22, cx - 15, head + 2, cx + lean * 0.4, head);
    body.closePath();
    // The arm reaching out to the pole.
    const arm = new Path2D();
    const sx = cx + side * (shoulder - 2),
      sy = head + 46;
    arm.moveTo(sx, sy - 6);
    arm.quadraticCurveTo(sx + side * 14, sy - 4, ox + hx, hy - 5);
    arm.lineTo(ox + hx + side * 2, hy + 5);
    arm.quadraticCurveTo(sx + side * 10, sy + 12, sx - side * 4, sy + 14);
    arm.closePath();
    // Shade (red): darker low and away from the lantern; rim (green) on the lantern's side.
    const shade = g.createLinearGradient(ox, 40, ox, 190);
    shade.addColorStop(0, 'rgb(150,0,0)');
    shade.addColorStop(1, 'rgb(70,0,0)');
    g.fillStyle = shade;
    g.fill(body);
    g.fill(arm);
    g.save();
    g.clip(body);
    g.globalCompositeOperation = 'lighter';
    const rim = g.createLinearGradient(cx + side * hem, 0, cx - side * 4, 0);
    rim.addColorStop(0, 'rgba(0,255,0,1)');
    rim.addColorStop(0.35, 'rgba(0,90,0,1)');
    rim.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = rim;
    g.fillRect(ox, 0, KEEPER_W, KEEPER_H);
    // A fold or two in the cloak.
    g.globalCompositeOperation = 'source-atop';
    g.strokeStyle = 'rgba(40,0,0,0.9)';
    g.lineWidth = 3;
    for (let f = 0; f < 2; f++) {
      const fx = cx + (r() - 0.5) * hem;
      g.beginPath();
      g.moveTo(fx, head + 60);
      g.quadraticCurveTo(fx + (r() - 0.5) * 10, 140, fx + (r() - 0.5) * 14, 186);
      g.stroke();
    }
    g.restore();
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = 'rgba(0,200,0,1)';
    g.fill(arm);
    g.restore();
  }
  keepers = c;
  return c;
}
