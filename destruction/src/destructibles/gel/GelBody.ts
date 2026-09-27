import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { allocateDestructibleId, type Destructible, type RayHit } from '../Destructible.ts';
import { MATERIALS } from '../../physics/materials.ts';
import type { BlastLoad, ImpactEvent, ProbeSegment, ThicknessProbe } from '../../physics/ballistics/types.ts';
import type { SegmentSpec, V3 } from './anatomy.ts';
import { Bone, GelShell, pairCrossings, unionIntervals } from './geometry.ts';
import { CAVITY_SAMPLES, CAVITY_SLOTS, createCavityUniforms, gelMaterials, GelLook, ORDER_CHANNEL, ORDER_SURFACE, ORDER_TRANSMISSION, type CavityUniforms, type GelMaterials } from './look.ts';
import { buildWounds, type WoundRecord } from './wound.ts';

/** What a gel piece reports to the rig that owns it (the dummy or block controller). */
export interface GelOwner {
  readonly look: GelLook;
  /** Simulation time now, s */
  now(): number;
  onHit(seg: GelBody, e: ImpactEvent): void;
  onBlast(seg: GelBody, load: BlastLoad): void;
  onDisposed(seg: GelBody): void;
}

interface CavitySlot {
  t0: number;
  maxR: number;
  active: boolean;
}

const GEL = MATERIALS.gelatin;
const BONE = MATERIALS.bone_sim;
/** Wounds kept per piece (older ones stay drawn but stop getting tears) */
const MAX_WOUNDS = 60;

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _n = new THREE.Vector3();

/**
 * One cast piece of ballistic gelatin (a body segment of the dummy, or a test block) riding on a
 * Rapier rigid body. Shots are tested against its lofted surface exactly; the probe reports the
 * run gel → bone → gel along the shot line; hits leave wound channels, break bones and open the
 * temporary cavity in the vertex shader; the momentum goes into the body.
 */
export class GelBody implements Destructible {
  readonly id = allocateDestructibleId();
  readonly kind = 'gel' as const;
  readonly name: string;
  readonly root = new THREE.Group();
  readonly bounds = new THREE.Box3();
  disposed = false;
  readonly spec: SegmentSpec;
  /** Segment origin in the rig frame (the body's local origin) */
  readonly origin: V3;
  readonly shells: GelShell[];
  readonly bones: Bone[];
  readonly localBox = new THREE.Box3();
  readonly volume: number;
  readonly body: RAPIER.RigidBody;
  readonly wounds: WoundRecord[] = [];
  /** World pose (from the body at the last sync) */
  readonly matrix = new THREE.Matrix4();
  readonly inverse = new THREE.Matrix4();
  readonly quaternion = new THREE.Quaternion();
  private readonly owner: GelOwner;
  private readonly removeBody: (b: RAPIER.RigidBody) => void;
  private readonly cav: CavityUniforms = createCavityUniforms();
  private readonly slots: CavitySlot[] = Array.from({ length: CAVITY_SLOTS }, () => ({ t0: 0, maxR: 0, active: false }));
  private readonly mats: GelMaterials;
  private readonly geos: THREE.BufferGeometry[] = [];
  private woundMeshes: THREE.Mesh[] = [];
  private boneMeshes: THREE.Mesh[] = [];
  private woundsDirty = false;
  /** Frames since the channels were last rebuilt (sustained fire rebuilds them every 3rd frame) */
  private sinceRebuild = 99;
  private bonesDirty = true;
  private seed = 1;

