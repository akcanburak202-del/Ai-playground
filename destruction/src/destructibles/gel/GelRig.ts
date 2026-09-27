import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { SimContext } from '../../app/contracts.ts';
import { allocateDestructibleId, type Destructible, type RayHit } from '../Destructible.ts';
import { MATERIALS } from '../../physics/materials.ts';
import { GEL_FAILURE_STRAIN } from '../../physics/ballistics/gel.ts';
import type { BlastLoad, ImpactEvent, ThicknessProbe } from '../../physics/ballistics/types.ts';
import type { ColliderSpec, SegmentSpec, V3 } from './anatomy.ts';
import { GelBody, type GelOwner } from './GelBody.ts';
import { GelLook } from './look.ts';

/**
 * The controller of one dummy (or one gel block): builds a rigid body per gel piece, joins the
 * pieces with pose-holding joints, pins the dummy to its stand, and decides when the physics says
 * something gives way:
 *
 *  - Release from the stand: when a hit or a blast gives the whole dummy more than ≈ 0.8 m/s
 *    (a 30 mm round, a nearby shell); rifle bullets do not knock a 76 kg body over — a 5.56 mm
 *    round carries 3.6 N·s, enough for 5 cm/s.
 *  - Break-up of a piece: when the temporary cavity stretches the whole cross-section past the
 *    gel's failure strain — the outer wall of a limb of section half-size a is stretched to
 *    √(a² + R²), so it tears through once R > a·√((1 + ε_f)² − 1) — or when a charge goes off
 *    against it (contact, or a reflected pressure above 10 MPa with more than 1 500 Pa·s of
 *    impulse). The piece falls apart into
 *    chunks of gel and bone; whatever hung from it comes loose.
 *
 * Registered as a destructible of its own so it gets the simulation's update and dispose hooks;
 * it has no surface (its bounds are empty and its ray test misses).
 */

const GEL = MATERIALS.gelatin;
const GEL_DENSITY = GEL.density;
/** Whole-dummy speed change that tears it off its stand, m/s (estimate: a clamp holding a 76 kg body) */
const RELEASE_DV = 0.8;
/**
 * Burst factor √((1 + ε_s)² − 1) for the outer wall: it carries the surface flaws of the cast, so
 * it fails at a little less stretch than the gel inside (ε_s = 0.9 ε_f; estimate).
 */
const RUPTURE_K = Math.sqrt((1 + 0.9 * GEL_FAILURE_STRAIN) ** 2 - 1);
/**
 * Charge on or very close to a piece: reflected pressure and impulse that break it up. Gel is
 * nearly incompressible, so a blast wave mostly passes through it and throws it; it bursts only
 * in the near field (≈ 1 kg of TNT within half a metre) — beyond that the fragments do the damage
 * (estimate from blast tests on gelatin torso simulants).
 */
const BLAST_BREAK_PA = 10e6;
const BLAST_BREAK_IMPULSE = 1500;
/** Most loose chunks one rig keeps simulating */
const MAX_CHUNKS = 80;

export interface DummySpec {
  name: string;
  /** Feet position, m */
  position: V3;
  /** Heading about the vertical, rad (0: facing +z) */
  rotY?: number;
  /** Pinned to a steel stand behind it (default true); without one it stands on its own and falls */
  stand?: boolean;
}

interface Joint {
  a: GelBody;
  b: GelBody;
  joint: RAPIER.ImpulseJoint;
  stiffness: number;
  revolute: boolean;
}

