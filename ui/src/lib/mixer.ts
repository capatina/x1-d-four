// Turns the server's mappings (GET /api/mappings) into what the UI teaches:
// short mixer control names ("R SELECT push", "L lit 1–4") and legend entries
// ("L lit 1–4 · load deck 1–4"). The mixer drives everything; the UI only
// shows which control does what.

import { BAND_PALETTE } from '../explore/palette';
import { BANDS, type Band, type Mapping, type View } from './protocol';

export type Side = 'L' | 'R';

/** One physical control (or a numbered run of them, e.g. lit 1–4). */
export type MixerKey = {
  side: Side | null;
  /** e.g. "jog", "SELECT push", "lit 1–4", "enc 2 push", "M". */
  name: string;
  shift: boolean;
};

export type LabelPart = { text: string; band?: Band };

export type LegendItem = { id: string; key: MixerKey; parts: LabelPart[] };

export type LegendSlot =
  | 'aim'
  | 'dive'
  | 'band'
  | 'load'
  | 'play'
  | 'cue'
  | 'pitch'
  | 'jog'
  | 'sync'
  | 'focus'
  | 'loop'
  | 'scroll'
  | 'root'
  | 'follow'
  | 'view';

/** Explore legend, in teaching order. */
export const EXPLORE_LEGEND: readonly LegendSlot[] = ['aim', 'dive', 'band', 'focus', 'jog', 'load', 'play', 'loop', 'cue', 'pitch', 'sync', 'root', 'follow', 'view'];

/** Deck view legend: browse, load, play. */
export const DECKS_LEGEND: readonly LegendSlot[] = ['scroll', 'load', 'play', 'cue', 'pitch', 'sync', 'view'];

type Parsed = {
  shift: boolean;
  side: Side | null;
  /** "lit", "encoder", "browse.push", "button.A", "jog", "xfader"… */
  base: string;
  /** Trailing control number (lit3 → 3), if any. */
  num: number | null;
  /** What follows the number, e.g. ".push". */
  suffix: string;
};

/** One mapping, or a collapsed run of numbered per-deck mappings. */
type Entry = {
  key: MixerKey;
  /** "2", "1–4", or null when the mapping acts on the focused deck. */
  decks: string | null;
  amount: number | undefined;
};

const NUMBERED: Record<string, string> = { encoder: 'enc' };

function parse(control: string): Parsed {
  let rest = control;
  const shift = rest.startsWith('shift.');
  if (shift) rest = rest.slice('shift.'.length);
  let side: Side | null = null;
  if (rest.startsWith('left.')) {
    side = 'L';
    rest = rest.slice('left.'.length);
  } else if (rest.startsWith('right.')) {
    side = 'R';
    rest = rest.slice('right.'.length);
  }
  const m = /^([a-z]+)(\d+)((?:\.[a-z0-9]+)*)$/i.exec(rest);
  if (m) return { shift, side, base: m[1], num: Number(m[2]), suffix: m[3] };
  return { shift, side, base: rest, num: null, suffix: '' };
}

function keyName(p: Parsed, num: string | null): string {
  if (p.num != null) return `${NUMBERED[p.base] ?? p.base} ${num ?? p.num}${p.suffix.replace(/\./g, ' ')}`;
  if (p.base === 'browse') return 'SELECT turn';
  if (p.base === 'browse.push') return 'SELECT push';
  if (p.base.startsWith('button.')) return p.base.slice('button.'.length);
  return p.base.replace(/\./g, ' ');
}

function makeKey(p: Parsed, num: string | null = null): MixerKey {
  return { side: p.side, name: keyName(p, num), shift: p.shift };
}

const range = (a: number, b: number) => (a === b ? String(a) : `${a}–${b}`);

/**
 * Mappings for one action, in file order, with numbered per-deck runs
 * collapsed: left.lit1..4 → deck 1..4 becomes one "L lit 1–4" entry.
 */
