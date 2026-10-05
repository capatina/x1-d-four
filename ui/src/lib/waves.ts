import { DECK_COUNT, type StateMsg, type WaveInfo } from './protocol';

/** The server renders at 48 kHz; `wave.block_frames` counts frames at that rate. */
const SAMPLE_RATE = 48_000;
/** The track is scaled so this share of its blocks fits; the loudest few clip. */
const NORM_PERCENTILE = 0.998;
/** Never boost a quiet track more than this (its noise floor stays low). */
const MAX_GAIN = 4;

export type DeckWave = {
  trackId: string;
  /** Seconds per block. */
  blockSec: number;
  blocks: number;
  /**
   * Per block, the [low, mid, high] peak level as a fraction of the half-height
   * (0..1), all three on one scale for the whole track, so a kick is a tall low
   * peak and a breakdown stays lower than a drop.
   */
  amp: Float32Array;
};

/**
 * Detailed waveforms of the loaded decks (from `GET /api/decks/{n}/wave`)
 * and the latest `state` with its arrival time, for dead reckoning.
 *
 * Deliberately not reactive, like `viz`: only the waveform strip's render
 * loop reads it, once per animation frame.
 */
class Waves {
  readonly decks: (DeckWave | null)[] = Array.from({ length: DECK_COUNT }, () => null);
  /** Latest `state`, uncoalesced, and performance.now() when it arrived. */
  state: StateMsg | null = null;
  stateAt = 0;
  /** Bumped on every `state`, so readers can tell a new one arrived. */
  stateSeq = 0;

  /** Per deck: load generation (guards against out-of-order fetches) and what it is for. */
  readonly #gen: number[] = Array.from({ length: DECK_COUNT }, () => 0);
  readonly #want: (string | null)[] = Array.from({ length: DECK_COUNT }, () => null);

  noteState(msg: StateMsg, at: number): void {
    this.state = msg;
    this.stateAt = at;
    this.stateSeq++;
  }

  /** A track was loaded (or re-announced on reconnect): fetch its waveform unless we already have it. */
  load(deck: number, trackId: string, info: WaveInfo | null | undefined): void {
    if (!validDeck(deck)) return;
    const blocks = info && Number.isFinite(info.blocks) ? Math.floor(info.blocks) : 0;
    const frames = info?.block_frames ?? 0;
    const key = `${trackId}|${blocks}|${frames}`;
    if (blocks > 0 && frames > 0 && this.#want[deck] === key) return;
    const gen = ++this.#gen[deck];
    this.decks[deck] = null;
    this.#want[deck] = null;
    if (blocks <= 0 || frames <= 0) return;
    this.#want[deck] = key;
    void this.#fetch(deck, gen, trackId, blocks, frames / SAMPLE_RATE);
  }

  drop(deck: number): void {
    if (!validDeck(deck)) return;
    this.#gen[deck]++;
    this.#want[deck] = null;
    this.decks[deck] = null;
  }

  async #fetch(deck: number, gen: number, trackId: string, blocks: number, blockSec: number): Promise<void> {
    try {
      const res = await fetch(`/api/decks/${deck}/wave`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (gen !== this.#gen[deck]) return;
      // A different length means the deck changed under us; its own deck_loaded will follow.
      if (bytes.length < blocks * 3) throw new Error('short waveform');
      this.decks[deck] = { trackId, blockSec, blocks, amp: prepare(bytes, blocks) };
    } catch {
      // Let the next deck_loaded (reconnect, reload) try again.
      if (gen === this.#gen[deck]) this.#want[deck] = null;
    }
  }
}

/**
 * Raw [low, mid, high] peak bytes (linear, 255 = full scale) → display heights.
 * One gain for the whole track: its loud passages fill the lane.
 */
function prepare(bytes: Uint8Array, blocks: number): Float32Array {
  const hist = new Uint32Array(256);
  for (let i = 0; i < blocks * 3; i += 3) hist[Math.max(bytes[i], bytes[i + 1], bytes[i + 2])]++;
  const loud = Math.max(1, percentile(hist, blocks, NORM_PERCENTILE));
  const gain = Math.min(MAX_GAIN, 255 / loud) / 255;
  const amp = new Float32Array(blocks * 3);
  for (let i = 0; i < amp.length; i++) amp[i] = Math.min(1, bytes[i] * gain);
  return amp;
}

/** Bin index below which a share `q` of the `total` counts in `hist` fall. */
function percentile(hist: Uint32Array, total: number, q: number): number {
  const want = total * q;
  let seen = 0;
  for (let v = 0; v < hist.length; v++) {
    seen += hist[v];
    if (seen >= want) return v;
  }
  return hist.length - 1;
}

function validDeck(deck: number): boolean {
  return Number.isInteger(deck) && deck >= 0 && deck < DECK_COUNT;
}

export const waves = new Waves();
