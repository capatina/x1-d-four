import * as THREE from 'three';
import { client } from '../lib/client.svelte';
import { DECK_COLORS } from '../lib/decks';
import type { ExploreMsg, ExploreNode, Track } from '../lib/protocol';
import type { VizFrame } from '../lib/viz';
import { waves } from '../lib/waves';
import { keeperAtlas, runeAtlas } from './atlas';
import { Labels, type Obstacle } from './labels';
import { makeGrass, makeLand, makeLife, makeSky, makeTrees, makeWater, type Wrapped } from './meshes';
import { BAND_PALETTE, REALM_SHADER } from './palette';
import {
  GRAND_SEGMENTS,
  makeBillboards,
  makeKeepers,
  makeRoutes,
  makeSpires,
  MAX_CHILDREN,
  MAX_GRANDS,
  ROUTE_SEGMENTS,
  SPIRE_TOP,
  TAKEN_SLOT,
} from './realm';
import { hashString, hexInto, LAND_DX, LAND_DZ, makeShared, RIPPLE_PERIOD, riverW } from './shared';

export type EngineStats = {
  fps: number;
  calls: number;
  triangles: number;
  dpr: number;
  /** CPU time of the world frame (JS + draw submission), ms. */
  frameMs: number;
  /** GPU time of the world, ms (only with ?qa, from timer queries). */
  gpuMs: number;
  growth: number;
  age: number;
  course: number;
  speed: number;
};
export type EngineOptions = {
  canvas: HTMLCanvasElement;
  labels: HTMLElement;
  /** Vignette edge that brightens as a gate passes overhead (CSS opacity, compositor only). */
  gate?: HTMLElement | null;
  viz: VizFrame;
  track: (id: string) => Track | undefined;
  onAim: (id: string) => void;
  onDive: (id: string) => void;
  onAimDelta: (delta: number) => void;
  reducedMotion: boolean;
  onStats?: (stats: EngineStats) => void;
};

const FOV = 52;
const CAMERA = new THREE.Vector3(0, 8, 27);
const TARGET = new THREE.Vector3(0, 3, -65);
/** The Wayfinder floats this far down the Current (traveller z), where it shows above the strip. */
const WAY_Z = -16;
/** Shard top and scale of a child spire; its gate is a rune ring hovering round the shard's tip. */
const SPIRE_Y = 6.3;
const SPIRE_SCALE = 0.86;
const GATE_Y = 3.75;
const GATE_R = 1.75;
const GRAND_Y = 5.4;
const GRAND_SCALE = 0.35;
/** The seed wipe: new land arrives from the horizon to 40 units ahead in 300 ms. */
const WIPE_NEAR = -40;
const WIPE_FAR = -380;
const WIPE_MS = 300;
/** Course travelled past a wipe before its old segment is forgotten (out of sight behind). */
const WIPE_FORGET = 245;
const NONE = -1e6;
/** Realm colours settle in 180 ms; the aim in 120 ms; the over-brightness lasts 90 ms. */
const BAND_MS = 180;
const AIM_MS = 120;
const FLOURISH_MS = 90;
/** Course impulse of a passage: ×6, decaying with τ 220 ms. */
const IMPULSE_TAU = 0.22;
/** The passage: heading swing (±22° max, back to 0 by 300 ms), the gate sweep (160 ms). */
const PASSAGE_MS = 300;
const SWING_MAX = (22 * Math.PI) / 180;
const SWEEP_MS = 160;
const SWEEP_R = 40;
/** Keepers' lantern pools and loop rings lie this far down the Current. */
const POOL_Z = -12;

/**
 * The Wayfaring: one forward render pass over a world that streams toward a
 * fixed camera. State changes land in the message frame (`setExplore` is
 * synchronous and writes labels, aim and uniforms at once); flourish decays
 * from there. The frame loop allocates nothing.
 */
