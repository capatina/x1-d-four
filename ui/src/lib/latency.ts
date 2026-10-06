import type { LatencyMsg } from './protocol';

/** Packets kept for the scope: about 2.4 s at 600 a second. */
export const LATENCY_KEEP = 1440;

/**
 * The live latency feed: every OUT packet's interval, render time and queue
 * depth, in rings. Deliberately not reactive, like `viz`: only the scope's
 * render loop reads it.
 */
export const latency = {
  interval: new Float32Array(LATENCY_KEEP),
  render: new Float32Array(LATENCY_KEEP),
  queued: new Uint8Array(LATENCY_KEEP),
  /** Packets ever written (the ring's head). */
  count: 0,
  /** performance.now() of the last message (0 = never). */
  at: 0,
  packetUs: 1666.7,
  outUrbs: 3,
  underruns: 0,
};

export function applyLatency(msg: LatencyMsg): void {
  const n = msg.interval_us.length;
  for (let i = 0; i < n; i++) {
    const k = latency.count % LATENCY_KEEP;
    latency.interval[k] = msg.interval_us[i];
    latency.render[k] = msg.render_us[i] ?? 0;
    latency.queued[k] = msg.queued[i] ?? 0;
    latency.count++;
  }
  latency.at = performance.now();
  latency.packetUs = msg.packet_us;
  latency.outUrbs = msg.out_urbs;
  latency.underruns = msg.underruns;
}
