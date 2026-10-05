<script lang="ts">
  import { lighten } from '../lib/decks';
  import { fmtTime } from '../lib/format';
  import { buildLayers } from '../lib/waveform';

  type Props = {
    peaks: number[] | null;
    position: number;
    length: number;
    cue: number;
    color: string;
    loading: boolean;
    onseek: (fraction: number) => void;
  };

  let { peaks, position, length, cue, color, loading, onseek }: Props = $props();

  let wrap: HTMLDivElement;
  let canvas: HTMLCanvasElement;

  /** Canvas size in device pixels. */
  let size = $state({ w: 0, h: 0 });
  /** Pointer x as a 0..1 fraction while hovering, for the hover line + time. */
  let hover = $state<number | null>(null);
  let seeking = false;
  let seekFrame = 0;
  let seekTarget = 0;

  const canSeek = $derived(!!peaks && length > 0);
  const layers = $derived(peaks && size.w > 0 ? buildLayers(peaks, size.w, size.h, color) : null);
  const playheadColor = $derived(lighten(color, 0.7));

  $effect(() => {
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      const dev = entry.devicePixelContentBoxSize?.[0];
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(dev ? dev.inlineSize : entry.contentRect.width * dpr);
      const h = Math.round(dev ? dev.blockSize : entry.contentRect.height * dpr);
      if (w !== size.w || h !== size.h) size = { w, h };
    });
    try {
      ro.observe(wrap, { box: 'device-pixel-content-box' });
    } catch {
      ro.observe(wrap);
    }
    return () => ro.disconnect();
  });

  // Redraw whenever anything visible changes; the state stream is already
  // coalesced to one update per animation frame.
  $effect(() => {
    draw(size.w, size.h, layers, position, length, cue, hover, playheadColor);
  });

  function draw(
    w: number,
    h: number,
    l: typeof layers,
    pos: number,
    len: number,
    cuePos: number,
    hoverFrac: number | null,
    headColor: string,
  ) {
    if (!canvas || w === 0 || h === 0) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const dpr = window.devicePixelRatio || 1;
    const px = (n: number) => Math.max(1, Math.round(n * dpr));
    const mid = Math.floor(h / 2);

    // Centre line, always: shows the deck is "there" even when empty.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.fillRect(0, mid, w, px(1));

    if (!l || len <= 0) return;

    const frac = clamp01(pos / len);
    const x = Math.round(frac * w);
    if (x > 0) ctx.drawImage(l.played, 0, 0, x, h, 0, 0, x, h);
    if (x < w) ctx.drawImage(l.unplayed, x, 0, w - x, h, x, 0, w - x, h);

    // Minute ticks along the bottom edge.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    const tick = px(4);
    for (let m = 60; m < len; m += 60) {
      const tx = Math.round((m / len) * w);
      ctx.fillRect(tx, h - tick, px(1), tick);
    }

    // Cue marker: thin line with a flag at the top (kept fully on-canvas).
    const flag = px(6);
    const cx = Math.min(w - px(1), Math.round(clamp01(cuePos / len) * w));
    const fx = Math.min(w - flag - px(1), Math.max(flag, cx));
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(cx, 0, px(1), h);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(fx - flag, 0);
    ctx.lineTo(fx + flag + px(1), 0);
    ctx.lineTo(fx + px(0.5), flag + px(1));
    ctx.closePath();
    ctx.fill();

    if (hoverFrac !== null) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.fillRect(Math.round(hoverFrac * w), 0, px(1), h);
    }

    // Playhead: bright line with a dark keyline on both sides for contrast.
    const head = px(2);
    const hx = Math.min(w - head, Math.max(0, x - Math.floor(head / 2)));
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(hx - px(1), 0, head + px(2), h);
    ctx.fillStyle = headColor;
    ctx.fillRect(hx, 0, head, h);
  }

  function fractionAt(e: PointerEvent): number {
    const rect = canvas.getBoundingClientRect();
    return rect.width > 0 ? clamp01((e.clientX - rect.left) / rect.width) : 0;
  }

  function seekTo(fraction: number) {
    seekTarget = fraction;
    if (seekFrame) return;
    seekFrame = requestAnimationFrame(() => {
      seekFrame = 0;
      onseek(seekTarget);
    });
  }

  function onpointerdown(e: PointerEvent) {
    if (!canSeek || e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    seeking = true;
    seekTo(fractionAt(e));
  }

  function onpointermove(e: PointerEvent) {
    if (!canSeek) return;
    const f = fractionAt(e);
    if (e.pointerType === 'mouse') hover = f;
    if (seeking) seekTo(f);
  }

  function endSeek() {
    seeking = false;
  }

  function clamp01(v: number): number {
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  }
</script>

<div class="wave" class:seekable={canSeek} bind:this={wrap}>
  <canvas
    bind:this={canvas}
    aria-label="Track overview. Click or drag to seek."
    {onpointerdown}
    {onpointermove}
    onpointerup={endSeek}
    onpointercancel={endSeek}
    onlostpointercapture={endSeek}
    onpointerleave={() => (hover = null)}
  ></canvas>
  {#if hover !== null && canSeek}
    <span class="hover-time" style:left="{hover * 100}%" class:flip={hover > 0.8}>{fmtTime(hover * length)}</span>
  {/if}
  {#if loading && peaks}
    <!-- Next track decoding; the current one stays usable underneath. -->
    <i class="bar top" aria-hidden="true"></i>
  {:else if loading}
    <div class="overlay loading"><span>Loading…</span><i class="bar"></i></div>
  {:else if !peaks}
    <div class="overlay empty">No track loaded</div>
  {/if}
</div>

<style>
  .wave {
    position: relative;
    min-height: 0;
    border-radius: var(--radius-sm);
    background:
      linear-gradient(to bottom, rgba(255, 255, 255, 0.025), transparent 50%, rgba(255, 255, 255, 0.025)),
      var(--bg-0);
    border: 1px solid var(--line);
    overflow: hidden;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
  }
  .seekable canvas {
    cursor: pointer;
  }
  .hover-time {
    position: absolute;
    top: 4px;
    transform: translateX(6px);
    padding: 1px 5px;
    font: 600 11px/1.4 var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text);
    background: rgba(11, 13, 16, 0.85);
    border-radius: 3px;
    pointer-events: none;
    white-space: nowrap;
  }
  .hover-time.flip {
    transform: translateX(calc(-100% - 6px));
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    gap: 8px;
    pointer-events: none;
    font-size: 13px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .loading {
    color: var(--text-2);
    background: rgba(11, 13, 16, 0.55);
  }
  .bar {
    display: block;
    width: 120px;
    height: 3px;
    border-radius: 2px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent) 0 0 / 50% 100% no-repeat,
      rgba(255, 255, 255, 0.08);
    animation: slide 1s linear infinite;
  }
  .bar.top {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 3px;
    border-radius: 0;
    pointer-events: none;
    background: linear-gradient(90deg, transparent, var(--accent), transparent) 0 0 / 30% 100% no-repeat,
      rgba(0, 0, 0, 0.5);
  }
  @keyframes slide {
    from {
      background-position: -100% 0, 0 0;
    }
    to {
      background-position: 200% 0, 0 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .bar {
      animation: none;
      background: var(--accent);
      opacity: 0.5;
    }
  }
</style>
