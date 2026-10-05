<script lang="ts">
  import { client } from '../lib/client.svelte';
</script>

<div class="toasts" role="region" aria-label="Notifications" aria-live="assertive">
  {#each client.toasts as toast (toast.id)}
    <div class="toast {toast.kind}" role={toast.kind === 'error' ? 'alert' : 'status'}>
      <span class="icon" aria-hidden="true">{toast.kind === 'error' ? '!' : 'i'}</span>
      <p>
        {toast.message}
        {#if toast.count > 1}<span class="count">×{toast.count}</span>{/if}
      </p>
      <button type="button" aria-label="Dismiss" onclick={() => client.dismiss(toast.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 50%;
    bottom: 56px;
    z-index: 20;
    display: grid;
    gap: 8px;
    width: min(560px, calc(100vw - 32px));
    transform: translateX(-50%);
    pointer-events: none;
  }
  .toast {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: 12px;
    padding: 12px 10px 12px 14px;
    border: 1px solid var(--line-2);
    border-left: 4px solid var(--bad);
    border-radius: var(--radius);
    background: var(--bg-3);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
    pointer-events: auto;
  }
  .toast.info {
    border-left-color: var(--focus);
  }
  .icon {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--bad);
    color: var(--bg-0);
    font: 800 14px/1 var(--font-ui);
  }
  .info .icon {
    background: var(--focus);
    font-style: italic;
    font-family: Georgia, serif;
  }
  p {
    margin: 2px 0 0;
    font-size: 14.5px;
    line-height: 1.4;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .count {
    margin-left: 6px;
    padding: 0 5px;
    border-radius: 3px;
    background: var(--bg-4);
    font: 600 12px var(--font-mono);
    color: var(--text-2);
  }
  button {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-2);
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
  }
  button:hover {
    background: var(--bg-4);
    color: var(--text);
  }
</style>
