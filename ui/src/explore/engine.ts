import * as THREE from 'three';
import { client } from '../lib/client.svelte';
import { DECK_COLORS } from '../lib/decks';
import type { ExploreMsg, ExploreNode, Track } from '../lib/protocol';
import type { VizFrame } from '../lib/viz';
import { waves } from '../lib/waves';
import {
  CAM_H,
  columnGeometry,
  GATE_R,
  GATE_Y,
  gateGeometries,
  glowMaterial,
  GRAND_R,
  GRAND_SEGMENTS,
  GRAND_Y,
  hashString,
  hexInto,
  LOOK_D,
  LOOK_Y,
  makeFloor,
  makePost,
  makeRails,
  makeShared,
  makeSky,
  makeStreaks,
  MAX_CHILDREN,
  MAX_GRANDS,
  padGeometry,
  PATH_SAMPLES,
  RAIL_SEGMENTS,
  rotY,
  scrollerTexture,
  SPLIT_Z,
  TRUNK_FROM,
  TRUNK_SEGMENTS,
  TRUNK_SLOT,
  wireMaterial,
  type Shared,
  type TreeUniforms,
} from './demo';
import { Labels, type Obstacle } from './labels';
import { BAND_PALETTE } from './palette';

export type EngineStats = {
  fps: number;
  calls: number;
  triangles: number;
  dpr: number;
  /** CPU time of the world frame (JS + draw submission), ms. */
  frameMs: number;
  /** GPU time of the world, ms (only with ?qa, from timer queries). */
  gpuMs: number;
  course: number;
  speed: number;
};
export type EngineOptions = {
  canvas: HTMLCanvasElement;
  labels: HTMLElement;
  /** Edge glow that flashes as a gate passes overhead (CSS opacity, compositor only). */
  gate?: HTMLElement | null;
  viz: VizFrame;
  track: (id: string) => Track | undefined;
  onAim: (id: string) => void;
  onDive: (id: string) => void;
  onAimDelta: (delta: number) => void;
  reducedMotion: boolean;
  onStats?: (stats: EngineStats) => void;
};

const FOV = 54;
/** Aim: the head of light runs down the branch in 160 ms; the paths beyond sprout over 220 ms after 60 ms. */
const HEAD_MS = 160;
const SPROUT_DELAY = 60;
const SPROUT_MS = 220;
const STUB = 0.22;
const AIM_FALL_MS = 140;
/** The flight down a taken branch, and back up the trunk. */
const FLIGHT_MS = 720;
const BACK_MS = 480;
const BACK_D = 55;
/** A cut (new root, band, re-shuffle): the frame tears for 220 ms. */
const CUT_MS = 220;
const MIST_MS = 300;

type Gate = {
  outer: THREE.Mesh;
  inner: THREE.Mesh | null;
  pad: THREE.Mesh | null;
  column: THREE.Mesh | null;
  outerU: { uLit: { value: number }; uSim: { value: number } };
  innerU: { uLit: { value: number }; uSim: { value: number } } | null;
  padU: { uLit: { value: number } } | null;
  columnU: { uLit: { value: number } } | null;
  spin: number;
  tilt: number;
};

/**
 * One fan of paths: the trunk under the camera splits into a branch per child,
 * each ending at a wireframe gate; the aimed gate sprouts its own branches
 * (the grandchildren). Built in its own frame, where the camera rests at the
 * origin looking down −z.
 */
class Tree {
  readonly group = new THREE.Group();
  readonly u: TreeUniforms = {
    uLit: { value: new Float32Array(8) },
    uHead: { value: new Float32Array(8).fill(-9) },
    uGrandLit: { value: new Float32Array(6) },
    uGrandGrow: { value: new Float32Array(6) },
    uAlpha: { value: 1 },
  };
  readonly rails: ReturnType<typeof makeRails>;
  readonly gates: Gate[] = [];
  readonly grands: Gate[] = [];
  readonly slotX = new Float32Array(MAX_CHILDREN);
  readonly slotZ = new Float32Array(MAX_CHILDREN);
  readonly heading = new Float32Array(MAX_CHILDREN);
  readonly sim = new Float32Array(MAX_CHILDREN);
  /** Camera flight per child: trunk then branch, (x, z) pairs. */
  readonly paths = new Float32Array(MAX_CHILDREN * PATH_SAMPLES * 2);
  readonly grandParent = new Int8Array(MAX_GRANDS);
  readonly grandSim = new Float32Array(MAX_GRANDS);
  count = 0;
  grandCount = 0;
  readonly headT0 = new Float64Array(MAX_CHILDREN).fill(-1e9);
  readonly sproutT0 = new Float64Array(MAX_CHILDREN).fill(-1e9);
  readonly sproutFrom = new Float32Array(MAX_CHILDREN);

  constructor(s: Shared, geos: THREE.BufferGeometry[], pad: THREE.BufferGeometry, column: THREE.BufferGeometry) {
    this.rails = makeRails(s, this.u);
    this.group.add(this.rails.mesh);
    const a = this.u.uAlpha;
    for (let i = 0; i < MAX_CHILDREN; i++) {
      const om = wireMaterial(s, a),
        im = wireMaterial(s, a),
        pm = glowMaterial(s, a, false),
        cm = glowMaterial(s, a, true);
      im.uniforms.uWidth.value = 1.1;
      const g: Gate = {
        outer: new THREE.Mesh(geos[0], om),
        inner: new THREE.Mesh(geos[1], im),
        pad: new THREE.Mesh(pad, pm),
        column: new THREE.Mesh(column, cm),
        outerU: om.uniforms as Gate['outerU'],
        innerU: im.uniforms as Gate['outerU'],
        padU: pm.uniforms as { uLit: { value: number } },
        columnU: cm.uniforms as { uLit: { value: number } },
        spin: 0,
        tilt: 0,
      };
      for (const m of [g.outer, g.inner!, g.pad!, g.column!]) {
        m.frustumCulled = false;
        m.visible = false;
        this.group.add(m);
      }
      this.gates.push(g);
    }
    for (let i = 0; i < MAX_GRANDS; i++) {
      const om = wireMaterial(s, a);
      om.uniforms.uWidth.value = 1.1;
      const g: Gate = { outer: new THREE.Mesh(geos[0], om), inner: null, pad: null, column: null, outerU: om.uniforms as Gate['outerU'], innerU: null, padU: null, columnU: null, spin: 0, tilt: 0 };
      g.outer.frustumCulled = false;
      g.outer.visible = false;
      this.group.add(g.outer);
      this.grands.push(g);
    }
  }

  dispose() {
    this.rails.mesh.geometry.dispose();
    (this.rails.mesh.material as THREE.Material).dispose();
    for (const g of [...this.gates, ...this.grands])
      for (const m of [g.outer, g.inner, g.pad, g.column]) if (m) (m.material as THREE.Material).dispose();
  }
}

/**
 * The Datastream: a demoscene flight over an endless neon grid. The trunk you
 * ride splits ahead into one light rail per similar track, each ending at a
 * spinning wireframe gate; aiming lights a branch and sprouts the paths beyond
 * its gate; loading the aimed track flies you down that branch, through the
 * gate, onto its own forks. State changes land in the message frame
 * (`setExplore` is synchronous); flourish decays from there. The frame loop
 * allocates nothing.
 */
export class ExploreEngine {
  readonly #o: EngineOptions;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(FOV, 1, 0.2, 1200);
  /** Resting camera in a tree's own frame: projects the labels' anchors. */
  readonly #rest = new THREE.PerspectiveCamera(FOV, 1, 0.2, 1200);
  readonly #shared = makeShared();
  readonly #post = makePost();
  readonly #sky: THREE.Mesh;
  readonly #floor: THREE.Mesh;
  readonly #streaks: THREE.LineSegments;
  readonly #trees: [Tree, Tree];
  #tree: Tree;
  #old: Tree;
  readonly #scroller = scrollerTexture();
  #scrollText = '';
  readonly #labels: Labels;
  readonly #resize: ResizeObserver;
  readonly #point = new THREE.Vector3();
  readonly #v2 = { x: 0, y: 0 };
  readonly #stats: EngineStats = { fps: 0, calls: 0, triangles: 0, dpr: 1, frameMs: 0, gpuMs: 0, course: 0, speed: 0 };

