import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { SimContext, SteelPlateSpec, Vec3Like } from '../../app/contracts.ts';
import { allocateDestructibleId, type Destructible, type RayHit, type Structural } from '../Destructible.ts';
import { material as getMaterial, type MaterialProps } from '../../physics/materials.ts';
import type { BlastLoad, ImpactEvent, ThicknessProbe } from '../../physics/ballistics/types.ts';
import type { PhysicsOwner } from '../../physics/PhysicsWorld.ts';
import { PlateSim } from './plateSim.ts';
import { safeHullDesc } from './colliders.ts';
import { diffusivity, maxBlastMomentum, plugShearHeat, sheetHeatLoss, steelParams, TAYLOR_QUINNEY, AMBIENT_C, type SteelParams } from './steelMaterial.ts';
import { createSteelMaterial, type SteelUniforms } from './look.ts';
import { DetailMap } from './detailMap.ts';

const NEXT = [1, 2, 0] as const;
const G = 9.80665;
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * Below this temperature nothing on the surface changes as the sheet cools (temper colours start
 * near 200 °C, visible glow near 500 °C), so the mesh is not refreshed for it, °C.
 */
const VISIBLE_HEAT_C = 150;

/** Groups 0–3 are the spec's welded edges; structure anchors get their own groups after that. */
const EDGE_GROUPS = { top: 0, bottom: 1, left: 2, right: 3 } as const;

function vec(v: Vec3Like): THREE.Vector3 {
  return v instanceof THREE.Vector3 ? v.clone() : new THREE.Vector3(v[0], v[1], v[2]);
}

interface HitCache {
  hit: RayHit;
  tri: number;
  u: number;
  v: number;
  /** Plate-local point on the mid-surface and triangle normal (facing the ray) */
  local: THREE.Vector3;
  normal: THREE.Vector3;
}

/** Plate options beyond the public spec (torn-off pieces reuse their parent's texture and state). */
interface PlateInit {
  sim?: PlateSim;
  detail?: DetailMap;
  pose?: { position: THREE.Vector3; quaternion: THREE.Quaternion };
  released?: boolean;
  linvel?: THREE.Vector3;
}

/**
 * A steel plate: the PlateSim sheet (see plateSim.ts), rendered as a thick shell (both faces offset
 * ±t/2 along smoothed normals, rim quads along free edges and tears), realising projectile impacts
 * (craters, perforations, petals, dents by the mode approximation) and blasts (reflected-impulse
 * loading, contact breaches, rear spall, soot), heating from plastic work and hole rims, welds to
 * supports that tear out, and release as a Rapier rigid body when nothing holds it any more.
 */
export class SteelPlate implements Destructible, Structural {
  readonly id = allocateDestructibleId();
  readonly kind = 'plate' as const;
  readonly name: string;
  readonly root = new THREE.Group();
  readonly bounds = new THREE.Box3();
  disposed = false;
  readonly structural: Structural = this;
  readonly material: MaterialProps;
  readonly params: SteelParams;
  readonly spec: SteelPlateSpec;
  readonly sim: PlateSim;
  readonly thickness: number;
  /** Rigid mode: the sheet's shape is frozen and a Rapier body carries it. */
  mode: 'fixed' | 'rigid' = 'fixed';
  stats = { lastImpactMs: 0, lastBlastMs: 0, lastStepMs: 0, lastMeshMs: 0, hottest: AMBIENT_C, deformations: 0 };

  private readonly ctx: SimContext;
  private readonly pivot = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly look: { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial; uniforms: SteelUniforms };
  readonly detail: DetailMap;
  private pos: Float32Array;
  private nrm: Float32Array;
  private duv: Float32Array;
  private heatA: Float32Array;
  private strainA: Float32Array;
  private rimA: Float32Array;
  private index: Uint32Array;
  private rimBase: number;
  private rimCap: number;
  private vNormal: Float64Array;
  private vThick: Float64Array;
  private readonly owner: PhysicsOwner;
  private body: RAPIER.RigidBody | null = null;
  private collider: RAPIER.Collider | null = null;
  private colliderDirty = false;
  private colliderClock = 0;
  private anchors = new Map<string, number>();
  private everWelded: Uint8Array;
  private imposed = 0;
  private failed = false;
  private hot = false;
  /** Sim time since the sheet's temperatures were last integrated (coarse steps when not visible) */
  private coolClock = 0;
  private heatDirty = false;
  /** Particle behind each rim vertex, and how many rim vertices there are (heat-only refresh) */
  private rimSrc: Int32Array;
  private rimVerts = 0;
  /** Per-impact load scratch (sized to the particle capacity; the sheet never outgrows it) */
  private jScratch: Float64Array;
  private wScratch: Float64Array;
  /**
   * Impulse a local mode could not hold (J·(1 − φ)), kept until that mode finishes. If the mode tore
   * a plug out, the plug leaves with its own momentum and the ring around it — which still carries
   * this residual — dishes about the hole (tearing with dishing, Nurick & Shave 1996 mode II*).
   */
  private residual: { J: Float64Array; u: number; v: number; dir: [number, number, number]; R: number } | null = null;
  private toreOut = false;
  private hitCache: HitCache | null = null;
  private triSphere: Float64Array;
  private triSphereVersion = -1;
  private geomVersion = 0;
  private readonly invPivot = new THREE.Matrix4();
  private lastImpulse = new THREE.Vector3();
  private lastImpulsePoint = new THREE.Vector3();
  private readonly seed: number;

