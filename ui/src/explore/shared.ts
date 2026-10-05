import * as THREE from 'three';

/**
 * Shared, mutable uniforms: every blade, tree, spire and route reads the same
 * ground, light and course. The engine writes them once per frame.
 */
export function makeShared() {
  return {
    uTime: { value: 0 },
    uWind: { value: 0 },
    uGrowth: { value: 0 },
    /** 0 low, 1 mid, 2 high: realm colours, crossfaded over 180 ms. */
    uBand: { value: 0 },
    /** The realm the routes and gates are drawn in (switches at once). */
    uRealmNow: { value: 0 },
    uLife: { value: 0 },
    uMotion: { value: 1 },
    /** Distance travelled along the Current, world units. */
    uCourse: { value: 0 },
    /** uCourse modulo a period that keeps water ripples exact over long sets. */
    uCourseW: { value: 0 },
    /** riverW(−uCourse): the river is re-centred under the vessel. */
    uRiver0: { value: 0 },
    /** Land grid snap (x, z) so the moving height field never swims between vertices. */
    uSnap: { value: new THREE.Vector2() },
    /** Terrain seed offsets of segments A, B, C (two-seed wipe, plus one queued). */
    uSeeds: { value: new THREE.Vector3() },
    /** Land-coordinate boundaries A|B and B|C (very negative = none). */
    uBounds: { value: new THREE.Vector2(-1e6, -1e6) },
    /** Realm of segments A, B, C. */
    uRealms: { value: new THREE.Vector3() },
    /** Course at which segments B and C began: furniture keeps the realm it was born in. */
    uStarts: { value: new THREE.Vector2(-1e6, -1e6) },
    /** Age of the mix: 0 dawn, 1 day, 2 dusk, 3 night, 4 second dawn. */
    uAge: { value: 0 },
    uNight: { value: 0 },
    uVigil: { value: 0 },
    /** Scouting: the land beyond is misted. */
    uMist: { value: 0 },
    uSun: { value: new THREE.Vector3(1, 0.96, 0.85) },
    uSunDir: { value: new THREE.Vector3(-0.48, 0.32, -0.84).normalize() },
    uHaze: { value: new THREE.Vector3(0.7, 0.72, 0.65) },
    uZenith: { value: new THREE.Vector3(0.26, 0.44, 0.52) },
    uFog: { value: 0.006 },
    uLight: { value: 1 },
    /** Ley lines and lanterns multiplier (brightest at night). */
    uMagic: { value: 1 },
    /** Band accent, linear-ish RGB 0..1. */
    uAccent: { value: new THREE.Vector3(0.89, 0.71, 0.4) },
    uSpectrum: { value: new Float32Array(64) },
    /** Window flicker: the realm's spectrum bins, τ 0.4 s. */
    uFlicker: { value: new Float32Array(8) },
    uDecks: { value: new THREE.Vector4() },
    /** Keepers' lantern pools on the water: x, z, intensity, radius. */
    uLantern: { value: new Float32Array(16) },
    uDeckColor: { value: new Float32Array(12) },
    /** Wayfinder: x, z on the water, aim direction xz. */
    uWay: { value: new THREE.Vector4(0, -16, 0, -1) },
    /** Previous beam direction xz, its fading strength, beam strength. */
    uWayPrev: { value: new THREE.Vector4(0, -1, 0, 1) },
    /** Per route slot: light (0 faint, 1 aimed); slot 7 is the taken route. */
    uRoute: { value: new Float32Array(8) },
    /** Per gate slot: ignition (1 lit, >1 = the 90 ms over-brightness). */
    uGate: { value: new Float32Array(8) },
    /** Phase within the bar, 0..1 (rune rings turn once per bar). */
    uBar: { value: 0 },
    /** Passage gate: centre xyz and radius; w < 0 hides it. */
    uPassage: { value: new THREE.Vector4(0, 0, 0, -1) },
    uPassageA: { value: 0 },
    /** Herald swallow: from xz, to xz; uHeraldT seconds since the aim. */
    uHerald: { value: new THREE.Vector4() },
    uHeraldY: { value: 6 },
    uHeraldT: { value: 99 },
    /** Dragon shadow on the land: x, z, radius, strength. */
    uShadow: { value: new THREE.Vector4(0, 0, 1, 0) },
    uRunes: { value: null as THREE.Texture | null },
  };
}
export type Shared = ReturnType<typeof makeShared>;

