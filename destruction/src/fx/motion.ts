/**
 * Closed-form particle motion shared by the CPU (landing-time solver, tests) and the GPU (the
 * particle vertex shaders evaluate the same expressions, see MOTION_GLSL), so particles need no
 * per-frame simulation or buffer uploads: they are written once when spawned.
 *
 * Model: linear (Stokes-regime) drag towards the local wind plus constant body force,
 *     dv/dt = −k (v − w) + g,
 * whose solution is v(t) = w + (v0 − w) e^(−kt) + g A(t), x(t) = x0 + w t + (v0 − w) A(t) + g B(t),
 * with A = (1 − e^(−kt)) / k and B = (kt − 1 + e^(−kt)) / k². Small particles and smoke puffs
 * relax to the air velocity on the time scale 1/k (Stokes relaxation time τ = ρ_p d² / 18 μ for
 * grit; for puffs, an effective entrainment rate). Buoyant gas uses a negative gravity scale.
 */

export const GRAVITY = 9.80665;

/** A(t) = ∫0^t e^(−ks) ds, with a series near kt → 0 (exact limit t). */
export function driftA(k: number, t: number): number {
  const kt = k * t;
  if (kt < 1e-3) return t * (1 - 0.5 * kt + (kt * kt) / 6);
  return (1 - Math.exp(-kt)) / k;
}

/** B(t) = ∫0^t A(s) ds, with a series near kt → 0 (exact limit t²/2). */
export function driftB(k: number, t: number): number {
  const kt = k * t;
  if (kt < 1e-3) return 0.5 * t * t * (1 - kt / 3 + (kt * kt) / 12);
  return (kt - 1 + Math.exp(-kt)) / (k * k);
}

export interface MotionState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
}

/**
 * Evaluate position and velocity at time t for initial state p0/v0, drag k (1/s), gravity scale
 * gs (1 = falls at g, negative = rises) and wind w.
 */
export function motionAt(
  p0x: number, p0y: number, p0z: number, v0x: number, v0y: number, v0z: number,
  k: number, gs: number, wx: number, wy: number, wz: number, t: number, out: MotionState,
): MotionState {
  const A = driftA(k, t);
  const B = driftB(k, t);
  const e = Math.exp(-k * t);
  const gy = -GRAVITY * gs;
  out.x = p0x + wx * t + (v0x - wx) * A;
  out.y = p0y + wy * t + (v0y - wy) * A + gy * B;
  out.z = p0z + wz * t + (v0z - wz) * A;
  out.vx = wx + (v0x - wx) * e;
  out.vy = wy + (v0y - wy) * e + gy * A;
  out.vz = wz + (v0z - wz) * e;
  return out;
}

const _m: MotionState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };

/**
 * First time the particle comes down through height `floor` (while descending), or −1 if it does
 * not within `maxT`. Coarse march then bisection; the height is monotone once falling.
 */
export function landingTime(
  p0y: number, v0y: number, k: number, gs: number, wy: number, floor: number, maxT: number,
): number {
  if (gs <= 0) return -1;
  if (p0y <= floor && v0y <= 0) return 0;
  const steps = 48;
  let prevT = 0;
  let prevY = p0y - floor;
  for (let i = 1; i <= steps; i++) {
    const t = (maxT * i) / steps;
    const yt = heightAbove(p0y, v0y, k, gs, wy, floor, t);
    if (yt <= 0 && prevY > 0) {
      let lo = prevT, hi = t;
      for (let j = 0; j < 30; j++) {
        const mid = 0.5 * (lo + hi);
        if (heightAbove(p0y, v0y, k, gs, wy, floor, mid) > 0) lo = mid;
        else hi = mid;
      }
      return 0.5 * (lo + hi);
    }
    prevT = t;
    prevY = yt;
  }
  return -1;
}

function heightAbove(p0y: number, v0y: number, k: number, gs: number, wy: number, floor: number, t: number): number {
  return motionAt(0, p0y, 0, 0, v0y, 0, k, gs, 0, wy, 0, t, _m).y - floor;
}

/** GLSL twin of motionAt (+ a single damped bounce on the floor after tLand). */
export const MOTION_GLSL = /* glsl */ `
const float GRAV = 9.80665;
float driftA(float k, float t) { float kt = k * t; return kt < 1e-3 ? t * (1.0 - 0.5 * kt) : (1.0 - exp(-kt)) / k; }
float driftB(float k, float t) { float kt = k * t; return kt < 1e-3 ? 0.5 * t * t * (1.0 - kt / 3.0) : (kt - 1.0 + exp(-kt)) / (k * k); }
vec3 motion(vec3 p0, vec3 v0, float k, float gs, vec3 w, float t, out vec3 vel) {
  float A = driftA(k, t);
  float B = driftB(k, t);
  float e = exp(-k * t);
  vec3 g = vec3(0.0, -GRAV * gs, 0.0);
  vel = w + (v0 - w) * e + g * A;
  return p0 + w * t + (v0 - w) * A + g * B;
}
/** Motion with one inelastic bounce (restitution 0.3 normal, 0.35 tangential) and then rest. */
vec3 motionBounce(vec3 p0, vec3 v0, float k, float gs, vec3 w, float t, float floorY, float tLand, out vec3 vel, out float rest) {
  rest = 0.0;
  if (tLand < 0.0 || t <= tLand) return motion(p0, v0, k, gs, w, t, vel);
  vec3 vL;
  vec3 pL = motion(p0, v0, k, gs, w, tLand, vL);
  vec3 vb = vec3(vL.x * 0.35, abs(vL.y) * 0.3, vL.z * 0.35);
  float tStop = 2.0 * vb.y / GRAV;
  float tb = min(t - tLand, tStop);
  vec3 p = pL + vb * tb + vec3(0.0, -0.5 * GRAV * tb * tb, 0.0);
  p.y = max(p.y, floorY);
  vel = t - tLand < tStop ? vb + vec3(0.0, -GRAV * tb, 0.0) : vec3(0.0);
  rest = t - tLand < tStop ? 0.0 : 1.0;
  return p;
}
`;