  constructor(ctx: SimContext, spec: SteelPlateSpec, init: PlateInit = {}) {
    this.ctx = ctx;
    this.spec = spec;
    this.name = spec.name;
    this.material = getMaterial(spec.material);
    this.params = steelParams(this.material);
    this.thickness = spec.thickness;
    this.seed = (this.id * 7919) % 1000;
    // Particle spacing: ~5 cm, coarsened so one plate stays under ~2 500 particles.
    const spacing = Math.max(spec.resolution ?? 0.05, Math.sqrt((spec.width * spec.height) / 2400));
    this.sim = init.sim ?? PlateSim.grid({ width: spec.width, height: spec.height, thickness: spec.thickness, spacing, params: this.params, seed: 11 + this.id });
    const sim = this.sim;
    this.everWelded = new Uint8Array(sim.pcap);

    // Transform: root carries the world pose, pivot the offset to the rigid body's centre of mass.
    if (init.pose) {
      this.root.position.copy(init.pose.position);
      this.root.quaternion.copy(init.pose.quaternion);
    } else {
      this.root.position.copy(vec(spec.position));
      const r = spec.rotation;
      if (r instanceof THREE.Quaternion) this.root.quaternion.copy(r);
      else if (r) this.root.quaternion.setFromEuler(new THREE.Euler(...(r instanceof THREE.Vector3 ? r.toArray() : r)));
    }
    this.root.name = `plate:${spec.name}`;
    this.root.add(this.pivot);

    // Surface detail: [front | back] at ≈ 4 mm per texel (≤ 512 per face side), heat at half that.
    if (init.detail) {
      this.detail = init.detail;
      this.detail.refs++;
    } else {
      const tex = Math.min(512, Math.max(64, Math.ceil(Math.max(spec.width, spec.height) / 0.004)));
      const tw = Math.max(32, Math.round((tex * spec.width) / Math.max(spec.width, spec.height)));
      const th = Math.max(32, Math.round((tex * spec.height) / Math.max(spec.width, spec.height)));
      const floatLinear = !!ctx.renderer?.extensions?.has?.('OES_texture_float_linear');
      this.detail = new DetailMap(2 * tw, th, Math.max(16, tw >> 1), Math.max(16, th >> 1), floatLinear);
    }
    const finish = spec.finish === 'polished' ? 'polished' : spec.finish;
    this.look = createSteelMaterial({
      finish,
      paintColor: spec.paintColor,
      detail: this.detail.tex,
      heat: this.detail.heatTex,
      size: [2 * spec.width, spec.height],
      split: true,
      dimpleScale: spec.thickness,
      diffusivity: diffusivity(this.params),
      seed: this.seed,
    });

    // Buffers: top + bottom vertex per particle, rim quads for free edges.
    const pcap = sim.pcap;
    this.rimBase = 2 * pcap;
    this.rimCap = Math.max(512, sim.ecap);
    const nv = this.rimBase + 4 * this.rimCap;
    this.pos = new Float32Array(3 * nv);
    this.nrm = new Float32Array(3 * nv);
    this.duv = new Float32Array(2 * nv);
    this.heatA = new Float32Array(nv).fill(AMBIENT_C);
    this.strainA = new Float32Array(nv);
    this.rimA = new Float32Array(nv);
    this.index = new Uint32Array(6 * sim.tv.length / 3 + 6 * this.rimCap);
    this.vNormal = new Float64Array(3 * pcap);
    this.vThick = new Float64Array(pcap);
    this.rimSrc = new Int32Array(4 * this.rimCap);
    this.jScratch = new Float64Array(3 * pcap);
    this.wScratch = new Float64Array(pcap);
    this.triSphere = new Float64Array(4 * (sim.tv.length / 3));
    const g = this.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aDUv', new THREE.BufferAttribute(this.duv, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aHeat', new THREE.BufferAttribute(this.heatA, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aStrain', new THREE.BufferAttribute(this.strainA, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aRim', new THREE.BufferAttribute(this.rimA, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(this.index, 1).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.Mesh(g, this.look.material);
    this.mesh.customDepthMaterial = this.look.depth;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = `plate-mesh:${spec.name}`;
    this.pivot.add(this.mesh);

    this.owner = { kind: 'plate', material: this.material, destructible: this };
    this.root.updateMatrixWorld(true);
    if (!init.sim) this.weldEdges();
    this.rebuildTopology();
    this.updateGeometry();
    if (init.released) this.toRigid(init.linvel);
    else this.buildStaticCollider();
  }

  // ─── supports ───────────────────────────────────────────────────────────────────────────────

  /** Weld the spec's edges: full-strength double fillet welds, moment-resisting (clamped). */
  private weldEdges(): void {
    const s = this.sim, W = this.spec.width, H = this.spec.height, eps = 1e-6;
    for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
      if (!this.spec.edges[edge]) continue;
      const g = EDGE_GROUPS[edge];
      for (let i = 0; i < s.n; i++) {
        const u = s.uv[2 * i]!, v = s.uv[2 * i + 1]!;
        const on = edge === 'top' ? v > H / 2 - eps : edge === 'bottom' ? v < -H / 2 + eps : edge === 'left' ? u < -W / 2 + eps : u > W / 2 - eps;
        if (on) {
          s.addWeld(i, g);
          this.everWelded[i] = 1;
        }
      }
      s.addClampHinges(g);
    }
  }

  weight(): number {
    return this.sim.totalMass() * G;
  }

  addAnchor(anchorId: string, regionWorld: THREE.Box3): void {
    if (this.mode === 'rigid' || this.anchors.has(anchorId)) return;
    const g = 4 + this.anchors.size;
    this.anchors.set(anchorId, g);
    const box = regionWorld.clone().expandByScalar(0.5 * this.thickness + 1e-3);
    const s = this.sim;
    this.pivot.updateMatrixWorld(true);
    for (let i = 0; i < s.n; i++) {
      if (!s.palive[i]) continue;
      _v.set(s.x[3 * i]!, s.x[3 * i + 1]!, s.x[3 * i + 2]!).applyMatrix4(this.pivot.matrixWorld);
      if (box.containsPoint(_v)) {
        s.addWeld(i, g);
        this.everWelded[i] = 1;
      }
    }
    s.addClampHinges(g);
  }

  releaseAnchor(anchorId: string): void {
    const g = this.anchors.get(anchorId);
    if (g === undefined) return;
    this.anchors.delete(anchorId);
    this.sim.releaseGroup(g);
    this.checkRelease();
  }

  /**
   * Fraction of the material in a region that is still there and holding: welded particles that
   * are still welded (for support regions), otherwise the area of live triangles.
   */
  supportPresence(regionWorld: THREE.Box3): number {
    if (this.failed || this.disposed) return 0;
    const s = this.sim;
    const box = regionWorld.clone().expandByScalar(0.5 * this.thickness + 1e-3);
    this.pivot.updateMatrixWorld(true);
    let welded = 0, weldedLive = 0;
    for (let i = 0; i < s.n; i++) {
      if (!this.everWelded[i]) continue;
      _v.set(s.x[3 * i]!, s.x[3 * i + 1]!, s.x[3 * i + 2]!).applyMatrix4(this.pivot.matrixWorld);
      if (!box.containsPoint(_v)) continue;
      welded++;
      const w = s.weldOf[i]!;
      if (s.palive[i] && w >= 0 && s.weldAlive[w]) weldedLive++;
    }
    if (welded > 0) return weldedLive / welded;
    let all = 0, live = 0;
    for (let t = 0; t < s.nt; t++) {
      const c = s.centroid(t);
      _v.set(c[0], c[1], c[2]).applyMatrix4(this.pivot.matrixWorld);
      if (!box.containsPoint(_v)) continue;
      all += s.tArea0[t]!;
      if (s.talive[t]) live += s.tArea0[t]!;
    }
    return all > 0 ? live / all : 0;
  }

  /**
   * In-plane load from what rests on the plate (a wall panel carrying a floor). Checked against the
   * remaining section's squash load and the post-buckling capacity of a plate loaded on one edge
   * (von Kármán effective width: N ≈ f_y·t·b_eff, b_eff = 1.9 t √(E/f_y)).
   */
  setImposedLoad(newtons: number): void {
    this.imposed = newtons;
    if (this.failed || newtons <= 0) return;
    const P = this.params, t = this.thickness;
    const b = Math.min(this.spec.width, 1.9 * t * Math.sqrt(P.E / P.fy) * 2);
    let frac = 0, n = 0;
    for (let tr = 0; tr < this.sim.nt; tr++) {
      n++;
      if (this.sim.talive[tr]) frac += this.sim.tThick[tr]!;
    }
    const capacity = P.fy * t * b * (n > 0 ? frac / n : 0);
    if (newtons > capacity) this.fail('buckling');
  }

  hasFailed(): boolean {
    return this.failed;
  }

  private fail(cause: 'buckling' | 'support-lost'): void {
    if (this.failed) return;
    this.failed = true;
    this.ctx.events.emit('structuralFailure', {
      time: this.ctx.time.now, position: this.bounds.getCenter(new THREE.Vector3()), label: this.name, mass: this.sim.totalMass(), cause,
    });
    if (cause === 'buckling') for (let w = 0; w < this.sim.nw; w++) if (this.sim.weldAlive[w]) this.sim.releaseGroup(this.sim.weldGroup[w]!);
    this.checkRelease();
  }

  /** Nothing holds the plate any more → it falls as a rigid body with its deformation frozen. */
  private checkRelease(): void {
    if (this.mode === 'rigid' || this.sim.liveWelds() > 0) return;
    if (!this.failed) {
      this.failed = true;
      this.ctx.events.emit('structuralFailure', {
        time: this.ctx.time.now, position: this.bounds.getCenter(new THREE.Vector3()), label: this.name, mass: this.sim.totalMass(), cause: 'support-lost',
      });
    }
    // Let the dish finish forming first (a few ms), then go rigid (see fixedUpdate).
    if (!this.sim.busy) this.toRigid();
  }

  // ─── rendering ──────────────────────────────────────────────────────────────────────────────

  /** Index buffer (both faces + rims along free edges) after a topology change. */
  private rebuildTopology(): void {
    const s = this.sim, idx = this.index;
    let k = 0;
    for (let t = 0; t < s.nt; t++) {
      if (!s.talive[t]) continue;
      const a = s.tv[3 * t]!, b = s.tv[3 * t + 1]!, c = s.tv[3 * t + 2]!;
      idx[k++] = a;
      idx[k++] = b;
      idx[k++] = c;
      const o = s.pcap;
      idx[k++] = o + a;
      idx[k++] = o + c;
      idx[k++] = o + b;
    }
    let rims = 0;
    for (let e = 0; e < s.ne && rims < this.rimCap; e++) {
      if (!s.ealive[e] || s.eTB[e]! >= 0) continue;
      const base = this.rimBase + 4 * rims;
      idx[k++] = base;
      idx[k++] = base + 2;
      idx[k++] = base + 1;
      idx[k++] = base;
      idx[k++] = base + 3;
      idx[k++] = base + 2;
      rims++;
    }
    this.rimCount = rims;
    this.geometry.setDrawRange(0, k);
    const ia = this.geometry.getIndex()!;
    ia.clearUpdateRanges();
    ia.addUpdateRange(0, k);
    ia.needsUpdate = true;
    s.topologyDirty = false;
    this.geomVersion++;
  }
  private rimCount = 0;

  /** Positions, normals, attributes of both faces and rims from the sheet's current state. */
  private updateGeometry(): void {
    const t0 = performance.now();
    const s = this.sim, x = s.x, N = this.vNormal, T = this.vThick;
    const n = s.n;
    N.fill(0, 0, 3 * n);
    T.fill(0, 0, n);
    const cnt = this.strainA;
    cnt.fill(0, 0, n);
    const strain = this.rimA; // scratch: max strain per particle
    strain.fill(0, 0, n);
    for (let t = 0; t < s.nt; t++) {
      if (!s.talive[t]) continue;
      const a = s.tv[3 * t]!, b = s.tv[3 * t + 1]!, c = s.tv[3 * t + 2]!;
      const ax = x[3 * b]! - x[3 * a]!, ay = x[3 * b + 1]! - x[3 * a + 1]!, az = x[3 * b + 2]! - x[3 * a + 2]!;
      const bx = x[3 * c]! - x[3 * a]!, by = x[3 * c + 1]! - x[3 * a + 1]!, bz = x[3 * c + 2]! - x[3 * a + 2]!;
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const th = s.tThick[t]! * this.thickness;
      const eq = s.eqStrain(t);
      for (let q = 0; q < 3; q++) {
        const i = q === 0 ? a : q === 1 ? b : c;
        N[3 * i] = N[3 * i]! + nx;
        N[3 * i + 1] = N[3 * i + 1]! + ny;
        N[3 * i + 2] = N[3 * i + 2]! + nz;
        T[i] = T[i]! + th;
        cnt[i] = cnt[i]! + 1;
        if (eq > strain[i]!) strain[i] = eq;
      }
    }
    const W = this.spec.width, H = this.spec.height;
    const pos = this.pos, nrm = this.nrm, duv = this.duv, o = s.pcap;
    for (let i = 0; i < n; i++) {
      let nx = N[3 * i]!, ny = N[3 * i + 1]!, nz = N[3 * i + 2]!;
      const l = Math.hypot(nx, ny, nz);
      if (l > 0) {
        nx /= l;
        ny /= l;
        nz /= l;
      } else nz = 1;
      N[3 * i] = nx;
      N[3 * i + 1] = ny;
      N[3 * i + 2] = nz;
      const th = cnt[i]! > 0 ? T[i]! / cnt[i]! : this.thickness;
      T[i] = th;
      const h = 0.5 * th;
      const px = x[3 * i]!, py = x[3 * i + 1]!, pz = x[3 * i + 2]!;
      pos[3 * i] = px + nx * h;
      pos[3 * i + 1] = py + ny * h;
      pos[3 * i + 2] = pz + nz * h;
      nrm[3 * i] = nx;
      nrm[3 * i + 1] = ny;
      nrm[3 * i + 2] = nz;
      pos[3 * (o + i)] = px - nx * h;
      pos[3 * (o + i) + 1] = py - ny * h;
      pos[3 * (o + i) + 2] = pz - nz * h;
      nrm[3 * (o + i)] = -nx;
      nrm[3 * (o + i) + 1] = -ny;
      nrm[3 * (o + i) + 2] = -nz;
      const u = s.uv[2 * i]! / W + 0.5, v = s.uv[2 * i + 1]! / H + 0.5;
      duv[2 * i] = 0.5 * u;
      duv[2 * i + 1] = v;
      duv[2 * (o + i)] = 0.5 + 0.5 * u;
      duv[2 * (o + i) + 1] = v;
      this.heatA[i] = this.heatA[o + i] = s.temp[i]!;
    }
    for (let i = 0; i < n; i++) {
      const eq = strain[i]!;
      this.strainA[i] = this.strainA[o + i] = eq;
      this.rimA[i] = this.rimA[o + i] = 0;
    }
    // Rims: a quad per free edge, flat-shaded, facing away from its triangle.
    let r = 0;
    for (let e = 0; e < s.ne && r < this.rimCap; e++) {
      if (!s.ealive[e] || s.eTB[e]! >= 0) continue;
      const A = s.eTA[e]!, k = s.eKA[e]!;
      const i = s.tv[3 * A + k]!, j = s.tv[3 * A + NEXT[k]]!;
      const ex = x[3 * j]! - x[3 * i]!, ey = x[3 * j + 1]! - x[3 * i + 1]!, ez = x[3 * j + 2]! - x[3 * i + 2]!;
      const fx = 0.5 * (N[3 * i]! + N[3 * j]!), fy = 0.5 * (N[3 * i + 1]! + N[3 * j + 1]!), fz = 0.5 * (N[3 * i + 2]! + N[3 * j + 2]!);
      let rx = ey * fz - ez * fy, ry = ez * fx - ex * fz, rz = ex * fy - ey * fx;
      const rl = Math.hypot(rx, ry, rz) || 1;
      rx /= rl;
      ry /= rl;
      rz /= rl;
      const base = this.rimBase + 4 * r;
      for (let q = 0; q < 4; q++) {
        const p = q === 0 || q === 3 ? i : j, vtx = base + q;
        const src = q < 2 ? p : o + p;
        pos[3 * vtx] = pos[3 * src]!;
        pos[3 * vtx + 1] = pos[3 * src + 1]!;
        pos[3 * vtx + 2] = pos[3 * src + 2]!;
        nrm[3 * vtx] = rx;
        nrm[3 * vtx + 1] = ry;
        nrm[3 * vtx + 2] = rz;
        duv[2 * vtx] = duv[2 * p]!;
        duv[2 * vtx + 1] = duv[2 * p + 1]!;
        this.heatA[vtx] = s.temp[p]!;
        this.strainA[vtx] = this.strainA[p]!;
        this.rimA[vtx] = 1;
        this.rimSrc[4 * r + q] = p;
      }
      r++;
    }
    this.rimVerts = 4 * r;
    const g = this.geometry;
    for (const name of ['position', 'normal', 'aDUv', 'aHeat', 'aStrain', 'aRim']) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      const width = a.itemSize;
      a.addUpdateRange(0, width * n);
      a.addUpdateRange(width * o, width * n);
      if (r > 0) a.addUpdateRange(width * this.rimBase, width * 4 * r);
      a.needsUpdate = true;
    }
    this.updateBounds();
    s.geometryDirty = false;
    this.geomVersion++;
    this.stats.lastMeshMs = performance.now() - t0;
  }