  // Render targets
  #rtScene!: THREE.WebGLRenderTarget;
  #rtA!: THREE.WebGLRenderTarget;
  #rtB!: THREE.WebGLRenderTarget;
  #rtC!: THREE.WebGLRenderTarget;
  #rtD!: THREE.WebGLRenderTarget;
  #rtType: THREE.TextureDataType = THREE.HalfFloatType;

  // Explore state
  #msg: ExploreMsg | null = null;
  #children: ExploreNode[] = [];
  #aimSlot = -1;
  #localAim: string | null = null;
  #localAimAt = -1e9;
  readonly #anchors = new Float32Array(MAX_CHILDREN * 2);
  readonly #gates = new Float32Array(MAX_CHILDREN * 2);
  #obstacles: Obstacle[] = [];

  // Travel and the frame of the grid (rotation, offset) across rebases
  #course = 0;
  #flow = 0;
  #speedF = 0;
  #speed = 0;
  #playing = false;
  #rampFrom = 0;
  #rampT0 = -1e9;
  #energyS = 0;
  #gridYaw = 0;
  readonly #gridOff = new THREE.Vector2();

  // The flight
  #flight: { t0: number; dur: number; back: boolean; slot: number; x: number; z: number; yaw: number } | null = null;
  readonly #flightPath = new Float32Array(PATH_SAMPLES * 2);
  #cutT0 = -1e9;
  #passFlash = 0;
  #mistFrom = 0;
  #mistTo = 0;
  #mistT0 = -1e9;
  #mist = 0;

  // Band colour
  readonly #accentFrom = new THREE.Vector3();
  readonly #accentTo = new THREE.Vector3();
  readonly #hotFrom = new THREE.Vector3();
  readonly #hotTo = new THREE.Vector3();
  #bandT0 = -1e9;
  #accentHex = BAND_PALETTE.low.css;

  // Music
  readonly #levels = new Float32Array(3);
  #onsets = 0;
  #vigil = 0;
  #breakdown = 0;
  #breakdownEnd = -1e9;
  #lowBelowAt = -1e9;
  #dropT0 = -1e9;
  #lastDrop = -1e9;

  // Decks: their cards (for the lasers)
  readonly #deckX = new Float32Array(4);
  #deckBase = 0;
  readonly #deckLevel = new Float32Array(4);

  // Time, frame pacing
  #raf = 0;
  #last = 0;
  #time = 0;
  #width = 1;
  #height = 1;
  #bottomInset = 300;
  #dpr = 1;
  #maxDpr = 1;
  #reduced = false;
  #disposed = false;
  #statsAt = 0;
  #frameEma = 16.67;
  #drawEma = 0;
  #slow = 0;
  #adaptive = true;
  #wheel = 0;
  #wheelAt = 0;

