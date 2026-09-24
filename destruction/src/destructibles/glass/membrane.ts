import { LAMINATED_SLACK } from './model.ts';

/**
 * Post-breakage laminated glass as an XPBD particle membrane (Macklin, Müller & Chentanez 2016,
 * "XPBD: position-based simulation of compliant constrained dynamics"; small-step variant, Macklin
 * et al. 2019, "Small steps in physics simulation": many substeps, one iteration each — stable and
 * dt-independent for any step in (0, 1/60]).
 *
 * Intact laminated glass is a stiff plate; once both plies crack, the fragments stay bonded to the
 * PVB and the pane becomes a membrane that carries tension but little bending. Per-particle damage
 * (0..1) softens the bending constraints and lengthens rest lengths (fragment wedging → slack), so a
 * damaged pane bulges in its frame; plastic updates keep the deformation (the interlayer yields
 * and does not spring back). Pinned particles are the frame bite / point fittings; releasing them
 * lets the sheet tear out and fall as one flexible piece onto the floor plane.
 *
 * Coordinates are pane-local (x along the width, y up the pane, z out of the front face).
 */

export interface MembraneOptions {
  width: number;
  height: number;
  thickness: number;
  density: number;
  /** Target particle spacing, m */
  spacing: number;
  framed: boolean;
}

/** Stretch compliance (m/N): cracked laminated in tension ≈ PVB + bonded fragments (≈ 0.5 MN/m per link). */
const ALPHA_STRETCH = 2e-6;
/** Bending (skip-one distance) compliance of intact and fully cracked glass, m/N. */
const ALPHA_BEND_INTACT = 1e-8;
const ALPHA_BEND_CRACKED = 4e-4;
/** Substep length, s (≈ 1/600 s). */
const SUBSTEP = 1 / 600;
/** Air and interlayer damping rate, 1/s */
const DAMPING = 1.2;
/** Strain beyond which the interlayer yields (rest length follows), and the rate it follows at. */
const YIELD = 0.015;
/** Damage slack is taken up over ≈ 0.2 s (fragments wedge as the pane creeps), not in one step. */
const SLACK_RATE = 5;
/** Safety cap on particle speed, m/s (blast-driven sheets stay well below it). */
const MAX_SPEED = 120;
/**
 * Sleep test on net motion: a crumpled sheet lying on the floor keeps a few particles jittering by
 * centimetres about a fixed shape (position-based floor contact against stiff links), so its
 * largest speed never settles and it simulated for ever (≈ 1–3 ms per sheet per step). The mean
 * drift of its particles over SLEEP_WINDOW s tells rest (≈ 0.1 mm) from sliding or falling.
 */
const SLEEP_WINDOW = 0.5;
const SLEEP_DRIFT = 0.0005;

export class Membrane {
  readonly nx: number;
  readonly ny: number;
  readonly n: number;
  readonly width: number;
  readonly height: number;
  /** Positions, previous positions, velocities (3 per particle) */
  readonly x: Float64Array;
  readonly p: Float64Array;
  readonly v: Float64Array;
  /** Rest (flat) position of each particle in the pane plane (2 per particle) */
  readonly rest: Float64Array;
  readonly w: Float64Array;
  readonly mass: Float64Array;
  readonly pinned: Uint8Array;
  readonly damage: Float64Array;
  readonly ci: Int32Array;
  readonly cj: Int32Array;
  readonly L0: Float64Array;
  /** Rest length before damage slack (plastic updates move this) */
  readonly Lbase: Float64Array;
  readonly bend: Uint8Array;
  /** Current damage slack factor per link (relaxes towards 1 + LAMINATED_SLACK · damage) */
  readonly slack: Float64Array;
  /** Out-of-plane side the sheet buckles to (+1 / −1), set by the first push it gets */
  bulge = 0;
  readonly gravity = [0, -9.80665, 0];
  /** Floor plane in pane-local coordinates: dot(floorN, x) ≥ floorD */
  readonly floorN = [0, 1, 0];
  floorD = -1e9;
  awake = false;
  released = false;
  private still = 0;
  /** Time since the drift snapshot, s, and the snapshot of x */
  private window = 0;
  private readonly snap: Float64Array;
  /** Largest particle speed in the last step, m/s */
  maxSpeed = 0;
  /** Largest floor-contact impulse in the last step (N·s), for debris sounds */
  floorImpulse = 0;

