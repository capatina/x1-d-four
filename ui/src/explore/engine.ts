import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { fmtBpm, idToName } from '../lib/format';
import type { ExploreMsg, ExploreNode, Track } from '../lib/protocol';
import type { VizFrame } from '../lib/viz';
import { Bend } from './bend';
import {
  makePortals,
  makeShared,
  makeSparks,
  makeSpectrumRing,
  makeTrails,
  makeTunnel,
  MOUTH_DEPTH,
  SPECTRUM_BINS,
  type Portals,
  type Shared,
  type Trails,
} from './meshes';
import { bandPalette } from './palette';

export type EngineStats = { fps: number; calls: number; triangles: number; dpr: number; bloom: boolean };

export type EngineOptions = {
  canvas: HTMLCanvasElement;
  /** Container for the HTML labels (same box as the canvas). */
  labels: HTMLElement;
  viz: VizFrame;
  track: (id: string) => Track | undefined;
  onAim: (id: string) => void;
  onDive: (id: string) => void;
  onAimDelta: (delta: number) => void;
  reducedMotion: boolean;
  onStats?: (stats: EngineStats) => void;
};

// Layout (world units; camera at the origin looking down -Z, tunnel radius 10).
const FOV = 64;
const D_AIM = 17;
const D_RING = 23;
/** Depth for grandchildren of ring children: seen through their parent's gate. */
const D_GRAND = 31;
const D_GRAND_AIM = 41;
const RING_R = 7.1;
const GRAND_AIM_R = 4.6;
const GRAND_CLUSTER_R = 0.8;
const S_AIM = 5.4;
const S_RING_MAX = 2.6;
const S_GRAND = 0.95;
const S_GRAND_AIM = 1.6;
/** Ring radius inside a portal quad, as a fraction of its half-size (matches the shader). */
const RING_UV = 0.62;
/** Trails leave from a ring just outside the aimed gate, at this depth. */
const HUB_DEPTH = 12;
const HUB_R = 2.75;

const SEG = 5; // world units per beat
const FALLBACK_BEATS_PER_S = 0.9;
const MAX_PORTALS = 160;
const MAX_TRAILS = 160;
const SPARKS = 900;
const VIZ_STALE_MS = 400;
const SPRING = 9.5;

type Role = 'aimed' | 'ring' | 'grandAimed' | 'grand' | 'leave' | 'through';
type LabelKind = 'aimed' | 'child' | 'grand';

class Spring {
  v: number;
  t: number;
  vel = 0;
  constructor(v: number) {
    this.v = v;
    this.t = v;
  }
  /** Critically damped, exact for any dt. */
  step(dt: number, w: number): void {
    const x = this.v - this.t;
    const e = Math.exp(-w * dt);
    const k = this.vel + w * x;
    this.v = this.t + (x + k * dt) * e;
    this.vel = (this.vel - k * w * dt) * e;
  }
  snap(v: number): void {
    this.v = v;
    this.t = v;
    this.vel = 0;
  }
}

type Label = {
  el: HTMLDivElement;
  title: HTMLDivElement;
  artist: HTMLDivElement;
  bpm: HTMLSpanElement;
  sim: HTMLSpanElement;
  hint: HTMLDivElement;
  kind: LabelKind | null;
  text: string;
};

type Portal = {
  id: string;
  role: Role;
  parent: string | null;
  sim: number;
  tempo: number | null;
  ang: Spring;
  rad: Spring;
  d: Spring;
  size: Spring;
  op: Spring;
  aimed: Spring;
  hover: Spring;
  omega: number;
  seed: number;
  mix: number;
  label: Label | null;
  labelOp: Spring;
  // Projected each frame.
  wx: number;
  wy: number;
  wz: number;
  sx: number;
  sy: number;
  sr: number;
  onScreen: boolean;
};

type Target = {
  role: Role;
  ang: number;
  rad: number;
  d: number;
  size: number;
  parent: string | null;
  sim: number;
  tempo: number | null;
};

export class ExploreEngine {
  readonly #o: EngineOptions;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera: THREE.PerspectiveCamera;
  readonly #composer: EffectComposer;
  readonly #bloom: UnrealBloomPass;
  readonly #shared: Shared;
  readonly #spectrumTex: THREE.DataTexture;
  readonly #spectrumData = new Uint8Array(SPECTRUM_BINS);
  readonly #spectrum = new Float32Array(SPECTRUM_BINS);
  readonly #portalMesh: Portals;
  readonly #trails: Trails;
  readonly #disposables: Array<{ dispose(): void }> = [];
  readonly #bend = new Bend();
  readonly #portals = new Map<string, Portal>();
  readonly #resize: ResizeObserver;
  readonly #tmp = new THREE.Vector3();

  #msg: ExploreMsg | null = null;
  #hint = '';
  #raf = 0;
  #running = false;
  #disposed = false;
  #last = 0;
  #time = 0;
  #width = 1;
  #height = 1;
  #dpr = 1;
  #maxDpr = 2;
  #reduced: boolean;

