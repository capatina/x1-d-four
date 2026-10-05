// Type-to-search in the tunnel: shared open/closed state and the query being typed.
import { client } from './client.svelte';

class Search {
  open = $state(false);
  query = $state('');

  /** Open with the first typed character and search right away. */
  start(first: string) {
    this.open = true;
    this.set(first);
  }

  set(query: string) {
    this.query = query;
    client.send({ cmd: 'browse', query });
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
