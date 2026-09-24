import { CRACK_SPEED, GRAVITY } from './model.ts';

/**
 * Tempered-glass dicing, shared by the CPU (which spawns the dice) and the GPU (which draws the
 * crazed pane and cuts out the dice as they leave). Both sides evaluate the same integer hash and
 * the same release-time formula, so a die appears exactly where the pane loses its piece.
 *
 * Dice sit on a jittered grid of cell size `s` in pane-corner coordinates (x ∈ [0, W], y ∈ [0, H]);
 * the visible pane is the Voronoi diagram of those sites.
 */

/** lowbias32 integer hash (C. Wellons, "Hash function prospector", 2018). Mirrored in GLSL. */
export function hash32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

/** Uniform [0, 1) per (i, j, salt), 24 bits so the float value is exact on the GPU as well. */
export function hash01(i: number, j: number, salt: number): number {
  const inner = hash32((((j >>> 0) + (Math.imul(salt >>> 0, 0x85ebca77) >>> 0)) >>> 0) >>> 0);
  const h = hash32(((Math.imul(i >>> 0, 0x9e3779b1) >>> 0) ^ inner) >>> 0);
  return (h & 0xffffff) / 16777216;
}

/** Site jitter within its cell (fraction of the cell). */
export const SITE_JITTER = 0.8;

/** Site of cell (i, j) in pane-corner coordinates, clamped inside the pane. */
export function sitePosition(i: number, j: number, s: number, salt: number, W: number, H: number, out: [number, number]): [number, number] {
  const x = (i + 0.5 + (hash01(i, j, salt) - 0.5) * SITE_JITTER) * s;
  const y = (j + 0.5 + (hash01(i, j, salt + 1) - 0.5) * SITE_JITTER) * s;
  const m = 0.3 * s;
  out[0] = Math.min(W - m, Math.max(m, x));
  out[1] = Math.min(H - m, Math.max(m, y));
  return out;
}

export interface BreakTiming {
  /** Fracture origin, pane-corner coordinates, m */
  ox: number;
  oy: number;
  /** Simulation time the fracture started, s */
  t0: number;
  /** Mean time the crazed pane hangs together after the front has passed, s */
  hold: number;
  /** Speed at which the crazed mosaic comes apart outward from the origin, m/s */
  unzip: number;
  /** Framed: dice within this distance of an edge stay in the glazing channel, m (0 = none) */
  bite: number;
  /** Point-fixed: dice within this distance of a corner fitting stay, m (0 = none) */
  fitting: number;
}

/** Far-future release time for dice that never leave (held by the frame). */
export const NEVER = 1e9;

/**
 * When the die at site (x, y) leaves the pane: the fracture front reaches it at r / 1.5 km/s
 * (Schardin's terminal crack velocity), then the interlocked mosaic holds for `hold` (± 50 %) and
 * comes apart outward at `unzip`.
 */
export function siteRelease(b: BreakTiming, x: number, y: number, jitter: number, W: number, H: number): number {
  if (b.bite > 0 && Math.min(x, y, W - x, H - y) < b.bite) return NEVER;
  if (b.fitting > 0) {
    const cx = Math.min(x, W - x), cy = Math.min(y, H - y);
    if (cx * cx + cy * cy < b.fitting * b.fitting) return NEVER;
  }
  const r = Math.hypot(x - b.ox, y - b.oy);
  return b.t0 + r / CRACK_SPEED + b.hold * (0.5 + jitter) + r / b.unzip;
}

// ─── Dice flight (closed form) ─────────────────────────────────────────────────────────────

/** Coefficient of restitution of a glass fragment on stone paving (normal). */
export const DICE_RESTITUTION = 0.3;
/** Coulomb friction of glass on stone / concrete. */
export const DICE_FRICTION = 0.5;
/** Hops slower than this are not drawn (the die just lands), m/s. */
const MIN_HOP = 0.3;

/**
 * Linearised drag rate of a tumbling die, 1/s: Newton drag F = ½ ρ_a C_d A v² on a body of
 * equivalent radius r gives dv/dt = −(3 ρ_a C_d / 8 ρ r) v²; linearised about v_ref ≈ ½ |v0| + 2 m/s
 * (C_d ≈ 1 for a tumbling cube, Hoerner 1965 "Fluid-dynamic drag").
 */
