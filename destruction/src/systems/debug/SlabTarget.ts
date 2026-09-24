import * as THREE from 'three';
import { allocateDestructibleId, type Destructible, type RayHit } from '../../destructibles/Destructible.ts';
import type { MaterialProps } from '../../physics/materials.ts';
import { MATERIALS } from '../../physics/materials.ts';
import type { BlastLoad, ImpactEvent, ProbeSegment, ThicknessProbe } from '../../physics/ballistics/types.ts';

/**
 * Analytic test target for the ballistics sandbox and system tests: a rectangular slab of one
 * material, optionally reinforced with a bar grid near both faces. It keeps an analytic "removed
 * depth" map (entry craters and tunnels from the front, scabs from the back), so a burst on one
 * spot really digs deeper until it breaks through — without voxels. Damage from earlier hits
 * weakens later ones (f_c × (1 − 0.8 D)), exactly as the real brittle elements are meant to.
 * DOM-free: builds THREE meshes but never touches WebGL until rendered.
 */
export interface SlabOptions {
  name: string;
  material: MaterialProps;
  width: number;
  height: number;
  thickness: number;
  position: THREE.Vector3;
  /** Yaw about +Y, radians (the slab's front face looks along local +Z) */
  yaw?: number;
  rebar?: { diameter: number; spacing: number; cover: number };
  color?: number;
}

interface Pit {
  /** Local x, y on the face */
  x: number;
  y: number;
  /** Cone radius and depth at the face, tunnel radius and depth */
  r: number;
  d: number;
  tr: number;
  td: number;
  back: boolean;
}

export interface SlabRecord {
  time: number;
  kind: 'impact' | 'blast';
  summary: string;
  outcome: string;
  depth: number;
}

const MAX_DECALS = 1500;
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const Z = new THREE.Vector3(0, 0, 1);

export class SlabTarget implements Destructible {
  readonly id = allocateDestructibleId();
  readonly kind: Destructible['kind'];
  readonly name: string;
  readonly root = new THREE.Group();
  readonly bounds = new THREE.Box3();
  disposed = false;
  readonly material: MaterialProps;
  readonly w: number;
  readonly h: number;
  readonly t: number;
  readonly rebar: SlabOptions['rebar'];
  private readonly inv = new THREE.Matrix4();
  private readonly mat = new THREE.Matrix4();
  private pits: Pit[] = [];
  private dmg: { x: number; y: number; r: number; d: number }[] = [];
  readonly log: SlabRecord[] = [];
  private slab: THREE.Mesh;
  private decals: THREE.InstancedMesh;
  private decalCount = 0;
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  /** Worst blast damage number seen (P–I) */
  blastDamage = 0;

