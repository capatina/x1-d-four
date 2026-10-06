<script lang="ts">
  import { onMount } from 'svelte';
  import { WaveRenderer } from './waveRender';

  let { onStats, accent }: { onStats?: (drawMs: number) => void; accent: string } = $props();

  let canvas: HTMLCanvasElement;
  let renderer = $state.raw<WaveRenderer | null>(null);
  $effect(() => renderer?.setAccent(accent));

  onMount(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    try {
      renderer = new WaveRenderer(canvas, motion.matches);
    } catch {
      return;
    }
    const r = renderer;
    r.setAccent(accent);
    const onMotion = () => r.setReducedMotion(motion.matches);
    motion.addEventListener('change', onMotion);
    const stats = onStats ? setInterval(() => onStats(r.drawMs), 500) : undefined;
    return () => {
      clearInterval(stats);
      motion.removeEventListener('change', onMotion);
      r.dispose();
      renderer = null;
    };
  });
</script>

<div class="strip" role="img" aria-label="The Current: four deck waveforms, four seconds before and after the playhead">
  <div class="caption"><span>−4 s</span><b>NOW</b><span>+4 s / FOUR DECKS · ONE STREAM</span></div>
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .strip { position: relative; height: clamp(140px, 19vh, 215px); pointer-events: none; }
  .caption { position: absolute; top: 0; left: 16px; right: 16px; display: grid; grid-template-columns: 1fr auto 1fr; font: 500 9px var(--font-mono); letter-spacing: .16em; color: #d6dbc2; }
  .caption > span:last-child { text-align: right; }
  .caption b { font-weight: 500; color: #f4edd4; }
  canvas { display: block; width: 100%; height: calc(100% - 24px); position: absolute; bottom: 0; }
</style>
