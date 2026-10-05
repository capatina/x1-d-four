import * as THREE from 'three';
import { REALM_SHADER } from './palette';
import { common, material, random, type Shared } from './shared';

// The world streams toward a fixed camera: `uCourse` feeds every shader, the
// ground is sampled at (x, z − uCourse), and grass, trees and wildlife are
// wrap-around instances that re-derive themselves (position, size, variant)
// from a hash of their instance and wrap count. Nothing is allocated while
// travelling; the CPU only writes a few uniforms per frame.

/** Mesh-specific wrap uniform: (course mod period, floor(course / period)). */
export type Wrapped = THREE.Mesh & { userData: { period: number; wrap: { value: THREE.Vector2 } } };

function wrapped(mesh: THREE.Mesh, period: number, wrap: { value: THREE.Vector2 }) {
  const m = mesh as Wrapped;
  m.userData = { period, wrap };
  return m;
}

const vec3 = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `vec3(${(((n >> 16) & 255) / 255).toFixed(3)},${(((n >> 8) & 255) / 255).toFixed(3)},${((n & 255) / 255).toFixed(3)})`;
};
const R = REALM_SHADER;
/** Realm ground colour from the band (0..2, crossfaded) and a 0..1 tone. */
const realmGround = /* glsl */ `
  vec3 realmGround(float tone) {
    vec3 a = mix(${vec3(R.groundDark[0])}, ${vec3(R.groundLight[0])}, tone);
    vec3 b = mix(${vec3(R.groundDark[1])}, ${vec3(R.groundLight[1])}, tone);
    vec3 c = mix(${vec3(R.groundDark[2])}, ${vec3(R.groundLight[2])}, tone);
    return mix(mix(a, b, clamp(uBand, 0., 1.)), c, max(0., uBand - 1.));
  }
`;

export function makeSky(s: Shared) {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(370, 32, 16),
    material(
      s,
      /* glsl */ `
    varying vec3 vDir;
    void main() { vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }
  `,
      /* glsl */ `
    varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      float y = max(0., d.y);
      vec3 col = mix(uHaze, uZenith, pow(y, .55));
      float sd = distance(d, uSunDir);
      // Sun by day, a pale moon at night; one light only.
      col += uSun * (.2 - uNight * .14) * exp(-sd * sd * 16.);
      float disc = 1. - smoothstep(.018 - uNight * .004, .023 - uNight * .004, sd);
      col = mix(col, uSun * (1.02 - uNight * .1), disc);
      vec2 cp = d.xz / max(.12, d.y) * 2.2 + vec2(uTime * .002 * uMotion, -uCourse * .0006);
      float clouds = noise(cp) * .65 + noise(cp * 2.8) * .35;
      float cover = smoothstep(.52, .78, clouds) * smoothstep(.03, .25, y) * .38;
      vec3 cloud = mix(mix(vec3(.93, .91, .82), uSun, .3) * (.55 + .45 * uLight), uHaze * 1.1, uNight * .6);
      col = mix(col, cloud, cover);
      gl_FragColor = vec4(col + grain(gl_FragCoord.xy), 1.);
    }
  `,
      { side: THREE.BackSide, depthWrite: false },
    ),
  );
  sky.renderOrder = -2;
  return sky;
}

