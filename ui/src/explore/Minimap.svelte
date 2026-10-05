<script lang="ts">
  import { client } from '../lib/client.svelte';
  import { idToName } from '../lib/format';
  import type { ExploreMsg } from '../lib/protocol';

  let { msg }: { msg: ExploreMsg } = $props();

  const R = 86;

  type Dot = { id: string; x: number; y: number; depth: number; onPath: boolean; isChild: boolean };
  type Edge = { x1: number; y1: number; x2: number; y2: number; onPath: boolean; sim: number };

  /** Radial tidy tree: root in the middle, one ring per depth, angle shared out by leaf count. */
  const layout = $derived.by(() => {
    const dots: Dot[] = [];
    const edges: Edge[] = [];
    const root = msg.root;
    if (!root) return { dots, edges, current: null as Dot | null, aim: null as Dot | null };

    const kids = new Map<string, string[]>();
    const sim = new Map<string, number>();
    const seen = new Set<string>([root]);
    for (const n of msg.nodes) {
      if (n.parent == null || seen.has(n.id)) continue;
      seen.add(n.id);
      sim.set(n.id, n.sim);
      kids.set(n.parent, [...(kids.get(n.parent) ?? []), n.id]);
    }
    const onPath = new Set(msg.path);
    const leaves = new Map<string, number>();
    let maxDepth = 1;
    const countLeaves = (id: string, depth: number): number => {
      maxDepth = Math.max(maxDepth, depth);
      const c = kids.get(id) ?? [];
      const n = c.length ? c.reduce((sum, k) => sum + countLeaves(k, depth + 1), 0) : 1;
      leaves.set(id, n);
      return n;
    };
    countLeaves(root, 0);
    const step = R / maxDepth;
    const currentChildren = new Set(kids.get(msg.current ?? '') ?? []);

    const place = (id: string, depth: number, a0: number, a1: number, px: number, py: number) => {
      const a = (a0 + a1) / 2;
      const r = depth * step;
      const x = depth === 0 ? 0 : Math.cos(a) * r;
      const y = depth === 0 ? 0 : Math.sin(a) * r;
      const dot: Dot = { id, x, y, depth, onPath: onPath.has(id), isChild: currentChildren.has(id) };
      dots.push(dot);
      if (depth > 0) edges.push({ x1: px, y1: py, x2: x, y2: y, onPath: dot.onPath, sim: sim.get(id) ?? 0.5 });
      const c = kids.get(id) ?? [];
      const total = leaves.get(id) ?? 1;
      let start = a0;
      for (const k of c) {
        const span = ((a1 - a0) * (leaves.get(k) ?? 1)) / total;
        place(k, depth + 1, start, start + span, x, y);
        start += span;
      }
    };
    place(root, 0, -Math.PI / 2, (3 * Math.PI) / 2, 0, 0);
    // Path on top.
    edges.sort((a, b) => Number(a.onPath) - Number(b.onPath));
    return {
      dots,
      edges,
      current: dots.find((d) => d.id === msg.current) ?? null,
      aim: dots.find((d) => d.id === msg.aim) ?? null,
    };
  });

  function name(id: string): string {
    const t = client.library.get(id);
    return t ? `${t.title}${t.artist ? ` — ${t.artist}` : ''}` : idToName(id);
  }

  function aim(id: string) {
    client.send({ cmd: 'explore_aim', id });
  }
</script>

<figure class="minimap" aria-label="Similarity tree">
  <svg viewBox="-100 -100 200 200" role="img" aria-label="Tree of {layout.dots.length} tracks, depth {msg.path.length - 1}">
    {#each [1, 2, 3] as ring (ring)}
      <circle class="guide" r={(R / 3) * ring} />
    {/each}
    {#each layout.edges as e, i (i)}
      <line
        x1={e.x1}
        y1={e.y1}
        x2={e.x2}
        y2={e.y2}
        class:path={e.onPath}
        stroke-width={e.onPath ? 2 : 0.6 + e.sim * 1.2}
        stroke-opacity={e.onPath ? 1 : 0.18 + e.sim * 0.4}
      />
    {/each}
    {#each layout.dots as d (d.id)}
      {#if d.isChild}
        <circle
          class="dot child"
          class:aimed={d.id === msg.aim}
          cx={d.x}
          cy={d.y}
          r={d.id === msg.aim ? 4.2 : 3}
          role="button"
          tabindex="-1"
          aria-label="Aim at {name(d.id)}"
          onclick={() => aim(d.id)}
          ondblclick={() => client.send({ cmd: 'explore_dive', id: d.id })}
          onkeydown={() => {}}><title>{name(d.id)}</title></circle
        >
      {:else}
        <circle class="dot" class:path={d.onPath} cx={d.x} cy={d.y} r={d.onPath ? 3.2 : d.depth === 0 ? 3.5 : 1.8}
          ><title>{name(d.id)}</title></circle
        >
      {/if}
    {/each}
    {#if layout.current}
      <circle class="current" cx={layout.current.x} cy={layout.current.y} r="7" />
    {/if}
    {#if layout.aim}
      <circle class="aim-halo" cx={layout.aim.x} cy={layout.aim.y} r="8" />
    {/if}
  </svg>
  <figcaption>
    <span>Tree</span>
    <b>{layout.dots.length}</b>
    <span>· depth</span>
    <b>{Math.max(0, msg.path.length - 1)}</b>
  </figcaption>
</figure>

<style>
  .minimap {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 8px 8px 6px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: var(--radius);
    background: rgba(6, 7, 10, 0.55);
    backdrop-filter: blur(6px);
  }
  svg {
    display: block;
    width: 184px;
    height: 184px;
    overflow: visible;
  }
  .guide {
    fill: none;
    stroke: rgba(255, 255, 255, 0.05);
    stroke-width: 0.6;
  }
  line {
    stroke: var(--band);
    stroke-linecap: round;
  }
  line.path {
    stroke: #fff;
    filter: drop-shadow(0 0 2px var(--band));
  }
  .dot {
    fill: color-mix(in srgb, var(--band) 55%, #0b0d10);
  }
  .dot.path {
    fill: #fff;
  }
  .dot.child {
    fill: var(--band);
    cursor: pointer;
  }
  .dot.child:hover {
    fill: #fff;
  }
  .dot.aimed {
    fill: #fff;
  }
  .current {
    fill: none;
    stroke: #fff;
    stroke-width: 1.4;
    stroke-opacity: 0.85;
  }
  .aim-halo {
    fill: none;
    stroke: var(--band);
    stroke-width: 1.6;
    transform-box: fill-box;
    transform-origin: center;
    animation: halo 1.6s ease-in-out infinite;
    pointer-events: none;
  }
  @keyframes halo {
    0%,
    100% {
      stroke-opacity: 0.9;
      transform: scale(1);
    }
    50% {
      stroke-opacity: 0.35;
      transform: scale(1.25);
    }
  }
  figcaption {
    display: flex;
    gap: 4px;
    align-items: baseline;
    justify-content: center;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  figcaption b {
    font: 650 11px var(--font-mono);
    color: var(--text-2);
  }
  @media (prefers-reduced-motion: reduce) {
    .aim-halo {
      animation: none;
    }
  }
</style>
