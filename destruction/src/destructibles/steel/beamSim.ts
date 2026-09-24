import { BandedSPD } from './banded.ts';
import { damagedSection, eccentricAxialArea, type SectionProps } from './section.ts';
import { TAYLOR_QUINNEY, AMBIENT_C, type SteelParams } from './steelMaterial.ts';

/**
 * Steel member as a chain of nodes along its axis (world space). Pure logic, no THREE / DOM.
 *
 * Constraints (XPBD, compliance α = 1/k):
 *  - axial bars between neighbours, k = E·A/ds, yield at N_p = A·f_y;
 *  - bending at every interior node, split into the profile's two axes: the node's offset from the
 *    midpoint of its neighbours, d = x_i − ½(x_{i−1} + x_{i+1}), projected on the node frame (u =
 *    profile "up", v = sideways). Curvature κ = 2d/ds², so ½EIκ²·ds gives k = 4EI/ds³ and the
 *    generalised force F relates to the moment by M = F·ds/2. Elastic up to M_y = S·f_y, then the
 *    section plastifies towards M_p = Z·f_y (plastic hinge), with linear strain hardening and the
 *    M–N interaction M_N = M_p·(1 − n²);
 *  - supports: fixed / pinned nodes; a fixed (moment) end adds a bending constraint against a ghost
 *    node on the original axis; the loaded end of a column is a roller (laterally held, free to
 *    shorten) so an imposed load flows down the member (P-δ).
 *
 * Unlike a plate, a beam is small enough to solve every substep *exactly*: constraints ordered by
 * node give a banded J W Jᵀ (half-bandwidth ≈ 8), factorised by Cholesky in O(n). The constraint
 * forces λ/h² are then the true (converged, implicit-Euler) member forces, so yield is detected by
 * force: an active set pins every over-capacity constraint at its capacity and re-solves; what it
 * cannot hold flows plastically (rest offset/length follow, M·Δθ is plastic work). A bent column
 * under axial load therefore buckles by itself (Euler / Johnson), and hinges form where M reaches M_p.
 */

export type EndCondition = 'fixed' | 'pinned' | 'free';
type V3 = [number, number, number];

export interface BeamSimOptions {
  start: V3;
  end: V3;
  /** Profile "up" (web direction), world */
  up: V3;
  section: SectionProps;
  params: SteelParams;
  ends: { start: EndCondition; end: EndCondition };
  /** Node spacing target, m (0.1 – 0.2) */
  spacing?: number;
  /** Initial bow (stress-free geometric imperfection) as a fraction of the length, EC3: L/1000 */
  imperfection?: number;
  gravity?: V3;
}

export interface BeamStepStats {
  substeps: number;
  maxSpeed: number;
  plasticWork: number;
  ms: number;
}

const C_AXIAL = 0, C_BENDU = 1, C_BENDV = 2, C_LAT = 3, C_TLOCK = 4;
/** Plastic hinge rotation where local buckling starts, where the residual moment is reached, and
 *  where a crumpled hinge is treated as a free pin (the offset measure of bending saturates as a
 *  hinge folds towards 90°, so it is not used beyond this), rad */
const HINGE_LB = 0.08, HINGE_RES = 0.5, HINGE_PIN = 1.0;
/** Time over which a support reaction must persist to fail a bolted connection, s */
const CONNECTION_TAU = 0.02;
/** Time over which a changed imposed load is brought on, s */
const LOAD_RAMP = 0.25;
/**
 * Bearing seat (a member resting on a pier or a wall top): a guided bearing. Keeper plates hold it
 * sideways; along its axis only friction does, C_f = 0.2 for a steel bearing plate on grout
 * (EN 1993-1-8 §6.2.2(6)), so a member that bows (its chord shortens) or is pulled along its axis
 * slides on the seat instead of hanging in a catenary from pins. Nothing holds it down: a seat whose
 * reaction turns into a pull lets the member lift off.
 */
const SEAT_FRICTION = 0.2;
/**
 * Seat reactions are judged over this time, s: a reversal shorter than this lifts the end by less
 * than ≈ g τ²/2 ≈ 5 cm and it drops back onto its seat, a push shorter than this is taken by the
 * keepers' and the bolts' give. A game-level estimate.
 */
const SEAT_TAU = 0.1;

export class BeamSim {
  readonly params: SteelParams;
  readonly section: SectionProps;
  readonly n: number;
  readonly ds: number;
  /** Arc-length position of every node along the undeformed axis, m */
  readonly s0: Float64Array;
  readonly x: Float64Array;
  readonly xp: Float64Array;
  readonly v: Float64Array;
  readonly mass: Float64Array;
  readonly w: Float64Array;
  /** Node frames: tangent t, profile up u (v = t × u) */
  readonly t: Float64Array;
  readonly u: Float64Array;
  /** Node position locks (fixed / pinned supports) */
  readonly locked: Uint8Array;
  readonly lockPos: Float64Array;
  /** Ghost node (fixed end) at each end: position, active */
  ghost: [Float64Array, Float64Array] = [new Float64Array(3), new Float64Array(3)];
  ghostOn: [boolean, boolean] = [false, false];
  /** Roller (laterally held, axially free) at the loaded end: node, anchor, lateral axes, tangent lock */
  roller = -1;
  rollerPos = new Float64Array(3);
  rollerAxis = new Float64Array(3);
  rollerE = new Float64Array(6);
  rollerLock = false;
  ends: { start: EndCondition; end: EndCondition };

  /** Per node section: plate fractions (n × plates) and derived properties */
  readonly frac: Float32Array;
  readonly A: Float64Array;
  /**
   * Axial capacity of the node as an area (N_max / f_y): the remaining area, less where material
   * lost on one side makes the carried force eccentric (section.ts eccentricAxialArea).
   */
  readonly Aax: Float64Array;
  readonly Iu: Float64Array;
  readonly Iv: Float64Array;
  readonly Zu: Float64Array;
  readonly Zv: Float64Array;
  readonly Su: Float64Array;
  readonly Sv: Float64Array;

  /** Plastic state */
  readonly axRest: Float64Array;
  readonly axRest0: Float64Array;
  readonly bendRest: Float64Array;
  readonly bendPlast: Float64Array;
  /** Axial force per segment (+ tension), N, low-pass filtered over ≈ 20 ms: the per-substep λ
   * also carries position-drift corrections, which must not feed the M–N interaction. */
  readonly axForce: Float64Array;
  readonly temp: Float32Array;

  gravity: V3;
  /** Imposed load (N) and how it is applied */
  imposed = 0;
  /** Imposed load currently acting (follows `imposed`, see LOAD_RAMP), N */
  applied = 0;
  /** Persistent external point forces per node (3 per node), N */
  readonly loads: Float64Array;
  /** Total external point force this substep (loads + imposed) */
  private fext: Float64Array;
  /** Connection capacity at the supports (resultant force), N */
  connectionCapacity: number;
  plasticWork = 0;
  /** Largest plastic hinge rotation so far, rad */
  maxHinge = 0;
  /** Events since last drain */
  events: { type: 'hinge' | 'connection' | 'landed' | 'seat'; node: number; value: number }[] = [];
  /**
   * Bearing seats: held nodes that rest on a support rather than being fixed to it (checkSeat), with
   * the low-passed reaction on the member (vertical, + up; along the axis), N, and how far the seat
   * point has slid along the axis, m.
   */
  readonly seats = new Map<number, { rv: number; ax: number; slid: number }>();
  damping = 1.5;
  minSubstepDt = 1 / 480;
  maxSubsteps = 96;

  // ─── solver scratch ─────────────────────────────────────────────────────────────────────────
  private m = 0;
  private cType: Int8Array;
  private cNode: Int32Array;
  private cN: Int32Array;
  private cG: Float64Array;
  private cC: Float64Array;
  private cAlpha: Float64Array;
  private cCap: Float64Array;
  private cSlot: Int32Array;
  private cFload: Float64Array;
  private band = new BandedSPD();
  private bandCopy = new Float64Array(0);
  private rhs: Float64Array;
  private lam: Float64Array;
  private fixedSet: Uint8Array;
  private nodeMin: Int32Array;
  private nodeMax: Int32Array;
  /** Per node: the (row, slot) gradient offsets of the constraints touching it (solve scratch) */
  private static readonly MAX_NODE_ROWS = 16;
  private nodeRows: Int32Array;
  private nodeRowCount: Int32Array;

