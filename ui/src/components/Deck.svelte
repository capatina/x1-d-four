<script lang="ts">
  import { client } from '../lib/client.svelte';
  import { deckColor } from '../lib/decks';
  import { fmtBpm, fmtTime, idToName } from '../lib/format';
  import { deckKey, keyText } from '../lib/mixer';
  import RateControl from './RateControl.svelte';
  import Waveform from './Waveform.svelte';

  let { index }: { index: number } = $props();

  const num = $derived(index + 1);
  const accent = $derived(deckColor(index));
  const ds = $derived(client.state?.decks[index] ?? null);
  const info = $derived(client.deckInfo[index]);
  const focused = $derived(client.focused === index);

  const loading = $derived(ds?.loading ?? false);
  const playing = $derived(ds?.playing ?? false);
  const trackId = $derived(ds ? ds.track_id : (info?.track.id ?? null));
  /** Metadata for what's on the deck: the loaded track, else the library entry. */
  const track = $derived(
    trackId == null ? null : info && info.track.id === trackId ? info.track : (client.library.get(trackId) ?? null),
  );
  // While a new track decodes the deck keeps its current one (still playable),
  // so only an id mismatch hides the waveform, not `loading` itself.
  const peaks = $derived(info && info.track.id === trackId ? info.peaks : null);
  const ready = $derived(trackId != null && !!peaks);

  const length = $derived(ds?.length || (info?.track.id === trackId ? info?.length : 0) || 0);
  const position = $derived(ds?.position ?? 0);
  const cue = $derived(ds?.cue ?? 0);
  const rate = $derived(ds?.rate ?? 1);
  const remaining = $derived(Math.max(0, length - position));
  const ending = $derived(ready && playing && length > 0 && remaining < 30);
  const endingSoon = $derived(ending && remaining < 15);
  const atCue = $derived(ready && !playing && Math.abs(position - cue) < 0.05);

  const title = $derived(track?.title ?? (trackId ? idToName(trackId) : null));
  const artist = $derived(track?.artist ?? null);
  const bpm = $derived(track?.bpm ? fmtBpm(track.bpm * rate) : '');

  /** "L lit 2", the mixer control that loads the selection onto this deck. */
  const loadKey = $derived(deckKey(client.mixer, 'deck.load_selected', index));

  let cueHeld = $state(false);

  function focus() {
    client.focus(index);
  }

  function cueDown(e: PointerEvent) {
    if (e.button !== 0 || !ready) return;
    cueHeld = true;
    client.send({ cmd: 'cue', deck: index, pressed: true });
  }

  function cueUp() {
    if (!cueHeld) return;
    cueHeld = false;
    client.send({ cmd: 'cue', deck: index, pressed: false });
  }

  function playDown(e: PointerEvent) {
    // Fire on press, not release: timing matters when dropping a track in.
    if (e.button !== 0 || !ready) return;
    client.send({ cmd: 'play_pause', deck: index });
  }

  function playClick(e: MouseEvent) {
    // Keyboard / assistive activation (pointer presses were handled on down).
    if (e.detail === 0 && ready) client.send({ cmd: 'play_pause', deck: index });
  }
</script>

<svelte:window onblur={cueUp} />

<section
  class="deck"
  class:focused
  class:playing
  class:idle={trackId == null}
  style:--accent={accent}
  aria-label="Deck {num}"
