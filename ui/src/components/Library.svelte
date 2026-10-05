<script lang="ts">
  import { untrack } from 'svelte';
  import { client } from '../lib/client.svelte';
  import { deckColor } from '../lib/decks';
  import { fmtBpm, fmtLength, idToName } from '../lib/format';
  import { DECKS_LEGEND } from '../lib/mixer';
  import { DECK_COUNT } from '../lib/protocol';
  import MixerLegend from './MixerLegend.svelte';

  /** Row height in px; must match --row-h below. */
  const ROW = 34;
  const OVERSCAN = 10;
  const SEARCH_DEBOUNCE_MS = 120;
  const DECKS = Array.from({ length: DECK_COUNT }, (_, i) => i);

  let scroller: HTMLDivElement;
  let input: HTMLInputElement;
  let scrollTop = $state(0);
  let viewH = $state(0);

  let query = $state('');
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchPending = false;

  // None of these read the 30 Hz deck state, so the table only re-renders on
  // browser / library / load changes.
  const ids = $derived(client.browser.ids);
  const selected = $derived(client.browser.selected);
  const library = $derived(client.library);
  const focused = $derived(client.focused);
  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN));
  const last = $derived(Math.min(ids.length, Math.ceil((scrollTop + viewH) / ROW) + OVERSCAN));
  const rows = $derived(ids.slice(first, last).map((id, i) => ({ id, index: first + i })));

  /** track id → decks it's loaded on. */
  const onDecks = $derived.by(() => {
    const map = new Map<string, number[]>();
    client.deckInfo.forEach((d, deck) => {
      if (d) map.set(d.track.id, [...(map.get(d.track.id) ?? []), deck]);
    });
    return map;
  });

  const total = $derived(library.size);
  const status = $derived(client.libraryStatus);
  const hasRows = $derived(total > 0 && ids.length > 0);

  // Follow the server's query (e.g. after a reload) unless the user is typing.
  $effect(() => {
    const q = client.browser.query;
    untrack(() => {
      if (!searchPending && document.activeElement !== input) query = q;
    });
  });

  // Keep the server-selected row in view, so hardware encoder scrolling shows.
  // Also re-run once rows exist (the first `browser` usually beats the library
  // fetch) and when the list's height changes (the mixer legend below it wraps).
  $effect(() => {
    const sel = selected;
    const list = ids;
    void hasRows;
    void viewH;
    untrack(() => {
      if (!scroller || sel == null) return;
      const i = list.indexOf(sel);
      if (i < 0) return;
      const margin = ROW * 1.5;
      const top = i * ROW;
      const view = scroller.clientHeight;
      if (top - margin < scroller.scrollTop) {
        scroller.scrollTop = Math.max(0, top - margin);
      } else if (top + ROW + margin > scroller.scrollTop + view) {
        scroller.scrollTop = top + ROW + margin - view;
      }
    });
  });

  function oninput() {
    searchPending = true;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(flushSearch, SEARCH_DEBOUNCE_MS);
  }

  function flushSearch() {
    clearTimeout(searchTimer);
    if (!searchPending) return;
    searchPending = false;
    client.send({ cmd: 'browse', query });
  }

  function clearSearch() {
    query = '';
    searchPending = true;
    flushSearch();
    input.focus();
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      flushSearch();
      input.blur();
    }
  }

  function track(id: string) {
    return library.get(id);
  }
</script>

