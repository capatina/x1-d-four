import * as THREE from 'three';

/** Shared, mutable uniforms: every blade, tree and bank grows from the same ground. */
export function makeShared() {
  return {
    uTime: { value: 0 },
    uWind: { value: 0 },
    uGrowth: { value: 0 },
    uDay: { value: 0 },
    uPlace: { value: 0 },
    uBand: { value: 0 },
    uLife: { value: 0 },
    uMotion: { value: 1 },
    uSpectrum: { value: new Float32Array(64) },
    uDecks: { value: new THREE.Vector4() },
  };
}
export type Shared = ReturnType<typeof makeShared>;

const common = /* glsl */ `
  uniform float uTime, uWind, uGrowth, uDay, uPlace, uBand, uLife, uMotion;
  uniform float uSpectrum[64];
  uniform vec4 uDecks;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float noise(vec2 p) {
    vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);
  }
  float river(float z) { return sin(z*.037+uPlace*.11)*7. + sin(z*.016-uPlace*.06)*9.; }
  float widthAt(float z) { return 3.6+13.*smoothstep(-45.,32.,z); }
  float ground(vec2 p) {
    float d=abs(p.x-river(p.y));
    vec2 q=p*.025+vec2(uPlace*.17, uPlace*.08);
    float n=noise(q)*.65+noise(q*2.07)*.25+noise(q*4.1)*.1;
    float banks=smoothstep(widthAt(p.y)-1.,widthAt(p.y)+8.,d);
    float hills=smoothstep(14.,95.,d)*18.;
    return -.48+banks*(.65+n*3.2)+n*hills;
  }
  vec3 haze() { return mix(vec3(.70,.75,.67),vec3(.76,.59,.41),uDay); }
  vec3 earth(vec3 color, vec3 p) {
    float fog=1.-exp(-max(0.,length(p-cameraPosition)-22.)*.007);
    return mix(color*(1.-uDay*.18), haze(),fog);
  }
`;

function material(s: Shared, vertexShader: string, fragmentShader: string, extra: THREE.ShaderMaterialParameters = {}) {
  return new THREE.ShaderMaterial({
    uniforms: s,
    vertexShader: common + vertexShader,
    fragmentShader: common + fragmentShader,
    ...extra,
  });
}

