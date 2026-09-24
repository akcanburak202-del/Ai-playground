import { Rng } from '../../core/rng.ts';
import { flowStress, fractureStrain, rateFactor, TAYLOR_QUINNEY, AMBIENT_C, type SteelParams } from './steelMaterial.ts';

/**
 * Ductile steel sheet in plate-local coordinates (the undeformed plate lies in z = 0 and spans
 * ±width/2 × ±height/2). Pure logic, no THREE / DOM.
 *
 * Representation
 *  - particles on a jittered grid (irregular mesh → natural crack paths), mass ρ·t·(tributary area);
 *  - triangles are the material: each owns a plastic state (membrane strain tensor from its bars'
 *    permanent set, bending strain from its hinges, thinning, hardening, fracture);
 *  - bars (unique edges): rest length and flow force σ_flow·t·w_trib (w_trib = 2A/3L per side);
 *  - hinges (dihedral angle between neighbours): rest angle and flow moment rising from the yield
 *    moment σ_y t²/6·|e| to the plastic moment σ_y t²/4·|e|; welded edges get hinges against a fixed
 *    virtual wing, so they form plastic hinge lines ("bent edges") instead of rotating freely;
 *  - welds: particles held by a support; they crack out when the heat-affected zone next to them
 *    has strained to half the parent metal's fracture strain.
 *
 * Why not an explicit / XPBD time integration of the sheet
 * --------------------------------------------------------
 * Steel's membrane and bending stiffness are 10⁴–10⁶× beyond what a Gauss–Seidel solver converges
 * at real-time step sizes on a 40×40 sheet: the global membrane behaves like rubber, the solver's
 * forces never reach yield, and energy is either lost or invented (see the module report). The
 * physics that matters — how far an impulsively loaded rigid–plastic plate deforms — is computed
 * the way structural-impact engineering does it:
 *
 *   Mode approximation (Martin & Symonds 1966, "Mode approximations for impulsively-loaded
 *   rigid-plastic structures", J. Eng. Mech. Div. ASCE 92): the load impulse J(x) is projected on a
 *   deformation mode φ(x). The mode keeps kinetic energy K = (∫J·φ)² / (2 ∫m φ²); the rest is lost in
 *   the initial mode-forming phase. Of a family of candidate modes the one that keeps the most
 *   energy (minimum initial loss) is chosen. The final amplitude W follows from the energy balance
 *   K − E_elastic = W_plastic(W), with W_plastic integrated on the actual, possibly already damaged
 *   mesh (Σ F_flow|ΔL| over bars + Σ M_flow|Δθ| over hinges, with hardening, thinning and a
 *   Cowper–Symonds factor at the mode's strain rate).
 *
 * Modes: a dome of geodesic radius R centred on the load, tapered to zero at welded supports
 * (geodesic distances run through intact material, so a flap beyond a crack moves on its own), and a
 * petal fold about a root circle for breaches. The deformation is animated over the rigid–plastic
 * response time T ≈ 2W/v₀ (slow motion shows the dish forming), committing plastic strain, heat and
 * cracks as it goes. The end state does not depend on the frame rate.
 */

const NEXT = [1, 2, 0] as const;
const PREV = [2, 0, 1] as const;

export interface PlateGridOptions {
  width: number;
  height: number;
  thickness: number;
  /** Target particle spacing, m */
  spacing: number;
  params: SteelParams;
  seed?: number;
  /** Interior vertex jitter as a fraction of the spacing */
  jitter?: number;
}

export interface PlateEvent {
  type: 'crack' | 'weld' | 'fragment';
  x: number;
  y: number;
  z: number;
  /** crack: equivalent plastic strain at failure; fragment: mass */
  value: number;
  /** crack: fracture strain of the element */
  limit: number;
}

/** A deformation mode: positions as a function of the amplitude for a set of particles. */
export interface Mode {
  kind: 'dome' | 'petal';
  particles: Int32Array;
  /** Positions of those particles when the mode was built */
  base: Float64Array;
  /** dome: displacement per unit amplitude (3 per particle); petal: in-plane radial unit (3) */
  a: Float64Array;
  /** petal: distance inward from the root circle (1 per particle) */
  s: Float64Array;
  /** Push / fold direction, local unit vector */
  dir: [number, number, number];
}

export interface DeformResult {
  /** Energy kept by the chosen mode, J */
  modalEnergy: number;
  /** Energy dissipated plastically at mesh scale, J */
  plasticEnergy: number;
  /** Final amplitude (dome: m, petal: rad) */
  amplitude: number;
  /** Mode radius, m */
  radius: number;
  /** Initial modal velocity, m/s */
  v0: number;
  /** Rigid–plastic response time (animation length), s */
  duration: number;
}

interface PendingDeform {
  mode: Mode;
  total: number;
  done: number;
  /** Plastic energy the event may dissipate, and what it has dissipated so far, J */
  budget: number;
  spent: number;
  /** Plastic work per unit amplitude of the last increment (predicts the next one) */
  slope: number;
  duration: number;
  elapsed: number;
  rate: number;
  bars: Int32Array;
  hinges: Int32Array;
}

interface ConstraintSet {
  bars: Int32Array;
  hinges: Int32Array;
}

const G = new Float64Array(12);
const SCRATCH3 = new Float64Array(3);

export class PlateSim {
  readonly params: SteelParams;
  readonly t0: number;
  readonly spacing: number;
  readonly width: number;
  readonly height: number;

  // ─── particles ──────────────────────────────────────────────────────────────────────────────
  n = 0;
  readonly pcap: number;
  readonly x: Float64Array;
  /** Rest coordinates in the plate plane (texture space), m, centred */
  readonly uv: Float64Array;
  readonly mass: Float64Array;
  readonly palive: Uint8Array;
  /** Temperature, °C */
  readonly temp: Float32Array;
  readonly weldOf: Int32Array;
  readonly vertTris: number[][];
  private scratchA: Float64Array;
  private scratchB: Float64Array;
  private trial: Float64Array;

  // ─── triangles ──────────────────────────────────────────────────────────────────────────────
  nt = 0;
  readonly tv: Int32Array;
  readonly talive: Uint8Array;
  /** Neighbour across local edge k (−1 = boundary / crack) */
  readonly tn: Int32Array;
  /** Unique edge (bar) of local edge k */
  readonly te: Int32Array;
  /** Hinge on local edge k (−1 none) */
  readonly th: Int32Array;
  readonly tArea0: Float64Array;
  /** Material mass of the triangle, kg */
  readonly tMass: Float64Array;
  /** Thickness / t0 (plastic thinning × material left after spall) */
  readonly tThick: Float32Array;
  /** Membrane equivalent plastic strain and accumulated bending surface strain */
  readonly tEpsM: Float32Array;
  readonly tEpsB: Float32Array;
  /** Remaining material fraction through the thickness (rear-face spall, gouges) */
  readonly tMat: Float32Array;
  /** Flow-force scale: thickness × hardening */
  readonly tScale: Float32Array;
  readonly tEf: Float32Array;
  readonly tCracks: Uint8Array;
  /** Edge-strain → strain-tensor map (rest frame), 9 per triangle */
  readonly tMap: Float64Array;
  private tDirtyStamp: Uint32Array;
  private dirtyTris: number[] = [];
  /**
   * Hardening / thinning computed while deformations are in flight, applied when they finish: the
   * amplitude was solved with the flow resultants at the start of the event, so they stay frozen for
   * its duration (otherwise the end state would depend on how finely the event is stepped).
   */
  private tScaleNext: Float32Array;
  private tThickNext: Float32Array;
  private frozen: number[] = [];
  private stamp = 1;

  // ─── bars ───────────────────────────────────────────────────────────────────────────────────
  ne = 0;
  readonly ecap: number;
  readonly eTA: Int32Array;
  readonly eKA: Int32Array;
  readonly eTB: Int32Array;
  readonly eKB: Int32Array;
  readonly eRest: Float64Array;
  readonly eRest0: Float64Array;
  /** Static yield force (at t0, un-hardened) contributed by side A / B, N */
  readonly eFyA: Float32Array;
  readonly eFyB: Float32Array;
  readonly ealive: Uint8Array;

  // ─── hinges ─────────────────────────────────────────────────────────────────────────────────
  nh = 0;
  readonly hTA: Int32Array;
  readonly hKA: Int32Array;
  /** −1: clamp hinge against the fixed virtual wing hWing */
  readonly hTB: Int32Array;
  readonly hKB: Int32Array;
  readonly hRest: Float64Array;
  /** Rotational stiffness D|e|/ℓ at t0, N·m/rad (elastic limit θ_y = M_y/k) */
  readonly hK: Float32Array;
  readonly hMy: Float32Array;
  readonly hMp: Float32Array;
  /** ℓ: width of the hinge band (curvature = θ/ℓ), m */
  readonly hEll: Float32Array;
  readonly hPlast: Float32Array;
  /** Plastic rotation accrued by in-flight events (folded into hPlast when they finish) */
  private hPlastNext: Float32Array;
  readonly halive: Uint8Array;
  readonly hWing: Float64Array;

  // ─── welds ──────────────────────────────────────────────────────────────────────────────────
  nw = 0;
  readonly weldP: Int32Array;
  readonly weldGroup: Int32Array;
  readonly weldAlive: Uint8Array;

  // ─── bookkeeping ────────────────────────────────────────────────────────────────────────────
  /** Cumulative plastic work at mesh scale (membrane + bending), J */
  plasticWork = 0;
  /** Topology changed since the owner last looked (owner clears) */
  topologyDirty = true;
  /** Positions changed since the owner last rebuilt its mesh (owner clears) */
  geometryDirty = true;
  events: PlateEvent[] = [];
  private pending: PendingDeform[] = [];
  private adjDirty = true;
  private adjStart = new Int32Array(0);
  private adjList = new Int32Array(0);
  private adjLen = new Float64Array(0);

