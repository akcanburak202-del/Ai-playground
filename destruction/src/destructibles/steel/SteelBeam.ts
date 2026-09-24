import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { SimContext, SteelBeamSpec, Vec3Like } from '../../app/contracts.ts';
import { allocateDestructibleId, type Destructible, type RayHit, type Structural } from '../Destructible.ts';
import { material as getMaterial, type MaterialProps } from '../../physics/materials.ts';
import type { BlastLoad, ImpactEvent, ProbeSegment, ThicknessProbe } from '../../physics/ballistics/types.ts';
import type { PhysicsOwner } from '../../physics/PhysicsWorld.ts';
import { BeamSim } from './beamSim.ts';
import { contactCut, fm5250CutArea, sectionProps, type SectionPlate, type SectionProps } from './section.ts';
import {
  accumulateDish, contactImpulse, diffusivity, dishStrain, fractureStrain, maxBlastMomentum, panelDish, sheetHeatLoss, steelParams, plugShearHeat,
  TAYLOR_QUINNEY, AMBIENT_C, type SteelParams,
} from './steelMaterial.ts';
import { createSteelMaterial, type SteelFinish, type SteelUniforms } from './look.ts';
import { DetailMap } from './detailMap.ts';
import { offsetOutline, profileOutline, SweptMesh, type Dent, type Outline } from './profileMesh.ts';

const G = 9.80665;
/** Below this the surface shows nothing of the heat (temper colours ≈ 200 °C, glow ≈ 500 °C), °C. */
const VISIBLE_HEAT_C = 150;
/**
 * Sleep: a member whose fastest node moves slower than this (m/s) — a vibration of v/ω ≲ 0.1 mm at
 * the 20–50 Hz of a member's first modes — with no plastic flow, no load being brought on and
 * nothing growing, for SLEEP_TIME, is at rest; it costs nothing until something touches it.
 */
const SLEEP_SPEED = 0.02;
const SLEEP_TIME = 0.25;
/** Node travel (m) since the last mesh build below which the drawn shape is not rebuilt */
const MESH_TOL = 1e-3;
/**
 * Work all members may do together in one fixed step, in node-substeps (Σ nodes × substeps; one
 * costs ≈ 3 µs, more while hinges yield). A blast that wakes dozens of members shares it: each
 * gets its wanted substeps scaled by budget / demand, never fewer than MIN_SUBSTEPS.
 */
const NODE_SUBSTEP_BUDGET = 12000;
const MIN_SUBSTEPS = 2;
/** Members barely moving (m/s) step at MIN_SUBSTEPS: the exact implicit solve needs no more for a quasi-static state */
const QUIET_SPEED = 0.05;
const budget = { time: -1, demand: 0, prevDemand: 0, used: 0 };
/** Wall-clock time all members may spend rebuilding meshes per rendered frame, ms (the rest waits a frame) */
const MESH_BUDGET_MS = 6;
const meshBudget = { time: -1, spent: 0 };

function budgetAt(now: number): typeof budget {
  if (budget.time !== now) {
    budget.time = now;
    budget.prevDemand = budget.demand;
    budget.demand = 0;
    budget.used = 0;
  }
  return budget;
}
/** At most this many dents per member (smallest dropped first) and dish patches */
const MAX_DENTS = 64;
const MAX_PATCHES = 24;
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

function arr(v: Vec3Like): [number, number, number] {
  return v instanceof THREE.Vector3 ? [v.x, v.y, v.z] : [v[0], v[1], v[2]];
}

/** A straight face of the outline (for texture coordinates of surface points). */
interface OutlineFace {
  ya: number;
  za: number;
  yb: number;
  zb: number;
  pa: number;
  pb: number;
  ny: number;
  nz: number;
}

/** Frame of the straight segment between nodes i and i+1 (for ray tests). */
interface SegFrame {
  c: THREE.Vector3;
  a: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  hl: number;
  s: number;
}

interface BeamHit {
  hit: RayHit;
  seg: number;
  plate: number;
  /** Section-plane coordinates of the entry point and arc position */
  y: number;
  z: number;
  s: number;
  /** Shot direction in segment coordinates (s, y, z) */
  ds: number;
  dy: number;
  dz: number;
}

interface BeamInit {
  sim: BeamSim;
  s0: number;
  length: number;
  detail: DetailMap;
  dents: Dent[];
  patches: DishPatch[];
  /** Bearing pins of the piece (node index in the piece → bearing region) */
  pins?: Map<number, THREE.Box3>;
}

/**
 * Accumulated local damage of one spot of one profile plate (a flange, web or wall panel): the
 * permanent dish, the membrane strain it cost and how much thinner the plate is there (thinning
 * and scabs). Later loads on the same spot are resolved against what is left.
 */
interface DishPatch {
  plate: number;
  s: number;
  y: number;
  z: number;
  /** Panel radius the dish spans, m */
  R: number;
  /** Permanent dish depth, m */
  dish: number;
  /** Mean membrane strain of the dish */
  strain: number;
  /** Thickness lost (thinning + scabs), m */
  tLoss: number;
  hits: number;
  torn: boolean;
  /** The tear has been cut into the section and drawn */
  tornDrawn?: boolean;
  dent: Dent;
}

/**
 * A steel member: BeamSim (node chain with plastic hinges, P-δ, section damage, supports) drawn by
 * sweeping the real profile along the smoothed deformed axis. Hits make holes (painted into the
 * detail texture on every face the shot line crosses, and taken out of the section), dents, heat
 * and impulses; blasts load every node with the reflected impulse on its presented width; contact
 * charges breach flanges. A column under its imposed load buckles when damage has eaten its
 * capacity; a member cut through splits in two; a member held by nothing becomes a rigid body.
 */
export class SteelBeam implements Destructible, Structural {
  readonly id = allocateDestructibleId();
  readonly kind = 'beam' as const;
  readonly name: string;
  readonly root = new THREE.Group();
  readonly bounds = new THREE.Box3();
  disposed = false;
  readonly structural: Structural = this;
  readonly material: MaterialProps;
  readonly params: SteelParams;
  readonly spec: SteelBeamSpec;
  readonly section: SectionProps;
  readonly sim: BeamSim;
  mode: 'fixed' | 'rigid' = 'fixed';
  stats = { lastStepMs: 0, lastMeshMs: 0, lastImpactMs: 0, lastBlastMs: 0, awake: false, hottest: AMBIENT_C, substeps: 0, meshBuilds: 0, maxDish: 0 };

  private readonly ctx: SimContext;
  private readonly outline: Outline;
  private readonly faces: OutlineFace[] = [];
  private readonly mesh: THREE.Mesh;
  private readonly swept: SweptMesh;
  private readonly look: { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial; uniforms: SteelUniforms };
  private coat: { swept: SweptMesh; mesh: THREE.Mesh; look: { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial; uniforms: SteelUniforms } } | null = null;
  readonly detail: DetailMap;
  private readonly dents: Dent[];
  private readonly patches: DishPatch[];
  /** Node positions the mesh was last built for */
  private meshX: Float64Array | null = null;
  private stillMin = Infinity;
  /** Sim time at which this member's substep demand was counted (see noteDemand) */
  private demandTime = -1;
  private demandNodes = 0;
  /**
   * Arc length of node 0 in the original member (= sim.s0[0]: a piece's nodes keep the original
   * member's arc coordinates), and this piece's length
   */
  private readonly s0: number;
  private readonly length: number;
  private readonly owner: PhysicsOwner;
  private body: RAPIER.RigidBody | null = null;
  private frozenInv = new THREE.Matrix4();
  private frozenPose = new THREE.Matrix4();
  private awake = true;
  private still = 0;
  /** Node positions the static colliders were built for, and the sim time since the last rebuild */
  private colliderX: Float64Array | null = null;
  private colliderClock = 0;
  private dirtyMesh = true;
  private failed = false;
  private imposed = 0;
  private anchors = new Map<string, number[]>();
  /** Nodes held by a bearing underneath (a pin that carries gravity only) → the bearing's region */
  private pins = new Map<number, THREE.Box3>();
  private segs: SegFrame[] = [];
  private segVersion = -1;
  private version = 0;
  private hitCache: BeamHit | null = null;
  private hot = false;
  /** Node positions the member was built with (lean of a free-headed column, see checkFailure) */
  private restX: Float64Array | null = null;
  /** The last close-in / contact load as realised (diagnostics and the sandbox readout) */
  lastContact: { tntKg: number; kind: string; t: number; dish: number; dishR: number; breach: boolean; breachR: number; scab: number; impulse?: number; r0?: number } | null = null;
  /** Sim time since the member's temperatures were last integrated (coarse steps when not visible) */
  private coolClock = 0;
  private heatDirty = false;

  constructor(ctx: SimContext, spec: SteelBeamSpec, init?: BeamInit) {
    this.ctx = ctx;
    this.spec = spec;
    this.name = spec.name;
    this.material = getMaterial(spec.material);
    this.params = steelParams(this.material);
    this.section = init ? init.sim.section : sectionProps(spec.profile);
    this.outline = profileOutline(spec.profile, this.section.rootRadius);
    for (let i = 0; i < this.outline.verts.length - 1; i++) {
      if (this.outline.brk[i]) continue;
      const a = this.outline.verts[i]!, b = this.outline.verts[i + 1]!;
      this.faces.push({ ya: a.y, za: a.z, yb: b.y, zb: b.z, pa: a.p, pb: b.p, ny: 0.5 * (a.ny + b.ny), nz: 0.5 * (a.nz + b.nz) });
    }
    if (init) {
      this.sim = init.sim;
      this.s0 = init.s0;
      this.length = init.length;
      this.detail = init.detail;
      this.detail.refs++;
      this.dents = init.dents;
      this.patches = init.patches;
    } else {
      this.sim = new BeamSim({
        start: arr(spec.start), end: arr(spec.end), up: spec.up ? arr(spec.up) : [0, 1, 0], section: this.section, params: this.params,
        ends: { ...spec.ends }, spacing: 0.15,
      });
      this.s0 = 0;
      this.length = this.sim.ds * (this.sim.n - 1);
      // Detail texture: perimeter × length at ≈ 5 mm per texel (≤ 1024 × 2048).
      const tw = Math.min(1024, Math.max(64, Math.ceil(this.outline.perimeter / 0.005)));
      const th = Math.min(2048, Math.max(64, Math.ceil(this.length / 0.005)));
      const floatLinear = !!ctx.renderer?.extensions?.has?.('OES_texture_float_linear');
      this.detail = new DetailMap(tw, th, Math.max(16, tw >> 2), Math.max(16, th >> 2), floatLinear);
      this.dents = [];
      this.patches = [];
    }
    this.root.name = `beam:${spec.name}`;
    const finish: SteelFinish = spec.finish === 'fireproofed' ? 'mill-scale' : spec.finish === 'chrome' ? 'chrome' : spec.finish;
    this.look = createSteelMaterial({
      finish, paintColor: spec.paintColor, detail: this.detail.tex, heat: this.detail.heatTex, size: [this.outline.perimeter, this.totalLength()],
      split: false, dimpleScale: Math.max(0.005, this.maxPlateT()), diffusivity: diffusivity(this.params), seed: (this.id * 31) % 97,
    });
    this.swept = new SweptMesh(this.outline, this.length, this.s0, Math.min(0.05, this.sim.ds / 3));
    this.remapV();
    this.mesh = new THREE.Mesh(this.swept.geometry, this.look.material);
    this.mesh.customDepthMaterial = this.look.depth;
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.name = `beam-mesh:${spec.name}`;
    this.root.add(this.mesh);
    if (spec.finish === 'fireproofed') this.buildCoat();
    this.owner = { kind: 'beam', material: this.material, destructible: this };
    this.updateMesh();
    this.buildStaticColliders();
    this.restX = Float64Array.from(this.sim.x);
    if (init) {
      if (init.pins) for (const [i, b] of init.pins) this.pins.set(i, b);
      this.checkBalance();
    }
  }

