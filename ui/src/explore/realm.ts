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

/** Spire unit geometry: base at y = 0, cap apex at SPIRE_TOP. */
export const SPIRE_TOP = 7.3;

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
    varying float vPart, vLocalY, vSim, vSlot, vSeed;
    void main() {
      vec3 p = position;
      float seed = aInfo.x;
      if (aPart < 2.5 || aTier > 2.5) {
        // Each tier sits a little off the one below and the whole tower leans.
        vec2 lean = vec2(hash(vec2(seed, 1.)) - .5, hash(vec2(seed, 2.)) - .5) * .1;
        float t = min(aTier, 2.);
        vec2 off = vec2(hash(vec2(seed, t + 3.)) - .5, hash(vec2(seed, t + 7.)) - .5) * .16 * t;
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
      p *= aSpire.w;
      p += aSpire.xyz;
      p.y += sin(uTime * .35 + seed * 9.) * .1 * uMotion * aSpire.w;
      vP = p; vPart = aPart; vSim = aInfo.y; vSlot = aInfo.z; vSeed = seed;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
    }
  `,
      /* glsl */ `
    varying vec3 vP;
    varying float vPart, vLocalY, vSim, vSlot, vSeed;
    void main() {
      vec3 n = normalize(cross(dFdx(vP), dFdy(vP)));
      if (dot(n, cameraPosition - vP) < 0.) n = -n;
      vec3 c;
      float a = 1.;
      if (vPart < .5) {
        float worn = snoise(vec2(vLocalY * 3., vSeed * 40. + atan(n.z, n.x) * 2.));
        c = lit(vec3(.36, .345, .31) * (.78 + .32 * worn), n);
      } else if (vPart < 1.5) {
        // The lit window band: its glow is the node's similarity; it flickers ±15 % with the realm's spectrum.
        int bin = int(mod(vSeed * 64., 8.));
        float glow = (.3 + .7 * vSim * vSim) * (.92 + .3 * uFlicker[bin]);
        int slot = int(vSlot + .5);
        float aimed = slot < 8 ? min(uGate[slot], 1.2) : 0.;
        float lamp = step(.5, fract(atan(n.z, n.x) * 1.114 + .25));
        c = vec3(1., .78, .47) * glow * (.55 + .45 * lamp) * (.8 + .5 * uMagic) + uAccent * aimed * .35;
        c = mix(c, lit(vec3(.25, .23, .2), n), .25 * (1. - lamp));
      } else if (vPart < 2.5) {
        c = lit(vec3(.2, .22, .22), n);
      } else {
        c = lit(vec3(.34, .31, .26) * (.75 + .35 * snoise(vP.xz * 2.1 + vLocalY)), n);
        // The underside dissolves into haze.
        a = smoothstep(-2.75, -.7, vLocalY);
        c = mix(uHaze, c, a);
        if (a < hash(gl_FragCoord.xy * .71)) discard;
      }
      gl_FragColor = vec4(fogged(c, vP), 1.);
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
      float core = 1. - smoothstep(grand ? .3 : .24, grand ? .42 : .3, side);
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
        pat = 1. - vWet * step(.82, cell) * step(.6, side / .3) * .55;
        stone = vec3(.7, .72, .68) * (.9 + .1 * hash(vec2(floor(dist * .5), 7.)));
      }
      vec3 base = lit(stone * pat, vec3(0., 1., 0.));
      // Ley light flows along the route toward its gate.
      float flow = pow(fract(vR.y * 6. - uFlow), 5.) * (1. - uVigil);
      // A drop sends a wave of light down the aimed route (600 ms).
      float wave = grand ? 0. : exp(-pow((vR.y - uLeyWave / .6) * 7., 2.)) * step(uLeyWave, .7) * min(light, 1.) * 2.2;
      float leyAmt = (light * (.45 + 1.1 * flow) + wave) * uMagic * (1. - .6 * uMist) * (1. - .45 * uVigil);
      vec3 ley = uAccent * leyAmt;
      float alpha = core * (grand ? .3 : .34 + .62 * min(light, 1.)) * (1. - .5 * uMist * (1. - light));
      if (slot == 7) alpha = core * light;
      vec3 coreCol = fogged(base + ley * .9, vP);
      float halo = exp(-side * side * 5.) * leyAmt * .22 * (1. - core);
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
      else if (aBillInfo.x > .5) { c = vec3(uWay.x, 1.35 + sin(uTime * 1.3) * .09 * uMotion, uWay.y); rad = 1.15; }
      vec4 mv = modelViewMatrix * vec4(c, 1.);
      mv.xy += position.xy * rad;
      gl_Position = rad > 0. ? projectionMatrix * mv : vec4(2., 2., 2., 1.);
      vUv = uv; vC = c; vKind = aBillInfo.x; vSlot = aBillInfo.y; vSeed = aBillInfo.z;
    }
  `,
      fragmentShader:
        common +
        /* glsl */ `
    varying vec2 vUv;
    varying vec3 vC;
    varying float vKind, vSlot, vSeed;
    // A stone ring with plinths and a band of etched runes.
    vec4 gate(vec2 uv, float ign, float turn, float seed, float stoneA) {
      float r = length(uv);
      float ring = smoothstep(.64, .67, r) * (1. - smoothstep(.91, .94, r));
      float feet = step(abs(abs(uv.x) - .6), .11) * step(uv.y, -.5) * step(-.98, uv.y) * step(.6, r);
      float stone = max(ring, feet);
      float a = fract(atan(uv.y, uv.x) / 6.2832 + .5 + turn);
      float cell = floor(a * 14.);
      float runeA = rune(mod(cell * 5. + floor(seed * 16.), 16.), vec2(fract(a * 14.), clamp((.9 - r) / .22, 0., 1.)));
      runeA *= ring;
      vec3 rock = lit(vec3(.33, .32, .29), normalize(vec3(uv * .6, .8)));
      vec3 c = rock * (1. - runeA * .45);
      // Ignited runes are light in the stone; at rest they are faint embers.
      float ember = mix(.12, .32, uVigil);
      vec3 emberCol = mix(uAccent, vec3(1., .55, .3), uVigil * .7);
      // In vigil even the aimed ring burns low, like the rest.
      vec3 lit1 = mix(uAccent * (1.1 + .9 * max(0., ign - 1.) * 4.), emberCol * .6, uVigil * .55);
      vec3 light = mix(emberCol * ember, lit1, clamp(ign, 0., 1.)) * runeA * uMagic;
      float inner = (1. - smoothstep(.0, .67, r)) * clamp(ign, 0., 1.) * .16 * uMagic;
      float halo = exp(-pow((r - .8) * 5.5, 2.)) * clamp(ign, 0., 1.) * .25 * uMagic;
      return vec4(c * stone * stoneA + light + uAccent * (inner + halo), stone * stoneA);
    }
    void main() {
      vec2 uv = vUv * 2. - 1.;
      vec4 o;
      float far = 1. - exp(-max(0., length(vC - cameraPosition) - 22.) * uFog * (1. + .6 * uMist));
      if (vKind < .5) {
        int slot = int(vSlot + .5);
        float ign = uGate[slot];
        o = gate(uv, ign, uBar * step(.5, ign) * uMotion, vSeed, 1.);
        o.rgb = mix(o.rgb, uHaze * o.a, far);
      } else if (vKind < 1.5) {
        // The Wayfinder: a small iron lantern, its glass warm, a soft halo.
        float r = length(uv);
        vec2 b = abs(uv - vec2(0., -.08));
        float body = step(b.x, .26) * step(b.y, .34);
        float roof = step(abs(uv.x), .3 - (uv.y - .26) * .9) * step(.26, uv.y) * step(uv.y, .5);
        float ringH = abs(length(uv - vec2(0., .6)) - .1) < .03 ? 1. : 0.;
        float glass = step(b.x, .19) * step(b.y, .27) * (1. - step(abs(uv.x), .025));
        float frame = max(max(body, roof), ringH) * (1. - glass);
        vec3 flame = vec3(1., .8, .5) * (1.1 + .15 * sin(uTime * 7.3) * uMotion) * uWayPrev.w;
        vec3 c = vec3(.09, .085, .08) * frame + flame * glass * (1. - frame);
        float halo = exp(-r * r * 3.2) * .45 * uWayPrev.w;
        float cover = max(frame, glass);
        o = vec4(c * cover + vec3(1., .78, .5) * halo * (1. - cover) * uMagic, frame);
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
      // Sampled outside any branch (a branch would break mip selection at the cell's edge).
      vec2 cp = clamp(p, vec2(1.), vec2(${KEEPER_W - 1}., ${KEEPER_H - 1}.));
      vec4 fig = texture2D(uKeeperAtlas, vec2((cp.x + float(i) * ${KEEPER_W}.) / ${KEEPER_W * 4}., cp.y / ${KEEPER_H}.));
      fig *= step(0., p.x) * step(p.x, ${KEEPER_W}.) * step(0., p.y) * step(p.y, ${KEEPER_H}.);
      // Pole from the hand, or (the master) a tall staff with a gem.
      vec2 tip = hand + vec2(side * 17., -30.);
      float pole = seg(p, hand + vec2(-side * 3., 5.), tip);
      vec2 staffTop = vec2(hand.x + side * 3., -14.);
      float staff = seg(p, vec2(hand.x + side * 1., ${KEEPER_H}. - 4.), staffTop);
      float wood = 1. - smoothstep(1.2, 2.2, mix(pole, min(pole, staff), master));
      // The lantern hangs from the tip and swings.
      vec2 q = p - tip;
      float cs = cos(swing), sn = sin(swing);
      q = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y);
      vec2 c = q - vec2(0., 17.);
      float chain = (1. - smoothstep(.5, 1.2, abs(q.x))) * step(0., q.y) * step(q.y, 10.);
      vec2 b = abs(c);
      float body = step(b.x, 6.) * step(b.y, 7.5);
      float cap = step(abs(c.x), 6. - (c.y + 7.5) * -.8) * step(c.y, -7.5) * step(-11.5, c.y);
      float glass = step(b.x, 3.8) * step(b.y, 5.5);
      float frame = max(max(body, cap), chain) * (1. - glass);
      vec3 flame = mix(deck, vec3(1., .93, .8), .35) * (.35 + 1.1 * bright);
      // Light: the lantern's halo, a pool at the feet, the gem.
      vec2 lc = tip + vec2(-sn, cs) * 17.;
      float halo = exp(-dot(p - lc, p - lc) / 520.) * bright;
      vec2 f = (p - vec2(64., ${KEEPER_H}. - 3.)) / vec2(46., 7.);
      float pool = exp(-dot(f, f) * 1.6) * bright * (.25 + uKeeper[i].w * .3);
      vec2 g = abs(p - staffTop - vec2(0., -3.));
      float gem = step(g.x + g.y * .6, 3.6) * master;
      float gemGlow = exp(-dot(p - staffTop, p - staffTop) / 90.) * master * (.4 + .6 * bright);
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
      float a = max(cover, max(glass, gem));
      vec3 light = deck * (halo * .55 + pool + gemGlow * .5) * uMagic;
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
