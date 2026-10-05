import type { Band } from '../lib/protocol';

export type BandPalette = {
  label: string;
  hint: string;
  css: string;
  a: string;
  b: string;
  hot: string;
  place: string;
  detail: string;
};

/** Ochre earth, sage woodland, blue-grey open water. Labels also name every band. */
export const BAND_PALETTE: Record<Band, BandPalette> = {
  low: {
    label: 'LOW',
    hint: 'kick, bass and groove',
    css: '#dfb975',
    a: '#87794b',
    b: '#b39e6a',
    hot: '#efe1b7',
    place: 'The lowlands',
    detail: 'Kick, bass & groove',
  },
  mid: {
    label: 'MID',
    hint: 'harmony, key and chords',
    css: '#b3c59a',
    a: '#596c4c',
    b: '#91a17b',
    hot: '#dce2bc',
    place: 'The river grove',
    detail: 'Harmony, key & chords',
  },
  high: {
    label: 'HIGH',
    hint: 'hats, percussion and air',
    css: '#a9cad6',
    a: '#637c7e',
    b: '#a0b8b7',
    hot: '#e0e8df',
    place: 'The open water',
    detail: 'Hats, percussion & air',
  },
};
export function bandPalette(band: Band | null | undefined): BandPalette {
  return BAND_PALETTE[band ?? 'low'] ?? BAND_PALETTE.low;
}
