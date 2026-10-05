import type { Band } from '../lib/protocol';

export type BandPalette = {
  label: string;
  hint: string;
  /** UI accent (the realm's one luminous colour). */
  css: string;
  a: string;
  b: string;
  /** Brighter accent for flashes of light (the gate passing overhead). */
  hot: string;
  /** Realm name shown in the UI. */
  place: string;
  detail: string;
};

/**
 * Three realms, one per band: ochre moor, old wood, pale fells. Labels also
 * name every band; lore lives in place names only.
 */
export const BAND_PALETTE: Record<Band, BandPalette> = {
  low: {
    label: 'LOW',
    hint: 'kick, bass and groove',
    css: '#e3b667',
    a: '#876e37',
    b: '#b39e6a',
    hot: '#fae2b0',
    place: 'The Lowmarch',
    detail: 'Kick, bass & groove',
  },
  mid: {
    label: 'MID',
    hint: 'harmony, key and chords',
    css: '#adc992',
    a: '#596b36',
    b: '#91a17b',
    hot: '#dce8bb',
    place: 'The Greenwold',
    detail: 'Harmony, key & chords',
  },
  high: {
    label: 'HIGH',
    hint: 'hats, percussion and air',
    css: '#99cedf',
    a: '#668272',
    b: '#a0b8b7',
    hot: '#d2eef3',
    place: 'The Highreach',
    detail: 'Hats, percussion & air',
  },
};
export function bandPalette(band: Band | null | undefined): BandPalette {
  return BAND_PALETTE[band ?? 'low'] ?? BAND_PALETTE.low;
}

/** Shader constants per realm (low, mid, high): ground dark → light, haze, zenith. */
export const REALM_SHADER = {
  groundDark: ['#3d3515', '#18361a', '#2a4241'],
  groundLight: ['#876e37', '#596b36', '#668272'],
  haze: ['#c3b5a3', '#aeb49f', '#b7c7cd'],
  zenith: ['#437085', '#376c79', '#5f7f95'],
} as const;

/**
 * The light table over a mix: dawn, day, dusk, night (the realm haze and
 * zenith are scaled by the age's, relative to day). `light` is the sun or
 * moon's strength on the land, `magic` multiplies ley lines and lanterns.
 */
export const AGES = [
  { name: 'Dawn', sun: '#ffd5b3', haze: '#d4b7a7', zenith: '#57768c', fog: 0.006, light: 0.86, magic: 1 },
  { name: 'Day', sun: '#fff5d9', haze: '#c2bfa9', zenith: '#4d88a9', fog: 0.005, light: 1, magic: 1 },
  { name: 'Dusk', sun: '#ff9874', haze: '#bd8b74', zenith: '#3d446d', fog: 0.008, light: 0.72, magic: 1.25 },
  { name: 'Night', sun: '#e9e5cf', haze: '#27364a', zenith: '#091123', fog: 0.01, light: 0.3, magic: 1.8 },
] as const;

/** Neutrals: label ink, label text, stone. */
export const INK = '#121e17';
export const PARCHMENT = '#f0e7d2';
export const STONE = '#615d54';