export function makeLand(s: Shared) {
  const geo = new THREE.PlaneGeometry(560, 432, 180, 150);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -156);
  const land = new THREE.Mesh(
    geo,
    material(
      s,
      /* glsl */ `
    varying vec3 vP, vN;
    void main() {
      vec3 p = position;
      // Vertices sit on land points; the grid steps back a row as the land passes.
      p.x -= uSnap.x; p.z += uSnap.y;
      p.y = ground(p.xz);
      float dx = ground(p.xz + vec2(.4, 0)) - p.y;
      float dz = ground(p.xz + vec2(0, .4)) - p.y;
      vN = normalize(vec3(-dx, .4, -dz)); vP = p;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
    }
  `,
      realmGround +
        /* glsl */ `
    varying vec3 vP, vN;
    void main() {
      vec2 L = vec2(vP.x + uRiver0, vP.z - uCourse);
      float far = smoothstep(30., 95., length(vP - cameraPosition));
      float n = noise(L * .9) * .3 * (1. - far) + noise(L * .14) * (.7 + .3 * far);
      vec3 c = realmGround(n);
      float shore = 1. - smoothstep(widthAt(vP.z), widthAt(vP.z) + 2., abs(vP.x - river(vP.z)));
      c = mix(c, vec3(.38, .35, .24), shore * .6);
      c = lit(c, vN);
      float b = beam(vP);
      c = mix(c, uAccent * (.6 + .4 * uMagic), b * .7) + uAccent * b * .25 + lanterns(vP);
      c *= 1. - shadowAt(vP) * .45;
      gl_FragColor = vec4(fogged(c, vP) + grain(gl_FragCoord.xy), 1.);
    }
  `,
    ),
  );
  land.frustumCulled = false;
  return land;
}

export function makeWater(s: Shared) {
  const geo = new THREE.PlaneGeometry(560, 430);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -0.05, -155);
  return new THREE.Mesh(
    geo,
    material(
      s,
      /* glsl */ `
    varying vec3 vP;
    void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }
  `,
      /* glsl */ `
    varying vec3 vP;
    void main() {
      float t = uTime * uMotion;
      // Ripples belong to the water, so they stream with the land.
      vec2 L = vec2(vP.x + uRiver0, vP.z - uCourseW);
      float ripple = sin(L.y * 3. + sin(L.x * 1.7 + t * .3) * 1.4 - t * .7) * .5 + .5;
      float near = 1. - smoothstep(40., 140., length(vP - cameraPosition));
      float fine = mix(.5, sin(L.y * 14. + sin(L.x * 2.1 + t) * 2.) * .5 + .5, near);
      vec3 c = mix(vec3(.14, .25, .24) * (.35 + .65 * uLight) + uZenith * .06, uHaze * .77, .3 + ripple * .08);
      float glint = exp(-pow((vP.x - uSunDir.x * 26.) / (8. + max(0., -vP.z) * .1), 2.));
      c += uSun * .28 * pow(ripple * fine, 5.) * glint * (.4 + .6 * uLight);
      float b = beam(vP);
      c = mix(c, uAccent * (.75 + .5 * uMagic), b) + uAccent * b * .45 + lanterns(vP) * 1.5;
      c *= 1. - shadowAt(vP) * .4;
      gl_FragColor = vec4(fogged(c, vP), 1.);
    }
  `,
    ),
  );
}

