import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { SimContext, SteelBeamSpec, Vec3Like } from '../../app/contracts.ts';
import { allocateDestructibleId, type Destructible, type RayHit, type Structural } from '../Destructible.ts';
import { material as getMaterial, type MaterialProps } from '../../physics/materials.ts';
import type { BlastLoad, ImpactEvent, ProbeSegment, ThicknessProbe } from '../../physics/ballistics/types.ts';
import type { PhysicsOwner } from '../../physics/PhysicsWorld.ts';
import { BeamSim } from './beamSim.ts';
import { sectionProps, type SectionPlate, type SectionProps } from './section.ts';
import { diffusivity, maxBlastMomentum, sheetHeatLoss, steelParams, plugShearHeat, TAYLOR_QUINNEY, AMBIENT_C, type SteelParams } from './steelMaterial.ts';
import { createSteelMaterial, type SteelFinish, type SteelUniforms } from './look.ts';
import { DetailMap } from './detailMap.ts';
import { offsetOutline, profileOutline, SweptMesh, type Dent, type Outline } from './profileMesh.ts';

const G = 9.80665;
/** Below this the surface shows nothing of the heat (temper colours ≈ 200 °C, glow ≈ 500 °C), °C. */
const VISIBLE_HEAT_C = 150;
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
  stats = { lastStepMs: 0, lastMeshMs: 0, lastImpactMs: 0, awake: false, hottest: AMBIENT_C };

  private readonly ctx: SimContext;
  private readonly outline: Outline;
  private readonly faces: OutlineFace[] = [];
  private readonly mesh: THREE.Mesh;
  private readonly swept: SweptMesh;
  private readonly look: { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial; uniforms: SteelUniforms };
  private coat: { swept: SweptMesh; mesh: THREE.Mesh; look: { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial; uniforms: SteelUniforms } } | null = null;
  readonly detail: DetailMap;
  private readonly dents: Dent[];
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
  private dirtyMesh = true;
  private failed = false;
  private imposed = 0;
  private anchors = new Map<string, number[]>();
  private segs: SegFrame[] = [];
  private segVersion = -1;
  private version = 0;
  private hitCache: BeamHit | null = null;
  private hot = false;
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
    const box = regionWorld.clone().expandByScalar(Math.max(this.section.cy, this.section.cz));
    const nodes: number[] = [];
    for (let i = 0; i < this.sim.n; i++) {
      _v.set(this.sim.x[3 * i]!, this.sim.x[3 * i + 1]!, this.sim.x[3 * i + 2]!);
      if (box.containsPoint(_v) && !this.sim.locked[i]) {
        this.sim.anchorNode(i);
        nodes.push(i);
      }
    }
    this.anchors.set(anchorId, nodes);
    this.wake();
  }

  releaseAnchor(anchorId: string): void {
    const nodes = this.anchors.get(anchorId);
    if (!nodes) return;
    this.anchors.delete(anchorId);
    for (const i of nodes) this.sim.releaseNode(i);
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
    if (!this.failed) this.sim.imposed = newtons;
    this.wake();
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
  }

  fixedUpdate(dt: number): void {
    if (this.disposed || this.mode === 'rigid' || !this.awake) return;
    const t0 = performance.now();
    const st = this.sim.step(dt);
    this.version++;
    this.dirtyMesh = true;
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
    // Sleep once the member is still (no per-frame cost until something hits it again).
    if (st.maxSpeed < 2e-3) {
      this.still += dt;
      if (this.still > 0.4) this.awake = false;
    } else this.still = 0;
    this.stats.lastStepMs = performance.now() - t0;
    this.stats.awake = this.awake;
  }

  /** A loaded column that has shortened or bowed far beyond elastic has buckled. */
  private checkFailure(): void {
    if (this.failed) return;
    const s = this.sim;
    if (s.roller < 0 || this.imposed <= 0) return;
    const i = s.roller, j = i === 0 ? s.n - 1 : 0;
    const drop = s.s0[s.n - 1]! - s.s0[0]! - Math.hypot(s.x[3 * i]! - s.x[3 * j]!, s.x[3 * i + 1]! - s.x[3 * j + 1]!, s.x[3 * i + 2]! - s.x[3 * j + 2]!);
    let bow = 0;
    for (let k = 1; k < s.n - 1; k++) {
      const t = k / (s.n - 1);
      const px = s.x[3 * j]! + (s.x[3 * i]! - s.x[3 * j]!) * (j === 0 ? t : 1 - t);
      const pz = s.x[3 * j + 2]! + (s.x[3 * i + 2]! - s.x[3 * j + 2]!) * (j === 0 ? t : 1 - t);
      bow = Math.max(bow, Math.hypot(s.x[3 * k]! - px, s.x[3 * k + 2]! - pz));
    }
    const L = this.length;
    if (drop > 0.02 * L || bow > L / 25) {
      let minA = 1;
      for (let k = 0; k < s.n; k++) minA = Math.min(minA, s.areaFraction(k));
      this.fail(drop > 0.02 * L && bow < L / 50 ? 'crushing' : 'buckling');
    }
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
      const beam = new SteelBeam(this.ctx, { ...this.spec, name: `${this.name}-${i0 === 0 ? 'a' : 'b'}` }, {
        sim: sub, s0: s.s0[i0]!, length: sub.ds * (sub.n - 1), detail: this.detail, dents: this.dents,
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
    if (this.dirtyMesh && this.mode === 'fixed') this.updateMesh();
    else if (this.heatDirty) {
      this.swept.updateHeat(this.sim.temp, this.sim.n, this.sim.ds);
      this.coat?.swept.updateHeat(this.sim.temp, this.sim.n, this.sim.ds);
    }
    this.heatDirty = false;
    this.detail.upload();
    this.look.uniforms.uTime.value = this.ctx.time.now;
    if (this.coat) this.coat.look.uniforms.uTime.value = this.ctx.time.now;
  }

  private updateMesh(): void {
    const t0 = performance.now();
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

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
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
      // Cheap reject against the whole segment box.
      const R = Math.max(this.section.cy, this.section.cz) * 1.2;
      if (slab(os, ds, -g.hl, g.hl, oy, dy, -R, R, oz, dz, -R, R, best).t === Infinity) continue;
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
        if (!this.detail.solid(pu, sArc / L)) continue;
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
    const segments: ProbeSegment[] = runs.map((r) => ({
      material: this.material, start: r.t0, end: r.t1, strength: Math.max(0.3, this.sim.frac[node * this.section.plates.length + r.plate]!),
    }));
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
      // Local dent of the struck plate (flange / web / wall) — the crater, and a wider plastic
      // dent for heavy rounds (plate bending over the damage radius).
      const rc = Math.max(e.craterRadius, 0.6 * d);
      const depth = Math.max(e.craterDepth, e.outcome === 'embed' ? e.depth : 0);
      const pl = this.section.plates[c.plate]!;
      this.detail.dimple(pu, v, rc / per, rc / L, Math.min(1, depth / Math.max(0.005, this.maxPlateT())));
      this.detail.scar(pu, v, (1.8 * rc) / per, (1.8 * rc) / L, 1, seed);
      const bigDent = Math.min(0.6 * pl.t + 0.5 * depth, (0.05 * Math.sqrt(e.energyAbsorbed)) / Math.sqrt(P.fy * 1e-6 * pl.t * 1000));
      if (bigDent > 0.002) this.addDent(c, Math.max(rc * 2, e.damageRadius * 0.5), bigDent);
      if (bigDent > 0.3 * pl.t) this.removeSection(node, c.plate, (0.3 * (bigDent / pl.t) * (2 * rc)) / Math.max(pl.hz * 2, pl.hy * 2, 1e-3), rc);
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

  /** A dent pushing the struck face inward (rest coordinates, so it rides along when the member bends). */
  private addDent(c: BeamHit, R: number, depth: number): void {
    const f = this.faceAt(c.y, c.z);
    this.dents.push({ s: c.s, y: c.y, z: c.z, dy: -f.ny, dz: -f.nz, R, depth });
    if (this.dents.length > 64) this.dents.shift();
    this.dirtyMesh = true;
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
    // Never more momentum than the charge's products can deliver (maxBlastMomentum).
    const Jscale = Math.min(1, maxBlastMomentum(load.tntKg) / Math.max(Jsum, 1e-9));
    const standoff = Math.sqrt(nd) - Math.max(this.section.cy, this.section.cz);
    const contact = load.contactTargetId === this.id || ((load.kind === 'contact' || load.kind === 'hesh') && standoff < 0.35 * w3);
    // A distant blast that cannot move any node by more than a few cm/s, beyond the fireball's
    // reach, changes nothing: do not wake the member for it.
    if (!contact && standoff > 2 * w3) {
      let dv = 0;
      for (let i = 0; i < s.n; i++) dv = Math.max(dv, (Math.hypot(Jb[3 * i]!, Jb[3 * i + 1]!, Jb[3 * i + 2]!) * Jscale) / Math.max(s.mass[i]!, 1e-9));
      if (dv < 0.05) return;
    }
    for (let i = 0; i < s.n; i++) {
      if (Jb[3 * i] === 0 && Jb[3 * i + 1] === 0 && Jb[3 * i + 2] === 0) continue;
      s.addImpulse(s.s0[i]! - this.s0, Jb[3 * i]! * Jscale, Jb[3 * i + 1]! * Jscale, Jb[3 * i + 2]! * Jscale);
    }
    // Face towards the charge at the nearest node: where soot, dents and breaches go.
    const probeFrom = load.center.clone();
    const toNode = new THREE.Vector3(s.x[3 * nearest]!, s.x[3 * nearest + 1]!, s.x[3 * nearest + 2]!).sub(probeFrom).normalize();
    const hit = this.raycast(probeFrom, toNode, Math.sqrt(nd) + 1);
    const c = hit ? this.hitCache : null;
    const seed = this.ctx.rng.next() * 100;
    const L = this.detailLength(), per = this.outline.perimeter;
    if (c) {
      const pu = this.perimeterAt(c.y, c.z), v = c.s / L;
      // Soot only within reach of the fireball (see SteelPlate.applyBlast).
      const rs = Math.min(1.5, 0.3 * w3 + 0.4 * Math.max(0, standoff));
      if (standoff < 2 * w3) this.detail.soot(pu, v, rs / per, rs / L, Math.min(0.9, (0.35 * w3) / Math.max(0.2, standoff)), seed);
      if (contact) {
        const pl = this.section.plates[c.plate]!;
        const cd = load.contactDamage(this.material, pl.t);
        // Local flange / web dish under the charge.
        this.addDent(c, Math.max(0.1, cd.craterRadius), Math.min(0.12, cd.craterDepth + 0.5 * pl.t));
        if (cd.breach) {
          const rb = cd.breachRadius;
          this.paintHoleAlong(c, rb, 0.45, seed, pl.t * 3 + 0.002);
          const node = this.nodeAt(c.s);
          // The breach takes the struck plate over 2·r_b, and the plates behind it if it is wider
          // than the struck plate is thick (the jet of detonation products shears through).
          const run = this.runThrough(c, 4 * rb);
          for (const seg of run) {
            const p = this.section.plates[seg.plate]!;
            const chord = (seg.t1 - seg.t0) * Math.hypot(c.dy, c.dz);
            this.removeSection(node, seg.plate, holeArea(p, Math.max(p.t, 0.5 * chord), rb, c.dy, c.dz) / Math.max(p.A, 1e-9), rb);
          }
          this.ctx.fx.chips({ position: load.center, direction: toNode, spread: 0.7, speed: 150, count: 30, size: 0.02, color: 0x3a3d40, kind: 'metal' });
        }
        if (cd.spallRadius > 0) this.detail.scar(pu, v, cd.spallRadius / per, cd.spallRadius / L, 0.8, seed + 1);
        this.detail.heatSpot(pu, v, (0.06 * w3) / per, (0.06 * w3) / L, 500, this.ctx.time.now, 0.004, diffusivity(this.params), false);
      }
    }
    this.warm();
    this.dirtyMesh = true;
    this.wake();
    this.checkSever();
  }

  /** Heat was added: check the temperatures on the next frame. */
  private warm(): void {
    this.hot = true;
    this.stats.hottest = Math.max(this.stats.hottest, VISIBLE_HEAT_C);
  }

  // ─── physics bodies ─────────────────────────────────────────────────────────────────────────

  /** Fixed cuboids along the member so debris collides with it. */
  private staticBody: RAPIER.RigidBody | null = null;
  private buildStaticColliders(): void {
    const phys = this.ctx.physics;
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
    this.frozenPose.makeTranslation(com.x, com.y, com.z);
    this.frozenInv.copy(this.frozenPose).invert();
    this.mode = 'rigid';
    this.updateMesh();
    this.body = phys.createDynamic({ position: com, colliders: this.segmentColliders(this.frozenInv), owner: this.owner, linvel: vel, contactForceThreshold: 5e4 });
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