  constructor(o: MembraneOptions) {
    this.width = o.width;
    this.height = o.height;
    this.nx = Math.max(3, Math.round(o.width / o.spacing) + 1);
    this.ny = Math.max(3, Math.round(o.height / o.spacing) + 1);
    const n = (this.n = this.nx * this.ny);
    this.x = new Float64Array(3 * n);
    this.p = new Float64Array(3 * n);
    this.v = new Float64Array(3 * n);
    this.snap = new Float64Array(3 * n);
    this.rest = new Float64Array(2 * n);
    this.w = new Float64Array(n);
    this.mass = new Float64Array(n);
    this.pinned = new Uint8Array(n);
    this.damage = new Float64Array(n);
    const dx = o.width / (this.nx - 1), dy = o.height / (this.ny - 1);
    const cellMass = o.density * o.thickness * dx * dy;
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const k = j * this.nx + i;
        const u = -o.width / 2 + i * dx, v = -o.height / 2 + j * dy;
        this.rest[2 * k] = u;
        this.rest[2 * k + 1] = v;
        this.x[3 * k] = this.p[3 * k] = u;
        this.x[3 * k + 1] = this.p[3 * k + 1] = v;
        // Lumped mass: a quarter cell per incident cell.
        const fx = i === 0 || i === this.nx - 1 ? 0.5 : 1, fy = j === 0 || j === this.ny - 1 ? 0.5 : 1;
        this.mass[k] = cellMass * fx * fy;
        const edge = i === 0 || j === 0 || i === this.nx - 1 || j === this.ny - 1;
        const corner = (i <= 1 || i >= this.nx - 2) && (j <= 1 || j >= this.ny - 2);
        this.pinned[k] = (o.framed ? edge : corner) ? 1 : 0;
        this.w[k] = this.pinned[k] ? 0 : 1 / this.mass[k]!;
      }
    }
    // Constraints: structural, shear and skip-one "bending" links.
    const I: number[] = [], J: number[] = [], B: number[] = [];
    const link = (a: number, b: number, bend: number) => {
      I.push(a);
      J.push(b);
      B.push(bend);
    };
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const k = j * this.nx + i;
        if (i + 1 < this.nx) link(k, k + 1, 0);
        if (j + 1 < this.ny) link(k, k + this.nx, 0);
        if (i + 1 < this.nx && j + 1 < this.ny) {
          link(k, k + this.nx + 1, 0);
          link(k + 1, k + this.nx, 0);
        }
        if (i + 2 < this.nx) link(k, k + 2, 1);
        if (j + 2 < this.ny) link(k, k + 2 * this.nx, 1);
      }
    }
    this.ci = Int32Array.from(I);
    this.cj = Int32Array.from(J);
    this.bend = Uint8Array.from(B);
    this.L0 = new Float64Array(I.length);
    this.Lbase = new Float64Array(I.length);
    this.slack = new Float64Array(I.length).fill(1);
    for (let c = 0; c < I.length; c++) {
      const a = I[c]!, b = J[c]!;
      const L = Math.hypot(this.rest[2 * a]! - this.rest[2 * b]!, this.rest[2 * a + 1]! - this.rest[2 * b + 1]!);
      this.L0[c] = this.Lbase[c] = L;
    }
  }

  /** Particle nearest to pane-local (x, y). */
  nearest(x: number, y: number): number {
    const i = Math.round(((x + this.width / 2) / this.width) * (this.nx - 1));
    const j = Math.round(((y + this.height / 2) / this.height) * (this.ny - 1));
    return Math.min(this.ny - 1, Math.max(0, j)) * this.nx + Math.min(this.nx - 1, Math.max(0, i));
  }

  /** Out-of-plane displacement at rest-plane point (x, y), bilinear over the grid. */
  displacementAt(x: number, y: number): number {
    const fx = Math.min(this.nx - 1.0001, Math.max(0, ((x + this.width / 2) / this.width) * (this.nx - 1)));
    const fy = Math.min(this.ny - 1.0001, Math.max(0, ((y + this.height / 2) / this.height) * (this.ny - 1)));
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    const k = j * this.nx + i;
    const z = (q: number) => this.x[3 * q + 2]!;
    return (1 - v) * ((1 - u) * z(k) + u * z(k + 1)) + v * ((1 - u) * z(k + this.nx) + u * z(k + this.nx + 1));
  }

  /** Mean damage 0..1. */
  meanDamage(): number {
    let s = 0;
    for (let k = 0; k < this.n; k++) s += this.damage[k]!;
    return s / this.n;
  }

  /**
   * Raise damage around (x, y) with a smooth kernel of radius R (capped at 1). The fragments are
   * nudged out of plane towards the bulge side: a perfectly flat sheet has no way to buckle, and
   * real cracked glass is never flat (the blow that cracked it pushed it).
   */
  addDamage(x: number, y: number, R: number, amount: number): void {
    if (this.bulge === 0) this.bulge = 1;
    for (let k = 0; k < this.n; k++) {
      const dx = this.rest[2 * k]! - x, dy = this.rest[2 * k + 1]! - y;
      const q = (dx * dx + dy * dy) / (R * R);
      if (q >= 1) continue;
      const f = amount * (1 - q) * (1 - q);
      this.damage[k] = Math.min(1, this.damage[k]! + f * (1 - this.damage[k]!));
      if (this.w[k]! > 0) this.x[3 * k + 2] += this.bulge * 2e-4 * f;
    }
    this.wake();
  }

  /** Add an impulse (N·s, pane-local) spread over particles within radius R of (x, y). */
  impulse(x: number, y: number, R: number, jx: number, jy: number, jz: number): void {
    if (this.bulge === 0 && jz !== 0) this.bulge = Math.sign(jz);
    let wsum = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < this.n; k++) {
        if (this.pinned[k] && !this.released) continue;
        const dx = this.rest[2 * k]! - x, dy = this.rest[2 * k + 1]! - y;
        const q = (dx * dx + dy * dy) / (R * R);
        if (q >= 1) continue;
        const f = (1 - q) * (1 - q) * this.mass[k]!;
        if (pass === 0) wsum += f;
        else {
          // Momentum shared in proportion to the kernel-weighted mass → uniform Δv under the kernel.
          const s = f / wsum / this.mass[k]!;
          this.v[3 * k] += jx * s;
          this.v[3 * k + 1] += jy * s;
          this.v[3 * k + 2] += jz * s;
        }
      }
      if (pass === 0 && wsum <= 0) {
        const k = this.nearest(x, y);
        if (this.pinned[k] && !this.released) return;
        wsum = this.mass[k]!;
        this.v[3 * k] += jx / wsum;
        this.v[3 * k + 1] += jy / wsum;
        this.v[3 * k + 2] += jz / wsum;
        break;
      }
    }
    this.wake();
  }

  /** Uniform velocity change for every free particle (blast loading of the whole sheet). */
  kick(fn: (k: number, out: number[]) => void): void {
    const tmp = [0, 0, 0];
    for (let k = 0; k < this.n; k++) {
      if (this.w[k] === 0) continue;
      fn(k, tmp);
      this.v[3 * k] += tmp[0]!;
      this.v[3 * k + 1] += tmp[1]!;
      this.v[3 * k + 2] += tmp[2]!;
    }
    this.wake();
  }

  /** Let go of every pinned particle: the sheet leaves its frame. */
  release(): void {
    if (this.released) return;
    this.released = true;
    for (let k = 0; k < this.n; k++) {
      this.pinned[k] = 0;
      this.w[k] = 1 / this.mass[k]!;
      // A pane that pulls out of its frame has cracked throughout.
      this.damage[k] = Math.max(this.damage[k]!, 0.6);
    }
    this.wake();
  }

  wake(): void {
    this.awake = true;
    this.still = 0;
    this.window = 0;
    this.snap.set(this.x);
  }

  step(dt: number): void {
    if (!this.awake || !(dt > 0)) return;
    const subs = Math.max(1, Math.ceil(dt / SUBSTEP));
    const h = dt / subs;
    const { x, p, v, w } = this;
    const gx = this.gravity[0]!, gy = this.gravity[1]!, gz = this.gravity[2]!;
    const damp = Math.exp(-DAMPING * h);
    const fnx = this.floorN[0]!, fny = this.floorN[1]!, fnz = this.floorN[2]!;
    this.floorImpulse = 0;
    for (let s = 0; s < subs; s++) {
      for (let k = 0; k < this.n; k++) {
        const o = 3 * k;
        p[o] = x[o]!;
        p[o + 1] = x[o + 1]!;
        p[o + 2] = x[o + 2]!;
        if (w[k] === 0) continue;
        v[o] = v[o]! * damp + gx * h;
        v[o + 1] = v[o + 1]! * damp + gy * h;
        v[o + 2] = v[o + 2]! * damp + gz * h;
        x[o] += v[o]! * h;
        x[o + 1] += v[o + 1]! * h;
        x[o + 2] += v[o + 2]! * h;
      }
      const h2 = h * h;
      for (let c = 0; c < this.ci.length; c++) {
        const a = this.ci[c]!, b = this.cj[c]!;
        const wa = w[a]!, wb = w[b]!;
        const ws = wa + wb;
        if (ws === 0) continue;
        const oa = 3 * a, ob = 3 * b;
        const dx = x[oa]! - x[ob]!, dy = x[oa + 1]! - x[ob + 1]!, dz = x[oa + 2]! - x[ob + 2]!;
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (L < 1e-9) continue;
        const L0 = this.Lbase[c]! * this.slack[c]!;
        let alpha = ALPHA_STRETCH;
        if (this.bend[c]) {
          const d = 0.5 * (this.damage[a]! + this.damage[b]!);
          alpha = ALPHA_BEND_INTACT + (ALPHA_BEND_CRACKED - ALPHA_BEND_INTACT) * d * d;
          // Cracked glass carries no tension across a fold, only compression by fragment contact.
          if (L > L0 && d > 0.5) continue;
        }
        const C = L - L0;
        const dl = -C / (ws + alpha / h2);
        const sx = (dl * dx) / L, sy = (dl * dy) / L, sz = (dl * dz) / L;
        x[oa] += wa * sx;
        x[oa + 1] += wa * sy;
        x[oa + 2] += wa * sz;
        x[ob] -= wb * sx;
        x[ob + 1] -= wb * sy;
        x[ob + 2] -= wb * sz;
      }
      // Floor contact with Coulomb friction (position-level, Müller et al. 2007 PBD).
      if (this.released) {
        for (let k = 0; k < this.n; k++) {
          const o = 3 * k;
          const d = fnx * x[o]! + fny * x[o + 1]! + fnz * x[o + 2]! - this.floorD;
          if (d >= 0) continue;
          x[o] -= fnx * d;
          x[o + 1] -= fny * d;
          x[o + 2] -= fnz * d;
          // Tangential slip since the substep start, reduced by μ × penetration correction.
          const tx = x[o]! - p[o]!, ty = x[o + 1]! - p[o + 1]!, tz = x[o + 2]! - p[o + 2]!;
          const tn = tx * fnx + ty * fny + tz * fnz;
          const ux = tx - tn * fnx, uy = ty - tn * fny, uz = tz - tn * fnz;
          const ut = Math.sqrt(ux * ux + uy * uy + uz * uz);
          const f = ut > 1e-12 ? Math.min(1, (0.6 * -d) / ut) : 0;
          x[o] -= ux * f;
          x[o + 1] -= uy * f;
          x[o + 2] -= uz * f;
          this.floorImpulse = Math.max(this.floorImpulse, (this.mass[k]! * -d) / h);
        }
      }
      let vmax = 0;
      for (let k = 0; k < this.n; k++) {
        const o = 3 * k;
        if (w[k] === 0) {
          v[o] = v[o + 1] = v[o + 2] = 0;
          continue;
        }
        v[o] = (x[o]! - p[o]!) / h;
        v[o + 1] = (x[o + 1]! - p[o + 1]!) / h;
        v[o + 2] = (x[o + 2]! - p[o + 2]!) / h;
        let sp = v[o]! * v[o]! + v[o + 1]! * v[o + 1]! + v[o + 2]! * v[o + 2]!;
        if (sp > MAX_SPEED * MAX_SPEED) {
          const f = MAX_SPEED / Math.sqrt(sp);
          v[o] *= f;
          v[o + 1] *= f;
          v[o + 2] *= f;
          sp = MAX_SPEED * MAX_SPEED;
        }
        if (sp > vmax) vmax = sp;
      }
      this.maxSpeed = Math.sqrt(vmax);
    }
    this.plastic(dt);
    if (this.maxSpeed < 0.004) {
      this.still += dt;
      if (this.still > 0.6) this.sleep();
    } else this.still = 0;
    this.window += dt;
    if (this.awake && this.window >= SLEEP_WINDOW) {
      let drift = 0;
      for (let k = 0; k < this.n; k++) {
        const o = 3 * k;
        drift += Math.hypot(x[o]! - this.snap[o]!, x[o + 1]! - this.snap[o + 1]!, x[o + 2]! - this.snap[o + 2]!);
      }
      this.window = 0;
      this.snap.set(x);
      if (drift / this.n < SLEEP_DRIFT) this.sleep();
    }
  }

  private sleep(): void {
    this.awake = false;
    this.v.fill(0);
  }

  /**
   * Damage slack relaxes in; the interlayer yields: links strained past YIELD, and bent links of
   * cracked glass, keep their shape.
   */
  private plastic(dt: number): void {
    const x = this.x;
    const rate = 1 - Math.exp(-8 * dt);
    const ramp = 1 - Math.exp(-SLACK_RATE * dt);
    for (let c = 0; c < this.ci.length; c++) {
      const a = this.ci[c]!, b = this.cj[c]!;
      const oa = 3 * a, ob = 3 * b;
      const L = Math.hypot(x[oa]! - x[ob]!, x[oa + 1]! - x[ob + 1]!, x[oa + 2]! - x[ob + 2]!);
      const d = 0.5 * (this.damage[a]! + this.damage[b]!);
      this.slack[c] += (1 + LAMINATED_SLACK * d - this.slack[c]!) * ramp;
      const slack = this.slack[c]!;
      const base = this.Lbase[c]!;
      if (this.bend[c]) {
        if (d < 0.2) continue;
        this.Lbase[c] = base + (L / slack - base) * rate * d;
      } else if (L > base * slack * (1 + YIELD)) {
        this.Lbase[c] = base + (L / (slack * (1 + YIELD)) - base) * rate;
      }
      this.L0[c] = this.Lbase[c]! * slack;
    }
  }

  /** Axis-aligned bounds of the particles (pane-local) into out [minx, miny, minz, maxx, maxy, maxz]. */
  bounds(out: number[]): number[] {
    out[0] = out[1] = out[2] = Infinity;
    out[3] = out[4] = out[5] = -Infinity;
    for (let k = 0; k < this.n; k++) {
      for (let a = 0; a < 3; a++) {
        const q = this.x[3 * k + a]!;
        if (q < out[a]!) out[a] = q;
        if (q > out[a + 3]!) out[a + 3] = q;
      }
    }
    return out;
  }
}
