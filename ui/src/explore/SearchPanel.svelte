<script lang="ts">
  import { tick } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { fly } from 'svelte/transition';
  import MixerKey from '../components/MixerKey.svelte';
  import { client } from '../lib/client.svelte';
  import { fmtBpm, fmtLength, idToName } from '../lib/format';
  import { keysFor } from '../lib/mixer';
  import { search, TRACK_DRAG } from '../lib/search.svelte';

  /**
   * Type anywhere in the valley to search. Results come ranked from the server
   * (`browser.ids`) and its selection is the best match, so the mixer's load
   * buttons act on it. Enter flies the valley there; Esc closes.
   */

  const MAX_ROWS = 12;
  const motion = new MediaQuery('prefers-reduced-motion: reduce');

  let input: HTMLInputElement | undefined = $state();

  const ids = $derived(client.browser.ids);
  const selected = $derived(client.browser.selected);
  const rows = $derived(
    ids.slice(0, MAX_ROWS).map((id) => {
      const t = client.library.get(id);
      return {
        id,
        title: t?.title ?? idToName(id),
        artist: t?.artist ?? null,
        bpm: t?.bpm ?? null,
        length: t?.duration ?? null,
      };
    }),
  );
  const loadKeys = $derived(keysFor(client.mixer, 'deck.load_selected'));
  const rootKeys = $derived(keysFor(client.mixer, 'explore.root'));

  $effect(() => {
    search.input = input ?? null;
    return () => {
      search.input = null;
    };
  });

  // Focus the box when it opens, with the caret after the first character.
  $effect(() => {
    if (search.open) {
      tick().then(() => {
        input?.focus();
        const end = input?.value.length ?? 0;
        input?.setSelectionRange(end, end);
      });
    }
  });

  // A track from the results got loaded (usually from the mixer): done searching.
  let loadedAtOpen = '';
  $effect(() => {
    const loaded = client.deckInfo.map((d) => d?.track.id ?? '').join('|');
    if (!search.open) {
      loadedAtOpen = loaded;
      return;
    }
    // Drag-and-drop loads keep the panel open, so several decks can be filled.
    if (loaded !== loadedAtOpen && selected && selected !== search.dropped && loaded.split('|').includes(selected)) {
      search.close();
    }
  });

  function onKey(e: KeyboardEvent) {
    if (search.key(e)) e.preventDefault();
  }

  function pick(id: string) {
    client.send({ cmd: 'select', track_id: id });
  }

  function fly_(id: string) {
    client.send({ cmd: 'select', track_id: id });
    client.send({ cmd: 'explore_root_selected' });
    search.close();
  }
</script>

{#if search.open}
  <div class="panel" transition:fly={{ y: motion.current ? 0 : -12, duration: motion.current ? 0 : 160 }} role="dialog" aria-label="Search the library">
    <label class="box">
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" /><path d="M10.4 10.4 14 14" /></svg>
      <input
        bind:this={input}
        type="search"
        spellcheck="false"
        autocomplete="off"
        placeholder="Search title, artist…"
        value={search.query}
        oninput={(e) => search.set(e.currentTarget.value)}
        onkeydown={onKey}
      />
      <span class="count">{ids.length === 0 ? 'no matches' : `${ids.length} ${ids.length === 1 ? 'match' : 'matches'}`}</span>
    </label>

    {#if rows.length}
      <ul class="results" role="listbox" aria-label="Results">
        {#each rows as r (r.id)}
          <li>
            <button
              type="button"
              class="row"
              class:selected={r.id === selected}
              role="option"
              aria-selected={r.id === selected}
              onclick={() => pick(r.id)}
              ondblclick={() => fly_(r.id)}
              draggable="true"
              ondragstart={(e) => {
                e.dataTransfer?.setData(TRACK_DRAG, r.id);
                e.dataTransfer?.setData('text/plain', r.title);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <span class="title">{r.title}</span>
              <span class="artist">{r.artist ?? ''}</span>
              <span class="num">{r.bpm ? fmtBpm(r.bpm) : ''}</span>
              <span class="num">{r.length ? fmtLength(r.length) : ''}</span>
            </button>
          </li>
        {/each}
      </ul>
      {#if ids.length > MAX_ROWS}<p class="more">+ {ids.length - MAX_ROWS} more, keep typing</p>{/if}
    {/if}

    <footer>
      <span><kbd>↑↓</kbd> pick</span>
      <span><kbd>Enter</kbd> explore from here</span>
      {#if loadKeys.length}<span>{#each loadKeys as k, i (i)}{#if i}/{/if}<MixerKey {k} />{/each} load</span>{/if}
      {#if rootKeys.length}<span>{#each rootKeys as k, i (i)}{#if i}/{/if}<MixerKey {k} />{/each} fly here</span>{/if}
      <span>drag onto a deck to load</span>
      <span><kbd>Esc</kbd> close</span>
    </footer>
  </div>
{/if}

<style>
  .panel {
    position: absolute;
    top: 76px;
    left: 50%;
    z-index: 30;
    width: min(720px, calc(100vw - 32px));
    transform: translateX(-50%);
    padding: 10px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 14px;
    background: rgba(22, 35, 27, 0.94);
    backdrop-filter: blur(14px) saturate(1.2);
    box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.8), 0 0 0 1px color-mix(in srgb, var(--band, #fff) 14%, transparent);
  }
  .box {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 10px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.05);
  }
  .box svg {
    flex: none;
    width: 18px;
    height: 18px;
    fill: none;
    stroke: var(--text-3);
    stroke-width: 1.6;
    stroke-linecap: round;
  }
  input {
    flex: 1;
    min-width: 0;
    height: 44px;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text);
    font: 600 22px/1 var(--font-ui);
  }
  input::-webkit-search-cancel-button {
    display: none;
  }
  .count {
    flex: none;
    font: 600 12px/1 var(--font-mono);
    color: var(--text-3);
  }
  .results {
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
    max-height: min(60vh, 560px);
    overflow: auto;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) 4.5em 3.5em;
    gap: 14px;
    align-items: center;
    width: 100%;
    min-height: 40px;
    padding: 6px 12px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text-2);
    text-align: left;
    cursor: pointer;
  }
  .row[draggable='true'] {
    cursor: grab;
  }
  .row:active {
    cursor: grabbing;
  }
  .row:hover {
    background: rgba(255, 255, 255, 0.04);
  }
  .row.selected {
    background: color-mix(in srgb, var(--band, #8af) 20%, transparent);
    color: var(--text);
    box-shadow: inset 3px 0 0 var(--band, #8af);
  }
  .title,
  .artist {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .title {
    font-size: 15px;
    font-weight: 620;
  }
  .artist {
    font-size: 13px;
    color: var(--text-3);
  }
  .selected .artist {
    color: var(--text-2);
  }
  .num {
    font: 600 12.5px/1 var(--font-mono);
    font-variant-numeric: tabular-nums;
    text-align: right;
    color: var(--text-3);
  }
  .more {
    margin: 6px 12px 0;
    font-size: 12px;
    color: var(--text-3);
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    margin-top: 10px;
    padding: 8px 6px 2px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    font-size: 12px;
    color: var(--text-3);
  }
  footer span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  kbd {
    padding: 1px 6px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 4px;
    font: 600 11px/1.5 var(--font-mono);
    color: var(--text-2);
  }
</style>