  /** Length of the original member (texture v spans it, so pieces keep their marks). */
  private totalLength(): number {
    return this.spec.profile ? Math.max(this.length + this.s0, this.detailLength()) : this.length;
  }
  private detailLength(): number {
    const a = arr(this.spec.start), b = arr(this.spec.end);
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }

  /** Texture v of the swept rings: this piece's share of the original member. */
  private remapV(): void {
    const L = this.detailLength();
    const g = this.swept.geometry.getAttribute('aDUv') as THREE.BufferAttribute;
    const m = this.outline.verts.length;
    for (let k = 0; k < this.swept.rings; k++) {
      const v = (this.s0 + (k / (this.swept.rings - 1)) * this.length) / L;
      for (let i = 0; i < m; i++) g.setY(k * m + i, v);
    }
    g.needsUpdate = true;
  }

  private maxPlateT(): number {
    let t = 0;
    for (const p of this.section.plates) t = Math.max(t, p.t);
    return t;
  }

  /** Sprayed fireproofing: a 25 mm coat swept over the steel, gone wherever the steel is scarred. */
  private buildCoat(): void {
    const out = offsetOutline(this.outline, 0.025);
    const swept = new SweptMesh(out, this.length, this.s0, Math.min(0.05, this.sim.ds / 3));
    swept.dentShift = 0.025;
    const look = createSteelMaterial({
      finish: 'fireproofed', detail: this.detail.tex, heat: this.detail.heatTex, size: [out.perimeter, this.detailLength()],
      split: false, dimpleScale: 0.02, diffusivity: diffusivity(this.params), seed: (this.id * 17) % 89, coat: true,
    });
    const mesh = new THREE.Mesh(swept.geometry, look.material);
    mesh.customDepthMaterial = look.depth;
    mesh.castShadow = mesh.receiveShadow = true;
    this.root.add(mesh);
    this.coat = { swept, mesh, look };
    const g = swept.geometry.getAttribute('aDUv') as THREE.BufferAttribute;
    const src = this.swept.geometry.getAttribute('aDUv') as THREE.BufferAttribute;
    for (let i = 0; i < Math.min(g.count, src.count); i++) g.setXY(i, src.getX(i), src.getY(i));
    g.needsUpdate = true;
  }

  // ─── structural ─────────────────────────────────────────────────────────────────────────────

  weight(): number {
    return this.sim.totalMass() * G;
  }

  addAnchor(anchorId: string, regionWorld: THREE.Box3): void {
    if (this.mode === 'rigid' || this.anchors.has(anchorId)) return;
    const nodes: number[] = [];
    const s = this.sim;
    if (this.isBearing(regionWorld)) {
      // A member lying on a bearing (a beam on a pier or a wall) is held there by gravity and
      // friction, not gripped: a pin at the node nearest the bearing centre, free to rotate — a
      // simply supported span. Clamping every node over the bearing would make it a built-in end.
      const c = regionWorld.getCenter(_w);
      let best = -1, bd = Infinity;
      for (let i = 0; i < s.n; i++) {
        const d = (s.x[3 * i]! - c.x) ** 2 + (s.x[3 * i + 2]! - c.z) ** 2;
        if (d < bd && !s.locked[i]) {
          bd = d;
          best = i;
        }
      }
      if (best >= 0) {
        s.anchorNode(best);
        nodes.push(best);
        this.pins.set(best, regionWorld.clone());
      }
    } else {
      // Column bases, splices and frame joints grip the section: every node inside is held (clamped).
      const box = regionWorld.clone().expandByScalar(Math.max(this.section.cy, this.section.cz));
      for (let i = 0; i < s.n; i++) {
        _v.set(s.x[3 * i]!, s.x[3 * i + 1]!, s.x[3 * i + 2]!);
        if (box.containsPoint(_v) && !s.locked[i]) {
          s.anchorNode(i);
          nodes.push(i);
        }
      }
    }
    this.anchors.set(anchorId, nodes);
    this.wake();
  }

