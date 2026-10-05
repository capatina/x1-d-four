import { fmtBpm, idToName } from '../lib/format';
import type { ExploreNode, Track } from '../lib/protocol';

/** Extra height an aimed label may grow upward (eyebrow, rule, display title). */
const AIM_EXTRA = 26;
/** Vertical stagger between neighbouring labels. */
const STAGGER = 60;
const MARGIN = 12;

type Item = {
  id: string;
  node: ExploreNode;
  el: HTMLButtonElement;
  title: HTMLElement;
  artist: HTMLElement;
  meta: HTMLElement;
  height: number;
  /** Screen x of the label's centre, from the last layout. */
  x: number;
};

export type Obstacle = { left: number; right: number; top: number; bottom: number };

/** Label width for a viewport width (six fit side by side down to 1024 px). */
export function labelWidth(width: number) {
  return Math.round(Math.min(220, width * 0.158));
}

/**
 * The six route labels. Text, `data-kind` and aim are written synchronously
 * when an `explore` message lands; screen positions only change on layout
 * (fixed slots, fixed camera). A new fan replaces the old one with a single
 * compositor animation each: old labels slide outward and fade, new ones rise
 * 8 px into place. Nothing here runs per frame.
 */
export class Labels {
  readonly items: Item[] = [];
  readonly #root: HTMLElement;
  readonly #track: (id: string) => Track | undefined;
  #hint = '';
  #aim: string | null = null;
  #width = 200;

  constructor(root: HTMLElement, track: (id: string) => Track | undefined) {
    this.#root = root;
    this.#track = track;
  }

  get aim() {
    return this.#aim;
  }

  /** A new fan (commit, scout, back, root, band): the old one leaves, the new one is there at once. */
  replace(nodes: readonly ExploreNode[], aim: string | null, motion: 'forward' | 'back' | 'swap', reduced: boolean, viewport: number) {
    for (const it of this.items) this.#leave(it.el, it.x < viewport / 2 ? -1 : 1, motion, reduced);
    this.items.length = 0;
    this.#aim = aim;
    for (const node of nodes) {
      const it = this.#create(node);
      this.items.push(it);
      this.#fill(it);
      this.#root.append(it.el);
      if (motion !== 'swap' || !reduced) {
        const rise = motion === 'back' ? '0 -8px' : '0 8px';
        it.el.animate(
          reduced
            ? [{ opacity: 0.4 }, { opacity: 1 }]
            : [
                { translate: rise, opacity: 0.85 },
                { translate: '0 0', opacity: 1 },
              ],
          { duration: reduced ? 150 : 180, easing: 'cubic-bezier(.2,.7,.3,1)' },
        );
      }
    }
    this.#measure();
  }

  /** The same fan with new contents (section changes, analysis, library metadata). */
  update(nodes: readonly ExploreNode[], aim: string | null) {
    this.#aim = aim;
    for (let i = 0; i < nodes.length && i < this.items.length; i++) {
      const it = this.items[i];
      if (it.id !== nodes[i].id) {
        it.id = nodes[i].id;
        it.el.dataset.id = it.id;
      }
      it.node = nodes[i];
      this.#fill(it);
    }
    this.#measure();
  }

  refresh() {
    for (const it of this.items) this.#fill(it);
    this.#measure();
  }

