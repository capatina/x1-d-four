import * as THREE from 'three';
import { BEND_GLSL } from './bend';

/**
 * Scene pieces for the similarity tunnel. Every piece is a single draw call
 * (instanced where it repeats) and shares one uniform set, so a frame is about
 * six scene draws plus bloom.
 */

export const TUNNEL_RADIUS = 10;
export const TUNNEL_NEAR = -4;
export const TUNNEL_FAR = 240;
export const SPECTRUM_BINS = 64;

export type Shared = ReturnType<typeof makeShared>;

export function makeShared(spectrum: THREE.DataTexture) {
  return {
    uTime: { value: 0 },
    uTravel: { value: 0 },
    uSeg: { value: 5 },
    uBeatPulse: { value: 0 },
    uFlow: { value: 0 },
    uLow: { value: 0 },
    uMid: { value: 0 },
    uHigh: { value: 0 },
    uKick: { value: 0 },
    uFlash: { value: 1 },
    uWarp: { value: 0 },
    uHue: { value: 0 },
    uFog: { value: 0.03 },
    uRadius: { value: TUNNEL_RADIUS },
    uColA: { value: new THREE.Color() },
    uColB: { value: new THREE.Color() },
    uHot: { value: new THREE.Color() },
    uWaves: { value: [-1, -1, -1, -1] },
    uBendS: { value: new THREE.Vector4() },
    uBendC: { value: new THREE.Vector4() },
    uBendAmt: { value: 1 },
    uSpec: { value: spectrum },
  };
}

const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

function additive(params: THREE.ShaderMaterialParameters): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    ...params,
  });
}

// ---------------------------------------------------------------------------
// Tunnel wall