  private constructor(params: SteelParams, t0: number, spacing: number, width: number, height: number, pcap: number, tcap: number, ecap: number, hcap: number, wcap: number) {
    this.params = params;
    this.t0 = t0;
    this.spacing = spacing;
    this.width = width;
    this.height = height;
    this.pcap = pcap;
    this.x = new Float64Array(3 * pcap);
    this.uv = new Float64Array(2 * pcap);
    this.mass = new Float64Array(pcap);
    this.palive = new Uint8Array(pcap);
    this.temp = new Float32Array(pcap).fill(AMBIENT_C);
    this.weldOf = new Int32Array(pcap).fill(-1);
    this.vertTris = Array.from({ length: pcap }, () => []);
    this.scratchA = new Float64Array(pcap);
    this.scratchB = new Float64Array(pcap);
    this.trial = new Float64Array(3 * pcap);
    this.tv = new Int32Array(3 * tcap);
    this.talive = new Uint8Array(tcap);
    this.tn = new Int32Array(3 * tcap).fill(-1);
    this.te = new Int32Array(3 * tcap).fill(-1);
    this.th = new Int32Array(3 * tcap).fill(-1);
    this.tArea0 = new Float64Array(tcap);
    this.tMass = new Float64Array(tcap);
    this.tThick = new Float32Array(tcap).fill(1);
    this.tEpsM = new Float32Array(tcap);
    this.tEpsB = new Float32Array(tcap);
    this.tMat = new Float32Array(tcap).fill(1);
    this.tScale = new Float32Array(tcap).fill(1);
    this.tEf = new Float32Array(tcap);
    this.tCracks = new Uint8Array(tcap);
    this.tMap = new Float64Array(9 * tcap);
    this.tDirtyStamp = new Uint32Array(tcap);
    this.tScaleNext = new Float32Array(tcap);
    this.tThickNext = new Float32Array(tcap);
    this.ecap = ecap;
    this.eTA = new Int32Array(ecap);
    this.eKA = new Int32Array(ecap);
    this.eTB = new Int32Array(ecap).fill(-1);
    this.eKB = new Int32Array(ecap);
    this.eRest = new Float64Array(ecap);
    this.eRest0 = new Float64Array(ecap);
    this.eFyA = new Float32Array(ecap);
    this.eFyB = new Float32Array(ecap);
    this.ealive = new Uint8Array(ecap);
    this.hTA = new Int32Array(hcap);
    this.hKA = new Int32Array(hcap);
    this.hTB = new Int32Array(hcap).fill(-1);
    this.hKB = new Int32Array(hcap);
    this.hRest = new Float64Array(hcap);
    this.hK = new Float32Array(hcap);
    this.hMy = new Float32Array(hcap);
    this.hMp = new Float32Array(hcap);
    this.hEll = new Float32Array(hcap);
    this.hPlast = new Float32Array(hcap);
    this.hPlastNext = new Float32Array(hcap);
    this.halive = new Uint8Array(hcap);
    this.hWing = new Float64Array(3 * hcap);
    this.weldP = new Int32Array(wcap);
    this.weldGroup = new Int32Array(wcap);
    this.weldAlive = new Uint8Array(wcap);
  }

