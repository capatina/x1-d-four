import * as THREE from 'three';
import { KEEPER_H, KEEPER_HANDS, KEEPER_W } from './atlas';
import { common, material, PREMULTIPLIED, type Shared } from './shared';

// The similarity tree, read as a quest: candidate tracks are spires on
// floating shards, each with a gate at its foot; ley routes run from the
// vessel to every gate. All of it lives in the traveller frame (it holds
// station while the land streams under it), so aiming never moves anything.

/** Child routes (6), the taken route, and up to 24 grandchild routes. */
export const ROUTE_SEGMENTS = 32;
export const GRAND_SEGMENTS = 12;
export const MAX_CHILDREN = 6;
export const MAX_GRANDS = 24;
export const TAKEN_SLOT = 7;

/** Spire unit geometry: base at y = 0, cap apex at 7.3 (a needle's at 8.6, a ruin breaks off at 4.3). */
export const SPIRE_TOP = 7.3;
export const SPIRE_TOPS = [SPIRE_TOP, 8.6, 4.3] as const;

function spireGeometry() {
  const pos: number[] = [];
  const part: number[] = [];
  const tier: number[] = [];
  const N = 7;
  const v = (r: number, a: number, y: number, p: number, t: number) => {
    pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
    part.push(p);
    tier.push(t);
  };
  // A band of quads between two rings (r0 at y0, r1 at y1).
  const band = (r0: number, y0: number, t0: number, r1: number, y1: number, t1: number, p: number, n = N, phase = 0) => {
    for (let k = 0; k < n; k++) {
      const a0 = phase + (k / n) * Math.PI * 2,
        a1 = phase + ((k + 1) / n) * Math.PI * 2;
      v(r0, a0, y0, p, t0), v(r1, a1, y1, p, t1), v(r0, a1, y0, p, t0);
      v(r0, a0, y0, p, t0), v(r1, a0, y1, p, t1), v(r1, a1, y1, p, t1);
    }
  };
  // Three worn tiers of a broch: tapered heptagonal prisms with ledges.
  band(1.0, 0, 0, 0.86, 2.5, 0, 0);
  band(0.86, 2.5, 0, 0.8, 2.5, 1, 0);
  band(0.8, 2.5, 1, 0.68, 4.3, 1, 0);
  band(0.68, 4.3, 1, 0.62, 4.3, 2, 0);
  band(0.62, 4.3, 2, 0.6, 4.55, 2, 0);
  // The one lit window band, at two thirds of the height.
  band(0.6, 4.55, 2, 0.585, 4.9, 2, 1);
  band(0.585, 4.9, 2, 0.54, 5.9, 2, 0);
  // Overhanging slate cap.
  band(0.54, 5.9, 2, 0.68, 5.9, 3, 2);
  for (let k = 0; k < N; k++) {
    const a0 = (k / N) * Math.PI * 2,
      a1 = ((k + 1) / N) * Math.PI * 2;
    v(0.68, a0, 5.9, 2, 3), v(0, 0, SPIRE_TOP, 2, 3), v(0.68, a1, 5.9, 2, 3);
  }
  // The shard: an inverted, irregular cone of rock (48 triangles).
  const S = 8;
  for (let k = 0; k < S; k++) {
    const a0 = (k / S) * Math.PI * 2,
      a1 = ((k + 1) / S) * Math.PI * 2;
    v(1.75, a0, 0.02, 3, -1), v(0, 0, 0.12, 3, -1), v(1.75, a1, 0.02, 3, -1);
  }
  band(1.75, 0.02, -1, 1.3, -0.9, -1, 3, S);
  band(1.3, -0.9, -1, 0.62, -1.9, -1, 3, S, 0.3);
  for (let k = 0; k < S; k++) {
    const a0 = 0.3 + (k / S) * Math.PI * 2,
      a1 = 0.3 + ((k + 1) / S) * Math.PI * 2;
    v(0.62, a0, -1.9, 3, -1), v(0.12, 0, -2.85, 3, -1), v(0.62, a1, -1.9, 3, -1);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  geo.setAttribute('aTier', new THREE.Float32BufferAttribute(tier, 1));
  return geo;
}

/**
 * Spires and their shards in one draw: per instance x, y (shard top), z,
 * scale; seed, sim, slot (0..5 children, 8+ grandchildren of slot − 8) and
 * height. The shard's tip dissolves into haze (dithered, so no sorting).
 */
export function makeSpires(s: Shared, capacity = MAX_CHILDREN + MAX_GRANDS) {
  const geo = spireGeometry();
  const spire = new Float32Array(capacity * 4);
  const info = new Float32Array(capacity * 4);
  const aSpire = new THREE.InstancedBufferAttribute(spire, 4).setUsage(THREE.DynamicDrawUsage);
  const aInfo = new THREE.InstancedBufferAttribute(info, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aSpire', aSpire);
  geo.setAttribute('aInfo', aInfo);
  geo.instanceCount = 0;
  const mesh = new THREE.Mesh(
    geo,
    material(
      s,
      /* glsl */ `
    attribute float aPart, aTier;
    attribute vec4 aSpire, aInfo;
    varying vec3 vP;
    varying float vPart, vLocalY, vSim, vSlot, vSeed, vKind, vTop;
    void main() {
      vec3 p = position;
      float seed = aInfo.x;
      // aInfo.z = slot + 32 × kind (0 broch, 1 needle, 2 ruin); aInfo.w = height.
      float kind = floor(aInfo.z / 32.);
      float slot = mod(aInfo.z, 32.);
      float top = 5.9;
      if (aPart < 2.5 || aTier > 2.5) {
        float ang = floor(atan(p.z, p.x + 1e-4) * 1.114 + 3.5);
        if (kind > .5 && kind < 1.5) {
          // A needle: one slender taper, no ledges, apex at 8.6.
          float r = .55 * (1. - .42 * clamp(p.y / 5.9, 0., 1.));
          if (aPart > 1.5) r = p.y > 7. ? 0. : .3;
          p.y *= 8.6 / 7.3;
          p.xz = length(p.xz) > 1e-3 ? normalize(p.xz) * r : p.xz;
          top = 6.95;
        } else if (kind > 1.5) {
          // A ruin: the upper tier and cap are gone; the break is ragged; no window.
          float rag = hash(vec2(seed, ang + 50.)) * .4;
          if (aTier > 1.5) p = vec3(length(p.xz) > 1e-3 ? normalize(p.xz) * .62 : p.xz, 4.3 - rag).xzy;
          else if (aTier > .5 && p.y > 4.29) p.y -= rag;
          top = 4.3;
        }
        // Each tier sits a little off the one below and the whole tower leans.
        vec2 lean = vec2(hash(vec2(seed, 1.)) - .5, hash(vec2(seed, 2.)) - .5) * .1;
        float t = min(aTier, 2.);
        vec2 off = vec2(hash(vec2(seed, t + 3.)) - .5, hash(vec2(seed, t + 7.)) - .5) * .16 * t * step(kind, .5);
        p.xz *= .9 + hash(vec2(seed, t + 11.)) * .2;
        p.y *= aInfo.w;
        p.xz += off + lean * p.y;
      } else {
        // Shards are irregular: each direction its own reach.
        float a = floor(atan(p.z, p.x + 1e-4) * 1.273 + 4.5);
        p.xz *= .78 + .44 * hash(vec2(seed, a + 20.));
        p.y *= .85 + .3 * hash(vec2(seed, 31.));
      }
      vLocalY = p.y;
      vTop = top * aInfo.w;
      p *= aSpire.w;
      p += aSpire.xyz;
      p.y += sin(uTime * .35 + seed * 9.) * .1 * uMotion * aSpire.w;
      vP = p; vPart = aPart; vSim = aInfo.y; vSlot = slot; vSeed = seed; vKind = kind;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
    }
  `,
      /* glsl */ `
    varying vec3 vP;
    varying float vPart, vLocalY, vSim, vSlot, vSeed, vKind, vTop;
    void main() {
      vec3 n = normalize(cross(dFdx(vP), dFdy(vP)));
      if (dot(n, cameraPosition - vP) < 0.) n = -n;
      vec3 c;
      int slot = int(vSlot + .5);
      bool grand = slot >= 8;
      if (vPart < 1.5) {
        float worn = snoise(vec2(vLocalY * 3., vSeed * 40. + atan(n.z, n.x) * 2.));
        c = lit(vec3(.36, .345, .31) * (.78 + .32 * worn), n);
        // One lit window band, between half and three quarters of the tower, its width
        // and height the spire's own; its glow is the node's similarity, flickering ±15 %.
        float lo = vTop * mix(.5, .75, hash(vec2(vSeed, 41.)));
        float wide = mix(.25, .5, hash(vec2(vSeed, 43.)));
        float band = step(lo, vLocalY) * step(vLocalY, lo + wide) * step(vKind, 1.5);
        if (band > 0.) {
          int bin = int(mod(vSeed * 64., 8.));
          float aimed = !grand ? clamp(uGate[slot], 0., 1.) : 0.;
          float glow = (.3 + .7 * vSim * vSim) * (.92 + .3 * uFlicker[bin]) * mix(.55, 1., aimed);
          float lamp = step(.5, fract(atan(n.z, n.x) * 1.114 + .25));
          vec3 w = vec3(1., .78, .47) * glow * (.55 + .45 * lamp) * (.8 + .5 * uMagic) + uAccent * aimed * .3;
          c = mix(w, lit(vec3(.25, .23, .2), n), .25 * (1. - lamp));
        }
      } else if (vPart < 2.5) {
        c = lit(vec3(.2, .22, .22), n);
      } else {
        c = lit(vec3(.34, .31, .26) * (.75 + .35 * snoise(vP.xz * 2.1 + vLocalY)), n);
        // The underside dissolves into haze.
        float a = smoothstep(-2.75, -.7, vLocalY);
        c = mix(uHaze, c, a);
        if (a < hash(gl_FragCoord.xy * .71)) discard;
      }
      // Three value planes: near spires in light fog, far ones (and the grandchildren) deep in it.
      float k = mix(.005, .008, smoothstep(-80., -120., vP.z)) * (uFog / .005) * (grand ? 1.6 : 1.) * (1. + .6 * uMist);
      float f = 1. - exp(-max(0., length(vP - cameraPosition) - 22.) * k);
      gl_FragColor = vec4(mix(c, uHaze, f), 1.);
    }
  `,
    ),
  );
  mesh.frustumCulled = false;
  return { mesh, spire, info, aSpire, aInfo };
}

/**
 * Ley routes: one dynamic buffer rebuilt only on layout (fixed slots, fixed
 * camera). The aimed route's light comes from `uRoute[slot]`, so aiming
 * writes a uniform, never geometry. Realm variants in the same shader:
 * causeway stones (Lowmarch), planks (Greenwold), bridge piers (Highreach).
 */
export function makeRoutes(s: Shared) {
  const segments = (MAX_CHILDREN + 1) * ROUTE_SEGMENTS + MAX_GRANDS * GRAND_SEGMENTS;
  const positions = new Float32Array(segments * 6 * 3);
  const routes = new Float32Array(segments * 6 * 4);
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const aRoute = new THREE.BufferAttribute(routes, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('aRoute', aRoute);
  geo.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(
    geo,
    material(
      s,
      /* glsl */ `
    attribute vec4 aRoute;
    varying vec3 vP;
    varying vec4 vR;
    varying float vWet;
    void main() {
      vec3 p = position;
      float g = ground(p.xz);
      vWet = 1. - smoothstep(-.2, .02, g);
      p.y = max(g, -.05) + .08;
      vP = p; vR = aRoute;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
    }
  `,
      /* glsl */ `
    varying vec3 vP;
    varying vec4 vR;
    varying float vWet;
    void main() {
      // vR: slot (0..5 child, 7 taken, 8+ grandchild of slot − 8), u along 0..1, side −1..1, distance along.
      int slot = int(vR.x + .5);
      bool grand = slot >= 8;
      float light = grand ? uRoute[slot - 8] * .3 : uRoute[slot];
      float side = abs(vR.z);
      // 0.22 units wide (a little less for the far spires), soft over the outer quarter.
      float half_ = grand ? .2 : .22;
      float core = 1. - smoothstep(half_ * .75, half_, side);
      float dist = vR.w;
      float realm = uRealmNow;
      vec3 stone;
      float pat;
      if (realm < .5) {
        // Lowmarch: causeway stones, worn into the turf.
        float cell = fract(dist * .85 + floor(vR.z * 1.5) * .5);
        pat = .86 + .14 * smoothstep(0., .07, cell) * smoothstep(1., .93, cell);
        stone = vec3(.6, .53, .38) * (.88 + .14 * hash(vec2(floor(dist * .85), floor(vR.z * 1.5))));
      } else if (realm < 1.5) {
        // Greenwold: boardwalk planks and stairs.
        float cell = fract(dist * 2.3);
        pat = .8 + .2 * smoothstep(0., .14, cell);
        stone = vec3(.5, .41, .29) * (.88 + .14 * hash(vec2(floor(dist * 2.3), 3.)));
      } else {
        // Highreach: pale slabs; dark piers where they cross water.
        float cell = fract(dist * .5);
        pat = 1. - vWet * step(.82, cell) * step(.6, side / half_) * .55;
        stone = vec3(.7, .72, .68) * (.9 + .1 * hash(vec2(floor(dist * .5), 7.)));
      }
      vec3 base = lit(stone * pat, vec3(0., 1., 0.));
      // Ley light, not a painted road: the accent let down into the haze, flowing toward the
      // gate in dashes of 40 % contrast. A drop sends a wave of light down the aimed route.
      float flow = pow(fract(vR.y * 6. - uFlow), 3.) * (1. - uVigil);
      float wave = grand ? 0. : exp(-pow((vR.y - uLeyWave / .6) * 7., 2.)) * step(uLeyWave, .7) * min(light, 1.) * 2.2;
      float lum = min(light, 1.) * (.8 + .4 * flow) * uMagic * (1. - .6 * uMist) * (1. - .45 * uVigil) + wave;
      vec3 ley = mix(uAccent, uHaze, .3) * lum;
      float alpha = core * mix(grand ? .3 : .34, .7, min(light, 1.)) * (1. - .5 * uMist * (1. - light));
      if (slot == 7) alpha = core * .7 * min(light, 1.);
      vec3 coreCol = fogged(mix(base, ley, min(1., light * .85 + wave)), vP);
      float halo = exp(-side * side * 9.) * min(light, 1.) * .1 * uMagic * (1. - core);
      vec3 col = coreCol * alpha + uAccent * halo * (1. - smoothstep(60., 220., length(vP - cameraPosition)));
      gl_FragColor = vec4(col, alpha);
    }
  `,
      { ...PREMULTIPLIED, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide },
    ),
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return { mesh, positions, routes, aPos, aRoute };
}

/**
 * Billboards in one draw: six gates (stone rune rings at the spires' feet),
 * the Wayfinder lantern and the passage gate that sweeps over the camera on a
 * commit. Premultiplied alpha: stone covers, light adds.
 */
export function makeBillboards(s: Shared) {
  const COUNT = MAX_CHILDREN + 2;
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(2, 2);
  geo.setIndex(quad.index);
  geo.setAttribute('position', quad.getAttribute('position'));
  geo.setAttribute('uv', quad.getAttribute('uv'));
  const bill = new Float32Array(COUNT * 4);
  const info = new Float32Array(COUNT * 4);
  for (let i = 0; i < COUNT; i++) {
    info[i * 4] = i < MAX_CHILDREN ? 0 : i === MAX_CHILDREN ? 1 : 2;
    info[i * 4 + 1] = i < MAX_CHILDREN ? i : 8;
    info[i * 4 + 2] = i * 0.137;
  }
  const aBill = new THREE.InstancedBufferAttribute(bill, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aBill', aBill);
  geo.setAttribute('aBillInfo', new THREE.InstancedBufferAttribute(info, 4));
  geo.instanceCount = COUNT;
  const mesh = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({
      uniforms: { ...s },
      vertexShader:
        common +
        /* glsl */ `
    attribute vec4 aBill, aBillInfo;
    varying vec2 vUv;
    varying vec3 vC;
    varying float vKind, vSlot, vSeed;
    void main() {
      vec3 c = aBill.xyz;
      float rad = aBill.w;
      if (aBillInfo.x > 1.5) { c = uPassage.xyz; rad = uPassage.w; }
      else if (aBillInfo.x > .5) { c = vec3(uWay.x, WAY_Y + sin(uTime * 1.3) * .1 * uMotion, uWay.y); rad = 3.45; }
      vC = c;
      // A gate is drawn 60 % of the way along its sightline, scaled to look the same, so
      // the near hills on its sightline never bite into the ring (the aim signal).
      if (aBillInfo.x < .5 && rad > 0.) { c = mix(c, cameraPosition, .6); rad *= .4; }
      vec4 mv = modelViewMatrix * vec4(c, 1.);
      mv.xy += position.xy * rad;
      gl_Position = rad > 0. ? projectionMatrix * mv : vec4(2., 2., 2., 1.);
      vUv = uv; vKind = aBillInfo.x; vSlot = aBillInfo.y; vSeed = aBillInfo.z;
    }
  `,
      fragmentShader:
        common +
        /* glsl */ `
    varying vec2 vUv;
    varying vec3 vC;
    varying float vKind, vSlot, vSeed;
    // Unaimed, a gate is a hairline in the haze: a 270° arc open at the bottom where the
    // route enters. Aimed, the arc closes and its band of runes ignites.
    vec4 gate(vec2 uv, float ign, float turn, float seed) {
      float r = length(uv);
      float on = clamp(ign, 0., 1.);
      float fw = max(fwidth(r), 1e-4);
      const float R = .9;
      float line = clamp(mix(1.5, 2.5, on) * .5 + .5 - abs(r - R) / fw, 0., 1.);
      float gap = .7854 * (1. - on);
      line *= smoothstep(gap, gap + 2.5 * fw / R, abs(atan(uv.x, -uv.y)));
      float a = fract(atan(uv.y, uv.x) / 6.2832 + .5 + turn);
      float cell = floor(a * 14.);
      float band = smoothstep(.64, .66, r) * (1. - smoothstep(.84, .86, r));
      float runeA = rune(mod(cell * 5. + floor(seed * 16.), 16.), vec2(fract(a * 14.), clamp((.85 - r) / .2, 0., 1.))) * band;
      // In vigil the hairlines warm to embers and even the aimed ring burns low.
      vec3 emberCol = mix(uAccent, vec3(1., .55, .3), uVigil * .7);
      vec3 hair = mix(uHaze, emberCol, uVigil * .35);
      vec3 fire = mix(uAccent * (1.1 + .9 * max(0., ign - 1.) * 4.), emberCol * .6, uVigil * .55) * uMagic;
      float rest = .18 * (1. - on);
      float halo = exp(-pow((r - R) * 6., 2.)) * on * .22 * uMagic;
      float inner = (1. - smoothstep(0., .66, r)) * on * .1 * uMagic;
      vec3 c = hair * line * rest + fire * (line + runeA) * on + uAccent * (halo + inner);
      return vec4(c, line * mix(.18, .8, on) + runeA * on * .6);
    }
    void main() {
      vec2 uv = vUv * 2. - 1.;
      vec4 o;
      float far = 1. - exp(-max(0., length(vC - cameraPosition) - 22.) * uFog * (1. + .6 * uMist));
      if (vKind < .5) {
        int slot = int(vSlot + .5);
        float ign = uGate[slot];
        o = gate(uv, ign, uBar * step(.5, ign) * uMotion, vSeed);
        o.rgb = mix(o.rgb, uHaze * o.a, far);
      } else if (vKind < 1.5) {
        // The Wayfinder: an iron lantern, its glass warm, in a halo three times its size.
        // The lantern fills the middle third of the quad (uv × 1.5); edges are antialiased.
        float r = length(uv);
        vec2 l = uv * 1.5;
        float fw = fwidth(l.x) * .75;
        vec2 b = abs(l - vec2(0., -.08));
        float body = smoothstep(.26 + fw, .26 - fw, b.x) * smoothstep(.34 + fw, .34 - fw, b.y);
        float roof = smoothstep(fw, -fw, abs(l.x) - (.3 - (l.y - .26) * .9)) * smoothstep(.26 - fw, .26 + fw, l.y) * smoothstep(.5 + fw, .5 - fw, l.y);
        float ringH = smoothstep(.03 + fw, .03 - fw, abs(length(l - vec2(0., .6)) - .1));
        float glass = smoothstep(.19 + fw, .19 - fw, b.x) * smoothstep(.27 + fw, .27 - fw, b.y) * smoothstep(.025 - fw, .025 + fw, abs(l.x));
        float frame = max(max(body, roof), ringH) * (1. - glass);
        vec3 flame = vec3(1., .8, .5) * (1.1 + .15 * sin(uTime * 7.3) * uMotion) * uWayPrev.w;
        // Iron warmed by its own glass.
        vec3 iron = vec3(.09, .085, .08) + vec3(.16, .11, .06) * (1. - smoothstep(.0, .3, abs(b.x - .22))) * uWayPrev.w;
        vec3 c = iron * frame + flame * glass;
        float halo = exp(-pow(max(r - .2, 0.) / .3, 2.)) * .2 * uWayPrev.w;
        float cover = max(frame, glass);
        o = vec4(c + vec3(1., .78, .5) * halo * (1. - cover) * uMagic, frame);
        o.rgb = mix(o.rgb, uHaze * o.a, far * .7);
      } else {
        // The passage gate: a stone arch sweeping over the camera, lit from within. No
        // glyphs at this size; only the ring's inner edge carries the realm's light.
        float r = length(uv);
        float ring = smoothstep(.7, .73, r) * (1. - smoothstep(.9, .93, r));
        float arch = ring * smoothstep(-.35, -.1, uv.y) + step(abs(abs(uv.x) - .8), .1) * step(uv.y, -.1) * step(.6, r);
        vec3 rock = lit(vec3(.3, .29, .27), normalize(vec3(uv * .7, .7))) * (.8 + .2 * snoise(uv * 18.));
        float edge = exp(-pow((r - .71) * 26., 2.)) * smoothstep(-.4, 0., uv.y);
        vec3 hot = mix(uAccent, vec3(1.), .45);
        o = vec4(rock * arch * .85 + hot * edge * .9 + uAccent * exp(-pow((r - .8) * 4., 2.)) * .12, arch * .85) * uPassageA;
      }
      gl_FragColor = o;
    }
  `,
      ...PREMULTIPLIED,
    }),
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return { mesh, bill, aBill };
}

/**
 * The four Keepers (decks 1–4) at the bow, above their deck cards: hooded
 * cloaks from a canvas atlas, drawn in screen space in one call. Pole, staff,
 * lantern (flame = deck colour) and its swing are procedural, so a beat costs
 * one uniform write. uKeeper: x px, feet y px, height px, focused;
 * uKeeperState: brightness, swing (rad), master, lit.
 */
export function makeKeepers(s: Shared, atlas: THREE.Texture) {
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(2, 2);
  geo.setIndex(quad.index);
  geo.setAttribute('position', quad.getAttribute('position'));
  geo.setAttribute('uv', quad.getAttribute('uv'));
  geo.setAttribute('aDeck', new THREE.InstancedBufferAttribute(new Float32Array([0, 1, 2, 3]), 1));
  geo.instanceCount = 4;
  const keeper = { value: new Float32Array(16) };
  const state = { value: new Float32Array(16) };
  const view = { value: new THREE.Vector2(1, 1) };
  const hands = KEEPER_HANDS.map(([x, y]) => `vec2(${x}.,${y}.)`).join(',');
  const mesh = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({
      uniforms: { ...s, uKeeperAtlas: { value: atlas }, uKeeper: keeper, uKeeperState: state, uView: view },
      vertexShader:
        common +
        /* glsl */ `
    attribute float aDeck;
    uniform vec4 uKeeper[4];
    varying vec2 vCell;
    varying float vDeck;
    void main() {
      int i = int(aDeck + .5);
      vec4 k = uKeeper[i];
      float scale = k.z / ${KEEPER_H}. * (1. + k.w * .07);
      // The quad is wider and taller than the figure: room for the pole, lantern and staff.
      vec2 cell = vec2((position.x * .5 + .5) * 1.6 - .3, (1. - (position.y * .5 + .5)) * 1.18 - .18) * vec2(${KEEPER_W}., ${KEEPER_H}.);
      vec2 px = vec2(k.x + (cell.x - ${KEEPER_W / 2}.) * scale, k.y + k.w * 5. - (${KEEPER_H}. - cell.y) * scale);
      gl_Position = vec4(px.x / uView.x * 2. - 1., 1. - px.y / uView.y * 2., 0., 1.);
      vCell = cell; vDeck = aDeck;
    }
  `,
      fragmentShader:
        common +
        /* glsl */ `
    uniform sampler2D uKeeperAtlas;
    uniform vec4 uKeeper[4];
    uniform vec4 uKeeperState[4];
    varying vec2 vCell;
    varying float vDeck;
    const vec2 HANDS[4] = vec2[4](${hands});
    float seg(vec2 p, vec2 a, vec2 b) {
      vec2 pa = p - a, ba = b - a;
      return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0., 1.));
    }
    void main() {
      int i = int(vDeck + .5);
      vec4 st = uKeeperState[i];
      float bright = st.x, swing = st.y, master = st.z;
      vec3 deck = uDeckColor[i];
      vec2 p = vCell;
      vec2 hand = HANDS[i];
      float side = hand.x > ${KEEPER_W / 2}. ? 1. : -1.;
      // Screen px per cell px, so strokes keep their pixel widths at any size.
      float px = ${KEEPER_H}. / uKeeper[i].z;
      // Sampled outside any branch (a branch would break mip selection at the cell's edge).
      vec2 cp = clamp(p, vec2(1.), vec2(${KEEPER_W - 1}., ${KEEPER_H - 1}.));
      vec4 fig = texture2D(uKeeperAtlas, vec2((cp.x + float(i) * ${KEEPER_W}.) / ${KEEPER_W * 4}., cp.y / ${KEEPER_H}.));
      fig *= step(0., p.x) * step(p.x, ${KEEPER_W}.) * step(0., p.y) * step(p.y, ${KEEPER_H}.);
      // A short pole from the hand, or (the master) a tall staff with a crook and a gem.
      vec2 tip = hand + vec2(side * 9., -14.);
      float pole = seg(p, hand + vec2(-side * 2., 4.), tip);
      vec2 crook = vec2(hand.x + side * 2., 8.);
      float staff = seg(p, vec2(hand.x + side * 1., ${KEEPER_H}. - 4.), crook);
      vec2 cc = crook + vec2(side * 4., 0.);
      float hook = abs(length(p - cc) - 4.) + step(cc.y, p.y) * 99.;
      staff = min(staff, hook);
      float wood = 1. - smoothstep(1.25 * px, 1.25 * px + px, mix(pole, min(pole, staff), master));
      // The lantern hangs from the tip at shoulder height and swings.
      vec2 q = p - tip;
      float cs = cos(swing), sn = sin(swing);
      q = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y);
      vec2 c = q - vec2(0., 13.);
      float chain = (1. - smoothstep(.5, 1.2, abs(q.x))) * step(0., q.y) * step(q.y, 7.);
      vec2 b = abs(c);
      float body = step(b.x, 5.5) * step(b.y, 7.);
      float cap = step(abs(c.x), 5.5 - (c.y + 7.) * -.8) * step(c.y, -7.) * step(-10.5, c.y);
      float glass = step(b.x, 3.6) * step(b.y, 5.2);
      float frame = max(max(body, cap), chain) * (1. - glass);
      vec3 flame = mix(deck, vec3(1., .93, .8), .35) * (.35 + 1.1 * bright);
      // Light: the lantern's halo, a pool at the feet, the gem.
      vec2 lc = tip + vec2(-sn, cs) * 13.;
      float halo = exp(-dot(p - lc, p - lc) / 700.) * bright;
      vec2 f = (p - vec2(64., ${KEEPER_H}. - 5.)) / vec2(34., 6.);
      float pool = exp(-dot(f, f) * 1.6) * bright * (.25 + uKeeper[i].w * .3);
      // A 6 px gem in the crook, with a streak of reflected light.
      vec2 gp = p - (cc + vec2(0., 1.));
      float gr = 3. * px;
      float gem = step(abs(gp.x) + abs(gp.y) * .75, gr) * master;
      float streak = gem * step(abs(gp.x + gp.y * .9 + gr * .35), .7 * px);
      float gemGlow = exp(-dot(gp, gp) / (90. * px)) * master * (.4 + .6 * bright);
      // Cloaks: dark by day and darker by night, their lantern side lit.
      vec3 cloak = vec3(.075, .085, .08) * (.55 + fig.r * 1.6) * (.45 + .55 * uLight) + deck * fig.g * bright * .5;
      vec3 woodCol = vec3(.13, .11, .085) + deck * bright * .25;
      float cover = max(fig.a, max(wood, frame));
      vec3 col = cloak * fig.a;
      col = mix(col, woodCol, wood * (1. - fig.a * .3));
      col = mix(col, vec3(.06, .055, .05) + deck * bright * .15, frame);
      // The deck's sigil (◆ ▲ ● ■) on the lantern's glass.
      vec2 g2 = c / 3.2;
      float sig = i == 0 ? abs(g2.x) + abs(g2.y) : i == 1 ? max(abs(g2.x) * .87 + g2.y * .5, -g2.y) : i == 2 ? length(g2) : max(abs(g2.x), abs(g2.y)) * 1.1;
      flame *= 1. - step(sig, .62) * .55;
      col += flame * glass * (1. - frame);
      col = mix(col, deck * 1.3 + .1, gem);
      col = mix(col, vec3(1.), streak * .8);
      float a = max(cover, max(glass, gem));
      vec3 light = deck * (halo * .7 + pool + gemGlow * .5) * uMagic;
      gl_FragColor = vec4(col * a + light * (1. - a), a);
    }
  `,
      ...PREMULTIPLIED,
      depthTest: false,
    }),
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return { mesh, keeper: keeper.value, state: state.value, view: view.value };
}
