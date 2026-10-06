<script lang="ts">
  import { onMount } from 'svelte';
  import MixerKey from '../components/MixerKey.svelte';
  import MixerLegend from '../components/MixerLegend.svelte';
  import { client } from '../lib/client.svelte';
  import { fmtBpm, idToName } from '../lib/format';
  import { backKey, bandKey, diveHint, EXPLORE_LEGEND, keysText, keyText } from '../lib/mixer';
  import { BANDS, type Band, type ExploreMsg, type MidiMsg } from '../lib/protocol';
  import { viz } from '../lib/viz';
  import DeckHud from './DeckHud.svelte';
  import type { EngineStats, ExploreEngine } from './engine';
  import LatencyScope from './LatencyScope.svelte';
  import LibraryTicker from './LibraryTicker.svelte';
  import SearchPanel from './SearchPanel.svelte';
  import WaveStrip from './WaveStrip.svelte';
  import { search } from '../lib/search.svelte';
  import Minimap from './Minimap.svelte';
  import { local } from './local';
  import { BAND_PALETTE, bandPalette } from './palette';

  let canvas: HTMLCanvasElement;
  let labels: HTMLDivElement;
  let infoEl: HTMLElement;
  let sideEl: HTMLElement;
  let gateEl: HTMLElement;
  let footerEl: HTMLElement;
  let realmEl: HTMLElement | undefined = $state();

  let engine = $state.raw<ExploreEngine | null>(null);
  /** Height of the legend + deck HUD, so toasts can sit above it. */
  let bottomH = $state(0);
  let failed = $state<string | null>(null);
  let stats = $state.raw<EngineStats | null>(null);
  let waveMs = $state(0);
  /** The title card of the generation that just started building (demo style). */
  let genCard = $state<{ eyebrow: string; name: string; key: number; big?: boolean } | null>(null);
  /** The world we're in (its index), for the labels' look. */
  let world = $state(0);
  let genTimer = 0;
  const showStats = new URLSearchParams(location.search).has('stats');
  const ex = $derived(client.explore);
  const band = $derived<Band>(ex?.band ?? 'low');
  const pal = $derived(bandPalette(band));
  const analysis = $derived(client.analysis);
  const bpm = $derived(client.state?.bpm ?? null);
  const rec = $derived(client.state?.recording ?? null);
  const recTime = $derived.by(() => {
    const t = Math.floor(rec?.seconds ?? 0);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  });

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

  // Scouting: dives (M) walk a route without a deck; a load claims it. Tracks reached
  // by a commit, or on a deck, are claimed; the root always is.
  const committed = new Set<string>();
  let commitSeq = $state(0);
  const scouting = $derived.by(() => {
    void commitSeq;
    const path = ex?.path ?? [];
    const onDecks = new Set(client.deckInfo.map((d) => d?.track.id ?? ''));
    let last = 0;
    path.forEach((id, i) => {
      if (i === 0 || committed.has(id) || onDecks.has(id)) last = i;
    });
    return Math.max(0, path.length - 1 - last);
  });
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

  function showCard(eyebrow: string, name: string, big: boolean) {
    genCard = { eyebrow, name, big, key: (genCard?.key ?? 0) + 1 };
    clearTimeout(genTimer);
    genTimer = window.setTimeout(() => (genCard = null), big ? 3200 : 2600);
  }

  onMount(() => {
    let cancelled = false;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => engine?.setReducedMotion(motion.matches);
    motion.addEventListener('change', onMotion);

    // explore messages reach the landscape in their own task, not after an effect flush.
    const onExplore = (msg: ExploreMsg) => {
      if (msg.reason === 'commit' && msg.current) {
        committed.add(msg.current);
        commitSeq++;
      }
      engine?.setExplore(msg);
    };
    client.exploreListeners.add(onExplore);
    // The mixer's MIDI data flow drives the visuals too.
    const onMidi = (msg: MidiMsg) => engine?.midiEvent(msg);
    client.midiListeners.add(onMidi);

    // Labels keep clear of the header boxes; they only move when those change size.
    const obstacles = () => {
      if (!engine) return;
      const rects = [infoEl, sideEl, realmEl].filter((el): el is HTMLElement => !!el).map((el) => el.getBoundingClientRect());
      engine.setObstacles(rects.map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })));
    };
    const boxes = new ResizeObserver(obstacles);
    boxes.observe(infoEl);
    boxes.observe(sideEl);
    window.addEventListener('resize', obstacles);

    // The decks' lasers rise from the strip's top edge, one above each deck card.
    const decks = () => {
      if (!engine) return;
      const strip = footerEl.querySelector('.strip')?.getBoundingClientRect();
      const cards = footerEl.querySelectorAll('.hud .deck');
      const xs = Array.from(cards, (c) => {
        const r = c.getBoundingClientRect();
        return r.left + r.width / 2;
      });
      if (strip && xs.length === 4) engine.setDecks(xs, strip.top);
    };
    const footerBox = new ResizeObserver(decks);
    footerBox.observe(footerEl);
    window.addEventListener('resize', decks);

    // three.js lives in its own chunk, loaded the first time Explore opens.
    import('./engine')
      .then(({ createExploreEngine }) => {
        if (cancelled) return;
        engine = createExploreEngine({
          canvas,
          labels,
          gate: gateEl,
          viz,
          track: (id) => client.library.get(id),
          onAim: (id) => client.send({ cmd: 'explore_aim', id }),
          onDive: (id) => client.send({ cmd: 'explore_dive', id }),
          onAimDelta: (delta) => client.send({ cmd: 'explore_aim', delta }),
          reducedMotion: motion.matches,
          onStats: showStats ? (s) => (stats = { ...s }) : undefined,
          onGeneration: (level, name) => showCard(`GEN ${String(level).padStart(2, '0')}`, name, false),
          onWorld: (w, name) => {
            world = w;
            showCard(`WORLD ${String(w + 1).padStart(2, '0')}`, name, true);
          },
        });
        local.engine = engine;
        if (new URLSearchParams(location.search).has('qa')) (window as unknown as { __datastream: unknown }).__datastream = engine.qa();
        engine.setExplore(client.explore);
        obstacles();
        decks();
      })
      .catch((err: unknown) => {
        if (!cancelled) failed = err instanceof Error ? err.message : String(err);
      });

    return () => {
      cancelled = true;
      client.exploreListeners.delete(onExplore);
      client.midiListeners.delete(onMidi);
      boxes.disconnect();
      footerBox.disconnect();
      window.removeEventListener('resize', obstacles);
      window.removeEventListener('resize', decks);
      motion.removeEventListener('change', onMotion);
      local.engine = null;
      clearTimeout(genTimer);
      engine?.dispose();
      engine = null;
    };
  });

  // The sector title comes and goes with the root.
  $effect(() => {
    const el = realmEl;
    if (!el || !engine) return;
    const ro = new ResizeObserver(() => {
      const rects = [infoEl, sideEl, el].map((e) => e.getBoundingClientRect());
      engine?.setObstacles(rects.map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })));
    });
    ro.observe(el);
    return () => ro.disconnect();
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
    engine?.setScouting(scouting);
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
  style:--hot={pal.hot}
  role="application"
  aria-label="Explore: the Datastream"
  data-world={world}
