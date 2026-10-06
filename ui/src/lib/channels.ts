import { viz } from './viz';
import { waves } from './waves';

/**
 * Each mixer channel's level as you hear it, low/mid/high, for the deck meters
 * and the visuals. Channels 1-3 come from the mixer's soundcard inputs 1/2, 3/4
 * and 5/6 (set to their channel, post fader): after your fader and EQ. Channel 4's
 * input carries the main mix instead, so channel 4 is deck 4's own level, scaled
 * to the part of the mix the other channels don't explain. A channel whose input
 * shows no signal falls back to what its deck sends (before the mixer).
 *
 * Deliberately not reactive: render loops read it once a frame.
 */
export const channels = {
  /** Smoothed level per channel and band (ch × 3 + band), 0..1 on a −48…0 dB scale. */
  bands: new Float32Array(12),
  /** Smoothed overall level per channel, 0..1 (−48…0 dB). */
  level: new Float32Array(4),
  /** Overall level per channel, dBFS (−99 = silent). */
  db: new Float32Array(4).fill(-99),
  /** Peak hold per channel, 0..1, falling slowly. */
  peak: new Float32Array(4),
  /** Measured after the fader (true), or what the deck sends (false). */
  postFader: [false, false, false, false],
  at: 0,
};

/** Seconds a channel's input may stay silent before we stop trusting it. */
const TRUST_MS = 8000;
const seen = new Float64Array(3).fill(-1e9);
const raw = new Float32Array(12);

const toLevel = (rms: number) => Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 1e-6)) + 48) / 48));

/** Update from the latest `state` and `viz`; safe to call from several loops (once per frame counts). */
export function updateChannels(now: number) {
  const dt = Math.min(0.1, Math.max(0, (now - channels.at) / 1000));
  if (dt < 0.004) return;
  channels.at = now;
  const st = waves.state;
  const live = viz.at > 0 && now - viz.at < 500;
  const returns = st?.device?.state === 'running' ? st.returns : undefined;
  // What each deck sends (viz levels are rms × 2.5, capped at 1).
  const sent = (d: number, b: number) => (live && viz.decks[d] ? viz.decks[d][b] / 2.5 : 0);
  let others = 0;
  for (let c = 0; c < 3; c++) {
    const r = returns?.[c];
    const total = r ? Math.hypot(r[0], r[1], r[2]) : 0;
    if (total > 0.0015) seen[c] = now;
    const post = !!r && now - seen[c] < TRUST_MS;
    channels.postFader[c] = post;
    for (let b = 0; b < 3; b++) raw[c * 3 + b] = post ? r![b] : sent(c, b);
    if (post) others += total * total;
  }
  // Channel 4: deck 4, scaled to the share of the mix the other channels leave.
  const mix = returns?.[3];
  const mixTotal = mix ? Math.hypot(mix[0], mix[1], mix[2]) : 0;
  const share = mixTotal > 1e-4 ? Math.max(0, Math.min(1, Math.sqrt(Math.max(0, mixTotal * mixTotal - others)) / mixTotal)) : mix ? 0 : 1;
  channels.postFader[3] = !!mix && mixTotal > 1e-4;
  for (let b = 0; b < 3; b++) raw[9 + b] = sent(3, b) * (mix ? share : 1);
  // Fast up, slower down; peaks hold, then fall.
  for (let i = 0; i < 12; i++) {
    const v = toLevel(raw[i]);
    channels.bands[i] += (v - channels.bands[i]) * (1 - Math.exp(-dt / (v > channels.bands[i] ? 0.03 : 0.3)));
  }
  for (let c = 0; c < 4; c++) {
    const rms = Math.hypot(raw[c * 3], raw[c * 3 + 1], raw[c * 3 + 2]);
    channels.db[c] = rms > 1e-5 ? 20 * Math.log10(rms) : -99;
    const v = toLevel(rms);
    channels.level[c] += (v - channels.level[c]) * (1 - Math.exp(-dt / (v > channels.level[c] ? 0.03 : 0.3)));
    channels.peak[c] = Math.max(v, channels.peak[c] - dt * 0.35);
  }
}