  constructor(owner: GelOwner, spec: SegmentSpec, name: string, origin: V3, body: RAPIER.RigidBody, removeBody: (b: RAPIER.RigidBody) => void) {
    this.owner = owner;
    this.spec = spec;
    this.name = name;
    this.origin = origin;
    this.body = body;
    this.removeBody = removeBody;
    this.shells = spec.shells.map((s) => new GelShell(s, origin, spec.id === 'torso' || spec.id === 'pelvis' || spec.id === 'block' ? 40 : 28));
    this.bones = spec.bones.map((b) => new Bone(b, origin));
    let vol = 0;
    for (const s of this.shells) {
      this.localBox.union(s.box);
      vol += s.volume();
    }
    this.volume = vol;
    this.localBox.expandByScalar(0.01);
    this.mats = gelMaterials(this.cav);
    // All shells of the piece in one geometry: two passes, one draw each.
    const parts = this.shells.map((s) => s.geometry());
    const g = parts.length > 1 ? mergeGeometries(parts, false)! : parts[0]!;
    if (parts.length > 1) for (const p of parts) p.dispose();
    this.geos.push(g);
    const trans = new THREE.Mesh(g, this.mats.transmission);
    trans.renderOrder = ORDER_TRANSMISSION;
    const surface = new THREE.Mesh(g, this.mats.surface);
    surface.renderOrder = ORDER_SURFACE;
    surface.castShadow = true;
    this.root.add(trans, surface);
    this.root.name = name;
    this.sync();
  }

  /** Mass of the piece, kg */
  get mass(): number {
    return this.body.mass();
  }

  /** Read the body's pose into the matrices, the scene root and the bounds. */
  sync(): void {
    if (this.disposed) return;
    const t = this.body.translation();
    const r = this.body.rotation();
    this.root.position.set(t.x, t.y, t.z);
    this.quaternion.set(r.x, r.y, r.z, r.w);
    this.root.quaternion.copy(this.quaternion);
    this.matrix.compose(this.root.position, this.quaternion, this.root.scale);
    this.inverse.copy(this.matrix).invert();
    this.bounds.copy(this.localBox).applyMatrix4(this.matrix);
  }

  /** How far a segment-local point lies inside the gel, m (< 0 outside). */
  depthOf(local: THREE.Vector3): number {
    let best = -Infinity;
    for (const s of this.shells) best = Math.max(best, s.depthOf(local));
    return best;
  }

  /**
   * Half-size of the cross-section of the shell containing a segment-local point (the limb or
   * trunk "radius" there), m; 0 when the point is outside the gel.
   */
  sectionRadius(local: THREE.Vector3): number {
    let best = 0, depth = 0;
    for (const s of this.shells) {
      const d = s.depthOf(local);
      if (d > depth) {
        depth = d;
        best = s.sectionRadius(local);
      }
    }
    return best;
  }

  toLocal(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(p).applyMatrix4(this.inverse);
  }

  toLocalDir(d: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    _qi.copy(this.quaternion).invert();
    return out.copy(d).applyQuaternion(_qi).normalize();
  }

