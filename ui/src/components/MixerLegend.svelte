<script lang="ts">
  import { bandPalette } from '../explore/palette';
  import { client } from '../lib/client.svelte';
  import { legend, type LegendSlot } from '../lib/mixer';
  import type { View } from '../lib/protocol';
  import MixerKey from './MixerKey.svelte';

  /**
   * One line of "mixer control · what it does", built from the live mappings.
   * `tone="overlay"` floats over the tunnel; `"panel"` sits in a card footer.
   */
  let {
    slots,
    view,
    tone = 'panel',
    lead = false,
    errors = true,
  }: {
    slots: readonly LegendSlot[];
    view: View;
    tone?: 'overlay' | 'panel';
    /** Lead with a small "Xone" label. */
    lead?: boolean;
    /** Say so when mappings.toml failed to load (off where another legend already does). */
    errors?: boolean;
  } = $props();

  const items = $derived(legend(client.mixer, slots, view));
  const broken = $derived(errors && client.mappings != null && !client.mappings.ok);
</script>

{#if items.length || broken}
  <p class="legend {tone}" aria-label="Mixer controls">
    {#if lead}
      <span class="lead" aria-hidden="true">
        <svg viewBox="0 0 20 14"><circle cx="5" cy="7" r="4" /><circle cx="15" cy="7" r="4" /><path d="M10 2v10" /></svg>
        Xone
      </span>
    {/if}
    {#each items as item (item.id)}
      <span class="item">
        <MixerKey k={item.key} />
        <span class="act">
          {#each item.parts as part, i (i)}
            {#if part.band}<b style:color={bandPalette(part.band).css}>{part.text}</b>{:else}{part.text}{/if}
          {/each}
        </span>
      </span>
    {/each}
    {#if broken}
      <span class="bad" title={client.mappings?.error ?? ''}>Mixer mappings have an error ({client.mappings?.path})</span>
    {/if}
  </p>
{/if}

<style>
  .legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 15px;
    margin: 0;
    font-size: 12.5px;
    line-height: 1.2;
  }
  .overlay {
    justify-content: center;
    text-shadow: 0 1px 6px rgba(0, 0, 0, 0.9);
  }
  .item {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
  }
  .act {
    color: var(--text-2);
  }
  .act b {
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .lead {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-right: -4px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .lead svg {
    width: 18px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
  }
  .overlay :global(.mk) {
    background: rgba(8, 9, 12, 0.55);
    backdrop-filter: blur(6px);
  }
  .bad {
    color: var(--bad);
  }
</style>