export function makeGrass(s: Shared, count = 44000) {
  const r = random(43);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.07, 0, 0, 0.07, 0, 0, -0.04, 0.55, 0, 0.04, 0.55, 0, 0.03, 1, 0], 3),
  );
  geo.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
  const blade = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    blade[i * 4] = r();
    blade[i * 4 + 1] = r() * 160;
    blade[i * 4 + 2] = r();
    blade[i * 4 + 3] = r() * Math.PI * 2;
  }
  geo.setAttribute('aBlade', new THREE.InstancedBufferAttribute(blade, 4));
  geo.instanceCount = count;
  const wrap = { value: new THREE.Vector2() };
  const mesh = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({
      uniforms: { ...s, uWrap: wrap },
      vertexShader:
        common +
        /* glsl */ `
    attribute vec4 aBlade;
    uniform vec2 uWrap;
    varying vec3 vP;
    varying float vY, vSeed;
    const float P = 160., ZN = 30.;
    void main() {
      float s = aBlade.y + uWrap.x;
      float m = mod(s, P);
      float k = uWrap.y + floor(s / P);
      float id = float(gl_InstanceID);
      // Each wrap is a fresh blade: new place, size and lean.
      float r1 = ihash(vec2(id, k)), r2 = ihash(vec2(id + 91733., k));
      float z = ZN - P + m;
      float off = (r1 - .5) * 150.;
      float x = river(z) + off;
      float d = abs(off);
      float wd = widthAt(z);
      float land = smoothstep(wd + .5, wd + 2.8, d);
      float growth = .45 + uGrowth * .75;
      float scale = (.35 + r2 * .85) * growth * land * smoothstep(0., 14., m);
      float ang = aBlade.w + r1 * 6.283;
      int bin = int(mod(ang * 10., 64.));
      float w = z - uCourseW;
      float wind = sin(x * .13 + w * .18 + uTime * 1.4) * .5 + sin(w * .4 + uTime * 2.) * .2;
      float sway = wind * (.13 + uWind * .55 + uSpectrum[bin] * .10 + uDecks[int(mod(ang, 4.))] * .12) * uMotion;
      vec3 p = position;
      p.x = position.x * cos(ang) + sway * position.y * position.y;
      p.z = position.x * sin(ang) + sway * .3 * position.y;
      p.y *= scale;
      p += vec3(x, groundAt(x, z, d), z);
      vP = p; vY = position.y; vSeed = fract(r2 * 7.);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
    }
  `,
      fragmentShader:
        common +
        /* glsl */ `
    varying vec3 vP;
    varying float vY, vSeed;
    void main() {
      vec3 base = mix(vec3(.19, .26, .105), vec3(.45, .43, .19), vSeed);
      base = mix(base, base * vec3(.7, 1.04, .85), clamp(uBand, 0., 1.));
      base = mix(base, vec3(.34, .43, .28), max(0., uBand - 1.) * .5);
      vec3 tip = mix(vec3(.65, .59, .32), vec3(.56, .63, .38), clamp(uBand, 0., 1.));
      tip = mix(tip, vec3(.62, .66, .55), max(0., uBand - 1.) * .6);
      vec3 c = mix(base * .65, tip, vY * .7) * ((.6 + .4 * uLight) * mix(vec3(1.), uSun, .35)) + lanterns(vP) * .6;
      gl_FragColor = vec4(fogged(c, vP), 1.);
    }
  `,
      side: THREE.DoubleSide,
    }),
  );
  mesh.frustumCulled = false;
  return wrapped(mesh, 160, wrap);
}

