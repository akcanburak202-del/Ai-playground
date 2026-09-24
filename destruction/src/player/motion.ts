import type { AmmoSpec } from '../physics/ballistics/types.ts';

/**
 * Pure motion helpers for the viewer: frame-rate independent smoothing, the recoil spring,
 * scope field of view and the slow-motion ramp. All stable for any real dt in [0, 0.25] s.
 */

/** Exponential approach: the same result whether a second is taken in one step or a thousand. */
export function approach(current: number, target: number, dt: number, tau: number): number {
  if (!(dt > 0)) return current;
  if (!(tau > 0)) return target;
  return target + (current - target) * Math.exp(-dt / tau);
}

/**
 * Damped angular spring for weapon recoil: x'' = −ω² x − 2ζω x' with kicks as velocity
 * impulses. Integrated semi-implicitly in sub-steps of ≤ 1/240 s, so it is stable at any frame
 * time (a raw explicit step at 60 Hz with ω = 20 rad/s already rings).
 */
export class RecoilSpring {
  x = 0;
  v = 0;
  omega: number;
  zeta: number;

  constructor(omega = 16, zeta = 0.75) {
    this.omega = omega;
    this.zeta = zeta;
  }

  kick(velocity: number): void {
    if (Number.isFinite(velocity)) this.v += velocity;
  }

  update(dt: number): number {
    if (!(dt > 0)) return this.x;
    const steps = Math.min(64, Math.ceil(dt * 240));
    const h = Math.min(dt, 0.25) / steps;
    const w2 = this.omega * this.omega, c = 2 * this.zeta * this.omega;
    for (let i = 0; i < steps; i++) {
      this.v += (-w2 * this.x - c * this.v) * h;
      this.x += this.v * h;
    }
    if (Math.abs(this.x) < 1e-7 && Math.abs(this.v) < 1e-6) this.x = this.v = 0;
    return this.x;
  }

  reset(): void {
    this.x = this.v = 0;
  }
}

/** Vertical field of view (degrees) through a sight of magnification `zoom`: tan(φ/2) scales by 1/zoom. */
export function fovForZoom(baseFovDeg: number, zoom: number): number {
  const z = Math.max(1, zoom);
  const t = Math.tan((baseFovDeg * Math.PI) / 360) / z;
  return (Math.atan(t) * 360) / Math.PI;
}

/**
 * Slow-motion ramp: eases the time scale in log space (×1 → ×0.1 feels even), snapping at the
 * end so the value lands exactly on the target.
 */
export function rampTimeScale(current: number, target: number, realDt: number, tau = 0.16): number {
  const c = Math.max(1e-3, current), t = Math.max(1e-3, target);
  const l = approach(Math.log(c), Math.log(t), realDt, tau);
  const next = Math.exp(l);
  return Math.abs(next - t) / t < 0.004 ? t : next;
}

/**
 * Worth following with the bullet camera: rockets, missiles, grenades, tank rounds, shells and
 * bombs — heavy or slow enough for the eye; not bullets, not fragments.
 */
export function isFollowable(ammo: AmmoSpec, speed: number): boolean {
  if (ammo.kind === 'fragment') return false;
  return ammo.mass >= 1 || !!ammo.rocket || !!ammo.guidance || speed < 400;
}

/** Wrap an angle to (−π, π]. */
export function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t <= 0 ? t + 2 * Math.PI : t) - Math.PI;
}
