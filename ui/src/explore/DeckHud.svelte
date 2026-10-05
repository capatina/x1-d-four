<script lang="ts">
  import { client } from '../lib/client.svelte';
  import { deckColor } from '../lib/decks';
  import { idToName } from '../lib/format';
  import { DECK_COUNT } from '../lib/protocol';

  let { rootDeck }: { rootDeck: number | null } = $props();

  const DECKS = Array.from({ length: DECK_COUNT }, (_, i) => i);

  const decks = $derived(
    DECKS.map((i) => {
      const ds = client.state?.decks[i] ?? null;
      const info = client.deckInfo[i];
      const id = ds ? ds.track_id : (info?.track.id ?? null);
      const track = id == null ? null : info && info.track.id === id ? info.track : (client.library.get(id) ?? null);
      const length = ds?.length || (info && info.track.id === id ? info.length : 0) || 0;
      return {
        i,
        id,
        title: track?.title ?? (id ? idToName(id) : null),
        artist: track?.artist ?? null,
        playing: ds?.playing ?? false,
        loading: ds?.loading ?? false,
        progress: length > 0 ? Math.min(1, Math.max(0, (ds?.position ?? 0) / length)) : 0,
      };
    }),
  );
</script>

<div class="hud" role="group" aria-label="Decks">
  {#each decks as d (d.i)}
    <button
      type="button"
      class="deck"
      class:focused={client.focused === d.i}
      class:playing={d.playing}
      class:empty={d.id == null}
      style:--accent={deckColor(d.i)}
      onclick={() => client.focus(d.i)}
      title={d.title ? `Deck ${d.i + 1}: ${d.title}` : `Deck ${d.i + 1} is empty`}
      aria-pressed={client.focused === d.i}
    >
      <span class="num">{d.i + 1}</span>
      <span class="meta">
        <span class="title">
          {#if d.loading}<i>loading…</i>{:else}{d.title ?? 'Empty'}{/if}
        </span>
        <span class="artist">
          {#if rootDeck === d.i}<em>root</em>{/if}
          {d.artist ?? (d.id ? 'Unknown artist' : `${d.i + 1} loads the aimed track`)}
        </span>
      </span>
      <span class="state" aria-label={d.playing ? 'Playing' : 'Paused'}>
        {#if d.playing}
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.5v9l8-4.5z" /></svg>
        {:else if d.id}
          <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="1.5" width="3" height="9" rx="0.6" /><rect x="7" y="1.5" width="3" height="9" rx="0.6" /></svg>
        {/if}
      </span>
      <span class="bar" aria-hidden="true"><span style:transform="scaleX({d.progress})"></span></span>
    </button>
  {/each}
</div>

<style>
  .hud {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
  }
  .deck {
    position: relative;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    min-width: 0;
    height: 52px;
    padding: 0 12px 0 8px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: var(--radius);
    background: rgba(8, 9, 12, 0.62);
    backdrop-filter: blur(8px);
    color: var(--text);
    text-align: left;
    cursor: pointer;
    overflow: hidden;
  }
  .deck:hover {
    background: rgba(18, 20, 26, 0.75);
  }
  .deck.focused {
    border-color: color-mix(in srgb, var(--accent) 70%, transparent);
    box-shadow: 0 0 18px -6px var(--accent);
  }
  .num {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 1.5px solid var(--accent);
    border-radius: var(--radius-sm);
    font: 700 17px/1 var(--font-mono);
    color: var(--accent);
  }
  .focused .num {
    background: var(--accent);
    color: var(--bg-0);
  }
  .meta {
    display: grid;
    min-width: 0;
    line-height: 1.25;
  }
  .title,
  .artist {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .title {
    font-size: 13.5px;
    font-weight: 620;
  }
  .title i {
    color: var(--accent);
  }
  .artist {
    font-size: 11.5px;
    color: var(--text-3);
  }
  .empty .title {
    color: var(--text-3);
  }
  em {
    margin-right: 5px;
    padding: 0 4px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--band) 22%, transparent);
    font: 700 9.5px/1.5 var(--font-ui);
    font-style: normal;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--band);
    vertical-align: 1px;
  }
  .state svg {
    display: block;
    width: 12px;
    height: 12px;
    fill: var(--text-3);
  }
  .playing .state svg {
    fill: var(--accent);
    filter: drop-shadow(0 0 4px var(--accent));
  }
  .bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    background: rgba(255, 255, 255, 0.06);
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    opacity: 0.55;
    transform-origin: left;
  }
  .playing .bar span {
    opacity: 1;
    box-shadow: 0 0 6px var(--accent);
  }
</style>