function entries(maps: readonly Mapping[], action: string): Entry[] {
  const mine = maps.filter((m) => m.action === action);
  const out: Array<Entry | null> = [];
  const groups = new Map<string, { at: number; items: Array<{ m: Mapping; p: Parsed }> }>();
  for (const m of mine) {
    const p = parse(m.control);
    if (p.num == null) {
      out.push({ key: makeKey(p), decks: m.deck != null ? String(m.deck) : null, amount: m.amount });
      continue;
    }
    const gk = `${p.shift}|${p.side}|${p.base}|${p.suffix}|${m.amount ?? ''}`;
    let g = groups.get(gk);
    if (!g) {
      g = { at: out.length, items: [] };
      groups.set(gk, g);
      out.push(null); // placeholder: the group lands where it first appeared
    }
    g.items.push({ m, p });
  }
  const placed = new Map<number, Entry[]>();
  for (const g of groups.values()) {
    const items = g.items.slice().sort((a, b) => a.p.num! - b.p.num!);
    const runs: Entry[] = [];
    let start = 0;
    for (let i = 1; i <= items.length; i++) {
      const prev = items[i - 1];
      const cur = items[i];
      const continues =
        cur &&
        cur.p.num === prev.p.num! + 1 &&
        (cur.m.deck == null) === (prev.m.deck == null) &&
        (cur.m.deck == null || cur.m.deck === prev.m.deck! + 1);
      if (continues) continue;
      const a = items[start];
      const b = prev;
      runs.push({
        key: makeKey(a.p, range(a.p.num!, b.p.num!)),
        decks: a.m.deck != null ? range(a.m.deck, b.m.deck!) : null,
        amount: a.m.amount,
      });
      start = i;
    }
    placed.set(g.at, runs);
  }
  return out.flatMap((e, i) => (e ? [e] : (placed.get(i) ?? [])));
}

/** "SHIFT L SELECT push" — for tooltips and one-line hints. */
export function keyText(k: MixerKey): string {
  return `${k.shift ? 'SHIFT ' : ''}${k.side ? `${k.side} ` : ''}${k.name}`;
}

/** Controls for an action, collapsed ("L lit 1–4"). */
export function keysFor(maps: readonly Mapping[], action: string): MixerKey[] {
  return entries(maps, action).map((e) => e.key);
}

/** "R SELECT push / L SELECT push", or null when nothing is mapped. */
export function keysText(maps: readonly Mapping[], action: string): string | null {
  const keys = keysFor(maps, action);
  return keys.length ? keys.map(keyText).join(' / ') : null;
}

/** The single control that does `action` for one deck (0-based), e.g. "L lit 2". */
export function deckKey(maps: readonly Mapping[], action: string, deck: number): MixerKey | null {
  const m = maps.find((x) => x.action === action && x.deck === deck + 1);
  return m ? makeKey(parse(m.control)) : null;
}

/** The button that picks `band` directly, if any. */
export function bandKey(maps: readonly Mapping[], band: Band): MixerKey | null {
  const m = maps.find((x) => x.action === 'explore.band' && BANDS[Math.round(x.amount ?? 0)] === band);
  return m ? makeKey(parse(m.control)) : null;
}

/** How to dive: the dive button, else turning the step encoder right. */
export function diveHint(maps: readonly Mapping[]): string | null {
  const dive = keysText(maps, 'explore.dive');
  if (dive) return dive;
  const step = keysFor(maps, 'explore.step')[0];
  return step ? `${keyText(step)} right` : null;
}

/** How to climb back: the back button, else turning the step encoder left. */
export function backKey(maps: readonly Mapping[]): { key: MixerKey; turn: boolean } | null {
  const back = keysFor(maps, 'explore.back')[0];
  if (back) return { key: back, turn: false };
  const step = keysFor(maps, 'explore.step')[0];
  return step ? { key: step, turn: true } : null;
}

const decksText = (e: Entry, focused = 'focused deck') => (e.decks ? e.decks : focused);