  /** Only the temperature attribute (a cooling sheet whose shape has not changed). */
  private updateHeat(): void {
    const s = this.sim, n = s.n, o = s.pcap, H = this.heatA;
    for (let i = 0; i < n; i++) H[i] = H[o + i] = s.temp[i]!;
    for (let q = 0; q < this.rimVerts; q++) H[this.rimBase + q] = s.temp[this.rimSrc[q]!]!;
    const a = this.geometry.getAttribute('aHeat') as THREE.BufferAttribute;
    a.clearUpdateRanges();
    a.addUpdateRange(0, n);
    a.addUpdateRange(o, n);
    if (this.rimVerts > 0) a.addUpdateRange(this.rimBase, this.rimVerts);
    a.needsUpdate = true;
  }

  /** Heat was added somewhere: check the temperatures on the next frame. */
  private warm(): void {
    this.hot = true;
    this.stats.hottest = Math.max(this.stats.hottest, VISIBLE_HEAT_C);
  }

  private updateBounds(): void {
    const s = this.sim;
    const bb = this.bounds.makeEmpty();
    this.pivot.updateMatrixWorld(true);
    const m = this.pivot.matrixWorld;
    const h = 0.5 * this.thickness * 1.5;
    for (let i = 0; i < s.n; i++) {
      if (!s.palive[i]) continue;
      _v.set(s.x[3 * i]!, s.x[3 * i + 1]!, s.x[3 * i + 2]!).applyMatrix4(m);
      bb.expandByPoint(_v);
    }
    bb.expandByScalar(h + 1e-3);
    this.invPivot.copy(m).invert();
  }

  // ─── ray queries ────────────────────────────────────────────────────────────────────────────

