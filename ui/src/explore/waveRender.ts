// Overlaid deck waveforms: every loaded deck's three-band waveform scrolling
// past a fixed centre playhead, all on one time axis (seconds from now), so
// decks synced to one tempo show their beats lined up.
//
// One 2D canvas. The lead deck (the focused one) is filled: its stacked bands
// are painted outside in (painter's order, so no seams between bands), dimmed
// through its colours when paused. The other decks are luminous outlines
// on top, their glows screen-blended so where decks cross the colours mix
// instead of hiding each other. (Faint screened fills for the other decks
// were tried too: with three or more, complementary hues mix to a grey-brown
// mud, so the outlines carry them alone.)

import { client } from '../lib/client.svelte';
import { DECK_SHADES, hexToRgb, rgba } from '../lib/decks';
import { DECK_COUNT, type BeatGrid, type DeckState, type StateMsg } from '../lib/protocol';
import { waves, type DeckWave } from '../lib/waves';

/** Seconds visible on each side of the playhead. */
export const WINDOW_S = 4;

/** Envelope sample spacing, CSS px (blocks are ~2.4 px apart at 1920 px). */
const STEP = 1.5;

/** Position error (track seconds) above which we jump instead of easing. */
const SNAP_S = 0.3;
/** Time constant for easing a playing deck onto the server's clock. */
const CORRECT_TAU = 0.15;
/** Time constant for a paused deck gliding to its new position (jog, cue). */
const GLIDE_TAU = 0.05;
/** Don't extrapolate further than this past the last `state` (server stalled). */
const MAX_AGE_S = 1;

/** Brightness of a paused lead deck's fill (its colours are mixed towards black). */
const LEAD_PAUSED = 0.72;
/** Outline opacity of the other decks. */
const OTHER_LINE = { playing: 1, paused: 0.55 };
/** How much of the past (left of the playhead) is faded out. */
const PAST_DIM = 0.38;

type Shown = { pos: number; trackId: string | null; live: boolean };

type Envelope = { n: number; xs: Float32Array; yl: Float32Array; ym: Float32Array; yh: Float32Array };

type Loop = { start: number; end: number };

