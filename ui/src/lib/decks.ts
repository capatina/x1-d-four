/**
 * One accent per deck, in mixer channel order 1–4. Similar lightness, hues
 * spread around the wheel so channels read at a glance on a dark booth screen.
 */
export const DECK_COLORS = ['#45b4ff', '#ff9e3d', '#ff6eb4', '#4fe0a2'] as const;

export function deckColor(deck: number): string {
  return DECK_COLORS[deck] ?? DECK_COLORS[0];
}

export function hexToRgb(hex: string): [number, number, number] {
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