  /**
   * Is a support region a bearing underneath the member (it rests on it) rather than a joint that
   * grips it? A roughly horizontal member whose support lies below its axis by more than half its
   * half-depth — a column head or a frame joint encloses the section instead.
   */
  private isBearing(region: THREE.Box3): boolean {
    const s = this.sim, n = s.n;
    const ax = s.x[3 * (n - 1)]! - s.x[0]!, ay = s.x[3 * (n - 1) + 1]! - s.x[1]!, az = s.x[3 * (n - 1) + 2]! - s.x[2]!;
    const al = Math.hypot(ax, ay, az) || 1;
    if (Math.abs(ay / al) > 0.5) return false;
    const c = region.getCenter(_w);
    let k = 0, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = (s.x[3 * i]! - c.x) ** 2 + (s.x[3 * i + 2]! - c.z) ** 2;
      if (d < bd) {
        bd = d;
        k = i;
      }
    }
    // Vertical half-extent of the section at that node (u = profile up, v = sideways).
    const tx = s.t[3 * k]!, tz = s.t[3 * k + 2]!;
    const ux = s.u[3 * k]!, uy = s.u[3 * k + 1]!, uz = s.u[3 * k + 2]!;
    const vy = tz * ux - tx * uz; // (t × u)_y
    const halfY = this.section.cy * Math.abs(uy) + this.section.cz * Math.abs(vy);
    return region.max.y <= s.x[3 * k + 1]! - 0.5 * halfY;
  }

  releaseAnchor(anchorId: string): void {
    const nodes = this.anchors.get(anchorId);
    if (!nodes) return;
    this.anchors.delete(anchorId);
    for (const i of nodes) {
      this.sim.releaseNode(i);
      this.pins.delete(i);
    }
    // A column whose base went cannot hold its floor: the floor and the column come down together.
    if (this.sim.autoRoller && !this.sim.baseHeld()) this.dropHead();
    this.wake();
    this.checkBalance();
  }

  /**
   * A member left resting on a single bearing (the other one gone, or a piece of a severed span)
   * stays only while its centre of mass is over that bearing; otherwise it tips off: the pin lets
   * go and the member falls as a rigid body, pivoting on the bearing's edge through its collider.
   */
  private checkBalance(): void {
    const s = this.sim;
    if (this.mode !== 'fixed' || this.disposed || s.roller >= 0 || s.ghostOn[0] || s.ghostOn[1]) return;
    let bearing: THREE.Box3 | null = null;
    const held: number[] = [];
    for (let i = 0; i < s.n; i++) {
      if (!s.locked[i]) continue;
      const b = this.pins.get(i);
      if (!b) return; // gripped somewhere: it stands (or cantilevers) on that
      if (bearing && b !== bearing && !b.equals(bearing)) return; // two bearings: a simple span
      bearing = b;
      held.push(i);
    }
    if (!bearing || !held.length) return;
    let m = 0, cx = 0, cz = 0;
    for (let i = 0; i < s.n; i++) {
      m += s.mass[i]!;
      cx += s.mass[i]! * s.x[3 * i]!;
      cz += s.mass[i]! * s.x[3 * i + 2]!;
    }
    cx /= Math.max(m, 1e-9);
    cz /= Math.max(m, 1e-9);
    if (cx >= bearing.min.x && cx <= bearing.max.x && cz >= bearing.min.z && cz <= bearing.max.z) return;
    for (const i of held) {
      s.releaseNode(i);
      this.pins.delete(i);
    }
    this.wake();
  }

  supportPresence(regionWorld: THREE.Box3): number {
    if (this.failed || this.disposed || this.mode === 'rigid') return 0;
    const box = regionWorld.clone().expandByScalar(Math.max(this.section.cy, this.section.cz));
    let sum = 0, n = 0;
    for (let i = 0; i < this.sim.n; i++) {
      _v.set(this.sim.x[3 * i]!, this.sim.x[3 * i + 1]!, this.sim.x[3 * i + 2]!);
      if (!box.containsPoint(_v)) continue;
      sum += this.sim.areaFraction(i);
      n++;
    }
    return n ? sum / n : 0;
  }

  setImposedLoad(newtons: number): void {
    if (Math.abs(newtons - this.imposed) < 1) return;
    this.imposed = newtons;
    if (!this.failed) {
      this.sim.imposed = newtons;
      // An upper-storey column: its floor bears on its head and holds it sideways (BeamSim.holdHead);
      // with nothing left to carry, nothing holds the head either.
      if (newtons > 0 && this.mode === 'fixed') this.sim.holdHead();
      else if (newtons <= 0) this.dropHead();
    }
    this.wake();
  }

  /** Let go of a head roller that was only there because of the carried floor. */
  private dropHead(): void {
    const s = this.sim;
    if (!s.autoRoller || s.roller < 0) return;
    s.imposed = 0;
    s.releaseRoller();
    s.autoRoller = false;
  }

  hasFailed(): boolean {
    return this.failed;
  }

  private fail(cause: 'buckling' | 'severed' | 'support-lost' | 'crushing'): void {
    if (this.failed) return;
    this.failed = true;
    const c = this.bounds.getCenter(new THREE.Vector3());
    this.ctx.events.emit('structuralFailure', { time: this.ctx.time.now, position: c, label: this.name, mass: this.sim.totalMass(), cause });
    this.ctx.structure.touch(this);
  }

  // ─── stepping ───────────────────────────────────────────────────────────────────────────────

  private wake(): void {
    this.awake = true;
    this.still = 0;
    this.stillMin = Infinity;
  }

  fixedUpdate(dt: number): void {
    if (this.disposed || this.mode === 'rigid' || !this.awake) return;
    const t0 = performance.now();
    // Bound the cost of one fixed step over all members: a blast that wakes dozens of them at once
    // shares NODE_SUBSTEP_BUDGET; each takes its wanted substeps scaled by budget / demand (still
    // the exact implicit solve, just coarser in time), so a heavy step cannot run away.
    const want = this.noteDemand(dt);
    const b = budgetAt(this.ctx.time.now);
    const scale = Math.min(1, NODE_SUBSTEP_BUDGET / Math.max(1, b.demand, b.prevDemand));
    let nsub = Math.max(MIN_SUBSTEPS, Math.floor(want * scale));
    // Hard stop well past the budget (an estimate was off): the rest take the minimum.
    if (b.used + nsub * this.sim.n > 1.5 * NODE_SUBSTEP_BUDGET) nsub = MIN_SUBSTEPS;
    this.sim.maxSubsteps = Math.min(want, nsub);
    const st = this.sim.step(dt);
    b.used += st.substeps * this.sim.n;
    this.stats.substeps = st.substeps;
    this.version++;
    if (this.movedSinceMesh(MESH_TOL)) this.dirtyMesh = true;
    for (const e of this.sim.events.splice(0)) {
      const i = e.node;
      _v.set(this.sim.x[3 * i]!, this.sim.x[3 * i + 1]!, this.sim.x[3 * i + 2]!);
      if (e.type === 'connection') this.ctx.fx.sparks({ position: _v.clone(), direction: new THREE.Vector3(0, 1, 0), count: 20, speed: 8, hot: 0.5 });
    }
    this.checkFailure();
    if (this.disposed) return;
    this.checkSever();
    if (this.disposed) return;
    if (this.sim.freeFloating) {
      this.fail('support-lost');
      this.toRigid();
      return;
    }
    // Sleep once the member is at rest (no per-step cost until something touches it again): slow,
    // no plastic flow, the imposed load fully on, and the motion not growing (a column creeping
    // into a buckle starts slow but accelerates — that must keep running).
    const s = this.sim;
    const loading = Math.abs(s.applied - s.imposed) > 1e-6 * Math.max(1, s.imposed);
    if (!loading && st.maxSpeed < SLEEP_SPEED && st.plasticWork < 0.5) {
      if (st.maxSpeed > Math.max(2 * this.stillMin, 2e-3)) {
        this.still = 0;
        this.stillMin = st.maxSpeed;
      } else {
        this.stillMin = Math.min(this.stillMin, st.maxSpeed);
        this.still += dt;
      }
      if (this.still >= SLEEP_TIME) {
        this.awake = false;
        s.v.fill(0);
        s.xp.set(s.x);
      }
    } else {
      this.still = 0;
      this.stillMin = Infinity;
    }
    // Debris must collide with the member where it is now, not where it stood: refresh the static
    // colliders when it has moved by more than a few centimetres (at most every 0.25 s while
    // moving, and once more when it comes to rest).
    this.colliderClock += dt;
    if ((this.colliderClock > 0.25 || !this.awake) && this.colliderStale(0.03)) this.buildStaticColliders();
    this.stats.lastStepMs = performance.now() - t0;
    this.stats.awake = this.awake;
  }

  /** A loaded column that has shortened or bowed far beyond elastic has buckled. */
  private checkFailure(): void {
    if (this.failed) return;
    const s = this.sim;
    if (this.imposed <= 0) return;
    // Loaded end i against the held end j: the roller of a ground-storey column, or the top of an
    // upright member standing on what holds its base (an upper-storey column on its splice).
    let i: number, j: number;
    if (s.roller >= 0) {
      i = s.roller;
      j = i === 0 ? s.n - 1 : 0;
    } else {
      const lo = s.x[1]! <= s.x[3 * (s.n - 1) + 1]! ? 0 : s.n - 1;
      const L0 = s.s0[s.n - 1]! - s.s0[0]!;
      if (!s.locked[lo] || Math.abs(s.x[3 * (s.n - 1) + 1]! - s.x[1]!) < 0.7 * L0) return;
      j = lo;
      i = lo === 0 ? s.n - 1 : 0;
    }
    const drop = s.s0[s.n - 1]! - s.s0[0]! - Math.hypot(s.x[3 * i]! - s.x[3 * j]!, s.x[3 * i + 1]! - s.x[3 * j + 1]!, s.x[3 * i + 2]! - s.x[3 * j + 2]!);
    let bow = 0;
    for (let k = 1; k < s.n - 1; k++) {
      const t = k / (s.n - 1);
      const px = s.x[3 * j]! + (s.x[3 * i]! - s.x[3 * j]!) * (j === 0 ? t : 1 - t);
      const pz = s.x[3 * j + 2]! + (s.x[3 * i + 2]! - s.x[3 * j + 2]!) * (j === 0 ? t : 1 - t);
      bow = Math.max(bow, Math.hypot(s.x[3 * k]! - px, s.x[3 * k + 2]! - pz));
    }
    const L = this.length;
    // A free-headed column can also lean over on a hinge at its base (bow and chord unchanged):
    // once its head has drifted L/25 sideways it no longer carries the floor.
    let drift = 0;
    if (s.roller < 0 && this.restX) drift = Math.hypot(s.x[3 * i]! - this.restX[3 * i]!, s.x[3 * i + 2]! - this.restX[3 * i + 2]!);
    if (drop > 0.02 * L || bow > L / 25 || drift > L / 25) this.fail(drop > 0.02 * L && bow < L / 50 && drift < L / 50 ? 'crushing' : 'buckling');
  }

  /** A node that has lost > 85 % of its section is cut through: the member splits there. */
  private checkSever(): void {
    const s = this.sim;
    for (let i = 0; i < s.n; i++) {
      if (s.areaFraction(i) > 0.15) continue;
      this.split(i);
      return;
    }
  }

  private split(k: number): void {
    const s = this.sim;
    this.fail('severed');
    const parts: [number, number][] = [];
    if (k > 1) parts.push([0, k - 1]);
    if (k < s.n - 2) parts.push([k + 1, s.n - 1]);
    for (const [i0, i1] of parts) {
      const sub = s.slice(i0, i1);
      sub.imposed = 0;
      // A column piece cut free below its head hangs from nothing that could carry it (the head
      // connection only holds it sideways): it drops with the structure it held up.
      if (sub.roller >= 0 && !sub.locked.some((l) => l === 1)) sub.releaseRoller();
      const pins = new Map<number, THREE.Box3>();
      for (const [i, b] of this.pins) if (i >= i0 && i <= i1) pins.set(i - i0, b);
      const beam = new SteelBeam(this.ctx, { ...this.spec, name: `${this.name}-${i0 === 0 ? 'a' : 'b'}` }, {
        sim: sub, s0: s.s0[i0]!, length: sub.ds * (sub.n - 1), detail: this.detail, dents: this.dents, patches: this.patches, pins,
      });
      beam.failed = true;
      this.ctx.addDestructible(beam);
    }
    const c = new THREE.Vector3(s.x[3 * k]!, s.x[3 * k + 1]!, s.x[3 * k + 2]!);
    this.ctx.fx.sparks({ position: c, direction: new THREE.Vector3(0, 1, 0), count: 40, speed: 12, hot: 0.9 });
    this.ctx.events.emit('fracture', { time: this.ctx.time.now, position: c, volume: (this.section.A * s.ds) / 2, pieces: parts.length, material: this.material });
    this.dispose();
  }

  frameUpdate(dt: number): void {
    if (this.disposed) return;
    if (this.mode === 'rigid' && this.body) {
      const t = this.body.translation(), r = this.body.rotation();
      this.root.position.set(t.x, t.y, t.z);
      this.root.quaternion.set(r.x, r.y, r.z, r.w);
      this.root.updateMatrixWorld(true);
      this.bounds.copy(this.swept.geometry.boundingBox!).applyMatrix4(this.root.matrixWorld);
      if (t.y < -50) this.dispose();
    }
    if (this.hot && dt > 0) {
      // Visible heat every frame; below VISIBLE_HEAT_C coarse 0.5 s cooling steps, mesh untouched.
      this.coolClock += dt;
      const visible = this.stats.hottest >= VISIBLE_HEAT_C;
      if (visible || this.coolClock >= 0.5) {
        const hottest = this.sim.cool(this.coolClock, (T) => sheetHeatLoss(this.params, T), diffusivity(this.params));
        this.coolClock = 0;
        this.stats.hottest = hottest;
        if (hottest < AMBIENT_C + 1) this.hot = false;
        if (visible) this.heatDirty = true;
      }
    }
    let rebuild = this.dirtyMesh && this.mode === 'fixed';
    if (rebuild) {
      // Share MESH_BUDGET_MS of rebuilds per frame across members; one that has to wait keeps a
      // conservative node-based box so ray tests still find it where it is.
      const now = this.ctx.time.now;
      if (meshBudget.time !== now) {
        meshBudget.time = now;
        meshBudget.spent = 0;
      }
      if (meshBudget.spent > MESH_BUDGET_MS) {
        rebuild = false;
        this.nodeBounds();
      }
    }
    if (rebuild) {
      this.updateMesh();
      meshBudget.spent += this.stats.lastMeshMs;
    } else if (this.heatDirty) {
      this.swept.updateHeat(this.sim.temp, this.sim.n, this.sim.ds);
      this.coat?.swept.updateHeat(this.sim.temp, this.sim.n, this.sim.ds);
    }
    this.heatDirty = false;
    this.detail.upload();
    this.look.uniforms.uTime.value = this.ctx.time.now;
    if (this.coat) this.coat.look.uniforms.uTime.value = this.ctx.time.now;
  }

  /**
   * Count this member's wanted work for the current fixed step (once per step) and return its
   * wanted substep count. Also called when a load wakes it (blasts and impacts arrive before the
   * members step), so the members stepping first already see the whole demand of a blast.
   */
  private noteDemand(dt = this.ctx.time.fixedDt || 1 / 60): number {
    const s = this.sim;
    // A quiet member only needs the implicit solve's equilibrium: MIN_SUBSTEPS per step.
    s.minSubstepDt = s.maxNodeSpeed() < QUIET_SPEED ? dt / MIN_SUBSTEPS : 1 / 480;
    s.maxSubsteps = 96;
    const want = s.desiredSubsteps(dt);
    const b = budgetAt(this.ctx.time.now);
    if (this.demandTime !== b.time) {
      this.demandTime = b.time;
      this.demandNodes = 0;
    }
    const nodes = want * s.n;
    if (nodes > this.demandNodes) {
      b.demand += nodes - this.demandNodes;
      this.demandNodes = nodes;
    }
    return want;
  }

  /** Bounds from the node positions, padded by the section and the deepest dent. */
  private nodeBounds(): void {
    const s = this.sim;
    this.bounds.makeEmpty();
    for (let i = 0; i < s.n; i++) this.bounds.expandByPoint(_v.set(s.x[3 * i]!, s.x[3 * i + 1]!, s.x[3 * i + 2]!));
    this.bounds.expandByScalar(Math.hypot(this.section.cy, this.section.cz) + 0.01);
  }

  /** Has any node moved more than `tol` since the mesh was last built? */
  private movedSinceMesh(tol: number): boolean {
    const x = this.sim.x, c = this.meshX;
    if (!c || c.length !== x.length) return true;
    const t2 = tol * tol;
    for (let i = 0; i < x.length; i += 3) {
      if ((x[i]! - c[i]!) ** 2 + (x[i + 1]! - c[i + 1]!) ** 2 + (x[i + 2]! - c[i + 2]!) ** 2 > t2) return true;
    }
    return false;
  }

  private updateMesh(): void {
    const t0 = performance.now();
    if (!this.meshX || this.meshX.length !== this.sim.x.length) this.meshX = new Float64Array(this.sim.x.length);
    this.meshX.set(this.sim.x);
    this.stats.meshBuilds++;
    const s = this.sim;
    const plast = new Float64Array(s.n);
    for (let i = 0; i < s.n; i++) plast[i] = Math.max(s.bendPlast[2 * i]!, s.bendPlast[2 * i + 1]!);
    const src = { n: s.n, ds: s.ds, x: s.x, u: s.u, s0: s.s0, temp: s.temp, plast };
    const toLocal = this.mode === 'rigid' ? this.frozenInv : null;
    this.swept.update(src, this.dents, toLocal);
    if (this.coat) this.coat.swept.update(src, this.dents, toLocal);
    if (this.mode === 'fixed') this.bounds.copy(this.swept.geometry.boundingBox!);
    this.dirtyMesh = false;
    this.stats.lastMeshMs = performance.now() - t0;
  }

  // ─── ray queries ────────────────────────────────────────────────────────────────────────────

  private ensureSegs(): void {
    if (this.segVersion === this.version) return;
    const s = this.sim;
    this.segs.length = 0;
    for (let i = 0; i < s.n - 1; i++) {
      const a = new THREE.Vector3(s.x[3 * i]!, s.x[3 * i + 1]!, s.x[3 * i + 2]!);
      const b = new THREE.Vector3(s.x[3 * i + 3]!, s.x[3 * i + 4]!, s.x[3 * i + 5]!);
      const ax = b.clone().sub(a);
      const len = ax.length();
      ax.divideScalar(len || 1);
      const u = new THREE.Vector3(s.u[3 * i]! + s.u[3 * i + 3]!, s.u[3 * i + 1]! + s.u[3 * i + 4]!, s.u[3 * i + 2]! + s.u[3 * i + 5]!);
      u.addScaledVector(ax, -u.dot(ax)).normalize();
      const v = new THREE.Vector3().crossVectors(ax, u);
      this.segs.push({ c: a.add(b).multiplyScalar(0.5), a: ax, u, v, hl: 0.5 * len, s: s.s0[i]! + 0.5 * s.ds });
    }
    this.segVersion = this.version;
  }

  /** World ray → the frozen frame the node positions live in (rigid pieces move as a whole). */
  private rayToSim(origin: THREE.Vector3, dir: THREE.Vector3): void {
    _o.copy(origin);
    _d.copy(dir);
    if (this.mode === 'rigid') {
      const m = new THREE.Matrix4().copy(this.root.matrixWorld).invert().premultiply(this.frozenPose);
      _o.applyMatrix4(m);
      _d.transformDirection(m);
    }
  }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, radius = 0): RayHit | null {
    return this.rayTest(origin, dir, maxDist, false, radius);
  }

  /**
   * Ray test against the profile plates. `solidPlates: false` skips surface points where a hole
   * has been cut (projectiles pass through them) — unless the hole is narrower than the round's
   * `radius`, which strikes its rim; a blast front loads the whole plate facing it, holes or not,
   * so blasts look for the struck face with `true`.
   */
  private rayTest(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, solidPlates: boolean, radius = 0): RayHit | null {
    if (this.disposed) return null;
    this.ensureSegs();
    this.rayToSim(origin, dir);
    const plates = this.section.plates;
    let best = maxDist, bestSeg = -1, bestPlate = -1, bestAxis = 0, bestSign = 1;
    let by = 0, bz = 0, bs = 0, bdy = 0, bdz = 0, bds = 0;
    const L = this.detailLength();
    for (let k = 0; k < this.segs.length; k++) {
      const g = this.segs[k]!;
      // Ray in segment coordinates (s along the axis, y = up, z = side).
      const rx = _o.x - g.c.x, ry = _o.y - g.c.y, rz = _o.z - g.c.z;
      const os = rx * g.a.x + ry * g.a.y + rz * g.a.z, oy = rx * g.u.x + ry * g.u.y + rz * g.u.z, oz = rx * g.v.x + ry * g.v.y + rz * g.v.z;
      const ds = _d.dot(g.a), dy = _d.dot(g.u), dz = _d.dot(g.v);
      // Cheap reject against the whole segment box. This must accept rays that start inside the
      // envelope (between the flanges, or just past a perforated face), so test for any overlap
      // of the ray with the box rather than for an entry.
      const R = Math.max(this.section.cy, this.section.cz) * 1.2;
      const env = slabInterval(os, ds, -g.hl, g.hl, oy, dy, -R, R, oz, dz, -R, R);
      if (!env || env[1] < 0 || env[0] > best) continue;
      for (let p = 0; p < plates.length; p++) {
        const pl = plates[p]!;
        let hit: { t: number; axis: number; sign: number };
        if (pl.kind === 'rect') hit = slab(os, ds, -g.hl, g.hl, oy, dy, pl.cy - pl.hy, pl.cy + pl.hy, oz, dz, pl.cz - pl.hz, pl.cz + pl.hz, best);
        else hit = ringHit(os, ds, g.hl, oy, dy, oz, dz, pl, best);
        if (hit.t >= best) continue;
        const hs = os + ds * hit.t, hy = oy + dy * hit.t, hz = oz + dz * hit.t;
        const sArc = g.s + hs;
        // Through an existing hole?
        const pu = this.perimeterAt(hy, hz);
        if (!solidPlates && !(radius > 0 ? this.detail.solidDisc(pu, sArc / L, radius / this.outline.perimeter, radius / L) : this.detail.solid(pu, sArc / L))) continue;
        best = hit.t;
        bestSeg = k;
        bestPlate = p;
        bestAxis = hit.axis;
        bestSign = hit.sign;
        by = hy;
        bz = hz;
        bs = sArc;
        bdy = dy;
        bdz = dz;
        bds = ds;
      }
    }
    if (bestSeg < 0) return null;
    const g = this.segs[bestSeg]!;
    const nLocal = new THREE.Vector3();
    if (bestAxis === 0) nLocal.copy(g.a).multiplyScalar(bestSign);
    else if (bestAxis === 1) nLocal.copy(g.u).multiplyScalar(bestSign);
    else if (bestAxis === 2) nLocal.copy(g.v).multiplyScalar(bestSign);
    else nLocal.copy(g.u).multiplyScalar(by).addScaledVector(g.v, bz).normalize();
    const pSim = _o.clone().addScaledVector(_d, best);
    let point = pSim, normal = nLocal;
    if (this.mode === 'rigid') {
      const m = new THREE.Matrix4().copy(this.frozenPose).invert().premultiply(this.root.matrixWorld);
      point = pSim.clone().applyMatrix4(m);
      normal = nLocal.clone().transformDirection(m);
    }
    const hit: RayHit = { target: this, point, normal, distance: point.distanceTo(origin), material: this.material, part: bestSeg * 16 + bestPlate };
    this.hitCache = { hit, seg: bestSeg, plate: bestPlate, y: by, z: bz, s: bs, ds: bds, dy: bdy, dz: bdz };
    return hit;
  }

  /** Perimeter parameter (texture u) of a surface point of the section. */
  private perimeterAt(y: number, z: number): number {
    let best = Infinity, p = 0;
    for (const f of this.faces) {
      const ey = f.yb - f.ya, ez = f.zb - f.za;
      const l2 = ey * ey + ez * ez || 1e-12;
      const t = Math.max(0, Math.min(1, ((y - f.ya) * ey + (z - f.za) * ez) / l2));
      const d = (f.ya + t * ey - y) ** 2 + (f.za + t * ez - z) ** 2;
      if (d < best) {
        best = d;
        p = f.pa + t * (f.pb - f.pa);
      }
    }
    return p;
  }

  /**
   * The run of steel along the shot line through the profile plates it crosses (flange, then web
   * if they touch …), as segments; air between plates ends the run.
   */
  probe(hit: RayHit, dir: THREE.Vector3, maxDepth: number): ThicknessProbe {
    const c = this.hitCache && this.hitCache.hit === hit ? this.hitCache : null;
    if (!c) return { segments: [{ material: this.material, start: 0, end: Math.min(maxDepth, this.maxPlateT()), strength: 1 }], exits: true };
    const runs = this.runThrough(c, maxDepth);
    const node = this.nodeAt(c.s);
    // Craters from earlier hits thin the struck plate under this one (see DetailMap.dimple).
    if (runs.length) {
      const dent = this.detail.dimpleAt(this.perimeterAt(c.y, c.z), c.s / this.detailLength()) * Math.max(0.005, this.maxPlateT());
      const pl = this.section.plates[runs[0]!.plate]!;
      const r0 = runs[0]!;
      r0.t1 = r0.t0 + (r0.t1 - r0.t0) * Math.max(0.1, 1 - dent / Math.max(pl.t, 1e-4));
    }
    const segments: ProbeSegment[] = runs.map((r) => {
      let strength = Math.max(0.3, this.sim.frac[node * this.section.plates.length + r.plate]!);
      // A shot running along a plate's plane (a web seen edge-on) would read as a very thick plate;
      // a penetrator only engages a sliver of it, so scale the run to ~1.5 plate thicknesses.
      const pt = this.section.plates[r.plate]!.t;
      const chord = r.t1 - r.t0;
      if (pt > 0 && chord > 3 * pt) strength *= Math.max(0.05, (1.5 * pt) / chord);
      return { material: this.material, start: r.t0, end: r.t1, strength };
    });
    if (!segments.length) segments.push({ material: this.material, start: 0, end: Math.min(maxDepth, this.maxPlateT()), strength: 1 });
    const last = segments[segments.length - 1]!;
    return { segments, exits: last.end < maxDepth };
  }

  /** Contiguous intervals of profile plates along the shot from the entry point (segment frame). */
  private runThrough(c: BeamHit, maxDepth: number): { plate: number; t0: number; t1: number }[] {
    const g = this.segs[c.seg]!;
    const os = c.s - g.s, oy = c.y, oz = c.z;
    const out: { plate: number; t0: number; t1: number }[] = [];
    const plates = this.section.plates;
    for (let p = 0; p < plates.length; p++) {
      const pl = plates[p]!;
      let iv: [number, number] | null;
      if (pl.kind === 'rect') iv = slabInterval(os - 1e-5 * c.ds, c.ds, -g.hl - 1, g.hl + 1, oy - 1e-5 * c.dy, c.dy, pl.cy - pl.hy, pl.cy + pl.hy, oz - 1e-5 * c.dz, c.dz, pl.cz - pl.hz, pl.cz + pl.hz);
      else iv = ringInterval(oy, c.dy, oz, c.dz, pl);
      if (!iv || iv[1] <= 0 || iv[0] > maxDepth) continue;
      out.push({ plate: p, t0: Math.max(0, iv[0]), t1: Math.min(maxDepth, iv[1]) });
    }
    out.sort((a, b) => a.t0 - b.t0);
    const run: { plate: number; t0: number; t1: number }[] = [];
    let end = 0;
    for (const r of out) {
      if (r.t0 > end + 1e-3) break;
      run.push(r);
      end = Math.max(end, r.t1);
    }
    return run;
  }

  private nodeAt(sArc: number): number {
    return Math.max(0, Math.min(this.sim.n - 1, Math.round((sArc - this.s0) / this.sim.ds)));
  }

  // ─── impacts and blasts ─────────────────────────────────────────────────────────────────────

  applyImpact(e: ImpactEvent): void {
    if (this.disposed) return;
    const t0 = performance.now();
    let c = this.hitCache && this.hitCache.hit.point.distanceToSquared(e.point) < 1e-8 ? this.hitCache : null;
    if (!c) {
      const back = e.point.clone().addScaledVector(e.direction, -0.05);
      if (this.raycast(back, e.direction, 0.2)) c = this.hitCache;
    }
    if (!c) return;
    const P = this.params, L = this.detailLength(), per = this.outline.perimeter;
    const seed = this.ctx.rng.next() * 100;
    const d = Math.max(e.ammo.diameter, 0.004);
    const node = this.nodeAt(c.s);
    const pu = this.perimeterAt(c.y, c.z);
    const v = c.s / L;
    const time = this.ctx.time.now;
    if (e.outcome === 'perforate') {
      const r = Math.max(e.tunnelRadius, 0.3 * d);
      const clean = e.ammo.kind === 'apfsds' || e.ammo.kind === 'ap' || e.agent === 'jet';
      const run = this.runThrough(c, e.depth + 1e-3);
      this.paintHoleAlong(c, r, clean ? 0.06 : 0.25, seed, e.depth + 0.002);
      // Net-section loss: the hole takes a 2r wide strip out of every plate it crosses.
      for (const seg of run) {
        const pl = this.section.plates[seg.plate]!;
        const chord = (seg.t1 - seg.t0) * Math.hypot(c.dy, c.dz);
        this.removeSection(node, seg.plate, holeArea(pl, Math.max(chord, 0.5 * pl.t), r, c.dy, c.dz) / Math.max(pl.A, 1e-9), r);
      }
      const mRim = P.rho * this.maxPlateT() * Math.PI * 3 * r * r;
      const dT = Math.min(1450, (TAYLOR_QUINNEY * (e.agent === 'jet' ? 0.3 : 0.5) * e.energyAbsorbed) / (mRim * P.c));
      this.detail.heatSpot(pu, v, (2.5 * r) / per, (2.5 * r) / L, dT, time, 2 * r, diffusivity(P));
      // Hot bore wall (thin layer, 1-D cooling; see SteelPlate.applyImpact): q = β f E / wall area.
      let wall = 0;
      for (const seg of run) wall += (seg.t1 - seg.t0) * Math.hypot(c.dy, c.dz);
      const qMax = (TAYLOR_QUINNEY * e.energyAbsorbed) / (2 * Math.PI * r * Math.max(wall, 1e-3));
      const qWall = Math.min(qMax, plugShearHeat(P, Math.max(wall, 1e-3) / Math.max(1, run.length)) * (e.agent === 'jet' ? 2 : 1));
      this.detail.boreHeat(pu, v, (1.35 * r) / per, (1.35 * r) / L, Math.min(1450, qWall / (P.rho * P.c * 1e-3)), time, 1e-3, diffusivity(P));
      this.detail.scar(pu, v, (2.2 * r) / per, (2.2 * r) / L, 0.9, seed);
    } else {
      // Local dent of the struck plate (flange / web / wall): the crater, and for heavy rounds a
      // dish of the whole panel (below).
      const rc = Math.max(e.craterRadius, 0.6 * d);
      const depth = Math.max(e.craterDepth, e.outcome === 'embed' ? e.depth : 0);
      this.detail.dimple(pu, v, rc / per, rc / L, Math.min(1, depth / Math.max(0.005, this.maxPlateT())));
      this.detail.scar(pu, v, (1.8 * rc) / per, (1.8 * rc) / L, 1, seed);
      // The momentum the round leaves in the plate dishes the panel it struck: Nurick & Martin's
      // localised-impulse relation (panelDish) with the crater as the loaded radius. Rifle rounds
      // leave nothing visible; heavy rounds and big fragments dish a flange by millimetres.
      const Rp = this.panelRadius(c.plate);
      const tLoc = this.localThickness(c);
      const dishAdd = panelDish(P, e.momentum.length(), Rp, Math.max(rc, d), tLoc);
      if (dishAdd > 0.001) {
        const patch = this.dish(c, Math.min(Rp, Math.max(2 * rc, 0.5 * e.damageRadius)), dishAdd, 0);
        if (patch.torn && !patch.tornDrawn) {
          patch.tornDrawn = true;
          this.tearPatch(c, patch, seed);
        }
      }
      const V = Math.PI * rc * rc * Math.max(depth, 5e-4) * 0.5;
      const dT = Math.min(1450, (TAYLOR_QUINNEY * Math.min(e.energyAbsorbed, 12 * P.fy * V)) / (P.rho * V * 3 * P.c));
      this.detail.heatSpot(pu, v, (1.5 * rc) / per, (1.5 * rc) / L, dT, time, rc, diffusivity(P));
    }
    // Structural impulse at the struck arc position (perforations: the penetration resistance only).
    let Pm = e.momentum.length();
    if (e.outcome === 'perforate' && e.agent !== 'jet') {
      const r = Math.max(e.tunnelRadius, 0.5 * d);
      Pm = Math.min(Pm, (3.5 * P.fy * Math.PI * r * r * e.depth) / Math.max(1, 0.5 * (e.speed + e.residualSpeed)));
    }
    const J = e.momentum.clone().setLength(Pm);
    if (this.mode === 'rigid' && this.body) this.ctx.physics.applyImpulseAt(this.body, J, e.point);
    else if (Pm > 0) {
      this.sim.addImpulse(c.s - this.s0, J.x, J.y, J.z);
      this.wake();
      this.noteDemand();
    }
    const sparkN = Math.round(Math.min(60, 4 + Math.sqrt(e.kineticEnergy) / 12));
    this.ctx.fx.sparks({ position: e.point, direction: e.outcome === 'ricochet' && e.residualDirection ? e.residualDirection : e.normal, count: sparkN, speed: Math.min(60, 8 + e.speed * 0.03), hot: 0.6 });
    this.warm();
    this.dirtyMesh = true;
    this.checkSever();
    this.stats.lastImpactMs = performance.now() - t0;
  }

  /** Paint a hole on every outline face the shot line crosses within `depth` of the entry. */
  private paintHoleAlong(c: BeamHit, r: number, jag: number, seed: number, depth: number): void {
    const L = this.detailLength(), per = this.outline.perimeter;
    for (const f of this.faces) {
      const ny = f.ny, nz = f.nz;
      const dn = c.dy * ny + c.dz * nz;
      if (Math.abs(dn) < 1e-4) continue;
      const t = ((f.ya - c.y) * ny + (f.za - c.z) * nz) / dn;
      if (t < -1e-4 || t > depth) continue;
      const y = c.y + t * c.dy, z = c.z + t * c.dz;
      const ey = f.yb - f.ya, ez = f.zb - f.za;
      const l2 = ey * ey + ez * ez;
      const q = ((y - f.ya) * ey + (z - f.za) * ez) / l2;
      if (q < -0.05 || q > 1.05) continue;
      const pu = f.pa + Math.max(0, Math.min(1, q)) * (f.pb - f.pa);
      const s = c.s + t * c.ds;
      const k = 1 / Math.sqrt(Math.max(0.2, Math.abs(dn)));
      this.detail.hole(pu, s / L, (r * k) / per, (r * k) / L, jag, seed + t);
    }
  }

  /** Take a fraction of plate p's section out at node i (and a share at neighbours for wide holes). */
  private removeSection(i: number, p: number, frac: number, r: number): void {
    const s = this.sim, P = this.section.plates.length;
    const apply = (k: number, f: number) => {
      if (k < 0 || k >= s.n || f <= 0) return;
      const idx = k * P + p;
      s.frac[idx] = Math.max(0, s.frac[idx]! - f);
      s.updateSection(k);
    };
    apply(i, frac);
    const spread = r / s.ds;
    if (spread > 0.5) {
      apply(i - 1, frac * Math.min(1, spread - 0.5));
      apply(i + 1, frac * Math.min(1, spread - 0.5));
    }
    this.wake();
    // What this member holds up (and how much of it is left) changed: let the graph re-check.
    this.ctx.structure.touch(this);
  }

  /**
   * The dish patch of the struck plate at this spot (within half a dish radius of an earlier one),
   * or null. Loads on a patch are resolved against the thinned plate and deepen its dish.
   */
  private patchAt(c: BeamHit, R: number): DishPatch | null {
    let best: DishPatch | null = null, bd = Infinity;
    for (const p of this.patches) {
      if (p.plate !== c.plate) continue;
      const reach = 0.5 * Math.max(p.R, R);
      const d = Math.hypot(c.s - p.s, c.y - p.y, c.z - p.z);
      if (d < reach && d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  /** Panel radius of profile plate p: half its width between the edges that hold it, m. */
  private panelRadius(p: number): number {
    const pl = this.section.plates[p]!;
    if (pl.kind === 'arc') return Math.max(0.5 * pl.r1, (pl.r1 * (pl.a1 - pl.a0)) / 2);
    return Math.max(pl.hy, pl.hz, 2 * pl.t);
  }

  /** Remaining thickness of the struck plate under this spot (thinning and scabs of earlier loads), m. */
  private localThickness(c: BeamHit): number {
    const pl = this.section.plates[c.plate]!;
    const patch = this.patchAt(c, this.panelRadius(c.plate));
    return Math.max(0.1 * pl.t, pl.t - (patch?.tLoss ?? 0));
  }

  /**
   * A permanent dish of the struck plate: deepens the patch at this spot (Jones' δ ∝ √(Σ E)
   * accumulation, see accumulateDish), thins it by the membrane strain it costs (volume constancy)
   * plus any scab, and draws it as an inward dent of the face (rest coordinates, so it rides along
   * when the member bends). Returns the patch; `torn` when the accumulated strain has reached the
   * fracture strain of the plate — an earlier dish is required, a single load's tearing is the
   * ballistics module's breach verdict.
   */
  private dish(c: BeamHit, R: number, add: number, scab: number): DishPatch {
    const pl = this.section.plates[c.plate]!;
    let patch = this.patchAt(c, R);
    const before = patch ? patch.dish : 0;
    if (!patch) {
      const f = this.faceAt(c.y, c.z);
      const type = this.section.profile.type;
      const freeEdges = (type === 'I' && pl.name.endsWith('flange')) || type === 'cruciform';
      const dent: Dent = { s: c.s, y: c.y, z: c.z, dy: -f.ny, dz: -f.nz, R, depth: 0, t: pl.t, freeEdges };
      patch = { plate: c.plate, s: c.s, y: c.y, z: c.z, R, dish: 0, strain: 0, tLoss: 0, hits: 0, torn: false, dent };
      this.dents.push(dent);
      this.patches.push(patch);
      if (this.patches.length > MAX_PATCHES) {
        let k = 0;
        for (let i = 1; i < this.patches.length; i++) if (this.patches[i]!.dish < this.patches[k]!.dish) k = i;
        this.patches.splice(k, 1);
      }
    }
    patch.hits++;
    patch.R = Math.max(patch.R, R);
    // A dish deeper than its own radius is no longer a dish but a hole (tearing takes over).
    patch.dish = Math.min(patch.R, accumulateDish(patch.dish, add));
    const eps = dishStrain(patch.dish, patch.R);
    const dEps = Math.max(0, eps - patch.strain);
    patch.strain = Math.max(patch.strain, eps);
    const tLeft = pl.t - patch.tLoss;
    patch.tLoss = Math.min(pl.t, patch.tLoss + tLeft * (1 - 1 / (1 + dEps)) + Math.max(0, scab));
    // Fracture at the element-size regularised strain (GL criterion, steelMaterial.fractureStrain)
    // with the dish radius as the "element": the strain is a mean over it.
    if (!patch.torn && before > 0 && (eps >= fractureStrain(this.params, pl.t, patch.R) || patch.tLoss >= 0.9 * pl.t)) patch.torn = true;
    // Drawn dish: the plate cannot pass through the far side of the section.
    patch.dent.R = patch.R;
    patch.dent.depth = Math.min(patch.dish, 0.45 * Math.min(2 * this.section.cy, 2 * this.section.cz));
    this.stats.maxDish = Math.max(this.stats.maxDish, patch.dish);
    this.pruneDents();
    this.dirtyMesh = true;
    return patch;
  }

  /**
   * A dish whose accumulated strain reached fracture tears open: a petalled hole of ≈ 0.4 of the
   * dish radius through the struck plate (its share of the section goes with it).
   */
  private tearPatch(c: BeamHit, patch: DishPatch, seed: number): void {
    const pl = this.section.plates[c.plate]!;
    const rb = 0.4 * patch.R;
    this.paintHoleAlong(c, rb, 0.5, seed + 7, pl.t * 1.5 + 0.002);
    this.removeSection(this.nodeAt(c.s), c.plate, holeArea(pl, pl.t, rb, c.dy, c.dz) / Math.max(pl.A, 1e-9), rb);
    this.ctx.fx.sparks({ position: c.hit.point.clone(), direction: c.hit.normal.clone(), count: 30, speed: 14, hot: 0.8 });
  }

  /**
   * A placed demolition charge that has breached the plate it sits on cuts the section around it:
   * every plate within a radius R of the charge loses its steel inside R, R set by the charge's
   * FM 5-250 cut area (section.ts contactCut / fm5250CutArea: 2.1 kg TNT cuts an HEB 200) and
   * bounded by 4 r_b, the reach of the products that shear through behind the breach. The struck
   * plate loses at least the breach itself. The kerf along the member is the breach width.
   */
  private cutSection(node: number, c: BeamHit, load: BlastLoad, rb: number, seed: number): void {
    const g = this.segs[c.seg]!;
    const sec = this.section, P = sec.plates.length;
    _v.copy(load.center).sub(g.c);
    // The charge in section coordinates, pulled onto the struck face if it sits off it.
    let y0 = _v.dot(g.u), z0 = _v.dot(g.v);
    const off = Math.hypot(y0 - c.y, z0 - c.z);
    if (off > rb) {
      y0 = c.y + ((y0 - c.y) * rb) / off;
      z0 = c.z + ((z0 - c.z) * rb) / off;
    }
    const pl = sec.plates[c.plate]!;
    const budget = fm5250CutArea(load.tntKg, this.material.tensileStrength);
    const { lost, R } = contactCut(sec, y0, z0, budget, Math.max(4 * rb, pl.t + rb), this.sim.frac, node * P);
    lost[c.plate] = Math.max(lost[c.plate]!, holeArea(pl, pl.t, rb, c.dy, c.dz) * this.sim.frac[node * P + c.plate]!);
    for (let p = 0; p < P; p++) if (lost[p]! > 0) this.removeSection(node, p, lost[p]! / Math.max(sec.plates[p]!.A, 1e-9), rb);
    // Draw the cut: a hole on every face of the outline within R of the charge, as long across the
    // face as the disc's chord there and as wide along the member as the breach.
    const L = this.detailLength(), per = this.outline.perimeter, v = c.s / L;
    const Rd = Math.max(R, rb);
    for (const f of this.faces) {
      const ey = f.yb - f.ya, ez = f.zb - f.za;
      const l2 = ey * ey + ez * ez || 1e-12;
      const t = Math.max(0, Math.min(1, ((y0 - f.ya) * ey + (z0 - f.za) * ez) / l2));
      const d = Math.hypot(f.ya + t * ey - y0, f.za + t * ez - z0);
      if (d >= Rd) continue;
      const half = Math.sqrt(Rd * Rd - d * d);
      this.detail.hole(f.pa + t * (f.pb - f.pa), v, half / per, (1.1 * rb) / L, 0.45, seed + d * 100);
    }
  }

  /** Keep at most MAX_DENTS dents: the shallowest go first (never a live dish patch). */
  private pruneDents(): void {
    while (this.dents.length > MAX_DENTS) {
      let k = -1;
      for (let i = 0; i < this.dents.length; i++) {
        const d = this.dents[i]!;
        if (this.patches.some((p) => p.dent === d)) continue;
        if (k < 0 || d.depth < this.dents[k]!.depth) k = i;
      }
      if (k < 0) k = 0;
      this.dents.splice(k, 1);
    }
  }

  private faceAt(y: number, z: number): OutlineFace {
    let best = Infinity, face = this.faces[0]!;
    for (const f of this.faces) {
      const ey = f.yb - f.ya, ez = f.zb - f.za;
      const l2 = ey * ey + ez * ez || 1e-12;
      const t = Math.max(0, Math.min(1, ((y - f.ya) * ey + (z - f.za) * ez) / l2));
      const d = (f.ya + t * ey - y) ** 2 + (f.za + t * ez - z) ** 2;
      if (d < best) {
        best = d;
        face = f;
      }
    }
    return face;
  }

  applyBlast(load: BlastLoad): void {
    if (this.disposed) return;
    const t0 = performance.now();
    const s = this.sim;
    if (this.mode === 'rigid') {
      if (this.body) {
        const c = this.bounds.getCenter(new THREE.Vector3());
        const n = c.clone().sub(load.center).normalize();
        const I = load.reflectedImpulseAt(c, n.clone().negate());
        // The BlastSystem already pushes each loose body as a sphere of equal volume (π r_eq²);
        // a long member presents more, so only the difference is added here.
        const m = s.totalMass();
        const rEq = Math.cbrt((3 * m) / (4 * Math.PI * this.params.rho));
        const area = Math.max(0, this.length * 2 * Math.max(this.section.cy, this.section.cz) - Math.PI * rEq * rEq);
        if (area > 0) this.ctx.physics.applyImpulseAt(this.body, n.multiplyScalar(Math.min(I * area, 300 * m)), c);
      }
      return;
    }
    this.ensureSegs();
    const w3 = Math.cbrt(Math.max(load.tntKg, 1e-6));
    let nearest = 0, nd = Infinity;
    const Jb = new Float64Array(3 * s.n);
    let Jsum = 0;
    for (let i = 0; i < s.n; i++) {
      _v.set(s.x[3 * i]!, s.x[3 * i + 1]!, s.x[3 * i + 2]!);
      const d2 = _v.distanceToSquared(load.center);
      if (d2 < nd) {
        nd = d2;
        nearest = i;
      }
      // Direction from the charge, in the section plane.
      const g = this.segs[Math.min(i, this.segs.length - 1)]!;
      const dir = _v.clone().sub(load.center);
      dir.addScaledVector(g.a, -dir.dot(g.a));
      const dl = dir.length();
      if (dl < 1e-6) continue;
      dir.divideScalar(dl);
      // Presented width of the profile seen from the charge.
      const e = new THREE.Vector3().crossVectors(g.a, dir);
      const width = 2 * (this.section.cy * Math.abs(e.dot(g.u)) + this.section.cz * Math.abs(e.dot(g.v)));
      // The load acts on the face towards the charge, not at the centroid: step back from the node
      // by the section's half-depth in that direction (matters for charges on the flange).
      const half = this.section.cy * Math.abs(dir.dot(g.u)) + this.section.cz * Math.abs(dir.dot(g.v));
      const trib = i === 0 || i === s.n - 1 ? 0.5 * s.ds : s.ds;
      // Average over the node's tributary length (5 points): a contact charge's footprint is
      // smaller than the node spacing, and one sample at the node would see it obliquely.
      const nIn = dir.clone().negate();
      let I = 0;
      for (let q = 0; q < 5; q++) {
        const off = ((q + 0.5) / 5 - 0.5) * trib;
        _w.copy(_v).addScaledVector(dir, -Math.min(half, Math.max(0, dl - 0.01))).addScaledVector(g.a, off);
        I += 0.2 * load.reflectedImpulseAt(_w, nIn);
      }
      const Jn = Math.min(I * width * trib, 300 * s.mass[i]!);
      Jb[3 * i] = dir.x * Jn;
      Jb[3 * i + 1] = dir.y * Jn;
      Jb[3 * i + 2] = dir.z * Jn;
      Jsum += Jn;
    }
    const standoff = Math.sqrt(nd) - Math.max(this.section.cy, this.section.cz);
    const contact = load.contactTargetId === this.id || ((load.kind === 'contact' || load.kind === 'hesh') && standoff < 0.35 * w3);
    // Never more momentum than the charge's products can deliver (maxBlastMomentum); a charge in
    // contact gives the member the impulse its dish is computed from (contactImpulse).
    const Jcap = contact ? contactImpulse(load.tntKg, load.kind) : maxBlastMomentum(load.tntKg, load.kind);
    const Jscale = Math.min(1, Jcap / Math.max(Jsum, 1e-9));
    // A distant blast that cannot move any node by more than a few cm/s, beyond the fireball's
    // reach, changes nothing: do not wake the member for it.
    if (!contact && standoff > 2 * w3) {
      let dv = 0;
      for (let i = 0; i < s.n; i++) dv = Math.max(dv, (Math.hypot(Jb[3 * i]!, Jb[3 * i + 1]!, Jb[3 * i + 2]!) * Jscale) / Math.max(s.mass[i]!, 1e-9));
      if (dv < 0.05) {
        this.stats.lastBlastMs = performance.now() - t0;
        return;
      }
    }
    for (let i = 0; i < s.n; i++) {
      if (Jb[3 * i] === 0 && Jb[3 * i + 1] === 0 && Jb[3 * i + 2] === 0) continue;
      s.addImpulse(s.s0[i]! - this.s0, Jb[3 * i]! * Jscale, Jb[3 * i + 1]! * Jscale, Jb[3 * i + 2]! * Jscale);
    }
    // Face towards the charge at the foot of the charge on the member axis (not the nearest node,
    // which would bias every mark to the node grid): where soot, dishes and breaches go.
    const probeFrom = load.center.clone();
    const toNode = this.axisFoot(load.center, nearest, new THREE.Vector3()).sub(probeFrom).normalize();
    const hit = this.rayTest(probeFrom, toNode, Math.sqrt(nd) + 1, true);
    const c = hit ? this.hitCache : null;
    const seed = this.ctx.rng.next() * 100;
    const L = this.detailLength(), per = this.outline.perimeter;
    if (c && hit) {
      const pu = this.perimeterAt(c.y, c.z), v = c.s / L;
      const pl = this.section.plates[c.plate]!;
      const Rp = this.panelRadius(c.plate);
      // Soot only within reach of the fireball (see SteelPlate.applyBlast).
      const rs = Math.min(1.5, 0.3 * w3 + 0.4 * Math.max(0, standoff));
      if (standoff < 2 * w3) this.detail.soot(pu, v, rs / per, rs / L, Math.min(0.9, (0.35 * w3) / Math.max(0.2, standoff)), seed);
      // What is left of the struck plate here (earlier dishes thinned it, scabs took its back).
      const tLoc = this.localThickness(c);
      let dishAdd = 0, dishR = Rp, breach = false, rb = 0, scabR = 0, scabD = 0, crater = 0;
      if (contact) {
        // The ballistics module's contact numbers for the plate as it is now, realised in full.
        const cd = load.contactDamage(this.material, tLoc);
        dishAdd = cd.craterDepth;
        dishR = Math.min(Rp, Math.max(0.05, cd.craterRadius));
        breach = cd.breach && cd.breachRadius > 0;
        rb = cd.breachRadius;
        crater = cd.craterRadius;
        if (cd.spallRadius > 0 && !breach) {
          // Hopkinson scab off the far side of the struck plate, bounded by the charge footprint
          // ≈ 0.1 W^⅓ as for plates (Held 1981, see SteelPlate.applyBlast).
          scabR = Math.min(cd.spallRadius, 0.1 * w3);
          scabD = Math.min(tLoc, cd.spallDepth);
        }
        this.lastContact = { tntKg: load.tntKg, kind: load.kind, t: tLoc, dish: cd.craterDepth, dishR: cd.craterRadius, breach: cd.breach, breachR: cd.breachRadius, scab: cd.spallDepth };
      } else if (standoff < 2 * w3) {
        // Close-in air burst (a delay-fuzed shell that went off behind the flange it holed, a
        // charge beside the member): the reflected impulse over the panel dishes it — Nurick &
        // Martin's localised-impulse relation with the impulse integrated over the panel disc
        // (rings of radius r ≤ R_p about the point nearest the charge) and the loaded radius r0
        // where the specific impulse has fallen to half its peak.
        const g = this.segs[Math.min(c.seg, this.segs.length - 1)]!;
        const n = hit.normal;
        const K = 6;
        let I = 0, i0 = 0, r0 = Rp, prevI = 0;
        for (let k = 0; k <= K; k++) {
          const r = (Rp * k) / K;
          // Average of the two sides along the member axis (the charge may sit off the patch).
          _w.copy(hit.point).addScaledVector(g.a, r);
          let ik = load.reflectedImpulseAt(_w, n);
          _w.copy(hit.point).addScaledVector(g.a, -r);
          ik = 0.5 * (ik + load.reflectedImpulseAt(_w, n));
          if (k === 0) i0 = ik;
          else {
            const dr = Rp / K;
            I += Math.PI * dr * (prevI * (r - dr) + ik * r); // trapezoid of ∫ i(r) 2πr dr
            if (r0 === Rp && ik < 0.5 * i0) r0 = r - dr * ((0.5 * i0 - ik) / Math.max(prevI - ik, 1e-9));
          }
          prevI = ik;
        }
        // The panel cannot take more than the member's share of the charge's momentum.
        I = Math.min(I * Jscale, Jcap);
        dishAdd = panelDish(this.params, I, Rp, Math.max(r0, 0.053 * w3), tLoc);
        this.lastContact = { tntKg: load.tntKg, kind: load.kind, t: tLoc, dish: dishAdd, dishR: Rp, breach: false, breachR: 0, scab: 0, impulse: I, r0 };
      }
      // A breach the ballistics module did not call but the accumulated strain did is a tear of the
      // struck plate only (the web and the far flange behind it are untouched by a dish).
      let torn = false;
      if (dishAdd > 5e-4 || breach || scabD > 0) {
        const patch = this.dish(c, dishR, dishAdd, scabD);
        if (!breach && patch.torn) {
          breach = torn = true;
          rb = Math.max(rb, 0.4 * patch.R);
        }
        if (breach) patch.torn = patch.tornDrawn = true;
      }
      if (breach) {
        const node = this.nodeAt(c.s);
        if (torn) {
          this.paintHoleAlong(c, rb, 0.5, seed, pl.t * 1.5 + 0.002);
          this.removeSection(node, c.plate, holeArea(pl, pl.t, rb, c.dy, c.dz) / Math.max(pl.A, 1e-9), rb);
        } else if (contact && load.kind === 'contact' && this.mode === 'fixed') {
          // A placed demolition charge: cuts the section around it (FM 5-250, see cutSection).
          this.cutSection(node, c, load, rb, seed);
        } else {
          // A shell's charge (HE, HESH, the blast of a shaped charge) holes the struck plate over
          // 2·r_b; its products come through the hole and shear what stands right behind it within
          // ½ r_b (a web root behind a flange), no further — the section behind is not cut.
          const behind = pl.t + 0.5 * rb;
          this.paintHoleAlong(c, rb, 0.45, seed, behind + 0.002);
          const run = this.runThrough(c, behind);
          for (const seg of run) {
            const p = this.section.plates[seg.plate]!;
            const chord = (seg.t1 - seg.t0) * Math.hypot(c.dy, c.dz);
            this.removeSection(node, seg.plate, holeArea(p, seg.plate === c.plate ? p.t : chord, rb, c.dy, c.dz) / Math.max(p.A, 1e-9), rb);
          }
        }
        this.ctx.fx.chips({ position: hit.point.clone(), direction: toNode, spread: 0.7, speed: 150, count: 30, size: 0.02, color: 0x3a3d40, kind: 'metal' });
      }
      if (contact) {
        // The charge strips coating and scale under its footprint on the struck face.
        this.detail.scar(pu, v, crater / per, crater / L, 0.8, seed + 2);
        this.detail.heatSpot(pu, v, (0.06 * w3) / per, (0.06 * w3) / L, 500, this.ctx.time.now, 0.004, diffusivity(this.params), false);
      } else if (dishAdd > 2e-3) {
        // A dished panel sheds its paint and mill scale where it stretched.
        this.detail.scar(pu, v, (0.6 * Rp) / per, (0.6 * Rp) / L, Math.min(0.8, dishAdd / pl.t), seed + 2);
      }
      if (scabD > 0) {
        const f = this.faceAt(c.y, c.z);
        const pr = this.perimeterAt(c.y - f.ny * pl.t * 1.05, c.z - f.nz * pl.t * 1.05);
        this.detail.scab(pr, v, scabR / per, scabR / L, Math.min(1, scabD / Math.max(0.005, this.maxPlateT())), seed + 1);
        if (!breach) this.removeSection(this.nodeAt(c.s), c.plate, (2 * scabR * scabD) / Math.max(pl.A, 1e-9), scabR);
      }
    }
    this.warm();
    this.dirtyMesh = true;
    this.wake();
    if (!this.disposed) this.noteDemand();
    this.checkSever();
    this.stats.lastBlastMs = performance.now() - t0;
  }

  /** Point of the node polyline nearest to p, searched on the two segments around node `near`. */
  private axisFoot(p: THREE.Vector3, near: number, out: THREE.Vector3): THREE.Vector3 {
    const s = this.sim;
    let bd = Infinity;
    out.set(s.x[3 * near]!, s.x[3 * near + 1]!, s.x[3 * near + 2]!);
    for (let i = Math.max(0, near - 1); i < Math.min(s.n - 1, near + 1); i++) {
      const ax = s.x[3 * i]!, ay = s.x[3 * i + 1]!, az = s.x[3 * i + 2]!;
      const ex = s.x[3 * i + 3]! - ax, ey = s.x[3 * i + 4]! - ay, ez = s.x[3 * i + 5]! - az;
      const t = Math.max(0, Math.min(1, ((p.x - ax) * ex + (p.y - ay) * ey + (p.z - az) * ez) / (ex * ex + ey * ey + ez * ez || 1e-12)));
      const qx = ax + t * ex, qy = ay + t * ey, qz = az + t * ez;
      const d = (qx - p.x) ** 2 + (qy - p.y) ** 2 + (qz - p.z) ** 2;
      if (d < bd) {
        bd = d;
        out.set(qx, qy, qz);
      }
    }
    return out;
  }

  /** Heat was added: check the temperatures on the next frame. */
  private warm(): void {
    this.hot = true;
    this.stats.hottest = Math.max(this.stats.hottest, VISIBLE_HEAT_C);
  }

  // ─── physics bodies ─────────────────────────────────────────────────────────────────────────

  /** Fixed cuboids along the member so debris collides with it. */
  private staticBody: RAPIER.RigidBody | null = null;

  /** Has any node moved more than `tol` metres since the static colliders were built? */
  private colliderStale(tol: number): boolean {
    const x = this.sim.x, c = this.colliderX;
    if (!c) return true;
    for (let i = 0; i < x.length; i += 3) {
      if ((x[i]! - c[i]!) ** 2 + (x[i + 1]! - c[i + 1]!) ** 2 + (x[i + 2]! - c[i + 2]!) ** 2 > tol * tol) return true;
    }
    return false;
  }

  private buildStaticColliders(): void {
    const phys = this.ctx.physics;
    if (this.staticBody) {
      try {
        phys.removeBody(this.staticBody);
      } catch {
        // World replaced on scene change.
      }
      this.staticBody = null;
    }
    this.colliderX = Float64Array.from(this.sim.x);
    this.colliderClock = 0;
    try {
      this.staticBody = phys.createFixed(new THREE.Vector3(), undefined, this.segmentColliders(new THREE.Matrix4()), this.owner);
    } catch {
      this.staticBody = null;
    }
  }

  private segmentColliders(toLocal: THREE.Matrix4): RAPIER.ColliderDesc[] {
    this.ensureSegs();
    const R = this.ctx.physics.R;
    const out: RAPIER.ColliderDesc[] = [];
    const q = new THREE.Quaternion(), m = new THREE.Matrix4(), c = new THREE.Vector3();
    const massPerSeg = this.sim.totalMass() / Math.max(1, this.segs.length);
    for (const g of this.segs) {
      m.makeBasis(g.a, g.u, g.v).premultiply(new THREE.Matrix4().extractRotation(toLocal));
      q.setFromRotationMatrix(m);
      c.copy(g.c).applyMatrix4(toLocal);
      const d = R.ColliderDesc.cuboid(g.hl, this.section.cy, this.section.cz).setTranslation(c.x, c.y, c.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
      d.setMass(massPerSeg).setFriction(0.6);
      out.push(d);
    }
    return out;
  }

  /** Nothing holds the member: freeze its shape and let Rapier carry it. */
  private toRigid(): void {
    if (this.mode === 'rigid') return;
    const phys = this.ctx.physics, s = this.sim;
    if (this.staticBody) {
      phys.removeBody(this.staticBody);
      this.staticBody = null;
    }
    this.ensureSegs();
    const com = new THREE.Vector3();
    let m = 0;
    for (let i = 0; i < s.n; i++) {
      com.x += s.mass[i]! * s.x[3 * i]!;
      com.y += s.mass[i]! * s.x[3 * i + 1]!;
      com.z += s.mass[i]! * s.x[3 * i + 2]!;
      m += s.mass[i]!;
    }
    com.divideScalar(Math.max(m, 1e-9));
    const vel = new THREE.Vector3();
    for (let i = 0; i < s.n; i++) vel.addScaledVector(new THREE.Vector3(s.v[3 * i]!, s.v[3 * i + 1]!, s.v[3 * i + 2]!), s.mass[i]! / m);
    // Keep the spin too: ω = I⁻¹ L about the centre of mass (point masses on the nodes, plus the
    // section's own radius of gyration so the inertia about the member axis is not zero). A piece
    // kicked at one end tumbles instead of flying off upright.
    const Lm = new THREE.Vector3(), r = new THREE.Vector3(), vi = new THREE.Vector3();
    const k2 = (this.section.cy ** 2 + this.section.cz ** 2) / 4;
    const I = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < s.n; i++) {
      const mi = s.mass[i]!;
      r.set(s.x[3 * i]! - com.x, s.x[3 * i + 1]! - com.y, s.x[3 * i + 2]! - com.z);
      vi.set(s.v[3 * i]!, s.v[3 * i + 1]!, s.v[3 * i + 2]!);
      Lm.add(r.clone().cross(vi).multiplyScalar(mi));
      const rr = r.lengthSq() + k2;
      const c = [r.x, r.y, r.z];
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) I[3 * a + b] = I[3 * a + b]! + mi * ((a === b ? rr : 0) - c[a]! * c[b]!);
    }
    const Iinv = new THREE.Matrix3().set(I[0]!, I[1]!, I[2]!, I[3]!, I[4]!, I[5]!, I[6]!, I[7]!, I[8]!);
    const angvel = Iinv.determinant() > 1e-12 ? Lm.applyMatrix3(Iinv.invert()) : new THREE.Vector3();
    if (angvel.length() > 30) angvel.setLength(30);
    this.frozenPose.makeTranslation(com.x, com.y, com.z);
    this.frozenInv.copy(this.frozenPose).invert();
    this.mode = 'rigid';
    this.updateMesh();
    this.body = phys.createDynamic({ position: com, colliders: this.segmentColliders(this.frozenInv), owner: this.owner, linvel: vel, angvel, contactForceThreshold: 5e4 });
    this.root.position.copy(com);
    this.root.quaternion.identity();
    this.root.updateMatrixWorld(true);
    this.owner.onContactForce = (info) => {
      if (info.totalForce * info.dt < 100) return;
      this.ctx.events.emit('debrisContact', {
        time: this.ctx.time.now, position: info.point ?? this.bounds.getCenter(new THREE.Vector3()), impulse: info.totalForce * info.dt,
        size: this.length, material: this.material,
      });
    };
    this.ctx.structure.remove(this);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of [this.body, this.staticBody]) {
      if (!b) continue;
      try {
        this.ctx.physics.removeBody(b);
      } catch {
        // World replaced on scene change.
      }
    }
    this.body = this.staticBody = null;
    this.root.removeFromParent();
    this.swept.dispose();
    this.look.material.dispose();
    this.look.depth.dispose();
    if (this.coat) {
      this.coat.swept.dispose();
      this.coat.look.material.dispose();
      this.coat.look.depth.dispose();
    }
    this.detail.release();
  }
}

