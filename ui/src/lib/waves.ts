import { DECK_COUNT, type StateMsg, type WaveInfo } from './protocol';

/** The server renders at 48 kHz; `wave.block_frames` counts frames at that rate. */
const SAMPLE_RATE = 48_000;
/** Each band is scaled so this share of its blocks fits; the loudest few clip. */
const NORM_PERCENTILE = 0.995;
/** A band quieter than this fraction of the track's loudest band stays that quiet (no blown-up noise). */
const NORM_FLOOR = 0.2;
/** Display curve on the normalised level: < 1 lifts quiet detail. */
const GAMMA = 0.8;
/** Share of the half-height each band gets, centre outwards: low, mid, high. */
export const BAND_SHARE = [0.46, 0.33, 0.21] as const;
/** The stacked total is scaled so this share of blocks fits (at most ×MAX_STACK_GAIN). */
const STACK_PERCENTILE = 0.99;
const MAX_STACK_GAIN = 1.8;
const STACK_BINS = 256;

export type DeckWave = {
  trackId: string;
  /** Seconds per block. */
  blockSec: number;
  blocks: number;
  /**
   * Stacked display heights per block, as fractions of the half-height,
   * centre outwards: [low, low + mid, low + mid + high], each 0..1.
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
 * Raw [low, mid, high] bytes → stacked display heights. Each band is scaled
 * to its own loud passages (so the server's absolute levels don't matter),
 * then the stack is scaled so the loud parts fill the lane.
 */
function prepare(bytes: Uint8Array, blocks: number): Float32Array {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < blocks; i++) {
    hist[0][bytes[i * 3]]++;
    hist[1][bytes[i * 3 + 1]]++;
    hist[2][bytes[i * 3 + 2]]++;
  }
  const loud = hist.map((h) => percentile(h, blocks, NORM_PERCENTILE));
  const top = Math.max(1, ...loud);
  const luts = loud.map((p) => {
    const norm = Math.max(p, top * NORM_FLOOR, 1);
    return Float32Array.from({ length: 256 }, (_, v) => Math.min(1, v / norm) ** GAMMA);
  });
  const amp = new Float32Array(blocks * 3);
  const totals = new Uint32Array(STACK_BINS);
  for (let i = 0; i < blocks * 3; i += 3) {
    const lo = luts[0][bytes[i]] * BAND_SHARE[0];
    const mid = lo + luts[1][bytes[i + 1]] * BAND_SHARE[1];
    const top = mid + luts[2][bytes[i + 2]] * BAND_SHARE[2];
    amp[i] = lo;
    amp[i + 1] = mid;
    amp[i + 2] = top;
    totals[Math.min(STACK_BINS - 1, Math.floor(top * STACK_BINS))]++;
  }
  const loudTotal = (percentile(totals, blocks, STACK_PERCENTILE) + 1) / STACK_BINS;
  const gain = Math.min(MAX_STACK_GAIN, Math.max(1, 1 / loudTotal));
  for (let i = 0; i < amp.length; i++) amp[i] = Math.min(1, amp[i] * gain);
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