export function diceDrag(size: number, thickness: number, speed: number, density = 2500): number {
  const r = 0.5 * Math.cbrt(size * size * thickness);
  const k = (3 * 1.225 * 1.0) / (8 * density * Math.max(r, 1e-4));
  return k * (0.5 * speed + 2);
}

/** A(τ) = (1 − e^(−cτ)) / c with its small-cτ series (limit τ). */
export function dragA(c: number, t: number): number {
  const ct = c * t;
  if (ct < 1e-3) return t * (1 - 0.5 * ct + (ct * ct) / 6);
  return (1 - Math.exp(-ct)) / c;
}

/** B(τ) = (τ − A(τ)) / c with its small-cτ series (limit τ²/2). */
export function dragB(c: number, t: number): number {
  const ct = c * t;
  if (ct < 1e-3) return 0.5 * t * t * (1 - ct / 3 + (ct * ct) / 12);
  return (t - (1 - Math.exp(-ct)) / c) / c;
}

/**
 * Time of flight until the die comes down to `floor` (while descending), s. Linear drag towards
 * still air plus gravity: y(τ) = y0 + v0 A(τ) − g B(τ), y'(τ) = v0 e^(−cτ) − g A(τ). Newton from
 * the drag-free estimate, kept inside a bracket [apex, hi] (bisection fallback).
 */
export function landingTime(y0: number, vy: number, c: number, floor: number): number {
  const h = y0 - floor;
  if (h <= 0 && vy <= 0) return 0;
  const y = (t: number) => y0 + vy * dragA(c, t) - GRAVITY * dragB(c, t) - floor;
  let lo = vy > 0 ? Math.log(1 + (c * vy) / GRAVITY) / Math.max(c, 1e-9) : 0;
  if (!(lo < 1e6)) lo = vy / GRAVITY;
  let hi = (vy + Math.sqrt(vy * vy + 2 * GRAVITY * Math.max(h, 0))) / GRAVITY + 1e-3;
  let guard = 0;
  while (y(hi) > 0 && guard++ < 60) hi *= 1.5;
  if (lo > hi) lo = 0;
  let t = hi;
  for (let k = 0; k < 30; k++) {
    const f = y(t);
    if (Math.abs(f) < 1e-7) return t;
    if (f > 0) lo = t;
    else hi = t;
    const d = vy * Math.exp(-c * t) - GRAVITY * dragA(c, t);
    let n = d < -1e-9 ? t - f / d : 0.5 * (lo + hi);
    if (!(n > lo && n < hi)) n = 0.5 * (lo + hi);
    t = n;
  }
  return t;
}

export interface DiceLaunch {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Drag rate, 1/s */
  c: number;
  /** Height the die's centre comes to rest at, m */
  floor: number;
}

export interface DiceRest {
  /** Flight time to first impact, hop time, slide time (s, from release) */
  t1: number;
  t2: number;
  t3: number;
  x: number;
  z: number;
}

/**
 * Where and when a released die comes to rest: flight with drag to the floor, one hop with
 * restitution e and a Coulomb friction impulse μ(1 + e)|v_n| (Brach 1991, "Mechanical impact
 * dynamics"), then a slide decelerating at μg.
 */
export function diceRest(d: DiceLaunch, out: DiceRest, flight?: number): DiceRest {
  const t1 = flight ?? landingTime(d.y, d.vy, d.c, d.floor);
  const A = dragA(d.c, t1);
  const e = Math.exp(-d.c * t1);
  const x1 = d.x + d.vx * A, z1 = d.z + d.vz * A;
  const vx1 = d.vx * e, vz1 = d.vz * e, vy1 = d.vy * e - GRAVITY * A;
  const vn = Math.max(0, -vy1);
  const vh = Math.hypot(vx1, vz1);
  const keep = vh > 1e-6 ? Math.max(0, 1 - (DICE_FRICTION * (1 + DICE_RESTITUTION) * vn) / vh) : 0;
  const hvx = vx1 * keep, hvz = vz1 * keep;
  const hop = DICE_RESTITUTION * vn;
  const t2 = hop > MIN_HOP ? (2 * hop) / GRAVITY : 0;
  const x2 = x1 + hvx * t2, z2 = z1 + hvz * t2;
  const vs = Math.hypot(hvx, hvz);
  const t3 = vs / (DICE_FRICTION * GRAVITY);
  out.t1 = t1;
  out.t2 = t2;
  out.t3 = t3;
  out.x = x2 + 0.5 * hvx * t3;
  out.z = z2 + 0.5 * hvz * t3;
  return out;
}