/**
 * Cross-section area a hole of radius r takes out of one profile plate: the hole's trace in the
 * section plane is a strip 2r wide along the in-plane shot direction (dy, dz) and `chord` long,
 * no wider than the plate is across that direction (a round fired edge-on along a web can only
 * take the web's thickness).
 */
function holeArea(pl: SectionPlate, chord: number, r: number, dy: number, dz: number): number {
  const l = Math.hypot(dy, dz);
  if (pl.kind !== 'rect' || l < 1e-9) return 2 * r * chord;
  const py = -dz / l, pz = dy / l;
  const across = 2 * (pl.hy * Math.abs(py) + pl.hz * Math.abs(pz));
  return Math.min(2 * r, across) * chord;
}

// ─── ray helpers (segment frame: s, y, z) ────────────────────────────────────────────────────

/** Slab test against an axis-aligned box; returns entry t, the axis entered (0 s, 1 y, 2 z) and sign. */
function slab(os: number, ds: number, s0: number, s1: number, oy: number, dy: number, y0: number, y1: number, oz: number, dz: number, z0: number, z1: number, maxT: number): { t: number; axis: number; sign: number } {
  let tmin = 0, tmax = maxT, axis = -1, sign = 1;
  const test = (o: number, d: number, lo: number, hi: number, ax: number): boolean => {
    if (Math.abs(d) < 1e-12) return o >= lo && o <= hi;
    let t0 = (lo - o) / d, t1 = (hi - o) / d;
    let sg = -1;
    if (t0 > t1) {
      const t = t0;
      t0 = t1;
      t1 = t;
      sg = 1;
    }
    if (t0 > tmin) {
      tmin = t0;
      axis = ax;
      sign = sg;
    }
    if (t1 < tmax) tmax = t1;
    return tmax >= tmin;
  };
  if (!test(os, ds, s0, s1, 0) || !test(oy, dy, y0, y1, 1) || !test(oz, dz, z0, z1, 2)) return { t: Infinity, axis: 0, sign: 1 };
  if (axis < 0) return { t: Infinity, axis: 0, sign: 1 }; // origin inside: not an entry
  return { t: tmin, axis, sign };
}

