import { lighten, rgba } from './decks';

export type WaveLayers = { played: HTMLCanvasElement; unplayed: HTMLCanvasElement };

/**
 * Pre-render the overview waveform twice (unplayed in the deck accent, played
 * dimmed) at device-pixel size. Each frame then only blits two slices of
 * these and draws the markers on top.
 */
export function buildLayers(peaks: ArrayLike<number>, w: number, h: number, color: string): WaveLayers | null {
  if (!peaks.length || w < 2 || h < 2) return null;
  return {
    unplayed: renderPeaks(peaks, w, h, color, lighten(color, 0.55)),
    played: renderPeaks(peaks, w, h, rgba(color, 0.3), 'rgba(255, 255, 255, 0.22)'),
  };
}

function renderPeaks(peaks: ArrayLike<number>, w: number, h: number, body: string, core: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const n = peaks.length;
  const mid = h / 2;
  const half = mid - Math.max(1, Math.round(h * 0.04));
  const heights = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const i0 = Math.floor((x * n) / w);
    const i1 = Math.max(i0 + 1, Math.floor(((x + 1) * n) / w));
    let peak = 0;
    for (let i = i0; i < i1 && i < n; i++) peak = Math.max(peak, peaks[i]);
    heights[x] = (Math.min(255, Math.max(0, peak)) / 255) * half;
  }

  // Body: full peak, mirrored around the centre line.
  ctx.fillStyle = body;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const a = Math.max(0.5, heights[x]);
    ctx.rect(x, mid - a, 1, a * 2);
  }
  ctx.fill();

  // Core: a lighter inner band gives the flat peaks some depth.
  ctx.fillStyle = core;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const a = heights[x] * 0.42;
    if (a >= 0.5) ctx.rect(x, mid - a, 1, a * 2);
  }
  ctx.fill();
  return canvas;
}
