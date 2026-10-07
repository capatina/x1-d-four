import * as THREE from 'three';

/**
 * The Datastream's building blocks: an infinite neon grid, a sky with copper
 * bars, branching light rails, wireframe gates, speed
 * streaks and the post chain (bloom, deck lasers, chromatic aberration,
 * scanlines, flashes and cuts). Everything is a ShaderMaterial on shared
 * uniforms; nothing here allocates per frame.
 */

export const MAX_CHILDREN = 6;
export const MAX_GRANDS = 24;
/** Rail slots: 0–5 the children, 6 the trunk, 8–13 the grand rails of child 0–5. */
export const TRUNK_SLOT = 6;
export const RAIL_SEGMENTS = 40;
export const TRUNK_SEGMENTS = 12;
export const GRAND_SEGMENTS = 14;
/** Camera path samples per route (trunk + branch), for the flight down a branch. */
export const PATH_SAMPLES = 48;

export const CAM_H = 10;
export const LOOK_Y = -2;
export const LOOK_D = 60;
export const GATE_Y = 3.4;
export const GATE_R = 1.7;
export const GRAND_Y = 2.2;
export const GRAND_R = 0.8;
export const SPLIT_Z = -13;
export const TRUNK_FROM = 12;

export function makeShared() {
  return {
    uTime: { value: 0 },
    uFlow: { value: 0 },
    uTravel: { value: 0 },
    uSpeed: { value: 0 },
    uBeat: { value: 0 },
    uBeatPhase: { value: 0 },
    uEnergy: { value: 0 },
    uVigil: { value: 0 },
    uAccent: { value: new THREE.Vector3(1, 0.2, 0.4) },
    uHot: { value: new THREE.Vector3(1, 0.8, 0.9) },
    uGridYaw: { value: 0 },
    uGridOff: { value: new THREE.Vector2() },
    uDeckColor: { value: new Float32Array(12) },
    uDeckLevel: { value: new Float32Array(4) },
    uDeckPhase: { value: new Float32Array(4) },
    uRipple: { value: -1 },
    /** Bass: a fast envelope of the low band, auto-levelled (0..~1.2), and the kick's flash (1 → 0). */
    uBass: { value: 0 },
    uKick: { value: 0 },
    /** Seconds since the last kick (its ring races out over the grid). */
    uKickAge: { value: 99 },
    /** Generations built so far, each 0..1: ridges, monoliths, hypertunnel, orbit. */
    uGen: { value: new THREE.Vector4() },
    /** Generation 5: plasma in the sky. */
    uGen5: { value: 0 },
    /** The camera in grid coordinates (structures are placed on the grid). */
    uCamGrid: { value: new THREE.Vector2() },
    uTunnel: { value: 0 },
    uSpectrum: { value: new Float32Array(32) },
    /** MIDI data flow: activity (0..1, decaying), and packets in flight: (side, launched at, value, deck). */
    uData: { value: 0 },
    uPackets: { value: Array.from({ length: 48 }, () => new THREE.Vector4(0, -100, 0, -1)) },
    uDpr: { value: 1 },
    /** The mix volume, 0 silent … 1 hot: silence flattens the world. */
    uMix: { value: 1 },
    /**
     * Each mixer channel's low/mid/high (ch × 3 + band, 0..1), each with its own part
     * of the world: 1 the ground, 2 the sky, 3 the paths, 4 the motion.
     */
    uChan: { value: new Float32Array(12).fill(0.5) },
    /**
     * The world (0 Neon Grid, 1 Chromozon, 2 Tunnelwerk, 3 Nachtflug, 4 Kupferzeit),
     * how far it has evolved since we arrived (0..1), and how many jumps so far.
     */
    uWorldF: { value: 0 },
    uWorldS: { value: 0 },
    uWorldP: { value: 0 },
    uEvo: { value: 0 },
    /**
     * The genome: 16 parameters (0..1) that drift toward targets which mutate
     * forever, shaping everything (see GENES in the engine).
     */
    uGenome: { value: new Float32Array(16).fill(0.5) },
    /** A slow turn of the palette's hue (turns), from the genome. Deck colours keep theirs. */
    uHue: { value: 0 },
    /** Phrase arches: (distance ahead, sides, flash, alpha) for the next four phrase downbeats. */
    uArch: { value: Array.from({ length: 4 }, () => new THREE.Vector4(0, 6, 0, 0)) },
    uJumps: { value: 0 },
    /**
     * Track changes reseed the land: the old seed near, the new one beyond the
     * front, which sweeps in from the horizon. And the loudest channel picks the
     * texture variant (0–3, its deck).
     */
    uSeedA: { value: 0 },
    uSeedB: { value: 0 },
    uSeedFront: { value: -1 },
    uVariant: { value: 0 },
  };
}
export type Shared = ReturnType<typeof makeShared>;

const COMMON = /* glsl */ `
  uniform float uTime, uFlow, uTravel, uSpeed, uBeat, uBeatPhase, uEnergy, uVigil, uBass, uKick, uKickAge, uData, uWorldF, uWorldS, uWorldP, uEvo, uJumps, uSeedA, uSeedB, uSeedFront, uVariant, uMix, uHue;
  uniform float uChan[12];
  uniform float uGenome[16];
  uniform vec3 uAccent, uHot;
  uniform vec4 uGen;
  float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  vec3 hueShift(vec3 c, float h) {
    const vec3 k = vec3(0.57735);
    float a = h * 6.28318, ca = cos(a);
    return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
  }
  /** The world's colours: saturated, and turned by the genome's hue. */
  vec3 neon(vec3 c) { c = hueShift(c, uHue); float l = dot(c, vec3(0.299, 0.587, 0.114)); return max(vec3(0.0), mix(vec3(l), c, 2.2)); }
  /** A deck's own colour: saturated, never turned (decks keep their identity). */
  vec3 deckNeon(vec3 c) { float l = dot(c, vec3(0.299, 0.587, 0.114)); return max(vec3(0.0), mix(vec3(l), c, 2.2)); }
  float gene(int i) { return uGenome[i]; }
  /** Radius of a regular n-gon (unit inscribed circle at the corners) at angle a. */
  float ngon(float a, float n) {
    float seg = 6.28318 / n;
    return cos(3.14159 / n) / cos(mod(a, seg) - seg * 0.5);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float ridged(vec2 p) {
    float h = 0.0, a = 0.55;
    for (int i = 0; i < 4; i++) { h += a * (1.0 - abs(vnoise(p) * 2.0 - 1.0)); p = p * 2.03 + 17.1; a *= 0.5; }
    return h * h;
  }
  /** Hybrid worlds: the land, the sky and the paths each come from a world of their own. */
  bool wF(float w) { return abs(uWorldF - w) < 0.5; }
  bool wS(float w) { return abs(uWorldS - w) < 0.5; }
  bool wP(float w) { return abs(uWorldP - w) < 0.5; }
  /** The land's seed at this distance from the camera (the new one beyond the sweeping front). */
  vec2 seeded(vec2 p, float dist) {
    float seed = dist > uSeedFront ? uSeedB : uSeedA;
    return p + vec2(seed * 1371.7, seed * 913.3);
  }
  float variant(float v) { return abs(uVariant - v) < 0.5 ? 1.0 : 0.0; }
  vec2 rot45(vec2 p) { return vec2(p.x + p.y, p.x - p.y) * 0.7071; }
  /** Chromozon's sunset: what the chrome sea reflects and the sky shows. */
  vec3 sunset(float el) {
    vec3 c = mix(vec3(1.0, 0.45, 0.16), vec3(0.85, 0.12, 0.45), smoothstep(0.0, 0.12, el));
    return mix(c, vec3(0.08, 0.02, 0.2), smoothstep(0.1, 0.45, el));
  }
  vec2 rotY2(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(p.x * c + p.y * s, -p.x * s + p.y * c); }
`;

