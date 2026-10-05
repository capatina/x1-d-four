<script lang="ts">
  import { client } from '../lib/client.svelte';
  import { fmtBpm } from '../lib/format';

  const device = $derived(client.state?.device ?? null);
  const devState = $derived(device?.state ?? null);
  const tone = $derived(
    devState === 'running' ? 'ok' : devState === 'connecting' ? 'warn' : devState ? 'bad' : 'none',
  );
  const devLabel = $derived(
    devState
      ? { running: 'Running', connecting: 'Connecting', stalled: 'Stalled', missing: 'Not found', error: 'Error' }[
          devState
        ]
      : 'No data',
  );
  const clock = $derived(fmtBpm(client.state?.bpm));
  const wsTone = $derived(client.ws === 'open' ? 'ok' : client.ws === 'connecting' ? 'warn' : 'bad');
  const wsLabel = $derived(
    client.ws === 'open' ? 'Connected' : client.ws === 'connecting' ? 'Connecting…' : 'Disconnected',
  );
  const queueTitle = $derived(
    device
      ? [
          `${device.out_urbs} OUT URBs`,
          `${device.packets_out.toLocaleString()} packets out`,
          device.min_queued != null ? `min queued ${device.min_queued} (last second)` : null,
          device.max_gap_us != null ? `max completion gap ${(device.max_gap_us / 1000).toFixed(2)} ms (last second)` : null,
        ]
          .filter(Boolean)
          .join('\n')
      : '',
  );
</script>

<header class="status" class:stale={client.ws !== 'open'}>
  <span class="brand">BARE<span>·</span>DECK</span>

  <span class="item device {tone}" title={device?.message ?? ''}>
    <span class="dot"></span>
    <span class="k">Xone:4D</span>
    <b>{devLabel}</b>
    {#if device?.message && devState !== 'running'}
      <span class="msg">{device.message}</span>
    {:else if device?.firmware}
      <span class="sub">fw {device.firmware}</span>
    {/if}
  </span>

  {#if device}
    <span class="item" title={queueTitle}>
      <span class="k">Latency</span><b class="n">{device.latency_ms.toFixed(1)}<small>ms</small></b>
    </span>
    <span class="item" class:alert={device.underruns > 0} title="Times the OUT queue ran dry (should stay 0)">
      <span class="k">Underruns</span><b class="n">{device.underruns}</b>
    </span>
    <span class="item" class:alert={device.urb_errors > 0}>
      <span class="k">URB errors</span><b class="n">{device.urb_errors}</b>
    </span>
    {#if device.min_queued != null || device.max_gap_us != null}
      <span class="item wide-only" title={queueTitle}>
        <span class="k">Queue</span>
        <b class="n">{device.min_queued ?? '–'}</b>
        <span class="k">Gap</span>
        <b class="n">{device.max_gap_us != null ? (device.max_gap_us / 1000).toFixed(1) : '–'}<small>ms</small></b>
      </span>
    {/if}
  {/if}

  <span class="item" title="Tempo from the mixer's MIDI clock">
    <span class="k">Clock</span><b class="n">{clock || '—'}{#if clock}<small>BPM</small>{/if}</b>
  </span>

  <span class="item ws {wsTone}">
    <span class="dot"></span><span class="k">Server</span><b>{wsLabel}</b>
  </span>
</header>

<style>
  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 44px;
    padding: 0 12px;
    border-bottom: 1px solid var(--line);
    background: var(--bg-1);
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
  }
  .brand {
    margin-right: 10px;
    font: 800 14px/1 var(--font-ui);
    letter-spacing: 0.18em;
    color: var(--text);
  }
  .brand span {
    color: var(--text-3);
  }
  .item {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    padding: 5px 10px;
    border-radius: var(--radius-sm);
  }
  .item + .item {
    border-left: 1px solid var(--line);
    border-radius: 0;
  }
  .k {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  b {
    font-weight: 650;
    color: var(--text);
  }
  .n {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  small {
    margin-left: 2px;
    font-size: 10px;
    font-weight: 600;
    color: var(--text-3);
  }
  .sub {
    font-size: 12px;
    color: var(--text-3);
  }
  .msg {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-2);
  }
  .device {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
  }
  .dot {
    align-self: center;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--text-4);
    flex: none;
  }
  .ok .dot {
    background: var(--ok);
    box-shadow: 0 0 8px color-mix(in srgb, var(--ok) 60%, transparent);
  }
  .warn .dot {
    background: var(--warn);
  }
  .bad .dot {
    background: var(--bad);
    box-shadow: 0 0 8px color-mix(in srgb, var(--bad) 60%, transparent);
  }
  .device.bad b {
    color: var(--bad);
  }
  .device.warn b {
    color: var(--warn);
  }
  .ws.bad b {
    color: var(--bad);
  }
  .alert {
    background: color-mix(in srgb, var(--bad) 18%, transparent);
  }
  .alert b {
    color: var(--bad);
  }
  .ws {
    margin-left: auto;
  }
  /* Device numbers are last-known while the server is unreachable. */
  .stale .item:not(.ws) {
    opacity: 0.4;
  }
  .item.ws {
    border-left: 0;
  }
  @media (max-width: 1500px) {
    .wide-only {
      display: none;
    }
  }
</style>