  /** Gel intervals of the full line o + t·d (segment-local), union over the shells; `tris` gets the entry triangle per interval. */
  private intervals(o: THREE.Vector3, d: THREE.Vector3, tris?: { shell: GelShell; tri: number }[]): number[] {
    const all: number[] = [];
    const cross: number[] = [];
    const tri: number[] = [];
    for (const s of this.shells) {
      cross.length = 0;
      tri.length = 0;
      s.crossings(o, d, cross, tri);
      const iv: number[] = [];
      const entryTri: number[] = [];
      pairCrossings(cross, iv, tri, entryTri);
      for (let i = 0; i < iv.length; i += 2) {
        all.push(iv[i]!, iv[i + 1]!);
        tris?.push({ shell: s, tri: entryTri[i / 2]! });
      }
    }
    return all;
  }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
    if (this.disposed) return null;
    const o = this.toLocal(origin, _o);
    const d = this.toLocalDir(dir, _d);
    const tris: { shell: GelShell; tri: number }[] = [];
    const iv = this.intervals(o, d, tris);
    let best = Infinity, bi = -1;
    for (let i = 0; i < iv.length; i += 2) {
      const t0 = iv[i]!, t1 = iv[i + 1]!;
      if (t1 <= 1e-5) continue;
      const t = Math.max(0, t0);
      if (t < best) {
        best = t;
        bi = i / 2;
      }
    }
    if (bi < 0 || best > maxDist) return null;
    const point = origin.clone().addScaledVector(dir, best);
    const normal = new THREE.Vector3();
    const e = tris[bi]!;
    if (iv[2 * bi]! >= 0) {
      e.shell.triangleNormal(e.tri, normal).applyQuaternion(this.quaternion);
      if (normal.dot(dir) > 0) normal.negate();
    } else normal.copy(dir).negate();
    return { target: this, point, normal, distance: best, material: GEL };
  }

  probe(hit: RayHit, dir: THREE.Vector3, maxDepth: number): ThicknessProbe {
    const back = 0.002;
    const o = this.toLocal(hit.point, _o);
    const d = this.toLocalDir(dir, _d);
    o.addScaledVector(d, -back);
    const iv = unionIntervals(this.intervals(o, d));
    let end = -1;
    for (let i = 0; i < iv.length; i += 2) {
      if (iv[i]! <= back + 1e-3 && iv[i + 1]! > back) {
        end = iv[i + 1]! - back;
        break;
      }
    }
    if (end <= 0) return { segments: [], exits: true };
    const clipped = end > maxDepth;
    const runEnd = Math.min(end, maxDepth);
    // Bone intervals inside the run.
    const bone: number[] = [];
    for (const b of this.bones) {
      const tmp: number[] = [];
      b.intervals(o, d, tmp);
      for (let i = 0; i < tmp.length; i += 2) {
        const t0 = Math.max(0, tmp[i]! - back), t1 = Math.min(runEnd, tmp[i + 1]! - back);
        if (t1 > t0) bone.push(t0, t1);
      }
    }
    const bu = unionIntervals(bone);
    const segs: ProbeSegment[] = [];
    let at = 0;
    for (let i = 0; i < bu.length; i += 2) {
      if (bu[i]! > at + 1e-6) segs.push({ material: GEL, start: at, end: bu[i]!, strength: 1 });
      segs.push({ material: BONE, start: Math.max(at, bu[i]!), end: bu[i + 1]!, strength: 1 });
      at = bu[i + 1]!;
    }
    if (runEnd > at + 1e-6) segs.push({ material: GEL, start: at, end: runEnd, strength: 1 });
    return { segments: segs, exits: !clipped };
  }

  applyImpact(e: ImpactEvent): void {
    if (this.disposed) return;
    const w = e.wound;
    if (w) {
      const o = this.toLocal(e.point, new THREE.Vector3());
      const u = this.toLocalDir(e.direction, new THREE.Vector3());
      const stopped = w.stopped && e.agent !== 'jet';
      const massLeft = Math.max(1e-6, e.mass - w.massLost);
      const bullet = stopped ? { d: e.ammo.diameter, L: e.ammo.kind === 'fragment' ? e.ammo.length : e.ammo.length * (massLeft / Math.max(e.mass, 1e-9)) } : undefined;
      this.wounds.push({ o, u, profile: w, seed: this.seed++, bullet });
      if (this.wounds.length > MAX_WOUNDS) this.wounds.shift();
      this.woundsDirty = true;
      this.startCavity(o, u, w.length, w.cavity, w.maxCavity, e.time);
      if (w.bones.some((b) => b.broken)) this.breakBones(o, u, w.length, w.bones);
    }
    this.owner.onHit(this, e);
  }

  applyBlast(load: BlastLoad): void {
    if (this.disposed) return;
    this.owner.onBlast(this, load);
  }

  /** Put a channel into the oldest cavity slot of the shader. */
  private startCavity(o: THREE.Vector3, u: THREE.Vector3, len: number, radii: number[], maxR: number, t0: number): void {
    let k = this.slots.findIndex((s) => !s.active);
    if (k < 0) {
      k = 0;
      for (let i = 1; i < CAVITY_SLOTS; i++) if (this.slots[i]!.t0 < this.slots[k]!.t0) k = i;
    }
    const slot = this.slots[k]!;
    slot.active = true;
    slot.t0 = t0;
    slot.maxR = maxR;
    this.cav.uCavO.value[k]!.copy(o);
    this.cav.uCavD.value[k]!.copy(u);
    const n = radii.length;
    for (let j = 0; j < CAVITY_SAMPLES; j++) {
      const f = n > 1 ? (j / (CAVITY_SAMPLES - 1)) * (n - 1) : 0;
      const i0 = Math.floor(f), i1 = Math.min(n - 1, i0 + 1);
      const r = n ? radii[i0]! + (radii[i1]! - radii[i0]!) * (f - i0) : 0;
      this.cav.uCavR.value[k * CAVITY_SAMPLES + j] = r;
    }
    this.cav.uCavS.value[k]!.set(0, 0, Math.max(len, 1e-3), 1);
  }

  /**
   * Cavity timing: the cavity opens in a few milliseconds and pulsates, each pulse about a third of
   * the one before (Fackler 1988: 3–4 pulsations); first period T ≈ 3 ms + 40 ms/m × R_max (5 ms for
   * 5.56 mm, 8 ms for .50). Then the gel wobbles as a whole at ≈ 8 Hz, damped over ≈ 0.2 s.
   */
  private animateCavities(now: number): void {
    for (let k = 0; k < CAVITY_SLOTS; k++) {
      const s = this.slots[k]!;
      const S = this.cav.uCavS.value[k]!;
      if (!s.active) {
        S.w = 0;
        continue;
      }
      const tau = now - s.t0;
      if (tau > 1.2 || tau < 0) {
        s.active = tau < 0;
        S.x = 0;
        S.y = 0;
        S.w = s.active ? 1 : 0;
        continue;
      }
      const T = 0.003 + 0.04 * s.maxR;
      const pulse = Math.floor(tau / T);
      S.x = pulse < 3 ? Math.abs(Math.sin((Math.PI * tau) / T)) * Math.pow(0.35, pulse) : 0;
      S.y = 0.22 * Math.exp(-tau / 0.2) * Math.sin(2 * Math.PI * 8 * tau) * Math.min(1, tau / T);
      S.w = 1;
    }
  }

  /** Mark the bones the channel broke (the resolver says which crossings broke). */
  private breakBones(o: THREE.Vector3, u: THREE.Vector3, len: number, hits: { s: number; broken: boolean }[]): void {
    for (const b of this.bones) {
      const iv: number[] = [];
      b.intervals(o, u, iv);
      for (let i = 0; i < iv.length; i += 2) {
        const s = 0.5 * (iv[i]! + iv[i + 1]!);
        if (s > len + 0.01) continue;
        if (!hits.some((h) => h.broken && Math.abs(h.s - iv[i]!) < 0.012)) continue;
        b.breaks.push(o.clone().addScaledVector(u, s));
        this.bonesDirty = true;
      }
    }
  }

  fixedUpdate(): void {
    this.sync();
  }

  frameUpdate(): void {
    if (this.disposed) return;
    this.sync();
    this.animateCavities(this.owner.now());
    this.sinceRebuild++;
    if (this.woundsDirty && this.sinceRebuild >= 3) this.rebuildWounds();
    if (this.bonesDirty) this.rebuildBones();
  }

  private rebuildWounds(): void {
    this.woundsDirty = false;
    this.sinceRebuild = 0;
    for (const m of this.woundMeshes) {
      m.geometry.dispose();
      this.root.remove(m);
    }
    this.woundMeshes = [];
    const g = buildWounds(this.wounds);
    const look = this.owner.look;
    const add = (geo: THREE.BufferGeometry | null, mat: THREE.Material, order: number) => {
      if (!geo) return;
      if (!geo.getAttribute('position')?.count) {
        geo.dispose();
        return;
      }
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = order;
      this.root.add(m);
      this.woundMeshes.push(m);
    };
    add(g.channel, look.channel, ORDER_CHANNEL);
    add(g.tears, look.tear, ORDER_CHANNEL);
    add(g.bullets, look.bullet, 0);
  }

  /** Bone meshes: tubes split at their fractures, the skull with holes, ribs with broken gaps. */
  private rebuildBones(): void {
    this.bonesDirty = false;
    for (const m of this.boneMeshes) {
      m.geometry.dispose();
      this.root.remove(m);
    }
    this.boneMeshes = [];
    const solid: THREE.BufferGeometry[] = [];
    const inside: THREE.BufferGeometry[] = [];
    const holes: THREE.BufferGeometry[] = [];
    for (const b of this.bones) boneGeometry(b, solid, inside, holes);
    const look = this.owner.look;
    const add = (list: THREE.BufferGeometry[], mat: THREE.Material, shadow: boolean) => {
      if (!list.length) return;
      const g = mergeGeometries(list, false);
      for (const x of list) x.dispose();
      if (!g) return;
      const m = new THREE.Mesh(g, mat);
      m.castShadow = shadow;
      this.root.add(m);
      this.boneMeshes.push(m);
    };
    // The gel's own shadow covers the skeleton's (bones cast none: that keeps the shadow passes lean).
    add(solid, look.bone, false);
    add(inside, look.boneInside, false);
    add(holes, look.hole, false);
  }

  /** A few random segment-local points inside the gel (for break-up chunks). */
  samplePoints(n: number, rnd: () => number): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    const b = this.localBox;
    for (let tries = 0; tries < 400 && out.length < n; tries++) {
      const p = new THREE.Vector3(b.min.x + rnd() * (b.max.x - b.min.x), b.min.y + rnd() * (b.max.y - b.min.y), b.min.z + rnd() * (b.max.z - b.min.z));
      if (this.depthOf(p) > 0.01) out.push(p);
    }
    return out;
  }

  /** Segment-local → world point */
  toWorld(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(p).applyMatrix4(this.matrix);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const m of [...this.woundMeshes, ...this.boneMeshes]) m.geometry.dispose();
    for (const g of this.geos) g.dispose();
    this.mats.transmission.dispose();
    this.mats.surface.dispose();
    this.root.removeFromParent();
    try {
      this.removeBody(this.body);
    } catch {
      // The world was already replaced (scene change): nothing to remove.
    }
    this.owner.onDisposed(this);
  }
}