export class WaveRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #env: Envelope[] = [];
  readonly #shown: Shown[] = Array.from({ length: DECK_COUNT }, () => ({ pos: 0, trackId: null, live: false }));
  readonly #resize: ResizeObserver;
  readonly #mono: string;
  #reduced: boolean;
  #dpr = 1;
  #w = 0;
  #h = 0;
  #raf = 0;
  #running = false;
  #disposed = false;
  #last = 0;
  /** Average draw time (ms), for ?stats. */
  drawMs = 0;

  constructor(canvas: HTMLCanvasElement, reducedMotion: boolean) {
    this.#canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.#ctx = ctx;
    for (let i = 0; i < DECK_COUNT; i++) {
      this.#env.push({ n: 0, xs: new Float32Array(0), yl: new Float32Array(0), ym: new Float32Array(0), yh: new Float32Array(0) });
    }
    this.#reduced = reducedMotion;
    this.#mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace';
    this.#resize = new ResizeObserver(() => this.#onResize());
    this.#resize.observe(canvas);
    this.#onResize();
    document.addEventListener('visibilitychange', this.#onVisibility);
    if (!document.hidden) this.#start();
  }

  setReducedMotion(reduced: boolean): void {
    this.#reduced = reduced;
  }

  dispose(): void {
    this.#disposed = true;
    this.#stop();
    this.#resize.disconnect();
    document.removeEventListener('visibilitychange', this.#onVisibility);
  }

  // -------------------------------------------------------------------------
  // Loop

  #start(): void {
    if (this.#running || this.#disposed) return;
    this.#running = true;
    this.#last = performance.now();
    this.#raf = requestAnimationFrame(this.#frame);
  }

  #stop(): void {
    this.#running = false;
    cancelAnimationFrame(this.#raf);
  }

  #onVisibility = (): void => {
    if (document.hidden) this.#stop();
    else this.#start();
  };

  #onResize(): void {
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const w = this.#canvas.clientWidth;
    const h = this.#canvas.clientHeight;
    if (w === this.#w && h === this.#h && dpr === this.#dpr) return;
    this.#w = w;
    this.#h = h;
    this.#dpr = dpr;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    this.#canvas.width = pw;
    this.#canvas.height = ph;
    const cols = Math.ceil(w / STEP) + 2;
    for (const e of this.#env) {
      e.xs = new Float32Array(cols);
      e.yl = new Float32Array(cols);
      e.ym = new Float32Array(cols);
      e.yh = new Float32Array(cols);
    }
  }

  #frame = (now: number): void => {
    if (!this.#running) return;
    this.#raf = requestAnimationFrame(this.#frame);
    const dt = Math.min(0.1, Math.max(0, (now - this.#last) / 1000));
    this.#last = now;
    // Moved to a screen with another pixel ratio (no resize event for that).
    if (Math.min(2, Math.max(1, window.devicePixelRatio || 1)) !== this.#dpr) this.#onResize();
    const st = waves.state;
    this.#advance(st, now, dt);
    const t0 = performance.now();
    this.#draw(st);
    this.drawMs += (performance.now() - t0 - this.drawMs) * 0.05;
  };

  // -------------------------------------------------------------------------
  // Dead reckoning: follow the 30 Hz `state` at 60 fps without visible jumps.

  #advance(st: StateMsg | null, now: number, dt: number): void {
    const age = Math.min(MAX_AGE_S, Math.max(0, (now - waves.stateAt) / 1000));
    for (let i = 0; i < DECK_COUNT; i++) {
      const sh = this.#shown[i];
      const ds = st?.decks[i];
      if (!ds || !ds.track_id) {
        sh.live = false;
        continue;
      }
      const loop = activeLoop(ds);
      const len = ds.length > 0 ? ds.length : Infinity;
      // Where the server's deck is now, by its own clock.
      let target = ds.position + (ds.playing ? ds.rate * age : 0);
      if (loop && ds.position < loop.end && target >= loop.end) target = wrapLoop(target, loop);
      target = clamp(target, 0, len);

      if (!sh.live || sh.trackId !== ds.track_id) {
        sh.pos = target;
        sh.trackId = ds.track_id;
        sh.live = true;
        continue;
      }
      if (ds.playing) {
        const step = ds.rate * dt;
        let next = sh.pos + step;
        if (loop && sh.pos < loop.end && next >= loop.end) next = wrapLoop(next, loop);
        let err = target - next;
        if (loop) err = wrapSym(err, loop.end - loop.start);
        if (Math.abs(err) > SNAP_S) {
          next = target;
        } else {
          // Ease onto the server clock, but never move backwards: a late
          // tick only slows the scroll for a moment.
          next += Math.max(-step, err * (1 - Math.exp(-dt / CORRECT_TAU)));
          if (loop && next >= loop.end) next = wrapLoop(next, loop);
        }
        sh.pos = clamp(next, 0, len);
      } else {
        const err = target - sh.pos;
        sh.pos = Math.abs(err) > SNAP_S ? target : sh.pos + err * (1 - Math.exp(-dt / GLIDE_TAU));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Drawing

  #draw(st: StateMsg | null): void {
    const ctx = this.#ctx;
    const w = this.#w;
    const h = this.#h;
    const dpr = this.#dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);
    if (!st || w < 10 || h < 10) return;

    const cx = w / 2;
    const cy = h / 2;
    const pps = w / (2 * WINDOW_S);
    // Beat-grid ruler along both edges: one lane per deck, deck 1 outermost.
    const lane = clamp(h * 0.04, 4, 6);
    const ruler = 2 + DECK_COUNT * lane;
    const half = Math.max(8, cy - ruler - 2);
    // The lead deck is drawn filled, the rest as outlines: the focused deck,
    // or while it's empty (about to be loaded) the master or a playing one.
    const lead = this.#lead(st);

    // Others first, lead last.
    const order: number[] = [];
    for (let i = 0; i < DECK_COUNT; i++) if (i !== lead) order.push(i);
    if (lead >= 0) order.push(lead);

    // Behind the waveforms: loop regions, and the lead deck's bar lines.
    for (const i of order) {
      const ds = st.decks[i];
      const sh = this.#shown[i];
      if (!ds || !sh.live) continue;
      const loop = activeLoop(ds);
      if (loop) this.#loop(i, loop, sh.pos, rate(ds), cx, pps, ruler, i === lead);
      const grid = i === lead ? gridFor(i, ds) : null;
      if (grid) this.#ticks(i, grid, sh.pos, rate(ds), ds.length, cx, pps, lane, ruler, 'lines');
    }

    // Waveforms.
    let any = false;
    for (const i of order) {
      const env = this.#env[i];
      env.n = 0;
      const ds = st.decks[i];
      const sh = this.#shown[i];
      const wave = waves.decks[i];
      if (!ds || !sh.live || !wave || wave.trackId !== ds.track_id) continue;
      this.#sample(env, wave, sh.pos, rate(ds), ds.length, cx, pps, half);
      if (env.n >= 2) any = true;
    }
    if (any) {
      // The lead deck in its true colours.
      if (lead >= 0 && this.#env[lead].n >= 2) this.#fill(lead, this.#env[lead], cy, st.decks[lead]?.playing ?? false);
      // The others as luminous outlines on top: a soft glow (screened, so
      // crossing decks mix), a thin dark casing so the line reads over the
      // lead deck's fill, then the line itself.
      ctx.lineJoin = 'bevel';
      for (const i of order) {
        const env = this.#env[i];
        if (env.n < 2 || i === lead) continue;
        const a = st.decks[i]?.playing ? OTHER_LINE.playing : OTHER_LINE.paused;
        this.#outline(env, cy);
        ctx.globalCompositeOperation = 'screen';
        ctx.strokeStyle = DECK_SHADES[i].mid;
        ctx.globalAlpha = a * 0.28;
        ctx.lineWidth = 6;
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = '#05060a';
        ctx.globalAlpha = a * 0.4;
        ctx.lineWidth = 2.8;
        ctx.stroke();
        ctx.strokeStyle = DECK_SHADES[i].line;
        ctx.globalAlpha = a;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Beat grid ruler.
    for (const i of order) {
      const ds = st.decks[i];
      const sh = this.#shown[i];
      const grid = ds && sh.live ? gridFor(i, ds) : null;
      if (!ds || !grid) continue;
      this.#ticks(i, grid, sh.pos, rate(ds), ds.length, cx, pps, lane, ruler, i === lead ? 'lead' : ds.playing ? 'playing' : 'paused');
    }

    // The past fades a little; both ends fade out.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0, 0, 0, ${PAST_DIM})`;
    ctx.fillRect(0, 0, cx - 1, h);
    const fade = Math.min(80, w * 0.05);
    let g = ctx.createLinearGradient(0, 0, fade, 0);
    g.addColorStop(0, 'rgba(0, 0, 0, 1)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, fade, h);
    g = ctx.createLinearGradient(w - fade * 1.6, 0, w, 0);
    g.addColorStop(0, 'rgba(0, 0, 0, 0)');
    g.addColorStop(1, 'rgba(0, 0, 0, 1)');
    ctx.fillStyle = g;
    ctx.fillRect(w - fade * 1.6, 0, fade * 1.6, h);
    ctx.globalCompositeOperation = 'source-over';

    this.#playhead(st, cx, h, lead);
    this.#markers(st, w, cy);
  }

  /** Envelope of one deck over the visible window, in CSS px from the centre line. */
  #sample(env: Envelope, wave: DeckWave, pos: number, r: number, length: number, cx: number, pps: number, half: number): void {
    const w = this.#w;
    const end = Math.min(length > 0 ? length : Infinity, wave.blocks * wave.blockSec);
    const x0 = Math.max(0, cx + ((0 - pos) / r) * pps);
    const x1 = Math.min(w, cx + ((end - pos) / r) * pps);
    if (x1 - x0 < 1) return;
    const amp = wave.amp;
    const last = wave.blocks - 1;
    const perPx = r / pps / wave.blockSec; // blocks per CSS px
    const span = STEP * perPx;
    const n = Math.min(env.xs.length, Math.ceil((x1 - x0) / STEP) + 1);
    for (let k = 0; k < n; k++) {
      const x = k === n - 1 ? x1 : x0 + k * STEP;
      // Block centres sit half a block in.
      const f = (pos / wave.blockSec) + (x - cx) * perPx - 0.5;
      let lo: number;
      let mi: number;
      let hi: number;
      if (span <= 1) {
        // Zoomed in: interpolate between block centres.
        const b = clamp(Math.floor(f), 0, last);
        const b2 = Math.min(last, b + 1);
        const fr = clamp(f - b, 0, 1);
        const i = b * 3;
        const j = b2 * 3;
        lo = amp[i] + (amp[j] - amp[i]) * fr;
        mi = amp[i + 1] + (amp[j + 1] - amp[i + 1]) * fr;
        hi = amp[i + 2] + (amp[j + 2] - amp[i + 2]) * fr;
      } else {
        // Zoomed out: the loudest block under this column.
        const b0 = clamp(Math.round(f - span / 2), 0, last);
        const b1 = clamp(Math.round(f + span / 2), b0, last);
        lo = 0;
        mi = 0;
        hi = 0;
        for (let b = b0 * 3; b <= b1 * 3; b += 3) {
          if (amp[b] > lo) lo = amp[b];
          if (amp[b + 1] > mi) mi = amp[b + 1];
          if (amp[b + 2] > hi) hi = amp[b + 2];
        }
      }
      env.xs[k] = x;
      env.yl[k] = lo * half;
      env.ym[k] = mi * half;
      env.yh[k] = hi * half;
    }
    env.n = n;
  }

  /** Fill one deck's stacked bands: highs outside, then mids, lows at the core. */
  #fill(i: number, env: Envelope, cy: number, playing: boolean): void {
    const ctx = this.#ctx;
    const c = playing ? DECK_SHADES[i] : PAUSED_SHADES[i];
    mirrored(ctx, env, env.yh, cy);
    ctx.fillStyle = c.high;
    ctx.fill();
    mirrored(ctx, env, env.ym, cy);
    ctx.fillStyle = c.mid;
    ctx.fill();
    mirrored(ctx, env, env.yl, cy);
    ctx.fillStyle = c.low;
    ctx.fill();
  }

  /** Path along the outer envelope, top and bottom, lightly smoothed so lines stay calm. */
  #outline(env: Envelope, cy: number): void {
    const ctx = this.#ctx;
    const { n, xs, yh } = env;
    const at = (k: number) => (yh[Math.max(0, k - 1)] + 2 * yh[k] + yh[Math.min(n - 1, k + 1)]) / 4;
    ctx.beginPath();
    ctx.moveTo(xs[0], cy - at(0));
    for (let k = 1; k < n; k++) ctx.lineTo(xs[k], cy - at(k));
    ctx.moveTo(xs[0], cy + at(0));
    for (let k = 1; k < n; k++) ctx.lineTo(xs[k], cy + at(k));
  }

  /** An active loop: a tint in the deck colour, bracketed at both ends. */
  #loop(i: number, loop: Loop, pos: number, r: number, cx: number, pps: number, ruler: number, isLead: boolean): void {
    const ctx = this.#ctx;
    const h = this.#h;
    const dpr = this.#dpr;
    const x0 = Math.round((cx + ((loop.start - pos) / r) * pps) * dpr) / dpr;
    const x1 = Math.round((cx + ((loop.end - pos) / r) * pps) * dpr) / dpr;
    if (x1 < 0 || x0 > this.#w) return;
    // Strongest along the ruler, nearly clear over the waveform.
    const c = DECK_SHADES[i].mid;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, rgba(c, 0.34));
    g.addColorStop(0.3, rgba(c, 0.08));
    g.addColorStop(0.7, rgba(c, 0.08));
    g.addColorStop(1, rgba(c, 0.34));
    ctx.fillStyle = g;
    ctx.globalAlpha = isLead ? 1 : 0.65;
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.fillStyle = c;
    ctx.globalAlpha = isLead ? 0.95 : 0.7;
    const arm = Math.min(10, (x1 - x0) / 3);
    for (const [x, dir] of [
      [x0, 1],
      [x1, -1],
    ] as const) {
      ctx.fillRect(x - 0.75, 0, 1.5, h);
      // Brackets: short arms pointing into the loop, top and bottom, just inside the ruler.
      ctx.fillRect(dir > 0 ? x : x - arm, ruler - 1.5, arm, 1.5);
      ctx.fillRect(dir > 0 ? x : x - arm, h - ruler, arm, 1.5);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Beats and bars of one deck: ticks in its own ruler lane along both edges
   * (bars stronger), or (`lines`, the lead deck) faint bar lines through the waveform.
   */
  #ticks(
    i: number,
    grid: BeatGrid,
    pos: number,
    r: number,
    length: number,
    cx: number,
    pps: number,
    lane: number,
    ruler: number,
    mode: 'lines' | 'lead' | 'playing' | 'paused',
  ): void {
    const ctx = this.#ctx;
    const w = this.#w;
    const h = this.#h;
    const dpr = this.#dpr;
    const beat = 60 / grid.bpm;
    const tL = pos + ((0 - cx) / pps) * r;
    const tR = pos + ((w - cx) / pps) * r;
    const k0 = Math.max(0, Math.ceil((tL - grid.first_beat) / beat));
    const k1 = Math.floor((Math.min(tR, length > 0 ? length : tR) - grid.first_beat) / beat);
    if (k1 < k0 || k1 - k0 > 400) return;
    ctx.fillStyle = DECK_SHADES[i].line;
    if (mode === 'lines') {
      ctx.globalAlpha = 0.1;
      for (let k = Math.ceil(k0 / 4) * 4; k <= k1; k += 4) {
        const x = Math.round((cx + ((grid.first_beat + k * beat - pos) / r) * pps) * dpr) / dpr;
        ctx.fillRect(x - 0.5, ruler, 1, h - 2 * ruler);
      }
      ctx.globalAlpha = 1;
      return;
    }
    const strength = mode === 'lead' ? 1 : mode === 'playing' ? 0.9 : 0.5;
    const y = 2 + i * lane;
    const lh = lane - 0.75;
    for (let k = k0; k <= k1; k++) {
      const x = Math.round((cx + ((grid.first_beat + k * beat - pos) / r) * pps) * dpr) / dpr;
      if (k % 4 === 0) {
        ctx.globalAlpha = strength;
        ctx.fillRect(x - 1.25, y, 2.5, lh);
        ctx.fillRect(x - 1.25, h - y - lh, 2.5, lh);
      } else {
        // Beats: shorter and thinner, on the side towards the waveform.
        ctx.globalAlpha = strength * 0.75;
        ctx.fillRect(x - 0.75, y + lh * 0.35, 1.5, lh * 0.65);
        ctx.fillRect(x - 0.75, h - y - lh, 1.5, lh * 0.65);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Deck to draw filled (-1: none has a waveform). */
  #lead(st: StateMsg): number {
    const drawable = (i: number) => {
      const ds = st.decks[i];
      const wave = waves.decks[i];
      return !!ds?.track_id && this.#shown[i].live && wave?.trackId === ds.track_id;
    };
    if (st.focused >= 0 && st.focused < DECK_COUNT && drawable(st.focused)) return st.focused;
    const decks = [...Array(DECK_COUNT).keys()].filter(drawable);
    return decks.find((i) => st.decks[i].master) ?? decks.find((i) => st.decks[i].playing) ?? decks[0] ?? -1;
  }

  #playhead(st: StateMsg, cx: number, h: number, lead: number): void {
    const ctx = this.#ctx;
    const dpr = this.#dpr;
    const x = Math.round(cx * dpr) / dpr;
    // A soft glow that kicks on the lead deck's beats (steady with reduced motion).
    let glow = 0.18;
    const ds = st.decks[lead];
    const grid = ds ? gridFor(lead, ds) : null;
    if (!this.#reduced && ds?.playing && grid && this.#shown[lead]?.live) {
      const beats = ((this.#shown[lead].pos - grid.first_beat) * grid.bpm) / 60;
      const phase = beats - Math.floor(beats);
      glow = 0.12 + 0.3 * (1 - phase) ** 4;
    }
    const g = ctx.createLinearGradient(x - 14, 0, x + 14, 0);
    g.addColorStop(0, 'rgba(255, 255, 255, 0)');
    g.addColorStop(0.5, `rgba(255, 255, 255, ${glow})`);
    g.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - 14, 0, 28, h);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillRect(x - 0.75, 0, 1.5, h);
    // Notches top and bottom.
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 5);
    ctx.closePath();
    ctx.moveTo(x - 5, h);
    ctx.lineTo(x + 5, h);
    ctx.lineTo(x, h - 5);
    ctx.closePath();
    ctx.fill();
  }

  /** Deck numbers down the right edge, in their colours; the focused one filled. */
  #markers(st: StateMsg, w: number, cy: number): void {
    const ctx = this.#ctx;
    const size = 15;
    const gap = 4;
    const total = DECK_COUNT * size + (DECK_COUNT - 1) * gap;
    const x = w - size - 8;
    ctx.font = `700 10.5px ${this.#mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < DECK_COUNT; i++) {
      const ds = st.decks[i];
      if (!ds?.track_id) continue;
      const y = cy - total / 2 + i * (size + gap);
      const c = DECK_SHADES[i].mid;
      const focused = i === st.focused;
      ctx.globalAlpha = ds.playing || focused ? 1 : 0.6;
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 0.5, size - 1, size - 1, 3.5);
      if (focused) {
        ctx.fillStyle = c;
        ctx.fill();
        ctx.fillStyle = '#08090b';
      } else {
        ctx.fillStyle = 'rgba(8, 9, 11, 0.7)';
        ctx.fill();
        ctx.strokeStyle = c;
        ctx.lineWidth = 1.25;
        ctx.stroke();
        ctx.fillStyle = c;
      }
      ctx.fillText(String(i + 1), x + size / 2, y + size / 2 + 0.5);
    }
    ctx.globalAlpha = 1;
  }
}

/** Band shades for a paused lead deck: the same colours, darker. */
const PAUSED_SHADES = DECK_SHADES.map((c) => ({ low: dim(c.low), mid: dim(c.mid), high: dim(c.high) }));

function dim(hex: string): string {
  const [r, g, b] = hexToRgb(hex).map((v) => Math.round(v * LEAD_PAUSED));
  return `rgb(${r}, ${g}, ${b})`;
}

/** Closed path around [-y, +y] of the envelope. */
function mirrored(ctx: CanvasRenderingContext2D, env: Envelope, ys: Float32Array, cy: number): void {
  const { n, xs } = env;
  ctx.beginPath();
  ctx.moveTo(xs[0], cy - ys[0]);
  for (let k = 1; k < n; k++) ctx.lineTo(xs[k], cy - ys[k]);
  for (let k = n - 1; k >= 0; k--) ctx.lineTo(xs[k], cy + ys[k]);
  ctx.closePath();
}

function gridFor(deck: number, ds: DeckState): BeatGrid | null {
  const info = client.deckInfo[deck];
  const grid = info && info.track.id === ds.track_id ? info.grid : null;
  return grid && grid.bpm > 0 && Number.isFinite(grid.first_beat) ? grid : null;
}

function activeLoop(ds: DeckState): Loop | null {
  const l = ds.loop;
  if (!l?.active || l.start == null || l.end == null || !(l.end > l.start)) return null;
  return { start: l.start, end: l.end };
}

function wrapLoop(t: number, loop: Loop): number {
  const len = loop.end - loop.start;
  return loop.start + ((((t - loop.start) % len) + len) % len);
}

/** Wrap a difference into [-len/2, len/2). */
function wrapSym(d: number, len: number): number {
  return d - len * Math.round(d / len);
}

/** Playback rate for the time axis (guards against a stopped or bogus rate). */
function rate(ds: DeckState): number {
  return ds.rate > 0.05 ? ds.rate : 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
