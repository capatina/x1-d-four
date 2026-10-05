<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { flip } from 'svelte/animate';
  import { MediaQuery } from 'svelte/reactivity';
  import { fly } from 'svelte/transition';
  import MixerKey from '../components/MixerKey.svelte';
  import { client } from '../lib/client.svelte';
  import { deckColor } from '../lib/decks';
  import { fmtBpm, idToName } from '../lib/format';
  import { keysFor } from '../lib/mixer';

  /**
   * The left jog scrolls the library even inside the tunnel. When the library
   * selection moves somewhere other than the aimed portal, show where it is
   * (with a few neighbours) and how to use it; fade out once it settles.
   */

  const HOLD_MS = 3000;
  /** Let a matching `explore` (aim) message land before deciding: the server may send `browser` first. */
  const SETTLE_MS = 90;
  const SPAN = 3;

  let visible = $state(false);
  const motion = new MediaQuery('prefers-reduced-motion: reduce');
  const reduced = $derived(motion.current);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let last = untrack(() => client.browser.selected);

  $effect(() => {
    const sel = client.browser.selected;
    if (sel === last) return;
    const prev = last;
    last = sel;
    // Ignore the first selection after connecting, and clearing it.
    if (sel == null || prev == null) return;
    checkTimer ??= setTimeout(() => {
      checkTimer = undefined;
      const now = client.browser.selected;
      // Aiming in the tunnel moves the selection too; that's not a library scroll.
      if (now && now !== client.explore?.aim) show();
    }, SETTLE_MS);
  });

  function show() {
    visible = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => (visible = false), HOLD_MS);
  }

  onDestroy(() => {
    clearTimeout(hideTimer);
    clearTimeout(checkTimer);
  });

  const selected = $derived(client.browser.selected);
  const ids = $derived(client.browser.ids);
  const at = $derived(selected ? ids.indexOf(selected) : -1);
  const rows = $derived.by(() => {
    if (!selected) return [];
    if (at < 0) return [{ id: selected, d: 0 }];
    const out: Array<{ id: string; d: number }> = [];
    for (let d = -SPAN; d <= SPAN; d++) {
      const id = ids[at + d];
      if (id) out.push({ id, d });
    }
    return out;
  });

  const track = (id: string) => client.library.get(id);
  const sel = $derived(selected ? track(selected) : undefined);
  const onDecks = $derived(
    selected ? client.deckInfo.flatMap((info, deck) => (info?.track.id === selected ? [deck] : [])) : [],
  );

  const rootKeys = $derived(keysFor(client.mixer, 'explore.root'));
  const loadKeys = $derived(keysFor(client.mixer, 'deck.load_selected'));
</script>

{#if visible && selected}
  <div class="wrap">
    <aside
      class="ticker"
      aria-live="polite"
      aria-label="Library selection"
      transition:fly={{ x: reduced ? 0 : -24, duration: reduced ? 120 : 260, opacity: 0 }}
    >
      <header>
        <span class="k">Library</span>
        {#if at >= 0}<span class="pos"><b>{at + 1}</b> / {ids.length}</span>{/if}
      </header>
      <ol>
        {#each rows as r (r.id)}
          {@const t = track(r.id)}
          <li class:sel={r.d === 0} style:--dim={1 - Math.abs(r.d) * 0.24} animate:flip={{ duration: reduced ? 0 : 150 }}>
            {#if r.d === 0}
              <span class="t">{t?.title ?? idToName(r.id)}</span>
              <span class="a">{t?.artist ?? 'Unknown artist'}</span>
              {#if sel?.bpm || onDecks.length}
                <span class="m">
                  {#if sel?.bpm}<span class="bpm"><b>{fmtBpm(sel.bpm)}</b> BPM</span>{/if}
                  {#each onDecks as d (d)}
                    <span class="deck" style:--accent={deckColor(d)}>on deck {d + 1}</span>
                  {/each}
                </span>
              {/if}
            {:else}
              <span class="t">{t?.title ?? idToName(r.id)}</span>
              {#if t?.artist}<span class="a">{t.artist}</span>{/if}
            {/if}
          </li>
        {/each}
      </ol>
      {#if rootKeys.length || loadKeys.length}
        <footer>
          {#if rootKeys.length}
            <span class="hint">
              {#each rootKeys as k, i (i)}{#if i}<span class="or">/</span>{/if}<MixerKey {k} />{/each}
              fly from here
            </span>
          {/if}
          {#if loadKeys.length}
            <span class="hint">
              {#each loadKeys as k, i (i)}{#if i}<span class="or">/</span>{/if}<MixerKey {k} />{/each}
              load
            </span>
          {/if}
        </footer>
      {/if}
    </aside>
  </div>
{/if}

<style>
  .wrap {
    position: absolute;
    /* Centred between the top bar and the waveforms, legend and decks. */
    top: 84px;
    bottom: calc(var(--explore-bottom, 0px) + 24px);
    left: 16px;
    display: flex;
    align-items: center;
    pointer-events: none;
  }
  .ticker {
    display: grid;
    gap: 10px;
    width: clamp(300px, 27vw, 430px);
    padding: 14px 16px 14px;
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 14px;
    background: linear-gradient(160deg, rgba(20, 22, 30, 0.78), rgba(6, 7, 10, 0.86));
    backdrop-filter: blur(16px) saturate(1.25);
    box-shadow:
      0 18px 50px rgba(0, 0, 0, 0.55),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .k {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .pos {
    font: 600 11.5px var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text-3);
  }
  .pos b {
    color: var(--text-2);
  }
  ol {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    min-width: 0;
    padding: 3px 10px;
    border-left: 2px solid transparent;
    opacity: var(--dim);
  }
  li .t,
  li .a {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  li .t {
    font-size: 13.5px;
    font-weight: 560;
    color: var(--text-2);
  }
  li .a {
    font-size: 11.5px;
    color: var(--text-3);
  }
  li.sel {
    margin: 4px 0;
    padding: 8px 10px 9px 12px;
    border-left-color: var(--band);
    border-radius: 3px 10px 10px 3px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--band) 16%, transparent), transparent 85%);
    opacity: 1;
  }
  li.sel .t {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    white-space: normal;
    text-wrap: balance;
    font: 680 clamp(19px, 1.6vw, 26px) / 1.15 var(--font-ui);
    letter-spacing: -0.01em;
    color: #fff;
  }
  li.sel .a {
    margin-top: 3px;
    font-size: 14.5px;
    color: var(--text-2);
  }
  .m {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 7px;
    font-size: 11.5px;
    color: var(--text-3);
  }
  .bpm b {
    font: 650 12.5px var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
  .deck {
    padding: 0 6px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    font-weight: 650;
    color: var(--accent);
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    padding-top: 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.07);
    font-size: 12.5px;
    color: var(--text-2);
  }
  .hint {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
  }
  .or {
    color: var(--text-4);
  }
</style>