<section class="library" aria-label="Library">
  <header class="bar">
    <div class="search">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.5 3a5.5 5.5 0 0 1 4.38 8.83l3.65 3.64-1.06 1.06-3.64-3.65A5.5 5.5 0 1 1 8.5 3Zm0 1.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" /></svg>
      <input
        id="library-search"
        bind:this={input}
        bind:value={query}
        type="search"
        placeholder="Search title, artist…"
        autocomplete="off"
        spellcheck="false"
        aria-label="Search library"
        {oninput}
        onkeydown={onSearchKey}
        onblur={flushSearch}
      />
      {#if query}
        <button type="button" class="clear" aria-label="Clear search" onclick={clearSearch}>×</button>
      {/if}
    </div>
    <span class="count">
      {#if status === 'ready'}
        {#if client.browser.query}
          <b>{ids.length}</b> of {total}
        {:else}
          <b>{total}</b> {total === 1 ? 'track' : 'tracks'}
        {/if}
      {/if}
    </span>
    <span class="target" style:--accent={deckColor(focused)} title="Double-click a row to load it to the focused deck">
      Load → <b>Deck {focused + 1}</b>
    </span>
    <button type="button" class="rescan" onclick={() => client.rescan()} disabled={client.rescanning}>
      <svg viewBox="0 0 20 20" aria-hidden="true" class:spin={client.rescanning}><path d="M10 3a7 7 0 0 1 6.32 4H14v1.5h4.5V4H17v1.6A8.5 8.5 0 1 0 18.5 10H17a7 7 0 1 1-7-7Z" /></svg>
      {client.rescanning ? 'Scanning…' : 'Rescan'}
    </button>
  </header>

  <div class="table" role="grid" aria-rowcount={ids.length} aria-label="Tracks">
    <div class="row headrow" role="row">
      <span role="columnheader" class="c-deck"><span class="sr">On deck</span></span>
      <span role="columnheader">Title</span>
      <span role="columnheader">Artist</span>
      <span role="columnheader" class="num">BPM</span>
      <span role="columnheader" class="num">Length</span>
      <span role="columnheader" class="c-load">Load to</span>
    </div>

    <div
      class="scroller"
      bind:this={scroller}
      bind:clientHeight={viewH}
      onscroll={() => (scrollTop = scroller.scrollTop)}
    >
      {#if status === 'loading' && total === 0}
        <div class="empty"><p>Loading library…</p></div>
      {:else if status === 'error' && total === 0}
        <div class="empty">
          <p>Couldn't load the library.</p>
          <button type="button" class="big" onclick={() => client.refreshLibrary()}>Try again</button>
        </div>
      {:else if total === 0}
        <div class="empty">
          <p class="lead">Your library is empty</p>
          <p>Put audio files in <code>~/Music</code>, then Rescan.</p>
          <button type="button" class="big" onclick={() => client.rescan()} disabled={client.rescanning}>
            {client.rescanning ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
      {:else if ids.length === 0}
        <div class="empty">
          <p>No tracks match “{client.browser.query}”.</p>
        </div>
      {:else}
        <div class="spacer" style:height="{ids.length * ROW}px">
          {#each rows as { id, index } (id)}
            {@const t = track(id)}
            {@const decks = onDecks.get(id)}
            <!-- The mixer (and hidden ↑/↓/Enter shortcuts) drive the server-owned
                 selection, so rows themselves aren't tab stops. -->
            <!-- svelte-ignore a11y_interactive_supports_focus, a11y_click_events_have_key_events -->
            <div
              class="row"
              class:selected={id === selected}
              class:loaded={!!decks}
              role="row"
              aria-rowindex={index + 1}
              aria-selected={id === selected}
              style:transform="translateY({index * ROW}px)"
              onclick={() => client.send({ cmd: 'select', track_id: id })}
              ondblclick={() => client.send({ cmd: 'load_selected' })}
            >
              <span role="gridcell" class="c-deck">
                {#each decks ?? [] as d (d)}
                  <i style:--accent={deckColor(d)} title="On deck {d + 1}">{d + 1}</i>
                {/each}
              </span>
              <span role="gridcell" class="c-title" title={t?.album ? `${t.title} — ${t.album}` : (t?.title ?? id)}>
                {t?.title ?? idToName(id)}
              </span>
              <span role="gridcell" class="c-artist">{t?.artist ?? ''}</span>
              <span role="gridcell" class="num">{fmtBpm(t?.bpm)}</span>
              <span role="gridcell" class="num">{fmtLength(t?.duration)}</span>
              <span role="gridcell" class="c-load">
                {#each DECKS as d (d)}
                  <button
                    type="button"
                    style:--accent={deckColor(d)}
                    aria-label="Load to deck {d + 1}"
                    title="Load to deck {d + 1}"
                    onclick={(e) => {
                      e.stopPropagation();
                      client.send({ cmd: 'load', deck: d, track_id: id });
                    }}
                    ondblclick={(e) => e.stopPropagation()}>{d + 1}</button
                  >
                {/each}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <footer class="hints">
    <MixerLegend slots={DECKS_LEGEND} view="decks" lead />
  </footer>
</section>

<style>
  .library {
    --row-h: 34px;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    min-width: 0;
    min-height: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg-1);
    overflow: hidden;
  }

  /* Toolbar */
  .bar {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
  }
  .search {
    position: relative;
    flex: 0 1 420px;
    min-width: 160px;
  }
  .search svg {
    position: absolute;
    left: 10px;
    top: 50%;
    width: 16px;
    height: 16px;
    transform: translateY(-50%);
    fill: var(--text-3);
    pointer-events: none;
  }
  .search input {
    width: 100%;
    height: 38px;
    padding: 0 34px 0 34px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    background: var(--bg-0);
    color: var(--text);
    font: 500 15px/1 var(--font-ui);
  }
  .search input::placeholder {
    color: var(--text-3);
  }
  .search input::-webkit-search-cancel-button {
    display: none;
  }
  .search input:focus {
    outline: none;
    border-color: var(--focus);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 25%, transparent);
  }
  .clear {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
  }
  .clear {
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: 4px;
    background: var(--bg-3);
    color: var(--text-2);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
  }
  .clear:hover {
    color: var(--text);
    background: var(--bg-4);
  }
  .count {
    font-size: 13px;
    color: var(--text-3);
    white-space: nowrap;
  }
  .count b {
    color: var(--text-2);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .target {
    margin-left: auto;
    font-size: 13px;
    color: var(--text-3);
    white-space: nowrap;
  }
  .target b {
    color: var(--accent);
    font-weight: 700;
  }
  .rescan {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 12px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    background: var(--bg-3);
    color: var(--text);
    font: 600 13px/1 var(--font-ui);
    cursor: pointer;
    white-space: nowrap;
  }
  .rescan:hover:not(:disabled) {
    background: var(--bg-4);
  }
  .rescan:disabled {
    color: var(--text-3);
    cursor: default;
  }
  .rescan svg {
    width: 14px;
    height: 14px;
    fill: currentColor;
  }
  .spin {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Table */
  .table {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-height: 0;
  }
  .row {
    display: grid;
    grid-template-columns: 52px minmax(0, 2.2fr) minmax(0, 1.4fr) 64px 72px 132px;
    align-items: center;
    column-gap: 14px;
    height: var(--row-h);
    padding: 0 12px;
  }
  .headrow {
    height: 30px;
    border-bottom: 1px solid var(--line);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-3);
    /* line up with rows above the scrollbar gutter */
    padding-right: calc(12px + var(--scrollbar-w));
  }
  .scroller {
    position: relative;
    min-height: 0;
    overflow-y: scroll;
    overflow-x: hidden;
    overscroll-behavior: contain;
  }
  .spacer {
    position: relative;
  }
  .spacer .row {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    font-size: 14.5px;
    color: var(--text);
    cursor: default;
    border-bottom: 1px solid rgba(255, 255, 255, 0.025);
  }
  .spacer .row:hover {
    background: rgba(255, 255, 255, 0.035);
  }
  .spacer .row.selected {
    background: color-mix(in srgb, var(--focus) 22%, var(--bg-1));
    box-shadow: inset 3px 0 0 var(--focus);
  }
  .c-title,
  .c-artist {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .c-title {
    font-weight: 550;
  }
  .c-artist {
    color: var(--text-2);
  }
  .selected .c-artist {
    color: var(--text);
  }
  .num {
    text-align: right;
    font-family: var(--font-mono);
    font-size: 13.5px;
    font-variant-numeric: tabular-nums;
    color: var(--text-2);
  }
  .headrow .num {
    font-family: inherit;
    font-size: inherit;
    color: inherit;
  }
  .c-deck {
    display: flex;
    gap: 3px;
  }
  .c-deck i {
    display: grid;
    place-items: center;
    width: 15px;
    height: 18px;
    border-radius: 3px;
    background: var(--accent);
    color: var(--bg-0);
    font: normal 700 11px/1 var(--font-mono);
  }
  .c-load {
    display: flex;
    justify-content: flex-end;
    gap: 4px;
  }
  .c-load button {
    width: 28px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--line-2);
    border-radius: 4px;
    background: transparent;
    color: var(--text-3);
    font: 700 12px/1 var(--font-mono);
    cursor: pointer;
  }
  .row:hover .c-load button,
  .row.selected .c-load button {
    color: var(--text-2);
  }
  .row.selected .c-load button {
    border-color: color-mix(in srgb, var(--focus) 35%, var(--line-2));
  }
  .c-load button:hover {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--bg-0) !important;
  }

  .empty {
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 6px;
    height: 100%;
    min-height: 120px;
    padding: 24px;
    text-align: center;
    color: var(--text-2);
    font-size: 15px;
  }
  .empty p {
    margin: 0;
  }
  .empty .lead {
    font-size: 20px;
    font-weight: 650;
    color: var(--text);
  }
  .empty code {
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--bg-3);
    font: 600 14px var(--font-mono);
    color: var(--text);
  }
  .big {
    margin-top: 12px;
    height: 42px;
    padding: 0 22px;
    border: 1px solid var(--focus);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--focus) 20%, transparent);
    color: var(--text);
    font: 650 15px/1 var(--font-ui);
    cursor: pointer;
  }
  .big:hover:not(:disabled) {
    background: color-mix(in srgb, var(--focus) 32%, transparent);
  }

  /* Mixer legend */
  .hints {
    padding: 8px 12px;
    border-top: 1px solid var(--line);
  }
  .hints:empty {
    display: none;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }
</style>