>
  <button
    type="button"
    class="head"
    onclick={focus}
    aria-pressed={focused}
    title={focused ? `Deck ${num} is focused: "load selected" goes here` : `Focus deck ${num}`}
  >
    <span class="num">{num}</span>
    <span class="meta">
      {#if title}
        <span class="title" title={title}>{title}</span>
        {#if loading && ready}
          <span class="sub loading-text">loading next track…</span>
        {:else if loading}
          <span class="sub loading-text">loading…</span>
        {:else}
          <span class="sub" title={artist ?? ''}>{artist ?? 'Unknown artist'}</span>
        {/if}
      {:else if loading}
        <span class="title">Loading…</span>
        <span class="sub loading-text">decoding track</span>
      {:else}
        <span class="title muted">Empty</span>
        <span class="sub">{loadKey ? `${keyText(loadKey)} loads the selected track` : 'Nothing loaded'}</span>
      {/if}
    </span>
    {#if bpm}
      <span class="bpm" title={track?.bpm ? `Tagged ${fmtBpm(track.bpm)} BPM` : undefined}>
        <b>{bpm}</b><small>BPM</small>
      </span>
    {/if}
  </button>

  <Waveform
    {peaks}
    {position}
    {length}
    {cue}
    color={accent}
    {loading}
    onseek={(fraction) => client.send({ cmd: 'seek', deck: index, fraction })}
  />

  <div class="times" class:dim={!ready}>
    <div class="time">
      <span class="lbl">Elapsed</span>
      <span class="val">{fmtTime(ready ? position : 0)}</span>
    </div>
    <div class="time remain" class:ending class:soon={endingSoon}>
      <span class="lbl">Remain</span>
      <span class="val">−{fmtTime(ready ? remaining : 0)}</span>
    </div>
  </div>

  <div class="transport">
    <button
      type="button"
      class="btn cue"
      class:held={cueHeld}
      class:lit={atCue}
      disabled={!ready}
      aria-label="Cue deck {num}"
      onpointerdown={cueDown}
      onpointerup={cueUp}
      onpointercancel={cueUp}
      onpointerleave={cueUp}
      oncontextmenu={(e) => e.preventDefault()}
    >
      CUE
    </button>
    <button
      type="button"
      class="btn play"
      class:lit={playing}
      disabled={!ready}
      aria-label="{playing ? 'Pause' : 'Play'} deck {num}"
      aria-pressed={playing}
      onpointerdown={playDown}
      onclick={playClick}
    >
      <svg viewBox="0 0 40 20" aria-hidden="true">
        <path d="M2 2.5v15L15 10z" />
        <rect x="22" y="3" width="5" height="14" rx="1" />
        <rect x="31" y="3" width="5" height="14" rx="1" />
      </svg>
    </button>
    <button
      type="button"
      class="btn eject"
      disabled={trackId == null || playing}
      aria-label="Eject deck {num}"
      title={playing ? 'Pause before ejecting' : `Eject deck ${num}`}
      onclick={() => client.send({ cmd: 'eject', deck: index })}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 3.5 17 11.5H3z" />
        <rect x="3" y="13.5" width="14" height="3" rx="1" />
      </svg>
    </button>
  </div>

  <RateControl
    {rate}
    disabled={trackId == null}
    label="Deck {num} rate"
    onrate={(r) => client.send({ cmd: 'rate', deck: index, rate: r })}
  />
</section>

<style>
  .deck {
    container-type: inline-size;
    position: relative;
    display: grid;
    grid-template-rows: auto var(--wave-h) auto auto auto;
    gap: var(--deck-gap);
    min-width: 0;
    padding: var(--deck-pad);
    padding-top: calc(var(--deck-pad) + 2px);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg-2);
  }
  .deck::before {
    content: '';
    position: absolute;
    inset: -1px -1px auto;
    height: 3px;
    border-radius: var(--radius) var(--radius) 0 0;
    background: var(--accent);
    opacity: 0.45;
  }
  .deck.focused {
    border-color: var(--accent);
    box-shadow:
      0 0 0 1px var(--accent),
      0 0 24px -6px color-mix(in srgb, var(--accent) 55%, transparent);
  }
  .deck.focused::before {
    opacity: 1;
  }

  /* Header: focus target */
  .head {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    min-width: 0;
    margin: calc(var(--deck-pad) * -0.5);
    padding: calc(var(--deck-pad) * 0.5);
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .head:hover {
    background: rgba(255, 255, 255, 0.03);
  }
  .num {
    display: grid;
    place-items: center;
    width: var(--num-size);
    height: var(--num-size);
    border: 2px solid var(--accent);
    border-radius: var(--radius-sm);
    font: 700 calc(var(--num-size) * 0.62) / 1 var(--font-mono);
    color: var(--accent);
  }
  .focused .num {
    background: var(--accent);
    color: var(--bg-0);
  }
  .meta {
    display: grid;
    min-width: 0;
    gap: 2px;
  }
  .title,
  .sub {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .title {
    font-size: var(--title-size);
    font-weight: 650;
    line-height: 1.25;
    color: var(--text);
  }
  .title.muted {
    color: var(--text-3);
  }
  .sub {
    font-size: 13px;
    color: var(--text-2);
  }
  .idle .sub {
    color: var(--text-3);
  }
  .loading-text {
    color: var(--accent);
    font-style: italic;
  }
  .bpm {
    display: grid;
    justify-items: end;
    line-height: 1.05;
  }
  .bpm b {
    font: 700 20px/1.1 var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
  .bpm small {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.12em;
    color: var(--text-3);
  }

  /* Times */
  .times {
    display: flex;
    justify-content: space-between;
    align-items: end;
    gap: 8px;
  }
  .time {
    display: grid;
    gap: 1px;
    min-width: 0;
  }
  .remain {
    justify-items: end;
  }
  .lbl {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .val {
    font: 600 clamp(20px, 8.4cqi, var(--time-max)) / 1 var(--font-mono);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    color: var(--text);
    white-space: nowrap;
  }
  .remain .val {
    color: var(--text-2);
  }
  .remain.ending .val {
    color: var(--warn);
  }
  .remain.soon .val {
    color: var(--bad);
  }
  .times.dim .val {
    color: var(--text-4);
  }

  /* Transport */
  .transport {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr) auto;
    gap: 8px;
  }
  .btn {
    display: grid;
    place-items: center;
    height: var(--btn-h);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    background: var(--bg-3);
    color: var(--text);
    font: 700 15px/1 var(--font-ui);
    letter-spacing: 0.12em;
    cursor: pointer;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }
  .btn:hover:not(:disabled, .held, .lit) {
    background: var(--bg-4);
  }
  .btn:disabled {
    color: var(--text-4);
    background: var(--bg-2);
    border-color: var(--line);
    cursor: default;
  }
  .btn svg {
    height: 20px;
    fill: currentColor;
  }
  .btn.cue.lit {
    border-color: var(--accent);
    color: var(--accent);
  }
  .btn.cue.held,
  .btn.play.lit {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg-0);
  }
  .btn.play.lit {
    animation: pulse 1.8s ease-in-out infinite;
  }
  .btn.play.lit:hover {
    filter: brightness(1.08);
  }
  .eject {
    width: calc(var(--btn-h) * 0.85);
  }
  .eject svg {
    height: 16px;
  }
  @keyframes pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent);
    }
    50% {
      box-shadow: 0 0 18px 2px color-mix(in srgb, var(--accent) 45%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .btn.play.lit {
      animation: none;
      box-shadow: 0 0 14px 1px color-mix(in srgb, var(--accent) 40%, transparent);
    }
  }
</style>
