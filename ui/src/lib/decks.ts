/** Lapis, amber, moonstone and heather. Lightness spread, stroke patterns and a
 * sigil per deck (◆ ▲ ● ■) supplement hue, so identity survives common
 * colour-vision deficiencies. */
const DECK_HUES = [235, 75, 110, 335] as const;
const DECK_LIGHTNESS = [0.72, 0.78, 0.9, 0.72] as const;
const DECK_CHROMA = [0.09, 0.12, 0.04, 0.08] as const;
export const DECK_DASHES: number[][] = [[], [10, 4], [2, 4], [10, 3, 2, 3]];

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
export const DECK_COLORS: readonly string[] = DECK_HUES.map((h, i) => oklch(DECK_LIGHTNESS[i], DECK_CHROMA[i], h));

/** Per-deck band shades for the waveform strip. */
export const DECK_SHADES: readonly DeckShades[] = DECK_HUES.map((h, i) => ({
  low: oklch(DECK_LIGHTNESS[i] - 0.22, DECK_CHROMA[i] * 0.7, h),
  mid: DECK_COLORS[i],
  high: oklch(DECK_LIGHTNESS[i] - 0.08, DECK_CHROMA[i] * 0.6, h),
  line: oklch(Math.min(0.93, DECK_LIGHTNESS[i] + 0.09), DECK_CHROMA[i], h),
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
