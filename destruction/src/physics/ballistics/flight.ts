import * as THREE from 'three';
import { AIR_DENSITY, G, SPEED_OF_SOUND } from '../../core/units.ts';
import type { AmmoSpec } from './types.ts';

/**
 * Exterior ballistics at game level: point-mass trajectories with gravity, Mach-dependent quadratic
 * drag and a simple rocket-motor boost (thrust with ignition delay and mass loss). There is no
 * guidance law anywhere: the top-attack launcher flies a scripted, purely cosmetic loft arc
 * (`LoftPath`) from the launch point to the aimed point.
 *
 * The integrator is a split scheme: thrust and gravity are applied explicitly, then the
 * quadratic drag is applied with the exact 1-D solution v' = v / (1 + k v dt), which can never
 * reverse or overshoot the velocity. It is therefore unconditionally stable for any dt, including
 * the 1–2 ms steps used in slow motion, and exact for pure drag.
 */

/**
 * Standard G7 drag function Cd(Mach) (boat-tail spitzer; McCoy, "Modern Exterior Ballistics",
 * 1999, tabulated by the US Army BRL). Used as the *shape* of each round's drag curve.
 */
const G7: readonly [number, number][] = [
  [0.0, 0.1198], [0.5, 0.1197], [0.7, 0.1196], [0.8, 0.1194], [0.85, 0.1194], [0.9, 0.1210],
  [0.925, 0.1250], [0.95, 0.1395], [0.975, 0.1945], [1.0, 0.3803], [1.025, 0.4043], [1.05, 0.4094],
  [1.075, 0.4108], [1.1, 0.4100], [1.15, 0.4048], [1.2, 0.3955], [1.3, 0.3783], [1.4, 0.3630],
  [1.5, 0.3491], [1.75, 0.3196], [2.0, 0.2980], [2.25, 0.2812], [2.5, 0.2672], [2.75, 0.2551],
  [3.0, 0.2447], [3.5, 0.2270], [4.0, 0.2124], [5.0, 0.1901],
];

/**
 * Tumbling blunt fragment (irregular steel chunk) Cd on its mean presented area: ≈0.8 subsonic
 * rising to ≈1.25 just above Mach 1.5 (Hoerner, "Fluid-Dynamic Drag", 1965, ch. 16; the
 * fragment-drag curves used in JMEM / UFC 3-340-02 §2-16).
 */
const BLUNT: readonly [number, number][] = [
  [0.0, 0.80], [0.6, 0.82], [0.8, 0.90], [1.0, 1.08], [1.2, 1.20], [1.5, 1.26], [2.0, 1.22],
  [3.0, 1.16], [4.0, 1.12], [6.0, 1.10],
];

