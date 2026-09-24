import * as THREE from 'three';
import { AIR_DENSITY, G, SPEED_OF_SOUND } from '../../core/units.ts';
import type { AmmoSpec } from './types.ts';

/**
 * Exterior ballistics: point-mass trajectories with gravity, Mach-dependent quadratic drag, rocket
 * thrust with ignition delay and mass loss, and simple pursuit / top-attack guidance.
 *
 * The integrator is a split scheme: thrust, guidance and gravity are applied explicitly, then the
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

/** Guidance inputs: the aim point and where the missile was launched (top-attack loft). */
export interface GuidanceTarget {
  target: THREE.Vector3;
  launch: THREE.Vector3;
}

const _acc = new THREE.Vector3();
const _v0 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _des = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const GRAVITY = new THREE.Vector3(0, -G, 0);

/** Seconds of [a, b] that overlap [c, d]. */
function overlap(a: number, b: number, c: number, d: number): number {
  return Math.max(0, Math.min(b, d) - Math.max(a, c));
}

/**
 * Advance one body by dt (any dt > 0). Thrust acts along the velocity (fin-stabilised rounds weather-
 * cock into the relative wind), the motor's propellant burns off linearly (Tsiolkovsky mass loss),
 * and guidance adds a lateral acceleration capped at `guidance.maxAccel`.
 */
export function stepFlight(b: FlightBody, ammo: AmmoSpec, dt: number, guide?: GuidanceTarget | null): void {
  if (!(dt > 0)) return;
  const v = b.velocity;
  _v0.copy(v);
  _acc.copy(GRAVITY);
  let speed = v.length();
  if (speed > 1e-6) _dir.copy(v).divideScalar(speed);
  else _dir.set(0, 0, 0);

  const r = ammo.rocket;
  b.burning = false;
  if (r) {
    const on = overlap(b.age, b.age + dt, r.ignitionDelay, r.ignitionDelay + r.burnTime);
    if (on > 0) {
      b.burning = true;
      // Average thrust over the step, then burn off the propellant used (mass flow = mp / tb).
      _acc.addScaledVector(_dir, (r.thrust * on) / dt / b.mass);
      b.mass = Math.max(b.mass - (r.propellantMass * on) / r.burnTime, ammo.mass - r.propellantMass);
    }
  }

  const g = ammo.guidance;
  if (g && guide && b.age >= (r?.ignitionDelay ?? 0) && speed > 1) {
    guidanceDirection(b, g, guide, _des);
    // Pursuit: steer the velocity towards the desired direction over ~0.15 s, plus lift that
    // cancels the component of gravity across the flight path (the airframe holds its path).
    _tmp.copy(_des).multiplyScalar(speed).sub(v).divideScalar(0.15);
    _tmp.addScaledVector(_dir, -_tmp.dot(_dir));
    _tmp.addScaledVector(GRAVITY, -1).addScaledVector(_dir, GRAVITY.dot(_dir));
    const a = _tmp.length();
    if (a > g.maxAccel) _tmp.multiplyScalar(g.maxAccel / a);
    _acc.add(_tmp);
  }

  v.addScaledVector(_acc, dt);
  // Quadratic drag F = ½ ρ Cd A v² (Cd from the Mach curve), exact decay along the path.
  speed = v.length();
  if (speed > 0) v.multiplyScalar(1 / (1 + dragFactor(ammo, speed, b.mass) * speed * dt));
  b.position.addScaledVector(_v0, 0.5 * dt).addScaledVector(v, 0.5 * dt);
  b.age += dt;
}

/**
 * Desired flight direction for guided rounds. 'direct' pursues the aim point. 'topAttack' (Javelin)
 * climbs at up to ~30° towards a cruise point `loft` metres above the launch height, then dives
 * so as to arrive at ≈55° from above: the dive starts where the remaining horizontal distance
 * equals h / tan 55° plus the turn radius v²/a_max it needs to pull over. The loft is scaled down
 * for short sandbox ranges (the real missile lofts ~150 m at 2 km; here ≈ 0.3 × range, ≥ 12 m).
 */
export function guidanceDirection(b: FlightBody, g: NonNullable<AmmoSpec['guidance']>, t: GuidanceTarget, out: THREE.Vector3): THREE.Vector3 {
  out.copy(t.target).sub(b.position);
  if (g.mode !== 'topAttack') return out.normalize();
  const dx = t.target.x - b.position.x;
  const dz = t.target.z - b.position.z;
  const rh = Math.hypot(dx, dz);
  const below = b.position.y - t.target.y;
  const v2 = b.velocity.lengthSq();
  const turn = v2 / Math.max(g.maxAccel, 1);
  if (below > 0 && (rh <= below / DIVE_TAN + 0.8 * turn || Math.atan2(below, rh) >= DIVE_MIN)) return out.normalize();
  const range = Math.hypot(t.target.x - t.launch.x, t.target.z - t.launch.z);
  const loft = Math.min(g.loftHeight ?? 150, Math.max(12, 0.3 * range));
  const cruiseY = Math.max(t.launch.y, t.target.y) + loft;
  out.set(dx, cruiseY - b.position.y, dz);
  const maxClimb = Math.tan(THREE.MathUtils.degToRad(30)) * Math.max(rh, 1e-3);
  if (out.y > maxClimb) out.y = maxClimb;
  return out.normalize();
}

const DIVE_TAN = Math.tan(THREE.MathUtils.degToRad(55));
const DIVE_MIN = THREE.MathUtils.degToRad(45);

export interface ArrivalPlan {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Time of flight from the returned state to the target, s */
  time: number;
}

/**
 * Plan an indirect-fire arrival: integrate *backwards* from the target with the given impact
 * velocity until the round is `height` metres above the target (or `maxTime` has elapsed). The
 * backward step is the exact algebraic inverse of `stepFlight` at the same dt (unguided, no
 * thrust), so flying the returned state forward with dt reproduces the arrival.
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