interface Chunk {
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
}

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class GelRig implements Destructible, GelOwner {
  readonly id = allocateDestructibleId();
  readonly kind = 'gel' as const;
  readonly name: string;
  readonly root = new THREE.Group();
  readonly bounds = new THREE.Box3();
  disposed = false;
  readonly look = GelLook.acquire();
  readonly segments: GelBody[] = [];
  readonly ctx: SimContext;
  /** Dummy frame in the world */
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  released = false;
  private joints: Joint[] = [];
  private stand: RAPIER.RigidBody | null = null;
  private standJoint: RAPIER.ImpulseJoint | null = null;
  private chunks: Chunk[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  /** Blast impulse gathered this step, N·s (pieces are loaded one by one as the front arrives) */
  private blastImpulse = 0;
  private rngState = 1;

  constructor(ctx: SimContext, name: string, position: V3, rotY: number) {
    this.ctx = ctx;
    this.name = name;
    this.position = new THREE.Vector3(...position);
    this.quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
    this.rngState = (Math.abs(Math.round(position[0] * 997 + position[2] * 131)) % 100000) + 7;
    this.root.name = name;
    this.bounds.makeEmpty();
  }

  now(): number {
    return this.ctx.time.now;
  }

  private rnd(): number {
    this.rngState = (this.rngState * 16807) % 2147483647;
    return (this.rngState - 1) / 2147483646;
  }

  get totalMass(): number {
    let m = 0;
    for (const s of this.segments) if (!s.disposed) m += s.mass;
    return m;
  }

  /** Rig frame → world */
  toWorld(p: V3, out: THREE.Vector3): THREE.Vector3 {
    return out.set(p[0], p[1], p[2]).applyQuaternion(this.quaternion).add(this.position);
  }

  /** Build the pieces of `specs` (rig frame) as bodies joined per their joint specs. */
  build(specs: SegmentSpec[], pin: boolean): void {
    const phys = this.ctx.physics;
    const R = phys.R;
    const byId = new Map<string, GelBody>();
    for (const spec of specs) {
      const box = new THREE.Box3();
      for (const sh of spec.shells) {
        box.expandByPoint(_v.set(...sh.a));
        box.expandByPoint(_v.set(...sh.b));
      }
      const c = box.getCenter(new THREE.Vector3());
      const origin: V3 = [c.x, c.y, c.z];
      const colliders = spec.colliders.map((cs) => colliderDesc(R, cs, origin).setDensity(GEL_DENSITY).setFriction(0.8).setRestitution(0.03));
      const owner = { kind: 'gel', material: GEL } as { kind: string; material: typeof GEL; destructible?: Destructible };
      const body = phys.createDynamic({
        position: this.toWorld(origin, new THREE.Vector3()), quaternion: this.quaternion, colliders, owner,
        linearDamping: 0.05, angularDamping: 0.5,
      });
      phys.exemptFromBudget(body);
      const seg = new GelBody(this, spec, `${this.name} · ${spec.nameTr}`, origin, body, (b) => phys.removeBody(b));
      owner.destructible = seg;
      this.segments.push(seg);
      byId.set(spec.id, seg);
      this.ctx.addDestructible(seg);
    }
    for (const seg of this.segments) {
      const js = seg.spec.joint;
      const parent = seg.spec.parent ? byId.get(seg.spec.parent) : undefined;
      if (!js || !parent) continue;
      const a1 = { x: js.at[0] - parent.origin[0], y: js.at[1] - parent.origin[1], z: js.at[2] - parent.origin[2] };
      const a2 = { x: js.at[0] - seg.origin[0], y: js.at[1] - seg.origin[1], z: js.at[2] - seg.origin[2] };
      const revolute = js.type === 'revolute';
      const data = revolute
        ? R.JointData.revolute(a1, a2, { x: js.axis![0], y: js.axis![1], z: js.axis![2] })
        : R.JointData.spherical(a1, a2);
      const joint = phys.world.createImpulseJoint(data, parent.body, seg.body, true);
      joint.setContactsEnabled(false);
      if (revolute && js.limits) (joint as RAPIER.RevoluteImpulseJoint).setLimits(js.limits[0], js.limits[1]);
      const j: Joint = { a: parent, b: seg, joint, stiffness: js.stiffness, revolute };
      this.setMotors(j, js.stiffness);
      this.joints.push(j);
    }
    if (pin) this.buildStand(byId.get('torso'));
  }

  /**
   * Pose-holding motors: target the rest pose with a torsional spring of `k` N·m/rad (force-based
   * motor model — Rapier's default scales the spring by the joint's effective inertia instead),
   * damping ≈ 8 % of the stiffness (well damped for these inertias).
   */
  private setMotors(j: Joint, k: number): void {
    const R = this.ctx.physics.R;
    const c = Math.max(0.5, 0.08 * k);
    if (j.revolute) {
      const r = j.joint as RAPIER.RevoluteImpulseJoint;
      r.configureMotorModel(R.MotorModel.ForceBased);
      r.configureMotorPosition(0, k, c);
      return;
    }
    // Rapier 0.20's JS class for spherical impulse joints lacks the per-axis motor methods its
    // typings declare; the joint set's raw calls underneath them work.
    type Raw = {
      jointConfigureMotorModel(h: number, ax: number, model: number): void;
      jointConfigureMotorPosition(h: number, ax: number, p: number, k: number, c: number): void;
    };
    const s = j.joint as RAPIER.SphericalImpulseJoint & { rawSet?: Raw };
    for (const ax of [R.JointAxis.AngX, R.JointAxis.AngY, R.JointAxis.AngZ]) {
      if (typeof s.configureMotorPosition === 'function') {
        s.configureMotorModel(ax, R.MotorModel.ForceBased);
        s.configureMotorPosition(ax, 0, k, c);
      } else {
        s.rawSet?.jointConfigureMotorModel(s.handle, ax, R.MotorModel.ForceBased);
        s.rawSet?.jointConfigureMotorPosition(s.handle, ax, 0, k, c);
      }
    }
  }

  /**
   * The steel stand: a 50 mm post on a base plate 35 cm behind the dummy and an arm clamped to its
   * back at chest height (a fixed joint holds the torso).
   */
  private buildStand(torso: GelBody | undefined): void {
    if (!torso) return;
    const phys = this.ctx.physics;
    const R = phys.R;
    const zPost = -0.36, yArm = 1.27, zBack = -0.1;
    const owner = { kind: 'stand', material: MATERIALS.steel_s355 };
    this.stand = phys.createFixed(this.position.clone(), this.quaternion, [
      R.ColliderDesc.cuboid(0.22, 0.008, 0.22).setTranslation(0, 0.008, zPost),
      R.ColliderDesc.cylinder(yArm / 2, 0.025).setTranslation(0, yArm / 2, zPost),
      R.ColliderDesc.cuboid(0.02, 0.02, (zBack - zPost) / 2).setTranslation(0, yArm, (zBack + zPost) / 2),
    ], owner);
    const anchor: V3 = [0, yArm, zBack];
    const data = R.JointData.fixed(
      { x: anchor[0], y: anchor[1], z: anchor[2] }, { x: 0, y: 0, z: 0, w: 1 },
      { x: anchor[0] - torso.origin[0], y: anchor[1] - torso.origin[1], z: anchor[2] - torso.origin[2] }, { x: 0, y: 0, z: 0, w: 1 },
    );
    this.standJoint = phys.world.createImpulseJoint(data, this.stand, torso.body, true);
    this.standJoint.setContactsEnabled(false);
    // Visuals: post, base plate with four bolts, the arm and its clamp pad.
    const parts: THREE.BufferGeometry[] = [
      new THREE.BoxGeometry(0.44, 0.016, 0.44).translate(0, 0.008, zPost),
      new THREE.CylinderGeometry(0.025, 0.025, yArm + 0.03, 14).translate(0, (yArm + 0.03) / 2, zPost),
      new THREE.BoxGeometry(0.04, 0.04, zBack - zPost).translate(0, yArm, (zBack + zPost) / 2),
      new THREE.BoxGeometry(0.12, 0.16, 0.012).translate(0, yArm, zBack - 0.006),
    ];
    for (const [bx, bz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) parts.push(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 6).translate(bx!, 0.02, zPost + bz!));
    for (const g of parts) {
      g.deleteAttribute('uv');
      this.geos.push(g);
      const m = new THREE.Mesh(g, this.look.steel);
      m.castShadow = m.receiveShadow = true;
      m.position.copy(this.position);
      m.quaternion.copy(this.quaternion);
      this.root.add(m);
    }
  }

  // ── Physics decisions ─────────────────────────────────────────────────────────────────────

  onHit(seg: GelBody, e: ImpactEvent): void {
    const phys = this.ctx.physics;
    if (seg.body.isDynamic()) phys.applyImpulseAt(seg.body, e.momentum, e.point);
    const w = e.wound;
    if (w && this.cavityTearsWall(seg, e)) {
      this.breakUp(seg, e.point, e.direction, w.maxCavity);
      return;
    }
    if (!this.released && this.standJoint && e.momentum.length() / Math.max(this.totalMass, 1) > RELEASE_DV) this.release();
  }

  /**
   * Does the temporary cavity burst the piece? The whole cross-section around the channel is
   * stretched: gel at radius r moves to √(r² + R²), so the outer wall of a limb or trunk of
   * section half-size a tears through once R > a·√((1 + ε_f)² − 1). (A cavity that only reaches
   * the near surface splits the exit, which the tears already show; it does not burst the piece.)
   */
  private cavityTearsWall(seg: GelBody, e: ImpactEvent): boolean {
    const w = e.wound!;
    if (w.maxCavity < 0.03) return false;
    const o = seg.toLocal(e.point, new THREE.Vector3());
    const u = seg.toLocalDir(e.direction, new THREE.Vector3());
    for (let i = 0; i < w.s.length; i++) {
      const R = w.cavity[i]!;
      if (R < 0.03) continue;
      const a = seg.sectionRadius(_p.copy(o).addScaledVector(u, w.s[i]!));
      if (a > 0 && R > RUPTURE_K * a) return true;
    }
    return false;
  }

  onBlast(seg: GelBody, load: BlastLoad): void {
    const c = seg.bounds.getCenter(new THREE.Vector3());
    const n = _v.copy(load.center).sub(c);
    const dist = n.length();
    if (dist > 1e-6) n.divideScalar(dist);
    else n.set(0, 1, 0);
    const size = seg.bounds.getSize(new THREE.Vector3());
    const half = 0.25 * (size.x + size.y + size.z) / 3;
    const face = c.clone().addScaledVector(n, Math.min(half, dist * 0.9));
    const Pr = load.reflectedPressureAt(face, n);
    const Ir = load.reflectedImpulseAt(face, n);
    // Presented area ≈ volume^(2/3) (a piece seen from any side).
    const J = Ir * Math.pow(seg.volume, 2 / 3);
    this.blastImpulse += J;
    if (load.contactTargetId === seg.id || (Pr > BLAST_BREAK_PA && Ir > BLAST_BREAK_IMPULSE)) {
      const dv = Math.min(150, J / Math.max(seg.mass, 1e-3));
      this.breakUp(seg, face, n.clone().negate(), 0, dv);
    }
    if (!this.released && this.standJoint && this.blastImpulse / Math.max(this.totalMass, 1) > RELEASE_DV) this.release();
  }

  /**
   * Tear the dummy off its stand: the clamp lets go and the joints keep only 5 % of their holding
   * stiffness — the mannequin cannot stand on its own and crumples under its weight as it is thrown.
   */
  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.standJoint) {
      try {
        this.ctx.physics.world.removeImpulseJoint(this.standJoint, true);
      } catch {
        // already gone with its body
      }
      this.standJoint = null;
    }
    for (const j of this.joints) if (!j.a.disposed && !j.b.disposed) this.setMotors(j, 0.05 * j.stiffness);
    for (const s of this.segments) if (!s.disposed) s.body.wakeUp();
  }

  /**
   * A piece falls apart: gel chunks (≈ 1.5 L each) and pieces of its bones fly off — outward from
   * the channel at the cavity's wall speed (R over the first-pulse time), or along the blast with
   * `dv`. Whatever hung from the piece comes loose; losing the torso frees the dummy.
   */
  breakUp(seg: GelBody, at: THREE.Vector3, dir: THREE.Vector3, cavityR: number, dv = 0): void {
    if (seg.disposed) return;
    const phys = this.ctx.physics;
    const R = phys.R;
    const lv = seg.body.linvel();
    const base = new THREE.Vector3(lv.x, lv.y, lv.z);
    const wall = cavityR > 0 ? Math.min(35, cavityR / (0.003 + 0.04 * cavityR)) * 0.5 : 0;
    const n = Math.max(3, Math.min(9, Math.round(seg.volume / 0.0015)));
    const pts = seg.samplePoints(n, () => this.rnd());
    const r = Math.cbrt((3 * seg.volume) / (4 * Math.PI * Math.max(pts.length, 1))) * 0.85;
    const axisPoint = at.clone();
    for (const lp of pts) {
      if (this.chunks.length >= MAX_CHUNKS) break;
      const wp = seg.toWorld(lp, new THREE.Vector3());
      // Radial direction from the channel line through `at` along `dir`.
      const rel = wp.clone().sub(axisPoint);
      const radial = rel.addScaledVector(dir, -rel.dot(dir));
      if (radial.lengthSq() < 1e-8) radial.set(this.rnd() - 0.5, this.rnd() - 0.5, this.rnd() - 0.5);
      radial.normalize();
      const vel = base.clone().addScaledVector(radial, wall * (0.6 + 0.8 * this.rnd())).addScaledVector(dir, dv * (0.7 + 0.6 * this.rnd()) + wall * 0.2);
      const size = r * (0.7 + 0.5 * this.rnd());
      this.spawnChunk(blob(size, () => this.rnd()), this.look.chunk, wp, vel, [R.ColliderDesc.ball(size * 0.85).setDensity(GEL_DENSITY)], GEL);
    }
    // Bones: each long bone in two pieces, other bones as a couple of fragments.
    for (const b of seg.bones) {
      if (this.chunks.length >= MAX_CHUNKS) break;
      if (b.spec.type === 'tube') {
        const half = b.len / 2;
        for (const k of [0.25, 0.75]) {
          const lp = b.a.clone().addScaledVector(b.w, k * b.len);
          const wp = seg.toWorld(lp, new THREE.Vector3());
          const g = new THREE.CylinderGeometry(b.spec.ro, b.spec.ro, half * 0.9, 8);
          g.deleteAttribute('uv');
          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.w).premultiply(seg.quaternion);
          g.applyQuaternion(q);
          const vel = base.clone().addScaledVector(dir, dv * 0.8 + wall * 0.3).add(new THREE.Vector3(this.rnd() - 0.5, this.rnd(), this.rnd() - 0.5).multiplyScalar(2 + wall * 0.4));
          this.spawnChunk(g, this.look.bone, wp, vel, [R.ColliderDesc.ball(Math.max(b.spec.ro, 0.01)).setDensity(1850)], MATERIALS.bone_sim);
        }
      } else {
        for (let k = 0; k < 2; k++) {
          const lp = b.spec.type === 'shell' ? b.c.clone() : new THREE.Vector3(b.c.x + b.r.x * (k ? 1 : -1), 0.5 * (b.y0 + b.y1), b.c.z);
          const wp = seg.toWorld(lp, new THREE.Vector3());
          const g = blob(0.025, () => this.rnd());
          const vel = base.clone().addScaledVector(dir, dv * 0.8 + wall * 0.3).add(new THREE.Vector3(this.rnd() - 0.5, this.rnd(), this.rnd() - 0.5).multiplyScalar(2 + wall * 0.4));
          this.spawnChunk(g, this.look.bone, wp, vel, [R.ColliderDesc.ball(0.02).setDensity(1850)], MATERIALS.bone_sim);
        }
      }
    }
    // Spray of gel droplets.
    this.ctx.fx.chips({ position: at, direction: dir, spread: 1.4, speed: Math.max(4, wall + dv * 0.5), count: 40, size: 0.01, color: GEL.color, kind: 'glass' });
    const wasTorso = seg.spec.id === 'torso';
    this.joints = this.joints.filter((j) => j.a !== seg && j.b !== seg);
    if (wasTorso) this.standJoint = null;
    seg.dispose();
    if (wasTorso || seg.spec.id === 'pelvis') this.release();
  }

  private spawnChunk(geo: THREE.BufferGeometry, mat: THREE.Material, at: THREE.Vector3, vel: THREE.Vector3, colliders: RAPIER.ColliderDesc[], material: typeof GEL): void {
    const phys = this.ctx.physics;
    const body = phys.createDynamic({
      position: at, colliders: colliders.map((c) => c.setFriction(0.9).setRestitution(0.05)), owner: { kind: 'gel chunk', material },
      linvel: vel, angvel: new THREE.Vector3(this.rnd() - 0.5, this.rnd() - 0.5, this.rnd() - 0.5).multiplyScalar(12),
      linearDamping: 0.1, angularDamping: 0.6,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.renderOrder = mat === this.look.chunk ? 3 : 0; // with the gel surface pass
    mesh.position.copy(at);
    this.root.add(mesh);
    this.geos.push(geo);
    this.chunks.push({ body, mesh });
  }

  onDisposed(seg: GelBody): void {
    this.joints = this.joints.filter((j) => j.a !== seg && j.b !== seg);
  }

  // ── Destructible (the rig itself has no surface) ─────────────────────────────────────────

  raycast(): RayHit | null {
    return null;
  }

  probe(): ThicknessProbe {
    return { segments: [], exits: true };
  }

  applyImpact(): void {}

  applyBlast(): void {}

  fixedUpdate(): void {
    this.blastImpulse = 0;
  }

  frameUpdate(): void {
    for (const c of this.chunks) {
      if (!c.body.isValid()) continue;
      const t = c.body.translation(), q = c.body.rotation();
      c.mesh.position.set(t.x, t.y, t.z);
      c.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of [...this.segments]) s.dispose();
    const phys = this.ctx.physics;
    try {
      for (const c of this.chunks) if (c.body.isValid()) phys.removeBody(c.body);
      if (this.stand && this.stand.isValid()) phys.removeBody(this.stand);
    } catch {
      // world replaced
    }
    for (const g of this.geos) g.dispose();
    this.chunks = [];
    this.root.removeFromParent();
    GelLook.release();
  }
}

function v3(p: V3, o: V3): { x: number; y: number; z: number } {
  return { x: p[0] - o[0], y: p[1] - o[1], z: p[2] - o[2] };
}

/** Rapier collider for a spec'd shape, in the body frame (rig frame minus the segment origin). */
function colliderDesc(R: typeof RAPIER, c: ColliderSpec, o: V3): RAPIER.ColliderDesc {
  switch (c.type) {
    case 'ball': {
      const p = v3(c.c, o);
      return R.ColliderDesc.ball(c.r).setTranslation(p.x, p.y, p.z);
    }
    case 'box': {
      const p = v3(c.c, o);
      return R.ColliderDesc.cuboid(c.h[0], c.h[1], c.h[2]).setTranslation(p.x, p.y, p.z);
    }
    case 'capsule': {
      const a = new THREE.Vector3(...c.a), b = new THREE.Vector3(...c.b);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dir = b.clone().sub(a);
      const len = dir.length();
      _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.divideScalar(Math.max(len, 1e-9)));
      return R.ColliderDesc.capsule(Math.max(0.001, len / 2), c.r).setTranslation(mid.x - o[0], mid.y - o[1], mid.z - o[2]).setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
    }
  }
}

/** An irregular blob (a lumpy icosphere) of radius ≈ r for gel and bone chunks. */
function blob(r: number, rnd: () => number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, 1);
  g.deleteAttribute('uv');
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  // Displace shared positions consistently (the icosphere is non-indexed: key by rounded position).
  const seen = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
    let k = seen.get(key);
    if (k === undefined) {
      k = 0.72 + 0.5 * rnd();
      seen.set(key, k);
    }
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.85, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}
