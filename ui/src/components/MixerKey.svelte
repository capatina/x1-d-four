<script lang="ts">
  import { keyText, type MixerKey } from '../lib/mixer';

  /** A mixer control as a small chip: pod letter, then the control's name. Sized in em. */
  let { k }: { k: MixerKey } = $props();
</script>

<span class="mk" title="{keyText(k)} on the mixer">
  {#if k.shift}<span class="shift">shift</span>{/if}
  {#if k.side}<span class="side">{k.side}</span>{/if}
  <span class="name">{k.name}</span>
</span>

<style>
  .mk {
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
    height: 1.72em;
    padding: 0 0.55em 0 0.22em;
    border: 1px solid rgba(255, 255, 255, 0.13);
    border-radius: 0.42em;
    background: rgba(255, 255, 255, 0.045);
    font-weight: 640;
    line-height: 1;
    color: var(--text);
    white-space: nowrap;
    vertical-align: middle;
  }
  .side {
    display: grid;
    place-items: center;
    min-width: 1.32em;
    height: 1.32em;
    border-radius: 0.3em;
    background: rgba(255, 255, 255, 0.13);
    font-size: 0.86em;
    font-weight: 780;
    color: var(--text);
  }
  .shift {
    padding: 0 0.3em;
    border-radius: 0.3em;
    background: color-mix(in srgb, var(--warn) 22%, transparent);
    font-size: 0.78em;
    font-weight: 720;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--warn);
  }
  /* Bare letters (pod buttons A–X) get no badge padding to balance. */
  .mk:not(:has(.side)) {
    padding-left: 0.55em;
  }
</style>