function table(t: readonly [number, number][], x: number): number {
  if (x <= t[0]![0]) return t[0]![1];
  for (let i = 1; i < t.length; i++) {
    const [x1, y1] = t[i]!;
    if (x <= x1) {
      const [x0, y0] = t[i - 1]!;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return t[t.length - 1]![1];
}

/** Raw drag-curve shape for a projectile kind at a Mach number. */
export function dragShape(mach: number, kind: AmmoSpec['kind']): number {
  return kind === 'fragment' ? table(BLUNT, mach) : table(G7, mach);
}

/**
 * Drag coefficient at `speed`. `ammo.dragCd` is the Cd at the round's own muzzle (or launch)
 * velocity; the curve shape carries it to other Mach numbers (form-factor method: Cd = i·Cd_G7(M)).
 */
export function dragCoefficient(ammo: AmmoSpec, speed: number): number {
  const mRef = Math.max(0.3, ammo.muzzleVelocity / SPEED_OF_SOUND);
  const mach = speed / SPEED_OF_SOUND;
  return (ammo.dragCd * dragShape(mach, ammo.kind)) / dragShape(mRef, ammo.kind);
}

/** Frontal reference area of the round, m². */
export function referenceArea(ammo: AmmoSpec): number {
  return (Math.PI * ammo.diameter * ammo.diameter) / 4;
}

/** Drag deceleration factor k = ½ ρ Cd A / m, so that a_drag = −k |v| v. */
export function dragFactor(ammo: AmmoSpec, speed: number, mass: number): number {
  return (0.5 * AIR_DENSITY * dragCoefficient(ammo, speed) * referenceArea(ammo)) / Math.max(mass, 1e-6);
}

/** State integrated by `stepFlight`. `Projectile` objects satisfy it. */
export interface FlightBody {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  mass: number;
  age: number;
  burning: boolean;
}

const _acc = new THREE.Vector3();
const _v0 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tan = new THREE.Vector3();
const GRAVITY = new THREE.Vector3(0, -G, 0);

/** Seconds of [a, b] that overlap [c, d]. */
function overlap(a: number, b: number, c: number, d: number): number {
  return Math.max(0, Math.min(b, d) - Math.max(a, c));
}

/**
 * Rocket motor over one step: fraction of dt the motor burns, the average thrust acceleration it
 * gives along the flight direction, and the propellant it uses (mass flow m_p / t_b, i.e. the
 * Tsiolkovsky mass loss). Updates `b.burning` and `b.mass`; returns the thrust acceleration, m/s².
 */
function motorStep(b: FlightBody, ammo: AmmoSpec, dt: number): number {
  const r = ammo.rocket;
  b.burning = false;
  if (!r) return 0;
  const on = overlap(b.age, b.age + dt, r.ignitionDelay, r.ignitionDelay + r.burnTime);
  if (on <= 0) return 0;
  b.burning = true;
  const a = (r.thrust * on) / dt / b.mass;
  b.mass = Math.max(b.mass - (r.propellantMass * on) / r.burnTime, ammo.mass - r.propellantMass);
  return a;
}

/**
 * Advance one body by dt (any dt > 0): gravity, rocket thrust along the velocity (fin-stabilised
 * rounds weathercock into the relative wind) and quadratic drag. No guidance: every round flies
 * ballistically; the top-attack launcher's arc is the scripted `LoftPath` below.
 */
export function stepFlight(b: FlightBody, ammo: AmmoSpec, dt: number): void {
  if (!(dt > 0)) return;
  const v = b.velocity;
  _v0.copy(v);
  _acc.copy(GRAVITY);
  let speed = v.length();
  if (speed > 1e-6) _dir.copy(v).divideScalar(speed);
  else _dir.set(0, 0, 0);
  const thrust = motorStep(b, ammo, dt);
  if (thrust > 0) _acc.addScaledVector(_dir, thrust);
  v.addScaledVector(_acc, dt);
  // Quadratic drag F = ½ ρ Cd A v² (Cd from the Mach curve), exact decay along the path.
  speed = v.length();
  if (speed > 0) v.multiplyScalar(1 / (1 + dragFactor(ammo, speed, b.mass) * speed * dt));
  b.position.addScaledVector(_v0, 0.5 * dt).addScaledVector(v, 0.5 * dt);
  b.age += dt;
}

// ─── Cosmetic top-attack loft ───────────────────────────────────────────────────────────────

const LOFT_SAMPLES = 64;

/**
 * A purely *scripted* flight path for the top-attack launcher: a cubic Bézier from the launch
 * point to the aimed point that climbs out, arcs over and comes down steeply onto the target's
 * top face. It is a presentation device, not a guidance law: nothing is sensed or steered. The
 * missile's speed along the curve still comes from its motor, drag and the along-path component of
 * gravity (`stepLoft`), so it visibly soft-launches, accelerates and noses over.
 *
 * Shape: apex height H = clamp(0.35 R, 6 m, loftHeight) above the higher of launch and target
 * (R = horizontal range; the published loft of ~150 m only fits multi-km shots), final dive
 * ≈ atan(H / 0.25 R) (≈ 55° with the default proportions).
 */
export class LoftPath {
  readonly p0 = new THREE.Vector3();
  readonly p1 = new THREE.Vector3();
  readonly p2 = new THREE.Vector3();
  readonly p3 = new THREE.Vector3();
  /** Cumulative arc length at LOFT_SAMPLES + 1 evenly spaced parameters */
  private readonly lut = new Float64Array(LOFT_SAMPLES + 1);
  /** Total arc length, m */
  length = 0;
  /** Apex height used, m */
  apex = 0;

  constructor(launch: THREE.Vector3, target: THREE.Vector3, loftHeight = 150) {
    this.set(launch, target, loftHeight);
  }

  set(launch: THREE.Vector3, target: THREE.Vector3, loftHeight = 150): this {
    const fwd = _tan.set(target.x - launch.x, 0, target.z - launch.z);
    const R = fwd.length();
    if (R > 1e-6) fwd.divideScalar(R);
    else fwd.set(0, 0, -1);
    const H = Math.min(Math.max(loftHeight, 6), Math.max(6, 0.35 * R));
    const top = Math.max(launch.y, target.y) + H;
    this.apex = H;
    this.p0.copy(launch);
    // Climb-out handle: a third of the way along, most of the way up (≈ 30–45° initial climb).
    this.p1.copy(launch).addScaledVector(fwd, 0.3 * R);
    this.p1.y = launch.y + 0.85 * (top - launch.y);
    // Dive handle: above the target, a quarter of the range short of it.
    this.p2.copy(target).addScaledVector(fwd, -0.25 * R);
    this.p2.y = top;
    this.p3.copy(target);
    let s = 0;
    this.lut[0] = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3().copy(launch);
    for (let i = 1; i <= LOFT_SAMPLES; i++) {
      this.pointAtParam(i / LOFT_SAMPLES, a);
      s += a.distanceTo(b);
      this.lut[i] = s;
      b.copy(a);
    }
    this.length = s;
    return this;
  }

  /** Bézier point at parameter u ∈ [0, 1]. */
  pointAtParam(u: number, out: THREE.Vector3): THREE.Vector3 {
    const w = 1 - u;
    const b0 = w * w * w, b1 = 3 * w * w * u, b2 = 3 * w * u * u, b3 = u * u * u;
    return out.set(
      b0 * this.p0.x + b1 * this.p1.x + b2 * this.p2.x + b3 * this.p3.x,
      b0 * this.p0.y + b1 * this.p1.y + b2 * this.p2.y + b3 * this.p3.y,
      b0 * this.p0.z + b1 * this.p1.z + b2 * this.p2.z + b3 * this.p3.z,
    );
  }

  /** Unit tangent at parameter u. */
  tangentAtParam(u: number, out: THREE.Vector3): THREE.Vector3 {
    const w = 1 - u;
    const d0 = 3 * w * w, d1 = 6 * w * u, d2 = 3 * u * u;
    out.set(
      d0 * (this.p1.x - this.p0.x) + d1 * (this.p2.x - this.p1.x) + d2 * (this.p3.x - this.p2.x),
      d0 * (this.p1.y - this.p0.y) + d1 * (this.p2.y - this.p1.y) + d2 * (this.p3.y - this.p2.y),
      d0 * (this.p1.z - this.p0.z) + d1 * (this.p2.z - this.p1.z) + d2 * (this.p3.z - this.p2.z),
    );
    const l = out.length();
    return l > 1e-9 ? out.divideScalar(l) : out.set(0, 0, -1);
  }

  /** Parameter at arc length s (clamped to the curve). */
  paramAt(s: number): number {
    if (s <= 0) return 0;
    if (s >= this.length) return 1;
    let lo = 0, hi = LOFT_SAMPLES;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.lut[mid]! < s) lo = mid;
      else hi = mid;
    }
    const s0 = this.lut[lo]!, s1 = this.lut[hi]!;
    return (lo + (s1 > s0 ? (s - s0) / (s1 - s0) : 0)) / LOFT_SAMPLES;
  }

  /**
   * Position and unit tangent at arc length s. Past the end the path continues straight along the
   * final tangent, so the last step sweeps through the aimed surface.
   */
  sample(s: number, pos: THREE.Vector3, tangent: THREE.Vector3): void {
    if (s <= this.length) {
      const u = this.paramAt(s);
      this.pointAtParam(u, pos);
      this.tangentAtParam(u, tangent);
      return;
    }
    this.tangentAtParam(1, tangent);
    pos.copy(this.p3).addScaledVector(tangent, s - this.length);
  }
}

