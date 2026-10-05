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

<div class="strip" role="img" aria-label="Deck waveforms around the playhead">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .strip {
    position: relative;
    height: clamp(80px, 11vh, 150px);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: var(--radius);
    background: linear-gradient(to bottom, rgba(6, 7, 10, 0.5), rgba(6, 7, 10, 0.66) 50%, rgba(6, 7, 10, 0.5));
    backdrop-filter: blur(10px) saturate(1.15);
    overflow: hidden;
    pointer-events: none;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