/** One seeded random stream at construction; animation never creates geometry. */
export function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeSky(s: Shared) {
  return new THREE.Mesh(
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
      vec3 d=normalize(vDir);
      float y=max(0.,d.y);
      vec3 zenith=mix(vec3(.24,.43,.51),vec3(.34,.37,.43),uDay);
      vec3 col=mix(haze(),zenith,pow(y,.55));
      vec3 sun=normalize(vec3(-.48,.32-uDay*.12,-.84));
      float sd=distance(d,sun);
      col+=vec3(.21,.16,.075)*exp(-sd*sd*16.);
      col=mix(col,vec3(1.,.91,.66),1.-smoothstep(.018,.023,sd));
      vec2 cp=d.xz/max(.12,d.y)*2.2+vec2(uTime*.002*uMotion,0.);
      float clouds=noise(cp)*.65+noise(cp*2.8)*.35;
      float cover=smoothstep(.52,.78,clouds)*smoothstep(.03,.25,y)*.38;
      col=mix(col,vec3(.89,.87,.75),cover);
      gl_FragColor=vec4(col,1.);
    }
  `,
      { side: THREE.BackSide, depthWrite: false },
    ),
  );
}

export function makeLand(s: Shared) {
  const geo = new THREE.PlaneGeometry(560, 430, 180, 150);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -155);
  return new THREE.Mesh(
    geo,
    material(
      s,
      /* glsl */ `
    varying vec3 vP, vN;
    void main() {
      vec3 p=position; p.y=ground(p.xz);
      float dx=ground(p.xz+vec2(.4,0))-p.y;
      float dz=ground(p.xz+vec2(0,.4))-p.y;
      vN=normalize(vec3(-dx,.4,-dz)); vP=p;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
    }
  `,
      /* glsl */ `
    varying vec3 vP, vN;
    void main() {
      float n=noise(vP.xz*.9)*.3+noise(vP.xz*.14)*.7;
      vec3 dry=mix(vec3(.22,.255,.115),vec3(.48,.43,.22),n);
      vec3 grove=mix(vec3(.12,.23,.135),vec3(.37,.43,.21),n);
      vec3 wet=mix(vec3(.19,.28,.24),vec3(.43,.47,.31),n);
      vec3 c=mix(mix(dry,grove,clamp(uBand,0.,1.)),wet,max(0.,uBand-1.));
      float shore=1.-smoothstep(widthAt(vP.z),widthAt(vP.z)+2.,abs(vP.x-river(vP.z)));
      c=mix(c,vec3(.38,.35,.24),shore*.6);
      float light=.60+.40*max(0.,dot(vN,normalize(vec3(-.6,.7,.3))));
      gl_FragColor=vec4(earth(c*light,vP),1.);
    }
  `,
    ),
  );
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
    void main() { vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }
  `,
      /* glsl */ `
    varying vec3 vP;
    void main() {
      float t=uTime*uMotion;
      float ripple=sin(vP.z*3.+sin(vP.x*1.7+t*.3)*1.4-t*.7)*.5+.5;
      float fine=sin(vP.z*14.+sin(vP.x*2.1+t)*2.)*.5+.5;
      vec3 c=mix(vec3(.14,.25,.24),haze()*.77,.3+ripple*.08);
      float sun=exp(-pow((vP.x+12.)/(8.+max(0.,-vP.z)*.1),2.));
      c+=vec3(.28,.21,.1)*pow(ripple*fine,5.)*sun;
      gl_FragColor=vec4(earth(c,vP),1.);
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
  const offset = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    offset[i * 4] = (r() - 0.5) * 150;
    offset[i * 4 + 1] = 30 - r() * 160;
    offset[i * 4 + 2] = 0.35 + r() * 0.85;
    offset[i * 4 + 3] = r() * Math.PI * 2;
  }
  geo.setAttribute('aBlade', new THREE.InstancedBufferAttribute(offset, 4));
  geo.instanceCount = count;
  const mesh = new THREE.Mesh(
    geo,
    material(
      s,
      /* glsl */ `
    attribute vec4 aBlade;
    varying vec3 vP;
    varying float vY, vSeed;
    void main() {
      vec3 p=position;
      float dist=abs(aBlade.x-river(aBlade.y));
      float land=smoothstep(widthAt(aBlade.y)+.5,widthAt(aBlade.y)+2.8,dist);
      float growth=.45+uGrowth*.75;
      int bin=int(mod(aBlade.w*10.,64.));
      float wind=sin(aBlade.x*.13+aBlade.y*.18+uTime*1.4)*.5+sin(aBlade.y*.4+uTime*2.)*.2;
      float sway=wind*(.13+uWind*.55+uSpectrum[bin]*.10+uDecks[int(mod(aBlade.w,4.))]*.12)*uMotion;
      p.x=position.x*cos(aBlade.w)+sway*position.y*position.y;
      p.z=position.x*sin(aBlade.w)+sway*.3*position.y;
      p.y*=aBlade.z*growth*land;
      p+=vec3(aBlade.x,ground(aBlade.xy),aBlade.y);
      vP=p; vY=position.y; vSeed=fract(aBlade.w*5.);
      gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
    }
  `,
      /* glsl */ `
    varying vec3 vP;
    varying float vY, vSeed;
    void main() {
      vec3 base=mix(vec3(.19,.26,.105),vec3(.45,.43,.19),vSeed);
      base=mix(base,base*vec3(.7,1.04,.85),clamp(uBand,0.,1.));
      base=mix(base,vec3(.34,.43,.28),max(0.,uBand-1.)*.5);
      vec3 tip=mix(vec3(.65,.59,.32),vec3(.56,.63,.38),clamp(uBand,0.,1.));
      gl_FragColor=vec4(earth(mix(base*.65,tip,vY*.7),vP),1.);
    }
  `,
      { side: THREE.DoubleSide },
    ),
  );
  mesh.frustumCulled = false;
  return mesh;
}

/** Small overlapping leaf sprays make porous, irregular crowns instead of solid blobs. */
export function makeTrees(s: Shared) {
  const r = random(711);
  const trunks: number[] = [];
  const leaves: number[] = [];
  for (let i = 0; i < 105; i++) {
    const z = 10 - r() * 235,
      x = (i % 2 ? 1 : -1) * (18 + r() * 95),
      h = 3 + r() * 6;
    trunks.push(x, z, h, r());
    for (let j = 0; j < 180; j++) {
      const angle = r() * Math.PI * 2,
        vertical = r() * 2 - 1,
        radius = Math.cbrt(r());
      const spread = Math.sqrt(1 - vertical * vertical) * radius;
      leaves.push(
        x + Math.cos(angle) * spread * h * 0.43,
        z + Math.sin(angle) * spread * h * 0.35,
        h * (0.78 + vertical * radius * 0.36),
        0.25 + r() * 0.5,
      );
    }
  }
  function mesh(base: THREE.BufferGeometry, values: number[], leaf: boolean) {
    const geo = new THREE.InstancedBufferGeometry().copy(base as THREE.InstancedBufferGeometry);
    base.dispose();
    geo.setAttribute('aTree', new THREE.InstancedBufferAttribute(new Float32Array(values), 4));
    geo.instanceCount = values.length / 4;
    const m = new THREE.Mesh(
      geo,
      material(
        s,
        /* glsl */ `
      attribute vec4 aTree;
      varying vec3 vP, vN;
      varying float vSeed;
      varying vec2 vUv;
      void main() {
        vec3 p=position; vUv=uv;
        float growth=.85+uGrowth*.18;
        vSeed=hash(aTree.xy);
        ${
          leaf
            ? `
          p*=aTree.w*growth;
          p.xz=mat2(cos(vSeed*6.28),-sin(vSeed*6.28),sin(vSeed*6.28),cos(vSeed*6.28))*p.xz;
          p.y+=aTree.z*growth;
        `
            : 'p.xz*=.10+aTree.z*.018; p.y=(p.y+.5)*aTree.z*growth;'
        }
        p.x+=sin(uTime*.65+aTree.x)*.09*position.y*uWind*uMotion;
        p+=vec3(aTree.x,ground(aTree.xy),aTree.y);
        vP=p; vN=normal;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
      }
    `,
        /* glsl */ `
      varying vec3 vP, vN;
      varying float vSeed;
      varying vec2 vUv;
      void main() {
        ${
          leaf
            ? `
          vec2 uv=vUv*2.-1.;
          if(dot(uv,uv)>.82+noise(uv*9.)*.18) discard;
          vec3 c=mix(vec3(.13,.22,.11),vec3(.41,.44,.22),vSeed);
          c=mix(c,c*vec3(.76,1.04,.87),clamp(uBand,0.,1.));
          c=mix(c,vec3(.33,.41,.31),max(0.,uBand-1.)*.35);
          c*=.75+.25*noise(vP.xz*3.);
        `
            : 'vec3 c=vec3(.24,.20,.14);'
        }
        float light=.74+.26*max(0.,dot(vN,normalize(vec3(-.5,.8,.3))));
        gl_FragColor=vec4(earth(c*light,vP),1.);
      }
    `,
        { side: leaf ? THREE.DoubleSide : THREE.FrontSide },
      ),
    );
    m.frustumCulled = false;
    return m;
  }
  return [
    mesh(new THREE.CylinderGeometry(0.7, 1.3, 1, 7), trunks, false),
    mesh(new THREE.PlaneGeometry(2, 1.8), leaves, true),
  ];
}

/** Swallows and small meadow butterflies: articulated triangles, one draw per species. */
export function makeLife(s: Shared, butterfly: boolean) {
  const r = random(butterfly ? 82 : 29);
  const n = butterfly ? 65 : 24;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [0, 0, 0.25, -0.9, 0, -0.1, -0.35, 0, 0.25, 0, 0, 0.25, 0.35, 0, 0.25, 0.9, 0, -0.1],
      3,
    ),
  );
  const a = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    a[i * 4] = (r() - 0.5) * 95;
    a[i * 4 + 1] = -r() * 110;
    a[i * 4 + 2] = r();
    a[i * 4 + 3] = i / n;
  }
  geo.setAttribute('aLife', new THREE.InstancedBufferAttribute(a, 4));
  geo.instanceCount = n;
  const m = new THREE.Mesh(
    geo,
    material(
      s,
      /* glsl */ `
    attribute vec4 aLife;
    varying vec3 vP;
    varying float vSeed;
    void main() {
      float t=uTime*uMotion;
      float visible=smoothstep(aLife.w,aLife.w+.16,uLife);
      vec3 p=position*${butterfly ? '.15' : '.48'}*visible;
      p.y+=sin(t*${butterfly ? '14.' : '5.'}+aLife.z*40.)*abs(p.x)*.7;
      float angle=t*${butterfly ? '.18' : '.05'}+aLife.z*6.28;
      p.xz=mat2(cos(angle),-sin(angle),sin(angle),cos(angle))*p.xz;
      p.x+=aLife.x+sin(angle)*${butterfly ? '2.' : '14.'};
      p.z+=aLife.y+cos(angle)*${butterfly ? '2.' : '10.'};
      p.y+=${butterfly ? 'ground(p.xz)+1.5+sin(t*.7+aLife.z*9.)*.5' : '12.+aLife.z*14.+sin(angle)*2.'};
      vP=p; vSeed=aLife.z;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
    }
  `,
      /* glsl */ `
    varying vec3 vP; varying float vSeed;
    void main() { gl_FragColor=vec4(earth(${butterfly ? 'mix(vec3(.81,.62,.3),vec3(.91,.84,.61),vSeed)' : 'vec3(.12,.16,.14)'},vP),1.); }
  `,
      { side: THREE.DoubleSide },
    ),
  );
  m.frustumCulled = false;
  return m;
}

/** The tree's edges are pale worn paths, its nodes river-stone cairns. */
export function makePlaces(s: Shared, capacity: number) {
  const stones = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 1),
    material(
      s,
      /* glsl */ `
    varying vec3 vP, vN;
    void main() {
      vec3 p=(instanceMatrix*vec4(position,1.)).xyz;
      p.y+=ground(p.xz)+.12; vP=p; vN=normal;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
    }
  `,
      /* glsl */ `
    varying vec3 vP,vN;
    void main() {
      vec3 c=vec3(.56,.52,.38)*(.72+.28*max(0.,dot(vN,normalize(vec3(-.5,.8,.3)))));
      gl_FragColor=vec4(earth(c,vP),1.);
    }
  `,
    ),
    capacity * 3,
  );
  stones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  stones.frustumCulled = false;
  stones.count = 0;
  const pathGeo = new THREE.BufferGeometry();
  const positions = new Float32Array(capacity * 24 * 6 * 3);
  const strengths = new Float32Array(capacity * 24 * 6);
  pathGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  pathGeo.setAttribute('aStrength', new THREE.BufferAttribute(strengths, 1).setUsage(THREE.DynamicDrawUsage));
  const paths = new THREE.Mesh(
    pathGeo,
    material(
      s,
      /* glsl */ `
    attribute float aStrength; varying vec3 vP; varying float vStrength;
    void main() {
      vec3 p=position; p.y=ground(p.xz)+.035; vP=p; vStrength=aStrength;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
    }
  `,
      /* glsl */ `
    varying vec3 vP; varying float vStrength;
    void main() {
      float n=noise(vP.xz*3.);
      vec3 c=mix(vec3(.36,.36,.23),vec3(.73,.64,.39),vStrength)*(.85+n*.15);
      gl_FragColor=vec4(earth(c,vP),1.);
    }
  `,
      { side: THREE.DoubleSide },
    ),
  );
  paths.frustumCulled = false;
  pathGeo.setDrawRange(0, 0);
  return { stones, paths, positions, strengths };
}

// CPU counterpart only used for label placement (a handful of points, at 20 Hz).
function fract(v: number) {
  return v - Math.floor(v);
}
function groundHash(a: number, b: number) {
  return fract(Math.sin(a * 127.1 + b * 311.7) * 43758.5453);
}
function groundNoise(a: number, b: number) {
  const i = Math.floor(a),
    j = Math.floor(b);
  let f = fract(a),
    g = fract(b);
  f = f * f * (3 - 2 * f);
  g = g * g * (3 - 2 * g);
  return (
    (groundHash(i, j) * (1 - f) + groundHash(i + 1, j) * f) * (1 - g) +
    (groundHash(i, j + 1) * (1 - f) + groundHash(i + 1, j + 1) * f) * g
  );
}
function smooth(a: number, b: number, v: number) {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
export function groundHeight(x: number, z: number, place: number) {
  const river = Math.sin(z * 0.037 + place * 0.11) * 7 + Math.sin(z * 0.016 - place * 0.06) * 9;
  const d = Math.abs(x - river),
    w = 3.6 + 13 * smooth(-45, 32, z);
  const qx = x * 0.025 + place * 0.17,
    qz = z * 0.025 + place * 0.08;
  const n =
    groundNoise(qx, qz) * 0.65 + groundNoise(qx * 2.07, qz * 2.07) * 0.25 + groundNoise(qx * 4.1, qz * 4.1) * 0.1;
  return -0.48 + smooth(w - 1, w + 8, d) * (0.65 + n * 3.2) + n * smooth(14, 95, d) * 18;
}