export function makeTunnel(shared: Shared): THREE.Mesh {
  const RS = 144; // around
  const LS = 260; // along
  const pos = new Float32Array((RS + 1) * (LS + 1) * 3);
  let k = 0;
  for (let j = 0; j <= LS; j++) {
    for (let i = 0; i <= RS; i++) {
      pos[k++] = i / RS;
      pos[k++] = j / LS;
      pos[k++] = 0;
    }
  }
  const idx = new Uint32Array(RS * LS * 6);
  k = 0;
  for (let j = 0; j < LS; j++) {
    for (let i = 0; i < RS; i++) {
      const a = j * (RS + 1) + i;
      const b = a + RS + 1;
      idx.set([a, b, a + 1, a + 1, b, b + 1], k);
      k += 6;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));

  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      ...shared,
      uNear: { value: TUNNEL_NEAR },
      uFar: { value: TUNNEL_FAR },
    },
    vertexShader: /* glsl */ `
      ${BEND_GLSL}
      uniform float uRadius;
      uniform float uNear;
      uniform float uFar;
      uniform float uLow;
      uniform float uKick;
      uniform float uFlash;
      uniform float uWaves[4];
      varying float vAng;
      varying float vD;
      void main() {
        float ang = position.x * 6.2831853;
        float d = mix(uNear, uFar, pow(position.y, 1.7));
        float nearW = exp(-max(d, 0.0) * 0.045);
        // Low band squeezes the tube: pressure on the kick.
        float r = uRadius * (1.0 - (uLow * 0.085 + uKick * 0.05 * uFlash) * nearW);
        for (int i = 0; i < 4; i++) {
          float w = uWaves[i];
          if (w >= 0.0) r += 0.45 * exp(-pow((d - w) * 0.35, 2.0)) * exp(-w * 0.015);
        }
        vec2 off = bend(d);
        vec3 p = vec3(cos(ang) * r + off.x, sin(ang) * r + off.y, -d);
        vAng = position.x;
        vD = d;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      uniform float uTime;
      uniform float uTravel;
      uniform float uSeg;
      uniform float uBeatPulse;
      uniform float uLow;
      uniform float uMid;
      uniform float uHigh;
      uniform float uKick;
      uniform float uFlash;
      uniform float uWarp;
      uniform float uHue;
      uniform float uFog;
      uniform float uWaves[4];
      uniform vec3 uColA;
      uniform vec3 uColB;
      uniform vec3 uHot;
      varying float vAng;
      varying float vD;

      float lineW(float x, float fw, float px) {
        float f = abs(fract(x + 0.5) - 0.5);
        return 1.0 - smoothstep(0.0, max(fw, 1e-4) * px, f);
      }

      void main() {
        float d = max(vD, 0.0);
        float s = d + uTravel;
        // One ring per beat; every fourth (the bar) burns brighter.
        float beatPos = s / uSeg;
        float ringId = floor(beatPos + 0.5);
        float bar = 1.0 - step(0.5, mod(ringId, 4.0));
        float ring = lineW(beatPos, fwidth(beatPos), 1.4);
        float halo = exp(-abs(fract(beatPos + 0.5) - 0.5) * uSeg * 1.4);

        // Ribs along the tube (seam-safe derivative).
        float ra = vAng * 36.0;
        float rfw = min(fwidth(ra), fwidth(fract(vAng + 0.5) * 36.0));
        float rib = lineW(ra, rfw, 0.9);

        float a = vAng * 6.2831853;
        // Mid band: hue drifts around the tube.
        float m = 0.5 + 0.5 * sin(a * 2.0 + uHue + s * 0.011);
        vec3 col = mix(uColA, uColB, m);

        float neb = vnoise(vec2(cos(a) * 3.2 + s * 0.035, sin(a) * 3.2 - s * 0.021));
        neb *= neb;

        float fog = exp(-d * uFog);
        float nearFade = smoothstep(1.5, 11.0, d);
        float energy = 0.35 + 0.65 * uLow;

        // Mostly black: thin lines carry the light, haze stays faint.
        vec3 c = col * ring * (0.22 + 0.8 * bar) * (energy + 0.6 * uBeatPulse);
        c += col * halo * 0.010 * (1.0 + 2.0 * bar) * (0.5 + uLow);
        c += col * rib * 0.04 * (0.45 + 0.8 * uMid);
        c += col * neb * 0.03 * (0.3 + 0.9 * uMid);

        // Onsets send a ring of light down the tube.
        for (int i = 0; i < 4; i++) {
          float w = uWaves[i];
          if (w >= 0.0) {
            float x = (d - w) * 1.1;
            c += mix(col, uHot, 0.4) * exp(-x * x) * 0.4 * exp(-(w - 18.0) * 0.02) * (0.35 + 0.65 * uFlash);
          }
        }

        // High band: sparkle grain on the walls.
        vec2 g = vec2(vAng * 300.0, s * 2.2);
        float h = hash12(floor(g) + floor(uTime * 18.0) * vec2(7.0, 3.0));
        float sp = smoothstep(1.0 - (0.0015 + 0.03 * uHigh * uHigh), 1.0, h);
        // Round glints (cells are ~0.21 x 0.45 units), only once they're small on screen.
        vec2 f = (fract(g) - 0.5) * vec2(0.21, 0.45);
        sp *= (1.0 - smoothstep(0.02, 0.09, length(f))) * smoothstep(16.0, 34.0, d);
        c += uHot * sp * (0.2 + 2.2 * uHigh);

        c *= 1.0 + uKick * uFlash * 0.35 + uWarp * 1.2;
        c *= fog * nearFade;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;
  return mesh;
}

// ---------------------------------------------------------------------------
// Sparks: instanced streaks riding the walls, lit by the high band

export function makeSparks(shared: Shared, count: number): THREE.Mesh {
  const base = new THREE.PlaneGeometry(2, 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  const seeds = new Float32Array(count * 4);
  let r = 0x9e3779b9;
  const rnd = () => {
    r ^= r << 13;
    r ^= r >>> 17;
    r ^= r << 5;
    return (r >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i++) seeds.set([rnd(), Math.sqrt(rnd()), rnd(), 0.4 + rnd() * 0.9], i * 4);
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = count;

  const mat = additive({
    uniforms: shared,
    vertexShader: /* glsl */ `
      ${BEND_GLSL}
      attribute vec4 aSeed;
      uniform float uTravel;
      uniform float uTime;
      uniform float uRadius;
      uniform float uWarp;
      uniform float uHigh;
      varying vec2 vUv;
      varying float vI;
      void main() {
        float L = 150.0;
        float d = mod(aSeed.z * L - uTravel * (0.5 + aSeed.w), L) - 3.0;
        float ang = aSeed.x * 6.2831853 + uTime * 0.025 * (aSeed.w - 0.9);
        float r = uRadius * mix(0.5, 0.94, aSeed.y);
        vec2 off = bend(d);
        vec2 dir = vec2(cos(ang), sin(ang));
        vec2 tang = vec2(-dir.y, dir.x);
        float len = 0.5 + 0.9 * aSeed.w + abs(uWarp) * 9.0;
        float wid = 0.012 + 0.012 * aSeed.y;
        vec3 p = vec3(dir * r + off + tang * position.x * wid, -d + position.y * len);
        vUv = position.xy;
        float tw = 0.5 + 0.5 * sin(uTime * (2.5 + aSeed.w * 6.0) + aSeed.x * 40.0);
        vI = (0.04 + uHigh * 1.1 * tw + abs(uWarp) * 0.7) * exp(-max(d, 0.0) * 0.03) * smoothstep(4.0, 16.0, d);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColB;
      uniform vec3 uHot;
      varying vec2 vUv;
      varying float vI;
      void main() {
        float a = exp(-vUv.x * vUv.x * 6.0) * (1.0 - abs(vUv.y));
        gl_FragColor = vec4(mix(uColB, uHot, 0.65) * a * vI, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return mesh;
}

// ---------------------------------------------------------------------------
// Spectrum ring at the tunnel mouth: 64 bins mirrored, bass at the bottom

export const MOUTH_DEPTH = 19;

export function makeSpectrumRing(shared: Shared): THREE.Mesh {
  const base = new THREE.PlaneGeometry(2, 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  const bars = new Float32Array(SPECTRUM_BINS * 2 * 2);
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    bars.set([i, 1], i * 4);
    bars.set([i, -1], i * 4 + 2);
  }
  geo.setAttribute('aBar', new THREE.InstancedBufferAttribute(bars, 2));
  geo.instanceCount = SPECTRUM_BINS * 2;

  const mat = additive({
    uniforms: { ...shared, uMouth: { value: MOUTH_DEPTH }, uBarLen: { value: 2.3 } },
    vertexShader: /* glsl */ `
      ${BEND_GLSL}
      attribute vec2 aBar;
      uniform sampler2D uSpec;
      uniform float uRadius;
      uniform float uMouth;
      uniform float uBarLen;
      varying vec2 vUv;
      varying float vLevel;
      void main() {
        float bin = aBar.x;
        float level = texture2D(uSpec, vec2((bin + 0.5) / 64.0, 0.5)).r;
        float ang = -1.5707963 + aBar.y * 3.14159265 * (bin + 0.5) / 64.0;
        vec2 dir = vec2(cos(ang), sin(ang));
        vec2 tang = vec2(-dir.y, dir.x);
        float outer = uRadius * 0.9;
        float len = 0.05 + level * uBarLen;
        float t = position.y * 0.5 + 0.5;
        float wid = 3.14159265 * outer / 64.0 * 0.3;
        vec2 xy = dir * (outer - t * len) + tang * position.x * wid;
        vUv = vec2(position.x, t);
        vLevel = level;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(xy + bend(uMouth), -uMouth, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColA;
      uniform vec3 uColB;
      uniform vec3 uHot;
      varying vec2 vUv;
      varying float vLevel;
      void main() {
        float side = exp(-vUv.x * vUv.x * 2.5);
        vec3 col = mix(mix(uColA, uColB, vUv.y), uHot, vUv.y * vLevel * 0.7);
        float I = side * (0.12 + 1.25 * vLevel) * (0.3 + 0.7 * vUv.y);
        gl_FragColor = vec4(col * I, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return mesh;
}

// ---------------------------------------------------------------------------
// Trails: camera-facing ribbons along quadratic curves, one instance each

export const TRAIL_SEGMENTS = 36;

export type Trails = {
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  a: THREE.InstancedBufferAttribute;
  b: THREE.InstancedBufferAttribute;
  c: THREE.InstancedBufferAttribute;
  style: THREE.InstancedBufferAttribute;
  capacity: number;
};

export function makeTrails(shared: Shared, capacity: number): Trails {
  const n = TRAIL_SEGMENTS;
  const seg = new Float32Array((n + 1) * 2 * 2);
  for (let i = 0; i <= n; i++) {
    seg.set([i / n, -1, i / n, 1], i * 4);
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex(idx);
  // three needs a `position` attribute to size the draw; the shader ignores it.
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((n + 1) * 2 * 3), 3));
  geo.setAttribute('aSeg', new THREE.BufferAttribute(seg, 2));
  const dyn = (size: number) => {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
    attr.setUsage(THREE.DynamicDrawUsage);
    return attr;
  };
  const a = dyn(3);
  const b = dyn(3);
  const c = dyn(3);
  const style = dyn(4);
  geo.setAttribute('aA', a);
  geo.setAttribute('aB', b);
  geo.setAttribute('aC', c);
  geo.setAttribute('aStyle', style);
  geo.instanceCount = 0;

  const mat = additive({
    uniforms: shared,
    vertexShader: /* glsl */ `
      attribute vec2 aSeg;
      attribute vec3 aA;
      attribute vec3 aB;
      attribute vec3 aC;
      attribute vec4 aStyle;
      varying float vT;
      varying float vSide;
      varying vec4 vStyle;
      varying float vD;
      void main() {
        float t = aSeg.x;
        vec3 p = mix(mix(aA, aB, t), mix(aB, aC, t), t);
        vec3 tg = 2.0 * (1.0 - t) * (aB - aA) + 2.0 * t * (aC - aB);
        vec3 toCam = cameraPosition - p;
        vec3 n = cross(tg, toCam);
        n = n / max(length(n), 1e-5);
        float w = aStyle.x * smoothstep(0.0, 0.15, t) * mix(1.0, 0.8, t);
        p += n * w * aSeg.y;
        vT = t;
        vSide = aSeg.y;
        vStyle = aStyle;
        vD = -p.z;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uFlow;
      uniform vec3 uColA;
      uniform vec3 uColB;
      uniform vec3 uHot;
      varying float vT;
      varying float vSide;
      varying vec4 vStyle;
      varying float vD;
      void main() {
        float edge = 1.0 - abs(vSide);
        edge *= edge;
        // A pulse runs out along every branch on each beat.
        float flow = pow(fract(vT * 1.5 - uFlow + vStyle.z), 8.0);
        float ends = smoothstep(0.0, 0.12, vT) * (1.0 - smoothstep(0.86, 1.0, vT));
        float fog = exp(-max(vD - 12.0, 0.0) * 0.03);
        vec3 col = mix(uColA, uColB, 0.25 + 0.5 * vStyle.z);
        vec3 c = mix(col, uHot, 0.15 + flow * 0.6) * edge * (0.45 + 1.8 * flow) * ends * vStyle.y * fog;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return { mesh, geo, a, b, c, style, capacity };
}

// ---------------------------------------------------------------------------
// Portals: instanced, camera-facing glowing gates (and soft glow blobs)

export type Portals = {
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  pos: THREE.InstancedBufferAttribute;
  style: THREE.InstancedBufferAttribute;
  tint: THREE.InstancedBufferAttribute;
  capacity: number;
};

export function makePortals(shared: Shared, capacity: number): Portals {
  const base = new THREE.PlaneGeometry(2, 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  const dyn = (size: number) => {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
    attr.setUsage(THREE.DynamicDrawUsage);
    return attr;
  };
  const pos = dyn(3);
  const style = dyn(4);
  const tint = dyn(4);
  geo.setAttribute('aPos', pos);
  geo.setAttribute('aStyle', style);
  geo.setAttribute('aTint', tint);
  geo.instanceCount = 0;

  const mat = additive({
    uniforms: shared,
    vertexShader: /* glsl */ `
      attribute vec3 aPos;
      attribute vec4 aStyle;
      attribute vec4 aTint;
      varying vec2 vUv;
      varying vec4 vStyle;
      varying vec4 vTint;
      void main() {
        vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
        mv.xy += position.xy * aStyle.x;
        vUv = position.xy;
        vStyle = aStyle;
        vTint = aTint;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uBeatPulse;
      uniform vec3 uColA;
      uniform vec3 uColB;
      uniform vec3 uHot;
      uniform sampler2D uSpec;
      varying vec2 vUv;
      varying vec4 vStyle;
      varying vec4 vTint;
      void main() {
        float r = length(vUv);
        float opacity = vStyle.y;
        float aimed = vStyle.z;
        float hover = vStyle.w;
        float sim = vTint.x;
        vec3 col = mix(uColA, uColB, vTint.z);
        if (vTint.y > 0.5) {
          // Soft glow blob (light at the end of the tunnel).
          float g = max(0.0, 1.0 - r * r);
          gl_FragColor = vec4(col * g * g * g * opacity, 1.0);
          return;
        }
        float ang = atan(vUv.y, vUv.x);
        // Spectrum around the rim, mirrored, bass at the bottom.
        float u = abs(ang + 1.5707963);
        if (u > 3.14159265) u = 6.2831853 - u;
        u /= 3.14159265;
        float spec = texture2D(uSpec, vec2(0.02 + u * 0.96, 0.5)).r;
        float R = 0.62 + aimed * (0.015 * uBeatPulse + spec * 0.075);
        float dr = abs(r - R);
        float aa = fwidth(r) * 1.25;
        float thick = mix(0.010, 0.016, aimed) + 0.006 * sim;
        float core = 1.0 - smoothstep(thick, thick + aa, dr);
        float glow = exp(-dr * mix(15.0, 8.5, aimed));
        float inner = 1.0 - smoothstep(0.003, 0.003 + aa, abs(r - (R - 0.085)));
        float veil = (1.0 - smoothstep(0.0, R, r)) * (0.55 + 0.45 * sin(r * 34.0 - uTime * 2.2 + vTint.w * 6.0));
        float tickR = R + 0.12;
        float dash = step(0.45, fract(ang / 6.2831853 * 48.0 + uTime * 0.035));
        float tick = (1.0 - smoothstep(0.006, 0.006 + aa, abs(r - tickR))) * dash * aimed;

        float bright = (0.5 + 0.55 * sim) * (1.0 + 0.45 * aimed + 0.45 * hover);
        vec3 hot = mix(col, uHot, 0.22 + 0.3 * aimed + 0.25 * hover);
        vec3 c = hot * core * 1.15 * bright;
        c += col * glow * 0.13 * bright;
        c += col * inner * 0.32 * bright * (1.0 - 0.6 * aimed);
        c += col * veil * (0.006 + 0.012 * aimed + 0.03 * hover);
        c += hot * tick * 0.9;
        c *= 1.0 - smoothstep(0.82, 1.0, r);
        gl_FragColor = vec4(c * opacity, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  return { mesh, geo, pos, style, tint, capacity };
}