// ─── Bone meshes ────────────────────────────────────────────────────────────────────────────

const Y = new THREE.Vector3(0, 1, 0);

function cylinderBetween(a: THREE.Vector3, b: THREE.Vector3, r: number, sides: number): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, Math.max(len, 1e-4), sides, 1, false);
  g.deleteAttribute('uv');
  _n.copy(b).sub(a).normalize();
  _q.setFromUnitVectors(Y, _n);
  _m.compose(_o.copy(a).add(b).multiplyScalar(0.5), _q, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(_m);
  return g;
}

function holeDisc(p: THREE.Vector3, n: THREE.Vector3, r: number): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(r, 10);
  g.deleteAttribute('uv');
  _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  _m.compose(_o.copy(p).addScaledVector(n, 0.0006), _q, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(_m);
  return g;
}

function boneGeometry(b: Bone, solid: THREE.BufferGeometry[], inside: THREE.BufferGeometry[], holes: THREE.BufferGeometry[]): void {
  const s = b.spec;
  if (s.type === 'tube') {
    // Pieces between the fractures, each fracture leaving a gap of ≈ 2.5 outer radii.
    const cuts = b.breaks.map((p) => _o.copy(p).sub(b.a).dot(b.w)).sort((x, y) => x - y);
    const gap = 1.25 * s.ro;
    let from = 0;
    for (const c of [...cuts, Infinity]) {
      const to = Number.isFinite(c) ? c - gap : b.len;
      if (to - from > 0.004) solid.push(cylinderBetween(b.a.clone().addScaledVector(b.w, from), b.a.clone().addScaledVector(b.w, to), s.ro, 10));
      from = Number.isFinite(c) ? c + gap : b.len;
    }
    return;
  }
  if (s.type === 'shell') {
    const g = new THREE.SphereGeometry(1, 28, 18);
    g.deleteAttribute('uv');
    g.scale(s.r[0], s.r[1], s.r[2]);
    g.translate(b.c.x, b.c.y, b.c.z);
    solid.push(g);
    for (const p of b.breaks) holes.push(...ellipsoidHoles(b, p));
    return;
  }
  // Rib cage / pelvic ring.
  const band = s.pitch >= s.y1 - s.y0;
  if (band) {
    const h = b.y1 - b.y0;
    const g = new THREE.CylinderGeometry(1, 1, h, 36, 1, true);
    g.deleteAttribute('uv');
    g.scale(s.rx - 0.5 * s.t, 1, s.rz - 0.5 * s.t);
    g.translate(b.c.x, 0.5 * (b.y0 + b.y1), b.c.z);
    inside.push(g);
    for (const p of b.breaks) {
      const n = new THREE.Vector3((p.x - b.c.x) / (s.rx * s.rx), 0, (p.z - b.c.z) / (s.rz * s.rz)).normalize();
      const q = new THREE.Vector3(b.c.x + ((p.x - b.c.x) / Math.hypot((p.x - b.c.x) / s.rx, (p.z - b.c.z) / s.rz)), p.y, b.c.z + ((p.z - b.c.z) / Math.hypot((p.x - b.c.x) / s.rx, (p.z - b.c.z) / s.rz)));
      holes.push(holeDisc(q, n, 0.007));
      holes.push(holeDisc(q, n.clone().negate(), 0.007));
    }
    return;
  }
  const rr = 0.5 * Math.min(s.width, 1.6 * s.t);
  for (let y = b.y0 + 0.5 * s.width; y <= b.y1 - 0.5 * s.width + 1e-6; y += s.pitch) {
    // Broken ribs lose a short arc around the fracture.
    const gaps = b.breaks.filter((p) => Math.abs(p.y - y) < 0.5 * s.pitch).map((p) => Math.atan2((p.z - b.c.z) / s.rz, (p.x - b.c.x) / s.rx));
    const rx = s.rx - 0.5 * s.t, rz = s.rz - 0.5 * s.t;
    const halfGap = 0.03 / Math.max(rx, rz);
    const arcs = arcsWithout(gaps, halfGap);
    for (const [a0, a1] of arcs) {
      const pts: THREE.Vector3[] = [];
      const n = Math.max(4, Math.ceil(((a1 - a0) / (2 * Math.PI)) * 48));
      for (let i = 0; i <= n; i++) {
        const a = a0 + ((a1 - a0) * i) / n;
        pts.push(new THREE.Vector3(b.c.x + rx * Math.cos(a), y, b.c.z + rz * Math.sin(a)));
      }
      const closed = arcs.length === 1 && a1 - a0 >= 2 * Math.PI - 1e-6;
      if (closed) pts.pop();
      const curve = new THREE.CatmullRomCurve3(pts, closed);
      const g = new THREE.TubeGeometry(curve, n, rr, 5, closed);
      g.deleteAttribute('uv');
      solid.push(g);
    }
  }
}

