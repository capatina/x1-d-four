/**
 * The tunnel's centreline. The camera sits at the origin looking down -Z and
 * the world scrolls past it; the tube snakes gently by offsetting x/y with a
 * sum of sines along the travelled distance. Offsets are relative to the
 * camera (zero offset and zero slope at d = 0), so the near tunnel always
 * points straight ahead while the far end curves away.
 *
 * The same function runs in GLSL (BEND_GLSL) for the walls, sparks and bars,
 * and in JS for portals and trails, so everything stays inside the tube.
 */

// Four terms: two on x, two on y. Amplitude (world units), angular frequency (1/unit), phase.
const A = [5.2, 2.2, 3.4, 1.5] as const;
const W = [0.0105, 0.027, 0.0145, 0.034] as const;
const P = [0, 1.3, 2.1, 0.4] as const;

export class Bend {
  /** sin(w·s + p) and cos(w·s + p) per term, for the current travel s. */
  readonly S = new Float32Array(4);
  readonly C = new Float32Array(4);
  /** Overall strength (lower with reduced motion). */
  amount = 1;

  update(travel: number): void {
    for (let i = 0; i < 4; i++) {
      // Doubles here, so large travel values don't lose precision on the GPU.
      const arg = W[i] * travel + P[i];
      this.S[i] = Math.sin(arg);
      this.C[i] = Math.cos(arg);
    }
  }

  /** Offset of the centreline `d` units ahead of the camera. */
  at(d: number): [number, number] {
    let x = 0;
    let y = 0;
    for (let i = 0; i < 4; i++) {
      const wd = W[i] * d;
      const v = A[i] * (this.S[i] * Math.cos(wd) + this.C[i] * Math.sin(wd) - this.S[i] - W[i] * this.C[i] * d);
      if (i < 2) x += v;
      else y += v;
    }
    return [x * this.amount, y * this.amount];
  }
}

const vec4 = (v: readonly number[]) => `vec4(${v.map((n) => n.toFixed(5)).join(', ')})`;

export const BEND_GLSL = /* glsl */ `
uniform vec4 uBendS;
uniform vec4 uBendC;
uniform float uBendAmt;
vec2 bend(float d) {
  const vec4 A = ${vec4(A)};
  const vec4 W = ${vec4(W)};
  vec4 wd = W * d;
  vec4 v = A * (uBendS * cos(wd) + uBendC * sin(wd) - uBendS - W * uBendC * d);
  return vec2(v.x + v.y, v.z + v.w) * uBendAmt;
}
`;