  setHint(text: string) {
    this.#hint = text;
    for (const it of this.items) if (it.id === this.#aim) this.#fill(it);
  }

  /** Aim: only the lit label changes, in place (it grows upward; nothing moves to the front). */
  setAim(aim: string | null) {
    if (aim === this.#aim) return;
    this.#aim = aim;
    for (const it of this.items) this.#kind(it);
  }

  /**
   * Place every label above its spire: x on the spire (clamped), neighbours
   * staggered 60 px, pushed below any header box above them, never into the
   * footer. Labels are bottom-anchored so an aimed one grows upward only.
   */
  layout(anchors: Float32Array, width: number, bottomLimit: number, obstacles: readonly Obstacle[]) {
    const w = (this.#width = labelWidth(width));
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const ax = anchors[i * 2],
        ay = anchors[i * 2 + 1];
      const x = Math.max(w / 2 + MARGIN, Math.min(width - w / 2 - MARGIN, ax));
      const reserve = it.height + (it.id === this.#aim ? 0 : AIM_EXTRA);
      let bottom = ay - 14 - (i % 2 === 0 && this.items.length > 1 ? STAGGER : 0);
      for (const ob of obstacles) {
        if (ob.left < x + w / 2 && ob.right > x - w / 2 && bottom - reserve < ob.bottom + 8) bottom = ob.bottom + 8 + reserve;
      }
      bottom = Math.max(92 + reserve, Math.min(bottomLimit, bottom));
      it.el.style.width = `${w}px`;
      it.el.style.setProperty('--stem', `${Math.max(10, Math.round(ay - bottom))}px`);
      it.el.style.transform = `translate(${Math.round(x)}px,${Math.round(bottom)}px) translate(-50%,-100%)`;
      it.x = x;
    }
  }

  clear() {
    for (const it of this.items) it.el.remove();
    this.items.length = 0;
  }

  #create(node: ExploreNode): Item {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'xl';
    el.dataset.id = node.id;
    el.style.width = `${this.#width}px`;
    const title = document.createElement('span');
    title.className = 'xl-t';
    const artist = document.createElement('span');
    artist.className = 'xl-a';
    const meta = document.createElement('span');
    meta.className = 'xl-m';
    el.append(title, artist, meta);
    return { id: node.id, node, el, title, artist, meta, height: 90, x: 0 };
  }

  #fill(it: Item) {
    const track = this.#track(it.id);
    const title = track?.title ?? idToName(it.id);
    const artist = track?.artist ?? 'Unknown artist';
    const bpm = fmtBpm(it.node.tempo ?? track?.bpm ?? null) || '—';
    const sim = Math.round(it.node.sim * 100);
    if (it.title.textContent !== title) it.title.textContent = title;
    if (it.artist.textContent !== artist) it.artist.textContent = artist;
    const meta = `${sim}% similar  ·  ${bpm} BPM`;
    if (it.meta.textContent !== meta) it.meta.textContent = meta;
    this.#kind(it);
  }

  #kind(it: Item) {
    const aimed = it.id === this.#aim;
    it.el.dataset.kind = aimed ? 'aimed' : 'child';
    it.el.setAttribute('aria-pressed', String(aimed));
    const track = this.#track(it.id);
    it.el.title = `${track?.title ?? idToName(it.id)} — ${track?.artist ?? 'Unknown artist'} · ${fmtBpm(it.node.tempo ?? track?.bpm ?? null) || '—'} BPM · ${Math.round(it.node.sim * 100)}% similar${aimed && this.#hint ? ` · ${this.#hint}` : ''}`;
  }

  /** Heights are read once per fill, together (one layout). */
  #measure() {
    for (const it of this.items) it.height = it.el.offsetHeight;
  }

  #leave(el: HTMLElement, dir: number, motion: 'forward' | 'back' | 'swap', reduced: boolean) {
    el.classList.add('xl-leaving');
    el.dataset.kind = 'leaving';
    el.removeAttribute('aria-pressed');
    el.tabIndex = -1;
    const dx = motion === 'back' ? -dir * 30 : dir * 60;
    const anim = el.animate(
      reduced
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            // The new fan reads first: the old one steps back at once, then slides away.
            { translate: '0 0', opacity: 0.4 },
            { translate: `${dx}px 0`, opacity: 0 },
          ],
      { duration: reduced ? 150 : 180, easing: 'cubic-bezier(.3,.5,.4,1)', fill: 'forwards' },
    );
    anim.onfinish = () => el.remove();
  }
}