/** A body flying a scripted loft: its distance travelled along the path. */
export interface LoftState {
  path: LoftPath;
  /** Arc length flown so far, m */
  s: number;
}

/**
 * Advance a body along its scripted loft by dt. Only the *speed* is simulated (1-D, along the
 * path): dv/dt = thrust/m − k v² − g·t̂_y, with the same motor and drag model as `stepFlight`;
 * position and velocity direction come from the curve. Returns true once the body has flown past
 * the end of the curve by more than `overrun` metres (the caller then lets it fly ballistically).
 */
export function stepLoft(b: FlightBody, ammo: AmmoSpec, loft: LoftState, dt: number, overrun = 2): boolean {
  if (!(dt > 0)) return false;
  loft.path.sample(loft.s, _v0, _tan);
  let v = b.velocity.length();
  const thrust = motorStep(b, ammo, dt);
  // Along-path gravity: slows the climb, speeds the dive. Never let the scripted flight stall.
  v += (thrust - G * _tan.y) * dt;
  v = v / (1 + dragFactor(ammo, Math.max(v, 1), b.mass) * Math.max(v, 0) * dt);
  v = Math.max(v, 15);
  loft.s += v * dt;
  loft.path.sample(loft.s, b.position, _tan);
  b.velocity.copy(_tan).multiplyScalar(v);
  b.age += dt;
  return loft.s > loft.path.length + overrun;
}

