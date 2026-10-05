<script lang="ts">
  import { fmtRatePct } from '../lib/format';

  type Props = {
    /** Current rate from the server, 1.0 = normal. */
    rate: number;
    disabled?: boolean;
    label: string;
    onrate: (rate: number) => void;
  };

  let { rate, disabled = false, label, onrate }: Props = $props();

  /** Slider range in percent either side of 1.0. */
  const RANGE = 8;
  const LOCAL_HOLD_MS = 400;

  let local = $state(0);
  // While dragging (and briefly after a keyboard nudge) show our own value so
  // the 30 Hz echo from the server can't make the thumb jitter.
  let dragging = $state(false);
  let holding = $state(false);
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let pendingPct = 0;

  const serverPct = $derived((rate - 1) * 100);
  const shownPct = $derived(dragging || holding ? local : serverPct);
  const sliderPct = $derived(Math.min(RANGE, Math.max(-RANGE, shownPct)));
  const text = $derived(fmtRatePct(1 + shownPct / 100));
  /** Thumb position 0..100 % along the track, for the centre-out fill. */
  const pos = $derived(((sliderPct + RANGE) / (2 * RANGE)) * 100);

  function push(pct: number) {
    pendingPct = pct;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      onrate(round4(1 + pendingPct / 100));
    });
  }

  function hold() {
    holding = true;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => (holding = false), LOCAL_HOLD_MS);
  }

  function oninput(e: Event & { currentTarget: HTMLInputElement }) {
    local = Number(e.currentTarget.value);
    hold();
    push(local);
  }

  function reset() {
    if (disabled) return;
    local = 0;
    hold();
    push(0);
  }

  function onpointerdown(e: PointerEvent) {
    if (e.button !== 0) return;
    local = serverPct;
    dragging = true;
    const up = () => {
      dragging = false;
      hold();
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function round4(v: number): number {
    return Math.round(v * 10000) / 10000;
  }
</script>

<div class="rate" class:off={Math.abs(shownPct) < 0.005} class:disabled>
  <span class="cap">Rate</span>
  <input
    type="range"
    min={-RANGE}
    max={RANGE}
    step="0.02"
    value={sliderPct}
    {disabled}
    aria-label={label}
    aria-valuetext={text}
    title="Double-click to reset to 0%"
    style:--lo="{Math.min(50, pos)}%"
    style:--hi="{Math.max(50, pos)}%"
    {oninput}
    {onpointerdown}
    ondblclick={reset}
  />
  <span class="readout">{text}</span>
</div>

<style>
  .rate {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
  }
  .cap {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .readout {
    min-width: 7.2ch;
    font: 600 15px/1.2 var(--font-mono);
    font-variant-numeric: tabular-nums;
    text-align: right;
    color: var(--accent);
  }
  .off .readout {
    color: var(--text-2);
  }
  .disabled .readout {
    color: var(--text-4);
  }

  input {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 28px;
    margin: 0;
    background: transparent;
    cursor: ew-resize;
    touch-action: none;
  }
  input:disabled {
    cursor: default;
  }
  input::-webkit-slider-runnable-track {
    height: 6px;
    border-radius: 3px;
    background:
      linear-gradient(var(--text-3), var(--text-3)) 50% 50% / 2px 12px no-repeat,
      linear-gradient(
        to right,
        transparent var(--lo),
        var(--accent) var(--lo),
        var(--accent) var(--hi),
        transparent var(--hi)
      ),
      var(--bg-4);
  }
  input::-moz-range-track {
    height: 6px;
    border-radius: 3px;
    background:
      linear-gradient(
        to right,
        transparent var(--lo),
        var(--accent) var(--lo),
        var(--accent) var(--hi),
        transparent var(--hi)
      ),
      var(--bg-4);
  }
  input::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 24px;
    margin-top: -9px;
    border-radius: 3px;
    background: linear-gradient(to right, transparent 6px, var(--bg-0) 6px, var(--bg-0) 8px, transparent 8px),
      var(--text);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
  }
  input::-moz-range-thumb {
    width: 14px;
    height: 24px;
    border: 0;
    border-radius: 3px;
    background: linear-gradient(to right, transparent 6px, var(--bg-0) 6px, var(--bg-0) 8px, transparent 8px),
      var(--text);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
  }
  input:disabled::-webkit-slider-thumb {
    background: var(--bg-4);
    box-shadow: none;
  }
  input:disabled::-moz-range-thumb {
    background: var(--bg-4);
    box-shadow: none;
  }
  input:focus-visible {
    outline: none;
  }
  input:focus-visible::-webkit-slider-thumb {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  input:focus-visible::-moz-range-thumb {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
</style>
