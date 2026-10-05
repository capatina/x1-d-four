import * as THREE from 'three';
import { common, random, type Shared } from './shared';

// The land grows older over a mix: waystones mark phrases, then stone circles
// and broken arches, then bridges over the Current and lit shrine lanterns.
// Three instanced meshes with wrap-around placement (period 240, like the
// other furniture): each wrap re-derives place, variant (by the realm the
// instance spawned in) and whether its age has come yet. Instances 0–3 of the
// stones are the waystones, placed from uniforms so they pass the bow on the
// phrase downbeats.

export const PROP_PERIOD = 240;
export const WAYSTONES = 4;

/** uAges: course at which the mix reached day, dusk and night (structures spawn after it). */
const propCommon = /* glsl */ `
  uniform vec2 uWrap;
  uniform vec4 uAges;
  uniform vec4 uWaystone[4];
  const float P = ${PROP_PERIOD}., ZN = 30.;
  // Wrap bookkeeping shared by all props: traveller z, land coordinate, wrap count, spawn course.
  void wrapAt(float base, out float z, out float k, out float spawn, out float m) {
    float s = base + uWrap.x;
    m = mod(s, P);
    k = uWrap.y + floor(s / P);
    z = ZN - P + m;
    spawn = k * P - base;
  }
  mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
`;

function propMaterial(s: Shared, wrap: { value: THREE.Vector2 }, ages: { value: THREE.Vector4 }, way: { value: Float32Array }, vs: string, fs: string) {
  return new THREE.ShaderMaterial({
    uniforms: { ...s, uWrap: wrap, uAges: ages, uWaystone: way },
    vertexShader: common + propCommon + vs,
    fragmentShader: common + fs,
  });
}

/** A prism of `sides` around y, in bands; flat-shaded by derivatives later. */
function prism(sides: number, rings: [r: number, y: number, jitter: number][], seed: number, cap = true) {
  const r = random(seed);
  const pos: number[] = [];
  const pts = rings.map(([rad, y, j]) => Array.from({ length: sides }, (_, k) => {
    const a = (k / sides) * Math.PI * 2 + (r() - 0.5) * j;
    const rr = rad * (1 + (r() - 0.5) * j);
    return [Math.cos(a) * rr, y, Math.sin(a) * rr];
  }));
  for (let b = 0; b < pts.length - 1; b++)
    for (let k = 0; k < sides; k++) {
      const a0 = pts[b][k],
        a1 = pts[b][(k + 1) % sides],
        b0 = pts[b + 1][k],
        b1 = pts[b + 1][(k + 1) % sides];
      pos.push(...a0, ...b1, ...a1, ...a0, ...b0, ...b1);
    }
  if (cap) {
    const top = pts[pts.length - 1];
    const cy = top[0][1] + 0.06;
    for (let k = 0; k < sides; k++) pos.push(...top[k], 0, cy, 0, ...top[(k + 1) % sides]);
  }
  return pos;
}

function instanced(pos: number[], count: number, seed: number) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const r = random(seed);
  const a = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    a[i * 4] = i;
    a[i * 4 + 1] = r() * PROP_PERIOD;
    a[i * 4 + 2] = r();
    a[i * 4 + 3] = r();
  }
  geo.setAttribute('aProp', new THREE.InstancedBufferAttribute(a, 4));
  geo.instanceCount = count;
  return geo;
}

const flatLit = /* glsl */ `
  vec3 flatN(vec3 p) {
    vec3 n = normalize(cross(dFdx(p), dFdy(p)));
    return dot(n, cameraPosition - p) < 0. ? -n : n;
  }
`;