function slabInterval(os: number, ds: number, s0: number, s1: number, oy: number, dy: number, y0: number, y1: number, oz: number, dz: number, z0: number, z1: number): [number, number] | null {
  let tmin = -Infinity, tmax = Infinity;
  for (const [o, d, lo, hi] of [[os, ds, s0, s1], [oy, dy, y0, y1], [oz, dz, z0, z1]] as const) {
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t0 = (lo - o) / d, t1 = (hi - o) / d;
    if (t0 > t1) {
      const t = t0;
      t0 = t1;
      t1 = t;
    }
    tmin = Math.max(tmin, t0);
    tmax = Math.min(tmax, t1);
  }
  return tmax >= tmin ? [tmin, tmax] : null;
}

/** Tube wall sector: entry through the outer cylinder within the sector's angle range. */
function ringHit(os: number, ds: number, hl: number, oy: number, dy: number, oz: number, dz: number, pl: SectionPlate, maxT: number): { t: number; axis: number; sign: number } {
  const a = dy * dy + dz * dz;
  if (a < 1e-12) return { t: Infinity, axis: 0, sign: 1 };
  const b = 2 * (oy * dy + oz * dz), c = oy * oy + oz * oz - pl.r1 * pl.r1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return { t: Infinity, axis: 0, sign: 1 };
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > maxT) return { t: Infinity, axis: 0, sign: 1 };
  const s = os + ds * t;
  if (s < -hl || s > hl) return { t: Infinity, axis: 0, sign: 1 };
  let ang = Math.atan2(oy + dy * t, oz + dz * t);
  if (ang < 0) ang += 2 * Math.PI;
  if (ang < pl.a0 || ang >= pl.a1) return { t: Infinity, axis: 0, sign: 1 };
  return { t, axis: 3, sign: 1 };
}

function ringInterval(oy: number, dy: number, oz: number, dz: number, pl: SectionPlate): [number, number] | null {
  const a = dy * dy + dz * dz;
  if (a < 1e-12) return null;
  const b = 2 * (oy * dy + oz * dz);
  const hitR = (r: number): [number, number] | null => {
    const c = oy * oy + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const q = Math.sqrt(disc);
    return [(-b - q) / (2 * a), (-b + q) / (2 * a)];
  };
  const outer = hitR(pl.r1);
  if (!outer) return null;
  const inner = hitR(pl.r0);
  // First wall crossing: from the outer entry to the inner entry (or the outer exit).
  const t0 = Math.max(0, outer[0]), t1 = inner && inner[0] > t0 ? inner[0] : outer[1];
  let ang = Math.atan2(oy + dy * t0, oz + dz * t0);
  if (ang < 0) ang += 2 * Math.PI;
  if (ang < pl.a0 || ang >= pl.a1) return null;
  return [t0, t1];
}