/** Legend entries for `slots`, skipping anything that isn't mapped. */
export function legend(maps: readonly Mapping[], slots: readonly LegendSlot[], view: View): LegendItem[] {
  const items: LegendItem[] = [];
  const add = (slot: string, action: string, label: (e: Entry) => string | LabelPart[]) => {
    entries(maps, action).forEach((e, i) => {
      const l = label(e);
      items.push({ id: `${slot}:${action}:${i}`, key: e.key, parts: typeof l === 'string' ? [{ text: l }] : l });
    });
  };
  for (const slot of slots) {
    switch (slot) {
      case 'aim':
        add(slot, 'explore.aim', () => 'aim');
        break;
      case 'dive':
        add(slot, 'explore.dive', () => 'dive');
        // Turn left = back, right = dive, so the words read in turning order.
        add(slot, 'explore.step', () => 'back / dive');
        add(slot, 'explore.back', () => 'back');
        break;
      case 'band':
        add(slot, 'explore.cycle_band', () => 'band');
        add(slot, 'explore.band_step', () => 'band');
        add(slot, 'explore.band_fader', () => 'band');
        add(slot, 'explore.band_crossfader', () => 'band');
        items.push(...bandItems(maps));
        break;
      case 'load':
        add(slot, 'deck.load_selected', (e) => `load ${decksText(e)}`);
        break;
      case 'play':
        add(slot, 'deck.play_pause', (e) => `play ${decksText(e)}`);
        add(slot, 'deck.play', (e) => `play ${decksText(e)}`);
        break;
      case 'cue':
        add(slot, 'deck.cue', (e) => `cue ${decksText(e)}`);
        break;
      case 'pitch':
        add(slot, 'deck.rate', (e) => `pitch ${decksText(e)}`);
        break;
      case 'jog':
        add(slot, 'deck.jog', () => 'move');
        add(slot, 'deck.shift', () => 'fix sync');
        break;
      case 'sync':
        add(slot, 'deck.sync', (e) => `sync ${decksText(e)}`);
        add(slot, 'deck.sync_reset', () => 'reset sync');
        break;
      case 'focus':
        add(slot, 'deck.focus_step', () => 'focus deck');
        break;
      case 'loop':
        add(slot, 'deck.loop', (e) => `loop ${decksText(e)}`);
        add(slot, 'deck.loop_length', () => 'loop length');
        add(slot, 'deck.loop_move', () => 'move loop');
        break;
      case 'scroll':
        add(slot, 'library.scroll', (e) => (e.amount != null && e.amount !== 1 ? `scroll ×${e.amount}` : 'scroll'));
        break;
      case 'root':
        add(slot, 'explore.root', () => 'root from library');
        break;
      case 'follow':
        add(slot, 'explore.follow', () => 'follow');
        break;
      case 'view':
        add(slot, 'view.explore', () => (view === 'explore' ? 'decks' : 'explore'));
        break;
    }
  }
  return items;
}

/**
 * explore.band buttons. B/C/D on one pod with amounts 0/1/2 read best as a
 * single "L B/C/D · LOW/MID/HIGH" entry; anything else gets one entry each.
 */
function bandItems(maps: readonly Mapping[]): LegendItem[] {
  const bandOf = (m: Mapping): Band | null => BANDS[Math.round(m.amount ?? 0)] ?? null;
  const mine = maps
    .filter((m) => m.action === 'explore.band' && bandOf(m))
    .map((m) => ({ m, p: parse(m.control), band: bandOf(m)! }));
  if (!mine.length) return [];
  const first = mine[0].p;
  const together =
    mine.length > 1 &&
    mine.every((x) => x.p.side === first.side && x.p.shift === first.shift && x.p.base.startsWith('button.')) &&
    new Set(mine.map((x) => x.band)).size === mine.length;
  if (together) {
    mine.sort((a, b) => BANDS.indexOf(a.band) - BANDS.indexOf(b.band));
    const parts: LabelPart[] = [];
    mine.forEach((x, i) => {
      if (i) parts.push({ text: '/' });
      parts.push({ text: BAND_PALETTE[x.band].label, band: x.band });
    });
    return [
      {
        id: 'band:explore.band',
        key: { side: first.side, shift: first.shift, name: mine.map((x) => keyName(x.p, null)).join('/') },
        parts,
      },
    ];
  }
  return mine.map((x, i) => ({
    id: `band:explore.band:${i}`,
    key: makeKey(x.p),
    parts: [{ text: BAND_PALETTE[x.band].label, band: x.band }],
  }));
}
