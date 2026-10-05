import { client } from '../lib/client.svelte';
import type { Band } from '../lib/protocol';

const BAND_KEYS: Record<string, Band> = { l: 'low', m: 'mid', h: 'high' };

/**
 * Explore-view shortcuts. Returns true when the key was handled (the caller
 * prevents the default). Typing in inputs is filtered out by the caller.
 */
export function handleExploreKey(e: KeyboardEvent): boolean {
  const deck = /^(?:Digit|Numpad)([1-4])$/.exec(e.code);
  if (deck) {
    if (e.repeat) return true;
    if (!client.explore?.aim) client.toast('Aim at a portal first', 'info');
    else client.send({ cmd: 'load_selected', deck: Number(deck[1]) - 1 });
    return true;
  }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowRight':
      client.send({ cmd: 'explore_aim', delta: key === 'ArrowLeft' ? -1 : 1 });
      return true;
    case 'ArrowUp':
    case 'Enter':
      if (!e.repeat) client.send({ cmd: 'explore_dive' });
      return true;
    case 'ArrowDown':
    case 'Backspace':
      if (!e.repeat) client.send({ cmd: 'explore_back' });
      return true;
    case 'l':
    case 'm':
    case 'h':
      if (!e.repeat) client.send({ cmd: 'explore_band', band: BAND_KEYS[key] });
      return true;
    case 'b':
      if (!e.repeat) client.send({ cmd: 'explore_cycle_band' });
      return true;
    case 'f':
      if (!e.repeat) client.send({ cmd: 'explore_follow', follow: !(client.explore?.follow ?? false) });
      return true;
    case ' ':
      if (!e.repeat) client.send({ cmd: 'play_pause', deck: client.targetDeck() });
      return true;
    case 'Escape':
    case 'e':
      if (!e.repeat) client.setView('decks');
      return true;
  }
  return false;
}
