<script lang="ts">
  import { onMount } from 'svelte';
  import MixerKey from '../components/MixerKey.svelte';
  import MixerLegend from '../components/MixerLegend.svelte';
  import { client } from '../lib/client.svelte';
  import { fmtBpm, idToName } from '../lib/format';
  import { backKey, bandKey, diveHint, EXPLORE_LEGEND, keysText, keyText } from '../lib/mixer';
  import { BANDS, type Band } from '../lib/protocol';
  import { viz } from '../lib/viz';
  import DeckHud from './DeckHud.svelte';
  import type { EngineStats, ExploreEngine } from './engine';
  import LibraryTicker from './LibraryTicker.svelte';
  import SearchPanel from './SearchPanel.svelte';
  import WaveStrip from './WaveStrip.svelte';
  import { search } from '../lib/search.svelte';
  import Minimap from './Minimap.svelte';
  import { BAND_PALETTE, bandPalette } from './palette';

  let canvas: HTMLCanvasElement;
  let labels: HTMLDivElement;

  let engine = $state.raw<ExploreEngine | null>(null);
  /** Height of the legend + deck HUD, so toasts can sit above it. */
  let bottomH = $state(0);
  let failed = $state<string | null>(null);
  let stats = $state.raw<EngineStats | null>(null);
  let waveMs = $state(0);
  const showStats = new URLSearchParams(location.search).has('stats');
  const ex = $derived(client.explore);
  const band = $derived<Band>(ex?.band ?? 'low');
  const pal = $derived(bandPalette(band));
  const analysis = $derived(client.analysis);
  const bpm = $derived(client.state?.bpm ?? null);

  const children = $derived(ex?.current ? ex.nodes.filter((n) => n.parent === ex.current) : []);
  const hasRoot = $derived(!!ex?.root);
  const offline = $derived(client.ws !== 'open');

  function title(id: string | null | undefined): string {
    if (!id) return '';
    return client.library.get(id)?.title ?? idToName(id);
  }

  /** Root › … › current, shortened from the middle. */
  const crumbs = $derived.by(() => {
    const path = ex?.path ?? [];
    const names = path.map((id) => ({ id, name: title(id) }));
    if (names.length <= 4) return names;
    return [names[0], { id: '…', name: '…' }, ...names.slice(-2)];
  });

  const currentTrack = $derived(ex?.current ? client.library.get(ex.current) : undefined);
  const selected = $derived(client.browser.selected);

  // Everything is driven from the mixer; these say which control does what.
  const maps = $derived(client.mixer);
  /** The mixer's connection, shown in the corner (the only status the app has). */
  const device = $derived(client.state?.device ?? null);
  const deviceLine = $derived.by(() => {
    if (!device) return 'Connecting…';
    if (device.state === 'running') return `Xone:4D · ${device.latency_ms.toFixed(1)} ms`;
    return device.message ?? { connecting: 'Connecting to the Xone:4D…', stalled: 'Xone:4D stalled', missing: 'Xone:4D not connected', error: 'Xone:4D error' }[device.state] ?? device.state;
  });
  const followKeys = $derived(keysText(maps, 'explore.follow'));
  const back = $derived(backKey(maps));
  const aimHint = $derived.by(() => {
    const parts: string[] = [];
    const dive = diveHint(maps);
    if (dive) parts.push(`${dive} dives in`);
    // "Load selected" loads the library selection: the aim, unless the left jog moved it.
    const load = keysText(maps, 'deck.load_selected');
    if (load && (!ex?.aim || selected === ex.aim)) parts.push(`${load} loads it`);
    return parts.join(' · ');
  });

  function bandTitle(b: Band): string {
    const k = bandKey(maps, b);
    return `${BAND_PALETTE[b].label}: ${BAND_PALETTE[b].hint}${k ? ` (${keyText(k)})` : ''}`;
  }

  onMount(() => {
    let cancelled = false;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => engine?.setReducedMotion(motion.matches);
    motion.addEventListener('change', onMotion);

    // three.js lives in its own chunk, loaded the first time Explore opens.
    import('./engine')
      .then(({ createExploreEngine }) => {
        if (cancelled) return;
        engine = createExploreEngine({
          canvas,
          labels,
          viz,
          track: (id) => client.library.get(id),
          onAim: (id) => client.send({ cmd: 'explore_aim', id }),
          onDive: (id) => client.send({ cmd: 'explore_dive', id }),
          onAimDelta: (delta) => client.send({ cmd: 'explore_aim', delta }),
          reducedMotion: motion.matches,
          onStats: showStats ? (s) => (stats = s) : undefined,
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) failed = err instanceof Error ? err.message : String(err);
      });

    return () => {
      cancelled = true;
      motion.removeEventListener('change', onMotion);
      engine?.dispose();
      engine = null;
    };
  });

  $effect(() => {
    const msg = client.explore;
    engine?.setExplore(msg);
  });

  $effect(() => {
    void client.library;
    engine?.refreshLabels();
  });

  $effect(() => {
    engine?.setHint(aimHint);
  });

  $effect(() => {
    const root = document.documentElement.style;
    if (bottomH > 0) root.setProperty('--explore-bottom', `${bottomH}px`);
    return () => root.removeProperty('--explore-bottom');
  });

  $effect(() => { engine?.setBottomInset(bottomH + 14); });

  function setBand(b: Band) {
    client.send({ cmd: 'explore_band', band: b });
  }
</script>

<div
  class="explore"
  style:--band={pal.css}
  style:--band-a={pal.a}
  style:--band-b={pal.b}
  role="application"
  aria-label="Explore: living river valley"
>
  <div class="stage">
    <canvas bind:this={canvas} aria-hidden="true"></canvas>
    <div class="labels" bind:this={labels}></div>
  </div>

  <div class="vignette" aria-hidden="true"></div>

  <!-- Top-left: band, follow, analysis, tempo, where we are -->
  <header class="info">
    <div class="row">
      <span class="brand">X1 D<span>·</span>FOUR</span>
      <div class="bands" role="radiogroup" aria-label="Band">
        {#each BANDS as b (b)}
          <button
            type="button"
            role="radio"
            class="band"
            class:on={band === b}
            style:--c={BAND_PALETTE[b].css}
            aria-checked={band === b}
            title={bandTitle(b)}
            onclick={() => setBand(b)}>{BAND_PALETTE[b].label}</button
          >
        {/each}
      </div>
      <button
        type="button"
        class="chip follow"
        class:on={ex?.follow}
        aria-pressed={ex?.follow ?? false}
        title="Root follows the focused deck{followKeys ? ` (${followKeys})` : ''}"
        onclick={() => client.send({ cmd: 'explore_follow', follow: !(ex?.follow ?? false) })}
      >
        <span class="pip"></span>Follow {ex?.follow ? 'on' : 'off'}
      </button>
      <span class="chip tempo" title="Tempo from the mixer's MIDI clock">
        <b>{fmtBpm(bpm) || '—'}</b><small>BPM</small>
      </span>
      {#if analysis?.running}
        <span class="chip analysis" title="Analysing the library: paths appear as tracks are analysed">
          <span class="k">Analysing</span>
          <b>{analysis.done}<small>/{analysis.total}</small></b>
          <span class="meter"><span style:transform="scaleX({analysis.total ? analysis.done / analysis.total : 0})"></span></span>
        </span>
      {:else if analysis?.error}
        <span class="chip bad" title={analysis.error}>Analysis failed</span>
      {/if}
      {#if offline}
        <span class="chip bad">Offline: reconnecting…</span>
      {/if}
    </div>
    {#if ex?.current}
      <div class="where">
        <span class="k">Now at</span>
        <b>{currentTrack?.title ?? title(ex.current)}</b>
        {#if currentTrack?.artist}<span class="artist">{currentTrack.artist}</span>{/if}
        {#if ex.root_deck != null && ex.current === ex.root}
          <span class="tag">deck {ex.root_deck + 1}</span>
        {/if}
      </div>
      {#if crumbs.length > 1}
        <ol class="crumbs" aria-label="Path from the root">
          {#each crumbs as c, i (i)}
            <li class:last={i === crumbs.length - 1}>{c.name}</li>
          {/each}
        </ol>
      {/if}
    {/if}
  </header>

  {#if hasRoot}
    <div class="place-name" aria-live="polite">
      <span>EXPLORE / {pal.detail}</span>
      <h1>{pal.place}</h1>
      <p>{children.length} paths from here <i>·</i> let the music lead</p>
      {#if (ex?.path.length ?? 0) > 1}
        <button type="button" class="upstream" onclick={() => client.send({ cmd: 'explore_back' })}>← Upstream</button>
      {/if}
    </div>
  {/if}

  <!-- Top-right: tree + way out -->
  <aside class="side">
    <div
      class="device"
      class:ok={device?.state === 'running'}
      class:warn={device?.state === 'connecting' || !device}
      title={device?.firmware ? `Firmware ${device.firmware} · ${device.underruns} underruns · ${device.urb_errors} USB errors` : undefined}
    >
      <span class="dot"></span>{deviceLine}
    </div>
    {#if ex?.root}
      <Minimap msg={ex} />
    {/if}
    {#if showStats && stats}
      <div class="stats" role="status">
        {stats.fps} fps · {stats.calls} calls · {(stats.triangles / 1000).toFixed(0)}k tris · dpr {stats.dpr.toFixed(2)} · world {stats.frameMs.toFixed(2)} ms · wave {waveMs.toFixed(2)} ms
        <span class="growth">growth {Math.round(stats.growth * 100)}% · evening {Math.round(stats.day * 100)}%</span>
      </div>
    {/if}
  </aside>

  {#if !search.open}<LibraryTicker />{/if}
  <SearchPanel />

  <!-- Empty / waiting states -->
  {#if failed}
    <div class="center">
      <p class="big">The landscape needs WebGL</p>
      <p class="sub">{failed}</p>
      {#if children.length}
        <ul class="fallback">
          {#each children as c (c.id)}
            <li>
              <button type="button" class:aimed={c.id === ex?.aim} onclick={() => client.send({ cmd: 'explore_aim', id: c.id })}>
                {title(c.id)} <span>{client.library.get(c.id)?.artist ?? 'Unknown artist'} · {fmtBpm(c.tempo ?? client.library.get(c.id)?.bpm ?? null) || '—'} BPM · {Math.round(c.sim * 100)}%</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else if !ex}
    <div class="center"><p class="sub">Waiting for the explorer…</p></div>
  {:else if !hasRoot}
    <div class="center">
      <p class="big">Load a track onto the focused deck</p>
      <p class="sub">The valley grows from the focused deck's track, in the {pal.label.toLowerCase()} band.</p>
      <div class="actions">
        {#if selected}
          <button type="button" class="primary" onclick={() => client.send({ cmd: 'explore_root', id: selected })}>
            Start from “{title(selected)}”
          </button>
        {/if}
        <span class="hint">or just start typing to search</span>
      </div>
      <div class="teach">
        <MixerLegend slots={['play', 'scroll', 'root']} view="explore" tone="overlay" errors={false} />
      </div>
    </div>
  {:else if children.length === 0}
    <div class="center">
      {#if analysis?.running}
        <p class="sub">Analysing the library… paths appear as tracks are analysed.</p>
      {:else}
        <p class="sub">
          No similar tracks here yet.
          {#if back && ex.path.length > 1}<MixerKey k={back.key} />{back.turn ? ' left' : ''} climbs back up.{/if}
        </p>
      {/if}
    </div>
  {/if}

  <!-- Bottom: what the mixer does here, then the decks -->
  <footer class="bottom" bind:clientHeight={bottomH}>
    <WaveStrip onStats={showStats ? (ms) => (waveMs = ms) : undefined} />
    <MixerLegend slots={EXPLORE_LEGEND} view="explore" tone="overlay" />
    <DeckHud rootDeck={ex?.root_deck ?? null} />
  </footer>
</div>

<style>
  .explore {
    position: fixed;
    inset: 0;
    z-index: 15;
    overflow: hidden;
    background: #25392e;
    color: var(--text);
    user-select: none;
    -webkit-user-select: none;
  }
  .stage,
  canvas,
  .labels,
  .vignette {
    position: absolute;
    inset: 0;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
  }
  .labels {
    pointer-events: none;
    overflow: hidden;
  }
  .vignette {
    pointer-events: none;
    background:
      linear-gradient(to bottom, #14291fd9, #172b1c00 130px),
      linear-gradient(to top, #14251ef5, #1b3028b0 140px, transparent 32%);
  }

  .place-name { position: absolute; top: 18%; left: 3.4%; pointer-events: none; color: #f0edda; text-shadow: 0 2px 18px #26393070; }
  .place-name > span { font-size: 10px; letter-spacing: .19em; text-transform: uppercase; }
  .place-name h1 { margin: 8px 0; font: 400 clamp(32px, 3.2vw, 58px)/1.08 Georgia, serif; letter-spacing: -.04em; }
  .place-name p { margin: 10px 0; font-size: 12px; color: #e3e4cc; }
  .place-name i { margin: 0 8px; font-style: normal; }
  .upstream { pointer-events: auto; margin-top: 12px; padding: 6px 10px; border: 1px solid #dedbb966; background: #1b3028cc; color: #eee9d3; font-size: 12px; cursor: pointer; }
  .growth { display: block; opacity: .8; }
  .labels :global(.xl) {
    position: absolute; left: 0; top: 0; padding: 10px 12px 12px;
    border: 0; border-top: 1px solid #e9ddaf45; border-radius: 0;
    color: #f3efdc; background: linear-gradient(#1f2c25c9, #1f2c259c);
    text-align: center; pointer-events: auto; cursor: pointer;
    box-shadow: 0 5px 20px #1b281c14;
  }
  .labels :global(.xl)::after {
    content: ''; position: absolute; height: var(--stem, 19px); width: 1px;
    top: 100%; left: 50%; background: #e6d8a788;
  }
  .labels :global(.xl:hover), .labels :global(.xl:focus-visible) { background: #233228ec; }
  .labels :global(.xl-t), .labels :global(.xl-a), .labels :global(.xl-m) { display: block; }
  .labels :global(.xl-t) { overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; font: 550 clamp(12px, .86vw, 15px)/1.3 var(--font-ui); text-wrap: balance; }
  .labels :global(.xl-a) { font-size: 11px; color: #c9cdb8; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .labels :global(.xl-m) { margin-top: 8px; font: 500 10px/1.4 var(--font-mono); color: #dfd7b7; white-space: pre; }
  .labels :global(.xl[data-kind='aimed']) { z-index: 2; padding: 18px 20px; border-top: 2px solid var(--band); background: linear-gradient(#213329ed,#1c3025ce); }
  .labels :global(.xl[data-kind='aimed'])::before { content: 'AIMED · NEXT PATH'; display: block; color: var(--band); font-size: 9px; letter-spacing: .22em; margin-bottom: 10px; }
  .labels :global(.xl[data-kind='aimed'] .xl-t) { font: 400 clamp(21px, 1.85vw, 32px)/1.08 Georgia, serif; letter-spacing: -.02em; }
  .labels :global(.xl[data-kind='aimed'] .xl-a) { font-size: 13px; margin-top: 8px; }
  .labels :global(.xl[data-kind='aimed'] .xl-m) { color: var(--band); font-size: 11px; }

  /* Info strip */
  .info {
    position: absolute;
    top: 22px;
    left: 24px;
    display: grid;
    gap: 8px;
    max-width: calc(100vw - 260px);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .brand {
    margin-right: 6px;
    font: 800 13px/1 var(--font-ui);
    letter-spacing: 0.18em;
    color: var(--text);
  }
  .brand span {
    color: #c0c5b0;
  }
  .bands {
    display: inline-flex;
    padding: 2px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(26, 40, 32, 0.78);
  }
  .band {
    height: 26px;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    font: 750 11.5px/1 var(--font-ui);
    letter-spacing: 0.12em;
    color: #c0c5b0;
    cursor: pointer;
  }
  .band:hover {
    color: var(--c);
  }
  .band.on {
    background: color-mix(in srgb, var(--c) 22%, transparent);
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--c) 65%, transparent),
      0 1px 4px #18251b33;
    color: var(--c);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(26, 40, 32, 0.78);
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
    white-space: nowrap;
  }
  button.chip {
    cursor: pointer;
  }
  .chip .pip {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-4);
  }
  .follow.on .pip {
    background: var(--band);
    box-shadow: 0 0 8px var(--band);
  }
  .follow.on {
    color: var(--text);
  }
  .chip b {
    font: 650 13px var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
  .chip small {
    font-size: 10px;
    color: #c0c5b0;
  }
  .k {
    font-size: 10.5px;
    font-weight: 650;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #c0c5b0;
  }
  .meter {
    width: 70px;
    height: 3px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.08);
    overflow: hidden;
  }
  .meter span {
    display: block;
    height: 100%;
    background: var(--band);
    transform-origin: left;
    transition: transform 0.4s ease-out;
  }
  .chip.bad {
    border-color: color-mix(in srgb, var(--bad) 50%, transparent);
    color: var(--bad);
  }
  .where {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    padding-left: 2px;
    font-size: 14px;
    white-space: nowrap;
  }
  .where b {
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 640;
  }
  .where .artist {
    overflow: hidden;
    text-overflow: ellipsis;
    color: #c0c5b0;
  }
  .tag {
    padding: 0 5px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--band) 22%, transparent);
    font: 700 10px/1.6 var(--font-ui);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--band);
  }
  .crumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 0;
    margin: -4px 0 0;
    padding: 0 0 0 2px;
    list-style: none;
    font-size: 11.5px;
    color: #c0c5b0;
  }
  .crumbs li {
    max-width: 180px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .crumbs li:not(:last-child)::after {
    content: '›';
    margin: 0 6px;
    color: var(--text-4);
  }
  .crumbs li.last {
    color: var(--text-2);
  }

  /* Side: close + minimap */
  .side {
    position: absolute;
    top: 22px;
    right: 24px;
    display: grid;
    justify-items: end;
    gap: 10px;
  }
  .device {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 360px;
    height: 30px;
    padding: 0 12px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    background: rgba(26, 40, 32, 0.78);
    font: 600 12.5px/1 var(--font-ui);
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .device .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--bad);
    box-shadow: 0 0 8px var(--bad);
  }
  .device.ok .dot {
    background: var(--ok);
    box-shadow: 0 0 8px var(--ok);
  }
  .device.warn .dot {
    background: var(--warn);
    box-shadow: 0 0 8px var(--warn);
  }
  .device:not(.ok):not(.warn) {
    color: var(--text);
    border-color: color-mix(in srgb, var(--bad) 55%, transparent);
  }
  .hint {
    align-self: center;
    font-size: 13px;
    color: #c0c5b0;
  }
  .stats {
    padding: 3px 8px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.6);
    font: 600 11px var(--font-mono);
    color: var(--ok);
  }

  /* Centre prompts */
  .center {
    position: absolute;
    left: 50%;
    top: 50%;
    display: grid;
    justify-items: center;
    gap: 10px;
    width: min(640px, calc(100vw - 48px));
    transform: translate(-50%, -50%);
    text-align: center;
    text-shadow: 0 2px 16px rgba(0, 0, 0, 0.9);
  }
  .big {
    margin: 0;
    font: 650 clamp(22px, 2.2vw, 32px) / 1.2 var(--font-ui);
    letter-spacing: -0.01em;
  }
  .sub {
    margin: 0;
    font-size: 15px;
    color: var(--text-2);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 10px;
    margin-top: 8px;
  }
  .actions button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    height: 38px;
    padding: 0 16px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    background: rgba(10, 12, 16, 0.7);
    font: 600 14px/1 var(--font-ui);
    color: var(--text);
    cursor: pointer;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .actions .primary {
    border-color: color-mix(in srgb, var(--band) 60%, transparent);
    background: color-mix(in srgb, var(--band) 18%, rgba(10, 12, 16, 0.8));
    box-shadow: 0 0 22px -6px var(--band);
  }
  .fallback {
    display: grid;
    gap: 6px;
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
  }
  .fallback button {
    width: 100%;
    padding: 8px 14px;
    border: 1px solid var(--line-2);
    border-radius: 8px;
    background: var(--bg-2);
    color: var(--text);
    cursor: pointer;
  }
  .fallback button.aimed {
    border-color: var(--band);
  }
  .fallback span {
    margin-left: 8px;
    color: var(--band);
  }

  /* Bottom */
  .bottom {
    position: absolute;
    left: 24px;
    right: 24px;
    bottom: 14px;
    display: grid;
    gap: 10px;
  }
  /* Wider than the prompt so the mixer hints stay on one line. */
  .teach {
    width: max-content;
    max-width: calc(100vw - 48px);
    margin-top: 10px;
  }
</style>
