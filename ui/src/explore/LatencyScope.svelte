<script lang="ts">
  import { onMount } from 'svelte';
  import { LATENCY_KEEP, latency } from '../lib/latency';

  let { connected, label, accent }: { connected: boolean; label: string; accent: string } = $props();

  let canvas: HTMLCanvasElement;
  /** Live numbers, refreshed four times a second (the graphs run every frame). */
  let liveMs = $state<number | null>(null);
  let jitterUs = $state(0);
  let renderUs = $state(0);
  let underruns = $state(0);
  let urbs = $state(3);

  /** Histogram: packet intervals from 1.0 to 2.35 ms in 50 µs bins, with peak-hold caps. */
  const BIN_US = 50;
  const BIN_FROM = 1000;
  const BINS = 27;
  /** The trace shows the last 1.6 s (960 packets), ±700 µs around the nominal interval. */
  const TRACE = 960;
  const SPAN_US = 400;

  onMount(() => {
    const ctx = canvas.getContext('2d')!;
    const bins = new Float32Array(BINS);
    const caps = new Float32Array(BINS);
    let raf = 0;
    let seen = -1;
    let last = performance.now();
    let numbersAt = 0;
    let w = 0,
      h = 0,
      dpr = 1;
    const resize = () => {
      // Pixel art: a coarse grid, shown with hard pixels.
      dpr = 0.5;
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      seen = -1;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const L = latency;
      const n = Math.min(L.count, LATENCY_KEEP);
      const nominal = L.packetUs;
      // Peak caps fall even when no packets arrive.
      for (let b = 0; b < BINS; b++) caps[b] = Math.max(bins[b], caps[b] - dt * 0.6);
      if (L.count === seen && now - numbersAt < 250) {
        draw();
        return;
      }
      seen = L.count;
      // The interval distribution over the last ~0.8 s, as a share of the busiest bin.
      bins.fill(0);
      const window = Math.min(n, 480);
      let sum = 0,
        sum2 = 0,
        render = 0,
        queued = 0;
      for (let i = 0; i < window; i++) {
        const k = (L.count - 1 - i + LATENCY_KEEP * 4) % LATENCY_KEEP;
        const v = L.interval[k];
        const b = Math.floor((v - BIN_FROM) / BIN_US);
        bins[Math.max(0, Math.min(BINS - 1, b))]++;
        sum += v;
        sum2 += v * v;
        render += L.render[k];
        queued += L.queued[k];
      }
      let top = 1;
      for (let b = 0; b < BINS; b++) top = Math.max(top, bins[b]);
      // Log scale, so the rare late packets still show.
      for (let b = 0; b < BINS; b++) {
        bins[b] = bins[b] > 0 ? Math.log1p(bins[b]) / Math.log1p(top) : 0;
        caps[b] = Math.max(caps[b], bins[b]);
      }
      if (now - numbersAt >= 250 && window > 0) {
        numbersAt = now;
        const mean = sum / window;
        jitterUs = Math.sqrt(Math.max(0, sum2 / window - mean * mean));
        renderUs = render / window;
        // Output latency now: the packets queued ahead of the one being rendered, plus it.
        liveMs = ((queued / window + 1) * nominal) / 1000;
        underruns = L.underruns;
        urbs = L.outUrbs;
      }
      draw();

      function draw() {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const split = Math.round(w * 0.58);
        // Trace: every packet's interval, newest at the right edge.
        const th = h - 4;
        const mid = th / 2 + 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(split - 8, mid);
        ctx.stroke();
        ctx.setLineDash([]);
        const count = Math.min(n, TRACE);
        if (count > 1) {
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.2;
          ctx.shadowColor = accent;
          ctx.shadowBlur = 0;
          ctx.beginPath();
          for (let i = 0; i < count; i++) {
            const k = (L.count - count + i + LATENCY_KEEP * 4) % LATENCY_KEEP;
            const x = ((i + TRACE - count) / (TRACE - 1)) * (split - 8);
            const y = mid - Math.max(-1, Math.min(1, (L.interval[k] - nominal) / SPAN_US)) * (th / 2);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
          ctx.shadowBlur = 0;
        }
        // Histogram: how often each interval happens, like a spectrum analyser.
        const bw = (w - split) / BINS;
        const nominalBin = (nominal - BIN_FROM) / BIN_US;
        for (let b = 0; b < BINS; b++) {
          const x = split + b * bw;
          const bh = bins[b] * (h - 6);
          const off = Math.abs(b + 0.5 - nominalBin) > 2;
          ctx.fillStyle = off ? '#ff4d6d' : accent;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(x + 0.5, h - bh, Math.max(1, bw - 1.5), bh);
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x + 0.5, h - caps[b] * (h - 6) - 2, Math.max(1, bw - 1.5), 1.5);
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  });
</script>

<div class="scope" class:off={!connected} title="Every USB packet to the mixer: its interval (left, ±0.4 ms around 1.67 ms) and how often each interval happens (right, log scale)">
  <div class="head">
    <span class="dot"></span>
    <span class="label">{label}</span>
  </div>
  <div class="big">
    <b>{liveMs !== null && connected ? liveMs.toFixed(1) : '—'}</b><small>ms out</small>
  </div>
  <div class="meta">{urbs} URBs · jitter ±{Math.round(jitterUs)} µs · render {Math.round(renderUs)} µs{underruns ? ` · ${underruns} underruns` : ''}</div>
  <canvas bind:this={canvas} aria-hidden="true"></canvas>
</div>

<style>
  .scope {
    width: 300px;
    padding: 8px 10px 8px;
    border: 1px solid color-mix(in srgb, var(--band) 45%, transparent);
    background: rgba(4, 2, 12, 0.94);
    box-shadow: 0 0 18px color-mix(in srgb, var(--band) 18%, transparent);
    font: 600 11px/1.3 var(--font-mono);
    color: #d6d9f0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .label {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 11.5px;
    color: #fff;
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 8px var(--ok);
  }
  .off .dot {
    background: var(--bad);
    box-shadow: 0 0 8px var(--bad);
  }
  .big {
    margin-top: 4px;
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .big b {
    font: italic 900 30px/1 'Arial Black', var(--font-ui);
    color: var(--band);
    text-shadow: 0 0 14px color-mix(in srgb, var(--band) 60%, transparent);
    font-variant-numeric: tabular-nums;
  }
  .big small {
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: #a4a8c8;
  }
  .meta {
    margin-top: 2px;
    color: #a4a8c8;
    font-size: 10px;
    white-space: nowrap;
  }
  canvas {
    display: block;
    width: 100%;
    height: 54px;
    margin-top: 6px;
  }
</style>