/** Land is drawn on a lattice this fine; the snap keeps vertices on land points. */
export const LAND_DX = 560 / 180;
export const LAND_DZ = 432 / 150;
/** Water ripple period: sin(z·3) and sin(z·14) both repeat over it. */
export const RIPPLE_PERIOD = Math.PI * 2 * 300;

/** CPU twin of the GLSL river: land x of the Current at land coordinate w. */
export function riverW(w: number) {
  return Math.sin(w * 0.037) * 7 + Math.sin(w * 0.016 + 1.3) * 9 + Math.sin(w * 0.0063 + 0.4) * 5;
}
export function widthAt(z: number) {
  const t = Math.max(0, Math.min(1, (z + 45) / 77));
  return 3.6 + 13 * t * t * (3 - 2 * t);
}

export const common = /* glsl */ `
  uniform float uTime, uWind, uGrowth, uBand, uRealmNow, uLife, uMotion;
  uniform float uCourse, uCourseW, uRiver0, uAge, uNight, uVigil, uMist, uFog, uLight, uMagic, uBar;
  uniform vec2 uSnap, uBounds, uStarts;
  uniform vec3 uSeeds, uRealms, uSun, uSunDir, uHaze, uZenith, uAccent;
  uniform float uSpectrum[64];
  uniform float uFlicker[8];
  uniform vec4 uDecks;
  uniform vec4 uLantern[4];
  uniform vec3 uDeckColor[4];
  uniform vec4 uWay, uWayPrev, uShadow;
  uniform float uRoute[8];
  uniform float uGate[8];
  // Small inputs only (instance seeds, uv).
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  // Integer hash: exact however far the course has run.
  uint ih(uint x) { x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }
  float ihash(vec2 p) {
    uvec2 q = uvec2(ivec2(floor(p)));
    return float(ih(q.x * 1597334677u ^ ih(q.y + 0x9e3779b9u))) * (1. / 4294967296.);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
    return mix(mix(ihash(i), ihash(i+vec2(1,0)), f.x), mix(ihash(i+vec2(0,1)), ihash(i+1.), f.x), f.y);
  }
  // The Current: land x at land coordinate w, and re-centred in the traveller frame.
  float riverW(float w) { return sin(w*.037)*7. + sin(w*.016+1.3)*9. + sin(w*.0063+.4)*5.; }
  float river(float z) { return riverW(z - uCourse) - uRiver0; }
  float widthAt(float z) { return 3.6+13.*smoothstep(-45.,32.,z); }
  // Weights of the land segments A, B, C at land coordinate w (the seed wipe, 20 units wide).
  vec3 segments(float w) {
    float b = 1. - smoothstep(uBounds.x - 10., uBounds.x + 10., w);
    float c = 1. - smoothstep(uBounds.y - 10., uBounds.y + 10., w);
    return vec3(1. - b, b - c, c);
  }
  // Realm variants switch at the wrap: furniture keeps the realm it spawned in.
  float realmFor(float spawn) {
    return spawn >= uStarts.y ? uRealms.z : (spawn >= uStarts.x ? uRealms.y : uRealms.x);
  }
  float relief(vec2 q) { return noise(q)*.65 + noise(q*2.07 + 3.1)*.25 + noise(q*4.1 + 7.7)*.1; }
  float landN(float X, float w) {
    vec3 s = segments(w);
    vec2 q = vec2(X, w) * .025;
    float n = 0.;
    if (s.x > .001) n += s.x * relief(q + uSeeds.x * vec2(1., .61));
    if (s.y > .001) n += s.y * relief(q + uSeeds.y * vec2(1., .61));
    if (s.z > .001) n += s.z * relief(q + uSeeds.z * vec2(1., .61));
    return n;
  }
  // Height at traveller (x, z), d = distance from the river's centre line.
  float groundAt(float x, float z, float d) {
    float n = landN(x + uRiver0, z - uCourse);
    float wd = widthAt(z);
    float banks = smoothstep(wd - 1., wd + 8., d);
    // Low banks near the Current (shards float clear of them), fells further out.
    float hills = smoothstep(22., 110., d) * 17.;
    return -.48 + banks * (.6 + n * 2.5) + n * hills;
  }
  float ground(vec2 p) { return groundAt(p.x, p.y, abs(p.x - river(p.y))); }
  vec3 fogged(vec3 c, vec3 p) {
    float f = 1. - exp(-max(0., length(p - cameraPosition) - 22.) * uFog * (1. + .6 * uMist));
    return mix(c, uHaze, f);
  }
  // Sun (or moon) on a surface, with a little sky fill.
  vec3 lit(vec3 albedo, vec3 n) {
    float d = max(0., dot(n, uSunDir));
    return albedo * ((.58 + .42 * d) * uLight * mix(vec3(1.), uSun, .45) + uZenith * .1);
  }
  // Four lantern pools of the Keepers and the Wayfinder's own.
  vec3 lanterns(vec3 p) {
    vec3 c = vec3(0.);
    for (int i = 0; i < 4; i++) {
      vec2 v = p.xz - uLantern[i].xy;
      c += uDeckColor[i] * uLantern[i].z * exp(-dot(v, v) / (uLantern[i].w * uLantern[i].w));
    }
    vec2 w = p.xz - uWay.xy;
    c += vec3(1., .82, .55) * .5 * exp(-dot(w, w) * .09) * uWayPrev.w;
    return c * uMagic * .3;
  }
  // The Wayfinder's beam: a 24° wedge, 40 units long, toward the aimed gate.
  float wedge(vec2 v, vec2 dir) {
    float a = dot(v, dir);
    float c = abs(v.x * dir.y - v.y * dir.x) / (a * .2126 + .5);
    float across = 1. - smoothstep(.55, 1., c);
    return smoothstep(0., 2.5, a) * (1. - smoothstep(22., 40., a)) * across * (.6 + .4 * (1. - c) * (1. - c));
  }
  // How much of the band accent the beam lays over a surface (25 % at its heart).
  float beam(vec3 p) {
    vec2 v = p.xz - uWay.xy;
    return min(1., wedge(v, uWay.zw) + wedge(v, uWayPrev.xy) * uWayPrev.z) * .25 * uWayPrev.w;
  }
  float shadowAt(vec3 p) {
    vec2 v = (p.xz - uShadow.xy) / uShadow.z;
    return uShadow.w * (1. - smoothstep(.55, 1., length(v * vec2(1., 1.8))));
  }
  // A faint fixed grain, like paper under ink.
  float grain(vec2 fc) { return (hash(floor(fc) * .37) - .5) * .02; }
`;

export function material(s: Shared, vertexShader: string, fragmentShader: string, extra: THREE.ShaderMaterialParameters = {}) {
  return new THREE.ShaderMaterial({
    uniforms: s,
    vertexShader: common + vertexShader,
    fragmentShader: common + fragmentShader,
    ...extra,
  });
}

/** Premultiplied alpha: rgb with a = 0 adds light, a = 1 covers. */
export const PREMULTIPLIED: THREE.ShaderMaterialParameters = {
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
};

/** One seeded random stream at construction; animation never creates geometry. */
export function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** '#rrggbb' → linear-ish 0..1 components written into `out` (no allocation). */
export function hexInto(hex: string, out: Float32Array | number[], at = 0) {
  const n = Number.parseInt(hex.slice(1), 16);
  out[at] = ((n >> 16) & 255) / 255;
  out[at + 1] = ((n >> 8) & 255) / 255;
  out[at + 2] = (n & 255) / 255;
}