  constructor(o: EngineOptions) {
    this.#o = o;
    this.#reduced = o.reducedMotion;
    this.#labels = new Labels(o.labels, o.track);
    const params = new URLSearchParams(location.search);
    this.#renderer = new THREE.WebGLRenderer({ canvas: o.canvas, antialias: false, alpha: false, stencil: false, depth: true, powerPreference: 'high-performance' });
    this.#renderer.autoClear = true;
    this.#renderer.setClearColor(0x000000, 1);
    const gl = this.#renderer.getContext();
    if (!gl.getExtension('EXT_color_buffer_half_float') && !gl.getExtension('EXT_color_buffer_float')) this.#rtType = THREE.UnsignedByteType;
    this.#maxDpr = Math.min(1.5, Math.max(0.75, Number(params.get('dpr')) || window.devicePixelRatio || 1));
    this.#dpr = this.#maxDpr;
    this.#adaptive = params.get('adaptive') !== '0';
    const s = this.#shared;
    s.uScroller.value = this.#scroller.tex;
    for (let i = 0; i < 4; i++) hexInto(DECK_COLORS[i], s.uDeckColor.value, i * 3);
    this.#post.composite.uniforms.uDeckColor.value.set(s.uDeckColor.value);

    const geos = gateGeometries();
    const pad = padGeometry(),
      column = columnGeometry();
    this.#trees = [new Tree(s, geos, pad, column), new Tree(s, geos, pad, column)];
    this.#tree = this.#trees[0];
    this.#old = this.#trees[1];
    this.#old.group.visible = false;
    this.#geos = geos;
    this.#sky = makeSky(s);
    this.#floor = makeFloor(s);
    this.#streaks = makeStreaks(s);
    this.#camera.add(this.#streaks);
    this.#renderer.sortObjects = true;
    this.#scene.add(this.#sky, this.#floor, this.#trees[0].group, this.#trees[1].group, this.#camera);

    this.#setBand('low', true);
    this.#rest.position.set(0, CAM_H, 0);
    this.#rest.lookAt(0, LOOK_Y, -LOOK_D);
    this.#resize = new ResizeObserver(this.#onResize);
    this.#resize.observe(o.canvas.parentElement ?? o.canvas);
    this.#onResize();
    o.canvas.addEventListener('click', this.#click);
    o.canvas.addEventListener('dblclick', this.#doubleClick);
    o.canvas.addEventListener('wheel', this.#onWheel, { passive: false });
    o.labels.addEventListener('click', this.#labelClick);
    o.labels.addEventListener('dblclick', this.#labelDoubleClick);
    document.addEventListener('visibilitychange', this.#visibility);
    this.#start();
  }
  readonly #geos: THREE.BufferGeometry[];

  // ---------------------------------------------------------------------------
  // Explore messages: everything that changes, changes here, synchronously.

  setExplore(msg: ExploreMsg | null) {
    if (msg === this.#msg) return;
    const prev = this.#msg;
    this.#msg = msg;
    const now = this.#now();
    if (!msg || !msg.current) {
      this.#children = [];
      this.#labels.clear();
      this.#aimSlot = -1;
      this.#endFlight();
      this.#tree.count = 0;
      this.#build(this.#tree, null, now);
      return;
    }
    const children = msg.nodes.filter((n) => n.parent === msg.current).slice(0, MAX_CHILDREN);
    const moved = !!prev && prev.current !== msg.current;
    const banded = !!prev && prev.band !== msg.band;
    if (banded || !prev) this.#setBand(msg.band, !prev);
    // Commit and scout fly down the branch that was aimed: its slot is where current came from.
    const forward = moved && (msg.reason === 'commit' || msg.reason === 'dive');
    const taken = forward ? this.#children.findIndex((c) => c.id === msg.current) : -1;
    const fresh = !prev || moved || banded || children.length !== this.#children.length;

    let aim = msg.aim;
    if (this.#localAim && now - this.#localAimAt < 350 && msg.reason === 'aim' && !fresh) aim = this.#localAim;
    else this.#localAim = null;

    if (fresh) {
      this.#endFlight();
      const from = this.#tree;
      this.#children = children;
      if (!this.#reduced && taken >= 0) this.#fly(from, taken, false, msg, now);
      else if (!this.#reduced && moved && msg.reason === 'back') this.#fly(from, -1, true, msg, now);
      else {
        this.#build(this.#tree, msg, now);
        if (prev && !this.#reduced) this.#cutT0 = now;
      }
      this.#labels.replace(children, aim, msg.reason === 'back' ? 'back' : moved ? 'forward' : 'swap', this.#reduced, this.#width);
      this.#project();
      this.#layoutLabels();
      this.#aimSlot = -1;
    } else {
      this.#children = children;
      this.#build(this.#tree, msg, now, true);
      this.#labels.update(children, aim);
      this.#project();
      this.#layoutLabels();
    }
    this.#aim(children.findIndex((n) => n.id === aim), now, !fresh);
    this.#writeScroller();
    if (this.#qa) this.#qaExpect(msg.reason, client.exploreAt, aim, children.length);
  }

  /** Scouting ahead (dives since the last load): the signal beyond is weak. */
  setScouting(depth: number) {
    const target = depth > 0 ? 1 : 0;
    if (target === this.#mistTo) return;
    this.#mistFrom = this.#mist;
    this.#mistTo = target;
    this.#mistT0 = this.#reduced ? -1e9 : this.#now();
  }

  /** The deck cards' centres and the strip's top (viewport px): the decks' lasers rise from there. */
  setDecks(xs: ArrayLike<number>, baseY: number) {
    for (let i = 0; i < 4; i++) this.#deckX[i] = xs[i] ?? 0;
    this.#deckBase = baseY;
  }

  /** Aim from a local input (keys, wheel, click): lit in this event, reconciled by the server's echo. */
  aimLocal(target: number | string) {
    const n = this.#children.length;
    if (!n) return;
    let slot: number;
    if (typeof target === 'string') slot = this.#children.findIndex((c) => c.id === target);
    else slot = ((((this.#aimSlot < 0 ? 0 : this.#aimSlot) + target) % n) + n) % n;
    if (slot < 0) return;
    const now = this.#now();
    this.#localAim = this.#children[slot].id;
    this.#localAimAt = now;
    this.#aim(slot, now, true);
    if (this.#qa) this.#qaExpect('local-aim', performance.now(), this.#localAim, n);
  }

  setBottomInset(pixels: number) {
    if (pixels === this.#bottomInset) return;
    this.#bottomInset = pixels;
    this.#layoutLabels();
  }
  setObstacles(rects: Obstacle[]) {
    this.#obstacles = rects;
    this.#layoutLabels();
  }
  setHint(text: string) {
    this.#labels.setHint(text);
  }
  setReducedMotion(reduced: boolean) {
    this.#reduced = reduced;
    if (reduced) this.#endFlight();
  }
  refreshLabels() {
    this.#labels.refresh();
    this.#layoutLabels();
    this.#writeScroller();
  }

  /** Frame 0: the branch is lit and its head of light starts down it; the old aim decays from where it is. */
  #aim(slot: number, now: number, flourish: boolean) {
    const prev = this.#aimSlot;
    this.#aimSlot = slot;
    this.#labels.setAim(slot >= 0 ? this.#children[slot].id : null);
    if (slot === prev) return;
    const t = this.#tree;
    if (slot >= 0) {
      t.u.uLit.value[slot] = 1;
      t.headT0[slot] = this.#reduced ? -1e9 : now;
      t.sproutFrom[slot] = t.u.uGrandGrow.value[slot];
      t.sproutT0[slot] = this.#reduced ? -1e9 : now;
    }
    if (prev >= 0 && prev < t.count) {
      t.sproutFrom[prev] = t.u.uGrandGrow.value[prev];
      t.sproutT0[prev] = this.#reduced ? -1e9 : now;
    }
    void flourish;
  }

  #setBand(band: 'low' | 'mid' | 'high', instant: boolean) {
    const s = this.#shared;
    const pal = BAND_PALETTE[band];
    this.#accentHex = pal.css;
    this.#accentFrom.copy(s.uAccent.value);
    this.#hotFrom.copy(s.uHot.value);
    hexVec(pal.css, this.#accentTo);
    hexVec(pal.hot, this.#hotTo);
    this.#hotTo.multiplyScalar(0.55);
    this.#bandT0 = instant ? -1e9 : this.#now();
    if (instant) {
      s.uAccent.value.copy(this.#accentTo);
      s.uHot.value.copy(this.#hotTo);
    }
  }

  #writeScroller() {
    const msg = this.#msg;
    let text = 'X1 D·FOUR  ✦  LOAD A TRACK TO ENTER THE DATASTREAM';
    if (msg?.current) {
      const t = this.#o.track(msg.current);
      const n = this.#children.length;
      const pal = BAND_PALETTE[msg.band];
      text = `NOW AT ${t?.title ?? msg.current}${t?.artist ? ` — ${t.artist}` : ''}  ✦  ${n} ${n === 1 ? 'PATH' : 'PATHS'} AHEAD  ✦  ${pal.place}  ✦  X1 D·FOUR`;
    }
    if (text === this.#scrollText) return;
    this.#scrollText = text;
    this.#scroller.draw(text, this.#accentHex);
  }

  // ---------------------------------------------------------------------------
  // Layout and building a tree: slots on a fan, branch curves, grand paths.

  /** Slot positions for `n` children in a tree's own frame: a fan across the view, centre ones farther. */
  #slot(i: number, n: number, out: { x: number; y: number }) {
    const aspect = this.#width / this.#height;
    const tanH = Math.tan((FOV * Math.PI) / 360) * aspect;
    const f = n === 1 ? 0.5 : 0.08 + (i * 0.84) / (n - 1);
    const d = 40 + (1 - Math.abs(f - 0.5) * 2) * 26;
    out.x = (f - 0.5) * 2 * d * tanH * 0.84;
    out.y = -d;
    return out;
  }

  /** (Re)write a tree's rails and gates for `msg`. Keeps the aim's light when `keep`. */
  #build(t: Tree, msg: ExploreMsg | null, now: number, keep = false) {
    const children = msg ? this.#children : [];
    const n = children.length;
    t.count = n;
    if (!keep) {
      t.u.uLit.value.fill(0);
      t.u.uHead.value.fill(-9);
      t.u.uGrandGrow.value.fill(0);
      t.u.uGrandLit.value.fill(0);
      t.headT0.fill(-1e9);
      t.sproutT0.fill(-1e9);
      t.sproutFrom.fill(0);
    }
    const r = t.rails;
    let seg = 0;
    if (n > 0) seg = strip(r, seg, TRUNK_SLOT, TRUNK_SEGMENTS, 0.34, (u, o) => ((o.x = 0), (o.y = TRUNK_FROM + (SPLIT_Z - TRUNK_FROM) * u)));
    const p = this.#v2;
    for (let i = 0; i < n; i++) {
      this.#slot(i, n, p);
      const gx = p.x,
        gz = p.y;
      t.slotX[i] = gx;
      t.slotZ[i] = gz;
      t.sim[i] = children[i].sim;
      // Leave the split straight ahead, arrive heading away from the split.
      const dx = gx,
        dz = gz - SPLIT_Z;
      const len = Math.hypot(dx, dz) || 1;
      const tx = dx / len,
        tz = dz / len;
      t.heading[i] = Math.atan2(-tx, -tz);
      const ax = 0,
        az = SPLIT_Z,
        bx = 0,
        bz = SPLIT_Z - len * 0.38,
        cx = gx - tx * len * 0.38,
        cz = gz - tz * len * 0.38;
      const curve = (u: number, o: { x: number; y: number }) => bezier(ax, az, bx, bz, cx, cz, gx, gz, u, o);
      seg = strip(r, seg, i, RAIL_SEGMENTS, 0.26, curve);
      // The flight: 8 samples down the trunk from the camera, then the branch.
      const P = t.paths,
        base = i * PATH_SAMPLES * 2;
      const q = { x: 0, y: 0 };
      for (let k = 0; k < PATH_SAMPLES; k++) {
        if (k < 8) {
          P[base + k * 2] = 0;
          P[base + k * 2 + 1] = (SPLIT_Z * k) / 8;
        } else {
          curve((k - 8) / (PATH_SAMPLES - 9), q);
          P[base + k * 2] = q.x;
          P[base + k * 2 + 1] = q.y;
        }
      }
      // Gate, its inner solid, landing pad and light column.
      const g = t.gates[i];
      const id = children[i].id;
      const kind = Math.floor(hashString(`${id}#k`) * 4) % 4;
      g.outer.geometry = this.#geos[kind];
      g.inner!.geometry = this.#geos[(kind + 1 + Math.floor(hashString(`${id}#i`) * 3)) % 4];
      const size = GATE_R * (0.8 + 0.4 * children[i].sim);
      g.outer.position.set(gx, GATE_Y, gz);
      g.outer.scale.setScalar(size);
      g.inner!.position.set(gx, GATE_Y, gz);
      g.inner!.scale.setScalar(size * 0.42);
      g.pad!.position.set(gx, 0.05, gz);
      g.column!.position.set(gx, 0, gz);
      g.spin = hashString(`${id}#s`) * Math.PI * 2;
      g.tilt = (hashString(`${id}#t`) - 0.5) * 0.9;
      g.outerU.uSim.value = children[i].sim;
      g.innerU!.uSim.value = children[i].sim;
      g.outer.visible = g.inner!.visible = g.pad!.visible = g.column!.visible = true;
    }
    for (let i = n; i < MAX_CHILDREN; i++) {
      const g = t.gates[i];
      g.outer.visible = g.inner!.visible = g.pad!.visible = g.column!.visible = false;
    }
    // Grand paths: from each gate onward, heading on from the branch, fanned a little.
    let k = 0;
    for (let i = 0; i < n && msg; i++) {
      const grands: ExploreNode[] = [];
      for (const node of msg.nodes) if (node.parent === children[i].id && grands.length < 4) grands.push(node);
      const gx = t.slotX[i],
        gz = t.slotZ[i],
        hd = t.heading[i];
      const fx = -Math.sin(hd),
        fz = -Math.cos(hd);
      for (let j = 0; j < grands.length && k < MAX_GRANDS; j++, k++) {
        const id = grands[j].id;
        const lat = (j - (grands.length - 1) / 2) * 11 + (hashString(`${id}#x`) - 0.5) * 3;
        const fwd = 18 + hashString(`${id}#z`) * 14;
        rotY(lat, -fwd, hd, p);
        const ex = gx + p.x,
          ez = gz + p.y;
        const len = Math.hypot(ex - gx, ez - gz);
        const ux = (ex - gx) / len,
          uz = (ez - gz) / len;
        seg = strip(r, seg, 8 + i, GRAND_SEGMENTS, 0.2, (u, o) =>
          bezier(gx, gz, gx + fx * len * 0.4, gz + fz * len * 0.4, ex - ux * len * 0.3, ez - uz * len * 0.3, ex, ez, u, o),
        );
        const g = t.grands[k];
        g.outer.geometry = this.#geos[Math.floor(hashString(`${id}#k`) * 3) % 3];
        g.outer.position.set(ex, GRAND_Y, ez);
        g.spin = hashString(`${id}#s`) * Math.PI * 2;
        g.tilt = (hashString(`${id}#t`) - 0.5) * 0.9;
        g.outerU.uSim.value = grands[j].sim;
        g.outer.visible = true;
        t.grandParent[k] = i;
        t.grandSim[k] = grands[j].sim;
      }
    }
    t.grandCount = k;
    for (let j = k; j < MAX_GRANDS; j++) t.grands[j].outer.visible = false;
    r.mesh.geometry.setDrawRange(0, seg * 6);
    r.aPos.needsUpdate = true;
    r.aRail.needsUpdate = true;
    void now;
  }

  /** Screen anchors of the gate tops and centres, from the resting camera (labels, picking). */
  #project() {
    this.#rest.aspect = this.#width / this.#height;
    this.#rest.updateProjectionMatrix();
    this.#rest.updateMatrixWorld();
    const t = this.#tree;
    for (let i = 0; i < t.count; i++) {
      const top = GATE_Y + GATE_R * (0.8 + 0.4 * t.sim[i]) * 1.15;
      this.#point.set(t.slotX[i], top, t.slotZ[i]).project(this.#rest);
      this.#anchors[i * 2] = (this.#point.x * 0.5 + 0.5) * this.#width;
      this.#anchors[i * 2 + 1] = (-this.#point.y * 0.5 + 0.5) * this.#height;
      this.#point.set(t.slotX[i], GATE_Y, t.slotZ[i]).project(this.#rest);
      this.#gates[i * 2] = (this.#point.x * 0.5 + 0.5) * this.#width;
      this.#gates[i * 2 + 1] = (-this.#point.y * 0.5 + 0.5) * this.#height;
    }
    this.#point.set(0, 0, -5000).project(this.#rest);
    this.#post.composite.uniforms.uVanish.value.set(this.#point.x * 0.5 + 0.5, this.#point.y * 0.5 + 0.5);
  }

  #layoutLabels() {
    if (!this.#labels.items.length) return;
    this.#labels.layout(this.#anchors, this.#width, this.#height - this.#bottomInset - 16, this.#obstacles);
  }

  // ---------------------------------------------------------------------------
  // The flight: down the taken branch, through its gate, onto the new forks.

  /**
   * The new fan is built at once, in a frame that stands on the taken gate
   * (forward) or back down the trunk (back); the camera flies there along the
   * branch, and the old fan fades behind it. On arrival the world is rebased
   * so the new fan's frame is the world again.
   */
  #fly(from: Tree, slot: number, back: boolean, msg: ExploreMsg, now: number) {
    const to = from === this.#trees[0] ? this.#trees[1] : this.#trees[0];
    this.#build(to, msg, now);
    let x = 0,
      z = BACK_D,
      yaw = 0;
    if (!back) {
      x = from.slotX[slot];
      z = from.slotZ[slot];
      yaw = from.heading[slot];
      this.#flightPath.set(from.paths.subarray(slot * PATH_SAMPLES * 2, (slot + 1) * PATH_SAMPLES * 2));
      // The taken branch burns while the others go dark.
      from.u.uLit.value.fill(0);
      from.u.uLit.value[slot] = 1.4;
      from.u.uLit.value[TRUNK_SLOT] = 1;
      from.u.uGrandGrow.value.fill(0);
    }
    to.group.position.set(x, 0, z);
    to.group.rotation.set(0, yaw, 0);
    to.group.visible = true;
    to.u.uAlpha.value = 0;
    from.u.uAlpha.value = 1;
    this.#old = from;
    this.#tree = to;
    this.#flight = { t0: now, dur: back ? BACK_MS : FLIGHT_MS, back, slot, x, z, yaw };
    this.#o.gate?.animate(
      [
        { opacity: 0, offset: 0 },
        { opacity: 0, offset: back ? 0.2 : 0.78 },
        { opacity: 0.55, offset: back ? 0.35 : 0.9 },
        { opacity: 0, offset: 1 },
      ],
      { duration: back ? BACK_MS : FLIGHT_MS + 120, easing: 'linear' },
    );
  }

  /** Land at once (a new message mid-flight, or reduced motion): rebase onto the new frame. */
  #endFlight() {
    const f = this.#flight;
    if (!f) return;
    this.#flight = null;
    // The grid keeps its place in the world: fold the new frame's transform into it.
    rotY(f.x, f.z, this.#gridYaw, this.#v2);
    this.#gridOff.x += this.#v2.x;
    this.#gridOff.y += this.#v2.y;
    this.#gridYaw += f.yaw;
    this.#tree.group.position.set(0, 0, 0);
    this.#tree.group.rotation.set(0, 0, 0);
    this.#tree.u.uAlpha.value = 1;
    this.#old.group.visible = false;
  }

  /** Camera along the flight; returns false when it has landed. */
  #flightFrame(now: number) {
    const f = this.#flight;
    if (!f) return false;
    const x = Math.min(1, (now - f.t0) / f.dur);
    if (x >= 1) {
      this.#endFlight();
      return false;
    }
    // Fast out of the trunk, easing into the new fan.
    const u = x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    const cam = this.#camera.position;
    const look = this.#point;
    if (f.back) {
      cam.set(0, CAM_H + Math.sin(Math.PI * u) * 2.5, f.z * u);
      look.set(0, LOOK_Y, f.z * u - LOOK_D);
      this.#passFlash = 0;
    } else {
      const P = this.#flightPath;
      const at = u * (PATH_SAMPLES - 1);
      const k = Math.min(PATH_SAMPLES - 2, Math.floor(at));
      const w = at - k;
      const px = P[k * 2] + (P[k * 2 + 2] - P[k * 2]) * w,
        pz = P[k * 2 + 1] + (P[k * 2 + 3] - P[k * 2 + 1]) * w;
      // Dip through the gate near the end, rising back to riding height on the far side.
      const dip = Math.sin(Math.PI * Math.max(0, Math.min(1, (u - 0.55) / 0.45)));
      cam.set(px, CAM_H + (GATE_Y + 0.2 - CAM_H) * dip, pz);
      // Look down the branch, then settle onto the new fan's own line of sight.
      const ahead = Math.min(PATH_SAMPLES - 1, k + 6);
      const hx = P[ahead * 2],
        hz = P[ahead * 2 + 1];
      rotY(0, -LOOK_D, f.yaw, this.#v2);
      const endX = f.x + this.#v2.x,
        endZ = f.z + this.#v2.y;
      let ax = hx - px,
        az = hz - pz;
      const al = Math.hypot(ax, az) || 1;
      ax = px + (ax / al) * LOOK_D;
      az = pz + (az / al) * LOOK_D;
      const settle = smoothstep(0.62, 1, u);
      look.set(ax + (endX - ax) * settle, LOOK_Y - 1.2 * (1 - settle), az + (endZ - az) * settle);
      this.#passFlash = Math.exp(-Math.abs(u - 0.93) * 30) * 0.3;
    }
    this.#camera.lookAt(look);
    // Fade the old fan out behind, the new one in ahead.
    this.#tree.u.uAlpha.value = smoothstep(0.05, 0.7, u);
    this.#old.u.uAlpha.value = 1 - smoothstep(0.6, 1, u);
    return true;
  }

  // ---------------------------------------------------------------------------
  // The frame: tempo-clocked travel, decays, uniforms, one render plus post.

  #start() {
    if (this.#disposed || document.hidden) return;
    this.#last = performance.now();
    this.#raf = requestAnimationFrame(this.#frame);
  }
  #visibility = () => {
    cancelAnimationFrame(this.#raf);
    if (!document.hidden) this.#start();
  };

  #frame = (raf: number) => {
    if (this.#disposed) return;
    this.#raf = requestAnimationFrame(this.#frame);
    const begin = performance.now();
    const qa = this.#qa;
    if (qa) this.#qaFrame(raf, begin);
    if (qa?.frozen) {
      this.#last = raf;
      this.#tick(qa.clock, 0, 0, begin);
      return;
    }
    const raw = raf - this.#last;
    const dt = Math.min(0.05, Math.max(0, raw / 1000));
    this.#last = raf;
    this.#tick(raf, dt, raw, begin);
  };

  #tick(now: number, dt: number, raw: number, begin: number, draw = true) {
    this.#time += dt;
    const s = this.#shared;
    const viz = this.#o.viz;
    const live = viz.at > 0 && now - viz.at < 500;

    // Music: smoothed bands and onsets.
    const k = 1 - Math.exp(-dt / 0.5);
    let energy = 0;
    for (let i = 0; i < 3; i++) {
      this.#levels[i] += ((live ? viz.bands[i] : 0) - this.#levels[i]) * k;
      energy += this.#levels[i] / 3;
    }
    if (viz.onsets !== this.#onsets) this.#onsets = viz.onsets;

    this.#travel(now, dt, energy, live);
    this.#decays(now, dt);
    this.#progression(now, dt, live);

    // The beat: a sharp attack on every master beat, scaled by the low end.
    const beats = this.#masterBeats(now);
    const phase = beats === null ? (this.#time * (this.#bpm / 60)) % 1 : beats - Math.floor(beats);
    const pulse = this.#playing && !this.#reduced ? Math.exp(-phase * 6) * (0.45 + 0.8 * this.#levels[0]) : 0;
    s.uBeat.value = Math.min(1.4, pulse);
    s.uBeatPhase.value = phase;
    s.uEnergy.value = energy;
    s.uTime.value = this.#time;
    this.#vigil = this.#playing ? Math.max(0, this.#vigil - dt / 0.4) : Math.min(1, this.#vigil + dt / 1.2);
    s.uVigil.value = this.#vigil;
    s.uScroll.value = (s.uScroll.value + dt * (0.035 + 0.05 * this.#speedF)) % 1;

    // Gates spin faster when lit and kick on the beat.
    this.#animateGates(this.#tree, dt, pulse);
    if (this.#old.group.visible) this.#animateGates(this.#old, dt, pulse);

    // Camera: at rest in the current fan (a flight overrides), with a beat bob and a drop's shake.
    if (!this.#flightFrame(now)) {
      const drop = Math.max(0, 1 - (now - this.#dropT0) / 600);
      const shake = this.#reduced ? 0 : drop * 0.5;
      this.#camera.position.set(Math.sin(this.#time * 61) * shake, CAM_H + pulse * 0.08 + Math.sin(this.#time * 47) * shake, 0);
      this.#camera.lookAt(0, LOOK_Y, -LOOK_D);
      this.#passFlash = 0;
    }
    const fovKick = this.#flight && !this.#flight.back ? Math.sin(Math.PI * Math.min(1, (now - this.#flight.t0) / this.#flight.dur)) * 10 : 0;
    const dropKick = Math.max(0, 1 - (now - this.#dropT0) / 500) * 6;
    const fov = FOV + (this.#reduced ? 0 : fovKick + dropKick);
    if (fov !== this.#camera.fov) {
      this.#camera.fov = fov;
      this.#camera.updateProjectionMatrix();
    }
    this.#camera.updateMatrixWorld();
    this.#sky.position.copy(this.#camera.position);
    this.#floor.position.set(this.#camera.position.x, 0, this.#camera.position.z);
    this.#postFrame(now, pulse, live);

    if (!draw) return;
    if (this.#qa) this.#gpuBegin();
    this.#render();
    if (this.#qa) this.#gpuEnd();
    const cpu = performance.now() - begin;
    this.#drawEma += (cpu - this.#drawEma) * 0.05;
    if (this.#qa && !this.#qa.frozen) {
      this.#qa.cpu[this.#qa.cpuAt] = cpu;
      this.#qa.cpuAt = (this.#qa.cpuAt + 1) % this.#qa.cpu.length;
    }
    if (raw > 0) this.#frameEma += (raw - this.#frameEma) * 0.025;
    if (this.#adaptive && this.#time > 8 && this.#frameEma > 19) {
      this.#slow += dt;
      if (this.#slow > 3 && this.#dpr > 0.75) {
        this.#dpr = Math.max(0.75, this.#dpr - 0.15);
        this.#applySize();
        this.#slow = 0;
      }
    } else this.#slow = 0;
    if (this.#o.onStats && now - this.#statsAt > 500) {
      const info = this.#renderer.info.render;
      const st = this.#stats;
      st.fps = Math.round(1000 / this.#frameEma);
      st.calls = info.calls;
      st.triangles = info.triangles;
      st.dpr = this.#dpr;
      st.frameMs = this.#drawEma;
      st.course = this.#course;
      st.speed = this.#speed;
      st.gpuMs = this.#gpuMs;
      this.#o.onStats(st);
      this.#statsAt = now;
    }
  }

  #bpm = 120;

  /** Course from tempo only (never from deck position): fast, and faster with energy. */
  #travel(now: number, dt: number, energy: number, live: boolean) {
    const s = this.#shared;
    const st = waves.state;
    let playing = false,
      master = 0,
      any = 0;
    if (st)
      for (let i = 0; i < st.decks.length; i++) {
        const d = st.decks[i];
        if (!d.track_id) continue;
        if (d.playing) {
          playing = true;
          if (d.bpm && !any) any = d.bpm;
        }
        if (d.master && d.bpm) master = d.bpm;
      }
    const viz = this.#o.viz;
    const bpm = (live && viz.bpm) || master || any || 120;
    this.#bpm = bpm;
    if (playing !== this.#playing) {
      this.#playing = playing;
      // Play: 50 % at once, full in 400 ms. Stop: half at once, then drift down.
      if (playing) {
        this.#rampFrom = Math.max(0.5, this.#speedF);
        this.#rampT0 = now;
        this.#speedF = this.#rampFrom;
      } else this.#speedF *= 0.5;
    }
    if (playing) {
      const u = Math.min(1, (now - this.#rampT0) / 400);
      this.#speedF = this.#rampFrom + (1 - this.#rampFrom) * (1 - (1 - u) * (1 - u));
    } else this.#speedF *= Math.exp(-dt / 0.5);
    this.#energyS += (energy - this.#energyS) * (1 - Math.exp(-dt / 2));
    // Units per beat: 14 at rest, up to 30 with energy; a drop surges ×2.5.
    const surge = 1 + 1.5 * Math.exp(-(now - this.#dropT0) / 600);
    const v = this.#speedF * (bpm / 60) * (14 + 16 * this.#energyS) * surge;
    this.#speed = this.#reduced ? 0 : v;
    const ds = this.#speed * dt;
    this.#course += ds;
    // The grid streams under a resting camera (a flight moves the camera itself).
    if (!this.#flight && ds) {
      rotY(0, -ds, this.#gridYaw, this.#v2);
      this.#gridOff.x += this.#v2.x;
      this.#gridOff.y += this.#v2.y;
      // Keep the offset small: the grid repeats every 8 units.
      this.#gridOff.x %= 8000;
      this.#gridOff.y %= 8000;
    }
    s.uGridYaw.value = this.#gridYaw;
    s.uGridOff.value.copy(this.#gridOff);
    s.uTravel.value = this.#course % 230;
    s.uSpeed.value = this.#speed + (this.#flight && !this.#flight.back ? 90 : 0);
    // Light packets race down the rails a little faster than we travel.
    this.#flow = (this.#flow + (this.#reduced ? 0 : (this.#speed * 1.2 + 14 * (1 - this.#vigil)) * dt)) % (11.42397 * 600);
    s.uFlow.value = this.#flow;
  }

  /** Flourish decays from the message frame; nothing eases toward a response. */
  #decays(now: number, dt: number) {
    const s = this.#shared;
    const t = this.#tree;
    const fall = dt / ((this.#reduced ? 150 : AIM_FALL_MS) / 1000);
    const lit = t.u.uLit.value,
      head = t.u.uHead.value,
      grow = t.u.uGrandGrow.value,
      glit = t.u.uGrandLit.value;
    for (let i = 0; i < MAX_CHILDREN; i++) {
      const aimed = i === this.#aimSlot;
      lit[i] = aimed ? 1 : Math.max(0, lit[i] - fall);
      const h = (now - t.headT0[i]) / HEAD_MS;
      head[i] = h >= 0 && h < 1.3 ? h : -9;
      // The aimed gate's paths sprout; the others shrink back to stubs.
      const target = aimed ? 1 : STUB;
      const u = Math.max(0, Math.min(1, (now - t.sproutT0[i] - (aimed ? SPROUT_DELAY : 0)) / SPROUT_MS));
      const e = 1 - (1 - u) * (1 - u);
      grow[i] = t.sproutT0[i] < -1e8 ? target : t.sproutFrom[i] + (target - t.sproutFrom[i]) * e;
      glit[i] = 0.12 + 0.88 * lit[i];
    }
    lit[TRUNK_SLOT] = 0.55 + 0.45 * (this.#aimSlot >= 0 ? 1 : 0);
    // Band colours settle in 180 ms.
    const u = Math.min(1, (now - this.#bandT0) / 180);
    const e = 1 - (1 - u) * (1 - u);
    s.uAccent.value.lerpVectors(this.#accentFrom, this.#accentTo, e);
    s.uHot.value.lerpVectors(this.#hotFrom, this.#hotTo, e);
    const mu = Math.min(1, (now - this.#mistT0) / MIST_MS);
    this.#mist = this.#mistFrom + (this.#mistTo - this.#mistFrom) * mu;
  }

  #animateGates(t: Tree, dt: number, pulse: number) {
    const lit = t.u.uLit.value,
      grow = t.u.uGrandGrow.value;
    const still = this.#reduced ? 0 : 1;
    for (let i = 0; i < t.count; i++) {
      const g = t.gates[i];
      const l = Math.min(1, lit[i]);
      g.spin += dt * still * (0.5 + 2.8 * l + this.#speedF * 0.6) * (1 + pulse * 0.8);
      g.outer.rotation.set(g.tilt + g.spin * 0.37, g.spin, 0);
      g.inner!.rotation.set(-g.spin * 0.9, -g.spin * 1.6, g.tilt);
      const size = GATE_R * (0.8 + 0.4 * t.sim[i]) * (1 + 0.14 * pulse * (0.4 + l) + 0.18 * l);
      g.outer.scale.setScalar(size);
      g.inner!.scale.setScalar(size * 0.42);
      g.outerU.uLit.value = l;
      g.innerU!.uLit.value = l;
      g.padU!.uLit.value = l;
      g.columnU!.uLit.value = l;
      g.column!.visible = l > 0.01;
    }
    for (let j = 0; j < t.grandCount; j++) {
      const g = t.grands[j];
      const p = t.grandParent[j];
      const shown = smoothstep(0.55, 1, grow[p]);
      g.spin += dt * still * (0.6 + 1.5 * shown);
      g.outer.rotation.set(g.tilt + g.spin * 0.4, g.spin, 0);
      g.outer.scale.setScalar(GRAND_R * (0.25 + 0.75 * shown) * (0.8 + 0.4 * t.grandSim[j]) * (1 + 0.12 * pulse));
      g.outerU.uLit.value = shown * (0.2 + 0.4 * Math.min(1, lit[p]));
      g.outer.visible = grow[p] > 0.05;
    }
  }

  /** Post uniforms: lasers, flashes, aberration, cuts, mist. */
  #postFrame(now: number, pulse: number, live: boolean) {
    const c = this.#post.composite.uniforms;
    const st = waves.state;
    const age = Math.min(1, Math.max(0, (now - waves.stateAt) / 1000));
    const kLevel = 0.2;
    for (let i = 0; i < 4; i++) {
      const d = st?.decks[i];
      const loaded = !!d?.track_id;
      const playing = loaded && !!d?.playing;
      const v = live ? this.#o.viz.decks[i] : undefined;
      const level = v ? (v[0] + v[1] + v[2]) / 3 : 0;
      this.#deckLevel[i] += (level - this.#deckLevel[i]) * kLevel;
      const focus = st?.focused === i ? 1.25 : 1;
      c.uBeamLevel.value[i] = this.#deckBase > 0 ? (playing ? (0.12 + Math.min(1, this.#deckLevel[i] * 1.6) * 0.5) * focus : loaded ? 0.03 : 0) * (1 - this.#mist * 0.5) : 0;
      c.uBeamX.value[i] = this.#deckX[i] / this.#width;
      // Sway on the deck's own beat: synced decks swing together.
      const grid = loaded ? client.deckInfo[i]?.grid : null;
      let deckPhase = 0;
      if (playing && grid && grid.bpm > 0 && !this.#reduced) {
        const beats = ((d!.position + d!.rate * age - grid.first_beat) * grid.bpm) / 60;
        deckPhase = beats;
      }
      c.uBeamSway.value[i] = this.#reduced ? 0 : Math.sin(Math.PI * deckPhase) * 0.05;
      this.#shared.uDeckLevel.value[i] = playing ? 0.25 + Math.min(1, this.#deckLevel[i] * 1.8) * 0.75 : loaded ? 0.08 : 0;
      this.#shared.uDeckPhase.value[i] = deckPhase;
    }
    c.uBeamY.value = this.#deckBase > 0 ? 1 - this.#deckBase / this.#height : 0;
    const drop = Math.max(0, 1 - (now - this.#dropT0) / 160);
    const cut = this.#reduced ? 0 : Math.max(0, 1 - (now - this.#cutT0) / CUT_MS);
    const flying = this.#flight ? 1 : 0;
    c.uFlash.value = this.#reduced ? 0 : this.#passFlash + drop * 0.55 + cut * 0.08 + pulse * 0.02 * this.#energyS;
    c.uAberr.value = this.#reduced ? 0 : pulse * 0.8 + flying * 2.5 + drop * 5 + cut * 3;
    c.uCut.value = cut;
    c.uMist.value = this.#mist;
    c.uTime.value = this.#time;
    c.uBloom.value = 1 + 0.25 * pulse;
    const ripple = (now - this.#dropT0) / 1200;
    this.#shared.uRipple.value = ripple >= 0 && ripple < 1 && !this.#reduced ? ripple : -1;
  }

  /** A drop after a breakdown (low band under 0.25 for 8 s, then back above 0.6): flash, shock wave, surge. */
  #progression(now: number, dt: number, live: boolean) {
    const low = this.#levels[0];
    const playing = this.#playing && live;
    if (playing && low < 0.25) {
      this.#breakdown += dt;
      this.#lowBelowAt = now;
    } else {
      if (this.#breakdown >= 8) this.#breakdownEnd = now;
      this.#breakdown = 0;
    }
    const after = this.#breakdown >= 8 || now - this.#breakdownEnd < 4000;
    if (playing && after && low > 0.6 && now - this.#lowBelowAt < 2000 && now - this.#lastDrop > 20_000) {
      this.#breakdownEnd = -1e9;
      this.#drop(now);
    }
  }
  #drop(now: number) {
    this.#lastDrop = now;
    this.#dropT0 = now;
  }

  /** The master deck's beat count from its grid and dead-reckoned position, or null. */
  #masterBeats(now: number) {
    const st = waves.state;
    if (!st) return null;
    for (let i = 0; i < st.decks.length; i++) {
      const d = st.decks[i];
      if (!d.master || !d.track_id) continue;
      const grid = client.deckInfo[i]?.grid;
      if (!grid || grid.bpm <= 0) return null;
      const age = Math.min(1, Math.max(0, (now - waves.stateAt) / 1000));
      return ((d.position + (d.playing ? d.rate * age : 0) - grid.first_beat) * grid.bpm) / 60;
    }
    return null;
  }

  #render() {
    const r = this.#renderer;
    const p = this.#post;
    r.setRenderTarget(this.#rtScene);
    r.render(this.#scene, this.#camera);
    const pass = (mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => {
      p.quad.material = mat;
      r.setRenderTarget(target);
      r.render(p.scene, p.camera);
    };
    p.bright.uniforms.tSrc.value = this.#rtScene.texture;
    p.bright.uniforms.uTexel.value.set(1 / this.#rtScene.width, 1 / this.#rtScene.height);
    pass(p.bright, this.#rtA);
    const b = p.blur.uniforms;
    b.tSrc.value = this.#rtA.texture;
    b.uDir.value.set(1 / this.#rtA.width, 0);
    pass(p.blur, this.#rtB);
    b.tSrc.value = this.#rtB.texture;
    b.uDir.value.set(0, 1 / this.#rtA.height);
    pass(p.blur, this.#rtA);
    b.tSrc.value = this.#rtA.texture;
    b.uDir.value.set(2 / this.#rtA.width, 0);
    pass(p.blur, this.#rtC);
    b.tSrc.value = this.#rtC.texture;
    b.uDir.value.set(0, 2 / this.#rtC.height);
    pass(p.blur, this.#rtD);
    const c = p.composite.uniforms;
    c.tScene.value = this.#rtScene.texture;
    c.tBloom.value = this.#rtA.texture;
    c.tWide.value = this.#rtD.texture;
    pass(p.composite, null);
  }

  // ---------------------------------------------------------------------------
  // QA (?qa): a clock that can be frozen and stepped (WAAPI animations with it),
  // message-to-frame records and GPU timer queries. Never active otherwise.

  #qa: Qa | null = null;
  #gl: WebGL2RenderingContext | null = null;
  #timer: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  readonly #queries: (WebGLQuery | null)[] = [null, null, null, null];
  #queryHead = 0;
  #queryActive = false;
  #gpuMs = 0;

  #now() {
    return this.#qa?.frozen ? this.#qa.clock : performance.now();
  }

  #qaExpect(reason: string, recv: number, aim: string | null, count: number) {
    if (!this.#qa) return;
    this.#qa.pending = { reason, recv, handled: performance.now(), aim, count };
  }

  /** In the first animation frame after a message: are its label text and lit branch there? */
  #qaFrame(raf: number, begin: number) {
    const qa = this.#qa!;
    const p = qa.pending;
    if (!p) return;
    qa.pending = null;
    const live = this.#o.labels.querySelectorAll<HTMLElement>('.xl:not(.xl-leaving)');
    let labelOk = live.length === p.count;
    if (p.aim) {
      const el = this.#o.labels.querySelector<HTMLElement>(`.xl[data-kind="aimed"]`);
      const expected = this.#o.track(p.aim)?.title;
      labelOk &&= !!el && el.dataset.id === p.aim && !!el.querySelector('.xl-t')?.textContent && (!expected || el.querySelector('.xl-t')?.textContent === expected);
    }
    const slot = this.#aimSlot;
    const routeOk = !p.aim || (slot >= 0 && this.#tree.u.uLit.value[slot] >= 0.999);
    qa.records.push({ reason: p.reason, recv: p.recv, handled: p.handled, raf, frame: begin, labelOk, routeOk });
    if (qa.records.length > 500) qa.records.shift();
  }

  #gpuBegin() {
    const gl = this.#gl,
      t = this.#timer;
    if (!gl || !t) return;
    const q = this.#queries[this.#queryHead];
    if (q) {
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      if (!gl.getParameter(t.GPU_DISJOINT_EXT)) {
        const ms = ns / 1e6;
        this.#gpuMs = this.#gpuMs ? this.#gpuMs + (ms - this.#gpuMs) * 0.1 : ms;
        this.#qa?.gpu.push(ms);
        if (this.#qa && this.#qa.gpu.length > 4000) this.#qa.gpu.shift();
      }
    } else this.#queries[this.#queryHead] = gl.createQuery();
    gl.beginQuery(t.TIME_ELAPSED_EXT, this.#queries[this.#queryHead]!);
    this.#queryActive = true;
  }
  #gpuEnd() {
    if (!this.#queryActive || !this.#gl || !this.#timer) return;
    this.#gl.endQuery(this.#timer.TIME_ELAPSED_EXT);
    this.#queryActive = false;
    this.#queryHead = (this.#queryHead + 1) % this.#queries.length;
  }

  /** The QA handle (window.__datastream with ?qa). */
  qa() {
    if (!this.#qa) {
      this.#qa = { frozen: false, clock: 0, anims: new Map(), pending: null, records: [], gpu: [], cpu: new Float64Array(2048).fill(-1), cpuAt: 0 };
      this.#gl = this.#renderer.getContext() as WebGL2RenderingContext;
      this.#timer = this.#gl.getExtension('EXT_disjoint_timer_query_webgl2');
    }
    const qa = this.#qa;
    const sync = () => {
      for (const a of document.getAnimations()) {
        if (!qa.anims.has(a)) {
          qa.anims.set(a, qa.clock);
          a.pause();
        }
        a.currentTime = qa.clock - qa.anims.get(a)!;
      }
    };
    return {
      records: qa.records,
      gpu: qa.gpu,
      cpuMark: () => qa.cpu.fill(-1),
      cpuSamples: () => Array.from(qa.cpu).filter((v) => v >= 0),
      freeze: () => {
        qa.clock = performance.now();
        qa.frozen = true;
        qa.anims.clear();
        for (const a of document.getAnimations()) {
          a.pause();
          qa.anims.set(a, qa.clock - Number(a.currentTime ?? 0));
        }
      },
      /** Step the frozen world by `ms` in 1/120 s steps, simulating without drawing. */
      advance: (ms: number) => {
        sync();
        let left = ms;
        while (left > 0) {
          const step = Math.min(1000 / 120, left);
          qa.clock += step;
          left -= step;
          this.#tick(qa.clock, step / 1000, step, performance.now(), false);
        }
        sync();
      },
      resume: () => {
        qa.frozen = false;
        for (const a of qa.anims.keys()) if (a.playState === 'paused') a.play();
        qa.anims.clear();
        this.#last = performance.now();
      },
      /** Force a drop (flash, shock wave, surge). */
      drop: () => this.#drop(this.#now()),
      gpuMedian: async (ms = 3000) => {
        qa.gpu.length = 0;
        await new Promise((r) => setTimeout(r, ms));
        const g = qa.gpu.slice().sort((a, b) => a - b);
        return g.length ? { n: g.length, p50: g[g.length >> 1], p95: g[Math.floor(g.length * 0.95)] } : null;
      },
      state: () => ({
        course: this.#course,
        speed: this.#speed,
        aimSlot: this.#aimSlot,
        flying: !!this.#flight,
        mist: this.#mist,
        vigil: this.#vigil,
        grandGrow: Array.from(this.#tree.u.uGrandGrow.value),
        anchors: Array.from(this.#anchors.slice(0, this.#children.length * 2)),
        calls: this.#renderer.info.render.calls,
        triangles: this.#renderer.info.render.triangles,
        gpuMs: this.#gpuMs,
        cpuMs: this.#drawEma,
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // Size, input, teardown

  #onResize = () => {
    const el = this.#o.canvas.parentElement ?? this.#o.canvas;
    this.#width = Math.max(1, el.clientWidth);
    this.#height = Math.max(1, el.clientHeight);
    this.#applySize();
    if (this.#msg && this.#children.length) {
      this.#endFlight();
      this.#build(this.#tree, this.#msg, this.#now(), true);
      this.#project();
      this.#layoutLabels();
    } else this.#project();
  };
  #applySize() {
    this.#renderer.setPixelRatio(this.#dpr);
    this.#renderer.setSize(this.#width, this.#height, false);
    this.#camera.aspect = this.#width / this.#height;
    this.#camera.updateProjectionMatrix();
    const w = Math.max(1, Math.round(this.#width * this.#dpr)),
      h = Math.max(1, Math.round(this.#height * this.#dpr));
    const make = (rw: number, rh: number, samples = 0) =>
      new THREE.WebGLRenderTarget(Math.max(1, rw), Math.max(1, rh), { type: this.#rtType, samples, depthBuffer: samples > 0, colorSpace: THREE.NoColorSpace });
    for (const rt of [this.#rtScene, this.#rtA, this.#rtB, this.#rtC, this.#rtD]) rt?.dispose();
    this.#rtScene = make(w, h, 4);
    this.#rtA = make(w >> 2, h >> 2);
    this.#rtB = make(w >> 2, h >> 2);
    this.#rtC = make(w >> 3, h >> 3);
    this.#rtD = make(w >> 3, h >> 3);
    this.#post.composite.uniforms.uRes.value.set(w, h);
  }
  #pick(e: MouseEvent) {
    const rect = this.#o.canvas.getBoundingClientRect();
    let best = -1;
    let distance = 56;
    const x = e.clientX - rect.left,
      y = e.clientY - rect.top;
    for (let i = 0; i < this.#children.length; i++) {
      const d = Math.min(Math.hypot(x - this.#anchors[i * 2], y - this.#anchors[i * 2 + 1]), Math.hypot(x - this.#gates[i * 2], y - this.#gates[i * 2 + 1]));
      if (d < distance) {
        distance = d;
        best = i;
      }
    }
    return best >= 0 ? this.#children[best].id : undefined;
  }
  #aimTo(id: string | undefined) {
    if (!id) return;
    this.aimLocal(id);
    this.#o.onAim(id);
  }
  #click = (e: MouseEvent) => this.#aimTo(this.#pick(e));
  #doubleClick = (e: MouseEvent) => {
    const id = this.#pick(e);
    if (id) this.#o.onDive(id);
  };
  #labelClick = (e: MouseEvent) => this.#aimTo((e.target as HTMLElement)?.closest<HTMLElement>('.xl:not(.xl-leaving)')?.dataset.id);
  #labelDoubleClick = (e: MouseEvent) => {
    const id = (e.target as HTMLElement)?.closest<HTMLElement>('.xl:not(.xl-leaving)')?.dataset.id;
    if (id) this.#o.onDive(id);
  };
  #onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const now = performance.now();
    if (now - this.#wheelAt > 400) this.#wheel = 0;
    this.#wheelAt = now;
    this.#wheel += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(this.#wheel) >= (e.deltaMode === 1 ? 3 : 80)) {
      const d = Math.sign(this.#wheel);
      this.aimLocal(d);
      this.#o.onAimDelta(d);
      this.#wheel = 0;
    }
  };
  dispose() {
    this.#disposed = true;
    cancelAnimationFrame(this.#raf);
    this.#resize.disconnect();
    document.removeEventListener('visibilitychange', this.#visibility);
    this.#o.canvas.removeEventListener('click', this.#click);
    this.#o.canvas.removeEventListener('dblclick', this.#doubleClick);
    this.#o.canvas.removeEventListener('wheel', this.#onWheel);
    this.#o.labels.removeEventListener('click', this.#labelClick);
    this.#o.labels.removeEventListener('dblclick', this.#labelDoubleClick);
    this.#labels.clear();
    for (const t of this.#trees) t.dispose();
    for (const g of this.#geos) g.dispose();
    for (const m of [this.#sky, this.#floor, this.#streaks]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    for (const m of [this.#post.bright, this.#post.blur, this.#post.composite]) m.dispose();
    for (const rt of [this.#rtScene, this.#rtA, this.#rtB, this.#rtC, this.#rtD]) rt.dispose();
    this.#scroller.tex.dispose();
    this.#renderer.dispose();
  }
}

type Qa = {
  frozen: boolean;
  clock: number;
  anims: Map<Animation, number>;
  pending: { reason: string; recv: number; handled: number; aim: string | null; count: number } | null;
  records: { reason: string; recv: number; handled: number; raf: number; frame: number; labelOk: boolean; routeOk: boolean }[];
  gpu: number[];
  cpu: Float64Array;
  cpuAt: number;
};

export function createExploreEngine(o: EngineOptions) {
  return new ExploreEngine(o);
}

type Rails = ReturnType<typeof makeRails>;
type Pt = { x: number; y: number };
const A: Pt = { x: 0, y: 0 },
  B: Pt = { x: 0, y: 0 };

/** One flat strip along `curve` (u 0..1 → x, z): `count` segments, `half` wide each side. */
function strip(r: Rails, seg: number, slot: number, count: number, half: number, curve: (u: number, out: Pt) => void) {
  const P = r.positions,
    R = r.rails;
  let dist = 0;
  for (let k = 0; k < count; k++) {
    const t0 = k / count,
      t1 = (k + 1) / count;
    curve(t0, A);
    curve(t1, B);
    const tx = B.x - A.x,
      tz = B.y - A.y;
    const len = Math.hypot(tx, tz) || 1;
    const nx = -tz / len,
      nz = tx / len;
    const d0 = dist,
      d1 = dist + len;
    dist = d1;
    const v = seg * 6;
    for (let c = 0; c < 6; c++) {
      // Two triangles: (a−, a+, b+), (a−, b+, b−).
      const atB = c === 2 || c === 4 || c === 5;
      const side = c === 1 || c === 2 || c === 4 ? 1 : -1;
      const x = atB ? B.x : A.x,
        z = atB ? B.y : A.y;
      P[(v + c) * 3] = x + nx * half * side;
      P[(v + c) * 3 + 1] = 0.03;
      P[(v + c) * 3 + 2] = z + nz * half * side;
      R[(v + c) * 4] = slot;
      R[(v + c) * 4 + 1] = atB ? t1 : t0;
      R[(v + c) * 4 + 2] = side;
      R[(v + c) * 4 + 3] = atB ? d1 : d0;
    }
    seg++;
  }
  return seg;
}

function bezier(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number, u: number, o: Pt) {
  const v = 1 - u;
  const a = v * v * v,
    b = 3 * v * v * u,
    c = 3 * v * u * u,
    d = u * u * u;
  o.x = a * ax + b * bx + c * cx + d * dx;
  o.y = a * az + b * bz + c * cz + d * dz;
}

function smoothstep(a: number, b: number, v: number) {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function hexVec(hex: string, out: THREE.Vector3) {
  const n = Number.parseInt(hex.slice(1), 16);
  out.set(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