// ---------------------------------------------------------------------------
// Floor: an endless grid in the travel frame, with a ring that races out on each beat.

export function makeFloor(s: Shared) {
  const geo = new THREE.PlaneGeometry(1600, 1600, 240, 240);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...pick(s), uGridYaw: s.uGridYaw, uGridOff: s.uGridOff, uRipple: s.uRipple, uSpectrum: s.uSpectrum },
    vertexShader: /* glsl */ `
      ${COMMON}
      uniform float uGridYaw;
      uniform vec2 uGridOff;
      uniform float uSpectrum[32];
      varying vec3 vWorld;
      varying vec2 vGrid;
      varying float vHeight;
      float swell(vec2 p) {
        return sin(p.x * 0.031 + uTime * 0.9) * 0.6 + sin(p.y * 0.023 - uTime * 0.7) * 0.8 + sin((p.x + p.y) * 0.017 + uTime * 0.5);
      }
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vec2 p = rotY2(w.xz, uGridYaw) + uGridOff;
        // The genome warps the land (strangeness) and sets its scale.
        p += sin(p.yx * 0.018 + uTime * 0.3) * gene(15) * 26.0;
        // Beside and beyond the paths the land may rise; the fan in front stays flat.
        vec2 rel = w.xz - cameraPosition.xz;
        float mask = max(smoothstep(85.0, 220.0, abs(rel.x)), smoothstep(230.0, 420.0, -rel.y)) * step(rel.y, 60.0);
        float bin = clamp(abs(atan(rel.x, -rel.y)) / 3.14159 * 31.0, 0.0, 31.0);
        float spec = uSpectrum[int(bin)];
        float h = 0.0;
        vec2 ps = seeded(p, length(rel));
        if (wF(0.0)) {
          // Generation 1, ridges, breathing with the bass and the spectrum.
          h = ridged(ps * 0.012 * mix(0.5, 2.0, gene(2))) * 34.0 * mix(0.4, 1.8, gene(3)) * mask * uGen.x * (0.75 + 0.4 * uBass + 0.5 * spec);
        } else if (wF(1.0)) {
          // Chromozon: far swells of liquid chrome, growing as the world evolves.
          h = (swell(ps * mix(0.6, 1.8, gene(2))) + 1.5) * mask * (6.0 + 10.0 * uEvo) * mix(0.5, 1.8, gene(3)) * (0.7 + 0.6 * uBass);
        } else if (wF(3.0)) {
          // Nachtflug: mountains all round, taller as the night goes on.
          float near = max(smoothstep(60.0, 160.0, abs(rel.x)), smoothstep(160.0, 320.0, -rel.y)) * step(rel.y, 60.0);
          h = ridged(ps * 0.009 * mix(0.5, 2.0, gene(2))) * (40.0 + 50.0 * uEvo) * mix(0.5, 1.6, gene(3)) * near * (0.8 + 0.35 * uBass + 0.4 * spec);
        }
        // Silence flattens the land; the mix raises it.
        // Channel 1's low raises the land.
        float rise = (0.06 + 0.94 * smoothstep(0.0, 0.75, uMix)) * (0.55 + 0.9 * uChan[0]);
        w.y += h * rise;
        h *= rise;
        vHeight = h;
        vWorld = w.xyz;
        vGrid = p;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform float uRipple;
      varying vec3 vWorld;
      varying vec2 vGrid;
      varying float vHeight;
      float grid(vec2 p, float cell, float width) {
        vec2 g = p / cell;
        vec2 d = abs(fract(g - 0.5) - 0.5) / fwidth(g);
        return 1.0 - min(min(d.x, d.y) / width, 1.0);
      }
      void main() {
        vec3 rel = vWorld - cameraPosition;
        float dist = length(rel.xz);
        // The pattern shifts with the track (its seed) and the loudest channel (the variant).
        vec2 p = vGrid + (dist > uSeedFront ? uSeedB : uSeedA) * vec2(3.7, 5.3);
        if (variant(1.0) + variant(3.0) > 0.5) p = rot45(p);
        // The genome turns and scales the floor's pattern.
        p = rotY2(p, gene(1) * 0.785) / mix(0.6, 1.8, gene(0));
        float bass = clamp(uBass, 0.0, 1.3);
        float fade = exp(-dist * 0.0075 * mix(0.6, 1.6, gene(13)));
        vec3 accent = neon(uAccent);
        vec3 col;
        float lines;
        if (wF(1.0)) {
          // Chromozon: a chrome sea. Wave normals (finer as it evolves) reflect the sunset.
          float k = (0.08 + 0.06 * uEvo) * (1.0 + 0.3 * uVariant);
          vec2 g = vec2(cos(p.x * k + uTime * 1.3) + 0.6 * cos((p.x + p.y) * k * 1.7 - uTime), sin(p.y * k * 0.8 - uTime * 1.1) + 0.6 * cos((p.y - p.x) * k * 1.3 + uTime * 0.8));
          vec3 n = normalize(vec3(-g.x * (0.12 + 0.12 * bass), 1.0, -g.y * (0.12 + 0.12 * bass)));
          vec3 v = normalize(rel);
          vec3 r = reflect(v, n);
          col = sunset(max(r.y, 0.0)) * (0.3 + 0.3 * fade);
          float sun = pow(max(0.0, dot(r, normalize(vec3(0.0, 0.1, -1.0)))), 120.0);
          col += vec3(1.0, 0.8, 0.5) * sun * 1.4;
          lines = grid(p, 8.0, 1.2) * 0.25;
          col += accent * lines * fade * (0.3 + 0.4 * bass);
          col = mix(col, sunset(0.0) * 0.4, 1.0 - exp(-dist * 0.004));
        } else if (wF(3.0)) {
          // Nachtflug: deep blue land, teal wire, glowing peaks.
          lines = max(grid(p, 4.0, 1.0) * 0.15, grid(p, 12.0 + 4.0 * uVariant, 1.4 + bass));
          col = vec3(0.004, 0.01, 0.03) + accent * lines * fade * (0.25 + 0.5 * bass + 0.3 * uEvo);
          col += mix(accent, vec3(1.0), 0.5) * lines * smoothstep(20.0, 70.0, vHeight) * (0.6 + bass);
          col = mix(col, vec3(0.01, 0.03, 0.08), 1.0 - exp(-dist * 0.003));
        } else if (wF(4.0)) {
          // Kupferzeit: the classic checkerboard, scrolling faster as it evolves.
          vec2 c = p / ((10.0 - 4.0 * uEvo) * (1.0 + 0.35 * uVariant));
          vec2 fw = fwidth(c);
          vec2 sq = smoothstep(-fw, fw, fract(c) - 0.5) ;
          float check = abs(sq.x - sq.y);
          lines = check;
          col = mix(vec3(0.01, 0.0, 0.02), accent * (0.18 + 0.3 * bass), check) * fade;
          col += accent * 0.06 * (1.0 - fade);
        } else {
          float cell = 8.0 * (1.0 + 0.5 * mod(uVariant, 2.0));
          float minor = grid(p, cell / 4.0, 0.8) * 0.05 * (1.0 - 0.6 * variant(2.0));
          float major = grid(p, cell, 0.9 + 0.6 * bass);
          // As the grid world evolves, diagonal traces join the grid.
          vec2 dp = vec2(p.x + p.y, p.x - p.y) * 0.7071;
          float diag = grid(dp, 16.0, 1.0) * smoothstep(0.3, 0.8, uEvo) * 0.35;
          lines = max(max(minor, major), diag);
          col = vec3(0.012, 0.004, 0.03);
          col += accent * lines * fade * (0.18 + 0.4 * bass + 0.15 * uEnergy) * (1.0 - 0.55 * uVigil);
          col += mix(accent, uHot * 2.0, 0.5) * lines * smoothstep(8.0, 30.0, vHeight) * (0.4 + 0.6 * bass) * fade;
          // A laser sweeps the grid once the world has grown.
          float sweep = exp(-abs(fract(p.y / 300.0 - uTime * 0.25) - 0.5) * 60.0) * smoothstep(0.5, 1.0, uEvo);
          col += mix(accent, vec3(1.0), 0.5) * sweep * fade * 0.6;
          col += accent * (0.04 + 0.1 * bass) * (1.0 - fade) * (1.0 - 0.5 * uVigil);
        }
        // Channel 1's mids light the ground's lines; its highs make it shimmer.
        col *= 0.65 + 0.8 * uChan[1];
        float glint = step(0.985, hash21(floor(vGrid * 0.5) + floor(uTime * 12.0)));
        col += mix(accent, vec3(1.0), 0.6) * glint * uChan[2] * 1.4 * fade * (0.3 + lines);
        // The new land's front, sweeping in from the horizon.
        if (uSeedFront > 0.0) col += mix(accent, vec3(1.0), 0.6) * exp(-abs(dist - uSeedFront) * 0.08) * 1.2;
        // Everywhere: the kick's ring, the beat's ring, the data flow, a drop's shock wave.
        float kring = exp(-abs(dist - uKickAge * 220.0) * 0.12) * exp(-uKickAge * 2.5);
        col += mix(accent, vec3(1.0), 0.5) * kring * (0.4 + 1.2 * lines) * (1.0 - uVigil);
        float ring = exp(-abs(dist - uBeatPhase * 140.0) * 0.18) * uBeat * fade;
        col += mix(accent, vec3(1.0), 0.4) * ring * (0.25 + lines) * 0.5 * (1.0 - uVigil);
        col += accent * lines * (uKick * 0.3 + uData * 0.25) * fade;
        if (uRipple >= 0.0) col += vec3(1.0) * exp(-abs(dist - uRipple * 260.0) * 0.08) * (1.0 - uRipple) * 1.6;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Tunnelwerk: an Amiga checkerboard tunnel around the paths, twisting as it evolves.

export function makeWorldTunnel(s: Shared) {
  const geo = new THREE.CylinderGeometry(70, 70, 1000, 64, 1, true);
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, -440);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { ...pick(s) },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vDepth;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying vec2 vUv;
      varying float vDepth;
      void main() {
        float along = vUv.y * 1000.0;
        float twist = (sin(along * 0.004 + uTime * 0.6) * (0.4 + 1.6 * uEvo) + uTime * 0.05) * (0.2 + 0.8 * smoothstep(0.0, 0.75, uMix));
        vec2 c = vec2((vUv.x + twist * 0.1) * (16.0 + 16.0 * floor(uEvo * 2.0 + 0.5)), (along + uTravel * 1.0) / 22.0);
        vec2 fw = fwidth(c);
        vec2 sq = smoothstep(-fw, fw, fract(c) - 0.5);
        float check = mod(uVariant, 2.0) > 0.5 ? sq.x : abs(sq.x - sq.y);
        vec3 accent = neon(uAccent);
        vec3 col = mix(vec3(0.0), mix(vec3(0.75), accent, 0.35), check) * (0.16 + 0.28 * uBass);
        // Rings of light race along the walls on the beat.
        float ring = exp(-abs(fract(along / 120.0 - uTime * 0.8) - 0.5) * 40.0);
        col += accent * ring * (0.4 + 1.2 * uKick);
        col *= exp(-vDepth * 0.008) * (1.0 - 0.5 * uVigil);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// MIDI data packets: every message from the mixer launches a glowing packet from
// its pod's side, coloured by its deck, arcing away over the grid with a trail.

export const PACKETS = 48;
const TRAIL = 12;

export function makePackets(s: Shared) {
  const idx = new Float32Array(PACKETS * TRAIL);
  const trail = new Float32Array(PACKETS * TRAIL);
  for (let i = 0; i < PACKETS; i++)
    for (let k = 0; k < TRAIL; k++) {
      idx[i * TRAIL + k] = i;
      trail[i * TRAIL + k] = k / TRAIL;
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PACKETS * TRAIL * 3), 3));
  geo.setAttribute('aIdx', new THREE.BufferAttribute(idx, 1));
  geo.setAttribute('aTrail', new THREE.BufferAttribute(trail, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { ...pick(s), uPackets: s.uPackets, uDeckColor: s.uDeckColor, uDpr: s.uDpr },
    vertexShader: /* glsl */ `
      ${COMMON}
      uniform vec4 uPackets[${PACKETS}];
      uniform float uDeckColor[12];
      uniform float uDpr;
      attribute float aIdx, aTrail;
      varying float vFade;
      varying vec3 vColor;
      void main() {
        vec4 P = uPackets[int(aIdx + 0.5)];
        float age = uTime - P.y - aTrail * 0.045;
        if (age < 0.0 || age > 1.3) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vFade = 0.0; return; }
        float seed = hash11(aIdx * 7.13 + floor(P.y * 10.0));
        vec3 start = vec3(cameraPosition.x + P.x * 16.0, 0.8, cameraPosition.z - 8.0);
        vec3 dir = normalize(vec3(-P.x * 0.3 + (seed - 0.5) * 0.9, 0.0, -1.0));
        vec3 p = start + dir * age * (85.0 + 70.0 * P.z);
        p.y += sin(min(age / 1.1, 1.0) * 3.14159) * (5.0 + 16.0 * P.z);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (1.0 - aTrail) * (8.0 + 12.0 * P.z) * uDpr * 40.0 / max(10.0, -mv.z);
        vFade = (1.0 - aTrail) * (1.0 - age / 1.3);
        int d = int(P.w + 0.5);
        vColor = P.w >= 0.0 ? deckNeon(vec3(uDeckColor[d * 3], uDeckColor[d * 3 + 1], uDeckColor[d * 3 + 2])) : neon(uAccent);
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying float vFade;
      varying vec3 vColor;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = exp(-dot(c, c) * 16.0) * vFade;
        gl_FragColor = vec4(mix(vColor, vec3(1.0), 0.4) * a * 1.6, 1.0);
      }`,
  });
  const mesh = new THREE.Points(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Generation 2, monoliths: black slabs with neon edges, placed on the grid by hash,
// streaming past beside the paths, pumping with the bass.

const MONO_CELL = 44;
const MONO_SPAN = 10;

export function makeMonoliths(s: Shared) {
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = box.index;
  geo.setAttribute('position', box.attributes.position);
  geo.setAttribute('uv', box.attributes.uv);
  const side = MONO_SPAN * 2 + 1;
  const cells = new Float32Array(side * side * 2);
  for (let i = 0; i < side; i++) for (let k = 0; k < side; k++) cells.set([i - MONO_SPAN, k - MONO_SPAN], (i * side + k) * 2);
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
  geo.instanceCount = side * side;
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...pick(s), uGridYaw: s.uGridYaw, uGridOff: s.uGridOff, uCamGrid: s.uCamGrid },
    vertexShader: /* glsl */ `
      ${COMMON}
      uniform float uGridYaw;
      uniform vec2 uGridOff, uCamGrid;
      attribute vec2 aCell;
      varying vec2 vUv;
      varying float vDepth;
      varying float vH;
      varying float vSeed;
      void main() {
        vec2 cell = floor(uCamGrid / ${MONO_CELL}.0) + aCell;
        vec2 cellCentre = rotY2((cell + 0.5) * ${MONO_CELL}.0 - uGridOff, -uGridYaw) - cameraPosition.xz;
        float seed = length(cellCentre) > uSeedFront ? uSeedB : uSeedA;
        vec2 sc = cell + seed * 17.0;
        float h0 = hash21(sc), h1 = hash21(sc + 13.7), h2 = hash21(sc + 71.3);
        vec2 g = (cell + vec2(0.1 + 0.8 * h1, 0.1 + 0.8 * h2)) * ${MONO_CELL}.0;
        vec2 wxz = rotY2(g - uGridOff, -uGridYaw);
        vec2 rel = wxz - cameraPosition.xz;
        // Only some cells, never on the paths ahead, and they rise as the generation builds.
        // We fly between them: they crowd up beside our line, leave a narrow lane on it,
        // and keep off the paths and gates ahead.
        float lane = step(abs(rel.x), 5.0 + 3.0 * h1);
        float fan = step(abs(rel.x), 62.0) * step(rel.y, -30.0) * step(-95.0, rel.y);
        float density = 0.42 + 0.4 * step(abs(rel.x), 45.0) * step(-30.0, rel.y);
        float keep = step(h0, density) * (1.0 - lane) * (1.0 - fan);
        float grow = smoothstep(h0 * 0.6, h0 * 0.6 + 0.4, uGen.y);
        float pump = 1.0 + 0.35 * uBass * (0.5 + 0.5 * sin(h1 * 40.0 + uTime * 2.0)) + 0.25 * uKick;
        float height = (10.0 + 46.0 * h2 * h2) * grow * pump * keep * (0.08 + 0.92 * smoothstep(0.0, 0.75, uMix)) * mix(0.5, 2.0, gene(6));
        float width = (2.5 + 4.0 * h1) * keep * step(0.01, grow);
        vec3 p = position * vec3(width, height, width);
        // The genome twists and tapers them.
        float up = position.y;
        p.xz *= 1.0 - gene(5) * 0.8 * up;
        float tw = (gene(4) - 0.5) * 4.0 * up + h1 * 6.28;
        p.xz = vec2(p.x * cos(tw) - p.z * sin(tw), p.x * sin(tw) + p.z * cos(tw));
        vec4 w = vec4(p.x + wxz.x, p.y, p.z + wxz.y, 1.0);
        vUv = uv;
        vH = height;
        vSeed = h1;
        vec4 mv = viewMatrix * w;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying vec2 vUv;
      varying float vDepth;
      varying float vH;
      varying float vSeed;
      void main() {
        vec2 e2 = min(vUv, 1.0 - vUv);
        float e = min(e2.x, e2.y);
        float edge = 1.0 - smoothstep(0.0, fwidth(e) * 1.6, e);
        // Scan bands climbing the faces.
        float scan = pow(0.5 + 0.5 * sin(vUv.y * 18.0 - uTime * 4.0 - vSeed * 20.0), 18.0);
        vec3 accent = neon(uAccent);
        vec3 col = vec3(0.004, 0.002, 0.012);
        col += accent * edge * (0.8 + 1.2 * uBass + uKick);
        col += accent * scan * (0.15 + 0.5 * uBass);
        col *= exp(-vDepth * 0.005) * (1.0 - 0.5 * uVigil);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Generation 3, the hypertunnel: hexagon frames you fly through, flashing on kicks.

export const RINGS = 10;
export const RING_GAP = 42;

export function makeTunnel(s: Shared) {
  // Rings of 48 segments; the shader bends each into the genome's polygon (3-8 sides).
  const SEG = 48,
    T = 0.9;
  const pos: number[] = [],
    ring: number[] = [],
    side: number[] = [];
  for (let r = 0; r < RINGS; r++)
    for (let k = 0; k < SEG; k++) {
      const a0 = (k / SEG) * Math.PI * 2,
        a1 = ((k + 1) / SEG) * Math.PI * 2;
      const pts = [
        [a0, -1],
        [a0, 1],
        [a1, 1],
        [a1, -1],
      ];
      for (const i of [0, 1, 2, 0, 2, 3]) {
        pos.push(pts[i][0], pts[i][1] * T, 0);
        ring.push(r);
        side.push(pts[i][1]);
      }
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aRing', new THREE.Float32BufferAttribute(ring, 1));
  geo.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { ...pick(s), uTunnel: s.uTunnel },
    vertexShader: /* glsl */ `
      ${COMMON}
      uniform float uTunnel;
      attribute float aRing, aSide;
      varying float vSide, vZ, vRing;
      void main() {
        float z = 20.0 - mod(aRing * ${RING_GAP}.0 + uTunnel, ${RINGS * RING_GAP}.0);
        float spin = aRing * 0.35 + uTime * 0.15;
        float sides = floor(mix(3.0, 8.99, gene(8)));
        float r = (52.0 * mix(0.6, 1.4, gene(9)) + position.y) * ngon(position.x, sides) * (1.0 + 0.06 * uKick);
        float a = position.x + spin;
        vec2 xy = vec2(cos(a), sin(a)) * r;
        vec4 w = vec4(cameraPosition.x + xy.x, 16.0 + xy.y, cameraPosition.z + z, 1.0);
        vSide = aSide;
        vZ = z;
        vRing = aRing;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying float vSide, vZ, vRing;
      void main() {
        float core = exp(-vSide * vSide * 4.0);
        float near = smoothstep(18.0, 0.0, vZ) * smoothstep(${-RINGS * RING_GAP + 20}.0, -250.0, vZ);
        vec3 accent = neon(uAccent);
        float flash = uKick * step(0.5, fract(vRing * 0.5 + 0.25));
        vec3 col = mix(accent, vec3(1.0), 0.15 + 0.4 * uKick) * core * (0.18 + 0.35 * uBass + 0.9 * flash);
        gl_FragColor = vec4(col * near * uGen.z * (1.0 - 0.6 * uVigil), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Phrase arches: a huge polygon frame on each coming 8-bar phrase downbeat, placed
// so we fly through it exactly on the downbeat; it flashes as we pass.

export function makeArches(s: Shared) {
  const SEG = 48;
  const pos: number[] = [],
    idx: number[] = [];
  for (let r = 0; r < 4; r++)
    for (let k = 0; k < SEG; k++) {
      const a0 = (k / SEG) * Math.PI * 2,
        a1 = ((k + 1) / SEG) * Math.PI * 2;
      const pts = [
        [a0, -1],
        [a0, 1],
        [a1, 1],
        [a1, -1],
      ];
      for (const i of [0, 1, 2, 0, 2, 3]) {
        pos.push(pts[i][0], pts[i][1], 0);
        idx.push(r);
      }
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aIdx', new THREE.Float32BufferAttribute(idx, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { ...pick(s), uArch: s.uArch },
    vertexShader: /* glsl */ `
      ${COMMON}
      uniform vec4 uArch[4];
      attribute float aIdx;
      varying float vSide, vFlash, vAlpha, vDepth;
      void main() {
        vec4 A = uArch[int(aIdx + 0.5)];
        if (A.w <= 0.001) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; return; }
        float r = (34.0 + position.y * (1.2 + 1.5 * A.z)) * ngon(position.x + aIdx * 0.7, A.y);
        vec3 w = vec3(cameraPosition.x + cos(position.x + aIdx * 0.7) * r, 14.0 + sin(position.x + aIdx * 0.7) * r, cameraPosition.z - A.x);
        vec4 mv = viewMatrix * vec4(w, 1.0);
        vDepth = -mv.z;
        vSide = position.y;
        vFlash = A.z;
        vAlpha = A.w;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying float vSide, vFlash, vAlpha, vDepth;
      void main() {
        float core = exp(-vSide * vSide * 3.0);
        vec3 accent = neon(uAccent);
        vec3 col = mix(accent, vec3(1.0), 0.3 + 0.6 * vFlash) * core * (0.5 + 2.5 * vFlash);
        col *= vAlpha * exp(-vDepth * 0.0025) * smoothstep(2.0, 18.0, vDepth + 8.0 * vFlash);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Generation 4, orbit: a giant wireframe planet with a ring rising off to the right.

export function makePlanet(s: Shared, geo: THREE.BufferGeometry) {
  const alpha = { value: 0 };
  const mat = wireMaterial(s, alpha);
  mat.uniforms.uWidth.value = 1.2;
  mat.uniforms.uSim.value = 1;
  mat.uniforms.uFog.value = 0.0004;
  const planet = new THREE.Mesh(geo, mat);
  planet.frustumCulled = false;
  const ringGeo = new THREE.RingGeometry(1.45, 1.6, 96, 1);
  const ringMat = glowMaterial(s, alpha, false);
  ringMat.uniforms.uFog.value = 0.0004;
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.frustumCulled = false;
  ring.rotation.x = -1.2;
  planet.add(ring);
  return { planet, alpha, lit: mat.uniforms.uLit as { value: number }, ringLit: ringMat.uniforms.uLit as { value: number } };
}

// ---------------------------------------------------------------------------
// Sky: black to violet, stars, the horizon glow and four copper bars (the decks).

export function makeSky(s: Shared) {
  const geo = new THREE.SphereGeometry(500, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: { ...pick(s), uDeckColor: s.uDeckColor, uDeckLevel: s.uDeckLevel, uDeckPhase: s.uDeckPhase, uGen5: s.uGen5 },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform float uDeckColor[12];
      uniform float uDeckLevel[4];
      uniform float uDeckPhase[4];
      uniform float uGen5;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float el = d.y;
        float az = atan(d.x, -d.z);
        vec3 accent = neon(uAccent);
        float dim = 1.0 - 0.5 * uVigil;
        vec3 col;
        if (wS(1.0)) {
          // Chromozon: sunset, and a striped sun that grows as the world evolves.
          col = sunset(max(el, 0.0)) * 0.75;
          vec2 sp = vec2(az, el - 0.05);
          float r = 0.13 + 0.06 * uEvo + 0.01 * uBass;
          float disc = smoothstep(r, r - 0.006, length(sp));
          float slits = step(0.35 + 0.25 * (0.05 - sp.y) / r, fract(sp.y * (40.0 + 30.0 * uEvo) + uTime * 0.6));
          disc *= sp.y > 0.0 ? 1.0 : slits;
          col = mix(col, mix(vec3(1.0, 0.9, 0.4), vec3(1.0, 0.25, 0.5), smoothstep(0.1, -0.1, sp.y)), disc);
          col += vec3(1.0, 0.5, 0.3) * exp(-length(sp) * 9.0) * 0.35;
        } else if (wS(2.0)) {
          col = vec3(0.0);
        } else if (wS(3.0)) {
          // Nachtflug: deep night, dense stars and aurora curtains that spread as the night goes on.
          col = mix(vec3(0.0, 0.02, 0.06), vec3(0.0, 0.0, 0.01), smoothstep(0.0, 0.4, el));
          float curtain = 0.0;
          for (int i = 0; i < 3; i++) {
            float fi = float(i);
            float x = az * (2.0 + fi) + sin(az * 3.0 + uTime * (0.2 + fi * 0.1)) * 0.8 + fi * 2.1;
            float band = exp(-pow(el - 0.12 - 0.05 * fi - 0.03 * sin(x + uTime * 0.3), 2.0) * 300.0);
            float streak = 0.5 + 0.5 * sin(x * 20.0 + uTime * 2.0);
            curtain += band * (0.5 + 0.5 * streak);
          }
          vec3 aur = mix(vec3(0.1, 1.0, 0.6), vec3(0.6, 0.2, 1.0), smoothstep(0.08, 0.25, el));
          col += aur * curtain * (0.25 + 0.6 * uEvo) * (0.5 + 0.5 * uBass + 0.9 * uChan[4]) * dim;
        } else if (wS(4.0)) {
          // Kupferzeit: rainbow copper bars fill the sky, more of them as it evolves.
          col = vec3(0.01, 0.0, 0.02);
          float bars = 5.0 + floor(uEvo * 9.0);
          for (int i = 0; i < 14; i++) {
            if (float(i) >= bars) break;
            float fi = float(i);
            float centre = 0.03 + 0.14 * (0.5 + 0.5 * sin(uTime * (0.7 + fi * 0.13) + fi * 1.7));
            float t = max(0.0, 1.0 - abs(el - centre) / 0.012);
            vec3 hue = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + fi * 0.9 + uTime * 0.3);
            col = mix(col, mix(hue * 0.4, hue + 0.3, t * t), step(0.001, t) * t);
          }
          col *= 0.6 + 0.4 * uBass + 0.7 * uChan[4];
        } else {
          col = mix(vec3(0.05, 0.0, 0.09), vec3(0.0, 0.0, 0.012), smoothstep(-0.02, 0.45, el));
        }
        if (!wS(1.0) && !wS(2.0)) col += accent * exp(-abs(el) * 30.0) * (0.15 + 0.35 * uBass + 0.5 * uChan[3]) * dim;
        if (uGen5 > 0.0 && (wS(0.0) || wS(4.0))) {
          vec2 q = vec2(az * 3.0, el * 9.0);
          float t = uTime * (0.4 + 0.8 * uBass);
          float v = sin(q.x * 2.0 + t) + sin(q.y * 3.0 - t * 1.3) + sin((q.x + q.y) * 1.7 + t * 0.7) + sin(length(q - vec2(sin(t * 0.3) * 3.0, 1.0)) * 3.0);
          vec3 pc = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + v * 1.4 + t * 0.2);
          col += mix(pc, accent, 0.45) * smoothstep(0.02, 0.12, el) * uGen5 * (0.12 + 0.25 * uBass) * dim;
        }
        if (!wS(2.0)) {
          // Stars; more of them as any world evolves, and a sky full of them at night.
          vec2 sp = vec2(az * 60.0, el * 60.0);
          vec2 cell = floor(sp);
          float h = hash21(cell);
          vec2 f = fract(sp) - vec2(hash21(cell + 7.1), hash21(cell + 3.7));
          float density = (wS(3.0) ? 0.8 : 0.93 - 0.05 * uEvo) - 0.06 * gene(10);
          float star = step(density, h) * exp(-dot(f, f) * 90.0) * (0.5 + 0.5 * sin(uTime * (2.0 + h * 5.0) + h * 40.0));
          col += vec3(0.8, 0.85, 1.0) * star * smoothstep(0.03, 0.2, el) * (wS(1.0) ? 0.3 : 1.0) * (0.4 + 1.6 * uChan[5]);
        }
        // Copper bars: one per deck, bouncing on the deck's own beat, lit by its level.
        for (int i = 0; i < 4; i++) {
          vec3 dc = deckNeon(vec3(uDeckColor[i * 3], uDeckColor[i * 3 + 1], uDeckColor[i * 3 + 2]));
          float centre = 0.035 + float(i) * 0.026 + 0.01 * abs(sin(3.14159 * uDeckPhase[i]));
          float t = abs(el - centre) / 0.008;
          float bar = max(0.0, 1.0 - t);
          vec3 copper = mix(dc * 0.5, dc + 0.35, pow(bar, 3.0));
          col += copper * bar * bar * uDeckLevel[i] * 0.55 * dim * (wS(2.0) ? 0.0 : 1.0) * (0.6 + 0.8 * uChan[4]);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

// ---------------------------------------------------------------------------
// Rails: the trunk, the branches to every gate and the grand rails beyond.

export type TreeUniforms = {
  uLit: { value: Float32Array };
  /** Where the light head running down each child rail is (u), or below −1 for none. */
  uHead: { value: Float32Array };
  uGrandLit: { value: Float32Array };
  uGrandGrow: { value: Float32Array };
  uAlpha: { value: number };
};

export function makeRails(s: Shared, u: TreeUniforms) {
  const capacity = TRUNK_SEGMENTS + MAX_CHILDREN * RAIL_SEGMENTS + MAX_GRANDS * GRAND_SEGMENTS;
  const positions = new Float32Array(capacity * 6 * 3);
  const rails = new Float32Array(capacity * 6 * 4);
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const aRail = new THREE.BufferAttribute(rails, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('aRail', aRail);
  geo.setDrawRange(0, 0);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { ...pick(s), ...u },
    vertexShader: /* glsl */ `
      attribute vec4 aRail;
      varying vec4 vRail;
      varying float vDepth;
      void main() {
        vRail = aRail;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform float uLit[8];
      uniform float uHead[8];
      uniform float uGrandLit[6];
      uniform float uGrandGrow[6];
      uniform float uAlpha;
      varying vec4 vRail;
      varying float vDepth;
      void main() {
        int slot = int(vRail.x + 0.5);
        float u = vRail.y, side = vRail.z, dist = vRail.w;
        float lit, head;
        if (slot >= 8) {
          // Grand rails sprout from the aimed gate: they exist only up to their growth.
          float grow = uGrandGrow[slot - 8];
          if (u > grow) discard;
          lit = uGrandLit[slot - 8];
          head = grow < 0.999 ? grow : -9.0;
        } else { lit = uLit[slot]; head = uHead[slot]; }
        float core = exp(-side * side * 10.0);
        float halo = exp(-side * side * 2.2) * 0.35;
        vec3 accent = neon(uAccent);
        // Packets of light race down the rails toward the gates.
        float packet = pow(0.5 + 0.5 * sin(dist * (0.55 + 0.45 * uEvo) * mix(0.6, 1.8, gene(11)) - uFlow * 0.55), 14.0);
        float front = exp(-abs(u - head) * 22.0) * step(u, head + 0.02);
        float look = 1.0;
        vec3 base = accent;
        if (wP(1.0)) {
          // Chromozon: wide chrome ribbons, banded like polished metal, glinting gold.
          core = smoothstep(1.0, 0.7, abs(side));
          halo = 0.0;
          float band = 0.5 + 0.5 * sin(side * 6.0 + dist * 0.05 - uTime);
          base = mix(sunset(0.05 + 0.3 * band), vec3(1.0, 0.85, 0.6), pow(band, 8.0));
        } else if (wP(2.0)) {
          // Tunnelwerk: a checkered track, block by block.
          float blocks = step(0.5, fract(dist * 0.25 + (side > 0.0 ? 0.5 : 0.0)));
          core = smoothstep(1.0, 0.85, abs(side)) * (0.25 + 0.75 * blocks);
          halo = 0.0;
          base = mix(vec3(0.9), accent, 0.3);
        } else if (wP(3.0)) {
          // Nachtflug: a runway of landing lights, chasing toward the gates.
          float light = exp(-pow(fract(dist * 0.3 - uFlow * 0.15) - 0.5, 2.0) * 120.0);
          core = exp(-side * side * 3.0) * light * 1.8 + exp(-side * side * 30.0) * 0.15;
          halo = 0.0;
        } else if (wP(4.0)) {
          // Kupferzeit: copper bars, rainbow along the rail.
          core = smoothstep(1.0, 0.6, abs(side)) * (0.6 + 0.4 * (1.0 - abs(side)));
          halo = 0.0;
          base = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + dist * 0.06 - uTime * 0.8);
        }
        vec3 col = base * (core + halo) * (0.22 + 0.9 * lit) * (0.6 + 0.5 * uBass + 0.7 * uChan[6]) * look;
        col += vec3(1.0) * core * uKick * (0.25 + 0.6 * lit);
        col += mix(accent, vec3(1.0), 0.55) * packet * core * (0.25 + 1.6 * lit) * (1.0 - 0.8 * uVigil);
        col += uHot * core * lit * (0.35 + 0.4 * uBeat);
        col += vec3(1.0) * front * core * 3.0;
        if (slot >= 8) col *= 1.6;
        col *= uAlpha * exp(-vDepth * 0.004);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return { mesh, positions, rails, aPos, aRail };
}

// ---------------------------------------------------------------------------
// Gates: demo-classic wireframe solids (icosahedron, octahedron, tetrahedron, geodesic).

function wireGeometry(g: THREE.BufferGeometry) {
  const geo = g.index ? g.toNonIndexed() : g;
  const n = geo.attributes.position.count;
  const bary = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) bary[i * 3 + (i % 3)] = 1;
  geo.setAttribute('aBary', new THREE.BufferAttribute(bary, 3));
  return geo;
}

export function gateGeometries() {
  return [
    wireGeometry(new THREE.IcosahedronGeometry(1, 0)),
    wireGeometry(new THREE.OctahedronGeometry(1, 0)),
    wireGeometry(new THREE.TetrahedronGeometry(1.15, 0)),
    wireGeometry(new THREE.IcosahedronGeometry(1, 1)),
  ];
}

const WIRE_VERT = /* glsl */ `
  attribute vec3 aBary;
  varying vec3 vBary;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying float vDepth;
  void main() {
    vBary = aBary;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDir = normalize(-mv.xyz);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;

export function wireMaterial(s: Shared, alpha: { value: number }) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { ...pick(s), uAlpha: alpha, uLit: { value: 0 }, uSim: { value: 0.5 }, uWidth: { value: 1.4 }, uFog: { value: 0.006 }, uTint: { value: new THREE.Vector3() }, uTintMix: { value: 0 } },
    vertexShader: WIRE_VERT,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform float uAlpha, uLit, uSim, uWidth, uFog, uTintMix;
      uniform vec3 uTint;
      varying vec3 vBary;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      varying float vDepth;
      void main() {
        float e = min(min(vBary.x, vBary.y), vBary.z);
        float px = e / max(fwidth(e), 1e-4);
        float width = uWidth * (1.0 + 1.2 * uLit);
        float wire = 1.0 - smoothstep(width - 0.6, width + 0.6, px);
        float glow = exp(-px * 0.35) * 0.3;
        float rim = pow(1.0 - abs(dot(normalize(vNormalV), normalize(vViewDir))), 2.0);
        vec3 accent = neon(uAccent);
        vec3 c = mix(accent, vec3(1.0), 0.1 + 0.35 * uLit);
        float fill = 0.0;
        if (wP(1.0)) {
          // Chromozon: filled chrome, reflecting the sunset at the rim.
          c = mix(sunset(0.1 + 0.4 * rim), vec3(1.0, 0.9, 0.7), 0.3 * uLit);
          fill = 0.25 + 0.5 * rim;
        } else if (wP(2.0)) {
          c = mix(vec3(1.0), accent, 0.25);
          width *= 1.8;
          wire = 1.0 - smoothstep(width - 0.6, width + 0.6, px);
        } else if (wP(3.0)) {
          glow *= 2.0;
        } else if (wP(4.0)) {
          c = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + vBary.x * 3.0 + vBary.y * 5.0 + uTime);
          fill = 0.12;
        }
        // A deck's guardian wears the deck's colour and answers only to its deck.
        vec3 tint = deckNeon(uTint);
        c = mix(c, mix(tint, vec3(1.0), 0.25 * uLit), uTintMix);
        accent = mix(accent, tint, uTintMix);
        vec3 col = c * (wire * (0.6 + 0.9 * uLit) + glow * (0.18 + 0.35 * uLit) + fill * (0.4 + 0.6 * uLit));
        col += accent * rim * (0.04 + 0.12 * uLit);
        col *= mix((0.55 + 0.45 * uSim) * (0.6 + 0.4 * uBass + 0.6 * uKick + 0.4 * uBeat * uLit + 0.7 * uChan[7]), 1.0, uTintMix) * (1.0 - 0.5 * uVigil);
        col *= uAlpha * exp(-vDepth * uFog);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

/** A landing ring flat on the grid under each gate, and the aimed gate's light column. */
export function padGeometry() {
  const g = new THREE.RingGeometry(GATE_R * 1.25, GATE_R * 1.55, 48, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}
export function columnGeometry() {
  const g = new THREE.CylinderGeometry(0.55, 0.55, 90, 12, 1, true);
  g.translate(0, 45, 0);
  return g;
}

export function glowMaterial(s: Shared, alpha: { value: number }, column: boolean) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { ...pick(s), uAlpha: alpha, uLit: { value: 0 }, uFog: { value: 0.006 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vDepth;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: column
      ? /* glsl */ `
      ${COMMON}
      uniform float uAlpha, uLit, uFog;
      varying vec2 vUv;
      varying float vDepth;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float facing = pow(abs(dot(normalize(vN), normalize(vV))), 3.0);
        float rise = pow(1.0 - vUv.y, 2.5);
        float scan = 0.75 + 0.25 * sin(vUv.y * 120.0 - uTime * 18.0);
        vec3 col = mix(neon(uAccent), vec3(1.0), 0.5) * facing * rise * scan * uLit * (0.9 + 0.8 * uBeat);
        gl_FragColor = vec4(col * uAlpha * (1.0 - 0.5 * uVigil), 1.0);
      }`
      : /* glsl */ `
      ${COMMON}
      uniform float uAlpha, uLit, uFog;
      varying vec2 vUv;
      varying float vDepth;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float dash = step(0.5, fract(vUv.x * 24.0 + uTime * (0.4 + uLit * 1.5)));
        vec3 col = neon(uAccent) * (0.18 + 0.9 * uLit) * (0.6 + 0.4 * dash);
        gl_FragColor = vec4(col * uAlpha * exp(-vDepth * uFog) * (1.0 - 0.5 * uVigil), 1.0);
      }`,
  });
}

// ---------------------------------------------------------------------------
// Speed streaks: lines that race past the camera, longer the faster we go.

export function makeStreaks(s: Shared, count = 1400) {
  const pos = new Float32Array(count * 2 * 3);
  const end = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = (Math.random() - 0.5) * 160;
    const y = Math.random() < 0.6 ? -4.7 + Math.random() * 3 : -1.5 + Math.random() * 30;
    const z = Math.random() * 230;
    for (let k = 0; k < 2; k++) {
      pos.set([x, y, z], (i * 2 + k) * 3);
      end[i * 2 + k] = k;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: pick(s),
    vertexShader: /* glsl */ `
      uniform float uTravel, uSpeed, uEvo;
      uniform float uGenome[16];
      attribute float aEnd;
      varying float vA;
      void main() {
        vec3 p = position;
        p.z = mod(p.z + uTravel, 230.0) - 215.0;
        p.z -= aEnd * clamp(uSpeed * 0.06, 0.05, 14.0);
        vA = (1.0 - aEnd * 0.9) * smoothstep(-215.0, -150.0, p.z) * smoothstep(15.0, 2.0, p.z);
        // More of them as the world evolves, and all of them in a jump.
        vA *= step(fract(position.x * 13.17 + position.y * 7.31), (0.45 + 0.55 * uEvo) * mix(0.5, 1.2, uGenome[12]) + uSpeed * 0.004);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying float vA;
      void main() {
        float k = clamp(uSpeed / 40.0, 0.0, 1.0);
        gl_FragColor = vec4(mix(neon(uAccent), vec3(1.0), 0.6) * vA * (0.15 + 0.85 * k) * (0.4 + 0.6 * uBass + 0.6 * uData + 1.0 * uChan[11]) * (1.0 - uVigil * (1.0 - uData)), 1.0);
      }`,
  });
  const mesh = new THREE.LineSegments(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Post: bright pass, separable blur, then the composite.

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export function makePost() {
  const bright = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D tSrc;
      uniform vec2 uTexel;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
               + texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
        c *= 0.25;
        gl_FragColor = vec4(max(c - 0.7, 0.0) * 0.8, 1.0);
      }`,
  });
  const blur = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D tSrc;
      uniform vec2 uDir;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tSrc, vUv).rgb * 0.227;
        c += (texture2D(tSrc, vUv + uDir * 1.385).rgb + texture2D(tSrc, vUv - uDir * 1.385).rgb) * 0.316;
        c += (texture2D(tSrc, vUv + uDir * 3.231).rgb + texture2D(tSrc, vUv - uDir * 3.231).rgb) * 0.070;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const composite = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: null },
      tBloom: { value: null },
      tWide: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uAberr: { value: 0 },
      uFlash: { value: 0 },
      uCut: { value: 0 },
      uMist: { value: 0 },
      uBloom: { value: 1 },
      uScan: { value: 0.2 },
      uExposure: { value: 1 },
      /** The virtual pixel grid the world is drawn on (pixel art). */
      uLow: { value: new THREE.Vector2(480, 270) },
      uVanish: { value: new THREE.Vector2(0.5, 0.5) },
      uBeamX: { value: new Float32Array(4) },
      uBeamY: { value: 0 },
      uBeamLevel: { value: new Float32Array(4) },
      uBeamSway: { value: new Float32Array(4) },
      uDeckColor: { value: new Float32Array(12) },
      uFrame: { value: new THREE.Vector4(0, 0, 0, 0) },
    },
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D tScene, tBloom, tWide;
      uniform vec2 uRes, uVanish, uLow;
      uniform float uTime, uAberr, uFlash, uCut, uMist, uBloom, uBeamY, uScan, uExposure;
      uniform float uBeamX[4];
      uniform float uBeamLevel[4];
      uniform float uBeamSway[4];
      uniform float uDeckColor[12];
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      vec3 neon(vec3 c) { float l = dot(c, vec3(0.299, 0.587, 0.114)); return max(vec3(0.0), mix(vec3(l), c, 2.2)); }
      vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
      // 4×4 Bayer matrix, for ordered dithering.
      float bayer(vec2 c) {
        vec2 a = mod(c, 4.0);
        int i = int(a.x) + int(a.y) * 4;
        float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
        return m[i] / 16.0 - 0.47;
      }
      void main() {
        // Pixel art: everything is computed once per virtual pixel, then shown as a hard square.
        vec2 cell = floor(vUv * uLow);
        vec2 uv = (cell + 0.5) / uLow;
        // A cut: the frame tears into horizontal slices, whole pixels at a time.
        if (uCut > 0.0) {
          float band = floor(uv.y * 24.0 + floor(uTime * 40.0));
          float r = hash(vec2(band, floor(uTime * 30.0)));
          uv.x += floor((r - 0.5) * 0.12 * uCut * step(0.55, r) * uLow.x) / uLow.x;
        }
        vec2 dir = uv - 0.5;
        // Colour fringes in whole pixels.
        vec2 ab = floor(dir * (uAberr * dot(dir, dir) * 0.06 + uAberr * 0.0015) * uLow + 0.5) / uLow;
        vec3 col;
        col.r = texture2D(tScene, uv + ab).r;
        col.g = texture2D(tScene, uv).g;
        col.b = texture2D(tScene, uv - ab).b;
        col += (texture2D(tBloom, uv).rgb * 0.7 + texture2D(tWide, uv).rgb * 0.5) * uBloom;
        // Deck lasers, on the pixel grid.
        vec2 px = uv * uRes;
        float pscale = uRes.y / uLow.y;
        for (int i = 0; i < 4; i++) {
          if (uBeamLevel[i] <= 0.001) continue;
          vec2 a = vec2(uBeamX[i], uBeamY) * uRes;
          vec2 b = (uVanish + vec2(uBeamSway[i], 0.0)) * uRes;
          vec2 ab2 = b - a;
          float t = clamp(dot(px - a, ab2) / dot(ab2, ab2), 0.0, 1.0);
          float d = length(px - (a + ab2 * t)) / pscale;
          float w = mix(1.2, 0.5, t);
          vec3 dc = neon(vec3(uDeckColor[i * 3], uDeckColor[i * 3 + 1], uDeckColor[i * 3 + 2]));
          col += mix(dc, vec3(1.0), 0.2) * (step(d, w) + exp(-d / (w * 4.0)) * 0.08) * uBeamLevel[i] * (1.0 - t * 0.8);
        }
        // Scouting: the signal is weak beyond the last claimed track.
        if (uMist > 0.0) {
          float l = dot(col, vec3(0.299, 0.587, 0.114));
          col = mix(col, vec3(l) * vec3(0.75, 0.9, 1.0), 0.6 * uMist);
          col += (hash(cell + floor(uTime * 12.0)) - 0.5) * 0.06 * uMist;
        }
        col *= uExposure;
        col += vec3(uFlash);
        col = aces(col * 1.1);
        // Every other pixel row a touch darker (a CRT feel), and the vignette.
        col *= 1.0 - uScan * 0.35 * mod(cell.y, 2.0);
        col *= 1.0 - 0.55 * pow(length(dir * vec2(1.0, 0.8)) * 1.25, 3.0);
        col = pow(max(col, 0.0), vec3(1.0 / 2.2));
        // A small palette: 8 levels per channel, light ordered dithering between them.
        col = clamp(floor(col * 7.0 + 0.5 + bayer(cell) * 0.55) / 7.0, 0.0, 1.0);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), composite);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return { bright, blur, composite, quad, scene, camera };
}

/** The shared uniforms every material reads (the same objects, so one write reaches all). */
function pick(s: Shared) {
  return {
    uTime: s.uTime,
    uFlow: s.uFlow,
    uTravel: s.uTravel,
    uSpeed: s.uSpeed,
    uBeat: s.uBeat,
    uBeatPhase: s.uBeatPhase,
    uEnergy: s.uEnergy,
    uVigil: s.uVigil,
    uAccent: s.uAccent,
    uHot: s.uHot,
    uBass: s.uBass,
    uKick: s.uKick,
    uKickAge: s.uKickAge,
    uGen: s.uGen,
    uData: s.uData,
    uEvo: s.uEvo,
    uJumps: s.uJumps,
    uSeedA: s.uSeedA,
    uSeedB: s.uSeedB,
    uSeedFront: s.uSeedFront,
    uVariant: s.uVariant,
    uMix: s.uMix,
    uChan: s.uChan,
    uWorldF: s.uWorldF,
    uWorldS: s.uWorldS,
    uWorldP: s.uWorldP,
    uGenome: s.uGenome,
    uHue: s.uHue,
  };
}

/** Rotate (x, z) about +y by `a`, the way three's `rotation.y` does. */
export function rotY(x: number, z: number, a: number, out: { x: number; y: number }) {
  const c = Math.cos(a),
    s = Math.sin(a);
  out.x = x * c + z * s;
  out.y = -x * s + z * c;
  return out;
}

export function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export function hexInto(hex: string, out: Float32Array | number[], at: number) {
  const n = Number.parseInt(hex.slice(1), 16);
  out[at] = ((n >> 16) & 255) / 255;
  out[at + 1] = ((n >> 8) & 255) / 255;
  out[at + 2] = (n & 255) / 255;
}