  constructor(o: BeamSimOptions | null, clone?: BeamSim, range?: [number, number]) {
    if (clone && range) {
      const [i0, i1] = range;
      this.params = clone.params;
      this.section = clone.section;
      this.n = i1 - i0 + 1;
      this.ds = clone.ds;
      this.gravity = [...clone.gravity];
      this.connectionCapacity = clone.connectionCapacity;
      this.ends = { start: i0 === 0 ? clone.ends.start : 'free', end: i1 === clone.n - 1 ? clone.ends.end : 'free' };
    } else {
      const opt = o!;
      this.params = opt.params;
      this.section = opt.section;
      const L = Math.hypot(opt.end[0] - opt.start[0], opt.end[1] - opt.start[1], opt.end[2] - opt.start[2]);
      this.n = Math.max(4, Math.round(L / (opt.spacing ?? 0.15)) + 1);
      this.ds = L / (this.n - 1);
      this.gravity = opt.gravity ?? [0, -9.80665, 0];
      this.ends = { ...opt.ends };
      // A typical full-strength end connection: shear/tension resultant ≈ 0.6·A·f_y.
      this.connectionCapacity = 0.6 * opt.section.A * opt.params.fy;
    }
    const n = this.n;
    const P = this.section.plates.length;
    this.s0 = new Float64Array(n);
    this.x = new Float64Array(3 * n);
    this.xp = new Float64Array(3 * n);
    this.v = new Float64Array(3 * n);
    this.mass = new Float64Array(n);
    this.w = new Float64Array(n);
    this.t = new Float64Array(3 * n);
    this.u = new Float64Array(3 * n);
    this.locked = new Uint8Array(n);
    this.lockPos = new Float64Array(3 * n);
    this.frac = new Float32Array(n * P).fill(1);
    this.A = new Float64Array(n);
    this.Aax = new Float64Array(n);
    this.Iu = new Float64Array(n);
    this.Iv = new Float64Array(n);
    this.Zu = new Float64Array(n);
    this.Zv = new Float64Array(n);
    this.Su = new Float64Array(n);
    this.Sv = new Float64Array(n);
    this.axRest = new Float64Array(n - 1);
    this.axRest0 = new Float64Array(n - 1);
    this.bendRest = new Float64Array(2 * n);
    this.bendPlast = new Float64Array(2 * n);
    this.axForce = new Float64Array(n - 1);
    this.temp = new Float32Array(n).fill(AMBIENT_C);
    this.loads = new Float64Array(3 * n);
    this.fext = new Float64Array(3 * n);
    const mMax = 3 * n + 8;
    this.cType = new Int8Array(mMax);
    this.cNode = new Int32Array(mMax);
    this.cN = new Int32Array(3 * mMax);
    this.cG = new Float64Array(9 * mMax);
    this.cC = new Float64Array(mMax);
    this.cAlpha = new Float64Array(mMax);
    this.cCap = new Float64Array(mMax);
    this.cSlot = new Int32Array(mMax);
    this.cFload = new Float64Array(mMax);
    this.rhs = new Float64Array(mMax);
    this.lam = new Float64Array(mMax);
    this.fixedSet = new Uint8Array(mMax);
    this.nodeMin = new Int32Array(n);
    this.nodeMax = new Int32Array(n);
    this.nodeRows = new Int32Array(n * BeamSim.MAX_NODE_ROWS);
    this.nodeRowCount = new Int32Array(n);

    if (clone && range) {
      const i0 = range[0];
      for (let i = 0; i < n; i++) {
        const j = i0 + i;
        this.s0[i] = clone.s0[j]!;
        for (let c = 0; c < 3; c++) {
          this.x[3 * i + c] = clone.x[3 * j + c]!;
          this.xp[3 * i + c] = clone.xp[3 * j + c]!;
          this.v[3 * i + c] = clone.v[3 * j + c]!;
          this.u[3 * i + c] = clone.u[3 * j + c]!;
          this.lockPos[3 * i + c] = clone.lockPos[3 * j + c]!;
        }
        this.locked[i] = clone.locked[j]!;
        for (let p = 0; p < P; p++) this.frac[i * P + p] = clone.frac[j * P + p]!;
        this.bendRest[2 * i] = clone.bendRest[2 * j]!;
        this.bendRest[2 * i + 1] = clone.bendRest[2 * j + 1]!;
        this.bendPlast[2 * i] = clone.bendPlast[2 * j]!;
        this.bendPlast[2 * i + 1] = clone.bendPlast[2 * j + 1]!;
        this.temp[i] = clone.temp[j]!;
        if (i < n - 1) {
          this.axRest[i] = clone.axRest[j]!;
          this.axRest0[i] = clone.axRest0[j]!;
        }
      }
      if (this.ends.start === 'fixed' && clone.ghostOn[0]) {
        this.ghost[0].set(clone.ghost[0]);
        this.ghostOn[0] = true;
      }
      if (this.ends.end === 'fixed' && clone.ghostOn[1]) {
        this.ghost[1].set(clone.ghost[1]);
        this.ghostOn[1] = true;
      }
      if (clone.roller >= range[0] && clone.roller <= range[1]) {
        this.roller = clone.roller - range[0];
        this.rollerPos.set(clone.rollerPos);
        this.rollerAxis.set(clone.rollerAxis);
        this.rollerE.set(clone.rollerE);
        this.rollerLock = clone.rollerLock;
      }
      for (const [j, st] of clone.seats) if (j >= i0 && j <= range[1]) this.seats.set(j - i0, { ...st });
      for (let i = 0; i < n; i++) this.updateSection(i);
      this.updateFrames();
      return;
    }

    const opt = o!;
    const [sx, sy, sz] = opt.start;
    const L = this.ds * (n - 1);
    const ax: V3 = [(opt.end[0] - sx) / L, (opt.end[1] - sy) / L, (opt.end[2] - sz) / L];
    // Profile up: the requested direction made perpendicular to the axis.
    let [ux, uy, uz] = opt.up;
    const d = ux * ax[0] + uy * ax[1] + uz * ax[2];
    ux -= d * ax[0];
    uy -= d * ax[1];
    uz -= d * ax[2];
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-6) {
      [ux, uy, uz] = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const d2 = ux * ax[0] + uy * ax[1] + uz * ax[2];
      ux -= d2 * ax[0];
      uy -= d2 * ax[1];
      uz -= d2 * ax[2];
      ul = Math.hypot(ux, uy, uz);
    }
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = ax[1] * uz - ax[2] * uy, vy = ax[2] * ux - ax[0] * uz, vz = ax[0] * uy - ax[1] * ux;
    // EC3 geometric imperfection: a half-sine bow, mostly about the weak axis (sideways, v).
    const e0 = (opt.imperfection ?? 1 / 1000) * L;
    for (let i = 0; i < n; i++) {
      const s = i * this.ds;
      this.s0[i] = s;
      const bow = Math.sin((Math.PI * s) / L);
      const bv = e0 * bow, bu = 0.3 * e0 * bow;
      this.x[3 * i] = sx + ax[0] * s + vx * bv + ux * bu;
      this.x[3 * i + 1] = sy + ax[1] * s + vy * bv + uy * bu;
      this.x[3 * i + 2] = sz + ax[2] * s + vz * bv + uz * bu;
      this.u[3 * i] = ux;
      this.u[3 * i + 1] = uy;
      this.u[3 * i + 2] = uz;
    }
    this.xp.set(this.x);
    for (let i = 0; i < n; i++) this.updateSection(i);
    for (let i = 0; i < n - 1; i++) {
      const L0 = Math.hypot(this.x[3 * i + 3]! - this.x[3 * i]!, this.x[3 * i + 4]! - this.x[3 * i + 1]!, this.x[3 * i + 5]! - this.x[3 * i + 2]!);
      this.axRest[i] = L0;
      this.axRest0[i] = L0;
    }
    this.updateFrames();
    // The imperfect shape is stress free.
    for (let i = 1; i < n - 1; i++) {
      const [du, dv] = this.offset(i, this.x);
      this.bendRest[2 * i] = du;
      this.bendRest[2 * i + 1] = dv;
    }
    this.applyEnds(ax);
  }

  /** Supports from the end conditions. The upper end of a column (loaded end) is a roller. */
  private applyEnds(ax: V3): void {
    const n = this.n;
    const vertical = Math.abs(ax[1]) > 0.7;
    const topIsEnd = ax[1] > 0;
    for (const which of [0, 1] as const) {
      const cond = which === 0 ? this.ends.start : this.ends.end;
      if (cond === 'free') continue;
      const i = which === 0 ? 0 : n - 1;
      const isTop = vertical && (which === 1) === topIsEnd;
      const otherCond = which === 0 ? this.ends.end : this.ends.start;
      if (isTop && otherCond !== 'free') {
        // Roller: held sideways, free to move along the axis so the imposed load flows down.
        this.setRoller(i, ax);
        this.rollerLock = cond === 'fixed';
        continue;
      }
      this.lock(i);
      if (cond === 'fixed') this.setGhost(which);
    }
  }

  /** Make node i a roller: held in the plane ⊥ ax through where it is now, free along ax. */
  private setRoller(i: number, ax: V3 | Float64Array): void {
    this.roller = i;
    this.rollerPos.set(this.x.subarray(3 * i, 3 * i + 3));
    this.rollerAxis.set(ax);
    const e1 = Math.abs(ax[0]!) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    const d = e1[0]! * ax[0]! + e1[1]! * ax[1]! + e1[2]! * ax[2]!;
    let a1x = e1[0]! - d * ax[0]!, a1y = e1[1]! - d * ax[1]!, a1z = e1[2]! - d * ax[2]!;
    const l = Math.hypot(a1x, a1y, a1z);
    a1x /= l;
    a1y /= l;
    a1z /= l;
    this.rollerE.set([a1x, a1y, a1z, ax[1]! * a1z - ax[2]! * a1y, ax[2]! * a1x - ax[0]! * a1z, ax[0]! * a1y - ax[1]! * a1x]);
  }

  /** The roller was added for a carried load by holdHead (not by the member's own end conditions) */
  autoRoller = false;

  /**
   * An upright member standing on a held base that starts to carry a load (an upper-storey column
   * on its splice): the floor it carries bears on its head and also holds the head sideways (the
   * floor diaphragm), so the head becomes a pinned roller like a ground-storey column's. Without
   * it the column would be a free-headed flagpole under its floor (effective length 2L). Returns
   * whether a roller was added.
   */
  holdHead(): boolean {
    if (this.roller >= 0) return false;
    const head = this.loadedHead();
    if (head < 0) return false;
    const base = head === 0 ? this.n - 1 : 0;
    const ax = new Float64Array(3);
    for (let c = 0; c < 3; c++) ax[c] = this.x[3 * head + c]! - this.x[3 * base + c]!;
    const l = Math.hypot(ax[0]!, ax[1]!, ax[2]!) || 1;
    for (let c = 0; c < 3; c++) ax[c] = ax[c]! / l;
    this.setRoller(head, ax);
    this.rollerLock = false;
    this.autoRoller = true;
    return true;
  }

  /** Is the base of an upright member (the end opposite the roller) still held? */
  baseHeld(): boolean {
    const head = this.roller >= 0 ? this.roller : this.loadedHead();
    if (head < 0) return this.locked.some((l) => l === 1);
    const base = head === 0 ? this.n - 1 : 0, next = base === 0 ? 1 : this.n - 2;
    return !!(this.locked[base] || this.locked[next]);
  }

  private lock(i: number): void {
    this.locked[i] = 1;
    this.lockPos.set(this.x.subarray(3 * i, 3 * i + 3), 3 * i);
    this.w[i] = 0;
  }

  /** Ghost node beyond a fixed end: the mirror of its neighbour, so the end tangent is clamped. */
  private setGhost(which: 0 | 1): void {
    const n = this.n;
    const i = which === 0 ? 0 : n - 1, j = which === 0 ? 1 : n - 2;
    const g = this.ghost[which];
    for (let c = 0; c < 3; c++) g[c] = 2 * this.x[3 * i + c]! - this.x[3 * j + c]!;
    this.ghostOn[which] = true;
  }

  /** Recompute a node's section properties, mass and stiffness from its plate fractions. */
  updateSection(i: number): void {
    const s = this.section;
    const d = damagedSection(s, this.frac, i * s.plates.length);
    this.A[i] = Math.max(d.A, 1e-9);
    this.Aax[i] = Math.max(Math.min(d.A, eccentricAxialArea(s, this.frac, i * s.plates.length)), 1e-9);
    this.Iu[i] = Math.max(d.Iy, 1e-14);
    this.Iv[i] = Math.max(d.Iz, 1e-14);
    this.Zu[i] = d.Zy;
    this.Zv[i] = d.Zz;
    this.Su[i] = d.Sy;
    this.Sv[i] = d.Sz;
    const end = i === 0 || i === this.n - 1;
    const m = this.params.rho * this.A[i]! * this.ds * (end ? 0.5 : 1);
    this.mass[i] = m;
    if (!this.locked[i]) this.w[i] = m > 0 ? 1 / (m + this.loadMass(i)) : 0;
  }

  /** Mass of the carried load riding on node i (imposed load as a mass, see step), kg */
  private loadMass(i: number): number {
    const g = Math.hypot(...this.gravity);
    if (!(g > 1e-6) || !(this.applied > 0)) return 0;
    const head = this.loadedHead();
    if (head >= 0) return i === head ? this.applied / g : 0;
    return this.applied / (this.n * g);
  }

  /**
   * Node the carried load bears on: the roller of a column with a loaded head, or the top node of
   * an upright member standing on its base (an upper-storey column: the floor rides on its head,
   * not along its shaft); −1 for a member carrying its load along its length (a beam under a slab).
   */
  loadedHead(): number {
    if (this.roller >= 0) return this.roller;
    const n = this.n, L0 = this.s0[n - 1]! - this.s0[0]!;
    const dy = this.x[3 * (n - 1) + 1]! - this.x[1]!;
    if (Math.abs(dy) < 0.7 * L0) return -1;
    const top = dy > 0 ? n - 1 : 0, base = top === 0 ? n - 1 : 0;
    return this.locked[base] || this.locked[base === 0 ? 1 : n - 2] ? top : -1;
  }

  /** Inverse mass of node i: its steel plus the load it carries (0 when held). */
  private refreshW(i: number): void {
    if (this.locked[i] || !(this.mass[i]! > 0)) {
      if (this.locked[i]) this.w[i] = 0;
      return;
    }
    this.w[i] = 1 / (this.mass[i]! + this.loadMass(i));
  }

  /** Remaining area fraction of node i. */
  areaFraction(i: number): number {
    return this.A[i]! / this.section.A;
  }

  /** Node offset from the midpoint of its neighbours in the node frame (u, v components). */
  offset(i: number, x: Float64Array): [number, number] {
    const a = this.prevPos(i, x), b = this.nextPos(i, x);
    const dx = x[3 * i]! - 0.5 * (a[0] + b[0]), dy = x[3 * i + 1]! - 0.5 * (a[1] + b[1]), dz = x[3 * i + 2]! - 0.5 * (a[2] + b[2]);
    const ux = this.u[3 * i]!, uy = this.u[3 * i + 1]!, uz = this.u[3 * i + 2]!;
    const tx = this.t[3 * i]!, ty = this.t[3 * i + 1]!, tz = this.t[3 * i + 2]!;
    const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
    return [dx * ux + dy * uy + dz * uz, dx * vx + dy * vy + dz * vz];
  }

  private readonly pa: V3 = [0, 0, 0];
  private readonly pb: V3 = [0, 0, 0];
  private prevPos(i: number, x: Float64Array): V3 {
    if (i > 0) {
      this.pa[0] = x[3 * i - 3]!;
      this.pa[1] = x[3 * i - 2]!;
      this.pa[2] = x[3 * i - 1]!;
    } else {
      const g = this.ghost[0];
      this.pa[0] = g[0]!;
      this.pa[1] = g[1]!;
      this.pa[2] = g[2]!;
    }
    return this.pa;
  }
  private nextPos(i: number, x: Float64Array): V3 {
    if (i < this.n - 1) {
      this.pb[0] = x[3 * i + 3]!;
      this.pb[1] = x[3 * i + 4]!;
      this.pb[2] = x[3 * i + 5]!;
    } else {
      const g = this.ghost[1];
      this.pb[0] = g[0]!;
      this.pb[1] = g[1]!;
      this.pb[2] = g[2]!;
    }
    return this.pb;
  }

  /** Tangents by central differences; profile-up vectors transported (projected) onto them. */
  updateFrames(): void {
    const n = this.n, x = this.x;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = x[3 * b]! - x[3 * a]!, ty = x[3 * b + 1]! - x[3 * a + 1]!, tz = x[3 * b + 2]! - x[3 * a + 2]!;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      this.t[3 * i] = tx;
      this.t[3 * i + 1] = ty;
      this.t[3 * i + 2] = tz;
      let ux = this.u[3 * i]!, uy = this.u[3 * i + 1]!, uz = this.u[3 * i + 2]!;
      const d = ux * tx + uy * ty + uz * tz;
      ux -= d * tx;
      uy -= d * ty;
      uz -= d * tz;
      const ul = Math.hypot(ux, uy, uz) || 1;
      this.u[3 * i] = ux / ul;
      this.u[3 * i + 1] = uy / ul;
      this.u[3 * i + 2] = uz / ul;
    }
  }

  /** Bending cap of node i about one axis: generalised force 2·M/ds. */
  private bendCap(i: number, axis: 0 | 1): number {
    const P = this.params;
    const S = axis === 0 ? this.Su[i]! : this.Sv[i]!;
    const Z = axis === 0 ? this.Zu[i]! : this.Zv[i]!;
    const I = axis === 0 ? this.Iu[i]! : this.Iv[i]!;
    const c = axis === 0 ? this.section.cy : this.section.cz;
    const My = S * P.fy, Mp = Math.max(Z * P.fy, My);
    const thy = ((My / (P.E * I)) * this.ds);
    const th = this.bendPlast[2 * i + axis]!;
    // Spread of plasticity through the section (M_y → M_p over ≈ 2 θ_y of plastic rotation), then
    // linear strain hardening on the extreme fibre strain κ_p·c.
    let M = My + (Mp - My) * (1 - Math.exp(-th / (2 * thy)));
    M *= Math.min(P.fu / P.fy, 1 + (P.H / P.fy) * ((th / this.ds) * c));
    // M–N interaction (rectangular-section form M_N = M_p (1 − n²)).
    const Np = Math.max(1, this.A[i]! * P.fy);
    const N = 0.5 * (Math.abs(this.axForce[Math.max(0, i - 1)]!) + Math.abs(this.axForce[Math.min(this.n - 2, i)]!));
    const nn = Math.min(0.9, N / Np);
    M *= 1 - nn * nn;
    // Past its rotation capacity the compression flange buckles locally and the hinge moment falls
    // towards a residual ≈ 0.3 M_p (Gioncu & Petcu, J. Constr. Steel Res. 43, 1997: available
    // rotation capacity of wide-flange beam-columns ≈ 0.05–0.1 rad at high axial load).
    if (th > HINGE_LB) M *= Math.max(0.3, 1 - (0.7 * (th - HINGE_LB)) / (HINGE_RES - HINGE_LB));
    return (2 * M) / this.ds;
  }

  private axialCap(seg: number): number {
    const P = this.params;
    const A = Math.min(this.Aax[seg]!, this.Aax[seg + 1]!);
    const eps = Math.abs(this.axRest[seg]! / this.axRest0[seg]! - 1);
    return A * Math.min(P.fy + P.H * eps, P.fu);
  }

  /** Add a constraint; returns its index. */
  private addC(type: number, node: number, slot: number, alpha: number, cap: number): number {
    const j = this.m++;
    this.cType[j] = type;
    this.cNode[j] = node;
    this.cSlot[j] = slot;
    this.cAlpha[j] = alpha;
    this.cCap[j] = cap;
    this.cN[3 * j] = this.cN[3 * j + 1] = this.cN[3 * j + 2] = -1;
    return j;
  }

  private setG(j: number, k: number, node: number, gx: number, gy: number, gz: number): void {
    this.cN[3 * j + k] = node;
    this.cG[9 * j + 3 * k] = gx;
    this.cG[9 * j + 3 * k + 1] = gy;
    this.cG[9 * j + 3 * k + 2] = gz;
  }

  /** Build constraint rows (values, gradients) at the current (predicted) positions. */
  private assemble(): void {
    this.m = 0;
    const n = this.n, x = this.x, E = this.params.E, ds = this.ds;
    for (let i = 0; i < n; i++) {
      if (i === this.roller) {
        for (let a = 0; a < 2; a++) {
          const ex = this.rollerE[3 * a]!, ey = this.rollerE[3 * a + 1]!, ez = this.rollerE[3 * a + 2]!;
          const j = this.addC(C_LAT, i, a, 0, Infinity);
          this.setG(j, 0, i, ex, ey, ez);
          this.cC[j] = (x[3 * i]! - this.rollerPos[0]!) * ex + (x[3 * i + 1]! - this.rollerPos[1]!) * ey + (x[3 * i + 2]! - this.rollerPos[2]!) * ez;
        }
      }
      const interior = i > 0 && i < n - 1;
      const ghostHere = (i === 0 && this.ghostOn[0]) || (i === n - 1 && this.ghostOn[1]);
      if (interior || ghostHere) {
        const ux = this.u[3 * i]!, uy = this.u[3 * i + 1]!, uz = this.u[3 * i + 2]!;
        const tx = this.t[3 * i]!, ty = this.t[3 * i + 1]!, tz = this.t[3 * i + 2]!;
        const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
        const [du, dv] = this.offset(i, x);
        for (let axis = 0; axis < 2; axis++) {
          if (this.bendPlast[2 * i + axis]! > HINGE_PIN) continue;
          const gx = axis === 0 ? ux : vx, gy = axis === 0 ? uy : vy, gz = axis === 0 ? uz : vz;
          const I = axis === 0 ? this.Iu[i]! : this.Iv[i]!;
          const j = this.addC(axis === 0 ? C_BENDU : C_BENDV, i, axis, ds * ds * ds / (4 * E * I), this.bendCap(i, axis as 0 | 1));
          let k = 0;
          if (i > 0) this.setG(j, k++, i - 1, -0.5 * gx, -0.5 * gy, -0.5 * gz);
          this.setG(j, k++, i, gx, gy, gz);
          if (i < n - 1) this.setG(j, k++, i + 1, -0.5 * gx, -0.5 * gy, -0.5 * gz);
          this.cC[j] = (axis === 0 ? du : dv) - this.bendRest[2 * i + axis]!;
        }
      }
      if (i === this.roller && this.rollerLock) {
        // Clamped roller: the end tangent stays on the original axis.
        const nb = i === 0 ? 1 : i - 1;
        for (let a = 0; a < 2; a++) {
          const ex = this.rollerE[3 * a]!, ey = this.rollerE[3 * a + 1]!, ez = this.rollerE[3 * a + 2]!;
          const j = this.addC(C_TLOCK, i, a, 0, Infinity);
          this.setG(j, 0, nb, -ex, -ey, -ez);
          this.setG(j, 1, i, ex, ey, ez);
          this.cC[j] = (x[3 * i]! - x[3 * nb]!) * ex + (x[3 * i + 1]! - x[3 * nb + 1]!) * ey + (x[3 * i + 2]! - x[3 * nb + 2]!) * ez;
        }
      }
      if (i < n - 1) {
        const dx = x[3 * i + 3]! - x[3 * i]!, dy = x[3 * i + 4]! - x[3 * i + 1]!, dz = x[3 * i + 5]! - x[3 * i + 2]!;
        const l = Math.hypot(dx, dy, dz) || 1e-9;
        const A = 0.5 * (this.A[i]! + this.A[i + 1]!);
        const j = this.addC(C_AXIAL, i, i, this.axRest[i]! / (E * A), this.axialCap(i));
        this.setG(j, 0, i, -dx / l, -dy / l, -dz / l);
        this.setG(j, 1, i + 1, dx / l, dy / l, dz / l);
        this.cC[j] = l - this.axRest[i]!;
      }
    }
  }

  /**
   * Solve the linearised constraint system globally (banded Cholesky) with an active set for
   * yield: constraints beyond capacity are held at capacity and the rest re-solved.
   */
  private solve(h: number): void {
    const m = this.m, n = this.n, w = this.w;
    const h2 = h * h;
    this.nodeMin.fill(1 << 30);
    this.nodeMax.fill(-1);
    for (let j = 0; j < m; j++) {
      for (let k = 0; k < 3; k++) {
        const nd = this.cN[3 * j + k]!;
        if (nd < 0) continue;
        if (j < this.nodeMin[nd]!) this.nodeMin[nd] = j;
        if (j > this.nodeMax[nd]!) this.nodeMax[nd] = j;
      }
    }
    let bw = 1;
    for (let i = 0; i < n; i++) if (this.nodeMax[i]! >= 0) bw = Math.max(bw, this.nodeMax[i]! - this.nodeMin[i]!);
    const band = this.band;
    band.resize(m, bw);
    // A = J W Jᵀ + α̃, accumulated node by node over the (row, slot) pairs touching each node
    // (gathered once: at most ~12 rows touch a node), straight into the band storage.
    const nr = this.nodeRowCount, rows = this.nodeRows, MAXR = BeamSim.MAX_NODE_ROWS;
    nr.fill(0);
    for (let j = 0; j < m; j++) {
      for (let k = 0; k < 3; k++) {
        const nd = this.cN[3 * j + k]!;
        if (nd < 0 || w[nd] === 0) continue;
        const c = nr[nd]!;
        if (c >= MAXR) continue;
        rows[nd * MAXR + c] = 9 * j + 3 * k;
        nr[nd] = c + 1;
      }
    }
    const A = band.a, W1 = bw + 1, G = this.cG;
    for (let i = 0; i < n; i++) {
      const wi = w[i]!;
      const cnt = nr[i]!;
      if (wi === 0 || cnt === 0) continue;
      const base = i * MAXR;
      for (let p = 0; p < cnt; p++) {
        const ga = rows[base + p]!;
        const a = (ga / 9) | 0;
        const gax = G[ga]!, gay = G[ga + 1]!, gaz = G[ga + 2]!;
        for (let q = 0; q <= p; q++) {
          const gb = rows[base + q]!;
          const b = (gb / 9) | 0;
          const d = wi * (gax * G[gb]! + gay * G[gb + 1]! + gaz * G[gb + 2]!);
          // Rows are gathered in increasing order, so a ≥ b.
          const hi = a >= b ? a : b, lo = a >= b ? b : a;
          A[hi * W1 + (lo - hi + bw)] = A[hi * W1 + (lo - hi + bw)]! + (a === b && p !== q ? 2 * d : d);
        }
      }
    }
    for (let j = 0; j < m; j++) {
      // Rows with no free node would be singular: make them trivially solvable.
      if (band.get(j, j) <= 1e-30) band.add(j, j, 1);
      band.add(j, j, this.cAlpha[j]! / h2 + 1e-12 * band.get(j, j));
    }
    const need = m * (bw + 1);
    if (this.bandCopy.length < need) this.bandCopy = new Float64Array(need);
    this.bandCopy.set(band.a.subarray(0, need));
    this.fixedSet.fill(0, 0, m);
    const lam = this.lam, rhs = this.rhs;
    lam.fill(0, 0, m);
    // Point loads enter linearly: J·Δx must also cancel the load's displacement W·f·h².
    const f = this.fext;
    const cF = this.cFload;
    for (let j = 0; j < m; j++) {
      let acc = 0;
      for (let k = 0; k < 3; k++) {
        const nd = this.cN[3 * j + k]!;
        if (nd < 0) continue;
        const wn = w[nd]!;
        if (wn === 0) continue;
        acc += wn * (this.cG[9 * j + 3 * k]! * f[3 * nd]! + this.cG[9 * j + 3 * k + 1]! * f[3 * nd + 1]! + this.cG[9 * j + 3 * k + 2]! * f[3 * nd + 2]!);
      }
      cF[j] = acc * h2;
    }
    // Active set (rigid–plastic complementarity): a constraint beyond capacity is held at ±capacity;
    // a held constraint whose solved flow opposes its force would be unloading, so it is released
    // back to rigid. Converges in a few passes for the handful of hinges a member forms at once.
    // Each pass solves the free constraints with the held ones at their caps; the last solve is
    // always one for the final set, so λ is consistent (free rows exactly satisfied) even when the
    // set is still changing after the pass limit (then counted in activeSetUnconverged).
    const solveFor = (): boolean => {
      band.a.set(this.bandCopy.subarray(0, need));
      for (let j = 0; j < m; j++) rhs[j] = -this.cC[j]! - cF[j]!;
      for (let j = 0; j < m; j++) {
        if (!this.fixedSet[j]) continue;
        for (let k = Math.max(0, j - bw); k <= Math.min(m - 1, j + bw); k++) {
          if (k !== j && !this.fixedSet[k]) rhs[k] = rhs[k]! - this.bandGetCopy(k, j, bw) * lam[j]!;
        }
      }
      for (let j = 0; j < m; j++) {
        if (!this.fixedSet[j]) continue;
        band.pin(j);
        rhs[j] = lam[j]!;
      }
      this.passes++;
      if (!band.factor()) {
        this.factorFailures++;
        return false;
      }
      band.solve(rhs);
      for (let j = 0; j < m; j++) if (!this.fixedSet[j]) lam[j] = rhs[j]!;
      return true;
    };
    let settled = false;
    for (let pass = 0; pass < 12 && !settled; pass++) {
      if (!solveFor()) break;
      let changed = false;
      for (let j = 0; j < m; j++) {
        const cap = this.cCap[j]! * h2;
        if (!this.fixedSet[j]) {
          if (Math.abs(lam[j]!) > cap) {
            lam[j] = Math.sign(lam[j]!) * cap;
            this.fixedSet[j] = 1;
            changed = true;
          }
          continue;
        }
        // Linearised post-solve violation beyond the elastic part: e = C + J·Δx + α̃λ = (A λ)_j + C + load.
        let e = this.cC[j]! + cF[j]!;
        for (let k = Math.max(0, j - bw); k <= Math.min(m - 1, j + bw); k++) e += this.bandGetCopy(j, k, bw) * lam[k]!;
        // XPBD sign: λ < 0 pulls back a positive violation, so plastic flow must have e·λ < 0.
        if (e * lam[j]! > 0) {
          this.fixedSet[j] = 0;
          changed = true;
        }
      }
      settled = !changed;
    }
    if (!settled) {
      this.activeSetUnconverged++;
      solveFor();
    }
    // Apply Δx = W (Jᵀ Δλ + f h²).
    for (let i = 0; i < n; i++) {
      const wi = w[i]!;
      if (wi === 0) continue;
      this.x[3 * i] = this.x[3 * i]! + wi * f[3 * i]! * h2;
      this.x[3 * i + 1] = this.x[3 * i + 1]! + wi * f[3 * i + 1]! * h2;
      this.x[3 * i + 2] = this.x[3 * i + 2]! + wi * f[3 * i + 2]! * h2;
    }
    for (let j = 0; j < m; j++) {
      const L = lam[j]!;
      if (L === 0) continue;
      for (let k = 0; k < 3; k++) {
        const nd = this.cN[3 * j + k]!;
        if (nd < 0) continue;
        const s = w[nd]! * L;
        this.x[3 * nd] = this.x[3 * nd]! + s * this.cG[9 * j + 3 * k]!;
        this.x[3 * nd + 1] = this.x[3 * nd + 1]! + s * this.cG[9 * j + 3 * k + 1]!;
        this.x[3 * nd + 2] = this.x[3 * nd + 2]! + s * this.cG[9 * j + 3 * k + 2]!;
      }
    }
  }

  private bandGetCopy(i: number, j: number, bw: number): number {
    if (j > i) {
      const t = i;
      i = j;
      j = t;
    }
    if (i - j > bw) return 0;
    return this.bandCopy[i * (bw + 1) + (j - i + bw)]!;
  }

  private slotOf(j: number, node: number): number {
    for (let k = 0; k < 3; k++) if (this.cN[3 * j + k] === node) return k;
    return -1;
  }

  /** Held constraints flowed: rest follows (elastic part = capacity/k), work = capacity × flow. */
  private flow(h: number): void {
    const h2 = h * h;
    const x = this.x;
    for (let j = 0; j < this.m; j++) {
      const type = this.cType[j]!;
      const lam = this.lam[j]!;
      if (type === C_AXIAL) {
        const a = Math.min(1, h / 0.02);
        const sl = this.cSlot[j]!;
        this.axForce[sl] = this.axForce[sl]! + a * (-lam / h2 - this.axForce[sl]!);
      }
      if (!this.fixedSet[j]) continue;
      const force = Math.abs(lam) / h2;
      if (type === C_LAT || type === C_TLOCK) continue;
      const i = this.cNode[j]!;
      // Current constraint value and the rest that leaves exactly the elastic part λ·α/h².
      let value: number;
      if (type === C_AXIAL) {
        value = Math.hypot(x[3 * i + 3]! - x[3 * i]!, x[3 * i + 4]! - x[3 * i + 1]!, x[3 * i + 5]! - x[3 * i + 2]!);
        const rest = value + (lam * this.cAlpha[j]!) / h2;
        const d = rest - this.axRest[i]!;
        this.axRest[i] = rest;
        this.addWork(force * Math.abs(d), i, i + 1);
      } else {
        const axis = type === C_BENDU ? 0 : 1;
        value = this.offset(i, x)[axis]!;
        const rest = value + (lam * this.cAlpha[j]!) / h2;
        const d = rest - this.bendRest[2 * i + axis]!;
        this.bendRest[2 * i + axis] = rest;
        const dth = (2 * Math.abs(d)) / this.ds;
        const before = this.bendPlast[2 * i + axis]!;
        this.bendPlast[2 * i + axis] = before + dth;
        if (before < 0.02 && before + dth >= 0.02) this.events.push({ type: 'hinge', node: i, value: before + dth });
        this.maxHinge = Math.max(this.maxHinge, before + dth);
        this.addWork(force * Math.abs(d), i, i);
      }
    }
  }

  private addWork(work: number, a: number, b: number): void {
    this.plasticWork += work;
    const q = (TAYLOR_QUINNEY * work) / this.params.c;
    const ma = this.mass[a]!, mb = this.mass[b]!;
    if (a === b) this.temp[a] = Math.min(1500, this.temp[a]! + q / Math.max(ma, 1e-6));
    else {
      this.temp[a] = Math.min(1500, this.temp[a]! + (0.5 * q) / Math.max(ma, 1e-6));
      this.temp[b] = Math.min(1500, this.temp[b]! + (0.5 * q) / Math.max(mb, 1e-6));
    }
  }

  /** Support reactions of locked nodes → release a connection that is overloaded. */
  /** Low-passed support reactions [start, end]: axial (+ = tension) and shear, N */
  private reactN = [0, 0];
  private reactLat = 0;
  /** Diagnostics: constraint systems that were not positive definite (solve skipped) */
  factorFailures = 0;
  /** Diagnostics: substeps whose yield active set had not settled after the pass limit */
  activeSetUnconverged = 0;
  /** Diagnostics: banded factorisations done (active-set passes over all substeps) */
  passes = 0;
  private reactV = [0, 0];

  private checkConnections(h: number): void {
    const h2 = h * h;
    const n = this.n;
    for (const i of [0, n - 1]) {
      if (!this.locked[i]) continue;
      // Reaction = constraint forces on the support node plus on its ghost (the ghost is part of
      // the support: a bending constraint's forces are self-equilibrated over its three points).
      let fx = 0, fy = 0, fz = 0;
      const ghost = (i === 0 && this.ghostOn[0]) || (i === n - 1 && this.ghostOn[1]);
      for (let j = 0; j < this.m; j++) {
        const k = this.slotOf(j, i);
        if (k < 0) continue;
        const type = this.cType[j]!;
        let s = this.lam[j]! / h2;
        // Bending row centred on the support node: its ghost carries −½ of the centre gradient.
        if (ghost && this.cNode[j] === i && (type === C_BENDU || type === C_BENDV)) s *= 0.5;
        fx += s * this.cG[9 * j + 3 * k]!;
        fy += s * this.cG[9 * j + 3 * k + 1]!;
        fz += s * this.cG[9 * j + 3 * k + 2]!;
      }
      // Split into the member-axis part (τ from the support into the member) and shear. Compression
      // goes into the support in bearing and never fails the connection; tension is resisted by the
      // anchors / bolts (connectionCapacity), shear by the bolts plus friction under the compression
      // (C_f = 0.2, EN 1993-1-8 §6.2.2). Both are low-passed over CONNECTION_TAU: slip and bolt
      // deformation spread a millisecond reaction spike, so only a sustained overload fails it.
      const nb = i === 0 ? 1 : n - 2;
      let tx = this.x[3 * nb]! - this.x[3 * i]!, ty = this.x[3 * nb + 1]! - this.x[3 * i + 1]!, tz = this.x[3 * nb + 2]! - this.x[3 * i + 2]!;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      const Nt = fx * tx + fy * ty + fz * tz;
      const V = Math.hypot(fx - Nt * tx, fy - Nt * ty, fz - Nt * tz);
      const e = i === 0 ? 0 : 1;
      const a = 1 - Math.exp(-h / CONNECTION_TAU);
      this.reactN[e] = this.reactN[e]! + a * (Nt - this.reactN[e]!);
      this.reactV[e] = this.reactV[e]! + a * (V - this.reactV[e]!);
      const cap = this.connectionCapacity;
      const shearCap = cap / Math.sqrt(3) + 0.2 * Math.max(0, -this.reactN[e]!);
      if (this.reactN[e]! > 1.5 * cap || this.reactV[e]! > 1.5 * shearCap) this.releaseNode(i);
    }
    for (const [i, st] of this.seats) this.checkSeat(i, st, h);
    if (this.roller >= 0) {
      // Head connection in shear: bolts plus friction under the carried load, low-passed as above.
      let fl2 = 0;
      for (let j = 0; j < this.m; j++) if (this.cType[j] === C_LAT) fl2 += (this.lam[j]! / h2) ** 2;
      const a = 1 - Math.exp(-h / CONNECTION_TAU);
      this.reactLat += a * (Math.sqrt(fl2) - this.reactLat);
      if (this.reactLat > 1.5 * (this.connectionCapacity / Math.sqrt(3) + 0.2 * this.applied)) this.releaseRoller();
    }
  }

  /**
   * A bearing seat under node i. The reaction the member gets there (the constraint forces on the
   * held node, reversed, plus the node's own weight) is split into its vertical part and its part
   * along the member axis. Along the axis the seat holds only by friction: any excess over
   * C_f · R_v slides the seat point with the member, by the excess over the axial stiffness of the
   * span (EA / L, half of it per substep, so the slip settles without overshoot). The vertical part
   * is low-passed over CONNECTION_TAU like a bolted connection's reaction: once the seat would have
   * to pull the member down (it lifts off) it lets go. A member that slides off the end of its seat
   * is released by SteelBeam (it knows the seat's extent).
   */
  private checkSeat(i: number, st: { rv: number; ax: number; slid: number }, h: number): void {
    if (!this.locked[i]) {
      this.seats.delete(i);
      return;
    }
    const h2 = h * h;
    let fx = 0, fy = 0, fz = 0;
    for (let j = 0; j < this.m; j++) {
      const k = this.slotOf(j, i);
      if (k < 0) continue;
      const s = this.lam[j]! / h2;
      fx += s * this.cG[9 * j + 3 * k]!;
      fy += s * this.cG[9 * j + 3 * k + 1]!;
      fz += s * this.cG[9 * j + 3 * k + 2]!;
    }
    const [gx, gy, gz] = this.gravity;
    const g = Math.hypot(gx, gy, gz);
    const m = this.mass[i]!;
    // Reaction on the member: −(what its constraints push the node with) − the node's own weight.
    const rx = -fx - m * gx, ry = -fy - m * gy, rz = -fz - m * gz;
    const ux = g > 1e-6 ? -gx / g : 0, uy = g > 1e-6 ? -gy / g : 1, uz = g > 1e-6 ? -gz / g : 0;
    const rv = rx * ux + ry * uy + rz * uz;
    // Member axis at the seat, in the seat plane.
    let tx = this.t[3 * i]!, ty = this.t[3 * i + 1]!, tz = this.t[3 * i + 2]!;
    const tu = tx * ux + ty * uy + tz * uz;
    tx -= tu * ux;
    ty -= tu * uy;
    tz -= tu * uz;
    const tl = Math.hypot(tx, ty, tz);
    const a = 1 - Math.exp(-h / SEAT_TAU);
    st.rv += a * (rv - st.rv);
    if (tl > 1e-6) {
      tx /= tl;
      ty /= tl;
      tz /= tl;
      const rax = rx * tx + ry * ty + rz * tz;
      st.ax += a * (rax - st.ax);
      // Friction acts at once: whatever the seat would have to hold beyond it slides the seat point
      // the way the member pulls the node (−reaction), by half the slip that relieves the excess
      // over the stiffness of the bar next to it, EA / ds (a displaced support loads that bar
      // first; a sustained pull over the span is relieved over a few substeps without launching an
      // axial wave).
      const excess = Math.abs(rax) - SEAT_FRICTION * Math.max(0, rv);
      if (excess > 0) {
        const d = (-Math.sign(rax) * 0.5 * excess * this.ds) / (this.params.E * Math.max(this.A[i]!, 1e-9));
        this.lockPos[3 * i] = this.lockPos[3 * i]! + d * tx;
        this.lockPos[3 * i + 1] = this.lockPos[3 * i + 1]! + d * ty;
        this.lockPos[3 * i + 2] = this.lockPos[3 * i + 2]! + d * tz;
        st.slid += d;
      }
    }
    if (g > 1e-6 && st.rv < -0.05 * m * g) {
      this.releaseNode(i);
      this.events.push({ type: 'seat', node: i, value: -1 });
    }
  }

  /** Make held node i a bearing seat (it rests on its support, see checkSeat). */
  setSeat(i: number): void {
    if (this.locked[i]) this.seats.set(i, { rv: 0, ax: 0, slid: 0 });
  }

  /** Free a support (connection failed or anchor released). */
  releaseNode(i: number): void {
    if (!this.locked[i]) return;
    this.seats.delete(i);
    this.locked[i] = 0;
    this.refreshW(i);
    if (i === 0) {
      this.ghostOn[0] = false;
      this.ends.start = 'free';
    }
    if (i === this.n - 1) {
      this.ghostOn[1] = false;
      this.ends.end = 'free';
    }
    this.events.push({ type: 'connection', node: i, value: 0 });
  }

  /** The head connection failed while loaded: released together with the load, next step */
  private rollerPending = false;

  releaseRoller(): void {
    if (this.roller < 0) return;
    if (this.imposed > 0) {
      // Still loaded: the slab slides off as the head lets go. Do both at the start of the next
      // step, so constraint forces sized for the load are never applied to the bare end node.
      if (!this.rollerPending) {
        this.rollerPending = true;
        if (this.landedNode < 0) this.landedNode = this.roller;
      }
      return;
    }
    const i = this.roller;
    this.roller = -1;
    if (i === 0) this.ends.start = 'free';
    else this.ends.end = 'free';
    // The head connection sheared off: what it carried slides off the member.
    this.imposed = 0;
    this.events.push({ type: 'connection', node: i, value: 0 });
  }

  /** Lock node i where it is now (a new support). */
  anchorNode(i: number): void {
    this.lock(i);
  }

  get freeFloating(): boolean {
    return this.roller < 0 && !this.locked.some((l) => l === 1);
  }

  /** Apply an impulse (N·s, world) at arc position s along the member. */
  addImpulse(s: number, jx: number, jy: number, jz: number): void {
    const f = Math.min(this.n - 1.000001, Math.max(0, s / this.ds));
    const i = Math.floor(f), a = f - i;
    for (const [node, wt] of [[i, 1 - a], [i + 1, a]] as const) {
      this.refreshW(node);
      const w = this.w[node]!;
      if (w === 0 || wt <= 0) continue;
      this.v[3 * node] = this.v[3 * node]! + jx * wt * w;
      this.v[3 * node + 1] = this.v[3 * node + 1]! + jy * wt * w;
      this.v[3 * node + 2] = this.v[3 * node + 2]! + jz * wt * w;
    }
  }

  /**
   * Advance by dt (any dt in (0, 1/60]). Substeps: at least dt/minSubstepDt, more while nodes move
   * fast relative to each other (≤ 5 % of the spacing of relative travel per substep, so the single
   * linearisation per substep stays accurate through large hinge rotations).
   */
  step(dt: number): BeamStepStats {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const n = this.n, x = this.x, v = this.v, w = this.w;
    if (this.landedNode >= 0) {
      // The load has come down: slab and ground crush the member between them — an inelastic
      // event that leaves it at rest — and from now on the load bears on the ground and debris.
      const i = this.landedNode;
      this.landedNode = -1;
      const head = this.roller;
      this.imposed = 0;
      this.applied = 0;
      v.fill(0, 0, 3 * n);
      this.rollerPending = false;
      this.releaseRoller();
      // The slab now lies on the crushed head and pins it where it came to rest.
      if (head >= 0) this.lock(head);
      this.events.push({ type: 'landed', node: i, value: 0 });
    }
    // Dead load is applied quasi-statically: the carried load follows `imposed` over LOAD_RAMP (a
    // step change on the undamped load mass would ring at twice the load). Removal is immediate.
    if (this.imposed <= 0) this.applied = 0;
    else {
      const rate = (Math.max(this.imposed, this.applied) / LOAD_RAMP) * dt;
      this.applied += Math.max(-rate, Math.min(rate, this.imposed - this.applied));
    }
    const nsub = this.desiredSubsteps(dt);
    const h = dt / nsub;
    const w0 = this.plasticWork;
    // The imposed load is the weight of what the member carries (a floor, a roof), so it also has
    // that mass: M = P/g rides on the loaded node(s). It cannot fall faster than g when the member
    // gives way, and the energy it feeds in is bounded by P·Δ (a constant force on a 20 kg node
    // would not be).
    // Gravity (an acceleration in the prediction) then supplies the load as that mass's weight, so
    // the load is not also added as a force. Without gravity it stays a plain force.
    const loadAsMass = Math.hypot(...this.gravity) > 1e-6;
    for (let i = 0; i < n; i++) this.refreshW(i);
    // Imposed load: at the roller (column head) or spread along a horizontal member.
    const [gx, gy, gz] = this.gravity;
    const head = this.loadedHead();
    for (let s = 0; s < nsub; s++) {
      const damp = Math.exp(-this.damping * h);
      const f = this.fext;
      for (let i = 0; i < n; i++) {
        const k = 3 * i;
        this.xp[k] = x[k]!;
        this.xp[k + 1] = x[k + 1]!;
        this.xp[k + 2] = x[k + 2]!;
        f[k] = this.loads[k]!;
        f[k + 1] = this.loads[k + 1]!;
        f[k + 2] = this.loads[k + 2]!;
        if (this.applied > 0 && !loadAsMass) {
          if (head >= 0) {
            if (i === head) f[k + 1] = f[k + 1]! - this.applied;
          } else f[k + 1] = f[k + 1]! - this.applied / n;
        }
        if (w[i] === 0) continue;
        // Gravity is a uniform acceleration (tiny g·h² displacement): it stays in the prediction.
        // Point loads do not: F·h²/m on a light end node can be a large fraction of the spacing,
        // and linearising the constraints there would be wildly wrong. They enter the solve's
        // right-hand side instead (see solve), i.e. the linearisation sees only the net motion.
        // Structural damping acts on the member's own mass, not on the load it carries.
        const di = damp + (1 - damp) * (1 - this.mass[i]! * w[i]!);
        v[k] = (v[k]! + gx * h) * di;
        v[k + 1] = (v[k + 1]! + gy * h) * di;
        v[k + 2] = (v[k + 2]! + gz * h) * di;
        x[k] = x[k]! + v[k]! * h;
        x[k + 1] = x[k + 1]! + v[k + 1]! * h;
        x[k + 2] = x[k + 2]! + v[k + 2]! * h;
      }
      for (let i = 0; i < n; i++) {
        if (!this.locked[i]) continue;
        x[3 * i] = this.lockPos[3 * i]!;
        x[3 * i + 1] = this.lockPos[3 * i + 1]!;
        x[3 * i + 2] = this.lockPos[3 * i + 2]!;
      }
      this.assemble();
      this.solve(h);
      this.flow(h);
      this.checkConnections(h);
      this.groundContact();
      const inv = 1 / h;
      for (let i = 0; i < n; i++) {
        const k = 3 * i;
        if (w[i] === 0) {
          v[k] = v[k + 1] = v[k + 2] = 0;
          continue;
        }
        v[k] = (x[k]! - this.xp[k]!) * inv;
        v[k + 1] = (x[k + 1]! - this.xp[k + 1]!) * inv;
        v[k + 2] = (x[k + 2]! - this.xp[k + 2]!) * inv;
      }
      this.updateFrames();
    }
    let maxV = 0;
    for (let i = 0; i < 3 * n; i++) {
      if (!Number.isFinite(x[i]!)) {
        // Numerical safety net: never let a bad node poison the member.
        x[i] = this.xp[i]!;
        v[i] = 0;
      }
      maxV = Math.max(maxV, Math.abs(v[i]!));
    }
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return { substeps: nsub, maxSpeed: maxV, plasticWork: this.plasticWork - w0, ms: t1 - t0 };
  }

  /**
   * Substeps `step(dt)` takes: at least dt/minSubstepDt, more while nodes move fast relative to
   * each other (≤ 5 % of the spacing of relative travel per substep), at most maxSubsteps.
   */
  desiredSubsteps(dt: number): number {
    const v = this.v;
    let vrel = 0;
    for (let i = 0; i < this.n - 1; i++) {
      const r = Math.hypot(v[3 * i + 3]! - v[3 * i]!, v[3 * i + 4]! - v[3 * i + 1]!, v[3 * i + 5]! - v[3 * i + 2]!);
      if (r > vrel) vrel = r;
    }
    const nsub = Math.max(1, Math.ceil(dt / this.minSubstepDt - 1e-9));
    return Math.max(1, Math.min(this.maxSubsteps, Math.max(nsub, Math.ceil((dt * vrel) / (0.05 * this.ds)))));
  }

  /** Fastest node speed, m/s */
  maxNodeSpeed(): number {
    let m = 0;
    for (let i = 0; i < this.n; i++) m = Math.max(m, Math.hypot(this.v[3 * i]!, this.v[3 * i + 1]!, this.v[3 * i + 2]!));
    return m;
  }

  /** Nodes cannot pass through the ground plane y = 0 (half the section depth as margin). */
  /** Node whose load came down on the ground this step (handled at the start of the next) */
  private landedNode = -1;

  private groundContact(): void {
    // Half the section depth above y = 0, but never above the member's own supports (a base plate
    // on a low plinth): a margin its fixed end cannot satisfy would fight the axial constraints
    // every substep and store energy in the violation.
    let r = 0.5 * Math.min(2 * this.section.cy, 2 * this.section.cz);
    for (let i = 0; i < this.n; i++) if (this.locked[i]) r = Math.min(r, Math.max(0, this.x[3 * i + 1]!));
    let grounded = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.w[i] === 0) continue;
      const k = 3 * i + 1;
      if (this.x[k]! < r + 0.02) grounded++;
      // Once the loaded end is down on the ground the load it carried bears on the ground and the
      // debris, no longer on this member.
      if (this.imposed > 0 && this.landedNode < 0 && this.x[k]! < r + 0.02 && (i === this.roller || (this.roller < 0 && 2 * grounded > this.n))) this.landedNode = i;
      // A loaded head that has come down more than 0.85 L has crushed through the member.
      if (this.imposed > 0 && this.landedNode < 0 && i === this.roller) {
        const drop = Math.hypot(this.x[3 * i]! - this.rollerPos[0]!, this.x[3 * i + 1]! - this.rollerPos[1]!, this.x[3 * i + 2]! - this.rollerPos[2]!);
        if (drop > 0.85 * this.ds * (this.n - 1)) this.landedNode = i;
      }
      if (this.x[k]! < r) {
        this.x[k] = r;
        // Inelastic contact: the projection must not turn into an upward velocity (a node that was
        // already below the surface would otherwise be launched at depth/h).
        if (this.xp[k]! < r) this.xp[k] = r;
        // Friction: keep only part of the horizontal travel.
        this.x[3 * i] = this.xp[3 * i]! + 0.3 * (this.x[3 * i]! - this.xp[3 * i]!);
        this.x[3 * i + 2] = this.xp[3 * i + 2]! + 0.3 * (this.x[3 * i + 2]! - this.xp[3 * i + 2]!);
      }
    }
  }

  /** Nodes [i0, i1] as an independent member (the cut ends become free). */
  slice(i0: number, i1: number): BeamSim {
    return new BeamSim(null, this, [i0, i1]);
  }

  kineticEnergy(): number {
    let ke = 0;
    for (let i = 0; i < this.n; i++) ke += 0.5 * this.mass[i]! * (this.v[3 * i]! ** 2 + this.v[3 * i + 1]! ** 2 + this.v[3 * i + 2]! ** 2);
    return ke;
  }

  totalMass(): number {
    let m = 0;
    for (let i = 0; i < this.n; i++) m += this.mass[i]!;
    return m;
  }

  /** Newtonian cooling of the nodes (convection + radiation over the perimeter) and conduction along the axis. */
  cool(dt: number, lossPerArea: (tempC: number) => number, alpha: number): number {
    let hottest = AMBIENT_C;
    const n = this.n;
    for (let i = 0; i < n - 1; i++) {
      const Ti = this.temp[i]!, Tj = this.temp[i + 1]!;
      if (Math.abs(Ti - Tj) < 0.5) continue;
      const g = Math.min(0.25, (alpha * dt) / (this.ds * this.ds));
      const flow = g * (Ti - Tj);
      this.temp[i] = Ti - flow;
      this.temp[i + 1] = Tj + flow;
    }
    for (let i = 0; i < n; i++) {
      const T = this.temp[i]!;
      if (T <= AMBIENT_C + 0.5) continue;
      const area = this.section.perimeter * this.ds;
      // lossPerArea counts both faces of a sheet; a member surface loses half of that per m².
      const Tn = Math.max(AMBIENT_C, T - (0.5 * lossPerArea(T) * area * dt) / (Math.max(this.mass[i]!, 1e-6) * this.params.c));
      this.temp[i] = Tn;
      if (Tn > hottest) hottest = Tn;
    }
    return hottest;
  }
}