  /** A flat rectangular plate meshed with a jittered grid (alternating diagonals). */
  static grid(o: PlateGridOptions): PlateSim {
    const nx = Math.max(2, Math.round(o.width / o.spacing) + 1);
    const ny = Math.max(2, Math.round(o.height / o.spacing) + 1);
    const n = nx * ny;
    const tcount = 2 * (nx - 1) * (ny - 1);
    const pcap = Math.ceil(n * 1.6) + 64;
    const sim = new PlateSim(o.params, o.thickness, o.spacing, o.width, o.height, pcap, tcount, 3 * n + tcount + 64, 3 * n + 2 * (nx + ny) + 16, pcap);
    const rng = new Rng(o.seed ?? 7);
    const sx = o.width / (nx - 1), sy = o.height / (ny - 1);
    const jit = o.jitter ?? 0.18;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        let u = -o.width / 2 + i * sx, v = -o.height / 2 + j * sy;
        if (i !== 0 && i !== nx - 1) u += rng.range(-jit, jit) * sx;
        if (j !== 0 && j !== ny - 1) v += rng.range(-jit, jit) * sy;
        sim.uv[2 * k] = u;
        sim.uv[2 * k + 1] = v;
        sim.x[3 * k] = u;
        sim.x[3 * k + 1] = v;
        sim.x[3 * k + 2] = 0;
        sim.palive[k] = 1;
      }
    }
    sim.n = n;
    const tris: number[] = [];
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx + 1, d = a + nx;
        if (((i + j) & 1) === 0) tris.push(a, b, c, a, c, d);
        else tris.push(a, b, d, b, c, d);
      }
    }
    sim.build(tris);
    return sim;
  }

  /** Build triangles, bars, hinges and masses from a CCW triangle list over the current particles. */
  private build(tris: number[]): void {
    const nt = tris.length / 3;
    this.nt = nt;
    const edgeMap = new Map<number, number>();
    const P = this.params;
    const t0 = this.t0;
    const D = (P.E * t0 * t0 * t0) / (12 * (1 - P.nu * P.nu));
    for (let t = 0; t < nt; t++) {
      for (let k = 0; k < 3; k++) this.tv[3 * t + k] = tris[3 * t + k]!;
      this.talive[t] = 1;
      const a = this.tv[3 * t]!, b = this.tv[3 * t + 1]!, c = this.tv[3 * t + 2]!;
      const area = 0.5 * ((this.uv[2 * b]! - this.uv[2 * a]!) * (this.uv[2 * c + 1]! - this.uv[2 * a + 1]!) - (this.uv[2 * c]! - this.uv[2 * a]!) * (this.uv[2 * b + 1]! - this.uv[2 * a + 1]!));
      this.tArea0[t] = area;
      this.tMass[t] = P.rho * t0 * area;
      this.tEf[t] = fractureStrain(P, t0, Math.sqrt(2 * area));
      this.computeStrainMap(t);
      for (let k = 0; k < 3; k++) this.vertTris[this.tv[3 * t + k]!]!.push(t);
    }
    for (let t = 0; t < nt; t++) {
      for (let k = 0; k < 3; k++) {
        const i = this.tv[3 * t + k]!, j = this.tv[3 * t + NEXT[k]]!;
        const key = i < j ? i * this.pcap + j : j * this.pcap + i;
        const len = Math.hypot(this.uv[2 * j]! - this.uv[2 * i]!, this.uv[2 * j + 1]! - this.uv[2 * i + 1]!);
        // Tributary width 2A/(3L) per side: a triangle's three bars together carry σ·t per unit
        // width in any direction (to within the lattice anisotropy).
        const fy = P.fy * t0 * ((2 * this.tArea0[t]!) / (3 * len));
        const found = edgeMap.get(key);
        if (found === undefined) {
          const e = this.ne++;
          edgeMap.set(key, e);
          this.eTA[e] = t;
          this.eKA[e] = k;
          this.eTB[e] = -1;
          this.eRest[e] = len;
          this.eRest0[e] = len;
          this.eFyA[e] = fy;
          this.ealive[e] = 1;
          this.te[3 * t + k] = e;
        } else {
          const e = found;
          this.eTB[e] = t;
          this.eKB[e] = k;
          this.eFyB[e] = fy;
          this.te[3 * t + k] = e;
          const u = this.eTA[e]!, ku = this.eKA[e]!;
          this.tn[3 * t + k] = u;
          this.tn[3 * u + ku] = t;
          const h = this.nh++;
          this.hTA[h] = u;
          this.hKA[h] = ku;
          this.hTB[h] = t;
          this.hKB[h] = k;
          this.initHinge(h, len, (this.tArea0[u]! + this.tArea0[t]!) / len, D);
          this.th[3 * t + k] = h;
          this.th[3 * u + ku] = h;
        }
      }
    }
    for (let i = 0; i < this.n; i++) this.updateMass(i);
  }

  private initHinge(h: number, len: number, ell: number, D: number): void {
    const P = this.params, t0 = this.t0;
    this.hRest[h] = 0;
    this.hEll[h] = ell;
    // Discrete-shell hinge: bending energy ½ D (θ/ℓ)² over a band |e|·ℓ ⇒ k = D |e| / ℓ.
    this.hK[h] = (D * len) / ell;
    this.hMy[h] = (P.fy * t0 * t0 * len) / 6;
    this.hMp[h] = (P.fy * t0 * t0 * len) / 4;
    this.hPlast[h] = 0;
    this.halive[h] = 1;
  }

  /** ε_k = n_kᵀ E n_k = exx c² + eyy s² + 2 exy c s for the three edges, inverted once per triangle. */
  private computeStrainMap(t: number): void {
    const m = new Float64Array(9);
    for (let k = 0; k < 3; k++) {
      const i = this.tv[3 * t + k]!, j = this.tv[3 * t + NEXT[k]]!;
      let cx = this.uv[2 * j]! - this.uv[2 * i]!, cy = this.uv[2 * j + 1]! - this.uv[2 * i + 1]!;
      const l = Math.hypot(cx, cy);
      cx /= l;
      cy /= l;
      m[3 * k] = cx * cx;
      m[3 * k + 1] = cy * cy;
      m[3 * k + 2] = 2 * cx * cy;
    }
    const inv = invert3(m);
    for (let q = 0; q < 9; q++) this.tMap[9 * t + q] = inv[q]!;
  }

  private updateMass(i: number): void {
    let m = 0;
    for (const t of this.vertTris[i]!) if (this.talive[t]) m += this.tMass[t]! / 3;
    this.mass[i] = m;
    if (m <= 0) {
      this.palive[i] = 0;
      const w = this.weldOf[i]!;
      if (w >= 0) {
        this.weldAlive[w] = 0;
        this.weldOf[i] = -1;
      }
    }
  }

  // ─── welds ──────────────────────────────────────────────────────────────────────────────────

  /** Weld particle i to support group `group`. */
  addWeld(i: number, group: number): number {
    const cur = this.weldOf[i]!;
    if (cur >= 0 && this.weldAlive[cur]) return cur;
    if (this.nw >= this.weldP.length) return -1;
    const w = this.nw++;
    this.weldP[w] = i;
    this.weldGroup[w] = group;
    this.weldAlive[w] = 1;
    this.weldOf[i] = w;
    return w;
  }

  /**
   * Clamp (moment-resisting) edges: every boundary edge whose two ends are welded (same group) gets
   * a hinge against a fixed virtual wing (the mirror image of its triangle).
   */
  addClampHinges(group: number): void {
    const P = this.params, t0 = this.t0;
    const D = (P.E * t0 * t0 * t0) / (12 * (1 - P.nu * P.nu));
    const x = this.x;
    for (let t = 0; t < this.nt; t++) {
      if (!this.talive[t]) continue;
      for (let k = 0; k < 3; k++) {
        if (this.tn[3 * t + k]! >= 0 || this.th[3 * t + k]! >= 0) continue;
        const i = this.tv[3 * t + k]!, j = this.tv[3 * t + NEXT[k]]!, a = this.tv[3 * t + PREV[k]]!;
        const wi = this.weldOf[i]!, wj = this.weldOf[j]!;
        if (wi < 0 || wj < 0 || this.weldGroup[wi] !== group || this.weldGroup[wj] !== group) continue;
        if (this.nh >= this.hTA.length) return;
        const h = this.nh++;
        this.hTA[h] = t;
        this.hKA[h] = k;
        this.hTB[h] = -1;
        const ex = x[3 * j]! - x[3 * i]!, ey = x[3 * j + 1]! - x[3 * i + 1]!, ez = x[3 * j + 2]! - x[3 * i + 2]!;
        const el = Math.hypot(ex, ey, ez);
        const ax = x[3 * a]! - x[3 * i]!, ay = x[3 * a + 1]! - x[3 * i + 1]!, az = x[3 * a + 2]! - x[3 * i + 2]!;
        const s = (ax * ex + ay * ey + az * ez) / (el * el);
        this.hWing[3 * h] = x[3 * i]! + 2 * ex * s - ax;
        this.hWing[3 * h + 1] = x[3 * i + 1]! + 2 * ey * s - ay;
        this.hWing[3 * h + 2] = x[3 * i + 2]! + 2 * ez * s - az;
        this.initHinge(h, el, (2 * this.tArea0[t]!) / el, D);
        this.th[3 * t + k] = h;
      }
    }
  }

  /** Remove every weld of a group (the support behind it is gone). */
  releaseGroup(group: number): number {
    let n = 0;
    for (let w = 0; w < this.nw; w++) {
      if (this.weldAlive[w] && this.weldGroup[w] === group) {
        this.breakWeld(w, false);
        n++;
      }
    }
    return n;
  }

  private breakWeld(w: number, event: boolean): void {
    this.weldAlive[w] = 0;
    const i = this.weldP[w]!;
    if (this.weldOf[i] === w) this.weldOf[i] = -1;
    if (event) this.events.push({ type: 'weld', x: this.x[3 * i]!, y: this.x[3 * i + 1]!, z: this.x[3 * i + 2]!, value: 0, limit: 0 });
    // A clamp hinge needs both of its welds.
    for (const t of this.vertTris[i]!) {
      for (let k = 0; k < 3; k++) {
        const h = this.th[3 * t + k]!;
        if (h < 0 || this.hTB[h]! >= 0 || !this.halive[h]) continue;
        if (this.tv[3 * t + k] === i || this.tv[3 * t + NEXT[k]] === i) {
          this.halive[h] = 0;
          this.th[3 * t + k] = -1;
        }
      }
    }
    this.topologyDirty = true;
  }

  liveWelds(): number {
    let n = 0;
    for (let w = 0; w < this.nw; w++) n += this.weldAlive[w]!;
    return n;
  }

  // ─── material removal and heat ──────────────────────────────────────────────────────────────

  addHeat(i: number, joules: number): void {
    const m = this.mass[i]!;
    if (m > 0) this.temp[i] = Math.min(1500, this.temp[i]! + joules / (m * this.params.c));
  }

  /** Remove a fraction of the thickness of triangle t (rear-face spall, gouges). */
  removeMaterial(t: number, fraction: number): void {
    if (!this.talive[t]) return;
    const f = Math.max(0.05, this.tMat[t]! * (1 - fraction));
    const r = f / this.tMat[t]!;
    this.tMat[t] = f;
    this.tMass[t] = this.tMass[t]! * r;
    for (let k = 0; k < 3; k++) this.updateMass(this.tv[3 * t + k]!);
    this.markDirty(t);
    this.processDirty();
  }

  // ─── geodesics ──────────────────────────────────────────────────────────────────────────────

  /** CSR adjacency over live bars (material distances = initial bar lengths). */
  private ensureAdjacency(): void {
    if (!this.adjDirty && this.adjStart.length === this.n + 1) return;
    const n = this.n;
    const deg = new Int32Array(n + 1);
    for (let e = 0; e < this.ne; e++) {
      if (!this.ealive[e]) continue;
      const A = this.eTA[e]!, k = this.eKA[e]!;
      deg[this.tv[3 * A + k]!]!++;
      deg[this.tv[3 * A + NEXT[k]]!]!++;
    }
    const start = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) start[i + 1] = start[i]! + deg[i]!;
    const list = new Int32Array(start[n]!);
    const len = new Float64Array(start[n]!);
    const fill = start.slice(0, n);
    for (let e = 0; e < this.ne; e++) {
      if (!this.ealive[e]) continue;
      const A = this.eTA[e]!, k = this.eKA[e]!;
      const i = this.tv[3 * A + k]!, j = this.tv[3 * A + NEXT[k]]!;
      const L = this.eRest0[e]!;
      list[fill[i]!] = j;
      len[fill[i]!++] = L;
      list[fill[j]!] = i;
      len[fill[j]!++] = L;
    }
    this.adjStart = start;
    this.adjList = list;
    this.adjLen = len;
    this.adjDirty = false;
  }

  /**
   * Geodesic distance through the material from source particles (Dijkstra, binary heap), each
   * source starting at `start[q]` (0 by default) — e.g. its distance to a point in a hole.
   */
  geodesic(sources: ArrayLike<number>, out: Float64Array, start?: ArrayLike<number>): Float64Array {
    this.ensureAdjacency();
    const n = this.n;
    out.fill(Infinity, 0, n);
    const heap = new MinHeap(n);
    for (let q = 0; q < sources.length; q++) {
      const s = sources[q]!;
      const d0 = start ? start[q]! : 0;
      if (d0 < out[s]!) {
        out[s] = d0;
        heap.push(s, d0);
      }
    }
    const st = this.adjStart, li = this.adjList, ln = this.adjLen;
    while (heap.size) {
      const i = heap.pop();
      const di = out[i]!;
      for (let q = st[i]!; q < st[i + 1]!; q++) {
        const j = li[q]!;
        const nd = di + ln[q]!;
        if (nd < out[j]!) {
          out[j] = nd;
          heap.push(j, nd);
        }
      }
    }
    return out;
  }

  /** Geodesic distance to the nearest live weld (Infinity everywhere if there is none). */
  supportDistance(out: Float64Array): Float64Array {
    const src: number[] = [];
    for (let w = 0; w < this.nw; w++) if (this.weldAlive[w]) src.push(this.weldP[w]!);
    if (!src.length) {
      out.fill(Infinity, 0, this.n);
      return out;
    }
    return this.geodesic(src, out);
  }

  /** Nearest live particle to a local point (by current position). */
  nearestParticle(px: number, py: number, pz: number): number {
    let best = -1, bd = Infinity;
    const x = this.x;
    for (let i = 0; i < this.n; i++) {
      if (!this.palive[i]) continue;
      const dx = x[3 * i]! - px, dy = x[3 * i + 1]! - py, dz = x[3 * i + 2]! - pz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  // ─── modes ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Dome mode of geodesic radius R pushing along `dir`: shape (1 − (d/R)²)² (C¹ at the rim) times a
   * smoothstep ramp that vanishes at welded supports and spans min(R, farthest support distance
   * inside the dome). `dist`/`sup`: geodesic distances from the centre and to the supports.
   */
  domeMode(R: number, dir: [number, number, number], dist: Float64Array, sup: Float64Array): Mode {
    const idx: number[] = [];
    let supMax = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.palive[i] || !(dist[i]! < R)) continue;
      idx.push(i);
      const s = sup[i]!;
      if (s !== Infinity && s > supMax) supMax = s;
    }
    const Ds = Math.max(1e-6, Math.min(R, supMax));
    const particles = Int32Array.from(idx);
    const base = new Float64Array(3 * idx.length);
    const a = new Float64Array(3 * idx.length);
    for (let q = 0; q < idx.length; q++) {
      const i = idx[q]!;
      const r = dist[i]! / R;
      let f = (1 - r * r) * (1 - r * r);
      const s = sup[i]!;
      if (s !== Infinity) {
        const u = Math.min(1, s / Ds);
        f *= u * u * (3 - 2 * u);
      }
      base[3 * q] = this.x[3 * i]!;
      base[3 * q + 1] = this.x[3 * i + 1]!;
      base[3 * q + 2] = this.x[3 * i + 2]!;
      a[3 * q] = f * dir[0];
      a[3 * q + 1] = f * dir[1];
      a[3 * q + 2] = f * dir[2];
    }
    return { kind: 'dome', particles, base, a, s: new Float64Array(0), dir };
  }

  /**
   * Petal fold: each petal rotates rigidly by the amplitude β about its root chord, as real petals
   * do (Wierzbicki 1999): Δx = s(1 − cos β) r̂ + s sin β n_out, with r̂ the petal's central radial
   * direction and s the distance inward from its root chord. Petals are found topologically: the
   * triangles inside the root circle, split into edge-connected pieces by the radial cracks.
   */
  petalMode(cu: number, cv: number, rootR: number, nOut: [number, number, number]): Mode {
    const x = this.x;
    // Tangent basis of the fold plane: rest u/v axes map to plate-local x/y (mirrored for −z).
    const sg = nOut[2] >= 0 ? 1 : -1;
    const inside = new Uint8Array(this.nt);
    for (let t = 0; t < this.nt; t++) {
      if (!this.talive[t]) continue;
      const [u, v] = this.centroidUV(t);
      if ((u - cu) ** 2 + (v - cv) ** 2 < rootR * rootR) inside[t] = 1;
    }
    const seen = new Uint8Array(this.nt);
    const moved = new Map<number, [number, number, number, number]>();
    for (let t0 = 0; t0 < this.nt; t0++) {
      if (!inside[t0] || seen[t0]) continue;
      const comp: number[] = [];
      const stack = [t0];
      seen[t0] = 1;
      while (stack.length) {
        const t = stack.pop()!;
        comp.push(t);
        for (let k = 0; k < 3; k++) {
          const u = this.tn[3 * t + k]!;
          if (u >= 0 && inside[u] && !seen[u]) {
            seen[u] = 1;
            stack.push(u);
          }
        }
      }
      const verts = new Set<number>();
      for (const t of comp) for (let k = 0; k < 3; k++) verts.add(this.tv[3 * t + k]!);
      let mu = 0, mv = 0;
      for (const i of verts) {
        mu += this.uv[2 * i]! - cu;
        mv += this.uv[2 * i + 1]! - cv;
      }
      const ml = Math.hypot(mu, mv);
      // An unbroken ring (no cracks) cannot fold as petals.
      if (ml < 0.25 * rootR * verts.size * 0.1 || comp.length > 0.8 * this.nt) continue;
      const cx = mu / ml, cy = mv / ml;
      let dmax = -Infinity;
      for (const i of verts) dmax = Math.max(dmax, (this.uv[2 * i]! - cu) * cx + (this.uv[2 * i + 1]! - cv) * cy);
      const rx = cx, ry = sg * cy;
      for (const i of verts) {
        if (this.weldOf[i]! >= 0) continue;
        const s = dmax - ((this.uv[2 * i]! - cu) * cx + (this.uv[2 * i + 1]! - cv) * cy);
        if (s <= 1e-6) continue;
        const prev = moved.get(i);
        if (!prev || prev[3] > s) moved.set(i, [rx, ry, 0, s]);
      }
    }
    const idx = [...moved.keys()];
    const particles = Int32Array.from(idx);
    const base = new Float64Array(3 * idx.length);
    const a = new Float64Array(3 * idx.length);
    const sv = new Float64Array(idx.length);
    idx.forEach((i, q) => {
      const [rx, ry, rz, s] = moved.get(i)!;
      base[3 * q] = x[3 * i]!;
      base[3 * q + 1] = x[3 * i + 1]!;
      base[3 * q + 2] = x[3 * i + 2]!;
      a[3 * q] = rx;
      a[3 * q + 1] = ry;
      a[3 * q + 2] = rz;
      sv[q] = s;
    });
    return { kind: 'petal', particles, base, a, s: sv, dir: nOut };
  }

  /**
   * Add the mode's displacement between amplitudes W0 and W1 to `out` (incremental, so several
   * modes can act on the same particles at once — a petal fold riding on a dish).
   */
  private modeDelta(m: Mode, W0: number, W1: number, out: Float64Array): void {
    const p = m.particles, a = m.a;
    if (m.kind === 'dome') {
      const dW = W1 - W0;
      for (let q = 0; q < p.length; q++) {
        const i = 3 * p[q]!;
        out[i] = out[i]! + dW * a[3 * q]!;
        out[i + 1] = out[i + 1]! + dW * a[3 * q + 1]!;
        out[i + 2] = out[i + 2]! + dW * a[3 * q + 2]!;
      }
      return;
    }
    const dc = Math.cos(W0) - Math.cos(W1), ds = Math.sin(W1) - Math.sin(W0);
    const [nx, ny, nz] = m.dir;
    for (let q = 0; q < p.length; q++) {
      const i = 3 * p[q]!, s = m.s[q]!;
      out[i] = out[i]! + s * (dc * a[3 * q]! + ds * nx);
      out[i + 1] = out[i + 1]! + s * (dc * a[3 * q + 1]! + ds * ny);
      out[i + 2] = out[i + 2]! + s * (dc * a[3 * q + 2]! + ds * nz);
    }
  }

  /** Bars and hinges touching any of the given particles (every hinge vertex lies on one of its triangles). */
  private affected(particles: Int32Array): ConstraintSet {
    const bars: number[] = [];
    const hinges: number[] = [];
    const seenH = new Uint8Array(this.nh);
    const seenE = new Uint8Array(this.ne);
    for (let q = 0; q < particles.length; q++) {
      for (const t of this.vertTris[particles[q]!]!) {
        if (!this.talive[t]) continue;
        for (let k = 0; k < 3; k++) {
          const e = this.te[3 * t + k]!;
          if (e >= 0 && this.ealive[e] && !seenE[e]) {
            seenE[e] = 1;
            bars.push(e);
          }
          const h = this.th[3 * t + k]!;
          if (h >= 0 && this.halive[h] && !seenH[h]) {
            seenH[h] = 1;
            hinges.push(h);
          }
        }
        // Hinges on the far edges of neighbouring triangles have this particle as a wing.
        for (let k = 0; k < 3; k++) {
          const u = this.tn[3 * t + k]!;
          if (u < 0) continue;
          for (let kk = 0; kk < 3; kk++) {
            const h = this.th[3 * u + kk]!;
            if (h >= 0 && this.halive[h] && !seenH[h]) {
              seenH[h] = 1;
              hinges.push(h);
            }
          }
        }
      }
    }
    return { bars: Int32Array.from(bars), hinges: Int32Array.from(hinges) };
  }

  private barFlowForce(e: number): number {
    const A = this.eTA[e]!, B = this.eTB[e]!;
    return B >= 0 ? this.eFyA[e]! * this.tScale[A]! + this.eFyB[e]! * this.tScale[B]! : this.eFyA[e]! * this.tScale[A]!;
  }

  /** Hinge flow moment: yield → plastic moment over ≈ 2 θ_y of plastic rotation, × hardening. */
  private hingeFlowMoment(h: number): number {
    const A = this.hTA[h]!, B = this.hTB[h]!;
    const tA = this.tThick[A]!, tB = B >= 0 ? this.tThick[B]! : tA;
    const tt = tA < tB ? tA : tB;
    const My = this.hMy[h]! * tt * tt, Mp = this.hMp[h]! * tt * tt;
    const thy = My / (this.hK[h]! * tt * tt * tt);
    const hard = B >= 0 ? 0.5 * (this.tScale[A]! / tA + this.tScale[B]! / tB) : this.tScale[A]! / tA;
    return (My + (Mp - My) * (1 - Math.exp(-this.hPlast[h]! / (2 * thy)))) * hard;
  }

  private barLength(e: number, x: Float64Array): number {
    const A = this.eTA[e]!, k = this.eKA[e]!;
    const i = 3 * this.tv[3 * A + k]!, j = 3 * this.tv[3 * A + NEXT[k]]!;
    return Math.hypot(x[j]! - x[i]!, x[j + 1]! - x[i + 1]!, x[j + 2]! - x[i + 2]!);
  }

  private hingeAngle(h: number, x: Float64Array): number {
    const A = this.hTA[h]!, kA = this.hKA[h]!, B = this.hTB[h]!;
    const i0 = this.tv[3 * A + kA]!, i1 = this.tv[3 * A + NEXT[kA]]!, ia = this.tv[3 * A + PREV[kA]]!;
    const ib = B >= 0 ? this.tv[3 * B + PREV[this.hKB[h]!]]! : -1;
    return dihedral(x, i0, i1, ia, ib, ib >= 0 ? x : this.hWing, ib >= 0 ? 3 * ib : 3 * h, G);
  }

  private static wrap(d: number): number {
    if (d > Math.PI) return d - 2 * Math.PI;
    if (d < -Math.PI) return d + 2 * Math.PI;
    return d;
  }

  /**
   * Plastic work of moving the mode from its base to amplitude W (rigid–plastic: every change of a
   * bar length or hinge angle is flow at the current flow resultant × rate factor).
   */
  plasticWorkOf(m: Mode, W: number, rate: number, set?: ConstraintSet): number {
    const s = set ?? this.affected(m.particles);
    const tr = this.trial;
    tr.set(this.x.subarray(0, 3 * this.n));
    this.modeDelta(m, 0, W, tr);
    let work = 0;
    for (let q = 0; q < s.bars.length; q++) {
      const e = s.bars[q]!;
      work += this.barFlowForce(e) * Math.abs(this.barLength(e, tr) - this.eRest[e]!);
    }
    for (let q = 0; q < s.hinges.length; q++) {
      const h = s.hinges[q]!;
      const th = this.hingeAngle(h, tr);
      if (th !== th) continue;
      work += this.hingeFlowMoment(h) * Math.abs(PlateSim.wrap(th - this.hRest[h]!));
    }
    return work * rate;
  }

  /**
   * Elastic energy the mode can store before its most strained hinge yields: ½·W_y·Σ M_y|dθ/dW|,
   * W_y = the amplitude at which that hinge reaches θ_y = M_y/k. Loads below it leave no set.
   */
  elasticCapacity(m: Mode, set: ConstraintSet): number {
    const eps = m.kind === 'dome' ? 1e-5 : 1e-4;
    const tr = this.trial;
    tr.set(this.x.subarray(0, 3 * this.n));
    this.modeDelta(m, 0, eps, tr);
    let maxRatio = 0, force = 0;
    for (let q = 0; q < set.hinges.length; q++) {
      const h = set.hinges[q]!;
      const th = this.hingeAngle(h, tr);
      const th0 = this.hingeAngle(h, this.x);
      if (th !== th || th0 !== th0) continue;
      const d = Math.abs(PlateSim.wrap(th - th0)) / eps;
      const A = this.hTA[h]!, B = this.hTB[h]!;
      const tt = Math.min(this.tThick[A]!, B >= 0 ? this.tThick[B]! : 1);
      const My = this.hMy[h]! * tt * tt;
      const thy = My / (this.hK[h]! * tt * tt * tt);
      maxRatio = Math.max(maxRatio, d / thy);
      force += My * d;
    }
    return maxRatio > 0 ? (0.5 * force) / maxRatio : 0;
  }

  /**
   * Amplitude at which the mode's plastic work equals E. The work is monotone and close to
   * b·W + c·W² (bending + membrane), so a quadratic first guess and an Illinois-type regula falsi
   * converge to 0.5 % in a handful of evaluations.
   */
  solveAmplitude(m: Mode, E: number, rate: number, set: ConstraintSet, maxW: number): number {
    if (!(E > 0)) return 0;
    const w1 = Math.min(maxW, m.kind === 'dome' ? Math.max(this.t0, 0.005) : 0.1);
    const f1 = this.plasticWorkOf(m, w1, rate, set);
    const w2 = Math.min(maxW, 3 * w1);
    const f2 = this.plasticWorkOf(m, w2, rate, set);
    // Fit W_p = bW + cW² through the two samples; solve for E.
    const c = Math.max(0, (f2 / w2 - f1 / w1) / (w2 - w1));
    const b = Math.max(1e-9, f1 / w1 - c * w1);
    let guess = c > 1e-12 ? (-b + Math.sqrt(b * b + 4 * c * E)) / (2 * c) : E / b;
    guess = Math.min(maxW, Math.max(1e-7, guess));
    let lo = 0, flo = -E, hi = Infinity, fhi = Infinity;
    const probe = (w: number, f: number) => {
      if (f - E < 0) {
        if (w > lo) {
          lo = w;
          flo = f - E;
        }
      } else if (w < hi) {
        hi = w;
        fhi = f - E;
      }
    };
    probe(w1, f1);
    probe(w2, f2);
    let w = guess;
    let side = 0;
    for (let it = 0; it < 12; it++) {
      const f = this.plasticWorkOf(m, w, rate, set);
      if (Math.abs(f - E) < 0.005 * E) return w;
      probe(w, f);
      if (fhi === Infinity) {
        // No upper bracket yet: the mode cannot absorb E within maxW → saturate.
        if (w >= maxW) return maxW;
        w = Math.min(maxW, Math.max(w * 2, lo * 2));
        continue;
      }
      // Illinois regula falsi inside the bracket.
      let next = lo - (flo * (hi - lo)) / (fhi - flo);
      if (f - E < 0) {
        if (side === -1) fhi *= 0.5;
        side = -1;
      } else {
        if (side === 1) flo *= 0.5;
        side = 1;
      }
      if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
      w = next;
    }
    return w;
  }

  /**
   * Realise an impulsive load J (3 per particle, N·s, plate-local). Picks the dome mode (radius among
   * `radii`, centred at particle `centre`, pushing along `dir`) that keeps the most kinetic energy,
   * solves its amplitude from the energy balance and queues the animated deformation.
   */
  impulse(J: Float64Array, centre: number | { u: number; v: number }, dir: [number, number, number], radii: number[], maxAmplitude = Infinity): DeformResult | null {
    let dist: Float64Array;
    if (typeof centre === 'number') {
      if (centre < 0 || !this.palive[centre] || !this.hasLiveTri(centre)) return null;
      dist = this.geodesic([centre], this.scratchA);
    } else {
      // The load centre sits in a hole: the live material around it starts at its planar distance.
      let dmin = Infinity;
      for (let i = 0; i < this.n; i++) {
        if (!this.palive[i] || !this.hasLiveTri(i)) continue;
        dmin = Math.min(dmin, Math.hypot(this.uv[2 * i]! - centre.u, this.uv[2 * i + 1]! - centre.v));
      }
      if (!Number.isFinite(dmin)) return null;
      const src: number[] = [], d0: number[] = [];
      const lim = dmin + 1.5 * this.spacing;
      for (let i = 0; i < this.n; i++) {
        if (!this.palive[i] || !this.hasLiveTri(i)) continue;
        const d = Math.hypot(this.uv[2 * i]! - centre.u, this.uv[2 * i + 1]! - centre.v);
        if (d <= lim) {
          src.push(i);
          d0.push(d);
        }
      }
      dist = this.geodesic(src, this.scratchA, d0);
    }
    const sup = this.supportDistance(this.scratchB);
    let best: Mode | null = null, bestE = 0, bestR = 0, bestP = 0, bestM = 0;
    for (const R of radii) {
      const m = this.domeMode(R, dir, dist, sup);
      let P = 0, M = 0;
      for (let q = 0; q < m.particles.length; q++) {
        const i = m.particles[q]!;
        const ax = m.a[3 * q]!, ay = m.a[3 * q + 1]!, az = m.a[3 * q + 2]!;
        // Particles born after J was sampled (crack splits) carry no load.
        if (3 * i + 2 < J.length) P += J[3 * i]! * ax + J[3 * i + 1]! * ay + J[3 * i + 2]! * az;
        M += this.mass[i]! * (ax * ax + ay * ay + az * az);
      }
      if (!(M > 0) || !(P > 0)) continue;
      // Kinetic energy the mode keeps: (∫J·φ)² / (2∫mφ²).
      const E = (0.5 * P * P) / M;
      if (E > bestE) {
        bestE = E;
        best = m;
        bestR = R;
        bestP = P;
        bestM = M;
      }
    }
    if (!best) return null;
    const set = this.affected(best.particles);
    const Ep = Math.max(0, bestE - this.elasticCapacity(best, set));
    const v0 = bestP / bestM;
    const maxW = Math.min(maxAmplitude, 1.5 * bestR);
    let W = this.solveAmplitude(best, Ep, 1, set, maxW);
    // Cowper–Symonds at the mode's mean strain rate: membrane ε̇ ≈ W·v₀/R², bending ε̇ ≈ t·v₀/R².
    const rate = rateFactor(this.params, ((W + this.t0) * 0.5 * v0) / Math.max(bestR * bestR, 1e-4));
    if (rate > 1.0001) W = this.solveAmplitude(best, Ep, rate, set, maxW);
    // Rigid–plastic response: the mode decelerates uniformly from v₀ to rest over W.
    const duration = W > 0 && v0 > 0 ? Math.min(0.08, Math.max(2e-4, (2 * W) / v0)) : 0;
    if (W > 1e-6) this.pending.push({ mode: best, total: W, done: 0, budget: Ep, spent: 0, slope: 0, duration, elapsed: 0, rate, bars: set.bars, hinges: set.hinges });
    return { modalEnergy: bestE, plasticEnergy: Ep, amplitude: W, radius: bestR, v0, duration };
  }

  private hasLiveTri(i: number): boolean {
    for (const t of this.vertTris[i]!) if (this.talive[t]) return true;
    return false;
  }

  /** Fold the petals around a breach by the angle the given energy can pay for (≤ maxAngle). */
  foldPetals(cu: number, cv: number, holeR: number, rootR: number, nOut: [number, number, number], energy: number, v0: number, maxAngle = 1.9): DeformResult | null {
    const m = this.petalMode(cu, cv, rootR, nOut);
    if (!m.particles.length) return null;
    const set = this.affected(m.particles);
    const rate = rateFactor(this.params, (v0 / Math.max(rootR - holeR, 1e-3)) * (this.t0 / (2 * this.spacing)));
    const beta = this.solveAmplitude(m, energy, rate, set, maxAngle);
    const duration = Math.min(0.05, Math.max(2e-4, (2 * beta * (rootR - holeR)) / Math.max(v0, 1)));
    if (beta > 1e-4) this.pending.push({ mode: m, total: beta, done: 0, budget: energy, spent: 0, slope: 0, duration, elapsed: 0, rate, bars: set.bars, hinges: set.hinges });
    return { modalEnergy: energy, plasticEnergy: energy, amplitude: beta, radius: rootR, v0, duration };
  }

  /** True while queued deformations are still being animated. */
  get busy(): boolean {
    return this.pending.length > 0;
  }

  /**
   * Advance the queued deformations by dt (uniform deceleration: amplitude ∝ 1 − (1 − t/T)²),
   * committing plastic flow, heat and fracture as the sheet moves.
   */
  advance(dt: number): void {
    if (!this.pending.length) return;
    const keep: PendingDeform[] = [];
    for (const d of this.pending) {
      d.elapsed += dt;
      const f = d.duration > 0 ? Math.min(1, d.elapsed / d.duration) : 1;
      let target = d.total * (1 - (1 - f) * (1 - f));
      let last = f >= 1;
      if (target > d.done) {
        // Energy-limited: hardening and cracks during the event change the work per unit
        // amplitude, so the event stops exactly when its plastic-energy budget is spent.
        const slope = d.slope > 0 ? d.slope : this.incrementWork(d, target) / (target - d.done);
        if (slope > 0 && d.spent + slope * (target - d.done) > d.budget) {
          target = d.done + Math.max(0, d.budget - d.spent) / slope;
          last = true;
        }
        this.modeDelta(d.mode, d.done, target, this.x);
        const w = this.commit(d.bars, d.hinges, d.rate);
        if (target > d.done) d.slope = w / (target - d.done);
        d.spent += w;
        d.done = target;
        this.geometryDirty = true;
      }
      if (!last && d.spent < d.budget) keep.push(d);
    }
    this.pending = keep;
    if (this.dirtyTris.length) this.processDirty();
    if (!this.pending.length) {
      for (const t of this.frozen) {
        this.tThick[t] = this.tThickNext[t]!;
        this.tScale[t] = this.tScaleNext[t]!;
      }
      this.frozen.length = 0;
      for (let h = 0; h < this.nh; h++) {
        if (this.hPlastNext[h] === 0) continue;
        this.hPlast[h] = this.hPlast[h]! + this.hPlastNext[h]!;
        this.hPlastNext[h] = 0;
      }
    }
    this.checkWelds();
  }

  /** Plastic work of advancing a queued deformation from its current amplitude to `target`. */
  private incrementWork(d: PendingDeform, target: number): number {
    const tr = this.trial;
    tr.set(this.x.subarray(0, 3 * this.n));
    this.modeDelta(d.mode, d.done, target, tr);
    let work = 0;
    for (let q = 0; q < d.bars.length; q++) {
      const e = d.bars[q]!;
      if (this.ealive[e]) work += this.barFlowForce(e) * Math.abs(this.barLength(e, tr) - this.eRest[e]!);
    }
    for (let q = 0; q < d.hinges.length; q++) {
      const h = d.hinges[q]!;
      if (!this.halive[h]) continue;
      const th = this.hingeAngle(h, tr);
      if (th === th) work += this.hingeFlowMoment(h) * Math.abs(PlateSim.wrap(th - this.hRest[h]!));
    }
    return work * d.rate;
  }

  /** Finish every queued deformation now (in 64 increments each, so budgets and cracks apply). */
  flush(): void {
    let guard = 0;
    while (this.pending.length && guard++ < 4096) {
      let dt = Infinity;
      for (const d of this.pending) dt = Math.min(dt, Math.max(d.duration, 1e-6) / 64);
      this.advance(dt);
    }
  }

  /** Plastic flow: rest state follows the current shape; F·|Δ| is plastic work and heat. Returns the work, J. */
  private commit(bars: Int32Array, hinges: Int32Array, rate: number): number {
    const P = this.params, x = this.x, tv = this.tv;
    const w0 = this.plasticWork;
    for (let q = 0; q < bars.length; q++) {
      const e = bars[q]!;
      if (!this.ealive[e]) continue;
      const L = this.barLength(e, x);
      const d = L - this.eRest[e]!;
      if (d === 0) continue;
      const work = this.barFlowForce(e) * rate * Math.abs(d);
      this.eRest[e] = L;
      this.plasticWork += work;
      const A = this.eTA[e]!, k = this.eKA[e]!;
      const i = tv[3 * A + k]!, j = tv[3 * A + NEXT[k]]!;
      const heat = (0.5 * TAYLOR_QUINNEY * work) / P.c;
      this.temp[i] = Math.min(1500, this.temp[i]! + heat / Math.max(this.mass[i]!, 1e-6));
      this.temp[j] = Math.min(1500, this.temp[j]! + heat / Math.max(this.mass[j]!, 1e-6));
      this.markDirty(A);
      const B = this.eTB[e]!;
      if (B >= 0) this.markDirty(B);
    }
    for (let q = 0; q < hinges.length; q++) {
      const h = hinges[q]!;
      if (!this.halive[h]) continue;
      const th = this.hingeAngle(h, x);
      if (th !== th) continue;
      const d = PlateSim.wrap(th - this.hRest[h]!);
      if (d === 0) continue;
      const ad = Math.abs(d);
      const work = this.hingeFlowMoment(h) * rate * ad;
      this.hRest[h] = th;
      this.hPlastNext[h] = this.hPlastNext[h]! + ad;
      this.plasticWork += work;
      const A = this.hTA[h]!, B = this.hTB[h]!;
      const tt = Math.min(this.tThick[A]!, B >= 0 ? this.tThick[B]! : 1);
      // Bending plastic strain of the surface fibres: Δθ · t / (2ℓ).
      const deps = (ad * this.t0 * tt) / (2 * this.hEll[h]!);
      this.tEpsB[A] = this.tEpsB[A]! + deps;
      this.markDirty(A);
      if (B >= 0) {
        this.tEpsB[B] = this.tEpsB[B]! + deps;
        this.markDirty(B);
      }
      const kA = this.hKA[h]!;
      const i0 = tv[3 * A + kA]!, i1 = tv[3 * A + NEXT[kA]]!;
      const heat = (0.5 * TAYLOR_QUINNEY * work) / P.c;
      this.temp[i0] = Math.min(1500, this.temp[i0]! + heat / Math.max(this.mass[i0]!, 1e-6));
      this.temp[i1] = Math.min(1500, this.temp[i1]! + heat / Math.max(this.mass[i1]!, 1e-6));
    }
    return this.plasticWork - w0;
  }

  /**
   * Welds crack when the heat-affected zone next to them has strained to half the parent metal's
   * fracture strain (fillet welds and HAZ keep ≈ 50 % of the base metal's ductility).
   */
  private checkWelds(): void {
    for (let w = 0; w < this.nw; w++) {
      if (!this.weldAlive[w]) continue;
      const i = this.weldP[w]!;
      let worst = 0;
      for (const t of this.vertTris[i]!) {
        if (!this.talive[t]) continue;
        worst = Math.max(worst, (this.tEpsM[t]! + this.tEpsB[t]!) / this.tEf[t]!);
      }
      if (worst >= 0.5) this.breakWeld(w, true);
    }
  }

  // ─── plastic state and fracture ─────────────────────────────────────────────────────────────

  markDirty(t: number): void {
    if (this.tDirtyStamp[t] === this.stamp) return;
    this.tDirtyStamp[t] = this.stamp;
    this.dirtyTris.push(t);
  }

  /** Strain tensor (exx, eyy, exy) of triangle t from its bars' permanent set, rest frame. */
  plasticStrain(t: number, out: Float64Array): Float64Array {
    const e0 = Math.log(this.eRest[this.te[3 * t]!]! / this.eRest0[this.te[3 * t]!]!);
    const e1 = Math.log(this.eRest[this.te[3 * t + 1]!]! / this.eRest0[this.te[3 * t + 1]!]!);
    const e2 = Math.log(this.eRest[this.te[3 * t + 2]!]! / this.eRest0[this.te[3 * t + 2]!]!);
    const m = this.tMap;
    const o = 9 * t;
    out[0] = m[o]! * e0 + m[o + 1]! * e1 + m[o + 2]! * e2;
    out[1] = m[o + 3]! * e0 + m[o + 4]! * e1 + m[o + 5]! * e2;
    out[2] = m[o + 6]! * e0 + m[o + 7]! * e1 + m[o + 8]! * e2;
    return out;
  }

  /** Equivalent plastic strain (membrane von Mises + accumulated bending) of triangle t. */
  eqStrain(t: number): number {
    return this.tEpsM[t]! + this.tEpsB[t]!;
  }

  processDirty(): void {
    let guard = 0;
    const E = SCRATCH3;
    const P = this.params;
    while (this.dirtyTris.length && guard++ < 8) {
      const list = this.dirtyTris;
      this.dirtyTris = [];
      this.stamp++;
      if (this.stamp > 0xfffffff0) {
        this.stamp = 1;
        this.tDirtyStamp.fill(0);
      }
      for (const t of list) {
        if (!this.talive[t]) continue;
        this.plasticStrain(t, E);
        const exx = E[0]!, eyy = E[1]!, exy = E[2]!;
        // Von Mises equivalent strain for plastic (incompressible) plane stress: εz = −(εx + εy).
        const em = (2 / Math.sqrt(3)) * Math.sqrt(Math.max(0, exx * exx + eyy * eyy + exx * eyy + exy * exy));
        this.tEpsM[t] = em;
        // Volume constancy: t/t0 = exp(εz), times what spall / gouging left of the section.
        const thick = Math.min(1.5, Math.max(0.05, Math.exp(-(exx + eyy)) * this.tMat[t]!));
        const eq = em + this.tEpsB[t]!;
        const scale = thick * (flowStress(P, eq) / P.fy);
        if (this.pending.length) {
          this.tThickNext[t] = thick;
          this.tScaleNext[t] = scale;
          this.frozen.push(t);
        } else {
          this.tThick[t] = thick;
          this.tScale[t] = scale;
        }
        const limit = this.tEf[t]! * (1 + 0.35 * this.tCracks[t]!);
        if (eq >= limit) this.fractureTriangle(t, exx, eyy, exy, eq);
      }
    }
  }

  /** Crack triangle t along the edge most perpendicular to its largest principal strain. */
  private fractureTriangle(t: number, exx: number, eyy: number, exy: number, eq: number): void {
    let px = 1, py = 0;
    if (Math.hypot(0.5 * (exx - eyy), exy) > 1e-9) {
      const ang = 0.5 * Math.atan2(2 * exy, exx - eyy);
      px = Math.cos(ang);
      py = Math.sin(ang);
    }
    let best = -1, bestScore = Infinity;
    // Bending-dominated failure opens along the most rotated hinge line.
    const membrane = this.tEpsM[t]! > this.tEpsB[t]!;
    for (let k = 0; k < 3; k++) {
      if (this.tn[3 * t + k]! < 0) continue;
      let score: number;
      if (membrane) {
        const i = this.tv[3 * t + k]!, j = this.tv[3 * t + NEXT[k]]!;
        const cx = this.uv[2 * j]! - this.uv[2 * i]!, cy = this.uv[2 * j + 1]! - this.uv[2 * i + 1]!;
        score = Math.abs(cx * px + cy * py) / Math.hypot(cx, cy);
      } else {
        const hh = this.th[3 * t + k]!;
        score = hh >= 0 ? -this.hPlast[hh]! : 1;
      }
      if (score < bestScore) {
        bestScore = score;
        best = k;
      }
    }
    const c = this.centroid(t);
    this.events.push({ type: 'crack', x: c[0], y: c[1], z: c[2], value: eq, limit: this.tEf[t]! });
    this.tCracks[t] = Math.min(255, this.tCracks[t]! + 1);
    if (best < 0) {
      this.deleteTriangle(t, true);
      return;
    }
    this.crackEdge(t, best);
  }

  centroid(t: number): [number, number, number] {
    const a = 3 * this.tv[3 * t]!, b = 3 * this.tv[3 * t + 1]!, c = 3 * this.tv[3 * t + 2]!;
    const x = this.x;
    return [(x[a]! + x[b]! + x[c]!) / 3, (x[a + 1]! + x[b + 1]! + x[c + 1]!) / 3, (x[a + 2]! + x[b + 2]! + x[c + 2]!) / 3];
  }

  /** Rest-space (u, v) centroid of triangle t. */
  centroidUV(t: number): [number, number] {
    const a = this.tv[3 * t]!, b = this.tv[3 * t + 1]!, c = this.tv[3 * t + 2]!;
    const uv = this.uv;
    return [(uv[2 * a]! + uv[2 * b]! + uv[2 * c]!) / 3, (uv[2 * a + 1]! + uv[2 * b + 1]! + uv[2 * c + 1]!) / 3];
  }

  // ─── topology changes ───────────────────────────────────────────────────────────────────────

  private localIndexOf(u: number, t: number): number {
    for (let k = 0; k < 3; k++) if (this.tn[3 * u + k] === t) return k;
    return -1;
  }

  private killHinge(h: number): void {
    if (h < 0 || !this.halive[h]) return;
    this.halive[h] = 0;
    const A = this.hTA[h]!, B = this.hTB[h]!;
    if (this.th[3 * A + this.hKA[h]!] === h) this.th[3 * A + this.hKA[h]!] = -1;
    if (B >= 0 && this.th[3 * B + this.hKB[h]!] === h) this.th[3 * B + this.hKB[h]!] = -1;
  }

  /** Separate triangle t from its neighbour across local edge k. Returns false if already separate. */
  crackEdge(t: number, k: number): boolean {
    const u = this.tn[3 * t + k]!;
    if (u < 0) return false;
    const ku = this.localIndexOf(u, t);
    if (ku < 0 || this.ne >= this.ecap) return false;
    const e = this.te[3 * t + k]!;
    const e2 = this.ne++;
    // Bar e keeps side A; the triangle on side B gets its own boundary bar e2.
    const moveT = this.eTB[e]!;
    const moveK = this.eKB[e]!;
    this.eTA[e2] = moveT;
    this.eKA[e2] = moveK;
    this.eTB[e2] = -1;
    this.eRest[e2] = this.eRest[e]!;
    this.eRest0[e2] = this.eRest0[e]!;
    this.eFyA[e2] = this.eFyB[e]!;
    this.ealive[e2] = 1;
    this.eTB[e] = -1;
    this.eFyB[e] = 0;
    this.te[3 * moveT + moveK] = e2;
    this.killHinge(this.th[3 * t + k]!);
    this.tn[3 * t + k] = -1;
    this.tn[3 * u + ku] = -1;
    const i = this.tv[3 * t + k]!, j = this.tv[3 * t + NEXT[k]]!;
    this.splitVertex(i);
    this.splitVertex(j);
    this.topologyDirty = true;
    this.adjDirty = true;
    return true;
  }

  /** True if particle i lies on a free (boundary or crack) edge. */
  onFreeEdge(i: number): boolean {
    for (const t of this.vertTris[i]!) {
      if (!this.talive[t]) continue;
      for (let k = 0; k < 3; k++) {
        if (this.tn[3 * t + k]! >= 0) continue;
        if (this.tv[3 * t + k] === i || this.tv[3 * t + NEXT[k]] === i) return true;
      }
    }
    return false;
  }

  /** Crack the shared edge between particles a and b (if they share one). */
  crackBetween(a: number, b: number): boolean {
    for (const t of this.vertTris[a]!) {
      if (!this.talive[t]) continue;
      for (let k = 0; k < 3; k++) {
        const i = this.tv[3 * t + k]!, j = this.tv[3 * t + NEXT[k]]!;
        if ((i === a && j === b) || (i === b && j === a)) return this.crackEdge(t, k);
      }
    }
    return false;
  }

  /**
   * Breach: punch out the material within `holeR` of rest point (cu, cv) and cut `petals` radial
   * cracks from the hole edge to `holeR + crackLen` along the mesh edges closest to each ray — the
   * star-shaped tear of petalling (Wierzbicki 1999, "Petalling of plates under explosive and impact
   * loading", Int. J. Impact Eng. 22: 3–6 petals, crack length of the order of the hole radius).
   * Returns the number of triangles removed and the crack angles (rest space).
   */
  breach(cu: number, cv: number, holeR: number, crackLen: number, petals: number, seed: number): { removed: number; crackAngles: number[] } {
    let removed = 0;
    const crackAngles: number[] = [];
    for (let t = 0; t < this.nt; t++) {
      if (!this.talive[t]) continue;
      const [u, v] = this.centroidUV(t);
      if ((u - cu) ** 2 + (v - cv) ** 2 < holeR * holeR) {
        this.deleteTriangle(t, false);
        removed++;
      }
    }
    if (petals < 2 || crackLen <= 0) return { removed, crackAngles };
    const rng = new Rng(seed);
    const phase = rng.range(0, Math.PI * 2);
    const rootR = holeR + crackLen;
    for (let k = 0; k < petals; k++) {
      const ang = phase + (2 * Math.PI * k) / petals + rng.range(-0.25, 0.25) * (Math.PI / petals);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      crackAngles.push(ang);
      // Start on the hole rim (a vertex on a free edge) nearest the ray, so the crack opens at once.
      let cur = -1, best = Infinity;
      for (let i = 0; i < this.n; i++) {
        if (!this.palive[i] || !this.onFreeEdge(i)) continue;
        const pu = this.uv[2 * i]! - cu, pv = this.uv[2 * i + 1]! - cv;
        const r = Math.hypot(pu, pv);
        if (r > holeR + 2 * this.spacing) continue;
        const off = Math.abs(pu * dy - pv * dx) + Math.max(0, -(pu * dx + pv * dy));
        if (off < best) {
          best = off;
          cur = i;
        }
      }
      for (let step = 0; cur >= 0 && step < 64; step++) {
        const pu = this.uv[2 * cur]! - cu, pv = this.uv[2 * cur + 1]! - cv;
        if (Math.hypot(pu, pv) >= rootR) break;
        let next = -1, score = -Infinity;
        for (const t of this.vertTris[cur]!) {
          if (!this.talive[t]) continue;
          for (let q = 0; q < 3; q++) {
            const j = this.tv[3 * t + q]!;
            if (j === cur) continue;
            const su = this.uv[2 * j]! - this.uv[2 * cur]!, sv = this.uv[2 * j + 1]! - this.uv[2 * cur + 1]!;
            const sl = Math.hypot(su, sv);
            const ju = this.uv[2 * j]! - cu, jv = this.uv[2 * j + 1]! - cv;
            // Follow the ray outward: forward progress, penalise drifting off the ray.
            const sc = (su * dx + sv * dy) / sl - (0.8 * Math.abs(ju * dy - jv * dx)) / this.spacing;
            if (sc > score) {
              score = sc;
              next = j;
            }
          }
        }
        if (next < 0 || score < -1.5) break;
        this.crackBetween(cur, next);
        cur = next;
      }
    }
    return { removed, crackAngles };
  }

  /** Remove a triangle (material punched out or shredded). */
  deleteTriangle(t: number, fragment = false): void {
    if (!this.talive[t]) return;
    if (fragment) {
      const c = this.centroid(t);
      this.events.push({ type: 'fragment', x: c[0], y: c[1], z: c[2], value: this.tMass[t]!, limit: 0 });
    }
    this.talive[t] = 0;
    for (let k = 0; k < 3; k++) {
      const e = this.te[3 * t + k]!;
      if (this.eTA[e] === t) {
        if (this.eTB[e]! >= 0) {
          this.eTA[e] = this.eTB[e]!;
          this.eKA[e] = this.eKB[e]!;
          this.eFyA[e] = this.eFyB[e]!;
          this.eTB[e] = -1;
          this.eFyB[e] = 0;
        } else this.ealive[e] = 0;
      } else if (this.eTB[e] === t) {
        this.eTB[e] = -1;
        this.eFyB[e] = 0;
      }
      const u = this.tn[3 * t + k]!;
      if (u >= 0) {
        const ku = this.localIndexOf(u, t);
        if (ku >= 0) this.tn[3 * u + ku] = -1;
      }
      this.tn[3 * t + k] = -1;
      const hh = this.th[3 * t + k]!;
      if (hh >= 0) this.killHinge(hh);
    }
    for (let k = 0; k < 3; k++) {
      const i = this.tv[3 * t + k]!;
      const list = this.vertTris[i]!;
      const idx = list.indexOf(t);
      if (idx >= 0) list.splice(idx, 1);
      this.updateMass(i);
      if (this.palive[i]) this.splitVertex(i);
    }
    this.topologyDirty = true;
    this.adjDirty = true;
  }

  /**
   * If the triangles around vertex v no longer form one edge-connected fan, give every extra fan
   * its own copy of the vertex so the pieces can separate.
   */
  splitVertex(v: number): void {
    const tris = this.vertTris[v]!.filter((t) => this.talive[t]);
    if (tris.length <= 1) return;
    const comp = new Map<number, number>();
    let ncomp = 0;
    for (const t0 of tris) {
      if (comp.has(t0)) continue;
      const id = ncomp++;
      const stack = [t0];
      comp.set(t0, id);
      while (stack.length) {
        const t = stack.pop()!;
        for (let k = 0; k < 3; k++) {
          if (this.tv[3 * t + k] !== v && this.tv[3 * t + NEXT[k]] !== v) continue;
          const u = this.tn[3 * t + k]!;
          if (u >= 0 && !comp.has(u) && this.talive[u]) {
            comp.set(u, id);
            stack.push(u);
          }
        }
      }
    }
    if (ncomp <= 1) return;
    const keep: number[] = [];
    const groups: number[][] = Array.from({ length: ncomp - 1 }, () => []);
    for (const t of tris) {
      const c = comp.get(t)!;
      if (c === 0) keep.push(t);
      else groups[c - 1]!.push(t);
    }
    this.vertTris[v] = keep;
    for (const g of groups) {
      if (this.n >= this.pcap) {
        // Out of particle capacity: shred the smaller fan instead of splitting it.
        for (const t of g) this.deleteTriangle(t, true);
        continue;
      }
      const v2 = this.n++;
      for (let c = 0; c < 3; c++) this.x[3 * v2 + c] = this.x[3 * v + c]!;
      this.uv[2 * v2] = this.uv[2 * v]!;
      this.uv[2 * v2 + 1] = this.uv[2 * v + 1]!;
      this.temp[v2] = this.temp[v]!;
      this.palive[v2] = 1;
      this.weldOf[v2] = -1;
      for (const t of g) {
        for (let k = 0; k < 3; k++) if (this.tv[3 * t + k] === v) this.tv[3 * t + k] = v2;
      }
      this.vertTris[v2] = g;
      const w = this.weldOf[v]!;
      if (w >= 0 && this.weldAlive[w]) this.addWeld(v2, this.weldGroup[w]!);
      this.updateMass(v2);
      // Queued deformations that move v also move its copy.
      for (const d of this.pending) {
        const p = d.mode.particles;
        const q = p.indexOf(v);
        if (q < 0) continue;
        const grow = (arr: Float64Array, width: number) => {
          const out = new Float64Array(arr.length + width);
          out.set(arr);
          for (let c = 0; c < width; c++) out[arr.length + c] = arr[width * q + c]!;
          return out;
        };
        d.mode.particles = Int32Array.from([...p, v2]);
        d.mode.base = grow(d.mode.base, 3);
        d.mode.a = grow(d.mode.a, 3);
        if (d.mode.s.length) d.mode.s = grow(d.mode.s, 1);
      }
    }
    this.updateMass(v);
    this.topologyDirty = true;
    this.adjDirty = true;
  }

  /** Edge-connected components of the live triangles. */
  components(): number[][] {
    const seen = new Uint8Array(this.nt);
    const out: number[][] = [];
    for (let s = 0; s < this.nt; s++) {
      if (!this.talive[s] || seen[s]) continue;
      const comp: number[] = [];
      const stack = [s];
      seen[s] = 1;
      while (stack.length) {
        const t = stack.pop()!;
        comp.push(t);
        for (let k = 0; k < 3; k++) {
          const u = this.tn[3 * t + k]!;
          if (u >= 0 && !seen[u] && this.talive[u]) {
            seen[u] = 1;
            stack.push(u);
          }
        }
      }
      out.push(comp);
    }
    return out;
  }

  /** True if any live weld holds a particle of these triangles. */
  isWelded(tris: number[]): boolean {
    for (const t of tris) for (let k = 0; k < 3; k++) {
      const w = this.weldOf[this.tv[3 * t + k]!]!;
      if (w >= 0 && this.weldAlive[w]) return true;
    }
    return false;
  }

  /**
   * Move a set of triangles into a new, independent sheet (a torn-off piece) and remove them here.
   * Plastic state, temperatures and rest coordinates carry over.
   */
  extract(tris: number[]): PlateSim {
    const vmap = new Map<number, number>();
    for (const t of tris) for (let k = 0; k < 3; k++) {
      const i = this.tv[3 * t + k]!;
      if (!vmap.has(i)) vmap.set(i, vmap.size);
    }
    const nv = vmap.size;
    const sub = new PlateSim(this.params, this.t0, this.spacing, this.width, this.height, Math.ceil(nv * 1.5) + 16, tris.length, 3 * nv + tris.length + 16, 3 * nv + 16, 4);
    for (const [i, j] of vmap) {
      for (let c = 0; c < 3; c++) sub.x[3 * j + c] = this.x[3 * i + c]!;
      sub.uv[2 * j] = this.uv[2 * i]!;
      sub.uv[2 * j + 1] = this.uv[2 * i + 1]!;
      sub.temp[j] = this.temp[i]!;
      sub.palive[j] = 1;
    }
    sub.n = nv;
    const tmap = new Map<number, number>();
    tris.forEach((t, q) => tmap.set(t, q));
    sub.nt = tris.length;
    const emap = new Map<number, number>();
    const hmap = new Map<number, number>();
    tris.forEach((t, q) => {
      for (let k = 0; k < 3; k++) sub.tv[3 * q + k] = vmap.get(this.tv[3 * t + k]!)!;
      sub.talive[q] = 1;
      sub.tArea0[q] = this.tArea0[t]!;
      sub.tMass[q] = this.tMass[t]!;
      sub.tThick[q] = this.tThick[t]!;
      sub.tEpsM[q] = this.tEpsM[t]!;
      sub.tEpsB[q] = this.tEpsB[t]!;
      sub.tMat[q] = this.tMat[t]!;
      sub.tScale[q] = this.tScale[t]!;
      sub.tEf[q] = this.tEf[t]!;
      sub.tCracks[q] = this.tCracks[t]!;
      for (let c = 0; c < 9; c++) sub.tMap[9 * q + c] = this.tMap[9 * t + c]!;
      for (let k = 0; k < 3; k++) {
        const u = this.tn[3 * t + k]!;
        sub.tn[3 * q + k] = u >= 0 && tmap.has(u) ? tmap.get(u)! : -1;
        const e = this.te[3 * t + k]!;
        const fromA = this.eTA[e] === t;
        let e2 = emap.get(e);
        if (e2 === undefined) {
          e2 = sub.ne++;
          emap.set(e, e2);
          sub.eRest[e2] = this.eRest[e]!;
          sub.eRest0[e2] = this.eRest0[e]!;
          sub.ealive[e2] = 1;
          sub.eTB[e2] = -1;
          sub.eTA[e2] = q;
          sub.eKA[e2] = k;
          sub.eFyA[e2] = fromA ? this.eFyA[e]! : this.eFyB[e]!;
        } else {
          sub.eTB[e2] = q;
          sub.eKB[e2] = k;
          sub.eFyB[e2] = fromA ? this.eFyA[e]! : this.eFyB[e]!;
        }
        sub.te[3 * q + k] = e2;
        const hh = this.th[3 * t + k]!;
        if (hh >= 0 && this.halive[hh] && this.hTB[hh]! >= 0 && tmap.has(this.hTA[hh]!) && tmap.has(this.hTB[hh]!)) {
          let h2 = hmap.get(hh);
          if (h2 === undefined) {
            h2 = sub.nh++;
            hmap.set(hh, h2);
            sub.hTA[h2] = tmap.get(this.hTA[hh]!)!;
            sub.hKA[h2] = this.hKA[hh]!;
            sub.hTB[h2] = tmap.get(this.hTB[hh]!)!;
            sub.hKB[h2] = this.hKB[hh]!;
            sub.hRest[h2] = this.hRest[hh]!;
            sub.hK[h2] = this.hK[hh]!;
            sub.hMy[h2] = this.hMy[hh]!;
            sub.hMp[h2] = this.hMp[hh]!;
            sub.hEll[h2] = this.hEll[hh]!;
            sub.hPlast[h2] = this.hPlast[hh]!;
            sub.halive[h2] = 1;
          }
          sub.th[3 * q + k] = h2;
        }
      }
    });
    for (let q = 0; q < sub.nt; q++) for (let k = 0; k < 3; k++) sub.vertTris[sub.tv[3 * q + k]!]!.push(q);
    for (let i = 0; i < nv; i++) sub.updateMass(i);
    // Detach silently: no fragment events, the piece lives on in `sub`.
    for (const t of tris) this.deleteTriangle(t, false);
    return sub;
  }

  drainEvents(): PlateEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  totalMass(): number {
    let m = 0;
    for (let i = 0; i < this.n; i++) if (this.palive[i]) m += this.mass[i]!;
    return m;
  }

  /**
   * Heat balance: grey-body radiation + convection from both faces (lossPerArea, W/m²) and in-plane
   * conduction along the bars (explicit; the Fourier number α·dt/L² is ≪ ¼ at these sizes).
   * Returns the hottest temperature, °C.
   */
  cool(dt: number, lossPerArea: (tempC: number) => number, alpha: number): number {
    const P = this.params;
    let hottest = AMBIENT_C;
    for (let e = 0; e < this.ne; e++) {
      if (!this.ealive[e]) continue;
      const A = this.eTA[e]!, k = this.eKA[e]!;
      const i = this.tv[3 * A + k]!, j = this.tv[3 * A + NEXT[k]]!;
      const Ti = this.temp[i]!, Tj = this.temp[j]!;
      if (Math.abs(Ti - Tj) < 0.5) continue;
      const L = this.eRest0[e]!;
      const g = Math.min(0.25, (alpha * dt) / (L * L));
      const mi = this.mass[i]!, mj = this.mass[j]!;
      if (!(mi > 0 && mj > 0)) continue;
      const flow = g * (Ti - Tj) * Math.min(mi, mj);
      this.temp[i] = Ti - flow / mi;
      this.temp[j] = Tj + flow / mj;
    }
    for (let i = 0; i < this.n; i++) {
      if (!this.palive[i]) continue;
      const T = this.temp[i]!;
      if (T <= AMBIENT_C + 0.5) continue;
      const area = this.mass[i]! / (P.rho * this.t0);
      const Tn = Math.max(AMBIENT_C, T - (lossPerArea(T) * area * dt) / (this.mass[i]! * P.c));
      this.temp[i] = Tn;
      if (Tn > hottest) hottest = Tn;
    }
    return hottest;
  }
}

