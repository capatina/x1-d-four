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
 * Three sectors, one per band, each with one neon accent: hot magenta for the
 * low end, acid green for harmony, electric cyan for the highs. Labels also
 * name every band; lore lives in place names only.
 */
export const BAND_PALETTE: Record<Band, BandPalette> = {
  low: {
    label: 'LOW',
    hint: 'kick, bass and groove',
    css: '#ff2f7e',
    a: '#7a0f3c',
    b: '#c2246a',
    hot: '#ffc2dc',
    place: 'Sector Sub',
    detail: 'Kick, bass & groove',
  },
  mid: {
    label: 'MID',
    hint: 'harmony, key and chords',
    css: '#9dff3c',
    a: '#3f7a12',
    b: '#74c42b',
    hot: '#e4ffc4',
    place: 'Sector Chord',
    detail: 'Harmony, key & chords',
  },
  high: {
    label: 'HIGH',
    hint: 'hats, percussion and air',
    css: '#2fe6ff',
    a: '#0f5f7a',
    b: '#23a9c2',
    hot: '#c8f8ff',
    place: 'Sector Air',
    detail: 'Hats, percussion & air',
  },
};
export function bandPalette(band: Band | null | undefined): BandPalette {
  return BAND_PALETTE[band ?? 'low'] ?? BAND_PALETTE.low;
}
