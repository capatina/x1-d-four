<script lang="ts">
  import { client, type MidiEntry } from '../lib/client.svelte';
  import { fmtServerClock } from '../lib/format';

  let { collapsed = $bindable(false) }: { collapsed?: boolean } = $props();

  const mappings = $derived(client.mappings);
  const entries = $derived(client.midi);
  const latest = $derived(entries[0]?.key ?? 0);
  const unknown = $derived(entries.filter((m) => m.control == null).length);

  // Flash the activity LED briefly whenever a message arrives.
  let blink = $state(false);
  let blinkTimer: ReturnType<typeof setTimeout> | undefined;
  let lastKey = 0;
  $effect(() => {
    if (latest === lastKey) return;
    const first = lastKey === 0;
    lastKey = latest;
    if (first) return;
    blink = true;
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => (blink = false), 140);
  });

  function eventText(m: MidiEntry): string {
    switch (m.event) {
      case 'press':
        return 'press';
      case 'release':
        return 'release';
      case 'value':
        return m.value == null ? 'value' : `= ${m.value}`;
      case 'delta':
        return m.value == null ? 'delta' : m.value > 0 ? `+${m.value}` : `−${Math.abs(m.value)}`;
      default:
        return '';
    }
  }
</script>

{#if collapsed}
  <aside class="rail" aria-label="MIDI monitor (collapsed)">
    <button type="button" class="expand" onclick={() => (collapsed = false)} title="Show MIDI monitor" aria-expanded="false">
      <span class="led" class:blink></span>
      <span class="vert">MIDI</span>
      {#if mappings && !mappings.ok}<span class="dot bad" title="Mappings error"></span>{/if}
      {#if unknown > 0}<span class="unk-count" title="{unknown} unknown controls in the log">{unknown}</span>{/if}
    </button>
  </aside>
{:else}
  <aside class="panel" aria-label="MIDI monitor">
    <header class="top">
      <span class="led" class:blink></span>
      <h2>MIDI</h2>
      <span class="spacer"></span>
      <button type="button" class="ghost" onclick={() => client.clearMidi()} disabled={entries.length === 0}>Clear</button>
      <button type="button" class="ghost icon" onclick={() => (collapsed = true)} title="Collapse" aria-expanded="true" aria-label="Collapse MIDI monitor">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5 13 10l-5.5 5.5-1.06-1.06L10.88 10 6.44 5.56z" /></svg>
      </button>
    </header>

    <div class="mappings" class:ok={mappings?.ok} class:err={mappings && !mappings.ok}>
      {#if !mappings}
        <span class="dot"></span><span>Mappings: waiting for server…</span>
      {:else if mappings.ok}
        <span class="dot ok"></span>
        <span><b>{mappings.count}</b> {mappings.count === 1 ? 'mapping' : 'mappings'} loaded</span>
        <code class="path" title={mappings.path}>{'\u200e' + mappings.path + '\u200e'}</code>
      {:else}
        <span class="dot bad"></span>
        <b>Mappings error</b>
        <code class="path" title={mappings.path}>{'\u200e' + mappings.path + '\u200e'}</code>
        {#if mappings.error}<pre class="error">{mappings.error}</pre>{/if}
      {/if}
    </div>

    <div class="log" role="log" aria-live="off">
      {#each entries as m (m.key)}
        <!-- Server notes like "(LED echo ignored)" come in parentheses: not a fired mapping. -->
        <div class="entry" class:unknown={m.control == null} class:fired={!!m.action && !m.action.startsWith('(')}>
          <span class="t">{fmtServerClock(m.t)}</span>
          {#if m.control}
            <span class="ctl">{m.control}</span>
          {:else}
            <span class="ctl"><em>unknown</em> <span class="desc">{m.desc}</span></span>
          {/if}
          <span class="ev">{eventText(m)}</span>
          <span class="raw">{m.raw}</span>
          <span class="act" title={m.action ?? 'No mapping fired'}>{m.action ? `→ ${m.action}` : '—'}</span>
        </div>
      {:else}
        <p class="none">Press a control on the Xone:4D to see it here.<br />Unknown controls are flagged so you can map them.</p>
      {/each}
    </div>
  </aside>
{/if}

<style>
  .panel {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    grid-template-columns: minmax(0, 1fr);
    width: var(--midi-w);
    min-height: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg-1);
    overflow: hidden;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 8px 12px;
    border-bottom: 1px solid var(--line);
  }
  h2 {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.14em;
    color: var(--text-2);
  }
  .spacer {
    flex: 1;
  }
  .ghost {
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-2);
    font: 600 12px/1 var(--font-ui);
    cursor: pointer;
  }
  .ghost:hover:not(:disabled) {
    background: var(--bg-3);
    color: var(--text);
  }
  .ghost:disabled {
    color: var(--text-4);
    cursor: default;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 30px;
    padding: 0;
  }
  .icon svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
  }

  .led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--bg-4);
    flex: none;
  }
  .led {
    transition:
      background 0.3s ease-out,
      box-shadow 0.3s ease-out;
  }
  .led.blink {
    background: var(--ok);
    box-shadow: 0 0 8px var(--ok);
    transition: none;
  }

  .mappings {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
    color: var(--text-2);
  }
  .mappings b {
    color: var(--text);
    font-weight: 650;
  }
  .mappings.err {
    background: color-mix(in srgb, var(--bad) 12%, transparent);
  }
  .mappings.err b {
    color: var(--bad);
  }
  .path {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: 12px var(--font-mono);
    color: var(--text-3);
    direction: rtl;
    text-align: left;
  }
  .error {
    flex-basis: 100%;
    max-height: 7.5em;
    margin: 2px 0 0;
    overflow: auto;
    white-space: pre-wrap;
    font: 12px/1.45 var(--font-mono);
    color: var(--text);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-4);
    flex: none;
  }
  .dot.ok {
    background: var(--ok);
  }
  .dot.bad {
    background: var(--bad);
  }

  .log {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .entry {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas:
      't ctl ev'
      'raw act act';
    column-gap: 10px;
    row-gap: 1px;
    padding: 6px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.035);
    font-size: 13px;
  }
  .entry:first-child {
    background: rgba(255, 255, 255, 0.03);
  }
  .t {
    grid-area: t;
    font: 12px var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text-3);
  }
  .ctl {
    grid-area: ctl;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font: 600 13px var(--font-mono);
    color: var(--text);
  }
  .ctl em {
    padding: 0 5px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--warn) 22%, transparent);
    color: var(--warn);
    font-style: normal;
    font-family: var(--font-ui);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .desc {
    font-weight: 500;
    color: var(--text-2);
  }
  /* Unknown controls: never truncate the raw description, it's what you map from. */
  .unknown .ctl {
    white-space: normal;
  }
  .unknown {
    box-shadow: inset 3px 0 0 var(--warn);
  }
  .ev {
    grid-area: ev;
    font: 600 12px var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text-2);
    text-align: right;
  }
  .raw {
    grid-area: raw;
    font: 12px var(--font-mono);
    color: var(--text-3);
    white-space: nowrap;
  }
  .act {
    grid-area: act;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font: 12px var(--font-mono);
    color: var(--text-4);
  }
  .fired .act {
    color: var(--ok);
  }
  .none {
    margin: 0;
    padding: 24px 16px;
    text-align: center;
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-3);
  }

  /* Collapsed rail */
  .rail {
    display: grid;
    min-height: 0;
  }
  .expand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    width: 40px;
    padding: 12px 0;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg-1);
    color: var(--text-2);
    cursor: pointer;
  }
  .expand:hover {
    background: var(--bg-2);
    color: var(--text);
  }
  .vert {
    writing-mode: vertical-rl;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.14em;
  }
  .unk-count {
    min-width: 20px;
    padding: 2px 4px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--warn) 22%, transparent);
    color: var(--warn);
    font: 700 11px/1.2 var(--font-mono);
    text-align: center;
  }

  @media (prefers-reduced-motion: reduce) {
    .led {
      transition: none;
    }
  }
</style>