>
  <div class="stage">
    <canvas bind:this={canvas} aria-hidden="true"></canvas>
    <div class="labels" bind:this={labels}></div>
  </div>

  <div class="vignette" aria-hidden="true"></div>
  {#if genCard}
    {#key genCard.key}
      <div class="gen-card" class:big={genCard.big} role="status">
        <span class="gen-n">{genCard.eyebrow}</span>
        <span class="gen-name">{genCard.name}</span>
      </div>
    {/key}
  {/if}
  <div class="gate-glow" aria-hidden="true" bind:this={gateEl}></div>

  <!-- Top-left: band, follow, analysis, tempo, where we are -->
  <header class="info" bind:this={infoEl}>
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
      <button
        type="button"
        class="chip rec"
        class:on={rec?.active}
        aria-pressed={rec?.active ?? false}
        title={rec?.active ? `Recording the mix to Music/recordings/${rec.file ?? ''} · peak ${rec.peak_db ?? '—'} dB` : 'Record the mix (the mixer’s master) to Music/recordings'}
        onclick={() => client.send({ cmd: 'record', on: !(rec?.active ?? false) })}
      >
        <span class="rec-dot"></span>{rec?.active ? recTime : 'REC'}
      </button>
      <span class="chip tempo" title="Tempo from the mixer's MIDI clock">
        <b>{fmtBpm(bpm) || '—'}</b><small>BPM</small>
      </span>
      {#if analysis?.running && !hasRoot}
        <span class="chip analysis" title="Analysing the library: routes appear as tracks are analysed">
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
          {#if scouting > 0}<li class="scout">scouting · {scouting} ahead</li>{/if}
        </ol>
      {/if}
    {/if}
  </header>

  {#if hasRoot}
    <div class="realm" aria-live="polite" bind:this={realmEl}>
      <span class="eyebrow">{pal.detail.toLowerCase()}</span>
      <h1>{pal.place}</h1>
      <p>
        {#if analysis?.running}
          <span class="analysis" title="Analysing the library: routes appear as tracks are analysed"
            >analysing <b>{analysis.done}<small>/{analysis.total}</small></b>
            <span class="meter"><span style:transform="scaleX({analysis.total ? analysis.done / analysis.total : 0})"></span></span></span
          ><i>·</i>
        {/if}
        {children.length} {children.length === 1 ? 'path' : 'paths'} ahead <i>·</i> aim to branch, load to fly
        {#if (ex?.path.length ?? 0) > 1}
          <button type="button" class="upstream" onclick={() => client.send({ cmd: 'explore_back' })}>← Upstream</button>
        {/if}
      </p>
    </div>
  {/if}

  <!-- Top-right: tree + way out -->
  <aside class="side" bind:this={sideEl}>
    <LatencyScope connected={device?.state === 'running'} label={device?.state === 'running' ? `Xone:4D${device.firmware ? ` · fw ${device.firmware}` : ''}` : deviceLine} accent={pal.css} />
    {#if ex?.root}
      <Minimap msg={ex} />
    {/if}
  </aside>

  {#if showStats && stats}
    <div class="stats" role="status">
      {stats.fps} fps · {stats.calls} calls · {(stats.triangles / 1000).toFixed(0)}k tris · dpr {stats.dpr.toFixed(2)} · world {stats.frameMs.toFixed(2)} ms · wave {waveMs.toFixed(2)} ms
      <span class="growth">course {stats.course.toFixed(0)} · {stats.speed.toFixed(1)} u/s{stats.gpuMs ? ` · gpu ${stats.gpuMs.toFixed(2)} ms` : ''}</span>
    </div>
  {/if}

  {#if !search.open}<LibraryTicker />{/if}
  <SearchPanel />

  <!-- Empty / waiting states -->
  {#if failed}
    <div class="center">
      <p class="big">The Datastream needs WebGL</p>
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
      <p class="sub">The flight starts from the focused deck's track, in {pal.place} ({pal.label.toLowerCase()} band).</p>
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
        <p class="sub">Analysing the library… routes appear as tracks are analysed.</p>
      {:else}
        <p class="sub">
          No similar tracks here yet.
          {#if back && ex.path.length > 1}<MixerKey k={back.key} />{back.turn ? ' left' : ''} climbs back up.{/if}
        </p>
      {/if}
    </div>
  {/if}

  <!-- Bottom: what the mixer does here, then the decks -->
  <footer class="bottom" bind:clientHeight={bottomH} bind:this={footerEl}>
    <WaveStrip accent={pal.css} onStats={showStats ? (ms) => (waveMs = ms) : undefined} />
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
    background: #000;
    color: var(--text);
    /* The demo's own ink: black glass, white type, the band's neon. */
    --bg-0: #000;
    --bg: #04020a;
    --bg-1: #080512;
    --bg-2: #0d0a1a;
    --bg-3: #151126;
    --bg-4: #221c38;
    --line: #2a2342;
    --line-2: #3d3460;
    --text: #ffffff;
    --text-2: #d6d9f0;
    --text-3: #a4a8c8;
    --text-4: #6b6f92;
    --ok: #5dffb0;
    --warn: #ffd23f;
    --bad: #ff4d6d;
    --focus: var(--band);
    --parchment: #ffffff;
    --font-display: 'JetBrains Mono', 'JetBrainsMono Nerd Font', ui-monospace, monospace;
    --glass: rgba(4, 2, 12, 0.78);
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
    transition: opacity 0.15s ease-out;
  }
  /* The path names fade 3 s after the aim last moved; turning the wheel brings them back. */
  .labels:global(.idle) {
    opacity: 0;
    transition: opacity 0.8s ease-in;
  }
  .labels:global(.idle) :global(.xl) {
    pointer-events: none;
  }
  /* The edge of the view flashes in the band's hot colour as a gate passes overhead. */
  .gate-glow {
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: 0;
    /* The commit's light lives in the outer 12 % of the frame only. */
    --edge: color-mix(in srgb, var(--hot) 70%, transparent);
    --soft: color-mix(in srgb, var(--hot) 22%, transparent);
    background:
      linear-gradient(to right, var(--edge), var(--soft) 5%, transparent 12%),
      linear-gradient(to left, var(--edge), var(--soft) 5%, transparent 12%),
      linear-gradient(to bottom, var(--edge), var(--soft) 5%, transparent 12%),
      linear-gradient(to top, var(--edge), var(--soft) 5%, transparent 12%);
    mix-blend-mode: screen;
    will-change: opacity;
  }
  .vignette {
    pointer-events: none;
    background:
      linear-gradient(to bottom, #000000c0, #00000000 120px),
      linear-gradient(to top, #000000f0, #000000a0 140px, transparent 30%);
  }

  /* A new generation of the world: a title card slammed in, demo style. */
  .gen-card {
    position: absolute; left: 50%; top: 34%; display: grid; justify-items: center; gap: 2px;
    transform: translate(-50%, -50%); pointer-events: none; z-index: 3;
    animation: gen-card 2.6s cubic-bezier(.2,.8,.2,1) both;
  }
  .gen-n { font: 800 13px/1 var(--font-mono); letter-spacing: .5em; color: #000; background: var(--band); padding: 4px 6px 4px 12px; }
  .gen-name {
    font: italic 900 clamp(44px, 6vw, 110px)/1 'Arial Black', Impact, sans-serif; text-transform: uppercase; letter-spacing: .02em;
    background: linear-gradient(#ffffff 0%, #e6ecff 44%, var(--band) 50%, #1a0b33 80%, #ffffff 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-stroke: 1px #00000090;
    filter: drop-shadow(0 0 24px color-mix(in srgb, var(--band) 60%, transparent));
  }
  @keyframes gen-card {
    0% { opacity: 0; transform: translate(-50%, -50%) scale(2.4, .2); filter: blur(6px); }
    8% { opacity: 1; transform: translate(-50%, -50%) scale(1.06, 1.06); filter: blur(0); }
    14% { transform: translate(-50%, -50%) scale(1); }
    78% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    100% { opacity: 0; transform: translate(-50%, -50%) scale(1.6, .05); }
  }
  .gen-card.big { top: 40%; animation-duration: 3.2s; }
  .gen-card.big .gen-name { font-size: clamp(56px, 8.5vw, 150px); }
  @media (prefers-reduced-motion: reduce) { .gen-card { animation: gen-fade 2.6s linear both; } }

  /* Each world dresses the path labels its own way. */
  /* Chromozon: chrome pills in the sunset. */
  .explore[data-world='1'] .labels :global(.xl) { border-radius: 14px; border-color: #ff9a3d80; background: linear-gradient(#2a1030ee, #12061aee); }
  .explore[data-world='1'] .labels :global(.xl[data-kind='aimed']) { border-color: #ffb36b; box-shadow: 0 0 24px #ff7a3d70, inset 0 1px 0 #ffffff50; }
  .explore[data-world='1'] .labels :global(.xl[data-kind='aimed'])::before { border-radius: 13px 13px 0 0; background: linear-gradient(90deg, #ffe08a, #ff7a3d, #ff3d8a); }
  /* Tunnelwerk: black and white blocks, a checkered header. */
  .explore[data-world='2'] .labels :global(.xl) { border: 2px solid #ffffffb0; background: #000000f0; box-shadow: 4px 4px 0 #ffffff40; }
  .explore[data-world='2'] .labels :global(.xl[data-kind='aimed']) { border-color: #fff; box-shadow: 6px 6px 0 #fff; }
  .explore[data-world='2'] .labels :global(.xl[data-kind='aimed'])::before { color: #000; background: repeating-conic-gradient(#fff 0 25%, #d8d8d8 0 50%) 0 0 / 10px 10px; }
  /* Nachtflug: HUD brackets on the night. */
  .explore[data-world='3'] .labels :global(.xl) { border: 0; background: linear-gradient(#020a18cc, #020a18cc) padding-box; box-shadow: inset 2px 2px 0 -0px color-mix(in srgb, var(--band) 70%, transparent), inset -2px -2px 0 0 color-mix(in srgb, var(--band) 70%, transparent); }
  .explore[data-world='3'] .labels :global(.xl[data-kind='aimed']) { box-shadow: inset 2px 2px 0 var(--band), inset -2px -2px 0 var(--band), 0 0 26px color-mix(in srgb, var(--band) 45%, transparent); }
  .explore[data-world='3'] .labels :global(.xl[data-kind='aimed'])::before { background: transparent; color: var(--band); border-bottom: 1px solid var(--band); }
  /* Kupferzeit: copper-bar rainbow headers on deep purple. */
  .explore[data-world='4'] .labels :global(.xl) { border: 0; border-top: 3px solid transparent; border-image: linear-gradient(90deg, #ff3d3d, #ffb347, #fff35c, #3dff8a, #3dc8ff, #b84dff) 1; background: #140626ee; }
  .explore[data-world='4'] .labels :global(.xl[data-kind='aimed'])::before { background: linear-gradient(90deg, #ff3d3d, #ffb347, #fff35c, #3dff8a, #3dc8ff, #b84dff); }
  @keyframes gen-fade { 0%, 100% { opacity: 0; } 10%, 85% { opacity: 1; } }

  /* The sector's name: a chrome logo, demo style. */
  .realm { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); display: grid; justify-items: center; max-width: min(44vw, 560px); pointer-events: none; text-align: center; }
  .realm .eyebrow { font: 700 11px/1.2 var(--font-mono); text-transform: uppercase; letter-spacing: .32em; color: var(--band); text-shadow: 0 0 10px var(--band); }
  .realm h1 {
    margin: 2px 0 0; font: italic 900 clamp(26px, 2.6vw, 46px)/1 'Arial Black', 'Helvetica Neue', Impact, sans-serif; text-transform: uppercase; letter-spacing: .02em; white-space: nowrap;
    background: linear-gradient(#ffffff 0%, #e6ecff 44%, var(--band) 50%, #1a0b33 78%, #ffffff 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    -webkit-text-stroke: 1px #00000080;
    filter: drop-shadow(0 0 14px color-mix(in srgb, var(--band) 55%, transparent));
  }
  .realm p { display: flex; align-items: center; gap: 8px; margin: 6px 0 0; font: 600 11px/1.2 var(--font-mono); text-transform: uppercase; letter-spacing: .12em; color: #d6d9f0; }
  .realm i { font-style: normal; color: var(--band); }
  .realm .analysis { display: inline-flex; align-items: center; gap: 6px; color: var(--band); }
  .realm .analysis b { font: 650 11px var(--font-mono); font-variant-numeric: tabular-nums; color: #fff; letter-spacing: 0; }
  .realm .analysis small { font-size: 10px; color: #a4a8c8; }
  .upstream { pointer-events: auto; padding: 3px 8px; border: 1px solid var(--band); border-radius: 0; background: var(--glass); color: #fff; font: 700 10.5px var(--font-mono); text-transform: uppercase; letter-spacing: .1em; cursor: pointer; }
  .growth { display: block; opacity: .8; }

  /* Path labels: black glass, a neon hairline, mono type; the aimed one locks on and grows upward only. */
  .labels :global(.xl) {
    position: absolute; left: 0; top: 0; padding: 8px 10px 9px;
    border: 1px solid color-mix(in srgb, var(--band) 35%, transparent); border-radius: 0;
    color: #fff; background: var(--glass);
    text-align: left; pointer-events: auto; cursor: pointer;
    box-shadow: 0 0 18px #0008;
    will-change: transform;
  }
  .labels :global(.xl)::after {
    content: ''; position: absolute; height: var(--stem, 19px); width: 1px;
    top: 100%; left: 50%; background: linear-gradient(color-mix(in srgb, var(--band) 70%, transparent), transparent);
  }
  .labels :global(.xl:hover), .labels :global(.xl:focus-visible) { background: #0d0a1aee; border-color: var(--band); }
  .labels :global(.xl-leaving) { pointer-events: none; }
  .labels :global(.xl-t), .labels :global(.xl-a), .labels :global(.xl-m) { display: block; }
  .labels :global(.xl-t) { overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; font: 700 clamp(12px, .84vw, 15px)/1.25 var(--font-ui); text-wrap: balance; }
  .labels :global(.xl-a) { font-size: 11px; color: #a4a8c8; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .labels :global(.xl-m) { margin-top: 6px; font: 600 10px/1.4 var(--font-mono); font-variant-numeric: tabular-nums; color: color-mix(in srgb, var(--band) 60%, #fff); white-space: pre; }
  .labels :global(.xl[data-kind='aimed']) { z-index: 2; border: 1px solid var(--band); background: #05020dee; box-shadow: 0 0 0 1px #000, 0 0 24px color-mix(in srgb, var(--band) 45%, transparent), inset 0 0 18px color-mix(in srgb, var(--band) 14%, transparent); }
  .labels :global(.xl[data-kind='aimed'])::before { content: '▶ locked · next path'; display: block; margin: -8px -10px 6px; padding: 3px 10px; background: var(--band); font: 800 10px/1.3 var(--font-mono); text-transform: uppercase; letter-spacing: .16em; color: #000; }
  .labels :global(.xl[data-kind='aimed'] .xl-t) { font-size: clamp(13px, .95vw, 17px); }
  .labels :global(.xl[data-kind='aimed'])::after { width: 2px; background: linear-gradient(var(--band), transparent); box-shadow: 0 0 8px var(--band); }
  .labels :global(.xl[data-kind='aimed'] .xl-m) { color: var(--band); }

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
    font: italic 900 14px/1 'Arial Black', var(--font-ui);
    letter-spacing: 0.18em;
    color: var(--text);
  }
  .brand span {
    color: #a4a8c8;
  }
  .bands {
    display: inline-flex;
    padding: 2px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: var(--glass);
  }
  .band {
    height: 26px;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    font: 750 11.5px/1 var(--font-ui);
    letter-spacing: 0.12em;
    color: #a4a8c8;
    cursor: pointer;
  }
  .band:hover {
    color: var(--c);
  }
  .band.on {
    background: color-mix(in srgb, var(--c) 22%, transparent);
    box-shadow:
      inset 0 0 0 1px var(--c),
      0 0 12px color-mix(in srgb, var(--c) 45%, transparent);
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
    background: var(--glass);
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
    white-space: nowrap;
  }
  button.chip {
    cursor: pointer;
  }
  .rec { font: 800 11.5px/1 var(--font-mono); letter-spacing: 0.12em; font-variant-numeric: tabular-nums; }
  .rec-dot { width: 9px; height: 9px; border-radius: 50%; background: #5a2030; box-shadow: inset 0 0 0 1px #ff4d6d80; }
  .rec.on { border-color: #ff4d6d; color: #fff; box-shadow: 0 0 14px #ff4d6d55; }
  .rec.on .rec-dot { background: #ff2b4f; box-shadow: 0 0 10px #ff2b4f; animation: rec-blink 1s steps(2, start) infinite; }
  @keyframes rec-blink { 50% { opacity: 0.25; } }
  @media (prefers-reduced-motion: reduce) { .rec.on .rec-dot { animation: none; } }
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
    color: #a4a8c8;
  }
  .k {
    font-size: 10.5px;
    font-weight: 650;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #a4a8c8;
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
    color: #a4a8c8;
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
    color: #a4a8c8;
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
    color: var(--band);
    font-weight: 700;
  }
  .crumbs li.scout {
    margin-left: 8px;
    color: var(--band);
    font: 400 12px/1.2 var(--font-display);
    font-variant-caps: all-small-caps;
    letter-spacing: 0.14em;
  }
  .crumbs li.scout::after,
  .crumbs li:nth-last-child(2):has(+ .scout)::after {
    content: none;
  }

  /* Side: close + minimap */
  /* The latency scope beside the minimap; labels keep clear of the corner. */
  .side {
    position: absolute;
    top: 22px;
    right: 24px;
    display: flex;
    flex-direction: row-reverse;
    align-items: flex-start;
    gap: 10px;
  }
  .hint {
    align-self: center;
    font-size: 13px;
    color: #a4a8c8;
  }
  .stats {
    position: absolute;
    right: 24px;
    bottom: calc(var(--explore-bottom, 300px) + 22px);
    pointer-events: none;
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