  // Audio-driven state.
  #levels = [0, 0, 0];
  #kick = 0;
  #onsets = 0;
  #waves = [-1, -1, -1, -1];
  #beatClock = 0;
  #travel = 0;
  #warpTravel = 0;
  #warp = 0;
  #warpT = -1;
  #warpDir = 1;
  #hue = 0;
  #bandFlash = 0;
  #colA = new THREE.Color();
  #colB = new THREE.Color();
  #hot = new THREE.Color();
  #tgtA = new THREE.Color();
  #tgtB = new THREE.Color();
  #tgtHot = new THREE.Color();
  #paletteKey = '';
  #fov = FOV;

  // Input.
  #pointer = { x: 0, y: 0, inside: false };
  #parallax = { x: 0, y: 0 };
  #hovered: string | null = null;
  #wheel = 0;
  #wheelAt = 0;

  // Perf.
  #adaptive = true;
  #frameEma = 1 / 60;
  #slowFor = 0;
  #statsAt = 0;
  #frames = 0;

  constructor(o: EngineOptions) {
    this.#o = o;
    this.#reduced = o.reducedMotion;
    const params = new URLSearchParams(location.search);

    this.#renderer = new THREE.WebGLRenderer({
      canvas: o.canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    // Pure black: fogged walls fade to 0, so the open far end of the tube must match.
    this.#renderer.setClearColor(0x000000, 1);
    this.#renderer.toneMapping = THREE.NoToneMapping;
    // Count draw calls across all composer passes, not just the last one.
    this.#renderer.info.autoReset = false;
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#maxDpr = Math.min(2, Math.max(1, Number(params.get('dpr')) || window.devicePixelRatio || 1));
    this.#dpr = this.#maxDpr;
    // ?adaptive=0 pins resolution and bloom (screenshots on slow software GL).
    this.#adaptive = params.get('adaptive') !== '0';

    this.#camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 400);

    this.#spectrumTex = new THREE.DataTexture(this.#spectrumData, SPECTRUM_BINS, 1, THREE.RedFormat, THREE.UnsignedByteType);
    this.#spectrumTex.minFilter = THREE.LinearFilter;
    this.#spectrumTex.magFilter = THREE.LinearFilter;
    this.#spectrumTex.wrapS = THREE.ClampToEdgeWrapping;
    this.#spectrumTex.needsUpdate = true;
    this.#disposables.push(this.#spectrumTex);

    this.#shared = makeShared(this.#spectrumTex);
    const tunnel = makeTunnel(this.#shared);
    const sparks = makeSparks(this.#shared, SPARKS);
    const ring = makeSpectrumRing(this.#shared);
    this.#trails = makeTrails(this.#shared, MAX_TRAILS);
    this.#portalMesh = makePortals(this.#shared, MAX_PORTALS);
    for (const mesh of [tunnel, sparks, ring, this.#trails.mesh, this.#portalMesh.mesh]) {
      this.#scene.add(mesh);
      this.#disposables.push(mesh.geometry, mesh.material as THREE.Material);
    }

    this.#composer = new EffectComposer(this.#renderer);
    this.#composer.addPass(new RenderPass(this.#scene, this.#camera));
    this.#bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.62, 0.32, 0.42);
    this.#bloom.enabled = params.get('bloom') !== '0';
    this.#composer.addPass(this.#bloom);
    this.#composer.addPass(new OutputPass());

    this.#applyPalette(true);
    this.#bend.amount = this.#reduced ? 0.5 : 1;

    this.#resize = new ResizeObserver(() => this.#onResize());
    this.#resize.observe(o.canvas.parentElement ?? o.canvas);
    this.#onResize();

    o.canvas.addEventListener('pointermove', this.#onPointerMove);
    o.canvas.addEventListener('pointerleave', this.#onPointerLeave);
    o.canvas.addEventListener('click', this.#onClick);
    o.canvas.addEventListener('dblclick', this.#onDblClick);
    o.canvas.addEventListener('wheel', this.#onWheel, { passive: false });
    o.labels.addEventListener('click', this.#onLabelClick);
    o.labels.addEventListener('dblclick', this.#onLabelDblClick);
    document.addEventListener('visibilitychange', this.#onVisibility);

    this.#start();
  }

  // -------------------------------------------------------------------------
  // Public API

  setExplore(msg: ExploreMsg | null): void {
    const prev = this.#msg;
    this.#msg = msg;
    const reason = !prev ? 'init' : (msg?.reason ?? 'init');
    this.#applyPalette(false);
    if (msg && prev) {
      if (reason === 'dive') this.#startWarp(1);
      else if (reason === 'back') this.#startWarp(-1);
      else if (reason === 'band' || reason === 'root') {
        this.#bandFlash = 1;
        this.#pushWave();
      }
    }
    this.#layout(reason);
  }

  /** One line under the aimed portal saying how to use it (mixer controls); '' hides it. */
  setHint(text: string): void {
    if (text === this.#hint) return;
    this.#hint = text;
    for (const p of this.#portals.values()) if (p.label) p.label.hint.textContent = text;
  }

  /** Library metadata changed: refresh label text. */
  refreshLabels(): void {
    for (const p of this.#portals.values()) if (p.label) p.label.text = '';
  }

  setReducedMotion(reduced: boolean): void {
    this.#reduced = reduced;
    this.#bend.amount = reduced ? 0.5 : 1;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stop();
    const o = this.#o;
    o.canvas.removeEventListener('pointermove', this.#onPointerMove);
    o.canvas.removeEventListener('pointerleave', this.#onPointerLeave);
    o.canvas.removeEventListener('click', this.#onClick);
    o.canvas.removeEventListener('dblclick', this.#onDblClick);
    o.canvas.removeEventListener('wheel', this.#onWheel);
    o.labels.removeEventListener('click', this.#onLabelClick);
    o.labels.removeEventListener('dblclick', this.#onLabelDblClick);
    document.removeEventListener('visibilitychange', this.#onVisibility);
    this.#resize.disconnect();
    for (const p of this.#portals.values()) p.label?.el.remove();
    this.#portals.clear();
    for (const d of this.#disposables) d.dispose();
    for (const pass of this.#composer.passes) (pass as { dispose?: () => void }).dispose?.();
    this.#composer.renderTarget1.dispose();
    this.#composer.renderTarget2.dispose();
    this.#renderer.dispose();
    this.#renderer.forceContextLoss();
  }

  // -------------------------------------------------------------------------
  // Layout: explore message → per-portal targets, keyed by track id

  #layout(reason: string): void {
    const msg = this.#msg;
    const want = new Map<string, Target>();
    if (msg?.current) {
      const seen = new Set<string>([msg.current]);
      const children: ExploreNode[] = [];
      for (const n of msg.nodes) {
        if (n.parent === msg.current && !seen.has(n.id)) {
          seen.add(n.id);
          children.push(n);
        }
      }
      const childIds = new Set(children.map((c) => c.id));
      const kids = new Map<string, ExploreNode[]>();
      for (const n of msg.nodes) {
        if (n.parent == null || seen.has(n.id) || !childIds.has(n.parent)) continue;
        seen.add(n.id);
        const list = kids.get(n.parent) ?? [];
        list.push(n);
        kids.set(n.parent, list);
      }

      const count = children.length;
      const aimIdx = children.findIndex((c) => c.id === msg.aim);
      const ringSize = Math.min(S_RING_MAX, (24.5 / Math.max(count, 1)) * (RING_R / 7));
      children.forEach((c, i) => {
        // The aimed child sits dead centre; the rest ring around it with the
        // gap at six o'clock, so the aimed label always has room below.
        const k = aimIdx >= 0 ? (i - aimIdx + count) % count : i + 0.5;
        const aimed = aimIdx >= 0 && k === 0;
        const ang = -Math.PI / 2 + (2 * Math.PI * k) / count;
        want.set(c.id, {
          role: aimed ? 'aimed' : 'ring',
          ang,
          rad: aimed ? 0 : RING_R,
          d: aimed ? D_AIM : D_RING,
          size: aimed ? S_AIM : ringSize,
          parent: c.parent,
          sim: c.sim,
          tempo: c.tempo,
        });
        const gk = kids.get(c.id) ?? [];
        gk.forEach((g, j) => {
          if (aimed) {
            const ga = Math.PI / 4 + Math.PI / 2 + (2 * Math.PI * j) / gk.length;
            want.set(g.id, {
              role: 'grandAimed',
              ang: ga,
              rad: GRAND_AIM_R,
              d: D_GRAND_AIM,
              size: S_GRAND_AIM,
              parent: g.parent,
              sim: g.sim,
              tempo: g.tempo,
            });
          } else {
            // Same screen direction as the parent, deeper: a cluster behind its gate.
            const through = (RING_R * D_GRAND) / D_RING;
            const cx = Math.cos(ang) * through;
            const cy = Math.sin(ang) * through;
            const ga = ang + Math.PI + (2 * Math.PI * (j + 0.5)) / gk.length;
            const x = cx + Math.cos(ga) * GRAND_CLUSTER_R;
            const y = cy + Math.sin(ga) * GRAND_CLUSTER_R;
            want.set(g.id, {
              role: 'grand',
              ang: Math.atan2(y, x),
              rad: Math.hypot(x, y),
              d: D_GRAND,
              size: S_GRAND,
              parent: g.parent,
              sim: g.sim,
              tempo: g.tempo,
            });
          }
        });
      });
    }

    const init = reason === 'init';
    const dive = reason === 'dive';
    const back = reason === 'back';

    for (const p of this.#portals.values()) {
      if (want.has(p.id)) continue;
      if (p.role === 'leave' || p.role === 'through') continue;
      if (dive && p.id === this.#msg?.current) {
        // The portal we dove into flies past the camera.
        p.role = 'through';
        p.d.t = -6;
        p.rad.t = 0;
        p.size.t = p.size.v * 1.25;
        p.omega = 5.5;
      } else {
        p.role = 'leave';
        p.op.t = 0;
        if (dive) {
          p.d.t = -3;
          p.rad.t = p.rad.v * 1.9 + 3;
          p.omega = 5;
        } else if (back) {
          p.d.t = p.d.v + 45;
          p.omega = 4.5;
        } else {
          p.size.t = p.size.v * 0.4;
          p.omega = 8;
        }
      }
    }

    for (const [id, t] of want) {
      let p = this.#portals.get(id);
      if (!p) {
        p = this.#spawn(id, t, reason);
        this.#portals.set(id, p);
      }
      p.role = t.role;
      p.parent = t.parent;
      p.sim = t.sim;
      p.tempo = t.tempo;
      if (t.rad > 0.01) p.ang.t = p.ang.v + wrapPi(t.ang - p.ang.v);
      p.rad.t = t.rad;
      p.d.t = t.d;
      p.size.t = t.size;
      p.op.t = 1;
      p.aimed.t = t.role === 'aimed' ? 1 : 0;
      p.omega = init ? 7 : t.role === 'aimed' && dive ? 6.5 : SPRING;
      if (p.label) p.label.text = '';
    }
  }

  #spawn(id: string, t: Target, reason: string): Portal {
    const seed = hash01(id);
    const p: Portal = {
      id,
      role: t.role,
      parent: t.parent,
      sim: t.sim,
      tempo: t.tempo,
      ang: new Spring(t.ang),
      rad: new Spring(t.rad),
      d: new Spring(t.d),
      size: new Spring(t.size),
      op: new Spring(0),
      aimed: new Spring(t.role === 'aimed' ? 1 : 0),
      hover: new Spring(0),
      omega: SPRING,
      seed,
      mix: 0.15 + 0.7 * seed,
      label: null,
      labelOp: new Spring(0),
      wx: 0,
      wy: 0,
      wz: 0,
      sx: 0,
      sy: 0,
      sr: 0,
      onScreen: false,
    };
    if (reason === 'dive') {
      // New branches emerge from the fog ahead.
      p.d.snap(t.d + 50);
      p.size.snap(t.size * 0.6);
    } else if (reason === 'back') {
      // Flying backwards: what was behind us slides into view.
      p.d.snap(-4);
      p.rad.snap(t.rad * 1.5 + 2);
    } else if (reason === 'init') {
      p.size.snap(t.size * 0.85);
      p.d.snap(t.d + 12);
    } else {
      p.size.snap(t.size * 0.2);
    }
    return p;
  }

  // -------------------------------------------------------------------------
  // Colour

  #applyPalette(snap: boolean): void {
    const band = this.#msg?.band ?? 'low';
    const node = this.#msg?.current ?? '';
    const key = `${band}|${node}`;
    if (!snap && key === this.#paletteKey) return;
    this.#paletteKey = key;
    const pal = bandPalette(band);
    // Every node tints the band slightly differently, so a dive feels like a new room.
    const shift = node ? (hash01(node) - 0.5) * 0.07 : 0;
    this.#tgtA.set(pal.a).offsetHSL(shift, 0, 0);
    this.#tgtB.set(pal.b).offsetHSL(shift * 0.6, 0, 0);
    this.#tgtHot.set(pal.hot);
    if (snap) {
      this.#colA.copy(this.#tgtA);
      this.#colB.copy(this.#tgtB);
      this.#hot.copy(this.#tgtHot);
    }
  }

  // -------------------------------------------------------------------------
  // Motion

  #startWarp(dir: number): void {
    this.#warpT = 0;
    this.#warpDir = dir;
  }

  #pushWave(): void {
    this.#waves.pop();
    this.#waves.unshift(MOUTH_DEPTH);
  }

  #start(): void {
    if (this.#running || this.#disposed) return;
    this.#running = true;
    this.#last = performance.now();
    this.#raf = requestAnimationFrame(this.#frame);
  }

  #stop(): void {
    this.#running = false;
    cancelAnimationFrame(this.#raf);
  }

  #onVisibility = (): void => {
    if (document.hidden) this.#stop();
    else this.#start();
  };

  #frame = (now: number): void => {
    if (!this.#running) return;
    this.#raf = requestAnimationFrame(this.#frame);
    const dt = Math.min(0.05, Math.max(0, (now - this.#last) / 1000));
    this.#last = now;
    this.#time += dt;
    this.#update(dt, now);
    this.#renderer.info.reset();
    this.#composer.render(dt);
    this.#perf(dt, now);
  };

  #update(dt: number, now: number): void {
    const viz = this.#o.viz;
    const reduced = this.#reduced;
    const live = viz.at > 0 && now - viz.at < VIZ_STALE_MS;

    // Band levels: fast attack, slower release.
    for (let i = 0; i < 3; i++) {
      const target = live ? viz.bands[i] : 0;
      const k = target > this.#levels[i] ? 1 - Math.exp(-dt / 0.03) : 1 - Math.exp(-dt / 0.18);
      this.#levels[i] += (target - this.#levels[i]) * k;
    }
    const decay = Math.exp(-dt / 0.16);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const raw = live ? viz.spectrum[i] : 0;
      this.#spectrum[i] = Math.max(raw, this.#spectrum[i] * decay);
      this.#spectrumData[i] = Math.round(this.#spectrum[i] * 255);
    }
    this.#spectrumTex.needsUpdate = true;

    if (viz.onsets !== this.#onsets) {
      this.#onsets = viz.onsets;
      if (live) {
        this.#kick = 1;
        this.#pushWave();
      }
    }
    this.#kick *= Math.exp(-dt / 0.13);
    const waveSpeed = reduced ? 30 : 58;
    for (let i = 0; i < 4; i++) {
      if (this.#waves[i] >= 0) {
        this.#waves[i] += dt * waveSpeed;
        if (this.#waves[i] > 200) this.#waves[i] = -1;
      }
    }
    this.#bandFlash *= Math.exp(-dt / 0.35);

    // Beat clock: free-runs at the tempo and is pulled onto the mixer's phase.
    const bpm = live && viz.bpm ? viz.bpm : null;
    const rate = bpm ? bpm / 60 : FALLBACK_BEATS_PER_S;
    this.#beatClock += dt * rate;
    if (live && viz.beat != null && bpm) {
      const expected = viz.beat + ((now - viz.at) / 1000) * rate;
      const err = wrapHalf(expected - this.#beatClock);
      this.#beatClock += err * Math.min(1, dt * 6);
    }
    const frac = this.#beatClock - Math.floor(this.#beatClock);
    const beatPulse = bpm ? Math.pow(1 - frac, 3) : 0;

    // Flight: one ring per beat, with a small surge on every beat.
    let travel: number;
    if (reduced) {
      travel = this.#beatClock * SEG * 0.35;
    } else if (bpm) {
      const pump = frac + 0.35 * (1 - Math.pow(1 - frac, 3) - frac);
      travel = (Math.floor(this.#beatClock) + pump) * SEG;
    } else {
      travel = this.#beatClock * SEG;
    }

    // Dive / back warp: a burst of speed (backwards for back) over ~0.9 s.
    if (this.#warpT >= 0) {
      this.#warpT += dt;
      const dur = reduced ? 1.3 : 0.9;
      const x = this.#warpT / dur;
      if (x >= 1) {
        this.#warpT = -1;
        this.#warp = 0;
      } else {
        this.#warp = Math.sin(Math.PI * x) * this.#warpDir;
      }
      this.#warpTravel += this.#warp * dt * (reduced ? 12 : 70);
    }
    this.#travel = travel + this.#warpTravel;
    this.#bend.update(this.#travel);

    // Mid band drifts the hue.
    this.#hue += dt * (0.08 + this.#levels[1] * 0.9) * (reduced ? 0.4 : 1);

    const lerp = 1 - Math.exp(-dt / 0.3);
    this.#colA.lerp(this.#tgtA, lerp);
    this.#colB.lerp(this.#tgtB, lerp);
    this.#hot.lerp(this.#tgtHot, lerp);

    const s = this.#shared;
    s.uTime.value = this.#time;
    s.uTravel.value = this.#travel;
    s.uSeg.value = SEG;
    s.uBeatPulse.value = reduced ? beatPulse * 0.3 : beatPulse;
    s.uFlow.value = this.#beatClock;
    s.uLow.value = this.#levels[0];
    s.uMid.value = this.#levels[1];
    s.uHigh.value = this.#levels[2];
    s.uKick.value = Math.max(this.#kick, this.#bandFlash * 0.8);
    s.uFlash.value = reduced ? 0 : 1;
    s.uWarp.value = Math.abs(this.#warp);
    s.uHue.value = this.#hue;
    s.uColA.value.copy(this.#colA);
    s.uColB.value.copy(this.#colB);
    s.uHot.value.copy(this.#hot);
    for (let i = 0; i < 4; i++) s.uWaves.value[i] = this.#waves[i];
    s.uBendS.value.set(this.#bend.S[0], this.#bend.S[1], this.#bend.S[2], this.#bend.S[3]);
    s.uBendC.value.set(this.#bend.C[0], this.#bend.C[1], this.#bend.C[2], this.#bend.C[3]);
    s.uBendAmt.value = this.#bend.amount;

    // Camera: slight parallax toward the pointer, a gentle roll on the bar,
    // FOV opens up during a warp.
    const px = this.#pointer.inside ? this.#pointer.x : 0;
    const py = this.#pointer.inside ? this.#pointer.y : 0;
    const pk = 1 - Math.exp(-dt / 0.6);
    this.#parallax.x += (px - this.#parallax.x) * pk;
    this.#parallax.y += (py - this.#parallax.y) * pk;
    const cam = this.#camera;
    cam.position.set(this.#parallax.x * 0.8, this.#parallax.y * 0.5, 0);
    cam.lookAt(this.#parallax.x * 0.2, this.#parallax.y * 0.12, -40);
    if (!reduced) cam.rotateZ(Math.sin((this.#beatClock * Math.PI) / 8) * 0.018);
    const fov = FOV + (reduced ? 4 : 16) * Math.abs(this.#warp) + (reduced ? 0 : this.#kick * 0.6);
    if (Math.abs(fov - this.#fov) > 0.01) {
      this.#fov = fov;
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();

    this.#updatePortals(dt, frac);
  }

  #updatePortals(dt: number, beatFrac: number): void {
    const pm = this.#portalMesh;
    const tr = this.#trails;
    let n = 0;
    let t = 0;
    const projScale = this.#height / 2 / Math.tan((this.#camera.fov * Math.PI) / 360);
    const reduced = this.#reduced;

    // Light at the end of the tunnel.
    {
      const d = 150;
      const [bx, by] = this.#bend.at(d);
      pm.pos.setXYZ(n, bx, by, -d);
      pm.style.setXYZW(n, 20, 0.08 + this.#levels[0] * 0.12, 0, 0);
      pm.tint.setXYZW(n, 0, 1, 0.5, 0);
      n++;
    }

    for (const p of [...this.#portals.values()]) {
      const w = p.omega * (reduced ? 0.7 : 1);
      p.ang.step(dt, w);
      p.rad.step(dt, w);
      p.d.step(dt, w);
      p.size.step(dt, w);
      p.op.step(dt, p.role === 'leave' ? 7 : w);
      p.aimed.step(dt, 10);
      p.hover.t = this.#hovered === p.id ? 1 : 0;
      p.hover.step(dt, 14);

      let opacity = clamp01(p.op.v);
      if (p.role === 'through') opacity = smoothstep(-1.5, 7, p.d.v);
      if ((p.role === 'leave' && opacity < 0.01 && p.op.t === 0) || (p.role === 'through' && p.d.v < -1.4)) {
        p.label?.el.remove();
        this.#portals.delete(p.id);
        continue;
      }

      const d = p.d.v;
      const [bx, by] = this.#bend.at(d);
      const x = Math.cos(p.ang.v) * p.rad.v + bx;
      const y = Math.sin(p.ang.v) * p.rad.v + by;
      p.wx = x;
      p.wy = y;
      p.wz = -d;

      // Fog: grandchildren fade into the distance.
      const fog = Math.exp(-Math.max(0, d - 19) * 0.034);
      const aimedPulse =
        p.aimed.v * (reduced ? 0.01 : 0.025 * Math.sin(this.#time * 2.6) + 0.035 * Math.pow(1 - beatFrac, 4));
      const size = Math.max(0.01, p.size.v * (1 + aimedPulse));

      if (n < pm.capacity) {
        pm.pos.setXYZ(n, x, y, -d);
        pm.style.setXYZW(n, size, opacity * fog, clamp01(p.aimed.v), p.hover.v);
        pm.tint.setXYZW(n, p.sim, 0, p.mix, p.seed);
        n++;
      }

      // Project for labels and picking.
      this.#tmp.set(x, y, -d).project(this.#camera);
      const ndcZ = this.#tmp.z;
      p.sx = (this.#tmp.x * 0.5 + 0.5) * this.#width;
      p.sy = (-this.#tmp.y * 0.5 + 0.5) * this.#height;
      const viewDepth = Math.max(0.1, d + this.#camera.position.z);
      p.sr = ((size * RING_UV) / viewDepth) * projScale;
      p.onScreen =
        ndcZ < 1 && d > 0.5 && p.sx > -p.sr && p.sx < this.#width + p.sr && p.sy > -p.sr && p.sy < this.#height + p.sr;

      // Labels wait until their portal has nearly arrived, so flights stay clean.
      const settle = 1 - smoothstep(2.5, 10, Math.abs(p.d.v - p.d.t));
      this.#updateLabel(p, opacity * Math.min(1, fog * 1.4) * settle, dt);
    }

    // Trails: current → children, children → grandchildren.
    const [hx, hy] = this.#bend.at(HUB_DEPTH);
    for (const p of this.#portals.values()) {
      if (t >= tr.capacity) break;
      const isChild = p.role === 'aimed' || p.role === 'ring' || (p.role === 'leave' && p.rad.v > 0 && p.d.v < 30);
      const opacity = p.role === 'through' ? smoothstep(-1.5, 7, p.d.v) : clamp01(p.op.v);
      if (opacity < 0.01) continue;
      if (isChild || p.role === 'through') {
        if (p.rad.v < 0.6) continue; // the aimed portal is straight ahead
        // From the rim around where we stand, out to the gate.
        const ca = Math.cos(p.ang.v);
        const sa = Math.sin(p.ang.v);
        const sx = hx + ca * HUB_R;
        const sy = hy + sa * HUB_R;
        const mid = (HUB_R + p.rad.v) * 0.5;
        const [mx, my] = this.#bend.at((HUB_DEPTH + p.d.v) * 0.5);
        tr.a.setXYZ(t, sx, sy, -HUB_DEPTH);
        tr.b.setXYZ(t, mx + ca * mid * 0.85, my + sa * mid * 0.85, -(HUB_DEPTH + p.d.v) * 0.5);
        tr.c.setXYZ(t, p.wx, p.wy, p.wz);
        const aimed = clamp01(p.aimed.v);
        tr.style.setXYZW(
          t,
          0.06 + p.sim * 0.16,
          (0.6 + 2.2 * p.sim * p.sim) * opacity * (1 + 0.6 * p.hover.v),
          p.seed,
          aimed,
        );
        t++;
      } else if (p.role === 'grand' || p.role === 'grandAimed') {
        const parent = p.parent ? this.#portals.get(p.parent) : undefined;
        if (!parent) continue;
        const sx = parent.wx;
        const sy = parent.wy;
        const sz = parent.wz;
        tr.a.setXYZ(t, sx, sy, sz);
        tr.b.setXYZ(t, (sx + p.wx) / 2, (sy + p.wy) / 2, (sz + p.wz) / 2 - 2);
        tr.c.setXYZ(t, p.wx, p.wy, p.wz);
        const strength = p.role === 'grandAimed' ? 0.9 : 0.5;
        tr.style.setXYZW(t, 0.03 + p.sim * 0.05, (0.3 + p.sim * p.sim) * opacity * strength, p.seed, 0);
        t++;
      }
    }

    pm.geo.instanceCount = n;
    pm.pos.needsUpdate = true;
    pm.style.needsUpdate = true;
    pm.tint.needsUpdate = true;
    tr.geo.instanceCount = t;
    tr.a.needsUpdate = true;
    tr.b.needsUpdate = true;
    tr.c.needsUpdate = true;
    tr.style.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Labels (HTML, positioned by projection)

  #updateLabel(p: Portal, visibility: number, dt: number): void {
    const kind: LabelKind | null =
      p.role === 'aimed' ? 'aimed' : p.role === 'ring' ? 'child' : p.role === 'grandAimed' ? 'grand' : null;
    p.labelOp.t = kind && p.onScreen ? visibility : 0;
    p.labelOp.step(dt, 12);
    const alpha = clamp01(p.labelOp.v);
    if (alpha < 0.01) {
      if (p.label && p.label.el.style.display !== 'none') p.label.el.style.display = 'none';
      return;
    }
    if (!p.label) p.label = this.#makeLabel(p.id);
    const l = p.label;
    if (l.el.style.display === 'none') l.el.style.display = '';
    if (kind && kind !== l.kind) {
      l.kind = kind;
      l.el.dataset.kind = kind;
      l.text = '';
    }
    this.#fillLabel(p, l);
    l.el.classList.toggle('hover', p.hover.v > 0.5);

    // Aimed: centred below the gate. Children: pushed outward from the
    // tunnel axis. Aimed grandchildren: outward from the aimed gate.
    let ox = 0;
    let oy = 1;
    if (l.kind === 'child') {
      const dx = p.sx - this.#width / 2;
      const dy = p.sy - this.#height / 2;
      const len = Math.hypot(dx, dy) || 1;
      ox = dx / len;
      oy = dy / len;
    }
    const gap = l.kind === 'aimed' ? 22 : l.kind === 'grand' ? 4 : 12;
    const ax = p.sx + ox * (p.sr + gap);
    const ay = p.sy + oy * (p.sr + gap);
    // Anchor: which corner of the label sits at (ax, ay). Aimed and its
    // grandchildren hang centred below; children push outward from the axis.
    const centred = l.kind !== 'child';
    const tx = centred ? -50 : ox > 0.35 ? 0 : ox < -0.35 ? -100 : -50;
    const ty = centred ? 0 : oy > 0.35 ? 0 : oy < -0.35 ? -100 : -50;
    const align = tx === 0 ? 'left' : tx === -100 ? 'right' : 'center';
    if (l.el.dataset.align !== align) l.el.dataset.align = align;
    l.el.style.transform = `translate3d(${Math.round(ax)}px, ${Math.round(ay)}px, 0) translate(${tx}%, ${ty}%)`;
    l.el.style.opacity = alpha.toFixed(3);
  }

  #makeLabel(id: string): Label {
    const el = document.createElement('div');
    el.className = 'xl';
    el.dataset.id = id;
    const title = document.createElement('div');
    title.className = 'xl-t';
    const artist = document.createElement('div');
    artist.className = 'xl-a';
    const meta = document.createElement('div');
    meta.className = 'xl-m';
    const bpm = document.createElement('span');
    bpm.className = 'xl-bpm';
    const sim = document.createElement('span');
    sim.className = 'xl-sim';
    meta.append(sim, bpm);
    const hint = document.createElement('div');
    hint.className = 'xl-k';
    hint.textContent = this.#hint;
    el.append(title, artist, meta, hint);
    this.#o.labels.append(el);
    return { el, title, artist, bpm, sim, hint, kind: null, text: '' };
  }

  #fillLabel(p: Portal, l: Label): void {
    const track = this.#o.track(p.id);
    const tempo = p.tempo ?? track?.bpm ?? null;
    const titleText = track?.title ?? idToName(p.id);
    const artistText = track?.artist ?? 'Unknown artist';
    const simText = `${Math.round(p.sim * 100)}%`;
    const bpmText = tempo ? `${fmtBpm(tempo)} BPM` : '';
    const key = `${titleText}|${artistText}|${simText}|${bpmText}`;
    if (key === l.text) return;
    l.text = key;
    l.title.textContent = titleText;
    l.artist.textContent = artistText;
    l.sim.textContent = simText;
    l.bpm.textContent = bpmText;
    l.el.title = `${titleText} — ${artistText}`;
  }

  // -------------------------------------------------------------------------
  // Input

  #pick(clientX: number, clientY: number): string | null {
    const rect = this.#o.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: Portal | null = null;
    for (const p of this.#portals.values()) {
      if ((p.role !== 'aimed' && p.role !== 'ring') || p.op.v < 0.3 || !p.onScreen) continue;
      const r = Math.max(18, p.sr * 1.2);
      if (Math.hypot(x - p.sx, y - p.sy) > r) continue;
      if (!best || p.d.v < best.d.v) best = p;
    }
    return best?.id ?? null;
  }

  #onPointerMove = (e: PointerEvent): void => {
    const rect = this.#o.canvas.getBoundingClientRect();
    this.#pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.#pointer.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    this.#pointer.inside = true;
    this.#hovered = this.#pick(e.clientX, e.clientY);
    this.#o.canvas.style.cursor = this.#hovered ? 'pointer' : '';
  };

  #onPointerLeave = (): void => {
    this.#pointer.inside = false;
    this.#hovered = null;
  };

  #onClick = (e: MouseEvent): void => {
    const id = this.#pick(e.clientX, e.clientY);
    if (id) this.#o.onAim(id);
  };

  #onDblClick = (e: MouseEvent): void => {
    const id = this.#pick(e.clientX, e.clientY);
    if (id) this.#o.onDive(id);
  };

  #labelId(e: Event): string | null {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('.xl');
    const id = el?.dataset.id;
    const p = id ? this.#portals.get(id) : undefined;
    return p && (p.role === 'aimed' || p.role === 'ring') ? p.id : null;
  }

  #onLabelClick = (e: MouseEvent): void => {
    const id = this.#labelId(e);
    if (id) this.#o.onAim(id);
  };

  #onLabelDblClick = (e: MouseEvent): void => {
    const id = this.#labelId(e);
    if (id) this.#o.onDive(id);
  };

  #onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const now = performance.now();
    if (now - this.#wheelAt > 400) this.#wheel = 0;
    this.#wheelAt = now;
    this.#wheel += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const step = e.deltaMode === 1 ? 3 : 80;
    if (Math.abs(this.#wheel) >= step) {
      this.#o.onAimDelta(Math.sign(this.#wheel));
      this.#wheel = 0;
    }
  };

  // -------------------------------------------------------------------------
  // Size + adaptive quality

  #onResize(): void {
    const el = this.#o.canvas.parentElement ?? this.#o.canvas;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    this.#width = w;
    this.#height = h;
    this.#applySize();
  }

  #applySize(): void {
    this.#renderer.setPixelRatio(this.#dpr);
    this.#renderer.setSize(this.#width, this.#height, false);
    this.#composer.setPixelRatio(this.#dpr);
    this.#composer.setSize(this.#width, this.#height);
    this.#camera.aspect = this.#width / this.#height;
    this.#camera.updateProjectionMatrix();
  }

  #perf(dt: number, now: number): void {
    this.#frames++;
    if (dt > 0) this.#frameEma += (dt - this.#frameEma) * 0.05;
    // Hold 60 fps: shed resolution, then bloom, if frames run long for a while.
    if (this.#adaptive && this.#time > 3 && this.#frameEma > 1 / 48) {
      this.#slowFor += dt;
      if (this.#slowFor > 2) {
        this.#slowFor = 0;
        this.#frameEma = 1 / 60;
        if (this.#dpr > 1) {
          this.#dpr = Math.max(1, this.#dpr - 0.5);
          this.#applySize();
        } else if (this.#bloom.enabled && this.#dpr > 0.75) {
          this.#dpr = 0.75;
          this.#applySize();
        } else if (this.#bloom.enabled) {
          this.#bloom.enabled = false;
        }
      }
    } else {
      this.#slowFor = 0;
    }
    if (this.#o.onStats && now - this.#statsAt > 500) {
      const info = this.#renderer.info.render;
      this.#o.onStats({
        fps: Math.round(1 / this.#frameEma),
        calls: info.calls,
        triangles: info.triangles,
        dpr: this.#dpr,
        bloom: this.#bloom.enabled,
      });
      this.#statsAt = now;
    }
  }
}

export function createExploreEngine(o: EngineOptions): ExploreEngine {
  return new ExploreEngine(o);
}

function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

function wrapPi(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

function wrapHalf(x: number): number {
  return x - Math.round(x);
}

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}