/** Binary min-heap of (index, key) for Dijkstra. */
class MinHeap {
  private idx: Int32Array;
  private key: Float64Array;
  size = 0;
  constructor(cap: number) {
    this.idx = new Int32Array(Math.max(16, cap * 4));
    this.key = new Float64Array(Math.max(16, cap * 4));
  }
  push(i: number, k: number): void {
    if (this.size >= this.idx.length) {
      const ni = new Int32Array(this.idx.length * 2), nk = new Float64Array(this.key.length * 2);
      ni.set(this.idx);
      nk.set(this.key);
      this.idx = ni;
      this.key = nk;
    }
    let c = this.size++;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[p]! <= k) break;
      this.idx[c] = this.idx[p]!;
      this.key[c] = this.key[p]!;
      c = p;
    }
    this.idx[c] = i;
    this.key[c] = k;
  }
  pop(): number {
    const top = this.idx[0]!;
    const n = --this.size;
    const li = this.idx[n]!, lk = this.key[n]!;
    let c = 0;
    for (;;) {
      let m = 2 * c + 1;
      if (m >= n) break;
      if (m + 1 < n && this.key[m + 1]! < this.key[m]!) m++;
      if (this.key[m]! >= lk) break;
      this.idx[c] = this.idx[m]!;
      this.key[c] = this.key[m]!;
      c = m;
    }
    this.idx[c] = li;
    this.key[c] = lk;
    return top;
  }
}