/** Small overlapping leaf sprays make porous, irregular crowns instead of solid blobs. */
export function makeTrees(s: Shared) {
  const r = random(711);
  const COUNT = 105,
    LEAVES = 180;
  const trunks = new Float32Array(COUNT * 4);
  const leafTree = new Float32Array(COUNT * LEAVES * 4);
  const leafOffset = new Float32Array(COUNT * LEAVES * 4);
  for (let i = 0; i < COUNT; i++) {
    const base = r() * 235,
      side = i % 2 ? 1 : -1,
      rnd = r();
    trunks.set([i, base, side, rnd], i * 4);
    for (let j = 0; j < LEAVES; j++) {
      const angle = r() * Math.PI * 2,
        vertical = r() * 2 - 1,
        radius = Math.cbrt(r());
      const spread = Math.sqrt(1 - vertical * vertical) * radius;
      const at = (i * LEAVES + j) * 4;
      leafTree.set([i, base, side, rnd], at);
      leafOffset.set(
        [Math.cos(angle) * spread * 0.43, Math.sin(angle) * spread * 0.35, 0.78 + vertical * radius * 0.36, 0.25 + r() * 0.5],
        at,
      );
    }
  }
  const wrap = { value: new THREE.Vector2() };
  function mesh(base: THREE.BufferGeometry, tree: Float32Array, leaf: Float32Array | null) {
    const geo = new THREE.InstancedBufferGeometry().copy(base as THREE.InstancedBufferGeometry);
    base.dispose();
    geo.setAttribute('aTree', new THREE.InstancedBufferAttribute(tree, 4));
    if (leaf) geo.setAttribute('aLeaf', new THREE.InstancedBufferAttribute(leaf, 4));
    geo.instanceCount = tree.length / 4;
    const isLeaf = !!leaf;
    const m = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: { ...s, uWrap: wrap },
        vertexShader:
          common +
          /* glsl */ `
      attribute vec4 aTree;
      ${isLeaf ? 'attribute vec4 aLeaf;' : ''}
      uniform vec2 uWrap;
      varying vec3 vP, vN;
      varying float vSeed;
      varying vec2 vUv;
      const float P = 235., ZN = 30.;
      void main() {
        float s = aTree.y + uWrap.x;
        float m = mod(s, P);
        float k = uWrap.y + floor(s / P);
        float r1 = ihash(vec2(aTree.x, k)), r2 = ihash(vec2(aTree.x + 4099., k)), r3 = ihash(vec2(aTree.x + 8111., k));
        float z = ZN - P + m;
        float dist = 18. + r1 * 95.;
        float x = river(z) + aTree.z * dist;
        // Moor, wood, fell: each realm keeps its own share of trees.
        float realm = realmFor(k * P - aTree.y);
        float keep = realm < .5 ? step(r3, .5) : (realm < 1.5 ? 1. : step(r3, .7));
        float h = (3. + r2 * 6.) * keep * smoothstep(0., 22., m);
        vec3 p = position; vUv = uv;
        float growth = .85 + uGrowth * .18;
        vSeed = fract(r3 * 13.7 + aTree.w);
        ${
          isLeaf
            ? `
          p *= aLeaf.w * growth * clamp(h / 6., 0., 1.4);
          p.xz = mat2(cos(vSeed * 6.28), -sin(vSeed * 6.28), sin(vSeed * 6.28), cos(vSeed * 6.28)) * p.xz;
          p += vec3(aLeaf.x * h, aLeaf.z * h, aLeaf.y * h) * growth;
        `
            : 'p.xz *= (.10 + h * .018) * step(.01, h); p.y = (p.y + .5) * h * growth;'
        }
        p.x += sin(uTime * .65 + aTree.x) * .09 * position.y * uWind * uMotion;
        p += vec3(x, groundAt(x, z, dist), z);
        vP = p; vN = normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
      }
    `,
        fragmentShader:
          common +
          /* glsl */ `
      varying vec3 vP, vN;
      varying float vSeed;
      varying vec2 vUv;
      void main() {
        ${
          isLeaf
            ? `
          vec2 uv = vUv * 2. - 1.;
          if (dot(uv, uv) > .82 + noise(uv * 9.) * .18) discard;
          vec3 c = mix(vec3(.13, .22, .11), vec3(.41, .44, .22), vSeed);
          c = mix(c, c * vec3(.76, 1.04, .87), clamp(uBand, 0., 1.));
          c = mix(c, vec3(.33, .41, .31), max(0., uBand - 1.) * .35);
          c *= .75 + .25 * noise(vP.xz * 3.);
        `
            : 'vec3 c = vec3(.24, .20, .14);'
        }
        vec3 col = lit(c * 1.12, normalize(vN + vec3(0., .6, 0.))) + lanterns(vP) * .5;
        gl_FragColor = vec4(fogged(col, vP), 1.);
      }
    `,
        side: isLeaf ? THREE.DoubleSide : THREE.FrontSide,
      }),
    );
    m.frustumCulled = false;
    return wrapped(m, 235, wrap);
  }
  return [mesh(new THREE.CylinderGeometry(0.7, 1.3, 1, 7), trunks, null), mesh(new THREE.PlaneGeometry(2, 1.8), leafTree, leafOffset)];
}

/**
 * Swallows fly with the vessel; meadow butterflies (pale wisps at night and
 * in vigil) belong to the land and stream past. Swallow 0 is the herald: it
 * flies from the Wayfinder to the aimed gate and circles it.
 */
