import { client } from '../lib/client.svelte';
import type { ExploreEngine } from './engine';

/**
 * Local inputs (keys, minimap clicks) light the aim in the same event, then
 * tell the server; its `explore` echo reconciles. The engine registers itself.
 */
export const local = {
  engine: null as ExploreEngine | null,
  aimBy(delta: number) {
    this.engine?.aimLocal(delta);
    client.send({ cmd: 'explore_aim', delta });
  },
  aimAt(id: string) {
    this.engine?.aimLocal(id);
    client.send({ cmd: 'explore_aim', id });
  },
};
