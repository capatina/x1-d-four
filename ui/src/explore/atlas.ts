import { random } from '../lib/runes';

// Re-exported for the engine: the rune atlas lives with the 2D code (no three.js there).
export { ATLAS_CELL, ATLAS_COLS, ATLAS_ROWS, RUNES, SIGIL_CELL, SIGIL_PATHS, runeAtlas, tintedCell } from '../lib/runes';

/** Keeper cells: 4 hooded figures seen from behind, 128 × 192 each. */
export const KEEPER_W = 128;
export const KEEPER_H = 192;
/** Per figure: the side the lantern arm reaches to, hood top, hem half-width, lean (cell px). */
const KEEPER_FORMS = [
  [1, 36, 24, 1],
  [-1, 40, 22, -2],
  [1, 38, 26, 0],
  [-1, 35, 23, 2],
] as const;
/** Where each Keeper's hand holds the pole: out at shoulder height (cell px). */
export const KEEPER_HANDS = KEEPER_FORMS.map(([side, head]) => [64 + side * 31, head + 44] as const);
/** Figure height in the cell (hood top to hem), for sizing them on screen. */
export const KEEPER_FIGURE = 150 / KEEPER_H;

let keepers: HTMLCanvasElement | null = null;

/**
 * Four Keepers: hooded cloaks from behind, slim (1 : 3.2), one arm out to the
 * lantern pole. No faces, no hats. Red = cloak shade, green = the rim the
 * lantern lights, alpha = coverage; the shader adds pole, lantern and light.
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
    const [side, head, hem, lean] = KEEPER_FORMS[k];
    const [hx, hy] = KEEPER_HANDS[k];
    const cx = ox + 64;
    const sh = 19;
    const foot = 186;
    const body = new Path2D();
    // Hood: a soft peak, falling to narrow shoulders from head + 28.
    body.moveTo(cx + lean, head);
    body.bezierCurveTo(cx + 11, head + 1, cx + 13, head + 18, cx + sh * 0.7, head + 28);
    body.quadraticCurveTo(cx + sh, head + 31, cx + sh, head + 40);
    // The cloak falls straight, flaring only below head + 90.
    body.lineTo(cx + sh + 1, head + 90);
    body.bezierCurveTo(cx + sh + 2, head + 110, cx + hem - 2, foot - 30, cx + hem, foot);
    const teeth = 6;
    for (let t = 1; t <= teeth; t++) {
      const x = cx + hem - (2 * hem * t) / teeth;
      body.lineTo(x + (r() - 0.5) * 3, foot - (t % 2) * (2 + r() * 3));
    }
    body.bezierCurveTo(cx - hem + 2, foot - 30, cx - sh - 2, head + 110, cx - sh - 1, head + 90);
    body.lineTo(cx - sh, head + 40);
    body.quadraticCurveTo(cx - sh, head + 31, cx - sh * 0.7, head + 28);
    body.bezierCurveTo(cx - 13, head + 18, cx - 11, head + 1, cx + lean, head);
    body.closePath();
    // The arm out to the pole, at shoulder height.
    const arm = new Path2D();
    const sx = cx + side * (sh - 3),
      sy = head + 36;
    arm.moveTo(sx, sy - 4);
    arm.quadraticCurveTo(sx + side * 9, sy - 2, ox + hx, hy - 4);
    arm.lineTo(ox + hx + side * 1, hy + 4);
    arm.quadraticCurveTo(sx + side * 6, sy + 10, sx - side * 3, sy + 12);
    arm.closePath();
    // Shade (red), darker low; rim (green) on the lantern's side.
    const shade = g.createLinearGradient(ox, head, ox, foot);
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
    // A back seam catching the light, and a fold.
    g.fillStyle = 'rgba(70,0,0,1)';
    g.fillRect(cx - 0.8 + lean * 0.3, head + 30, 1.6, foot - head - 34);
    g.globalCompositeOperation = 'source-atop';
    g.strokeStyle = 'rgba(40,0,0,0.9)';
    g.lineWidth = 2.5;
    const fx = cx - side * (6 + r() * 6);
    g.beginPath();
    g.moveTo(fx, head + 70);
    g.quadraticCurveTo(fx - side * 2, 150, fx - side * 5, foot);
    g.stroke();
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