export function makeProps(s: Shared) {
  const wrap = { value: new THREE.Vector2() };
  const ages = { value: new THREE.Vector4(1e9, 1e9, 1e9, 0) };
  const way = { value: new Float32Array(16) };

  // Stones: waystones (0–3), standing stones, mossy boulders or pale cairns by realm,
  // barrows on the Lowmarch, and (from dusk) circles of six.
  const stoneGeo = instanced(
    prism(6, [[0.42, 0, 0.25], [0.4, 0.45, 0.3], [0.33, 0.85, 0.35], [0.18, 1.06, 0.4]], 7),
    92,
    501,
  );
  const stones = new THREE.Mesh(
    stoneGeo,
    propMaterial(
      s,
      wrap,
      ages,
      way,
      /* glsl */ `
    attribute vec4 aProp;
    varying vec3 vP;
    varying float vKind, vRealm, vLight;
    void main() {
      float id = aProp.x;
      vec3 p = position;
      float z, k, spawn, m;
      wrapAt(aProp.y, z, k, spawn, m);
      float r1 = ihash(vec2(id, k)), r2 = ihash(vec2(id + 311., k)), r3 = ihash(vec2(id + 977., k));
      float realm = realmFor(spawn);
      float x, scale = 1., show = 1., kind = 0.;
      vec3 shape = vec3(1.);
      vLight = 0.;
      if (id < 4.) {
        // Waystones: placed from uniforms (z, size, alpha, big), on alternate banks.
        vec4 w = uWaystone[int(id)];
        z = w.x;
        float side = mod(id, 2.) < .5 ? 1. : -1.;
        x = river(z) + side * (widthAt(z) + 1.6 + w.w * .6);
        scale = w.y * w.z;
        shape = vec3(.55, 1.9 + w.w * 1.1, .5);
        kind = 1.;
        vLight = w.w;
        m = 120.;
      } else if (id < 68.) {
        float side = r1 < .5 ? -1. : 1.;
        float d = 18. + r2 * 70.;
        x = river(z) + side * d;
        if (realm < .5) {
          // Lowmarch: standing stones and the odd barrow.
          bool barrow = r3 > .84;
          shape = barrow ? vec3(4.2, 1.1, 3.2) : vec3(.8, 2.6 + r3 * 1.4, .55);
          kind = barrow ? 4. : 0.;
          show = step(r3, .7) + (barrow ? 1. : 0.);
        } else if (realm < 1.5) {
          // Greenwold: mossy boulders, low.
          shape = vec3(1.4 + r3, .9 + r3 * .5, 1.2 + r3);
          kind = 2.;
          show = step(r3, .55);
        } else {
          // Highreach: pale cairns, stacked.
          shape = vec3(.9, 1.3 + r3, .9);
          kind = 3.;
          show = step(r3, .6);
        }
        // Fewer of everything at dawn; the land fills in by day.
        show *= step(spawn, uAges.x) * step(r2, .55) + step(uAges.x, spawn);
      } else {
        // From dusk: circles of six stones around a shared centre.
        float g = floor((id - 68.) / 6.), j = mod(id - 68., 6.);
        float c1 = ihash(vec2(g + 41., k)), c2 = ihash(vec2(g + 83., k));
        float side = c1 < .5 ? -1. : 1.;
        float a = j / 6. * 6.2832 + c2 * 3.;
        x = river(z) + side * (26. + c2 * 30.) + cos(a) * 4.2;
        z += sin(a) * 4.2;
        shape = vec3(.6, 1.7 + r3 * .8, .5);
        show = step(uAges.y, spawn) * step(c1 * 3.7 - floor(c1 * 3.7), .55);
      }
      float fade = smoothstep(0., 14., m);
      p.xz = rot(r1 * 6.28) * p.xz;
      p *= shape * scale * show * fade;
      // A slight lean, as old stones have.
      p.x += p.y * (r2 - .5) * .12;
      p += vec3(x, groundAt(x, z, abs(x - river(z))) - .15, z);
      vP = p; vKind = kind; vRealm = realm;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
    }
  `,
      flatLit +
        /* glsl */ `
    varying vec3 vP;
    varying float vKind, vRealm, vLight;
    void main() {
      vec3 n = flatN(vP);
      vec3 stone = vRealm < .5 ? vec3(.47, .42, .33) : vRealm < 1.5 ? vec3(.35, .38, .3) : vec3(.62, .63, .6);
      // Barrows are turf: the moor's own colour, a little darker.
      if (vKind > 3.5) stone = vec3(.42, .38, .2);
      if (vKind > 1.5 && vKind < 2.5) stone = mix(stone, vec3(.25, .36, .2), smoothstep(.2, .9, n.y));
      vec3 c = lit(stone * (.85 + .2 * snoise(vP.xz * 3. + vP.y)), n);
      // A waystone's carved band catches the realm's light on the big (32-bar) ones.
      if (vKind > .5 && vKind < 1.5) c += uAccent * vLight * .18 * uMagic * step(.8, fract(vP.y * .9));
      gl_FragColor = vec4(fogged(c + lanterns(vP) * .5, vP), 1.);
    }
  `,
    ),
  );

  // Arches: broken arches on the land from dusk; whole bridges over the Current at night.
  // Unit arch, half-span 1: two piers, a thick semicircular ring, a deck (parts 0, 1, 2).
  const archPos: number[] = [];
  const archPart: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], part: number) => {
    archPos.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let i = 0; i < 6; i++) archPart.push(part);
  };
  const box = (x0: number, x1: number, y0: number, y1: number, z: number, part: number) => {
    const P = (x: number, y: number, zz: number) => [x, y, zz];
    quad(P(x0, y0, z), P(x1, y0, z), P(x1, y1, z), P(x0, y1, z), part);
    quad(P(x1, y0, -z), P(x0, y0, -z), P(x0, y1, -z), P(x1, y1, -z), part);
    quad(P(x0, y0, -z), P(x0, y0, z), P(x0, y1, z), P(x0, y1, -z), part);
    quad(P(x1, y0, z), P(x1, y0, -z), P(x1, y1, -z), P(x1, y1, z), part);
    quad(P(x0, y1, z), P(x1, y1, z), P(x1, y1, -z), P(x0, y1, -z), part);
    quad(P(x0, y0, -z), P(x1, y0, -z), P(x1, y0, z), P(x0, y0, z), part);
  };
  box(-1.1, -0.82, 0, 1, 0.3, 0);
  box(0.82, 1.1, 0, 1, 0.3, 0);
  const R0 = 0.82,
    R1 = 1.08,
    SEGS = 8;
  for (let k = 0; k < SEGS; k++) {
    const a0 = Math.PI * (k / SEGS),
      a1 = Math.PI * ((k + 1) / SEGS);
    const at = (a: number, r: number, z: number) => [-Math.cos(a) * r, 1 + Math.sin(a) * r, z];
    for (const z of [0.3, -0.3]) {
      const f = z > 0;
      quad(at(a0, R0, z), f ? at(a1, R0, z) : at(a0, R1, z), at(a1, R1, z), f ? at(a0, R1, z) : at(a1, R0, z), 1);
    }
    quad(at(a0, R1, 0.3), at(a1, R1, 0.3), at(a1, R1, -0.3), at(a0, R1, -0.3), 1);
    quad(at(a1, R0, 0.3), at(a0, R0, 0.3), at(a0, R0, -0.3), at(a1, R0, -0.3), 1);
  }
  box(-1.12, 1.12, 2.05, 2.2, 0.36, 2);
  const archGeo = instanced(archPos, 36, 733);
  archGeo.setAttribute('aPart', new THREE.Float32BufferAttribute(archPart, 1));
  const arches = new THREE.Mesh(
    archGeo,
    propMaterial(
      s,
      wrap,
      ages,
      way,
      /* glsl */ `
    attribute vec4 aProp;
    attribute float aPart;
    varying vec3 vP;
    varying float vRealm, vBridge;
    void main() {
      float id = aProp.x;
      vec3 p = position;
      float z, k, spawn, m;
      wrapAt(aProp.y, z, k, spawn, m);
      float r1 = ihash(vec2(id, k)), r2 = ihash(vec2(id + 59., k)), r3 = ihash(vec2(id + 143., k));
      float realm = realmFor(spawn);
      bool bridge = id < 10.;
      float x, show, base;
      if (bridge) {
        // A stone bridge sized for the Current out in the land; where the river widens
        // toward the vessel its piers simply stand in the water. Square to its course.
        x = river(z);
        float dir = river(z + 1.) - river(z - 1.);
        p *= vec3(6.4, realm > 1.5 ? 2.6 : 3.1, 2.4);
        p.xz = rot(-atan(dir, 2.)) * p.xz;
        show = step(uAges.z, spawn) * step(r1, .3);
        base = -.4;
      } else {
        float side = r1 < .5 ? -1. : 1.;
        x = river(z) + side * (22. + r2 * 55.);
        // Broken: no deck; on one side the pier stands short and the ring is gone.
        float lost = r3 < .5 ? -1. : 1.;
        if (aPart > 1.5) p *= 0.;
        else if (p.x * lost > .05) {
          if (aPart < .5) p.y *= .45 + r2 * .25;
          else p = vec3(lost * .96, .45 + r2 * .25, p.z);
        }
        p *= vec3(2.3, 2.6, 1.1) * (.85 + r3 * .35);
        p.xz = rot(r2 * 6.28) * p.xz;
        show = step(uAges.y, spawn) * step(r1 * 7.1 - floor(r1 * 7.1), .5);
        base = groundAt(x, z, abs(x - river(z))) - .2;
      }
      p *= show * smoothstep(0., 16., m);
      p += vec3(x, base, z);
      vP = p; vRealm = realm; vBridge = bridge ? 1. : 0.;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
    }
  `,
      flatLit +
        /* glsl */ `
    varying vec3 vP;
    varying float vRealm, vBridge;
    void main() {
      vec3 n = flatN(vP);
      // Stone in the Lowmarch, timber in the Greenwold, pale slender stone in the Highreach.
      vec3 c = vRealm < .5 ? vec3(.44, .4, .32) : vRealm < 1.5 ? vec3(.33, .26, .18) : vec3(.6, .62, .6);
      c = lit(c * (.85 + .2 * snoise(vP.xy * 2.)), n);
      gl_FragColor = vec4(fogged(c + lanterns(vP) * .4, vP), 1.);
    }
  `,
    ),
  );

  // Shrine lanterns along the banks: posts from dusk, lit at night.
  const shrinePos = prism(4, [[0.16, 0, 0.1], [0.14, 1.5, 0.1], [0.32, 1.5, 0], [0.32, 1.95, 0], [0.05, 2.25, 0]], 91);
  const shrines = new THREE.Mesh(
    instanced(shrinePos, 36, 919),
    propMaterial(
      s,
      wrap,
      ages,
      way,
      /* glsl */ `
    attribute vec4 aProp;
    varying vec3 vP;
    varying float vLamp, vY;
    void main() {
      float id = aProp.x;
      vec3 p = position;
      float z, k, spawn, m;
      wrapAt(aProp.y, z, k, spawn, m);
      float r1 = ihash(vec2(id, k)), r2 = ihash(vec2(id + 7., k));
      float side = r1 < .5 ? -1. : 1.;
      float x = river(z) + side * (widthAt(z) + 3. + r2 * 9.);
      float show = step(uAges.y + 40., spawn) * step(r2, .7);
      vY = p.y;
      p.xz = rot(r1 * 6.28) * p.xz;
      p *= show * smoothstep(0., 12., m);
      p += vec3(x, groundAt(x, z, abs(x - river(z))) - .1, z);
      vP = p; vLamp = step(uAges.z, spawn);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
    }
  `,
      flatLit +
        /* glsl */ `
    varying vec3 vP;
    varying float vLamp, vY;
    void main() {
      vec3 n = flatN(vP);
      vec3 c = lit(vec3(.25, .22, .18), n);
      // The lamp box glows warm at night: light on surfaces, no flare.
      float box = step(1.5, vY) * step(vY, 1.95);
      c = mix(c, vec3(1., .78, .45) * (.8 + .5 * uMagic), box * vLamp * uNight);
      gl_FragColor = vec4(fogged(c, vP), 1.);
    }
  `,
    ),
  );
  for (const m of [stones, arches, shrines]) m.frustumCulled = false;
  return { meshes: [stones, arches, shrines], wrap, ages: ages.value, waystones: way.value };
}

