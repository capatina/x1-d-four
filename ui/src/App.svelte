<script lang="ts">
  import Toasts from './components/Toasts.svelte';
  import ExploreView from './explore/ExploreView.svelte';
  import { handleExploreKey } from './explore/keys';
  import { client } from './lib/client.svelte';
  import { search } from './lib/search.svelte';

  // Banner: only once a connection attempt has actually failed, so a normal
  // page load doesn't flash it.
  const offline = $derived(client.ws === 'closed' || (client.ws === 'connecting' && client.everConnected));
  let now = $state(performance.now());
  $effect(() => {
    if (!offline) return;
    const timer = setInterval(() => (now = performance.now()), 250);
    return () => clearInterval(timer);
  });
  const retryIn = $derived(client.retryAt == null ? 0 : Math.max(0, Math.ceil((client.retryAt - now) / 1000)));

  // The tunnel is the whole app; everything is played from the mixer. Typing
  // any character searches; arrows, Enter, Backspace and Space are fallbacks.
  $effect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (search.open) {
        if (search.key(e)) e.preventDefault();
        return;
      }
      if (e.key.length === 1 && e.key !== ' ' && !e.repeat) {
        e.preventDefault();
        search.start(e.key);
        return;
      }
      if (handleExploreKey(e)) e.preventDefault();
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

  function isTyping(target: EventTarget | null): boolean {
    if (target instanceof HTMLTextAreaElement) return true;
    if (target instanceof HTMLInputElement) return !['range', 'button', 'checkbox', 'radio'].includes(target.type);
    return target instanceof HTMLElement && target.isContentEditable;
  }
</script>

<div class="app">
  <ExploreView />

  {#if offline}
    <div class="banner" role="alert">
      <span class="pip"></span>
      <span>
        <b>{client.everConnected ? 'Lost connection to the X1 D. Four server.' : "Can't reach the X1 D. Four server."}</b>
        {client.ws === 'connecting' ? 'Connecting…' : `Retrying in ${retryIn} s.`}
      </span>
      <button type="button" onclick={() => client.connect()}>Retry now</button>
    </div>
  {/if}

  <Toasts />
</div>

<style>
  .app {
    position: relative;
    height: 100vh;
    height: 100dvh;
  }

  .banner {
    position: absolute;
    top: 52px;
    z-index: 40;
    left: 50%;
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
