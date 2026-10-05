// Type-to-search in the tunnel: shared open/closed state and the query being typed.
import { client } from './client.svelte';

/** MIME type of a track id being dragged from the search results. */
export const TRACK_DRAG = 'application/x-x1d4-track';

class Search {
  open = $state(false);
  query = $state('');
  /** The track most recently dropped onto a deck (the panel stays open for those). */
  dropped = $state<string | null>(null);
  /** The search box, so keys typed elsewhere can go back into it. */
  input: HTMLInputElement | null = null;

  /** Open with the first typed character and search right away. */
  start(first: string) {
    this.open = true;
    this.set(first);
  }

  set(query: string) {
    this.query = query;
    client.send({ cmd: 'browse', query });
  }

  /** Keys while the panel is open, wherever focus is (after clicking a result or
   * dropping one, focus isn't in the box). Returns true when handled. */
  key(e: KeyboardEvent): boolean {
    switch (e.key) {
      case 'Escape':
        this.close();
        return true;
      case 'ArrowDown':
      case 'ArrowUp':
        client.send({ cmd: 'scroll', delta: e.key === 'ArrowUp' ? -1 : 1 });
        return true;
      case 'Enter':
        if (!e.repeat) {
          if (client.browser.selected) client.send({ cmd: 'explore_root_selected' });
          this.close();
        }
        return true;
    }
    // Typing goes back into the box (the keypress then lands there).
    if (e.key.length === 1 && this.input && document.activeElement !== this.input) this.input.focus();
    return false;
  }

  /** Close and bring the full library back; the server keeps the selection. */
  close() {
    if (!this.open) return;
    this.open = false;
    this.query = '';
    client.send({ cmd: 'browse', query: '' });
  }
}

export const search = new Search();