export class ExploreEngine {
  readonly #o: EngineOptions;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(FOV, 1, 0.2, 650);
  /** Never yawed: projects the fixed slots for the labels. */
  readonly #rest = new THREE.PerspectiveCamera(FOV, 1, 0.2, 650);
  readonly #shared = makeShared();
  readonly #wrapped: Wrapped[] = [];
  readonly #spires = makeSpires(this.#shared);
  readonly #routes = makeRoutes(this.#shared);
  readonly #bills = makeBillboards(this.#shared);
  readonly #labels: Labels;
  readonly #resize: ResizeObserver;
  readonly #point = new THREE.Vector3();
  readonly #stats: EngineStats = {
    fps: 0,
    calls: 0,
    triangles: 0,
    dpr: 1,
    frameMs: 0,
    gpuMs: 0,
    growth: 0,
    age: 0,
    course: 0,
    speed: 0,
  };

  // Explore state
  #msg: ExploreMsg | null = null;
  #children: ExploreNode[] = [];
  #aimSlot = -1;
  #aimAt = -1e9;
  #localAim: string | null = null;
  #localAimAt = -1e9;
  readonly #slotX = new Float32Array(MAX_CHILDREN);
  readonly #slotZ = new Float32Array(MAX_CHILDREN);
  readonly #slotTop = new Float32Array(MAX_CHILDREN);
  readonly #anchors = new Float32Array(MAX_CHILDREN * 2);
  readonly #gates = new Float32Array(MAX_CHILDREN * 2);
  #grandCount = 0;
  #obstacles: Obstacle[] = [];

  // Travel
  #course = 0;
  #speedF = 0;
  #playing = false;
  #rampFrom = 0;
  #rampT0 = -1e9;
  #energyS = 0;
  #speed = 0;
  #impulseT0 = -1e9;
  #impulseDir = 1;

  // Land segments (the seed wipe)
  readonly #seeds = [0, 0, 0];
  readonly #bounds = [NONE, NONE];
  readonly #realms = [0, 0, 0];
  readonly #starts = [NONE, NONE];
  #sweep = -1;
  #sweepT0 = -1e9;
  #sweepFrom = 0;
  #sweepTo = 0;

  // Realm colours
  #bandTarget = 0;
  #bandFrom = 0;
  #bandT0 = -1e9;
  readonly #accentFrom = new THREE.Vector3();
  readonly #accentTo = new THREE.Vector3();

  // Wayfinder
  #wayX = 0;
  #beamT0 = -1e9;

  // The passage (commit, scout, back) and the mist of scouting
  #passT0 = -1e9;
  #passDir = 0;
  #passYaw = 0;
  #yawFrom = 0;
  #yaw = 0;
  #passX = 0;
  #passZ = 0;
  #takenSlot = -1;
  #mistFrom = 0;
  #mistTo = 0;
  #mistT0 = -1e9;
  #routeRise = 1;

  // Keepers
  readonly #keepers: ReturnType<typeof makeKeepers>;
  readonly #keeperX = new Float32Array(4);
  #keeperBase = 0;
  readonly #keeperLevel = new Float32Array(4);
  readonly #flareAt = new Float64Array(4).fill(-1e9);
  readonly #wasLoading = [false, false, false, false];
  readonly #wasTrack: (string | null)[] = [null, null, null, null];
  #vigil = 0;

  // Time, music, frame pacing
  #raf = 0;
  #last = 0;
  #time = 0;
  #musicTime = 0;
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
  readonly #levels = new Float32Array(3);
  readonly #flicker = new Float32Array(8);
  #onsets = 0;
  #gust = 0;

  constructor(o: EngineOptions) {
    this.#o = o;
    this.#reduced = o.reducedMotion;
    this.#labels = new Labels(o.labels, o.track);
    const params = new URLSearchParams(location.search);
    this.#renderer = new THREE.WebGLRenderer({
      canvas: o.canvas,
      antialias: true,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#maxDpr = Math.min(1.5, Math.max(0.75, Number(params.get('dpr')) || window.devicePixelRatio || 1));
    this.#dpr = this.#maxDpr;
    this.#adaptive = params.get('adaptive') !== '0';
    const s = this.#shared;
    const runes = new THREE.CanvasTexture(runeAtlas());
    runes.flipY = false;
    runes.generateMipmaps = true;
    runes.minFilter = THREE.LinearMipmapLinearFilter;
    runes.anisotropy = 4;
    s.uRunes.value = runes;
    for (let i = 0; i < 4; i++) hexInto(DECK_COLORS[i], s.uDeckColor.value, i * 3);
    const keeperTex = new THREE.CanvasTexture(keeperAtlas());
    keeperTex.flipY = false;
    this.#keepers = makeKeepers(s, keeperTex);
    const grass = makeGrass(s);
    const trees = makeTrees(s);
    const swallows = makeLife(s, false);
    const butterflies = makeLife(s, true);
    this.#wrapped.push(grass, trees[0], trees[1], butterflies);
    this.#scene.add(
      makeSky(s),
      makeLand(s),
      makeWater(s),
      grass,
      ...trees,
      swallows,
      butterflies,
      this.#routes.mesh,
      this.#spires.mesh,
      this.#bills.mesh,
      this.#keepers.mesh,
    );
    this.#setBand(0, true);
    this.#camera.position.copy(CAMERA);
    this.#camera.lookAt(TARGET);
    this.#rest.position.copy(CAMERA);
    this.#rest.lookAt(TARGET);
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
      this.#spires.mesh.geometry.instanceCount = 0;
      this.#routes.mesh.geometry.setDrawRange(0, 0);
      this.#hideGates();
      return;
    }
    const children = msg.nodes.filter((n) => n.parent === msg.current).slice(0, MAX_CHILDREN);
    const band = msg.band === 'mid' ? 1 : msg.band === 'high' ? 2 : 0;
    const moved = !!prev && prev.current !== msg.current;
    const banded = !!prev && prev.band !== msg.band;
    const seed = 40 + hashString(`${msg.current}|${msg.band}`) * 320;
    if (!prev || !prev.current) {
      this.#seeds[0] = seed;
      this.#realms[0] = band;
      this.#setBand(band, true);
    } else {
      if (banded) this.#setBand(band, false);
      if (moved || banded) this.#wipe(seed, band, now);
    }
    if (moved && !this.#reduced) {
      this.#impulseT0 = now;
      this.#impulseDir = msg.reason === 'back' ? -1 : 1;
    }
    // Commit and scout take the route that was aimed: its slot is where current now came from.
    const forward = moved && (msg.reason === 'commit' || msg.reason === 'dive');
    const taken = forward ? this.#children.findIndex((c) => c.id === msg.current) : -1;
    if (taken >= 0) {
      this.#passX = this.#slotX[taken];
      this.#passZ = this.#slotZ[taken];
    }
    this.#takenSlot = taken;

    const fresh = !prev || moved || banded || children.length !== this.#children.length;
    this.#children = children;
    // A local aim (keys, wheel, click) wins until the server has caught up with it.
    let aim = msg.aim;
    if (this.#localAim && now - this.#localAimAt < 350 && msg.reason === 'aim' && !fresh) aim = this.#localAim;
    else this.#localAim = null;
    if (fresh) {
      this.#layoutSlots(msg);
      this.#writeRoutes(msg);
      this.#labels.replace(children, aim, msg.reason === 'back' ? 'back' : moved ? 'forward' : 'swap', this.#reduced, this.#width);
      this.#layoutLabels();
      this.#shared.uRoute.value.fill(0);
      this.#shared.uGate.value.fill(0);
      this.#aimSlot = -1;
    } else {
      this.#layoutGrands(msg);
      this.#writeRoutes(msg);
      this.#labels.update(children, aim);
      this.#layoutLabels();
    }
    this.#writeSpires(msg);
    const slot = children.findIndex((n) => n.id === aim);
    this.#routeRise = fresh && this.#reduced ? 0 : 1;
    this.#aim(slot, now, !fresh);
    if (forward && taken >= 0) this.#passage(1, now);
    else if (moved && msg.reason === 'back' && slot >= 0) {
      // Back: the gate we came through returns to its slot.
      this.#passX = this.#slotX[slot];
      this.#passZ = this.#slotZ[slot];
      this.#passage(-1, now);
    }
    if (taken >= 0) this.#shared.uRoute.value[TAKEN_SLOT] = 1;
    if (this.#qa) this.#qaExpect(msg.reason, client.exploreAt, aim, children.length);
  }

  /**
   * The passage, all from the message frame: the heading swings toward the
   * route (fastest at frame 0, level again by 300 ms), a gate ring sweeps
   * over the camera (passing at ~110 ms, when the vignette edge brightens),
   * and the course surges. A second one restarts from the current values.
   */
  #passage(dir: number, now: number) {
    if (this.#reduced) return;
    this.#yawFrom = this.#yaw;
    const bearing = Math.atan2(this.#passX - CAMERA.x, CAMERA.z - this.#passZ);
    this.#passYaw = Math.max(-SWING_MAX, Math.min(SWING_MAX, bearing)) * dir;
    this.#passDir = dir;
    this.#passT0 = now;
    // The labels ride the swing (one compositor animation, written once).
    const aspect = this.#width / this.#height;
    const half = (this.#width / 2) / (Math.tan((FOV * Math.PI) / 360) * aspect);
    const frames: Keyframe[] = [];
    for (let k = 0; k <= 10; k++) {
      const u = k / 10;
      const yaw = this.#yawFrom * (1 - u) * (1 - u) + this.#passYaw * 6.75 * u * (1 - u) * (1 - u);
      frames.push({ translate: `${(-Math.tan(yaw) * half).toFixed(1)}px 0`, offset: u });
    }
    this.#o.labels.animate(frames, { duration: PASSAGE_MS, easing: 'linear' });
    if (dir > 0)
      this.#o.gate?.animate(
        [
          { opacity: 0, offset: 0 },
          { opacity: 0, offset: 0.27 },
          { opacity: 0.35, offset: 0.42 },
          { opacity: 0, offset: 1 },
        ],
        { duration: 260, easing: 'linear' },
      );
  }

  /** Scouting ahead (dives since the last load): the land beyond is misted. */
  setScouting(depth: number) {
    const target = depth > 0 ? 1 : 0;
    if (target === this.#mistTo) return;
    this.#mistFrom = this.#shared.uMist.value;
    this.#mistTo = target;
    this.#mistT0 = this.#reduced ? -1e9 : this.#now();
  }

  /** Keepers stand above their deck cards: centre x per deck and the strip's top (viewport px). */
  setKeepers(xs: ArrayLike<number>, baseY: number) {
    for (let i = 0; i < 4; i++) this.#keeperX[i] = xs[i] ?? 0;
    this.#keeperBase = baseY;
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
  /** Header boxes the labels keep clear of (viewport px). */
  setObstacles(rects: Obstacle[]) {
    this.#obstacles = rects;
    this.#layoutLabels();
  }
  setHint(text: string) {
    this.#labels.setHint(text);
  }
  setReducedMotion(reduced: boolean) {
    this.#reduced = reduced;
    if (reduced) this.#impulseT0 = -1e9;
  }
  refreshLabels() {
    this.#labels.refresh();
    this.#layoutLabels();
  }

  #aim(slot: number, now: number, flourish: boolean) {
    const s = this.#shared;
    const prev = this.#aimSlot;
    this.#aimSlot = slot;
    const id = slot >= 0 ? this.#children[slot].id : null;
    this.#labels.setAim(id);
    if (slot === prev) return;
    // Frame 0: the new route and ring are fully lit; the old ones decay from where they are.
    if (slot >= 0) {
      s.uRoute.value[slot] = this.#routeRise;
      s.uGate.value[slot] = 1;
    }
    this.#routeRise = 1;
    this.#aimAt = flourish ? now : -1e9;
    // The beam snaps; its old direction fades over the aim's settle time.
    const way = s.uWay.value,
      wp = s.uWayPrev.value;
    wp.x = way.z;
    wp.y = way.w;
    wp.z = prev >= 0 && slot >= 0 ? 1 : 0;
    this.#beamT0 = now;
    if (slot >= 0) {
      this.#beamTo(slot);
      const h = s.uHerald.value;
      h.set(this.#wayX, WAY_Z, this.#slotX[slot], this.#slotZ[slot]);
      s.uHeraldY.value = GATE_Y + 0.4;
      s.uHeraldT.value = this.#reduced ? 2 : 0;
    } else s.uHeraldT.value = -1;
  }

  #beamTo(slot: number) {
    const way = this.#shared.uWay.value;
    const dx = this.#slotX[slot] - this.#wayX,
      dz = this.#slotZ[slot] - WAY_Z;
    const len = Math.hypot(dx, dz) || 1;
    way.z = dx / len;
    way.w = dz / len;
  }

  #setBand(band: number, instant: boolean) {
    const s = this.#shared;
    this.#bandFrom = instant ? band : s.uBand.value;
    this.#bandTarget = band;
    this.#bandT0 = instant ? -1e9 : this.#now();
    s.uRealmNow.value = band;
    this.#accentFrom.copy(s.uAccent.value);
    hexVec(BAND_PALETTE[band === 1 ? 'mid' : band === 2 ? 'high' : 'low'].css, this.#accentTo);
    if (instant) {
      s.uBand.value = band;
      s.uAccent.value.copy(this.#accentTo);
    }
  }

  /**
   * New land ahead: another terrain seed takes over from 40 units on, swept in
   * from the horizon in 300 ms (ahead of you, never under you). A third wipe
   * before the second has passed replaces the far segment in place.
   */
  #wipe(seed: number, realm: number, now: number) {
    const c = this.#course;
    let j: number;
    if (this.#bounds[0] <= NONE) j = 0;
    else if (this.#bounds[1] <= NONE) j = 1;
    else {
      this.#seeds[2] = seed;
      this.#realms[2] = realm;
      this.#starts[1] = c;
      return;
    }
    this.#seeds[j + 1] = seed;
    this.#realms[j + 1] = realm;
    this.#starts[j] = c;
    this.#sweep = j;
    this.#sweepFrom = WIPE_FAR - c;
    this.#sweepTo = WIPE_NEAR - c;
    this.#sweepT0 = this.#reduced ? -1e9 : now;
    this.#bounds[j] = this.#reduced ? this.#sweepTo : this.#sweepFrom;
    if (j === 1) this.#bounds[1] = Math.min(this.#bounds[1], this.#bounds[0] - 1);
  }

  // ---------------------------------------------------------------------------
  // Layout: fixed slots on an arc (d = 44…92), projected only on change or resize.

  #layoutSlots(msg: ExploreMsg) {
    const n = this.#children.length;
    const aspect = this.#width / this.#height;
    const tan = Math.tan((FOV * Math.PI) / 360);
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0.5 : 0.09 + (i * 0.82) / (n - 1);
      const d = 44 + (1 - Math.abs(f - 0.5) * 2) * 48;
      this.#slotX[i] = (f - 0.5) * 2 * d * tan * aspect;
      this.#slotZ[i] = 27 - d;
    }
    this.#layoutGrands(msg);
    this.#project();
  }

  #layoutGrands(msg: ExploreMsg) {
    this.#grandCount = 0;
    for (let i = 0; i < this.#children.length; i++) {
      let count = 0;
      for (const n of msg.nodes) if (n.parent === this.#children[i].id && count < 4 && this.#grandCount < MAX_GRANDS) count++, this.#grandCount++;
    }
  }

  /** Screen anchors of the spire tops and gates, from the resting camera. */
  #project() {
    this.#rest.aspect = this.#width / this.#height;
    this.#rest.updateProjectionMatrix();
    this.#rest.updateMatrixWorld();
    for (let i = 0; i < this.#children.length; i++) {
      const top = SPIRE_Y + SPIRE_TOP * SPIRE_SCALE * this.#heightOf(this.#children[i].id);
      this.#slotTop[i] = top;
      this.#point.set(this.#slotX[i], top, this.#slotZ[i]).project(this.#rest);
      this.#anchors[i * 2] = (this.#point.x * 0.5 + 0.5) * this.#width;
      this.#anchors[i * 2 + 1] = (-this.#point.y * 0.5 + 0.5) * this.#height;
      this.#point.set(this.#slotX[i], GATE_Y, this.#slotZ[i]).project(this.#rest);
      this.#gates[i * 2] = (this.#point.x * 0.5 + 0.5) * this.#width;
      this.#gates[i * 2 + 1] = (-this.#point.y * 0.5 + 0.5) * this.#height;
    }
  }

  #heightOf(id: string) {
    return 0.86 + hashString(`${id}#h`) * 0.3;
  }

  #layoutLabels() {
    if (!this.#labels.items.length) return;
    this.#labels.layout(this.#anchors, this.#width, this.#height - this.#bottomInset - 16, this.#obstacles);
  }

  #writeSpires(msg: ExploreMsg) {
    const { spire, info, aSpire, aInfo, mesh } = this.#spires;
    let k = 0;
    const n = this.#children.length;
    for (let i = 0; i < n; i++) {
      const c = this.#children[i];
      spire.set([this.#slotX[i], SPIRE_Y, this.#slotZ[i], SPIRE_SCALE], k * 4);
      info.set([hashString(c.id), c.sim, i, this.#heightOf(c.id)], k * 4);
      k++;
      const bill = this.#bills.bill;
      bill[i * 4] = this.#slotX[i];
      bill[i * 4 + 1] = GATE_Y;
      bill[i * 4 + 2] = this.#slotZ[i];
      bill[i * 4 + 3] = GATE_R;
    }
    for (let i = n; i < MAX_CHILDREN; i++) this.#bills.bill[i * 4 + 3] = -1;
    this.#bills.aBill.needsUpdate = true;
    for (let i = 0; i < n; i++) {
      const grands = this.#grandsOf(msg, this.#children[i].id);
      for (let j = 0; j < grands.length && k < MAX_CHILDREN + MAX_GRANDS; j++) {
        const g = grands[j];
        const o = j - (grands.length - 1) / 2;
        spire.set([this.#slotX[i] + o * 4.6, GRAND_Y, this.#slotZ[i] - 20 - Math.abs(o) * 5, GRAND_SCALE], k * 4);
        info.set([hashString(g.id), g.sim, 8 + i, this.#heightOf(g.id)], k * 4);
        k++;
      }
    }
    mesh.geometry.instanceCount = k;
    aSpire.needsUpdate = true;
    aInfo.needsUpdate = true;
  }

  #grandsOf(msg: ExploreMsg, id: string) {
    const out: ExploreNode[] = [];
    for (const n of msg.nodes) if (n.parent === id && out.length < 4) out.push(n);
    return out;
  }

  #hideGates() {
    for (let i = 0; i < MAX_CHILDREN; i++) this.#bills.bill[i * 4 + 3] = -1;
    this.#bills.aBill.needsUpdate = true;
  }

  /** Ley routes from the vessel to every gate, and on to the far spires. */
  #writeRoutes(msg: ExploreMsg) {
    const r = this.#routes;
    let seg = 0;
    const n = this.#children.length;
    for (let i = 0; i < n; i++) seg = this.#route(seg, i, 0, 9, this.#slotX[i], this.#slotZ[i], ROUTE_SEGMENTS, 1.25, 1.6);
    // The taken route keeps its own place in the buffer (full light, fading over the passage).
    seg = Math.max(seg, this.#takenAt(n));
    if (this.#takenSlot >= 0) this.#route(seg, TAKEN_SLOT, 0, 9, this.#passX, this.#passZ, ROUTE_SEGMENTS, 1.25, 1.6);
    seg += ROUTE_SEGMENTS;
    for (let i = 0; i < n; i++) {
      const grands = this.#grandsOf(msg, this.#children[i].id);
      for (let j = 0; j < grands.length; j++) {
        const o = j - (grands.length - 1) / 2;
        const gx = this.#slotX[i] + o * 4.6,
          gz = this.#slotZ[i] - 20 - Math.abs(o) * 5;
        seg = this.#route(seg, 8 + i, this.#slotX[i], this.#slotZ[i] - 1.5, gx, gz, GRAND_SEGMENTS, 0.5, 1);
      }
    }
    r.mesh.geometry.setDrawRange(0, seg * 6);
    r.aPos.needsUpdate = true;
    r.aRoute.needsUpdate = true;
  }

  #takenAt(n: number) {
    return n * ROUTE_SEGMENTS;
  }

  /** One curved strip from (x0, z0) to (x1, z1): leaves straight ahead, bends late. */
  #route(seg: number, slot: number, x0: number, z0: number, x1: number, z1: number, count: number, half: number, bend: number) {
    const { positions: P, routes: R } = this.#routes;
    let dist = 0;
    for (let k = 0; k < count; k++) {
      const t0 = k / count,
        t1 = (k + 1) / count;
      const ax = x0 + (x1 - x0) * t0 ** bend,
        az = z0 + (z1 - z0) * t0;
      const bx = x0 + (x1 - x0) * t1 ** bend,
        bz = z0 + (z1 - z0) * t1;
      const tx = bx - ax,
        tz = bz - az;
      const len = Math.hypot(tx, tz) || 1;
      const nx = -tz / len,
        nz = tx / len;
      const d0 = dist,
        d1 = dist + len;
      dist = d1;
      const v = seg * 6;
      // Two triangles: (a−, a+, b+), (a−, b+, b−).
      const corners = [
        [ax, az, -1, t0, d0],
        [ax, az, 1, t0, d0],
        [bx, bz, 1, t1, d1],
        [ax, az, -1, t0, d0],
        [bx, bz, 1, t1, d1],
        [bx, bz, -1, t1, d1],
      ] as const;
      for (let c = 0; c < 6; c++) {
        const [cx, cz, side, u, d] = corners[c];
        P[(v + c) * 3] = cx + nx * half * side;
        P[(v + c) * 3 + 1] = 0;
        P[(v + c) * 3 + 2] = cz + nz * half * side;
        R[(v + c) * 4] = slot;
        R[(v + c) * 4 + 1] = u;
        R[(v + c) * 4 + 2] = side;
        R[(v + c) * 4 + 3] = d;
      }
      seg++;
    }
    return seg;
  }

  // ---------------------------------------------------------------------------
  // The frame: tempo-clocked travel, decays, uniforms, one render.

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

  #tick(now: number, dt: number, raw: number, begin: number) {
    this.#time += dt;
    const s = this.#shared;
    const viz = this.#o.viz;
    const live = viz.at > 0 && now - viz.at < 500;

    // Music: smoothed bands, spectrum, onsets.
    const k = 1 - Math.exp(-dt / 1.4);
    let energy = 0;
    for (let i = 0; i < 3; i++) {
      this.#levels[i] += ((live ? viz.bands[i] : 0) - this.#levels[i]) * k;
      energy += this.#levels[i] / 3;
    }
    if (live && energy > 0.015) this.#musicTime += dt * (0.3 + energy * 0.7);
    if (viz.onsets !== this.#onsets) {
      this.#onsets = viz.onsets;
      if (live) this.#gust = Math.min(1, this.#gust + 0.08);
    }
    this.#gust *= Math.exp(-dt / 1.8);
    const spec = s.uSpectrum.value;
    for (let i = 0; i < 64; i++) spec[i] += ((live ? viz.spectrum[i] : 0) - spec[i]) * k;
    const kf = 1 - Math.exp(-dt / 0.4);
    const bin0 = this.#bandTarget === 0 ? 0 : this.#bandTarget === 1 ? 22 : 44;
    for (let i = 0; i < 8; i++) this.#flicker[i] += ((live ? viz.spectrum[bin0 + i] : 0) - this.#flicker[i]) * kf;
    s.uFlicker.value.set(this.#flicker);
    for (let i = 0; i < 4; i++) {
      const d = live ? viz.decks[i] : undefined;
      const target = d ? (d[0] + d[1] + d[2]) / 3 : 0;
      s.uDecks.value.setComponent(i, s.uDecks.value.getComponent(i) + (target - s.uDecks.value.getComponent(i)) * k);
    }

    this.#travel(now, dt, energy, live);
    this.#decays(now, dt);

    s.uTime.value = this.#time;
    s.uMotion.value = this.#reduced ? 0 : 1;
    // Vigil: nothing playing. Wind to ambient, ley lines still, runes to embers; light holds.
    this.#vigil = this.#playing
      ? Math.max(0, this.#vigil - dt / 0.6)
      : Math.min(1, this.#vigil + dt / 1.5);
    s.uVigil.value = this.#vigil;
    s.uWind.value += (energy * (1 - this.#vigil * 0.7) + 0.06 * this.#vigil + this.#gust * 0.15 - s.uWind.value) * k;
    s.uGrowth.value = 1 - Math.exp(-this.#musicTime / 100);
    s.uLife.value += (Math.min(1, energy * 0.85 + s.uGrowth.value * 0.7) - s.uLife.value) * (1 - Math.exp(-dt / 8));

    this.#passageFrame(now);
    this.#keepersFrame(now, dt, live);
    this.#camera.position.copy(CAMERA);
    this.#camera.lookAt(
      CAMERA.x + Math.sin(this.#yaw) * (CAMERA.z - TARGET.z),
      TARGET.y,
      CAMERA.z - Math.cos(this.#yaw) * (CAMERA.z - TARGET.z),
    );
    this.#camera.updateMatrixWorld();

    if (this.#qa) this.#gpuBegin();
    this.#renderer.render(this.#scene, this.#camera);
    if (this.#qa) this.#gpuEnd();
    this.#drawEma += (performance.now() - begin - this.#drawEma) * 0.05;
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
      st.growth = s.uGrowth.value;
      st.age = s.uAge.value;
      st.course = this.#course;
      st.speed = this.#speed;
      st.gpuMs = this.#gpuMs;
      this.#o.onStats(st);
      this.#statsAt = now;
    }
  }

  // ---------------------------------------------------------------------------
  // QA (?qa): a clock that can be frozen and stepped (WAAPI animations with it),
  // message-to-frame records and GPU timer queries. Never active otherwise.

  #qa: Qa | null = null;
  #gl: WebGL2RenderingContext | null = null;
  #timer: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  readonly #queries: (WebGLQuery | null)[] = [null, null, null, null];
  #queryHead = 0;
  #gpuMs = 0;

  #now() {
    return this.#qa?.frozen ? this.#qa.clock : performance.now();
  }

  #qaExpect(reason: string, recv: number, aim: string | null, count: number) {
    if (!this.#qa) return;
    this.#qa.pending = { reason, recv, handled: performance.now(), aim, count };
  }

  /** In the first animation frame after a message: are its label text and lit route there? */
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
    const routeOk = !p.aim || (slot >= 0 && this.#shared.uRoute.value[slot] >= 0.999 && this.#shared.uGate.value[slot] >= 1);
    qa.records.push({ reason: p.reason, recv: p.recv, handled: p.handled, raf, frame: begin, labelOk, routeOk });
    if (qa.records.length > 500) qa.records.shift();
  }

  #gpuBegin() {
    const gl = this.#gl,
      t = this.#timer;
    if (!gl || !t) return;
    const q = this.#queries[this.#queryHead];
    if (q) {
      // The query from four frames ago: read it if it's ready, else drop this frame's sample.
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
  #queryActive = false;
  #gpuEnd() {
    if (!this.#queryActive || !this.#gl || !this.#timer) return;
    this.#gl.endQuery(this.#timer.TIME_ELAPSED_EXT);
    this.#queryActive = false;
    this.#queryHead = (this.#queryHead + 1) % this.#queries.length;
  }

  /** The QA handle (window.__wayfaring with ?qa). */
  qa() {
    if (!this.#qa) {
      this.#qa = { frozen: false, clock: 0, anims: new Map(), pending: null, records: [], gpu: [] };
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
      /** Hold the world (and its CSS animations) still at this instant. */
      freeze: () => {
        qa.clock = performance.now();
        qa.frozen = true;
        qa.anims.clear();
        for (const a of document.getAnimations()) {
          a.pause();
          qa.anims.set(a, qa.clock - Number(a.currentTime ?? 0));
        }
      },
      /** Step the frozen world by `ms` in 1/120 s frames. */
      advance: (ms: number) => {
        sync();
        let left = ms;
        while (left > 0) {
          const step = Math.min(1000 / 120, left);
          qa.clock += step;
          left -= step;
          this.#tick(qa.clock, step / 1000, step, performance.now());
        }
        sync();
      },
      resume: () => {
        qa.frozen = false;
        for (const a of qa.anims.keys()) if (a.playState === 'paused') a.play();
        qa.anims.clear();
        this.#last = performance.now();
      },
      /** Diagnostics: show or hide one scene mesh (by index) to price it. */
      meshes: () => this.#scene.children.map((m, i) => `${i}:${(m as THREE.Mesh).geometry?.type}:${m.renderOrder}`),
      toggle: (i: number, visible: boolean) => {
        const m = this.#scene.children[i];
        if (m) m.visible = visible;
      },
      gpuMedian: async (ms = 3000) => {
        const from = qa.gpu.length;
        await new Promise((r) => setTimeout(r, ms));
        const g = qa.gpu.slice(from).sort((a, b) => a - b);
        return g.length ? { n: g.length, p50: g[g.length >> 1], p95: g[Math.floor(g.length * 0.95)] } : null;
      },
      state: () => ({
        course: this.#course,
        speed: this.#speed,
        yaw: this.#yaw,
        aimSlot: this.#aimSlot,
        mist: this.#shared.uMist.value,
        vigil: this.#vigil,
        age: this.#shared.uAge.value,
        anchors: Array.from(this.#anchors.slice(0, this.#children.length * 2)),
        calls: this.#renderer.info.render.calls,
        triangles: this.#renderer.info.render.triangles,
        gpuMs: this.#gpuMs,
        cpuMs: this.#drawEma,
      }),
    };
  }

  /** Course from tempo only (never from deck position), land streaming, the seed wipe. */
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
    if (playing !== this.#playing) {
      this.#playing = playing;
      // Play: 40 % at once, full in 600 ms. Stop: half at once, then drift down (τ 0.6 s).
      if (playing) {
        this.#rampFrom = Math.max(0.4, this.#speedF);
        this.#rampT0 = now;
        this.#speedF = this.#rampFrom;
      } else this.#speedF *= 0.5;
    }
    if (playing) {
      const u = Math.min(1, (now - this.#rampT0) / 600);
      this.#speedF = this.#rampFrom + (1 - this.#rampFrom) * (1 - (1 - u) * (1 - u));
    } else this.#speedF *= Math.exp(-dt / 0.6);
    this.#energyS += (energy - this.#energyS) * (1 - Math.exp(-dt / 4));
    const perBar = 4.5 + 3 * this.#energyS;
    const v = this.#speedF * (bpm / 240) * perBar;
    const impulse = 5 * Math.exp(-(now - this.#impulseT0) / 1000 / IMPULSE_TAU) * this.#impulseDir * Math.max(v, 1.6);
    this.#speed = this.#reduced ? 0 : v + impulse;
    this.#course += this.#speed * dt;
    const c = this.#course;
    s.uCourse.value = c;
    s.uCourseW.value = mod(c, RIPPLE_PERIOD);
    s.uCourseK.value = mod(c, 1000);
    const r0 = riverW(-c);
    s.uRiver0.value = r0;
    s.uSnap.value.set(mod(r0, LAND_DX), mod(c, LAND_DZ));
    for (let i = 0; i < this.#wrapped.length; i++) {
      const m = this.#wrapped[i];
      const p = m.userData.period;
      m.userData.wrap.value.set(mod(c, p), Math.floor(c / p));
    }

    // The wipe sweeps in from the horizon, then the old land is forgotten once far behind.
    if (this.#sweep >= 0) {
      const u = Math.min(1, (now - this.#sweepT0) / WIPE_MS);
      const e = 1 - (1 - u) * (1 - u);
      let b = this.#sweepFrom + (this.#sweepTo - this.#sweepFrom) * e;
      if (this.#sweep === 1) b = Math.min(b, this.#bounds[0] - 1);
      this.#bounds[this.#sweep] = b;
      if (u >= 1) this.#sweep = -1;
    }
    if (this.#bounds[0] > NONE && this.#sweep !== 0 && c - this.#starts[0] > WIPE_FORGET) {
      this.#seeds[0] = this.#seeds[1];
      this.#realms[0] = this.#realms[1];
      this.#seeds[1] = this.#seeds[2];
      this.#realms[1] = this.#realms[2];
      this.#bounds[0] = this.#bounds[1];
      this.#starts[0] = this.#starts[1];
      this.#bounds[1] = NONE;
      this.#starts[1] = NONE;
      if (this.#sweep === 1) this.#sweep = 0;
    }
    s.uSeeds.value.set(this.#seeds[0], this.#seeds[1], this.#seeds[2]);
    s.uBounds.value.set(this.#bounds[0], this.#bounds[1]);
    s.uRealms.value.set(this.#realms[0], this.#realms[1], this.#realms[2]);
    s.uStarts.value.set(this.#starts[0], this.#starts[1]);

    // The Wayfinder rides the Current; its beam keeps pointing at the aimed gate.
    this.#wayX = riverW(WAY_Z - c) - r0;
    s.uWay.value.x = this.#wayX;
    s.uWay.value.y = WAY_Z;
    if (this.#aimSlot >= 0) this.#beamTo(this.#aimSlot);
  }

  #passageFrame(now: number) {
    const s = this.#shared;
    const t = now - this.#passT0;
    if (t < PASSAGE_MS && !this.#reduced) {
      const u = t / PASSAGE_MS;
      this.#yaw = this.#yawFrom * (1 - u) * (1 - u) + this.#passYaw * 6.75 * u * (1 - u) * (1 - u);
    } else this.#yaw = 0;
    const pass = s.uPassage.value;
    if (t < SWEEP_MS && !this.#reduced) {
      const u = t / SWEEP_MS;
      const e = 1 - (1 - u) * (1 - u);
      // Forward: from the aimed gate to (just past) the camera; back: the reverse.
      const k = this.#passDir > 0 ? e * 1.11 : 1.11 * (1 - e);
      pass.set(
        this.#passX + (CAMERA.x - this.#passX) * k,
        GATE_Y + (CAMERA.y - 1 - GATE_Y) * k,
        this.#passZ + (CAMERA.z - this.#passZ) * k,
        GATE_R + (SWEEP_R - GATE_R) * (this.#passDir > 0 ? e : 1 - e),
      );
      s.uPassageA.value = (1 - smoothstep(0.72, 1, k)) * (this.#passDir > 0 ? 1 : smoothstep(0, 0.25, e));
    } else pass.w = -1;
    const mu = Math.min(1, (now - this.#mistT0) / PASSAGE_MS);
    s.uMist.value = this.#mistFrom + (this.#mistTo - this.#mistFrom) * mu;
  }

  /**
   * Keepers: flame = deck colour, brightness from the deck's level (τ 0.15 s),
   * the lantern swinging ±9° at the deck's own beat phase (so synced decks
   * swing together), still when paused; a load flares it 2× for 400 ms.
   */
  #keepersFrame(now: number, dt: number, live: boolean) {
    const s = this.#shared;
    const st = waves.state;
    const K = this.#keepers;
    const height = Math.round(Math.max(54, Math.min(92, this.#height * 0.082)));
    const kLevel = 1 - Math.exp(-dt / 0.15);
    const age = Math.min(1, Math.max(0, (now - waves.stateAt) / 1000));
    const aspect = this.#width / this.#height;
    const reach = 2 * (CAMERA.z - POOL_Z) * Math.tan((FOV * Math.PI) / 360) * aspect;
    const riverX = riverW(POOL_Z - this.#course) - s.uRiver0.value;
    for (let i = 0; i < 4; i++) {
      const d = st?.decks[i];
      const loaded = !!d?.track_id;
      const loading = !!d?.loading;
      if ((loading && !this.#wasLoading[i]) || (loaded && d.track_id !== this.#wasTrack[i] && this.#wasTrack[i] !== null))
        this.#flareAt[i] = now;
      this.#wasLoading[i] = loading;
      this.#wasTrack[i] = d?.track_id ?? null;
      const v = live ? this.#o.viz.decks[i] : undefined;
      const level = v ? (v[0] + v[1] + v[2]) / 3 : 0;
      this.#keeperLevel[i] += (level - this.#keeperLevel[i]) * kLevel;
      const flare = Math.max(0, 1 - (now - this.#flareAt[i]) / 400);
      const playing = !!d?.playing && loaded;
      let bright = loaded ? (playing ? 0.35 + Math.min(1, this.#keeperLevel[i] * 1.6) * 0.75 : 0.25) : 0.06;
      bright *= 1 + flare;
      let swing = K.state[i * 4 + 1];
      const grid = loaded ? client.deckInfo[i]?.grid : null;
      if (playing && grid && grid.bpm > 0 && !this.#reduced) {
        const pos = d.position + d.rate * age;
        const beats = ((pos - grid.first_beat) * grid.bpm) / 60;
        swing = ((9 * Math.PI) / 180) * Math.cos(Math.PI * beats);
      } else swing *= Math.exp(-dt / 0.12);
      K.keeper[i * 4] = this.#keeperX[i];
      K.keeper[i * 4 + 1] = this.#keeperBase + 4;
      K.keeper[i * 4 + 2] = height;
      K.keeper[i * 4 + 3] = st?.focused === i ? 1 : 0;
      K.state[i * 4] = bright;
      K.state[i * 4 + 1] = swing;
      K.state[i * 4 + 2] = d?.master ? 1 : 0;
      K.state[i * 4 + 3] = loaded ? 1 : 0;
      // Their light on the water and banks ahead, and a rune ring beside a looping Keeper.
      const x = (this.#keeperX[i] / this.#width - 0.5) * reach;
      const pool = s.uLantern.value;
      pool[i * 4] = x * 0.82 + riverX * 0.18;
      pool[i * 4 + 1] = POOL_Z;
      pool[i * 4 + 2] = loaded ? bright * (st?.focused === i ? 0.9 : 0.6) : 0;
      pool[i * 4 + 3] = 7;
      const ring = s.uLoop.value;
      const loop = d?.loop;
      const active = !!loop?.active && loop.start != null && loop.end != null && loop.end > loop.start;
      ring[i * 4] = x * 0.82 + riverX * 0.18 + (i < 2 ? 3.6 : -3.6);
      ring[i * 4 + 1] = POOL_Z - 1.5;
      ring[i * 4 + 2] =
        d && loop && active ? ((((d.position + (d.playing ? d.rate * age : 0) - loop.start!) / (loop.end! - loop.start!)) % 1) + 1) % 1 : 0;
      ring[i * 4 + 3] = active ? 1 : 0;
      if (this.#reduced) ring[i * 4 + 2] = 0;
    }
    K.view.set(this.#width, this.#height);
  }

  /** Flourish decays from the message frame; nothing eases toward a response. */
  #decays(now: number, dt: number) {
    const s = this.#shared;
    const route = s.uRoute.value,
      gate = s.uGate.value;
    const fall = this.#reduced ? dt / 0.15 : dt / (AIM_MS / 1000);
    for (let i = 0; i < MAX_CHILDREN; i++) {
      if (i === this.#aimSlot) {
        route[i] = Math.min(1, route[i] + (this.#reduced ? dt / 0.15 : 1));
        gate[i] = 1 + 0.35 * Math.max(0, 1 - (now - this.#aimAt) / FLOURISH_MS);
      } else {
        route[i] = Math.max(0, route[i] - fall);
        gate[i] = Math.max(0, gate[i] - fall);
      }
    }
    route[TAKEN_SLOT] = Math.max(0, route[TAKEN_SLOT] - dt / 0.3);
    const wp = s.uWayPrev.value;
    wp.z = Math.max(0, 1 - (now - this.#beamT0) / AIM_MS) * (wp.z > 0 ? 1 : 0);
    wp.w = 1 - this.#vigil * 0.55;
    if (s.uHeraldT.value >= 0) s.uHeraldT.value = Math.min(600, s.uHeraldT.value + dt);
    // Realm colours: 180 ms, the biggest change in the first frame.
    const u = Math.min(1, (now - this.#bandT0) / BAND_MS);
    const e = 1 - (1 - u) * (1 - u);
    s.uBand.value = this.#bandFrom + (this.#bandTarget - this.#bandFrom) * e;
    s.uAccent.value.lerpVectors(this.#accentFrom, this.#accentTo, e);
    this.#realmLight(s.uBand.value);
    // The rune rings turn once per bar.
    s.uBar.value = this.#barPhase(now);
  }

  /** Realm haze and zenith (crossfaded with the band); the light table comes with the ages. */
  #realmLight(band: number) {
    const s = this.#shared;
    mixHex(REALM_SHADER.haze, band, s.uHaze.value);
    mixHex(REALM_SHADER.zenith, band, s.uZenith.value);
  }

  #barPhase(now: number) {
    const st = waves.state;
    if (st) {
      for (let i = 0; i < st.decks.length; i++) {
        const d = st.decks[i];
        if (!d.master || !d.track_id) continue;
        const grid = client.deckInfo[i]?.grid;
        if (!grid || grid.bpm <= 0) break;
        const age = Math.min(1, Math.max(0, (now - waves.stateAt) / 1000));
        const pos = d.position + (d.playing ? d.rate * age : 0);
        const bars = ((pos - grid.first_beat) * grid.bpm) / 240;
        return bars - Math.floor(bars);
      }
    }
    return (this.#time * 0.5) % 1;
  }

  // ---------------------------------------------------------------------------
  // Size, input, teardown

  #onResize = () => {
    const el = this.#o.canvas.parentElement ?? this.#o.canvas;
    this.#width = Math.max(1, el.clientWidth);
    this.#height = Math.max(1, el.clientHeight);
    this.#applySize();
    if (this.#msg && this.#children.length) {
      this.#layoutSlots(this.#msg);
      this.#writeSpires(this.#msg);
      this.#writeRoutes(this.#msg);
      this.#layoutLabels();
    }
  };
  #applySize() {
    this.#renderer.setPixelRatio(this.#dpr);
    this.#renderer.setSize(this.#width, this.#height, false);
    this.#camera.aspect = this.#width / this.#height;
    this.#camera.updateProjectionMatrix();
  }
  #pick(e: MouseEvent) {
    const rect = this.#o.canvas.getBoundingClientRect();
    let best = -1;
    let distance = 48;
    const x = e.clientX - rect.left,
      y = e.clientY - rect.top;
    for (let i = 0; i < this.#children.length; i++) {
      const d = Math.min(
        Math.hypot(x - this.#anchors[i * 2], y - this.#anchors[i * 2 + 1]),
        Math.hypot(x - this.#gates[i * 2], y - this.#gates[i * 2 + 1]),
      );
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
    this.#scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    });
    this.#shared.uRunes.value?.dispose();
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
};

export function createExploreEngine(o: EngineOptions) {
  return new ExploreEngine(o);
}

function smoothstep(a: number, b: number, v: number) {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function mod(a: number, p: number) {
  return ((a % p) + p) % p;
}

function hexVec(hex: string, out: THREE.Vector3) {
  const n = Number.parseInt(hex.slice(1), 16);
  out.set(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Interpolate a 3-stop hex table by band (0..2) into `out`, without allocating. */
function mixHex(table: readonly string[], band: number, out: THREE.Vector3) {
  const i = Math.min(1, Math.floor(band));
  const t = Math.max(0, Math.min(1, band - i));
  const a = HEX_CACHE.get(table[i]) ?? cacheHex(table[i]);
  const b = HEX_CACHE.get(table[i + 1]) ?? cacheHex(table[i + 1]);
  out.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}
const HEX_CACHE = new Map<string, [number, number, number]>();
function cacheHex(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  const v: [number, number, number] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  HEX_CACHE.set(hex, v);
  return v;
}
