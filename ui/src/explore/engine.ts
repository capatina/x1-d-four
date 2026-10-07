import * as THREE from 'three';
import { client } from '../lib/client.svelte';
import { DECK_COLORS } from '../lib/decks';
import type { ExploreMsg, ExploreNode, MidiMsg, Track } from '../lib/protocol';
import type { VizFrame } from '../lib/viz';
import { channels, updateChannels } from '../lib/channels';
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
  makeArches,
  makeMonoliths,
  makePackets,
  makePlanet,
  makePost,
  makeRails,
  makeShared,
  makeSky,
  makeStreaks,
  makeTunnel,
  makeWorldTunnel,
  MAX_CHILDREN,
  MAX_GRANDS,
  PACKETS,
  padGeometry,
  PATH_SAMPLES,
  RAIL_SEGMENTS,
  RING_GAP,
  RINGS,
  rotY,
  SPLIT_Z,
  TRUNK_FROM,
  TRUNK_SEGMENTS,
  TRUNK_SLOT,
  wireMaterial,
  type Shared,
  type TreeUniforms,
} from './demo';
import { Labels, type Obstacle } from './labels';
import { pixelScale } from '../lib/pixel';
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
  /** A new generation of the world has started building (1-based), for the title card. */
  onGeneration?: (level: number, name: string) => void;
  /** We jumped into another world (its index into WORLDS), for the title card and the labels' look. */
  onWorld?: (world: number, name: string) => void;
};

/**
 * The worlds a climax jumps between, in order. Each tints the band's colour
 * toward its own, and sets the scanlines, the bloom and the shape of the paths
 * (0 curves, 1 swoops, 2 angles, 3 waves, 4 steps).
 */
export const WORLDS = [
  { name: 'Neon Grid', tint: '#ffffff', mix: 0, scan: 0.2, bloom: 1 },
  { name: 'Chromozon', tint: '#ff9a3d', mix: 0.5, scan: 0.12, bloom: 1.15 },
  { name: 'Tunnelwerk', tint: '#f0f4ff', mix: 0.35, scan: 0.35, bloom: 0.9 },
  { name: 'Nachtflug', tint: '#3de0ff', mix: 0.55, scan: 0.12, bloom: 1.25 },
  { name: 'Kupferzeit', tint: '#ffb347', mix: 0.25, scan: 0.4, bloom: 1.05 },
] as const;
/** Which generations each world shows: ridges, monoliths, hexagon tunnel, orbit (1 = always). */
const WORLD_LAYERS: readonly (readonly [number, number, number, number])[] = [
  [1, 1, 1, 1],
  [0, 0, 0, 0],
  [0, 0, -1, 0],
  [0, 1, 0, 1],
  [0, 1, 1, 0],
];
/** Seconds of (weighted) music between genome mutations. */
const MUTATE_S = 75;
/** A world evolves fully over this much music. */
const EVO_S = 240;
/** The hyperjump: 1.5 s, the world swapping under the white-out at 43 %. */
const JUMP_MS = 1500;
const JUMP_SWAP = 0.43;
/** A climax: the bass under 40 % of its usual level for 6 s, then back over 85 %; jumps at least 30 s apart. */
const CLIMAX_LOW = 0.4;
const CLIMAX_HIGH = 0.85;
const CLIMAX_HOLD_S = 6;
const CLIMAX_GAP_MS = 30_000;

/**
 * Progressive generation: the world builds up as the music plays, one layer at a
 * time, sooner when the bass is heavy and each time you take a branch.
 */