export interface ArrivalPlan {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Time of flight from the returned state to the target, s */
  time: number;
}

/**
 * Plan an indirect-fire arrival: integrate *backwards* from the target with the given impact
 * velocity until the round is `height` metres above the target (or `maxTime` has elapsed). The
 * backward step is the exact algebraic inverse of `stepFlight` at the same dt (no thrust), so
 * flying the returned state forward with dt reproduces the arrival.
 */
export function planArrival(ammo: AmmoSpec, target: THREE.Vector3, impactVelocity: THREE.Vector3, height: number, maxTime: number, dt = 1 / 60): ArrivalPlan {
  const p = target.clone();
  const v = impactVelocity.clone();
  const w = new THREE.Vector3();
  let t = 0;
  while (t < maxTime && p.y - target.y < height) {
    // Forward: w = v0 + g dt; v1 = w / (1 + k(|w|) |w| dt). Invert for w, then v0.
    const s1 = v.length();
    let sw = s1;
    for (let i = 0; i < 4; i++) {
      const k = dragFactor(ammo, sw, ammo.mass);
      const denom = 1 - k * s1 * dt;
      sw = denom > 0.05 ? s1 / denom : s1 * 20;
    }
    w.copy(v).multiplyScalar(s1 > 0 ? sw / s1 : 1);
    const v0x = w.x - GRAVITY.x * dt, v0y = w.y - GRAVITY.y * dt, v0z = w.z - GRAVITY.z * dt;
    p.x -= 0.5 * (v0x + v.x) * dt;
    p.y -= 0.5 * (v0y + v.y) * dt;
    p.z -= 0.5 * (v0z + v.z) * dt;
    v.set(v0x, v0y, v0z);
    t += dt;
  }
  return { position: p, velocity: v, time: t };
}

/** Speed after flying `distance` metres flat (tests/HUD): integrates `stepFlight` without gravity drop concerns. */
export function speedAtRange(ammo: AmmoSpec, distance: number, dt = 1 / 600): number {
  const b: FlightBody = {
    position: new THREE.Vector3(), velocity: new THREE.Vector3(ammo.muzzleVelocity, 0, 0),
    mass: ammo.mass, age: 0, burning: false,
  };
  let guard = 0;
  while (b.position.x < distance && guard++ < 1e6) {
    stepFlight(b, ammo, dt);
    b.velocity.y = 0;
    b.position.y = 0;
    if (b.velocity.x < 1) break;
  }
  return b.velocity.length();
}
