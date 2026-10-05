<script lang="ts">
  import { onMount } from 'svelte';
  import { WaveRenderer } from './waveRender';

  let { onStats }: { onStats?: (drawMs: number) => void } = $props();

  let canvas: HTMLCanvasElement;

  onMount(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let renderer: WaveRenderer | null = null;
    try {
      renderer = new WaveRenderer(canvas, motion.matches);
    } catch {
      return;
    }
    const r = renderer;
    const onMotion = () => r.setReducedMotion(motion.matches);
    motion.addEventListener('change', onMotion);
    const stats = onStats ? setInterval(() => onStats(r.drawMs), 500) : undefined;
    return () => {
      clearInterval(stats);
      motion.removeEventListener('change', onMotion);
      r.dispose();
    };
  });
</script>

<div class="strip" role="img" aria-label="Riverbank waveforms: four decks, four seconds before and after the playhead">
  <div class="caption"><span>THE CURRENT / −4 s</span><b>NOW</b><span>+4 s / FOUR DECKS · ONE RIVER</span></div>
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .strip { position: relative; height: clamp(140px, 19vh, 215px); pointer-events: none; }
  .caption { position: absolute; top: 0; left: 16px; right: 16px; display: grid; grid-template-columns: 1fr auto 1fr; font: 500 9px var(--font-mono); letter-spacing: .16em; color: #d6dbc2; }
  .caption > span:last-child { text-align: right; }
  .caption b { font-weight: 500; color: #f4edd4; }
  canvas { display: block; width: 100%; height: calc(100% - 24px); position: absolute; bottom: 0; }
</style>