  private ensureTriSpheres(): void {
    if (this.triSphereVersion === this.geomVersion) return;
    const s = this.sim, x = s.x, sp = this.triSphere;
    for (let t = 0; t < s.nt; t++) {
      if (!s.talive[t]) {
        sp[4 * t + 3] = -1;
        continue;
      }
      const a = 3 * s.tv[3 * t]!, b = 3 * s.tv[3 * t + 1]!, c = 3 * s.tv[3 * t + 2]!;
      const cx = (x[a]! + x[b]! + x[c]!) / 3, cy = (x[a + 1]! + x[b + 1]! + x[c + 1]!) / 3, cz = (x[a + 2]! + x[b + 2]! + x[c + 2]!) / 3;
      let r2 = 0;
      for (let q = 0; q < 3; q++) {
        const p = q === 0 ? a : q === 1 ? b : c;
        r2 = Math.max(r2, (x[p]! - cx) ** 2 + (x[p + 1]! - cy) ** 2 + (x[p + 2]! - cz) ** 2);
      }
      sp[4 * t] = cx;
      sp[4 * t + 1] = cy;
      sp[4 * t + 2] = cz;
      sp[4 * t + 3] = Math.sqrt(r2) + this.thickness;
    }
    this.triSphereVersion = this.geomVersion;
  }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
    if (this.disposed) return null;
    this.ensureTriSpheres();
    const inv = this.invPivot;
    _o.copy(origin).applyMatrix4(inv);
    _d.copy(dir).transformDirection(inv);
    const s = this.sim, x = s.x, sp = this.triSphere;
    const ox = _o.x, oy = _o.y, oz = _o.z, dx = _d.x, dy = _d.y, dz = _d.z;
    let best = maxDist, bestT = -1, bu = 0, bv = 0, bw = 0;
    for (let t = 0; t < s.nt; t++) {
      const r = sp[4 * t + 3]!;
      if (r < 0) continue;
      // Sphere cull.
      const cx = sp[4 * t]! - ox, cy = sp[4 * t + 1]! - oy, cz = sp[4 * t + 2]! - oz;
      const along = cx * dx + cy * dy + cz * dz;
      if (along < -r || along - r > best) continue;
      const perp2 = cx * cx + cy * cy + cz * cz - along * along;
      if (perp2 > r * r) continue;
      // Möller–Trumbore against the mid-surface.
      const a = 3 * s.tv[3 * t]!, b = 3 * s.tv[3 * t + 1]!, c = 3 * s.tv[3 * t + 2]!;
      const e1x = x[b]! - x[a]!, e1y = x[b + 1]! - x[a + 1]!, e1z = x[b + 2]! - x[a + 2]!;
      const e2x = x[c]! - x[a]!, e2y = x[c + 1]! - x[a + 1]!, e2z = x[c + 2]! - x[a + 2]!;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue;
      const id = 1 / det;
      const tx = ox - x[a]!, ty = oy - x[a + 1]!, tz = oz - x[a + 2]!;
      const u = (tx * px + ty * py + tz * pz) * id;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * id;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * id;
      if (tt < 0 || tt >= best) continue;
      // Through a hole? Look it up in the detail mask (front face).
      const w = 1 - u - v;
      const ia = s.tv[3 * t]!, ib = s.tv[3 * t + 1]!, ic = s.tv[3 * t + 2]!;
      const ru = w * s.uv[2 * ia]! + u * s.uv[2 * ib]! + v * s.uv[2 * ic]!;
      const rv = w * s.uv[2 * ia + 1]! + u * s.uv[2 * ib + 1]! + v * s.uv[2 * ic + 1]!;
      if (!this.detail.solid(0.5 * (ru / this.spec.width + 0.5), rv / this.spec.height + 0.5)) continue;
      best = tt;
      bestT = t;
      bu = ru;
      bv = rv;
      bw = w;
    }
    if (bestT < 0) return null;
    // Normal of the struck triangle facing the ray; entry is on the face, t/2 before the mid-surface.
    const t = bestT;
    const a = 3 * s.tv[3 * t]!, b = 3 * s.tv[3 * t + 1]!, c = 3 * s.tv[3 * t + 2]!;
    _n.set(
      (x[b + 1]! - x[a + 1]!) * (x[c + 2]! - x[a + 2]!) - (x[b + 2]! - x[a + 2]!) * (x[c + 1]! - x[a + 1]!),
      (x[b + 2]! - x[a + 2]!) * (x[c]! - x[a]!) - (x[b]! - x[a]!) * (x[c + 2]! - x[a + 2]!),
      (x[b]! - x[a]!) * (x[c + 1]! - x[a + 1]!) - (x[b + 1]! - x[a + 1]!) * (x[c]! - x[a]!),
    ).normalize();
    if (_n.dot(_d) > 0) _n.negate();
    const cos = Math.max(0.05, -_n.dot(_d));
    const half = 0.5 * this.thickness * s.tThick[t]!;
    const entry = Math.max(0, best - half / cos);
    const local = _o.clone().addScaledVector(_d, entry);
    const mid = _o.clone().addScaledVector(_d, best);
    this.pivot.updateMatrixWorld();
    const point = local.clone().applyMatrix4(this.pivot.matrixWorld);
    const normal = _n.clone().transformDirection(this.pivot.matrixWorld);
    const dist = point.distanceTo(origin);
    const hit: RayHit = { target: this, point, normal, distance: dist, material: this.material, part: t };
    void bw;
    this.hitCache = { hit, tri: t, u: bu, v: bv, local: mid, normal: _n.clone() };
    return hit;
  }

  /** Effective thickness at the hit (thinned, spalled, cratered) along the shot line. */
  probe(hit: RayHit, dir: THREE.Vector3, maxDepth: number): ThicknessProbe {
    const c = this.cacheFor(hit.point);
    const t = c ? c.tri : hit.part ?? -1;
    const s = this.sim;
    let th = this.thickness, strength = 1;
    if (t >= 0 && s.talive[t]) {
      th = this.thickness * s.tThick[t]!;
      // Material already damaged by plastic straining resists less (void growth, Gurson-type
      // softening, as a fraction of the fracture strain used).
      const used = s.eqStrain(t) / s.tEf[t]!;
      strength = Math.max(0.35, 1 - 0.6 * used * used);
      if (c) {
        const face = this.faceU(c, dir);
        th = Math.max(0.1 * th, th - this.detail.dimpleAt(face, c.v / this.spec.height + 0.5) * this.thickness);
      }
    }
    _d.copy(dir).transformDirection(this.invPivot);
    const n = c ? c.normal : _n.set(0, 0, 1);
    const cos = Math.max(0.1, Math.abs(n.dot(_d)));
    const len = Math.min(maxDepth, th / cos);
    return { segments: [{ material: this.material, start: 0, end: len, strength }], exits: len < maxDepth };
  }

  /** Detail-texture u of the face a shot along `dir` enters (front half = +z side). */
  private faceU(c: HitCache, dirWorld: THREE.Vector3): number {
    _w.copy(dirWorld).transformDirection(this.invPivot);
    const s = this.sim, t = c.tri;
    const a = 3 * s.tv[3 * t]!, b = 3 * s.tv[3 * t + 1]!, cc = 3 * s.tv[3 * t + 2]!, x = s.x;
    const nz = (x[b]! - x[a]!) * (x[cc + 1]! - x[a + 1]!) - (x[b + 1]! - x[a + 1]!) * (x[cc]! - x[a]!);
    const nxv = (x[b + 1]! - x[a + 1]!) * (x[cc + 2]! - x[a + 2]!) - (x[b + 2]! - x[a + 2]!) * (x[cc + 1]! - x[a + 1]!);
    const nyv = (x[b + 2]! - x[a + 2]!) * (x[cc]! - x[a]!) - (x[b]! - x[a]!) * (x[cc + 2]! - x[a + 2]!);
    const front = nxv * _w.x + nyv * _w.y + nz * _w.z < 0;
    const u = c.u / this.spec.width + 0.5;
    return front ? 0.5 * u : 0.5 + 0.5 * u;
  }

  /** Reuse the last ray hit if the impact is at its point; otherwise locate the nearest triangle. */
  private cacheFor(pointWorld: THREE.Vector3): HitCache | null {
    const c = this.hitCache;
    if (c && c.hit.point.distanceToSquared(pointWorld) < 1e-8) return c;
    // Locate: nearest particle, then the incident triangle whose plane projection contains the point.
    const s = this.sim;
    _o.copy(pointWorld).applyMatrix4(this.invPivot);
    const i = s.nearestParticle(_o.x, _o.y, _o.z);
    if (i < 0) return null;
    let bestT = -1, bestD = Infinity, bu = s.uv[2 * i]!, bv = s.uv[2 * i + 1]!;
    for (const t of s.vertTris[i]!) {
      if (!s.talive[t]) continue;
      const cen = s.centroid(t);
      const d = (cen[0] - _o.x) ** 2 + (cen[1] - _o.y) ** 2 + (cen[2] - _o.z) ** 2;
      if (d < bestD) {
        bestD = d;
        bestT = t;
        const cuv = s.centroidUV(t);
        // Blend towards the particle: the point is near its nearest particle.
        bu = 0.5 * (cuv[0] + s.uv[2 * i]!);
        bv = 0.5 * (cuv[1] + s.uv[2 * i + 1]!);
      }
    }
    if (bestT < 0) return null;
    const x = s.x, a = 3 * s.tv[3 * bestT]!, b = 3 * s.tv[3 * bestT + 1]!, cc = 3 * s.tv[3 * bestT + 2]!;
    const n = new THREE.Vector3(
      (x[b + 1]! - x[a + 1]!) * (x[cc + 2]! - x[a + 2]!) - (x[b + 2]! - x[a + 2]!) * (x[cc + 1]! - x[a + 1]!),
      (x[b + 2]! - x[a + 2]!) * (x[cc]! - x[a]!) - (x[b]! - x[a]!) * (x[cc + 2]! - x[a + 2]!),
      (x[b]! - x[a]!) * (x[cc + 1]! - x[a + 1]!) - (x[b + 1]! - x[a + 1]!) * (x[cc]! - x[a]!),
    ).normalize();
    return { hit: { target: this, point: pointWorld.clone(), normal: n.clone(), distance: 0, material: this.material }, tri: bestT, u: bu, v: bv, local: _o.clone(), normal: n };
  }

  // ─── impacts ────────────────────────────────────────────────────────────────────────────────

  applyImpact(e: ImpactEvent): void {
    if (this.disposed) return;
    const t0 = performance.now();
    const c = this.cacheFor(e.point);
    if (!c) return;
    const s = this.sim, P = this.params;
    const rng = this.ctx.rng;
    const W = this.spec.width, H = this.spec.height;
    const vv = c.v / H + 0.5;
    const uEntry = this.faceU(c, e.direction);
    const uExit = uEntry < 0.5 ? uEntry + 0.5 : uEntry - 0.5;
    const ru = (r: number) => r / (2 * W); // detail texture u units per metre (split texture)
    const rv = (r: number) => r / H;
    // The heat map covers one face (heat conducts through the thickness).
    const hu = c.u / W + 0.5;
    const hr = (r: number) => r / W;
    const tEff = this.thickness * (c.tri >= 0 ? s.tThick[c.tri]! : 1);
    const a = e.ammo;
    const kind = a.kind;
    const d = Math.max(a.diameter, 0.004);
    const seed = rng.next() * 100;
    const localDir = _w.copy(e.direction).transformDirection(this.invPivot).clone();
    const time = this.ctx.time.now;
    const alpha = diffusivity(P);

    // Momentum the plate structure receives (N·s, world). A perforating round mostly pushes the plug
    // and debris out of the way: the sheet only feels the penetration resistance during the transit,
    // R_t·π r²·t / v̄ (Tate target resistance R_t ≈ 3.5 σ_y for steel; Tate 1967, Anderson & Walker 1991).
    let Pmag = e.momentum.length();
    if (e.outcome === 'perforate' && e.agent !== 'jet') {
      const vbar = Math.max(1, 0.5 * (e.speed + e.residualSpeed));
      const Rt = 3.5 * (P.fy);
      const r = Math.max(e.tunnelRadius, 0.5 * d);
      Pmag = Math.min(Pmag, (Rt * Math.PI * r * r * (tEff / Math.max(0.2, Math.cos(e.obliquity)))) / vbar);
    }

    switch (e.outcome) {
      case 'perforate': {
        const r = Math.max(e.tunnelRadius, 0.3 * d);
        // Hole character: long rods, AP cores and jets punch round holes (plugging / ductile hole
        // growth); lead-core ball and fragments tear ragged ones; thin plates petal (t/d < 0.35 for
        // pointed noses, Backman & Goldsmith 1978).
        const clean = kind === 'apfsds' || kind === 'ap' || e.agent === 'jet';
        const petal = !clean && tEff / d < 0.35;
        const jag = clean ? 0.06 : petal ? 0.4 : 0.22;
        this.detail.hole(uEntry, vv, ru(r), rv(r), jag, seed);
        this.detail.hole(uExit, vv, ru(r * (petal ? 1.1 : 1.05)), rv(r * (petal ? 1.1 : 1.05)), jag * 1.3, seed + 1);
        // Narrow ring of sheared, scraped metal at the entry (the projectile's shoulder wipes the
        // coating off ≈ ½ r beyond the hole), a wider burr / spall ring on the exit side.
        this.detail.scar(uEntry, vv, ru(r * 1.5), rv(r * 1.5), 0.9, seed);
        this.detail.scar(uExit, vv, ru(r * 1.9), rv(r * 1.9), 0.8, seed + 2);
        this.detail.dimple(uEntry, vv, ru(r * 1.7), rv(r * 1.7), Math.min(1, (0.25 * tEff) / this.thickness));
        // Hole-rim heating: the energy dissipated in the transit heats the annulus r…2r (adiabatic
        // shear at the rim), Taylor–Quinney β = 0.9, ΔT = βE/(m c). Jets and rods glow; bullets barely.
        const share = e.agent === 'jet' ? 0.3 : 0.5;
        const mRim = P.rho * tEff * Math.PI * 3 * r * r;
        const dT = Math.min(1450, (TAYLOR_QUINNEY * share * e.energyAbsorbed) / (mRim * P.c));
        this.detail.heatSpot(hu, vv, hr(2.5 * r), rv(2.5 * r), dT, time, 2 * r, alpha);
        // The hole wall itself: plug-shear work per unit wall area (plugShearHeat), doubled for the
        // hydrodynamic crater lining of a jet, less for petalling (the work goes to the petal roots),
        // never more than the energy the target absorbed. In a δ = 1 mm layer the peak is q/(ρ c δ);
        // it cools as δ/√(π α t), so the glow lasts about a tenth of a second.
        const layer = 1e-3;
        const qMax = (TAYLOR_QUINNEY * e.energyAbsorbed) / (2 * Math.PI * r * tEff);
        const qWall = Math.min(qMax, plugShearHeat(P, tEff) * (e.agent === 'jet' ? 2 : petal ? 0.4 : 1));
        this.detail.boreHeat(hu, vv, hr(1.35 * r), rv(1.35 * r), Math.min(1450, qWall / (P.rho * P.c * layer)), time, layer, alpha);
        // Mesh-scale hole when it is larger than the sheet's resolution.
        if (r > 0.45 * s.spacing) {
          const res = s.breach(c.u, c.v, r, petal ? 1.3 * r : 0, petal ? 4 + Math.floor(rng.next() * 2) : 0, Math.floor(seed * 1000));
          if (petal && res.crackAngles.length) {
            const out = this.localNormalAlong(c, localDir);
            s.foldPetals(c.u, c.v, r, 2.3 * r, out, 0.3 * e.energyAbsorbed, e.speed);
          }
        }
        break;
      }
      case 'ricochet': {
        // A gouge streak along the path, bright metal, little dent.
        const len = Math.max(3 * d, e.craterRadius * 2);
        const du = localDir.x, dv = localDir.y;
        const dl = Math.hypot(du, dv) || 1;
        for (let k = 0; k < 4; k++) {
          const f = (k / 3 - 0.3) * len;
          this.detail.scar(uEntry + ru(f * (du / dl)), vv + rv(f * (dv / dl)), ru(e.craterRadius), rv(e.craterRadius), 1, seed + k);
        }
        this.detail.dimple(uEntry, vv, ru(e.craterRadius), rv(e.craterRadius), Math.min(1, e.craterDepth / this.thickness));
        break;
      }
      default: {
        // Embed / shatter: crater of the resolved size; bright ring; paint chips further out.
        const rc = Math.max(e.craterRadius, 0.6 * d);
        const depth = e.outcome === 'shatter' ? e.craterDepth : Math.max(e.craterDepth, e.depth);
        this.detail.dimple(uEntry, vv, ru(rc), rv(rc), Math.min(1, depth / this.thickness));
        this.detail.scar(uEntry, vv, ru(rc * (this.spec.finish === 'painted' ? 2.6 : 1.8)), rv(rc * (this.spec.finish === 'painted' ? 2.6 : 1.8)), 1, seed);
        if (kind === 'ball' && e.outcome === 'shatter') this.detail.soot(uEntry, vv, ru(rc * 1.2), rv(rc * 1.2), 0.35, seed); // lead smear
        // Crater heating: what the crater volume absorbed (≈ 3 σ_y × volume, cavity expansion), the
        // rest went into the projectile and the structure.
        const V = Math.PI * rc * rc * Math.max(depth, 5e-4) * 0.5;
        const Ec = Math.min(e.energyAbsorbed, 3 * P.fy * V * 4);
        const dT = Math.min(1450, (TAYLOR_QUINNEY * Ec) / (P.rho * V * 3 * P.c));
        this.detail.heatSpot(hu, vv, hr(1.5 * rc), rv(1.5 * rc), dT, time, rc, alpha);
        break;
      }
    }

    // Rear-face spall the resolver reported (a hard hit on a thick plate that did not go through, or
    // a wide flake around an exit): a flat fracture scab, the material gone with it.
    if (e.spallRadius > 0 && e.spallDepth > 0) {
      const rs = e.spallRadius;
      this.detail.scab(uExit, vv, ru(rs), rv(rs), Math.min(1, e.spallDepth / this.thickness), seed + 5);
      if (e.outcome !== 'perforate' && rs > 0.5 * s.spacing) {
        const frac = Math.min(0.6, e.spallDepth / Math.max(tEff, 1e-4));
        for (let t = 0; t < s.nt; t++) {
          if (!s.talive[t]) continue;
          const [tu, tv] = s.centroidUV(t);
          const q = ((tu - c.u) ** 2 + (tv - c.v) ** 2) / (rs * rs);
          if (q < 1) s.removeMaterial(t, frac * (1 - 0.5 * q));
        }
      }
    }

    // Structural response: the momentum (normal component) as a Gaussian load over ~2–3 calibres.
    const nL = c.normal;
    const pLocal = _v.copy(e.momentum).transformDirection(this.invPivot).multiplyScalar(Pmag);
    const pn = -pLocal.dot(nL);
    if (pn > 0) {
      const foot = Math.max(e.craterRadius, 1.5 * d);
      this.loadImpulse(c, pn, foot, [-nL.x, -nL.y, -nL.z]);
    }
    this.lastImpulse.copy(e.momentum).setLength(Pmag);
    this.lastImpulsePoint.copy(e.point);
    if (this.mode === 'rigid' && this.body) this.ctx.physics.applyImpulseAt(this.body, this.lastImpulse, e.point);

    // Sparks for steel strikes: count and speed grow with the energy.
    const sparkN = Math.round(Math.min(60, 4 + Math.sqrt(e.kineticEnergy) / 12));
    const out = e.outcome === 'ricochet' && e.residualDirection ? e.residualDirection : e.normal;
    this.ctx.fx.sparks({ position: e.point, direction: out, count: sparkN, speed: Math.min(60, 8 + e.speed * 0.03), hot: e.agent === 'jet' ? 1 : 0.6 });
    if (e.outcome === 'perforate' && e.exitPoint) this.ctx.fx.sparks({ position: e.exitPoint, direction: e.direction, count: Math.round(sparkN * 0.7), speed: Math.min(80, 10 + e.residualSpeed * 0.05), hot: 0.8 });
    this.warm();
    this.stats.lastImpactMs = performance.now() - t0;
  }

  /** Outward (fold) normal of the plate at a hit, pointing along `dirLocal`. */
  private localNormalAlong(c: HitCache, dirLocal: THREE.Vector3): [number, number, number] {
    const n = c.normal;
    const s = n.dot(dirLocal) >= 0 ? 1 : -1;
    return [n.x * s, n.y * s, n.z * s];
  }

  /**
   * A Gaussian impulse of total P (N·s) over radius `foot` around a hit, pushing along `dir`, turned
   * into plastic deformation by the mode approximation (skipped when it cannot yield anything).
   */
  private loadImpulse(c: HitCache, P: number, foot: number, dir: [number, number, number]): void {
    if (this.mode === 'rigid') return;
    const s = this.sim;
    const a = Math.max(foot, 0.5 * s.spacing);
    let sum = 0, mLocal = 0;
    const wts = this.wScratch;
    wts.fill(0, 0, s.n);
    for (let i = 0; i < s.n; i++) {
      if (!s.palive[i]) continue;
      const d2 = (s.uv[2 * i]! - c.u) ** 2 + (s.uv[2 * i + 1]! - c.v) ** 2;
      if (d2 > 9 * a * a) continue;
      const w = Math.exp(-d2 / (a * a)) * s.mass[i]!;
      wts[i] = w;
      sum += w;
      if (d2 < a * a) mLocal += s.mass[i]!;
    }
    if (!(sum > 0)) return;
    // Cheapest possible mode energy vs the smallest hinge's elastic capacity: bullets stop here.
    const eMax = (P * P) / (2 * Math.max(mLocal, s.mass[s.nearestParticle(c.local.x, c.local.y, c.local.z)] ?? 1));
    const My = (this.params.fy * this.thickness ** 2 * s.spacing) / 6;
    const Eel = (My * My) / (2 * ((this.params.E * this.thickness ** 3) / (12 * (1 - this.params.nu ** 2))));
    if (eMax < 4 * Eel) return;
    const J = this.jScratch.subarray(0, 3 * s.n);
    J.fill(0);
    for (let i = 0; i < s.n; i++) {
      const w = wts[i]!;
      if (w === 0) continue;
      const Ji = (P * w) / sum;
      J[3 * i] = Ji * dir[0];
      J[3 * i + 1] = Ji * dir[1];
      J[3 * i + 2] = Ji * dir[2];
    }
    const centre = s.nearestParticle(c.local.x, c.local.y, c.local.z);
    const r = s.impulse(J, centre, dir, this.modeRadii(a));
    if (r && r.amplitude > 0) this.stats.deformations++;
  }

  /** Candidate dome radii from the load footprint up to the whole plate (plus the global mode). */
  private modeRadii(a: number): number[] {
    const R: number[] = [];
    const Rmax = Math.hypot(this.spec.width, this.spec.height);
    for (let r = Math.max(a, 0.7 * this.sim.spacing); r < Rmax; r *= 1.45) R.push(r);
    R.push(Rmax, 100);
    return R;
  }

  // ─── blasts ─────────────────────────────────────────────────────────────────────────────────

  applyBlast(load: BlastLoad): void {
    if (this.disposed) return;
    const t0 = performance.now();
    if (this.mode === 'rigid') {
      if (this.body) {
        this.pivot.updateMatrixWorld();
        const c = this.bounds.getCenter(new THREE.Vector3());
        _n.copy(c).sub(load.center);
        const dist = Math.max(0.05, _n.length());
        _n.divideScalar(dist);
        // The BlastSystem already pushes every loose body as a sphere of the same volume (presented
        // area π r_eq²); a sheet presents far more, so only the difference is added here.
        const m = this.sim.totalMass();
        const P = this.params;
        const rEq = Math.cbrt((3 * m) / (4 * Math.PI * P.rho));
        _w.set(0, 0, 1).transformDirection(this.pivot.matrixWorld);
        const presented = (m / (P.rho * this.thickness)) * Math.abs(_w.dot(_n));
        const extra = Math.max(0, presented - Math.PI * rEq * rEq);
        const I = load.reflectedImpulseAt(c, _w.copy(_n).negate());
        if (extra > 0) this.ctx.physics.applyImpulseAt(this.body, _n.multiplyScalar(Math.min(I * extra, 300 * m)), c);
      }
      return;
    }
    // Distant blasts: bound the kinetic energy the load could give the sheet by the reflected impulse
    // at its nearest point (normal incidence: the largest anywhere on it) over its whole area,
    // Σ (I A)²/2m ≤ I_max² A / 2ρt. If even that (×2 for safety) cannot yield a 0.2 m patch and the
    // fireball does not reach, nothing here changes — and the per-particle loading is skipped.
    {
      const P = this.params;
      this.bounds.clampPoint(load.center, _v);
      const near = _v.distanceTo(load.center);
      if (load.contactTargetId !== this.id && near > 2 * Math.cbrt(Math.max(load.tntKg, 1e-6))) {
        _n.copy(load.center).sub(_v);
        if (_n.lengthSq() < 1e-12) _n.set(0, 1, 0);
        _n.normalize();
        const Imax = load.reflectedImpulseAt(_v, _n);
        const keBound = (2 * Imax * Imax * this.spec.width * this.spec.height) / (2 * P.rho * this.thickness);
        if (keBound < ((P.fy * P.fy) / (2 * P.E)) * Math.PI * 0.04 * this.thickness) {
          this.stats.lastBlastMs = performance.now() - t0;
          return;
        }
      }
    }
    const s = this.sim;
    this.pivot.updateMatrixWorld(true);
    const M = this.pivot.matrixWorld, inv = this.invPivot;
    const cLocal = load.center.clone().applyMatrix4(inv);
    const centre = s.nearestParticle(cLocal.x, cLocal.y, cLocal.z);
    if (centre < 0) return;
    // Which face looks at the charge (local normal sign at the nearest point).
    const N = this.vNormal;
    const sideSign = (N[3 * centre]! * (cLocal.x - s.x[3 * centre]!) + N[3 * centre + 1]! * (cLocal.y - s.x[3 * centre + 1]!) + N[3 * centre + 2]! * (cLocal.z - s.x[3 * centre + 2]!)) >= 0 ? 1 : -1;
    const standoff = Math.hypot(cLocal.x - s.x[3 * centre]!, cLocal.y - s.x[3 * centre + 1]!, cLocal.z - s.x[3 * centre + 2]!);
    const w3 = Math.cbrt(Math.max(load.tntKg, 1e-6));
    // Reflected impulse on every particle's tributary area, pushing the facing surface away.
    const J = new Float64Array(3 * s.n);
    const P = this.params;
    let Jtot = 0;
    for (let i = 0; i < s.n; i++) {
      if (!s.palive[i]) continue;
      const nx = N[3 * i]! * sideSign, ny = N[3 * i + 1]! * sideSign, nz = N[3 * i + 2]! * sideSign;
      _v.set(s.x[3 * i]!, s.x[3 * i + 1]!, s.x[3 * i + 2]!).applyMatrix4(M);
      _n.set(nx, ny, nz).transformDirection(M);
      const I = load.reflectedImpulseAt(_v, _n);
      const area = s.mass[i]! / (P.rho * this.thickness);
      // Cap the particle velocity at 400 m/s: material driven faster than that near a charge is
      // part of the breach / petals handled explicitly below.
      const Ji = Math.min(I * area, 400 * s.mass[i]!);
      J[3 * i] = -nx * Ji;
      J[3 * i + 1] = -ny * Ji;
      J[3 * i + 2] = -nz * Ji;
      Jtot += Ji;
    }
    // Never more momentum than the charge's products can deliver (maxBlastMomentum).
    const Jcap = maxBlastMomentum(load.tntKg, load.kind);
    if (Jtot > Jcap) {
      const k = Jcap / Jtot;
      for (let q = 0; q < J.length; q++) J[q] = J[q]! * k;
      Jtot = Jcap;
    }
    const cu = s.uv[2 * centre]!, cv = s.uv[2 * centre + 1]!;
    const W = this.spec.width, H = this.spec.height;
    const faceU = (u: number) => (sideSign > 0 ? 0.5 * (u / W + 0.5) : 0.5 + 0.5 * (u / W + 0.5));
    const vv = cv / H + 0.5;
    const nOut: [number, number, number] = [-N[3 * centre]! * sideSign, -N[3 * centre + 1]! * sideSign, -N[3 * centre + 2]! * sideSign];
    const contact = load.contactTargetId === this.id || ((load.kind === 'contact' || load.kind === 'hesh') && standoff < 0.35 * w3);
    const seed = this.ctx.rng.next() * 100;
    let breached = false;
    if (contact) {
      const tEff = this.thickness * s.tThick[s.vertTris[centre]![0] ?? 0]!;
      const cd = load.contactDamage(this.material, tEff);
      if (cd.breach && cd.breachRadius > 0) {
        const rb = cd.breachRadius, crack = 1.3 * rb;
        // Petals take the kinetic energy of the ring they are made of (rb … rb + crack); the plug
        // inside rb leaves with its own momentum. Measured before the breach: it splits particles,
        // and J only covers the ones that existed when the load was sampled.
        let Ep = 0, vsum = 0, cnt = 0;
        for (let i = 0; i < s.n; i++) {
          if (!s.palive[i] || !(s.mass[i]! > 0)) continue;
          const r = Math.hypot(s.uv[2 * i]! - cu, s.uv[2 * i + 1]! - cv);
          if (r > rb + crack) continue;
          const Jn = Math.hypot(J[3 * i]!, J[3 * i + 1]!, J[3 * i + 2]!);
          if (r >= rb) {
            Ep += (0.5 * Jn * Jn) / s.mass[i]!;
            vsum += Jn / s.mass[i]!;
            cnt++;
          }
          J[3 * i] = J[3 * i + 1] = J[3 * i + 2] = 0;
        }
        this.detail.hole(faceU(cu), vv, rb / (2 * W), rb / H, 0.45, seed);
        this.detail.hole(faceU(cu) < 0.5 ? faceU(cu) + 0.5 : faceU(cu) - 0.5, vv, (1.05 * rb) / (2 * W), (1.05 * rb) / H, 0.5, seed + 1);
        const res = s.breach(cu, cv, rb, crack, 4 + Math.floor(this.ctx.rng.next() * 3), Math.floor(seed * 997));
        breached = true;
        if (res.crackAngles.length && Ep > 0) s.foldPetals(cu, cv, rb, rb + crack, nOut, 0.8 * Ep, cnt ? vsum / cnt : 100);
        this.ctx.fx.chips({ position: load.center, direction: _n.set(nOut[0], nOut[1], nOut[2]).transformDirection(M).clone(), spread: 0.6, speed: 120, count: 30, size: 0.02, color: 0x3a3d40, kind: 'metal' });
      } else if (cd.spallRadius > 0) {
        // HESH / contact scab: a disc of the rear face flies off (Hopkinson spall). The scab is
        // bounded by the squash-head footprint (≈ 2–3 calibres, i.e. ≈ 0.1 W^1/3 m in radius;
        // Held, "HESH" in Propellants Explos. Pyrotech. 1981) whatever the wall-scale estimate says.
        const rs = Math.min(cd.spallRadius, 0.1 * w3);
        const frac = Math.min(0.5, cd.spallDepth / tEff);
        for (let t = 0; t < s.nt; t++) {
          if (!s.talive[t]) continue;
          const [u, v] = s.centroidUV(t);
          const q = ((u - cu) ** 2 + (v - cv) ** 2) / (rs * rs);
          if (q < 1) s.removeMaterial(t, frac * (1 - 0.5 * q));
        }
        const back = faceU(cu) < 0.5 ? faceU(cu) + 0.5 : faceU(cu) - 0.5;
        this.detail.scab(back, vv, rs / (2 * W), rs / H, Math.min(1, (frac * tEff) / this.thickness), seed);
        _v.set(s.x[3 * centre]!, s.x[3 * centre + 1]!, s.x[3 * centre + 2]!).applyMatrix4(M);
        this.ctx.fx.chips({ position: _v.clone(), direction: _n.set(nOut[0], nOut[1], nOut[2]).transformDirection(M).clone(), spread: 0.5, speed: cd.spallVelocity, count: 40, size: 0.015, color: 0x55575a, kind: 'metal' });
      }
      // Detonation products flash-heat the surface skin under the charge (a thin layer: it cools
      // by conduction into the plate within a fraction of a second).
      this.detail.heatSpot(cu / W + 0.5, vv, (0.06 * w3) / W, (0.06 * w3) / H, 500, this.ctx.time.now, 0.004, diffusivity(P), false);
    }
    // Soot and scorching on the face towards the charge — only within reach of the fireball
    // (diameter ≈ 3.86 W^0.32 m for TNT; Baker et al., Explosion Hazards and Evaluation 1983).
    if (standoff < 2 * w3) {
      const rs = Math.min(Math.max(W, H), 0.35 * w3 + 0.5 * standoff);
      this.detail.soot(faceU(cu), vv, rs / (2 * W), rs / H, Math.min(0.9, 0.35 * w3 / Math.max(0.2, standoff)), seed);
    }
    // Global / local dish by the mode approximation — unless even the whole kinetic energy the
    // load could impart (Σ J²/2m, an upper bound on any mode's share) is below what a 0.2 m patch
    // stores elastically at yield, σ_y²/2E · π (0.2 m)² t: then nothing yields (and distant
    // blasts cost nothing).
    let keMax = 0;
    for (let i = 0; i < s.n && 3 * i + 2 < J.length; i++) {
      if (!s.palive[i] || !(s.mass[i]! > 0)) continue;
      keMax += (J[3 * i]! ** 2 + J[3 * i + 1]! ** 2 + J[3 * i + 2]! ** 2) / (2 * s.mass[i]!);
    }
    const eYieldPatch = ((P.fy * P.fy) / (2 * P.E)) * Math.PI * 0.04 * this.thickness;
    if (Jtot > 0 && keMax > eYieldPatch) {
      const r = s.impulse(J, breached ? { u: cu, v: cv } : centre, nOut, this.modeRadii(Math.max(0.05, 0.5 * standoff)));
      if (r && r.amplitude > 0) this.stats.deformations++;
      if (r && r.amplitude > 0 && r.radius < 0.5 * Math.min(W, H)) {
        // φ ≈ (1 − (d/R)²)² with d the in-plane distance (the geodesic one differs little).
        const R2 = r.radius * r.radius;
        for (let i = 0; i < s.n && 3 * i + 2 < J.length; i++) {
          const d2 = (s.uv[2 * i]! - cu) ** 2 + (s.uv[2 * i + 1]! - cv) ** 2;
          if (d2 >= R2) continue;
          const f = 1 - d2 / R2, keep = 1 - f * f;
          J[3 * i] = J[3 * i]! * keep;
          J[3 * i + 1] = J[3 * i + 1]! * keep;
          J[3 * i + 2] = J[3 * i + 2]! * keep;
        }
        this.residual = { J, u: cu, v: cv, dir: nOut, R: r.radius };
        this.toreOut = false;
      }
    }
    this.warm();
    this.stats.lastBlastMs = performance.now() - t0;
  }

  // ─── per step ───────────────────────────────────────────────────────────────────────────────

  fixedUpdate(dt: number): void {
    if (this.disposed || this.mode === 'rigid') return;
    const s = this.sim;
    if (!s.busy && !s.topologyDirty) return;
    const t0 = performance.now();
    s.advance(dt);
    this.handleEvents();
    if (s.topologyDirty) this.handleTopology();
    if (!s.busy && this.residual) {
      const res = this.residual;
      this.residual = null;
      if (this.toreOut) {
        const radii = this.modeRadii(1.5 * res.R).filter((x) => x >= 1.5 * res.R);
        if (s.impulse(res.J, { u: res.u, v: res.v }, res.dir, radii)) this.stats.deformations++;
      }
    }
    this.colliderDirty = true;
    if (!s.busy && this.sim.liveWelds() === 0) this.checkRelease();
    this.stats.lastStepMs = performance.now() - t0;
  }

  private handleEvents(): void {
    const s = this.sim;
    const ev = s.drainEvents();
    if (!ev.length) return;
    this.pivot.updateMatrixWorld();
    const M = this.pivot.matrixWorld;
    let cracks = 0, weldsBroke = false;
    for (const e of ev) {
      _v.set(e.x, e.y, e.z).applyMatrix4(M);
      if (e.type === 'weld') {
        this.ctx.fx.sparks({ position: _v.clone(), direction: new THREE.Vector3(0, 1, 0), count: 6, speed: 6, hot: 0.4 });
        weldsBroke = true;
      } else if (e.type === 'fragment') {
        this.ctx.fx.chips({ position: _v.clone(), direction: new THREE.Vector3(0, 1, 0), spread: 1, speed: 6, count: 3, size: 0.02, color: 0x44474a, kind: 'metal' });
      } else if (e.type === 'crack' && cracks++ < 6) {
        this.ctx.fx.chips({ position: _v.clone(), direction: new THREE.Vector3(0, 1, 0), spread: 1, speed: 3, count: 1, size: 0.006, color: 0x6a6d70, kind: 'metal' });
      }
    }
    // Supports this plate gives (or gets) changed: let the structure graph re-check them.
    if (weldsBroke) this.ctx.structure.touch(this);
  }

  /** After tearing: pieces no weld holds break away as their own rigid plates; crumbs vanish. */
  private handleTopology(): void {
    const s = this.sim;
    if (s.busy) {
      this.rebuildTopology();
      return;
    }
    const comps = s.components();
    if (comps.length > 1 || (comps.length === 1 && !s.isWelded(comps[0]!))) {
      const welded = comps.filter((c) => s.isWelded(c));
      const keep = welded.length ? welded : [comps.reduce((a, b) => (a.length >= b.length ? a : b))];
      for (const c of comps) {
        if (keep.includes(c)) continue;
        let m = 0;
        for (const t of c) m += s.tMass[t]!;
        if (c.length < 4) {
          for (const t of c) s.deleteTriangle(t, true);
          continue;
        }
        const piece = s.extract(c);
        this.spawnPiece(piece, m);
        this.toreOut = true;
      }
    }
    this.rebuildTopology();
    this.ctx.structure.touch(this);
    this.checkRelease();
  }

  private spawnPiece(piece: PlateSim, mass: number): void {
    this.pivot.updateMatrixWorld();
    const pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3() };
    this.pivot.matrixWorld.decompose(pose.position, pose.quaternion, pose.scale);
    const p = new SteelPlate(this.ctx, { ...this.spec, name: `${this.name}-piece` }, { sim: piece, detail: this.detail, pose, released: true, linvel: this.lastImpulse.clone().multiplyScalar(0.3 / Math.max(mass, 1)) });
    this.ctx.addDestructible(p);
    const c = p.bounds.getCenter(new THREE.Vector3());
    this.ctx.events.emit('fracture', { time: this.ctx.time.now, position: c, volume: mass / this.params.rho, pieces: 1, material: this.material });
  }

  frameUpdate(dt: number): void {
    if (this.disposed) return;
    const s = this.sim;
    if (this.mode === 'rigid' && this.body) {
      const t = this.body.translation(), r = this.body.rotation();
      this.root.position.set(t.x, t.y, t.z);
      this.root.quaternion.set(r.x, r.y, r.z, r.w);
      this.root.updateMatrixWorld(true);
      this.updateBounds();
      if (t.y < -50) this.dispose();
    }
    if (s.topologyDirty && !s.busy) this.handleTopology();
    if (this.hot && dt > 0) {
      // Visible heat is integrated every frame; below VISIBLE_HEAT_C the sheet cools in 0.5 s steps
      // (explicit and stable far beyond that: its time constant is minutes) without touching the mesh.
      this.coolClock += dt;
      const visible = this.stats.hottest >= VISIBLE_HEAT_C;
      if (visible || this.coolClock >= 0.5) {
        const hottest = s.cool(this.coolClock, (T) => sheetHeatLoss(this.params, T), diffusivity(this.params));
        this.coolClock = 0;
        this.stats.hottest = hottest;
        if (hottest < AMBIENT_C + 1) this.hot = false;
        if (visible) this.heatDirty = true;
      }
    }
    if (s.geometryDirty) this.updateGeometry();
    else if (this.heatDirty) this.updateHeat();
    this.heatDirty = false;
    this.detail.upload();
    this.look.uniforms.uTime.value = this.ctx.time.now;
    if (this.colliderDirty && !s.busy && this.mode === 'fixed') {
      this.colliderClock += dt;
      if (this.colliderClock > 0.25) {
        this.buildStaticCollider();
        this.colliderDirty = false;
        this.colliderClock = 0;
      }
    }
  }

  // ─── physics bodies ─────────────────────────────────────────────────────────────────────────

  /** Fixed trimesh of the mid-surface so loose debris lands on (and slides off) the plate. */
  private buildStaticCollider(): void {
    const phys = this.ctx.physics;
    const s = this.sim;
    const tris: number[] = [];
    for (let t = 0; t < s.nt; t++) if (s.talive[t]) tris.push(s.tv[3 * t]!, s.tv[3 * t + 1]!, s.tv[3 * t + 2]!);
    if (!tris.length) return;
    const verts = new Float32Array(3 * s.n);
    for (let i = 0; i < 3 * s.n; i++) verts[i] = s.x[i]!;
    try {
      if (!this.body) {
        this.root.updateMatrixWorld(true);
        const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
        this.pivot.matrixWorld.decompose(p, q, sc);
        this.body = phys.createFixed(p, q, [], this.owner);
      }
      if (this.collider) phys.removeCollider(this.collider);
      this.collider = phys.attachCollider(this.body, phys.R.ColliderDesc.trimesh(verts, Uint32Array.from(tris)).setFriction(0.6), this.owner);
    } catch {
      this.collider = null;
    }
  }

  /** Freeze the shape and hand the plate to Rapier as a dynamic body (convex hull, true mass). */
  private toRigid(linvel?: THREE.Vector3): void {
    if (this.mode === 'rigid') return;
    const s = this.sim, phys = this.ctx.physics;
    s.flush();
    this.mode = 'rigid';
    this.failed = true;
    if (this.body) {
      phys.removeBody(this.body);
      this.body = null;
      this.collider = null;
    }
    // Centre of mass in plate-local space.
    const com = new THREE.Vector3();
    let m = 0;
    for (let i = 0; i < s.n; i++) {
      if (!s.palive[i]) continue;
      com.x += s.mass[i]! * s.x[3 * i]!;
      com.y += s.mass[i]! * s.x[3 * i + 1]!;
      com.z += s.mass[i]! * s.x[3 * i + 2]!;
      m += s.mass[i]!;
    }
    if (!(m > 0)) {
      this.dispose();
      return;
    }
    com.divideScalar(m);
    this.updateGeometry();
    const pts: number[] = [];
    const h = 0.5 * this.thickness;
    const N = this.vNormal;
    for (let i = 0; i < s.n; i++) {
      if (!s.palive[i]) continue;
      for (const sg of [1, -1]) {
        pts.push(s.x[3 * i]! - com.x + sg * h * N[3 * i]!, s.x[3 * i + 1]! - com.y + sg * h * N[3 * i + 1]!, s.x[3 * i + 2]! - com.z + sg * h * N[3 * i + 2]!);
      }
    }
    this.pivot.updateMatrixWorld(true);
    const wp = com.clone().applyMatrix4(this.pivot.matrixWorld);
    const wq = new THREE.Quaternion();
    this.pivot.getWorldQuaternion(wq);
    // Flat, collinear or tiny point sets (a torn sliver, particles in a line) would make Rapier's
    // hull degenerate: those get an oriented box (colliders.ts).
    const desc = safeHullDesc(phys.R, pts, Math.max(0.004, this.thickness)) ?? phys.R.ColliderDesc.cuboid(this.spec.width / 2, this.spec.height / 2, Math.max(h, 0.002));
    desc.setMass(m).setFriction(0.6).setRestitution(0.05);
    this.body = phys.createDynamic({
      position: wp, quaternion: wq, colliders: [desc], owner: this.owner, linvel, contactForceThreshold: 2e4,
      angvel: new THREE.Vector3((this.ctx.rng.next() - 0.5) * 0.4, (this.ctx.rng.next() - 0.5) * 0.4, (this.ctx.rng.next() - 0.5) * 0.4),
    });
    this.root.position.copy(wp);
    this.root.quaternion.copy(wq);
    this.pivot.position.copy(com).negate();
    this.pivot.quaternion.identity();
    this.root.updateMatrixWorld(true);
    this.updateBounds();
    if (this.lastImpulse.lengthSq() > 0) phys.applyImpulseAt(this.body, this.lastImpulse.clone().multiplyScalar(0.5), this.lastImpulsePoint);
    this.owner.onContactForce = (info) => {
      if (info.totalForce * info.dt < 50) return;
      this.ctx.events.emit('debrisContact', {
        time: this.ctx.time.now, position: info.point ?? this.bounds.getCenter(new THREE.Vector3()), impulse: info.totalForce * info.dt,
        size: Math.max(this.spec.width, this.spec.height), material: this.material,
      });
    };
    this.ctx.structure.remove(this);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.body) {
      try {
        this.ctx.physics.removeBody(this.body);
      } catch {
        // The world may already have been replaced (scene change).
      }
      this.body = null;
    }
    this.root.removeFromParent();
    this.geometry.dispose();
    this.look.material.dispose();
    this.look.depth.dispose();
    this.detail.release();
  }
}