/**
 * The dragon: a shape in the clouds you are not sure you saw. A 24-segment
 * ribbon body following its flight path in the vertex shader, two wing quads
 * with an SDF membrane beating once per bar, horns in the SDF. Unlit, fog
 * colour × 0.45, fading into cloud cover. uDragon: mode (0 none, 1 far
 * circling, 2 flyover, 3 perched), time in the mode (s), duration, seed.
 */
export function makeDragon(s: Shared) {
  const SEG = 24;
  const pos: number[] = [];
  const attr: number[] = [];
  const v = (t: number, side: number, part: number) => {
    pos.push(0, 0, 0);
    attr.push(t, side, part, 0);
  };
  for (let i = 0; i < SEG; i++) {
    const t0 = i / SEG,
      t1 = (i + 1) / SEG;
    v(t0, -1, 0), v(t0, 1, 0), v(t1, 1, 0);
    v(t0, -1, 0), v(t1, 1, 0), v(t1, -1, 0);
  }
  for (const wing of [1, 2]) {
    // A quad from the shoulder: (along, out) corners in 0..1.
    v(0, 0, wing), v(1, 0, wing), v(1, 1, wing);
    v(0, 0, wing), v(1, 1, wing), v(0, 1, wing);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aDragon', new THREE.Float32BufferAttribute(attr, 4));
  const dragon = { value: new THREE.Vector4() };
  const mesh = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({
      uniforms: { ...s, uDragon: dragon },
      vertexShader:
        common +
        /* glsl */ `
    attribute vec4 aDragon;
    uniform vec4 uDragon;
    varying vec2 vWing;
    varying float vPart, vT, vSide;
    varying vec3 vP;
    // Where the head is at time t (s) in the current mode, in the traveller frame.
    vec3 path(float t) {
      float mode = uDragon.x, D = uDragon.z, seed = uDragon.w;
      if (mode < 1.5) {
        // Far form: a slow circle above the horizon, a smudge in the haze.
        float a = t * .09 + seed * 6.28;
        return vec3(sin(a) * 140., 62. + sin(t * .3) * 6., -300. + cos(a) * 40.);
      }
      if (mode > 2.5) {
        // Perched on a far crag, curled (reduced motion: no flight at all).
        return vec3(-64., 23., -190.) + vec3(sin(t * 2.4) * 3.5, cos(t * 1.7) * 1.2 - (1. - t) * 1.5, cos(t * 2.4) * 2.5);
      }
      // Flyover: down out of the cloud behind and above, across the sky, up and away.
      float u = clamp(t / D, 0., 1.);
      float side = seed < .5 ? 1. : -1.;
      // From above and behind (out of sight: its shadow crosses the land first) down to
      // the open band of sky over the horizon, then away into the haze.
      vec3 a = vec3(90. * side, 64., 20.), b = vec3(25. * side, -4., -170.), c = vec3(-240. * side, 24., -250.);
      return mix(mix(a, b, u), mix(b, c, u), u);
    }
    void main() {
      float t = uDragon.y;
      float s = aDragon.x, side = aDragon.y, part = aDragon.z;
      float mode = uDragon.x;
      float scale = mode < 1.5 ? 3. : (mode > 2.5 ? .8 : 2.);
      float lag = mode > 2.5 ? 1. : 15. * scale / (mode < 1.5 ? 12. : 18.);
      vec3 c = path(t - s * lag);
      vec3 c2 = path(t - min(1., s + .04) * lag);
      c.y += sin(s * 7. - t * 2.6 * uMotion) * .9 * scale * s * step(mode, 2.5);
      vec4 v0 = modelViewMatrix * vec4(c, 1.);
      vec4 v1 = modelViewMatrix * vec4(c2, 1.);
      vec2 dir = normalize(v0.xy - v1.xy + vec2(1e-4, 0.));
      vec2 perp = vec2(-dir.y, dir.x);
      vec4 mv = v0;
      vec3 world = c;
      if (part < .5) {
        // Thick at the chest, a long tapering tail, a narrow snout with a horn bump.
        float w = (.5 + .9 * smoothstep(0., .14, s) * (1. - smoothstep(.16, 1., s))) * scale * (1. - s * .85);
        w *= 1. + .7 * (smoothstep(.03, .05, s) - smoothstep(.06, .09, s));
        mv.xy += perp * side * w;
      } else {
        // Wings from the shoulder, beating once per bar (folded when perched).
        vec3 sh = path(t - .22 * lag);
        world = sh;
        mv = modelViewMatrix * vec4(sh, 1.);
        float wing = part < 1.5 ? 1. : -1.;
        float beat = mode > 2.5 ? -.7 : sin(uBar * 6.2832) * uMotion;
        vec2 out_ = normalize(perp * wing + vec2(0., .2 + beat * .7));
        float along = s, span = side;
        float spanLen = (mode > 2.5 ? 3.5 : 10.) * scale;
        mv.xy += out_ * span * spanLen;
        mv.xy += -dir * ((along - .25) * 5.5 * (1. - span * .45) + span * 3.2) * scale;
        vWing = vec2(along, span);
      }
      vPart = part; vT = s; vSide = side;
      vP = world;
      gl_Position = projectionMatrix * mv;
    }
  `,
      fragmentShader:
        common +
        /* glsl */ `
    uniform vec4 uDragon;
    varying vec2 vWing;
    varying float vPart, vT, vSide;
    varying vec3 vP;
    void main() {
      if (vPart > .5) {
        // Membrane: finger bones end in points; the skin between them sags.
        float finger = 1. - abs(fract(vWing.y * 3. + .15) - .5) * 2.;
        float edge = .32 + .62 * pow(finger, 2.2) * (1. - vWing.y * .35);
        if (vWing.x > edge || vWing.y < .03) discard;
      } else if (vT < .03 && abs(vSide) > .45 + vT * 18.) discard;
      vec3 d = normalize(vP - cameraPosition);
      // Mostly behind cloud: the same cover as the sky in this direction.
      vec2 cp = d.xz / max(.12, d.y) * 2.2 + vec2(uTime * .002 * uMotion, -uCourse * .0006);
      float clouds = snoise(cp) * .65 + snoise(cp * 2.8) * .35;
      float cover = smoothstep(.5, .74, clouds) * smoothstep(.03, .25, d.y) * .85;
      // A silhouette in the fog's own colour × 0.45, unlit.
      vec3 c = uHaze * .45;
      float far = 1. - exp(-max(0., length(vP - cameraPosition) - 60.) * uFog * .5);
      c = mix(c, uHaze, far * .6);
      vec3 cloud = mix(mix(vec3(.93, .91, .82), uSun, .3) * (.55 + .45 * uLight), uHaze * 1.1, uNight * .6);
      gl_FragColor = vec4(mix(c, cloud, cover), 1.);
    }
  `,
      side: THREE.DoubleSide,
    }),
  );
  mesh.frustumCulled = false;
  mesh.visible = false;
  return { mesh, dragon: dragon.value };
}