/** Angle arcs of a full ring with gaps of ±half around each angle in `gaps`. */
function arcsWithout(gaps: number[], half: number): [number, number][] {
  if (!gaps.length) return [[0, 2 * Math.PI]];
  const g = gaps.map((a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i < g.length; i++) {
    const a0 = g[i]! + half;
    const a1 = (i + 1 < g.length ? g[i + 1]! : g[0]! + 2 * Math.PI) - half;
    if (a1 - a0 > 0.05) out.push([a0, a1]);
  }
  return out;
}

/** Entry/exit holes where a channel crossed an ellipsoidal shell near `p` (outer surface projection). */
function ellipsoidHoles(b: Bone, p: THREE.Vector3): THREE.BufferGeometry[] {
  const s = b.spec as Extract<typeof b.spec, { type: 'shell' }>;
  const rel = p.clone().sub(b.c);
  const k = Math.hypot(rel.x / s.r[0], rel.y / s.r[1], rel.z / s.r[2]);
  const q = rel.divideScalar(Math.max(k, 1e-6)).add(b.c);
  const n = new THREE.Vector3((q.x - b.c.x) / (s.r[0] * s.r[0]), (q.y - b.c.y) / (s.r[1] * s.r[1]), (q.z - b.c.z) / (s.r[2] * s.r[2])).normalize();
  return [holeDisc(q, n, 0.006)];
}
