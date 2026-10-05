/**
 * Deck colours, in mixer channel order 1–4.
 *
 * Defined in OKLCH so they are perceptually even: the same lightness and
 * chroma for every deck (each one as colourful as sRGB allows for the bluest),
 * with hues exactly 90° apart so no two decks are neighbours on the wheel.
 * The hues keep each deck's identity: 1 blue, 2 amber, 3 pink, 4 mint.
 */
const DECK_L = 0.72;
const DECK_C = 0.15;
const DECK_HUES = [250, 70, 340, 160] as const;

/**
 * The waveform strip recolours each deck by frequency band within its own hue
 * family, so spectral content reads without a rainbow:
 * - low: a deep shade at the edge of the gamut (the most saturated the hue gets
 *   at that lightness), turned a little along the wheel the way shadows shift,
 *   so dark amber goes rust rather than brown;
 * - mid: the deck colour itself;
 * - high: a pale, nearly neutral tint.
 * Decks that aren't focused are drawn as outlines in `line`: lighter than the
 * deck colour (so it stands out over another deck's fill) but still as
 * colourful as the gamut allows, so the hue keeps its identity.
 */
const LOW_L = 0.57;
const LOW_HUE_SHIFT = [8, -24, 6, 10] as const;
const HIGH_L = 0.91;
const HIGH_C = 0.055;
const LINE_L = 0.8;
const LINE_C = 0.16;

export type Rgb = [number, number, number];

export type DeckShades = { low: string; mid: string; high: string; line: string };

/** OKLCH → sRGB hex, clipping chroma (keeping lightness and hue) until it fits the gamut. */
export function oklch(l: number, c: number, h: number): string {
  let lo = 0;
  let hi = c;
  if (!inGamut(oklabToLinear(l, c, h))) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToLinear(l, mid, h))) lo = mid;
      else hi = mid;
    }
    c = lo;
  }
  const rgb = oklabToLinear(l, c, h).map((v) => Math.round(encode(v) * 255));
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** One accent per deck (HUD, ticker, waveform mids). */
export const DECK_COLORS: readonly string[] = DECK_HUES.map((h) => oklch(DECK_L, DECK_C, h));

/** Per-deck band shades for the waveform strip. */
export const DECK_SHADES: readonly DeckShades[] = DECK_HUES.map((h, i) => ({
  low: oklch(LOW_L, 0.2, h + LOW_HUE_SHIFT[i]),
  mid: DECK_COLORS[i],
  high: oklch(HIGH_L, HIGH_C, h),
  line: oklch(LINE_L, LINE_C, h),
}));

export function deckColor(deck: number): string {
  return DECK_COLORS[deck] ?? DECK_COLORS[0];
}

export function deckShades(deck: number): DeckShades {
  return DECK_SHADES[deck] ?? DECK_SHADES[0];
}

export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Mix a colour towards white by `amount` (0..1). */
export function lighten(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function oklabToLinear(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

function inGamut(rgb: Rgb): boolean {
  return rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
}

/** Linear light → sRGB transfer, clamped to 0..1. */
function encode(v: number): number {
  const x = Math.min(1, Math.max(0, v));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}
