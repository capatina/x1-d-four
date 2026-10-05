<script lang="ts">
  import Deck from './components/Deck.svelte';
  import Library from './components/Library.svelte';
  import MidiPanel from './components/MidiPanel.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import Toasts from './components/Toasts.svelte';
  import { client } from './lib/client.svelte';
  import { DECK_COUNT } from './lib/protocol';

  const DECKS = Array.from({ length: DECK_COUNT }, (_, i) => i);
  const MIDI_KEY = 'baredeck:midi-collapsed';

  let midiCollapsed = $state(readFlag(MIDI_KEY));
  $effect(() => writeFlag(MIDI_KEY, midiCollapsed));

  // Banner: only once a connection attempt has actually failed, so a normal
  // page load doesn't flash it.
  const offline = $derived(client.ws === 'closed' || (client.ws === 'connecting' && client.everConnected));
  let now = $state(performance.now());
  $effect(() => {
    if (!offline) return;
    const timer = setInterval(() => (now = performance.now()), 200);
    return () => clearInterval(timer);
  });
  const retryIn = $derived(client.retryAt == null ? 0 : Math.max(0, Math.ceil((client.retryAt - now) / 1000)));

  // Keyboard shortcuts. Capture phase, so they win over a focused button or
  // slider; ignored while typing in the search box (it handles Esc itself).
  $effect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;

      const digit = deckDigit(e.code);
      if (digit != null) {
        e.preventDefault();
        if (e.repeat) return;
        if (e.shiftKey) client.send({ cmd: 'load_selected', deck: digit });
        else client.focus(digit);
        return;
      }

      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowDown':
          e.preventDefault();
          client.send({ cmd: 'scroll', delta: e.key === 'ArrowUp' ? -1 : 1 });
          break;
        case 'Enter':
          e.preventDefault();
          if (!e.repeat) client.send({ cmd: 'load_selected' });
          break;
        case ' ':
          e.preventDefault();
          if (!e.repeat) client.send({ cmd: 'play_pause', deck: client.targetDeck() });
          break;
        case '/':
          e.preventDefault();
          document.getElementById('library-search')?.focus();
          break;
        case 'Escape':
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          break;
      }
    };
    // Stop Space/Enter from also "clicking" whatever button has focus.
    const up = (e: KeyboardEvent) => {
      if ((e.key === ' ' || e.key === 'Enter') && !isTyping(e.target)) e.preventDefault();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  });

  function deckDigit(code: string): number | null {
    const m = /^(?:Digit|Numpad)([1-4])$/.exec(code);
    return m ? Number(m[1]) - 1 : null;
  }

  function isTyping(target: EventTarget | null): boolean {
    if (target instanceof HTMLTextAreaElement) return true;
    if (target instanceof HTMLInputElement) return !['range', 'button', 'checkbox', 'radio'].includes(target.type);
    return target instanceof HTMLElement && target.isContentEditable;
  }

  function readFlag(key: string): boolean {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  }

  function writeFlag(key: string, value: boolean) {
    try {
      localStorage.setItem(key, value ? '1' : '0');
    } catch {
      // Storage blocked: the panel just won't remember its state.
    }
  }
</script>

<div class="app" class:offline>
  <StatusBar />

  {#if offline}
    <div class="banner" role="alert">
      <span class="pip"></span>
      <span>
        <b>{client.everConnected ? 'Lost connection to the baredeck server.' : "Can't reach the baredeck server."}</b>
        {client.ws === 'connecting' ? 'Connecting…' : `Retrying in ${retryIn} s.`}
      </span>
      <button type="button" onclick={() => client.connect()}>Retry now</button>
    </div>
  {/if}

  <main>
    <div class="decks">
      {#each DECKS as i (i)}
        <Deck index={i} />
      {/each}
    </div>
    <div class="lower">
      <Library />
      <MidiPanel bind:collapsed={midiCollapsed} />
    </div>
  </main>

  <Toasts />
</div>

<style>
  .app {
    position: relative;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: 100vh;
    height: 100dvh;
  }
  main {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    gap: var(--gap);
    min-height: 0;
    padding: var(--gap);
  }
  .decks {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--gap);
  }
  .lower {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--gap);
    min-height: 0;
  }
  .offline .decks {
    opacity: 0.45;
    filter: saturate(0.4);
  }

  .banner {
    position: absolute;
    top: 52px;
    left: 50%;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 14px;
    max-width: calc(100vw - 32px);
    padding: 10px 10px 10px 16px;
    border: 1px solid color-mix(in srgb, var(--bad) 60%, transparent);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--bad) 16%, var(--bg-2));
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
    transform: translateX(-50%);
    font-size: 15px;
    color: var(--text);
    white-space: nowrap;
  }
  .banner b {
    font-weight: 650;
  }
  .pip {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--bad);
    flex: none;
  }
  .banner button {
    height: 32px;
    padding: 0 14px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    background: var(--bg-3);
    color: var(--text);
    font: 600 13px/1 var(--font-ui);
    cursor: pointer;
  }
  .banner button:hover {
    background: var(--bg-4);
  }
</style>
