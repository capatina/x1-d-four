import { client } from '../lib/client.svelte';

/**
 * Explore-view keys; letters and digits type into the search instead. Returns
 * true when the key was handled (the caller prevents the default). Typing in
 * inputs is filtered out by the caller.
 */
export function handleExploreKey(e: KeyboardEvent): boolean {
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowRight':
      client.send({ cmd: 'explore_aim', delta: e.key === 'ArrowLeft' ? -1 : 1 });
      return true;
    case 'ArrowUp':
    case 'Enter':
      if (!e.repeat) client.send({ cmd: 'explore_dive' });
      return true;
    case 'ArrowDown':
    case 'Backspace':
      if (!e.repeat) client.send({ cmd: 'explore_back' });
      return true;
    case ' ':
      if (!e.repeat) client.send({ cmd: 'play_pause', deck: client.targetDeck() });
      return true;
  }
  return false;
}
