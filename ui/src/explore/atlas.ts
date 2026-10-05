import { random } from '../lib/runes';

// Re-exported for the engine: the rune atlas lives with the 2D code (no three.js there).
export { ATLAS_CELL, ATLAS_COLS, ATLAS_ROWS, RUNES, SIGIL_CELL, SIGIL_PATHS, runeAtlas, tintedCell } from '../lib/runes';

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