export function makeLife(s: Shared, butterfly: boolean) {
  const r = random(butterfly ? 82 : 29);
  const n = butterfly ? 65 : 24;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0.25, -0.9, 0, -0.1, -0.35, 0, 0.25, 0, 0, 0.25, 0.35, 0, 0.25, 0.9, 0, -0.1], 3),
  );
  const a = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    a[i * 4] = (r() - 0.5) * 95;
    a[i * 4 + 1] = butterfly ? r() * 120 : -r() * 110;
    a[i * 4 + 2] = r();
    a[i * 4 + 3] = i / n;
  }
  geo.setAttribute('aLife', new THREE.InstancedBufferAttribute(a, 4));
  geo.instanceCount = n;
  const wrap = { value: new THREE.Vector2() };
  const m = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({
      uniforms: { ...s, uWrap: wrap },
      vertexShader:
        common +
        /* glsl */ `
    attribute vec4 aLife;
    uniform vec2 uWrap;
    uniform vec4 uHerald;
    uniform float uHeraldY, uHeraldT;
    varying vec3 vP;
    varying float vSeed;
    const float P = 120., ZN = 8.;
    void main() {
      float t = uTime * uMotion;
      float visible = smoothstep(aLife.w, aLife.w + .16, uLife);
      ${
        butterfly
          ? `
      // Wisps: slower, paler, rising, in the night or a vigil.
      float wisp = max(uNight, uVigil * .8);
      float s = aLife.y + uWrap.x;
      float m = mod(s, P);
      float z = ZN - P + m;
      visible = max(visible, wisp * step(aLife.z, .7)) * smoothstep(0., 10., m) * (1. - smoothstep(P - 8., P, m));
      vec3 p = position * mix(.15, .1, wisp) * visible;
      float tt = t * mix(1., .35, wisp);
      p.y += sin(tt * 14. + aLife.z * 40.) * abs(p.x) * .7 * (1. - wisp);
      float angle = tt * .18 + aLife.z * 6.28;
      p.xz = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * p.xz;
      float x = river(z) + aLife.x + sin(angle) * 2.;
      p.x += x;
      p.z += z + cos(angle) * 2.;
      p.y += groundAt(x, z, abs(aLife.x)) + 1.5 + sin(tt * .7 + aLife.z * 9.) * .5 + wisp * (1.5 + fract(tt * .05 + aLife.z) * 5.);
      `
          : `
      vec3 p = position * .48 * visible;
      p.y += sin(t * 5. + aLife.z * 40.) * abs(p.x) * .7;
      float angle = t * .05 + aLife.z * 6.28;
      vec3 at = vec3(aLife.x + sin(angle) * 14., 12. + aLife.z * 14. + sin(angle) * 2., aLife.y + cos(angle) * 10.);
      if (gl_InstanceID == 0) {
        // The herald: from the Wayfinder to the aimed gate, then a slow circle over it.
        float ht = uHeraldT;
        float e = 1. - pow(1. - clamp(ht / 1.05, 0., 1.), 3.);
        vec2 xz = mix(uHerald.xy, uHerald.zw, e);
        float circle = smoothstep(.85, 1.4, ht);
        float ca = max(0., ht - .9) * 1.7;
        xz += vec2(sin(ca), cos(ca)) * 3.4 * circle;
        at = vec3(xz.x, mix(2.4, uHeraldY, e) + sin(e * 3.1416) * 3.5, xz.y);
        vec2 dir = mix(normalize(uHerald.zw - uHerald.xy + 1e-4), vec2(cos(ca), -sin(ca)), circle);
        angle = atan(dir.x, dir.y) + 3.1416;
        p = position * .62;
        p.y += sin(t * 9.) * abs(p.x) * .6;
        p *= step(0., ht);
      }
      p.xz = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * p.xz;
      p += at;
      `
      }
      vP = p; vSeed = aLife.z;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
    }
  `,
      fragmentShader:
        common +
        /* glsl */ `
    varying vec3 vP; varying float vSeed;
    void main() {
      ${
        butterfly
          ? `
      float wisp = max(uNight, uVigil * .8);
      vec3 day = mix(vec3(.81, .62, .3), vec3(.91, .84, .61), vSeed) * (.6 + .4 * uLight);
      vec3 c = mix(day, vec3(1., .86, .6) * (.9 + .4 * uMagic), wisp);
      `
          : 'vec3 c = vec3(.12, .16, .14) * (.5 + .5 * uLight);'
      }
      gl_FragColor = vec4(fogged(c, vP), 1.);
    }
  `,
      side: THREE.DoubleSide,
    }),
  );
  m.frustumCulled = false;
  return wrapped(m, 120, wrap);
}
