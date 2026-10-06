import * as THREE from 'three';

/**
 * The Datastream's building blocks: an infinite neon grid, a sky with copper
 * bars and a sine scroller, branching light rails, wireframe gates, speed
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
    uScroller: { value: null as THREE.Texture | null },
    uScroll: { value: 0 },
    uRipple: { value: -1 },
  };
}
export type Shared = ReturnType<typeof makeShared>;

const COMMON = /* glsl */ `
  uniform float uTime, uFlow, uTravel, uSpeed, uBeat, uBeatPhase, uEnergy, uVigil;
  uniform vec3 uAccent, uHot;
  float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  vec3 neon(vec3 c) { float l = dot(c, vec3(0.299, 0.587, 0.114)); return max(vec3(0.0), mix(vec3(l), c, 2.2)); }
`;

// ---------------------------------------------------------------------------
// Floor: an endless grid in the travel frame, with a ring that races out on each beat.

export function makeFloor(s: Shared) {
  const geo = new THREE.PlaneGeometry(1600, 1600, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uGridYaw: s.uGridYaw, uGridOff: s.uGridOff, uTime: s.uTime, uFlow: s.uFlow, uTravel: s.uTravel, uSpeed: s.uSpeed, uBeat: s.uBeat, uBeatPhase: s.uBeatPhase, uEnergy: s.uEnergy, uVigil: s.uVigil, uAccent: s.uAccent, uHot: s.uHot, uRipple: s.uRipple },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform float uGridYaw, uRipple;
      uniform vec2 uGridOff;
      varying vec3 vWorld;
      float grid(vec2 p, float cell, float width) {
        vec2 g = p / cell;
        vec2 d = abs(fract(g - 0.5) - 0.5) / fwidth(g);
        return 1.0 - min(min(d.x, d.y) / width, 1.0);
      }
      void main() {
        float c = cos(uGridYaw), s = sin(uGridYaw);
        vec2 p = vec2(vWorld.x * c + vWorld.z * s, -vWorld.x * s + vWorld.z * c) + uGridOff;
        vec3 rel = vWorld - cameraPosition;
        float dist = length(rel.xz);
        float minor = grid(p, 2.0, 1.0) * 0.1;
        float major = grid(p, 8.0, 1.4);
        float lines = max(minor, major);
        // Lines thin into the distance instead of shimmering.
        float fade = exp(-dist * 0.009);
        vec3 accent = neon(uAccent);
        vec3 col = vec3(0.012, 0.004, 0.03);
        col += accent * lines * fade * (0.4 + 0.45 * uEnergy) * (1.0 - 0.55 * uVigil);
        // The beat ring: races out from the camera on every beat.
        float ring = exp(-abs(dist - uBeatPhase * 140.0) * 0.18) * uBeat * fade;
        col += mix(accent, vec3(1.0), 0.4) * ring * (0.35 + lines) * (1.0 - uVigil);
        // A drop's shock wave.
        if (uRipple >= 0.0) col += vec3(1.0) * exp(-abs(dist - uRipple * 260.0) * 0.08) * (1.0 - uRipple) * 1.6;
        // Horizon glow.
        col += accent * 0.05 * (1.0 - fade) * (1.0 - 0.5 * uVigil);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Sky: black to violet, stars, the horizon glow, four copper bars (the decks) and the scroller.

export function makeSky(s: Shared) {
  const geo = new THREE.SphereGeometry(500, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: { uTime: s.uTime, uFlow: s.uFlow, uTravel: s.uTravel, uSpeed: s.uSpeed, uBeat: s.uBeat, uBeatPhase: s.uBeatPhase, uEnergy: s.uEnergy, uVigil: s.uVigil, uAccent: s.uAccent, uHot: s.uHot, uDeckColor: s.uDeckColor, uDeckLevel: s.uDeckLevel, uDeckPhase: s.uDeckPhase, uScroller: s.uScroller, uScroll: s.uScroll },
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
      uniform sampler2D uScroller;
      uniform float uScroll;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float el = d.y;
        float az = atan(d.x, -d.z);
        vec3 accent = neon(uAccent);
        float dim = 1.0 - 0.5 * uVigil;
        vec3 col = mix(vec3(0.05, 0.0, 0.09), vec3(0.0, 0.0, 0.012), smoothstep(-0.02, 0.45, el));
        col += accent * exp(-abs(el) * 30.0) * 0.3 * dim;
        // Stars, smeared sideways a little at speed.
        vec2 sp = vec2(az * 60.0, el * 60.0);
        vec2 cell = floor(sp);
        float h = hash21(cell);
        vec2 f = fract(sp) - vec2(hash21(cell + 7.1), hash21(cell + 3.7));
        float star = step(0.93, h) * exp(-dot(f, f) * 90.0) * (0.5 + 0.5 * sin(uTime * (2.0 + h * 5.0) + h * 40.0));
        col += vec3(0.8, 0.85, 1.0) * star * smoothstep(0.03, 0.2, el);
        // Copper bars: one per deck, bouncing on the deck's own beat, lit by its level.
        for (int i = 0; i < 4; i++) {
          vec3 dc = neon(vec3(uDeckColor[i * 3], uDeckColor[i * 3 + 1], uDeckColor[i * 3 + 2]));
          float centre = 0.035 + float(i) * 0.026 + 0.01 * abs(sin(3.14159 * uDeckPhase[i]));
          float t = abs(el - centre) / 0.008;
          float bar = max(0.0, 1.0 - t);
          vec3 copper = mix(dc * 0.5, dc + 0.35, pow(bar, 3.0));
          col += copper * bar * bar * uDeckLevel[i] * 0.55 * dim;
        }
        // The sine scroller, chrome on the sky.
        float y = (el - 0.142) / 0.017 + sin(az * 7.0 + uTime * 2.6) * 0.3;
        if (abs(y) < 1.0 && abs(az) < 1.4) {
          vec4 tx = texture2D(uScroller, vec2(fract(az / 1.25 + uScroll), 0.5 + y * 0.5));
          float edge = smoothstep(1.4, 1.0, abs(az));
          col = mix(col, tx.rgb * (0.85 + 0.4 * uBeat), tx.a * 0.8 * edge * dim);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

/** The scroller's strip: chrome text, repeated to fill, redrawn when the place changes. */
export function scrollerTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 4096;
  canvas.height = 128;
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  const draw = (text: string, accent: string) => {
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.font = 'italic 900 92px "JetBrains Mono", "Arial Black", Impact, sans-serif';
    g.textBaseline = 'middle';
    const unit = `${text.toUpperCase()}   ✦   `;
    // Squeeze or stretch slightly so a whole number of repeats fills the strip: no seam where it wraps.
    const natural = Math.max(1, g.measureText(unit).width);
    const reps = Math.max(1, Math.round(canvas.width / natural));
    const w = canvas.width / reps;
    g.setTransform(w / natural, 0, 0, 1, 0, 0);
    const grad = g.createLinearGradient(0, 18, 0, 110);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.45, '#d8e4ff');
    grad.addColorStop(0.5, accent);
    grad.addColorStop(0.8, '#20103a');
    grad.addColorStop(1, '#ffffff');
    g.lineWidth = 5;
    g.strokeStyle = '#000000';
    g.fillStyle = grad;
    for (let r = 0; r < reps; r++) {
      g.strokeText(unit, r * natural, 66);
      g.fillText(unit, r * natural, 66);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    tex.needsUpdate = true;
  };
  return { tex, draw };
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
        float packet = pow(0.5 + 0.5 * sin(dist * 0.55 - uFlow * 0.55), 14.0);
        float front = exp(-abs(u - head) * 22.0) * step(u, head + 0.02);
        vec3 col = accent * (core + halo) * (0.22 + 0.9 * lit);
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
    uniforms: { ...pick(s), uAlpha: alpha, uLit: { value: 0 }, uSim: { value: 0.5 }, uWidth: { value: 1.4 } },
    vertexShader: WIRE_VERT,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform float uAlpha, uLit, uSim, uWidth;
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
        vec3 col = c * (wire * (0.6 + 0.9 * uLit) + glow * (0.18 + 0.35 * uLit));
        col += accent * rim * (0.04 + 0.12 * uLit);
        col *= (0.55 + 0.45 * uSim) * (1.0 + 0.6 * uBeat * uLit) * (1.0 - 0.5 * uVigil);
        col *= uAlpha * exp(-vDepth * 0.006);
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
    uniforms: { ...pick(s), uAlpha: alpha, uLit: { value: 0 } },
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
      uniform float uAlpha, uLit;
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
      uniform float uAlpha, uLit;
      varying vec2 vUv;
      varying float vDepth;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float dash = step(0.5, fract(vUv.x * 24.0 + uTime * (0.4 + uLit * 1.5)));
        vec3 col = neon(uAccent) * (0.18 + 0.9 * uLit) * (0.6 + 0.4 * dash);
        gl_FragColor = vec4(col * uAlpha * exp(-vDepth * 0.006) * (1.0 - 0.5 * uVigil), 1.0);
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
      uniform float uTravel, uSpeed;
      attribute float aEnd;
      varying float vA;
      void main() {
        vec3 p = position;
        p.z = mod(p.z + uTravel, 230.0) - 215.0;
        p.z -= aEnd * clamp(uSpeed * 0.06, 0.05, 14.0);
        vA = (1.0 - aEnd * 0.9) * smoothstep(-215.0, -150.0, p.z) * smoothstep(15.0, 2.0, p.z);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying float vA;
      void main() {
        float k = clamp(uSpeed / 40.0, 0.0, 1.0);
        gl_FragColor = vec4(mix(neon(uAccent), vec3(1.0), 0.6) * vA * (0.15 + 0.85 * k) * (1.0 - uVigil), 1.0);
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
      uniform vec2 uRes, uVanish;
      uniform float uTime, uAberr, uFlash, uCut, uMist, uBloom, uBeamY;
      uniform float uBeamX[4];
      uniform float uBeamLevel[4];
      uniform float uBeamSway[4];
      uniform float uDeckColor[12];
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      vec3 neon(vec3 c) { float l = dot(c, vec3(0.299, 0.587, 0.114)); return max(vec3(0.0), mix(vec3(l), c, 2.2)); }
      vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
      void main() {
        vec2 uv = vUv;
        // A cut: the frame tears into horizontal slices for an instant.
        if (uCut > 0.0) {
          float band = floor(uv.y * 24.0 + floor(uTime * 40.0));
          float r = hash(vec2(band, floor(uTime * 30.0)));
          uv.x += (r - 0.5) * 0.12 * uCut * step(0.55, r);
        }
        vec2 dir = uv - 0.5;
        float ab = uAberr * dot(dir, dir) * 0.06 + uAberr * 0.0015;
        vec3 col;
        col.r = texture2D(tScene, uv + dir * ab).r;
        col.g = texture2D(tScene, uv).g;
        col.b = texture2D(tScene, uv - dir * ab).b;
        col += (texture2D(tBloom, uv).rgb * 0.7 + texture2D(tWide, uv).rgb * 0.5) * uBloom;
        // Deck lasers: from each deck card toward the vanishing point, swaying on its beat.
        vec2 px = uv * uRes;
        for (int i = 0; i < 4; i++) {
          if (uBeamLevel[i] <= 0.001) continue;
          vec2 a = vec2(uBeamX[i], uBeamY) * uRes;
          vec2 b = (uVanish + vec2(uBeamSway[i], 0.0)) * uRes;
          vec2 ab2 = b - a;
          float t = clamp(dot(px - a, ab2) / dot(ab2, ab2), 0.0, 1.0);
          float d = length(px - (a + ab2 * t));
          float w = mix(3.5, 0.6, t);
          vec3 dc = neon(vec3(uDeckColor[i * 3], uDeckColor[i * 3 + 1], uDeckColor[i * 3 + 2]));
          col += mix(dc, vec3(1.0), 0.2) * (exp(-d * d / (w * w)) + exp(-d / (w * 6.0)) * 0.08) * uBeamLevel[i] * (1.0 - t * 0.8);
        }
        // Scouting: the signal is weak beyond the last claimed track.
        if (uMist > 0.0) {
          float l = dot(col, vec3(0.299, 0.587, 0.114));
          col = mix(col, vec3(l) * vec3(0.75, 0.9, 1.0), 0.6 * uMist);
          col += (hash(px + fract(uTime) * 100.0) - 0.5) * 0.04 * uMist;
        }
        col += vec3(uFlash);
        col = aces(col * 1.1);
        // Scanlines and vignette.
        col *= 0.9 + 0.1 * sin(px.y * 3.14159 * 0.5);
        col *= 1.0 - 0.55 * pow(length(dir * vec2(1.0, 0.8)) * 1.25, 3.0);
        col = pow(max(col, 0.0), vec3(1.0 / 2.2));
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
