import type { VizMsg } from './protocol';

export const SPECTRUM_BINS = 64;

/**
 * Latest `viz` frame, mutated in place ~120 times a second.
 *
 * Deliberately not reactive: only the explore render loop reads it, once per
 * animation frame, so the 120 Hz stream never re-renders Svelte components.
 */
export type VizFrame = {
  /** Incremented on every `viz` message. */
  seq: number;
  /** performance.now() when the last frame arrived (0 = never). */
  at: number;
  /** Server time of the last frame, ms. */
  t: number;
  /** 64 bins, 0..1 (wire values / 255). */
  spectrum: Float32Array;
  /** Overall low/mid/high, 0..1. */
  bands: [number, number, number];
  /** Per deck low/mid/high, 0..1. */
  decks: Array<[number, number, number]>;
  /** Counts onsets, so a reader at any frame rate can tell a new one arrived. */
  onsets: number;
  /** Beat phase 0..1 at `at`, from the mixer's MIDI clock. */
  beat: number | null;
  bpm: number | null;
};

export const viz: VizFrame = {
  seq: 0,
  at: 0,
  t: 0,
  spectrum: new Float32Array(SPECTRUM_BINS),
  bands: [0, 0, 0],
  decks: [],
  onsets: 0,
  beat: null,
  bpm: null,
};

export function applyViz(msg: VizMsg): void {
  viz.seq++;
  viz.at = performance.now();
  viz.t = msg.t;
  const spec = msg.spectrum ?? [];
  const n = Math.min(SPECTRUM_BINS, spec.length);
  for (let i = 0; i < n; i++) viz.spectrum[i] = clamp01(spec[i] / 255);
  for (let i = n; i < SPECTRUM_BINS; i++) viz.spectrum[i] = 0;
  if (msg.bands) {
    viz.bands[0] = clamp01(msg.bands[0]);
    viz.bands[1] = clamp01(msg.bands[1]);
    viz.bands[2] = clamp01(msg.bands[2]);
  }
  viz.decks = msg.decks ?? [];
  if (msg.onset) viz.onsets++;
  viz.beat = typeof msg.beat === 'number' && Number.isFinite(msg.beat) ? msg.beat : null;
  viz.bpm = typeof msg.bpm === 'number' && msg.bpm > 0 ? msg.bpm : null;
}

function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}