  constructor(o: SlabOptions) {
    this.name = o.name;
    this.material = o.material;
    this.kind = o.material.class === 'glass' ? 'glass' : o.material.class === 'ductile' ? 'plate' : 'voxel';
    this.w = o.width;
    this.h = o.height;
    this.t = o.thickness;
    this.rebar = o.rebar;
    this.root.name = o.name;
    this.root.position.copy(o.position);
    this.root.rotation.y = o.yaw ?? 0;
    this.root.updateMatrixWorld(true);
    this.mat.copy(this.root.matrixWorld);
    this.inv.copy(this.mat).invert();
    const g = new THREE.BoxGeometry(o.width, o.height, o.thickness);
    const glass = o.material.class === 'glass';
    const m = new THREE.MeshStandardMaterial({
      color: o.color ?? o.material.color,
      roughness: glass ? 0.05 : o.material.class === 'ductile' ? 0.45 : 0.9,
      metalness: o.material.class === 'ductile' ? 0.7 : 0,
      transparent: glass, opacity: glass ? 0.35 : 1,
    });
    this.slab = new THREE.Mesh(g, m);
    this.slab.castShadow = !glass;
    this.slab.receiveShadow = true;
    this.root.add(this.slab);
    const dg = new THREE.CircleGeometry(1, 20);
    const dm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    this.decals = new THREE.InstancedMesh(dg, dm, MAX_DECALS);
    this.decals.count = 0;
    this.decals.frustumCulled = false;
    this.root.add(this.decals);
    this.geos.push(g, dg);
    this.mats.push(m, dm);
    this.bounds.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(o.width, o.height, o.thickness)).applyMatrix4(this.mat);
  }

  /** Removed depth from the front (back = false) or back face at local (x, y), m. */
  private removed(x: number, y: number, back: boolean): number {
    let best = 0;
    for (const p of this.pits) {
      if (p.back !== back) continue;
      const r = Math.hypot(x - p.x, y - p.y);
      let depth = 0;
      if (r < p.tr) depth = p.td;
      if (r < p.r) depth = Math.max(depth, p.d * (1 - r / p.r));
      if (depth > best) best = depth;
    }
    return best;
  }

  /**
   * Removed depth under a round of radius `radius` centred at (x, y): the shallowest point of its
   * footprint (centre and eight points on its rim), so a hole narrower than the round is solid to it.
   */
  private removedUnder(x: number, y: number, back: boolean, radius: number): number {
    let best = this.removed(x, y, back);
    if (!(radius > 0) || best <= 0) return best;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      best = Math.min(best, this.removed(x + radius * Math.cos(a), y + radius * Math.sin(a), back));
      if (best <= 0) break;
    }
    return best;
  }

  /** Accumulated micro-crack damage D at a face point: 1 − Π(1 − 0.3 (1 − (r/R)²)). */
  private damageAt(x: number, y: number): number {
    let keep = 1;
    for (const d of this.dmg) {
      const r = Math.hypot(x - d.x, y - d.y);
      if (r < d.r) keep *= 1 - d.d * (1 - (r / d.r) ** 2);
    }
    return 1 - keep;
  }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, radius = 0): RayHit | null {
    const o = _o.copy(origin).applyMatrix4(this.inv);
    const d = _d.copy(dir).transformDirection(this.inv);
    const hx = this.w / 2, hy = this.h / 2, hz = this.t / 2;
    // Slab test in local space.
    let t0 = 0, t1 = maxDist, axis = -1, sign = 1;
    const lo = [-hx, -hy, -hz], hi = [hx, hy, hz], oo = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(dd[a]!) < 1e-12) {
        if (oo[a]! < lo[a]! || oo[a]! > hi[a]!) return null;
        continue;
      }
      let ta = (lo[a]! - oo[a]!) / dd[a]!;
      let tb = (hi[a]! - oo[a]!) / dd[a]!;
      let s = -1;
      if (ta > tb) {
        const t = ta; ta = tb; tb = t; s = 1;
      }
      if (ta > t0) {
        t0 = ta; axis = a; sign = s;
      }
      if (tb < t1) t1 = tb;
      if (t1 < t0) return null;
    }
    if (axis < 0) return null; // origin inside: ignore (we never start inside a slab)
    // Front/back faces: walk into craters / through holes.
    if (axis === 2) {
      // sign = +1: entering through the +z (front) face.
      const back = sign < 0;
      const px = o.x + d.x * t0, py = o.y + d.y * t0;
      // The round meets the shallowest point under its footprint: it slips through a hole only
      // when the hole is clean through across its whole width.
      const rem = this.removedUnder(px, py, back, radius);
      if (rem > 0) {
        const remOther = this.removedUnder(px, py, !back, radius);
        if (rem + remOther >= this.t - 1e-4) {
          // Clean through: the round passes the hole.
          return null;
        }
        t0 += rem / Math.max(Math.abs(d.z), 0.05);
        if (t0 > t1 || t0 > maxDist) return null;
      }
    }
    const n = new THREE.Vector3();
    (n as unknown as Record<'x' | 'y' | 'z', number>)[axis === 0 ? 'x' : axis === 1 ? 'y' : 'z'] = sign;
    n.transformDirection(this.mat);
    const point = new THREE.Vector3().copy(o).addScaledVector(d, t0).applyMatrix4(this.mat);
    return { target: this, point, normal: n, distance: t0, material: this.material };
  }

  probe(hit: RayHit, dir: THREE.Vector3, maxDepth: number): ThicknessProbe {
    const o = _o.copy(hit.point).applyMatrix4(this.inv);
    const d = _d.copy(dir).transformDirection(this.inv);
    const hx = this.w / 2, hy = this.h / 2, hz = this.t / 2;
    // Exit distance through the box.
    let tExit = maxDepth;
    const lo = [-hx, -hy, -hz], hi = [hx, hy, hz], oo = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(dd[a]!) < 1e-12) continue;
      const tb = Math.max((lo[a]! - oo[a]!) / dd[a]!, (hi[a]! - oo[a]!) / dd[a]!);
      if (tb < tExit) tExit = tb;
    }
    // Scab/crater removal on the far face shortens the run.
    const back = d.z < 0;
    const ex = o.x + d.x * tExit, ey = o.y + d.y * tExit;
    const remBack = this.removed(ex, ey, back);
    tExit = Math.max(1e-4, tExit - remBack / Math.max(Math.abs(d.z), 0.05));
    const exits = tExit < maxDepth;
    const run = Math.min(tExit, maxDepth);
    const strength = Math.max(0.2, 1 - 0.8 * this.damageAt(o.x, o.y));
    const segs: ProbeSegment[] = [];
    const cuts = this.rebarCrossings(o, d, run);
    let s = 0;
    for (const [a, b] of cuts) {
      if (a > s) segs.push({ material: this.material, start: s, end: a, strength });
      segs.push({ material: MATERIALS.rebar_b500, start: a, end: b, strength: 1 });
      s = b;
    }
    if (run > s) segs.push({ material: this.material, start: s, end: run, strength });
    return { segments: segs, exits };
  }

  /** Where the local ray crosses rebar (bars along x and y in two mats, cover from each face). */
  private rebarCrossings(o: THREE.Vector3, d: THREE.Vector3, run: number): [number, number][] {
    const rb = this.rebar;
    if (!rb) return [];
    const r = rb.diameter / 2;
    const out: [number, number][] = [];
    for (const zc of [this.t / 2 - rb.cover - r, -this.t / 2 + rb.cover + r]) {
      for (const along of [0, 1]) {
        // Bars parallel to x (along = 0) sit at y = k·s; parallel to y at x = k·s. Distance in the (y|x, z) plane.
        const pu = along === 0 ? o.y : o.x;
        const du = along === 0 ? d.y : d.x;
        const k = Math.round(pu / rb.spacing);
        for (const kk of [k - 1, k, k + 1]) {
          const uc = kk * rb.spacing;
          // Solve |(pu + du t − uc, o.z + d.z t − zc)| = r
          const ax = pu - uc, az = o.z - zc;
          const A = du * du + d.z * d.z, B = 2 * (ax * du + az * d.z), C = ax * ax + az * az - r * r;
          const disc = B * B - 4 * A * C;
          if (A < 1e-12 || disc <= 0) continue;
          const sq = Math.sqrt(disc);
          const t0 = (-B - sq) / (2 * A), t1 = (-B + sq) / (2 * A);
          if (t1 <= 0 || t0 >= run) continue;
          out.push([Math.max(0, t0), Math.min(run, t1)]);
        }
      }
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
  }

  applyImpact(e: ImpactEvent): void {
    const p = _o.copy(e.point).applyMatrix4(this.inv);
    const dz = _d.copy(e.direction).transformDirection(this.inv).z;
    const back = dz > 0; // travelling towards +z means it entered through the back face
    const cos = Math.max(Math.abs(dz), 0.2);
    this.log.push({ time: e.time, kind: 'impact', summary: e.summary, outcome: e.outcome, depth: e.depth });
    if (e.outcome === 'ricochet') {
      this.addDecal(p.x, p.y, back, e.craterRadius * 0.6, 0x3a3530);
      return;
    }
    const frontRem = this.removed(p.x, p.y, back);
    const brittle = this.material.class === 'brittle';
    const perforated = e.outcome === 'perforate';
    // Crater cone plus tunnel along the shot line (depths measured normal to the face).
    const pit: Pit = {
      x: p.x, y: p.y, r: e.craterRadius, d: frontRem + e.craterDepth * cos,
      tr: e.tunnelRadius, td: perforated ? this.t : frontRem + e.depth * cos, back,
    };
    if (!brittle && !perforated) pit.r = 0; // steel/glass only dent: no material removed
    this.pits.push(pit);
    if (e.spallRadius > 0) {
      this.pits.push({ x: p.x, y: p.y, r: e.spallRadius, d: e.spallDepth, tr: 0, td: 0, back: !back });
      this.addDecal(p.x, p.y, !back, e.spallRadius, brittle ? 0xe8e2d6 : 0x9aa0a6);
    }
    this.dmg.push({ x: p.x, y: p.y, r: e.damageRadius, d: brittle ? 0.3 : 0.05 });
    const dark = perforated ? 0x050505 : brittle ? 0x6b655c : this.material.class === 'glass' ? 0xffffff : 0x2a2d31;
    if (brittle) this.addDecal(p.x, p.y, back, e.craterRadius, 0x8f897f);
    else if (this.material.class === 'ductile') this.addDecal(p.x, p.y, back, e.craterRadius, 0xb0b4b8);
    this.addDecal(p.x, p.y, back, Math.max(e.tunnelRadius, 0.004), dark);
    if (perforated) this.addDecal(p.x, p.y, !back, Math.max(e.tunnelRadius, 0.004), 0x050505);
  }

  applyBlast(load: BlastLoad): void {
    // Face patch nearest the charge: contact → crater/breach, otherwise P–I damage number.
    const c = _o.copy(load.center).applyMatrix4(this.inv);
    const px = THREE.MathUtils.clamp(c.x, -this.w / 2, this.w / 2);
    const py = THREE.MathUtils.clamp(c.y, -this.h / 2, this.h / 2);
    const back = c.z < 0;
    const nLocal = new THREE.Vector3(0, 0, back ? -1 : 1);
    const pw = new THREE.Vector3(px, py, back ? -this.t / 2 : this.t / 2).applyMatrix4(this.mat);
    const nw = nLocal.clone().transformDirection(this.mat);
    const P = load.reflectedPressureAt(pw, nw);
    const I = load.reflectedImpulseAt(pw, nw);
    const D = load.damageAt(pw, nw, this.material, this.t);
    this.blastDamage = Math.max(this.blastDamage, D);
    let summary = `${load.tntKg.toFixed(2)} kg TNT at ${pw.distanceTo(load.center).toFixed(1)} m: Pr ${(P / 1000).toFixed(1)} kPa, Ir ${(I).toFixed(0)} Pa·s, damage ${D.toFixed(2)}`;
    if (load.contactTargetId === this.id) {
      const cd = load.contactDamage(this.material, this.t);
      summary += ` | contact: crater Ø${(2 * cd.craterRadius).toFixed(2)} m, ${cd.breach ? `BREACH Ø${(2 * cd.breachRadius).toFixed(2)} m` : 'no breach'}${cd.spallRadius > 0 ? `, spall Ø${(2 * cd.spallRadius).toFixed(2)} m @ ${cd.spallVelocity.toFixed(0)} m/s` : ''}`;
      this.pits.push({ x: px, y: py, r: cd.craterRadius, d: cd.craterDepth, tr: cd.breach ? cd.breachRadius : 0, td: cd.breach ? this.t : 0, back });
      if (cd.spallRadius > 0) this.pits.push({ x: px, y: py, r: cd.spallRadius, d: cd.spallDepth, tr: 0, td: 0, back: !back });
      this.addDecal(px, py, back, cd.craterRadius * 1.6, 0x1c1a18); // soot
      this.addDecal(px, py, back, cd.craterRadius, 0x6b655c);
      if (cd.breach) {
        this.addDecal(px, py, back, cd.breachRadius, 0x050505);
        this.addDecal(px, py, !back, cd.breachRadius, 0x050505);
      }
      if (cd.spallRadius > 0) this.addDecal(px, py, !back, cd.spallRadius, 0xe8e2d6);
    } else if (D >= 1) {
      this.addDecal(px, py, back, Math.min(this.w, this.h) * 0.15 * Math.min(D, 3), this.material.class === 'glass' ? 0xffffff : 0x4a4640);
    }
    this.log.push({ time: load.time, kind: 'blast', summary, outcome: D >= 2 ? 'severe' : D >= 1 ? 'damaged' : 'intact', depth: 0 });
  }

  private addDecal(x: number, y: number, back: boolean, r: number, color: number): void {
    if (this.decalCount >= MAX_DECALS || !(r > 0)) return;
    const z = (back ? -1 : 1) * (this.t / 2 + 0.0015 + this.decalCount * 1e-6);
    _q.setFromUnitVectors(Z, new THREE.Vector3(0, 0, back ? -1 : 1));
    _m.compose(new THREE.Vector3(x, y, z), _q, _s.set(r, r, r));
    this.decals.setMatrixAt(this.decalCount, _m);
    this.decals.setColorAt(this.decalCount, _c.setHex(color));
    this.decalCount++;
    this.decals.count = this.decalCount;
    this.decals.instanceMatrix.needsUpdate = true;
    if (this.decals.instanceColor) this.decals.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.decals.dispose();
  }
}