export const GENERATIONS = [
  { at: 0.4, name: 'Ridges' },
  { at: 1.5, name: 'Monoliths' },
  { at: 3, name: 'Hypertunnel' },
  { at: 5, name: 'Orbit' },
  { at: 8, name: 'Plasma' },
] as const;
/** Each generation builds over this many seconds. */
const GEN_BUILD_S = 5;
/** Taking a branch counts as this much music toward the next generation. */
const GEN_PER_BRANCH_S = 20;

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
  readonly #monoliths: THREE.Mesh;
  readonly #packets: THREE.Points;
  readonly #worldTunnel: THREE.Mesh;
  readonly #arches: THREE.Mesh;
  /** One guardian per deck: its sigil as a big wireframe solid, in its colour, answering to its deck. */
  readonly #guardians: { mesh: THREE.Mesh; inner: THREE.Mesh; alpha: { value: number }; lit: { value: number }; innerLit: { value: number }; spin: number; scale: number }[] = [];
  readonly #deckBeat = new Float64Array(4);
  readonly #tunnel: THREE.Mesh;
  readonly #planet: ReturnType<typeof makePlanet>;
  readonly #trees: [Tree, Tree];
  #tree: Tree;
  #old: Tree;
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

  // Bass: a fast envelope, auto-levelled, and kicks found on its rising edges
  #bass = 0;
  #bassPeak = 0.1;
  #bassSlow = 0;
  #bassN = 0;
  #kickAt = -1e9;
  #kickSide = 1;
  // Progressive generation: seconds of (weighted) music, and the generations announced
  #genTime = 0;
  #genShown = 0;
  // The MIDI data flow: packets launched, activity, and the jogs' scratch (units of course to apply)
  #packetNext = 0;
  #data = 0;
  #dataGenAt = -1e9;
  #scratch = 0;
  // Worlds: where we are, how long we've been here (music s), the jump in progress, the climax watch
  #world = 0;
  /** Hybrid worlds: where the land, the sky and the paths each come from. */
  #worldF = 0;
  #worldS = 0;
  #worldP = 0;
  /**
   * The genome: 16 parameters that drift (τ 8 s) toward targets that mutate
   * forever: every ~75 s of music (sooner with bass, MIDI and branches, bigger
   * the deeper in the tree), and hard on every climax. Each session starts from
   * its own seed, so the world never repeats.
   */
  readonly #genome = new Float32Array(16).fill(0.5);
  readonly #genomeTarget = new Float32Array(16).fill(0.5);
  #mutations = 0;
  #mutateClock = 0;
  readonly #seed = (Math.random() * 0xffffffff) >>> 0;
  // Phrase arches: the bar clock (when no master grid), smoothed speed, last phrase passed
  #barClock = 0;
  #speedS = 0;
  #phrase = -1;
  #archPassT0 = -1e9;
  #worldTime = 0;
  #jumps = 0;
  #jumpT0 = -1e9;
  #jumpSwapped = true;
  #lastJump = -1e9;
  #bassRef = 0;
  #lowFor = 0;
  #lowEndAt = -1e9;
  #band: 'low' | 'mid' | 'high' = 'low';
  /**
   * The mix as the room hears it: the mixer's master, from its record channels
   * (after faders, EQ, filters, crossfader). Smoothed level 0..1, when it last had
   * signal (the bend only applies while it does), and the swell watch.
   */
  #master = 0;
  #masterDb = -99;
  #mix = 0;
  #masterLowAt = -1e9;
  /** The path labels fade out 3 s after the aim last moved, and come back when it does. */
  #labelsAt = -1e9;
  #labelsIdle = false;
  // The land's seed (reseeded on track changes, swept in from the horizon) and the loudest channel
  #seedT0 = -1e9;
  #dominant = -1;
  #challenger = -1;
  #challengeFor = 0;
  #bandMs = 180;

  // Music
  readonly #levels = new Float32Array(3);
  #onsets = 0;
  #vigil = 0;
  #dropT0 = -1e9;

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
    this.#monoliths = makeMonoliths(s);
    this.#packets = makePackets(s);
    this.#worldTunnel = makeWorldTunnel(s);
    this.#worldTunnel.visible = false;
    this.#arches = makeArches(s);
    // The decks' sigils (◆ ▲ ● ■): octahedron, tetrahedron, geodesic sphere, icosahedron.
    const sigil = [1, 2, 3, 0];
    for (let i = 0; i < 4; i++) {
      const alpha = { value: 1 };
      const om = wireMaterial(s, alpha),
        im = wireMaterial(s, alpha);
      for (const m of [om, im]) {
        m.uniforms.uTintMix.value = 1;
        m.uniforms.uFog.value = 0.0015;
        hexVec(DECK_COLORS[i], m.uniforms.uTint.value as THREE.Vector3);
      }
      om.uniforms.uWidth.value = 1.6;
      const mesh = new THREE.Mesh(geos[sigil[i]], om);
      const inner = new THREE.Mesh(geos[(sigil[i] + 2) % 4], im);
      inner.scale.setScalar(0.45);
      mesh.add(inner);
      mesh.frustumCulled = inner.frustumCulled = false;
      this.#guardians.push({ mesh, inner, alpha, lit: om.uniforms.uLit as { value: number }, innerLit: im.uniforms.uLit as { value: number }, spin: i * 1.3, scale: 0 });
      this.#scene.add(mesh);
    }
    this.#tunnel = makeTunnel(s);
    this.#planet = makePlanet(s, geos[3]);
    this.#renderer.sortObjects = true;
    this.#scene.add(this.#sky, this.#floor, this.#worldTunnel, this.#monoliths, this.#planet.planet, this.#trees[0].group, this.#trees[1].group, this.#tunnel, this.#arches, this.#packets, this.#camera);

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
    if (banded || !prev) {
      this.#bandMs = 180;
      this.#setBand(msg.band, !prev);
    }
    // A new track (a new root, or taking a branch): new land.
    if (prev && (prev.root !== msg.root || prev.current !== msg.current)) this.#reseed(now);
    // Commit and scout fly down the branch that was aimed: its slot is where current came from.
    const forward = moved && (msg.reason === 'commit' || msg.reason === 'dive');
    const taken = forward ? this.#children.findIndex((c) => c.id === msg.current) : -1;
    const fresh = !prev || moved || banded || children.length !== this.#children.length;

    let aim = msg.aim;
    if (this.#localAim && now - this.#localAimAt < 350 && msg.reason === 'aim' && !fresh) aim = this.#localAim;
    else this.#localAim = null;

    if (fresh) {
      this.#showLabels(now);
      this.#endFlight();
      const from = this.#tree;
      this.#children = children;
      if (taken >= 0) {
        this.#genTime += GEN_PER_BRANCH_S;
        this.#mutateClock += 15;
      }
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
    if (this.#qa) this.#qaExpect(msg.reason, client.exploreAt, aim, children.length);
  }

  /**
   * A MIDI message from the mixer: it launches a data packet from its pod's side
   * (coloured by its deck), lifts the data glow, builds the world a little, and a
   * jog scratches the grid back and forth with the wheel.
   */
  midiEvent(msg: MidiMsg) {
    if (msg.action === '(LED echo ignored)' || !msg.event || msg.event === 'release') return;
    const now = this.#now();
    const control = msg.control ?? '';
    const side = control.startsWith('left') || control.startsWith('shift.left') ? -1 : control.startsWith('right') || control.startsWith('shift.right') ? 1 : 0;
    const deck = /(?:lit|encoder|fader|upper|lower)(\d)/.exec(control);
    const v = msg.value ?? 0;
    const value = msg.event === 'value' ? v / 127 : msg.event === 'delta' ? Math.min(1, Math.abs(v) / 4) : 1;
    this.#data = Math.min(1, this.#data + 0.18);
    if (now - this.#dataGenAt > 150) {
      this.#dataGenAt = now;
      this.#genTime += 1;
      this.#mutateClock += 0.5;
    }
    if (msg.event === 'delta' && /jog$/.test(control)) this.#scratch += v * (control.includes('right') ? 0.6 : 2.2);
    if (this.#reduced) return;
    const p = this.#shared.uPackets.value[this.#packetNext];
    this.#packetNext = (this.#packetNext + 1) % PACKETS;
    p.set(side + (Math.random() - 0.5) * 0.3, this.#time, value, deck ? Number(deck[1]) - 1 : -1);
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
  }

  /** Frame 0: the branch is lit and its head of light starts down it; the old aim decays from where it is. */
  #aim(slot: number, now: number, flourish: boolean) {
    const prev = this.#aimSlot;
    this.#aimSlot = slot;
    this.#labels.setAim(slot >= 0 ? this.#children[slot].id : null);
    if (slot === prev) return;
    this.#showLabels(now);
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
    this.#band = band;
    this.#accentFrom.copy(s.uAccent.value);
    this.#hotFrom.copy(s.uHot.value);
    // The band's colour, tinted toward the world's, then toward the loudest deck's.
    const w = WORLDS[this.#worldS];
    hexVec(pal.css, this.#accentTo);
    hexVec(w.tint, this.#tint);
    this.#accentTo.lerp(this.#tint, w.mix);
    if (this.#dominant >= 0) {
      hexVec(DECK_COLORS[this.#dominant], this.#tint);
      // Deck colours are soft; push them to neon before mixing in.
      const l = this.#tint.x * 0.299 + this.#tint.y * 0.587 + this.#tint.z * 0.114;
      this.#tint.set(l + (this.#tint.x - l) * 2.4, l + (this.#tint.y - l) * 2.4, l + (this.#tint.z - l) * 2.4).clampScalar(0, 1);
      this.#accentTo.lerp(this.#tint, 0.35);
    }
    hexVec(pal.hot, this.#hotTo);
    this.#hotTo.lerp(this.#tint, w.mix * 0.6).multiplyScalar(0.55);
    this.#bandT0 = instant ? -1e9 : this.#now();
    if (instant) {
      s.uAccent.value.copy(this.#accentTo);
      s.uHot.value.copy(this.#hotTo);
    }
  }

  readonly #tint = new THREE.Vector3();

  #showLabels(now: number) {
    this.#labelsAt = now;
    if (this.#labelsIdle) {
      this.#labelsIdle = false;
      this.#o.labels.classList.remove('idle');
    }
  }

  /**
   * Land in the next world: for the first round, each world whole; after that,
   * hybrids: the land, the sky and the paths each from a world of their own (125
   * mixes, never the same twice in a row). `pure` forces world `w` whole.
   */
  #enterWorld(w: number, now: number, pure = false) {
    this.#world = w;
    this.#worldTime = 0;
    let f = w,
      sk = w,
      pa = w;
    if (!pure && this.#jumps >= WORLDS.length) {
      const r = mulberry32(this.#seed ^ Math.imul(this.#jumps, 2654435761));
      do {
        f = Math.floor(r() * WORLDS.length);
        sk = Math.floor(r() * WORLDS.length);
        pa = Math.floor(r() * WORLDS.length);
      } while (f === this.#worldF && sk === this.#worldS && pa === this.#worldP);
    }
    this.#worldF = f;
    this.#worldS = sk;
    this.#worldP = pa;
    const s = this.#shared;
    s.uWorldF.value = f;
    s.uWorldS.value = sk;
    s.uWorldP.value = pa;
    s.uEvo.value = 0;
    s.uJumps.value = this.#jumps;
    this.#floor.visible = f !== 2;
    this.#worldTunnel.visible = f === 2;
    this.#setBand(this.#band, true);
    this.#post.composite.uniforms.uScan.value = WORLDS[f].scan;
    // The paths take the new world's shape (same slots, so the labels stay put).
    if (this.#msg?.current && this.#children.length && !this.#flight) this.#build(this.#tree, this.#msg, now, true);
    this.#o.onWorld?.(pa, WORLDS[pa].name);
  }

  /** Mutate the genome's targets: each gene steps by up to ±strength, and now and then leaps anywhere. */
  #mutate(strength: number) {
    this.#mutations++;
    const r = mulberry32(this.#seed ^ Math.imul(this.#mutations, 0x9e3779b1));
    for (let i = 0; i < 16; i++) {
      let t = this.#genomeTarget[i] + (r() - 0.5) * 2 * strength;
      if (r() < 0.15 * strength) t = r();
      // Reflect at the ends, so genes don't stick there.
      if (t < 0) t = -t;
      if (t > 1) t = 2 - t;
      this.#genomeTarget[i] = Math.max(0, Math.min(1, t));
    }
  }

  /** The genome drifts toward its targets; music time (and depth in the tree) brings the next mutation. */
  #genomeFrame(dt: number, live: boolean) {
    if (this.#playing && live) this.#mutateClock += dt * (0.6 + 0.8 * Math.min(1, this.#shared.uBass.value)) * this.#gate();
    if (this.#mutateClock >= MUTATE_S) {
      this.#mutateClock = 0;
      const depth = Math.min(6, (this.#msg?.path.length ?? 1) - 1);
      this.#mutate(0.25 + 0.07 * depth);
    }
    const k = 1 - Math.exp(-dt / 8);
    for (let i = 0; i < 16; i++) this.#genome[i] += (this.#genomeTarget[i] - this.#genome[i]) * k;
    this.#shared.uGenome.value.set(this.#genome);
    this.#shared.uHue.value = (this.#genome[7] - 0.5) * 0.5;
  }

  /**
   * Phrase arches: one on each of the next four 8-bar phrase downbeats, placed so
   * we fly through it on the downbeat (its distance = time to the downbeat × our
   * speed). The next one flashes as it reaches us.
   */
  #archFrame(now: number, dt: number) {
    const beats = this.#masterBeats(now);
    const bars = beats !== null ? beats / 4 : this.#barClock;
    const perSec = Math.max(0.1, this.#bpm / 240);
    this.#speedS += (this.#speed - this.#speedS) * (1 - Math.exp(-dt / 0.8));
    const on = this.#playing && !this.#reduced ? this.#gate() : 0;
    const phrase = Math.floor(bars / 8);
    if (phrase !== this.#phrase) {
      if (this.#phrase >= 0 && on > 0.3) this.#archPassT0 = now;
      this.#phrase = phrase;
    }
    const arches = this.#shared.uArch.value;
    for (let j = 0; j < 4; j++) {
      const b = (phrase + 1 + j) * 8;
      const dist = ((b - bars) / perSec) * Math.max(8, this.#speedS);
      const sides = 3 + Math.floor(((this.#genome[14] + b * 0.1234) % 1) * 6);
      const flash = Math.exp(-Math.max(0, dist) / 25);
      arches[j].set(dist, sides, flash, on * smoothstep(1100, 600, dist));
    }
  }

  /**
   * The mix volume drives the world: silence flattens and darkens it, the mix
   * coming up raises and lights it, a hot mix burns brighter. It reads the
   * mixer's main mix (its record pair); without a mixer, the decks' own level.
   * A slam from quiet to loud is a climax.
   */
  #masterFrame(now: number, dt: number) {
    const st = waves.state;
    const running = st?.device?.state === 'running';
    const pair = st?.recording?.pair ?? 3;
    // The mix's level: the 120 Hz feed's peak since the last frame (bare-metal fast), else the state.
    const viz = this.#o.viz;
    const fresh = viz.returns && now - viz.at < 500 ? viz.returns[pair] : null;
    let db = -99;
    if (fresh) {
      const rms = Math.hypot(fresh[0], fresh[1], fresh[2]);
      db = rms > 1e-5 ? 20 * Math.log10(rms) : -99;
    } else if (st?.inputs) db = Math.max(st.inputs[pair * 2] ?? -99, st.inputs[pair * 2 + 1] ?? -99);
    let n: number;
    if (running && (fresh || st?.inputs)) {
      // Instant up; a 50 ms fall so silence between beats doesn't strobe.
      this.#masterDb = db > this.#masterDb ? db : this.#masterDb + (db - this.#masterDb) * (1 - Math.exp(-dt / 0.05));
      n = Math.max(0, Math.min(1, (this.#masterDb + 48) / 40));
    } else n = Math.min(1, this.#energyS * 2.5 * (this.#playing ? 1 : 0));
    const was = this.#master;
    this.#master = n;
    if (n < 0.3) this.#masterLowAt = now;
    if (n > 0.7 && was <= 0.7 && now - this.#masterLowAt < 1200 && now - this.#lastJump > CLIMAX_GAP_MS) this.#jump(now);
    // The world's level follows at once; it sinks over 120 ms when the mix goes.
    this.#mix = n > this.#mix ? n : this.#mix + (n - this.#mix) * (1 - Math.exp(-dt / 0.12));
    this.#shared.uMix.value = this.#reduced ? Math.max(0.5, this.#mix) : this.#mix;
  }
  /** How much the world may react at all: 0 with no mix volume (nothing bumps), 1 from a quiet mix up. */
  #gate() {
    const m = this.#shared.uMix.value;
    const t = Math.max(0, Math.min(1, m / 0.45));
    return t * t * (3 - 2 * t);
  }

  /** −1 silent … 0 at a normal mix … +1 hot. */
  #mixBend() {
    const m = this.#shared.uMix.value;
    return m < 0.75 ? (m - 0.75) / 0.75 : (m - 0.75) / 0.25;
  }

  /**
   * The decks' guardians, across the top of the view, each answering to its own
   * deck (after the mixer's fader where it's measured): low = size, mid = glow,
   * high = spin and sparkle, and a kick on the deck's own beat. A silent deck's
   * guardian shrinks to a dim speck.
   */
  #guardiansFrame(dt: number) {
    const ch = channels.bands;
    const gate = this.#gate();
    const cam = this.#camera.position;
    for (let i = 0; i < 4; i++) {
      const g = this.#guardians[i];
      const low = ch[i * 3] * gate,
        mid = ch[i * 3 + 1] * gate,
        high = ch[i * 3 + 2] * gate;
      const level = channels.level[i] * gate;
      const beat = this.#deckBeat[i];
      const kick = beat >= 0 && !this.#reduced ? Math.exp(-(beat - Math.floor(beat)) * 6) * level : 0;
      // Size follows the deck at once, falls back over 150 ms.
      const target = 0.25 + 6.5 * low + 1.8 * kick;
      g.scale = target > g.scale ? target : g.scale + (target - g.scale) * (1 - Math.exp(-dt / 0.15));
      g.spin += dt * (this.#reduced ? 0.1 : 0.3 + 3.5 * high + 1.2 * mid);
      g.mesh.position.set(cam.x + (i - 1.5) * 34, 22 + 3 * Math.sin(this.#time * 0.6 + i * 1.7) * (0.3 + level), cam.z - 115);
      g.mesh.rotation.set(g.spin * 0.6 + i, g.spin, Math.sin(g.spin * 0.3) * 0.4);
      g.inner.rotation.set(-g.spin * 1.4, -g.spin * 0.8, 0);
      g.mesh.scale.setScalar(Math.max(0.2, g.scale));
      g.lit.value = Math.min(1.2, 0.1 + 1.1 * mid + 0.4 * kick);
      g.innerLit.value = Math.min(1.2, 0.2 + 1.4 * high + kick);
      g.alpha.value = 0.25 + 0.75 * Math.min(1, level * 1.5);
    }
  }

  /** A new track: new land, swept in from the horizon to the camera in 2.5 s. */
  #reseed(now: number) {
    const s = this.#shared;
    s.uSeedA.value = s.uSeedB.value;
    s.uSeedB.value = (s.uSeedB.value + 1 + Math.random() * 7) % 97;
    this.#seedT0 = this.#reduced ? -1e9 : now;
    if (this.#reduced) s.uSeedA.value = s.uSeedB.value;
  }

  /**
   * The loudest channel: when another deck stays clearly louder (×1.3) for 1.5 s,
   * the colours drift toward its deck colour and the textures switch to its variant
   * under a short tear.
   */
  #channel(now: number, dt: number) {
    let best = -1,
      level = 0.02;
    for (let i = 0; i < 4; i++) if (this.#deckLevel[i] > level) (best = i), (level = this.#deckLevel[i]);
    const current = this.#dominant >= 0 ? this.#deckLevel[this.#dominant] : 0;
    if (best >= 0 && best !== this.#dominant && level > current * 1.3) {
      if (best !== this.#challenger) (this.#challenger = best), (this.#challengeFor = 0);
      this.#challengeFor += dt;
      if (this.#challengeFor >= 1.5 || this.#dominant < 0) {
        this.#dominant = best;
        this.#challenger = -1;
        this.#shared.uVariant.value = best;
        this.#bandMs = 1200;
        this.#setBand(this.#band, false);
        if (!this.#reduced) this.#cutT0 = now;
      }
    } else this.#challenger = -1;
  }

  /** The hyperjump into the next world: stretch, white-out, swap, land. */
  #jump(now: number) {
    if (this.#jumpT0 + JUMP_MS > now) return;
    this.#mutate(0.7);
    this.#lastJump = now;
    this.#jumps++;
    this.#drop(now);
    if (this.#reduced) {
      this.#enterWorld((this.#world + 1) % WORLDS.length, now);
      return;
    }
    this.#jumpT0 = now;
    this.#jumpSwapped = false;
  }

  /** 0..1 through the jump, or -1. Swaps the world under the white-out. */
  #jumpFrame(now: number) {
    const j = (now - this.#jumpT0) / JUMP_MS;
    if (j < 0 || j >= 1) return -1;
    if (!this.#jumpSwapped && j >= JUMP_SWAP) {
      this.#jumpSwapped = true;
      this.#enterWorld((this.#world + 1) % WORLDS.length, now);
    }
    return j;
  }

  /**
   * Climax watch: a long breakdown (bass under 40 % of its usual level for 6 s)
   * that ends in the bass coming back hard (over 85 %) jumps to the next world.
   */
  #climax(now: number, dt: number, live: boolean) {
    if (!this.#playing || !live) return;
    // A silent mix can't climax (the slam has to be heard).
    if (this.#gate() < 0.5) {
      this.#lowFor = 0;
      return;
    }
    const b = this.#bass;
    if (this.#bassRef < 0.02) this.#bassRef = b;
    if (b > this.#bassRef * 0.5) this.#bassRef += (b - this.#bassRef) * (1 - Math.exp(-dt / 20));
    else if (this.#lowFor > 30) this.#bassRef *= Math.exp(-dt / 30);
    if (b < this.#bassRef * CLIMAX_LOW) this.#lowFor += dt;
    else {
      if (this.#lowFor >= CLIMAX_HOLD_S) this.#lowEndAt = now;
      this.#lowFor = 0;
    }
    const afterBreakdown = this.#lowFor >= CLIMAX_HOLD_S || now - this.#lowEndAt < 2500;
    if (afterBreakdown && b > this.#bassRef * CLIMAX_HIGH && now - this.#lastJump > CLIMAX_GAP_MS) {
      this.#lowEndAt = -1e9;
      this.#jump(now);
    }
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
      const curve = pathCurve(this.#worldP, gx, gz, tx, tz, len, i);
      // Arrive heading the way the curve does (the flight lands facing along it).
      const q0 = { x: 0, y: 0 },
        q1 = { x: 0, y: 0 };
      curve(0.97, q0);
      curve(1, q1);
      t.heading[i] = Math.atan2(-(q1.x - q0.x), -(q1.y - q0.y));
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
    this.#bassFrame(now, dt, live);
    this.#data *= Math.exp(-dt / 0.8);
    s.uData.value = this.#data;
    this.#generation(dt, live);

    this.#travel(now, dt, energy, live);
    this.#decays(now, dt);
    this.#climax(now, dt, live);
    this.#genomeFrame(dt, live);
    this.#archFrame(now, dt);
    this.#masterFrame(now, dt);
    // Each mixer channel's bands, each driving its own part of the world.
    updateChannels(now);
    s.uChan.value.set(channels.bands);
    {
      const g = this.#gate();
      for (let i = 0; i < 12; i++) s.uChan.value[i] *= g;
    }
    const ch = channels.bands;
    this.#channel(now, dt);
    if (!this.#labelsIdle && now - this.#labelsAt > 3000 && this.#children.length) {
      this.#labelsIdle = true;
      this.#o.labels.classList.add('idle');
    }
    {
      const u = (now - this.#seedT0) / 2500;
      if (u >= 0 && u < 1) s.uSeedFront.value = 900 * (1 - u) * (1 - u);
      else {
        s.uSeedFront.value = -1;
        s.uSeedA.value = s.uSeedB.value;
      }
    }
    // The world evolves as the music plays.
    if (this.#playing && live) this.#worldTime += dt * (0.7 + 0.6 * Math.min(1, this.#bassN));
    s.uEvo.value = Math.min(1, this.#worldTime / EVO_S);

    // The beat: a sharp attack on every master beat, scaled by the low end.
    const beats = this.#masterBeats(now);
    const phase = beats === null ? (this.#time * (this.#bpm / 60)) % 1 : beats - Math.floor(beats);
    const pulse = this.#playing && !this.#reduced ? Math.exp(-phase * 6) * (0.45 + 0.8 * this.#levels[0]) * this.#gate() : 0;
    s.uBeat.value = Math.min(1.4, pulse);
    s.uBeatPhase.value = phase;
    s.uEnergy.value = energy * this.#gate();
    s.uTime.value = this.#time;
    this.#vigil = this.#playing ? Math.max(0, this.#vigil - dt / 0.4) : Math.min(1, this.#vigil + dt / 1.2);
    s.uVigil.value = this.#vigil;

    // Gates spin faster when lit and kick on the beat.
    this.#animateGates(this.#tree, dt, pulse);
    if (this.#old.group.visible) this.#animateGates(this.#old, dt, pulse);

    // Camera: at rest in the current fan (a flight overrides), with a beat bob and a drop's shake.
    const kick = s.uKick.value;
    if (!this.#flightFrame(now)) {
      const drop = Math.max(0, 1 - (now - this.#dropT0) / 600);
      const m = this.#reduced ? 0 : 1;
      const shake = m * (drop * 0.5 + kick * 0.12);
      const t = this.#time;
      // Always drifting a little; the kick punches down, the bass rocks it.
      const sway = m * (0.4 + 0.6 * this.#energyS) * (0.3 + 0.7 * this.#gate());
      this.#camera.position.set(
        Math.sin(t * 0.29) * 0.9 * sway + Math.sin(t * 61) * shake,
        CAM_H + m * (pulse * 0.08 - kick * 0.55 + Math.sin(t * 0.41) * 0.3 * sway) + Math.sin(t * 47) * shake,
        0,
      );
      this.#camera.lookAt(Math.sin(t * 0.17) * 2 * sway, LOOK_Y, -LOOK_D);
      this.#camera.rotateZ(m * (Math.sin(t * 0.19) * 0.022 * sway + this.#kickSide * kick * 0.012 + Math.sin(t * 0.7) * 0.006 * this.#shared.uBass.value));
      this.#passFlash = 0;
    }
    const fovKick = this.#flight && !this.#flight.back ? Math.sin(Math.PI * Math.min(1, (now - this.#flight.t0) / this.#flight.dur)) * 10 : 0;
    const dropKick = Math.max(0, 1 - (now - this.#dropT0) / 500) * 6;
    // The hyperjump: the view stretches to the white-out, then snaps back in the new world.
    const j = this.#jumpFrame(now);
    const stretch = j < 0 ? 0 : j < JUMP_SWAP ? Math.pow(j / JUMP_SWAP, 2) : Math.pow(1 - (j - JUMP_SWAP) / (1 - JUMP_SWAP), 3);
    this.#stretch = stretch;
    const fov = FOV + (this.#reduced ? 0 : fovKick + dropKick + kick * 2.2 + stretch * 50 + 4 * this.#mixBend() + 5 * (ch[10] - 0.4));
    if (fov !== this.#camera.fov) {
      this.#camera.fov = fov;
      this.#camera.updateProjectionMatrix();
    }
    this.#camera.updateMatrixWorld();
    this.#sky.position.copy(this.#camera.position);
    this.#floor.position.set(this.#camera.position.x, 0, this.#camera.position.z);
    rotY(this.#camera.position.x, this.#camera.position.z, this.#gridYaw, this.#v2);
    s.uCamGrid.value.set(this.#v2.x + this.#gridOff.x, this.#v2.y + this.#gridOff.y);
    s.uTunnel.value = this.#course % (RINGS * RING_GAP);
    const planet = this.#planet;
    planet.planet.visible = s.uGen.value.w > 0.001;
    if (planet.planet.visible) {
      planet.planet.position.set(this.#camera.position.x - 380, 75, this.#camera.position.z - 800);
      planet.planet.rotation.y += dt * 0.05;
      planet.planet.rotation.z = 0.35;
      planet.planet.scale.setScalar(120 * (1 + 0.035 * this.#shared.uBass.value + 0.03 * kick));
      planet.alpha.value = s.uGen.value.w;
      planet.lit.value = 0.1 + 0.3 * this.#shared.uBass.value;
      planet.ringLit.value = 0.3 + 0.6 * this.#shared.uBass.value;
    }
    this.#guardiansFrame(dt);
    this.#monoliths.visible = s.uGen.value.y > 0.001;
    if (this.#worldTunnel.visible) this.#worldTunnel.position.set(this.#camera.position.x, 10, this.#camera.position.z);
    this.#tunnel.visible = s.uGen.value.z > 0.001;
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
  #stretch = 0;

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
    if (this.#playing) this.#barClock += dt * (bpm / 240);
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
    const v = this.#speedF * (bpm / 60) * (14 + 16 * this.#energyS) * surge * (1 + 0.45 * this.#shared.uBass.value + 0.4 * this.#shared.uKick.value) * (1 + 7 * this.#stretch) * (0.2 + 0.8 * Math.min(1, this.#shared.uMix.value / 0.75) + 0.25 * Math.max(0, this.#mixBend())) * (0.75 + 0.6 * channels.bands[9]);
    this.#speed = this.#reduced ? 0 : v;
    // A jog scratches the world with the wheel (applied over ~50 ms).
    const scratch = this.#reduced ? 0 : this.#scratch * (1 - Math.exp(-dt / 0.05));
    this.#scratch -= scratch;
    const ds = this.#speed * dt + scratch;
    this.#course += ds;
    // The grid streams under a resting camera (a flight moves the camera itself).
    if (!this.#flight && ds !== 0) {
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
    this.#flow = (this.#flow + (this.#reduced ? 0 : (this.#speed * 1.2 + 14 * (1 - this.#vigil)) * (0.7 + 1.5 * channels.bands[8]) * dt)) % (11.42397 * 600);
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
    // Band colours settle in 180 ms (a change of channel crossfades slower).
    const u = Math.min(1, (now - this.#bandT0) / this.#bandMs);
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
      const size = GATE_R * (0.8 + 0.4 * t.sim[i]) * (1 + 0.14 * pulse * (0.4 + l) + 0.18 * l) * (0.55 + 0.45 * Math.min(1, this.#shared.uMix.value / 0.75));
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
      c.uBeamLevel.value[i] = this.#deckBase > 0 ? (playing ? (0.12 + Math.min(1, this.#deckLevel[i] * 1.6) * 0.5) * focus : loaded ? 0.03 : 0) * (1 - this.#mist * 0.5) * this.#gate() : 0;
      c.uBeamX.value[i] = this.#deckX[i] / this.#width;
      // Sway on the deck's own beat: synced decks swing together.
      const grid = loaded ? client.deckInfo[i]?.grid : null;
      let deckPhase = 0;
      if (playing && grid && grid.bpm > 0 && !this.#reduced) {
        const beats = ((d!.position + d!.rate * age - grid.first_beat) * grid.bpm) / 60;
        deckPhase = beats;
      }
      this.#deckBeat[i] = playing ? deckPhase : -1;
      c.uBeamSway.value[i] = this.#reduced ? 0 : Math.sin(Math.PI * deckPhase) * 0.05;
      this.#shared.uDeckLevel.value[i] = (playing ? 0.25 + Math.min(1, this.#deckLevel[i] * 1.8) * 0.75 : loaded ? 0.08 : 0) * this.#gate();
      this.#shared.uDeckPhase.value[i] = deckPhase;
    }
    c.uBeamY.value = this.#deckBase > 0 ? 1 - this.#deckBase / this.#height : 0;
    const drop = Math.max(0, 1 - (now - this.#dropT0) / 160);
    const cut = this.#reduced ? 0 : Math.max(0, 1 - (now - this.#cutT0) / CUT_MS);
    const flying = this.#flight ? 1 : 0;
    const kick = this.#shared.uKick.value;
    const st2 = this.#stretch;
    const white = this.#jumpT0 + JUMP_MS > now ? Math.max(0, 1 - Math.abs((now - this.#jumpT0) / JUMP_MS - JUMP_SWAP) / 0.12) : 0;
    // Passing through a phrase arch: a short flash and a fringe.
    const arch = Math.max(0, 1 - (now - this.#archPassT0) / 250);
    c.uFlash.value = this.#reduced ? 0 : this.#passFlash + drop * 0.55 + cut * 0.08 + kick * 0.035 + white * 1.4 + arch * 0.18;
    c.uAberr.value = this.#reduced ? 0 : pulse * 0.5 + kick * 2 + flying * 2.5 + drop * 5 + cut * 3 + st2 * 10 + channels.bands[11] * 1.5 + Math.max(0, 1 - (now - this.#archPassT0) / 300) * 3;
    c.uCut.value = cut;
    c.uMist.value = this.#mist;
    c.uTime.value = this.#time;
    c.uBloom.value = (1 + 0.15 * pulse + 0.25 * this.#shared.uBass.value + st2) * WORLDS[this.#worldF].bloom;
    // The mix volume: near black in silence, full at a normal mix, brighter hot.
    const m = this.#shared.uMix.value;
    c.uExposure.value = 0.08 + 0.92 * Math.pow(Math.min(1, m / 0.75), 0.8) + 0.3 * Math.max(0, this.#mixBend());
    const ripple = (now - this.#dropT0) / 1200;
    this.#shared.uRipple.value = ripple >= 0 && ripple < 1 && !this.#reduced ? ripple : -1;
  }

  /**
   * Bass: the low band through a fast envelope (12 ms attack, 160 ms release),
   * levelled against its recent peak so quiet and loud tracks both move the
   * world; a kick is a sharp rise above the slow average.
   */
  #bassFrame(now: number, dt: number, live: boolean) {
    const s = this.#shared;
    const raw = live && this.#playing ? Math.max(this.#o.viz.bands[0], (this.#o.viz.spectrum[0] + this.#o.viz.spectrum[1] + this.#o.viz.spectrum[2]) / 3) : 0;
    this.#bass += (raw - this.#bass) * (1 - Math.exp(-dt / (raw > this.#bass ? 0.012 : 0.16)));
    this.#bassPeak = Math.max(0.08, this.#bass, this.#bassPeak * Math.exp(-dt / 6));
    const n = Math.min(1.3, this.#bass / this.#bassPeak);
    this.#bassSlow += (n - this.#bassSlow) * (1 - Math.exp(-dt / 0.25));
    if (n > 0.7 && n - this.#bassSlow > 0.22 && now - this.#kickAt > 160) {
      this.#kickAt = now;
      this.#kickSide = -this.#kickSide;
    }
    this.#bassN = this.#reduced ? n * 0.4 : n;
    // No mix volume, no bumping: every reaction scales with the mix.
    const gate = this.#gate();
    s.uBass.value = this.#bassN * (1 - this.#vigil) * gate;
    const age = (now - this.#kickAt) / 1000;
    s.uKick.value = this.#reduced ? 0 : Math.exp(-age / 0.09) * gate;
    s.uKickAge.value = Math.min(99, age);
    const spec = s.uSpectrum.value;
    const k = 1 - Math.exp(-dt / 0.06);
    for (let i = 0; i < 32; i++) spec[i] += ((live ? (this.#o.viz.spectrum[i * 2] + this.#o.viz.spectrum[i * 2 + 1]) / 2 : 0) - spec[i]) * k;
  }

  /** Progressive generation: each layer builds over 5 s once enough music has played. */
  #generation(dt: number, live: boolean) {
    if (this.#playing && live) this.#genTime += dt * (0.6 + 0.8 * Math.min(1, this.#bassN));
    const s = this.#shared;
    const minutes = this.#genTime / 60;
    const level = (i: number) => Math.max(0, Math.min(1, (minutes - GENERATIONS[i].at) * 60 / GEN_BUILD_S));
    const m = WORLD_LAYERS[this.#worldF];
    const gate = (i: number) => (m[i] < 0 ? 1 : m[i] * level(i));
    s.uGen.value.set(gate(0), gate(1), gate(2), gate(3));
    s.uGen5.value = level(4);
    let reached = 0;
    for (let i = 0; i < GENERATIONS.length; i++) if (minutes >= GENERATIONS[i].at) reached = i + 1;
    if (reached > this.#genShown) {
      this.#genShown = reached;
      this.#o.onGeneration?.(reached, GENERATIONS[reached - 1].name);
    }
  }

  #drop(now: number) {
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
      /** Jump to generation `n` (0–5), fully built. */
      setGen: (n: number) => {
        this.#genTime = n > 0 ? (GENERATIONS[Math.min(n, GENERATIONS.length) - 1].at * 60 + GEN_BUILD_S + 0.1) : 0;
        this.#genShown = Math.min(this.#genShown, n);
      },
      /** Feed a MIDI message as if it came from the mixer, e.g. midi('left.lit2', 'press'). */
      midi: (control: string, event: 'press' | 'value' | 'delta', value: number | null = null) =>
        this.midiEvent({ type: 'midi', t: 0, raw: '', desc: '', control, event, value, action: null }),
      /** Jump to the next world now, as a climax would. */
      climax: () => this.#jump(this.#now()),
      /** Go straight to world `n` (no jump). */
      world: (n: number) => this.#enterWorld(((n % WORLDS.length) + WORLDS.length) % WORLDS.length, this.#now(), true),
      /** Mutate the genome now (strength 0..1). */
      mutate: (strength = 0.5) => this.#mutate(strength),
      /** Snap the genome to its targets (for captures). */
      settle: () => this.#genome.set(this.#genomeTarget),
      /** A new track's land, swept in. */
      reseed: () => this.#reseed(this.#now()),
      /** Evolve the current world to `e` (0..1). */
      evolve: (e: number) => (this.#worldTime = e * EVO_S),
      /** Force a kick. */
      kick: () => (this.#kickAt = this.#now()),
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
  /**
   * Pixel art: the world renders on a virtual grid about 360 pixels tall, without
   * anti-aliasing, and the composite shows each virtual pixel as a hard square.
   */
  #applySize() {
    this.#renderer.setPixelRatio(Math.min(this.#dpr, 1));
    this.#renderer.setSize(this.#width, this.#height, false);
    this.#camera.aspect = this.#width / this.#height;
    this.#camera.updateProjectionMatrix();
    const scale = pixelScale(this.#height);
    const w = Math.max(1, Math.ceil(this.#width / scale)),
      h = Math.max(1, Math.ceil(this.#height / scale));
    const make = (rw: number, rh: number, samples = 0) =>
      new THREE.WebGLRenderTarget(Math.max(1, rw), Math.max(1, rh), {
        type: this.#rtType,
        samples,
        depthBuffer: true,
        colorSpace: THREE.NoColorSpace,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
      });
    for (const rt of [this.#rtScene, this.#rtA, this.#rtB, this.#rtC, this.#rtD]) rt?.dispose();
    this.#rtScene = make(w, h, 0);
    this.#rtA = make(w >> 1, h >> 1);
    this.#rtB = make(w >> 1, h >> 1);
    this.#rtC = make(w >> 2, h >> 2);
    this.#rtD = make(w >> 2, h >> 2);
    const full = this.#renderer.getDrawingBufferSize(new THREE.Vector2());
    this.#post.composite.uniforms.uRes.value.copy(full);
    this.#post.composite.uniforms.uLow.value.set(w, h);
    // Point sprites are sized in render-target pixels.
    this.#shared.uDpr.value = 1 / scale;
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
    for (const g of this.#guardians) for (const m of [g.mesh, g.inner]) (m.material as THREE.Material).dispose();
    for (const m of [this.#sky, this.#floor, this.#streaks, this.#monoliths, this.#tunnel, this.#packets, this.#worldTunnel, this.#arches]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    for (const m of [this.#post.bright, this.#post.blur, this.#post.composite]) m.dispose();
    for (const rt of [this.#rtScene, this.#rtA, this.#rtB, this.#rtC, this.#rtD]) rt.dispose();
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

/**
 * A branch from the split to its gate, in the shape of the world: 0 curves,
 * 1 swoops (Chromozon), 2 angles (Tunnelwerk), 3 waves (Nachtflug), 4 steps (Kupferzeit).
 */
function pathCurve(world: number, gx: number, gz: number, tx: number, tz: number, len: number, i: number) {
  const az = SPLIT_Z;
  switch (world) {
    case 1:
      return (u: number, o: Pt) => bezier(0, az, -gx * 0.35, az - len * 0.45, gx * 1.15, gz + len * 0.25, gx, gz, u, o);
    case 2: {
      // Straight out, one hard turn, straight in.
      const kx = gx * 0.18,
        kz = az + (gz - az) * 0.55;
      return (u: number, o: Pt) => {
        if (u < 0.5) {
          const v = u / 0.5;
          o.x = kx * v;
          o.y = az + (kz - az) * v;
        } else {
          const v = (u - 0.5) / 0.5;
          o.x = kx + (gx - kx) * v;
          o.y = kz + (gz - kz) * v;
        }
      };
    }
    case 3: {
      const bz = az - len * 0.38,
        cx = gx - tx * len * 0.38,
        cz = gz - tz * len * 0.38;
      const phase = i * 1.3;
      return (u: number, o: Pt) => {
        bezier(0, az, 0, bz, cx, cz, gx, gz, u, o);
        // A runway that weaves, still at the split and at the gate.
        const w = Math.sin(u * Math.PI * 3 + phase) * 2.6 * Math.sin(u * Math.PI);
        o.x += -tz * w;
        o.y += tx * w;
      };
    }
    case 4:
      return (u: number, o: Pt) => {
        o.x = gx * smoothstep(0.25, 0.75, u);
        o.y = az + (gz - az) * u;
      };
    default: {
      const bz = az - len * 0.38,
        cx = gx - tx * len * 0.38,
        cz = gz - tz * len * 0.38;
      return (u: number, o: Pt) => bezier(0, az, 0, bz, cx, cz, gx, gz, u, o);
    }
  }
}

/** A small seeded random generator (0..1). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(a: number, b: number, v: number) {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function hexVec(hex: string, out: THREE.Vector3) {
  const n = Number.parseInt(hex.slice(1), 16);
  out.set(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
