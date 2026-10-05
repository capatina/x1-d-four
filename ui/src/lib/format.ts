/** Seconds → "mm:ss.t" (minutes keep counting past 59). */
export function fmtTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const tenths = Math.floor(seconds * 10 + 1e-6);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  const t = tenths % 10;
  return `${pad2(m)}:${pad2(s)}.${t}`;
}

/** Seconds → "m:ss" for library lengths. */
export function fmtLength(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** ms since server start → "mm:ss.mmm" (or "h:mm:ss.mmm"). */
export function fmtServerClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const frac = String(total % 1000).padStart(3, '0');
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}.${frac}` : `${pad2(m)}:${pad2(s)}.${frac}`;
}

export function fmtBpm(bpm: number | null | undefined): string {
  if (bpm == null || !Number.isFinite(bpm) || bpm <= 0) return '';
  return bpm.toFixed(1);
}

/** Rate (1.0 = normal) → signed percentage, e.g. "+1.25%". */
/** Loop length for people: "8 bars", "1 bar", "1/2 bar", "1/8 bar". */
export function fmtLoop(beats: number): string {
  const bars = beats / 4;
  if (bars >= 1) return `${bars} ${bars === 1 ? 'bar' : 'bars'}`;
  return `1/${Math.round(1 / bars)} bar`;
}

export function fmtRatePct(rate: number): string {
  const pct = (rate - 1) * 100;
  const rounded = Math.round(pct * 100) / 100;
  if (rounded === 0) return '0.00%';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(2)}%`;
}

/** File name without folders or extension, for ids we have no metadata for. */
export function idToName(id: string): string {
  const base = id.split('/').pop() ?? id;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