/**
 * Signed dihedral angle of the hinge (x0 → x1 shared, wings xa on triangle A = (x0, x1, xa) and xb
 * on B = (x1, x0, xb)), 0 when flat, and its gradient with respect to x0, x1, xa, xb written to g
 * (12 numbers). Bridson, Marino & Fedkiw 2003, "Simulation of clothing with folds and wrinkles", §4,
 * in the unnormalised-normal form of Tamstorf & Grinspun 2013.
 */
export function dihedral(x: Float64Array, i0: number, i1: number, ia: number, ib: number, xb: Float64Array, ob: number, g: Float64Array): number {
  const o0 = 3 * i0, o1 = 3 * i1, oa = 3 * ia;
  const x0 = x[o0]!, y0 = x[o0 + 1]!, z0 = x[o0 + 2]!;
  const x1 = x[o1]!, y1 = x[o1 + 1]!, z1 = x[o1 + 2]!;
  const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
  const el2 = ex * ex + ey * ey + ez * ez;
  if (el2 < 1e-20) return NaN;
  const el = Math.sqrt(el2);
  const ax = x[oa]! - x0, ay = x[oa + 1]! - y0, az = x[oa + 2]! - z0;
  const nax = ey * az - ez * ay, nay = ez * ax - ex * az, naz = ex * ay - ey * ax;
  const bx = xb[ob]! - x1, by = xb[ob + 1]! - y1, bz = xb[ob + 2]! - z1;
  const nbx = -ey * bz + ez * by, nby = -ez * bx + ex * bz, nbz = -ex * by + ey * bx;
  const na2 = nax * nax + nay * nay + naz * naz, nb2 = nbx * nbx + nby * nby + nbz * nbz;
  if (na2 < 1e-24 || nb2 < 1e-24) return NaN;
  const inv = 1 / Math.sqrt(na2 * nb2);
  const cos = (nax * nbx + nay * nby + naz * nbz) * inv;
  const cx = nay * nbz - naz * nby, cy = naz * nbx - nax * nbz, cz = nax * nby - nay * nbx;
  const sin = ((cx * ex + cy * ey + cz * ez) / el) * inv;
  const theta = Math.atan2(sin, cos);
  const fa = el / na2, fb = el / nb2;
  g[6] = -fa * nax;
  g[7] = -fa * nay;
  g[8] = -fa * naz;
  g[9] = -fb * nbx;
  g[10] = -fb * nby;
  g[11] = -fb * nbz;
  const sa = (ax * ex + ay * ey + az * ez) / el2;
  const sb0 = ((xb[ob]! - x0) * ex + (xb[ob + 1]! - y0) * ey + (xb[ob + 2]! - z0) * ez) / el2;
  g[0] = -(1 - sa) * g[6]! - (1 - sb0) * g[9]!;
  g[1] = -(1 - sa) * g[7]! - (1 - sb0) * g[10]!;
  g[2] = -(1 - sa) * g[8]! - (1 - sb0) * g[11]!;
  g[3] = -sa * g[6]! - sb0 * g[9]!;
  g[4] = -sa * g[7]! - sb0 * g[10]!;
  g[5] = -sa * g[8]! - sb0 * g[11]!;
  return theta;
}

function invert3(m: Float64Array): Float64Array {
  const a = m[0]!, b = m[1]!, c = m[2]!, d = m[3]!, e = m[4]!, f = m[5]!, g = m[6]!, h = m[7]!, i = m[8]!;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const r = new Float64Array(9);
  if (Math.abs(det) < 1e-14) return r;
  const s = 1 / det;
  r[0] = A * s;
  r[1] = -(b * i - c * h) * s;
  r[2] = (b * f - c * e) * s;
  r[3] = B * s;
  r[4] = (a * i - c * g) * s;
  r[5] = -(a * f - c * d) * s;
  r[6] = C * s;
  r[7] = -(a * h - b * g) * s;
  r[8] = (a * e - b * d) * s;
  return r;
}
