import type { Band } from '../lib/protocol';

export type BandPalette = {
  label: string;
  /** What the band listens to, for tooltips. */
  hint: string;
  /** UI accent (chips, minimap, labels). */
  css: string;
  /** Tunnel colours: primary, secondary and the hot core used for highlights. */
  a: string;
  b: string;
  hot: string;
};

/** Band colour is the mood: violet/magenta lows, emerald/teal mids, ice-blue highs. */
export const BAND_PALETTE: Record<Band, BandPalette> = {
  low: { label: 'LOW', hint: 'kick, bass and groove', css: '#d66bff', a: '#8a1cff', b: '#ff2a9d', hot: '#ffc2f1' },
  mid: { label: 'MID', hint: 'harmony, key and chords', css: '#3ce8b0', a: '#00d488', b: '#00a8d6', hot: '#c4fff0' },
  high: { label: 'HIGH', hint: 'hats, percussion and air', css: '#a6e3ff', a: '#3fb6ff', b: '#d8f0ff', hot: '#ffffff' },
};

export function bandPalette(band: Band | null | undefined): BandPalette {
  return BAND_PALETTE[band ?? 'low'] ?? BAND_PALETTE.low;
}
