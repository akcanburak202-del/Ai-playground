import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { SimContext } from '../../app/contracts.ts';
import type { ContactForceInfo, PhysicsOwner } from '../../physics/PhysicsWorld.ts';
import type { MaterialProps } from '../../physics/materials.ts';
import { clipHalfPlane, convexHull, pointInPoly, polyArea, polyBounds, polyCentroid, simplifyConvex, type Poly } from './polygon.ts';
import { createReflectionMaterial, createTransmissionMaterial, type GlassUniforms } from './look.ts';
import { shardPieces, DICE_AREA } from './model.ts';
import { exhausted, spend } from './budget.ts';

/** Most rigid shards one pane keeps (rows of the transform texture). */
export const MAX_SHARDS = 160;
/** Most corners of a shard's collision outline (the drawn outline keeps all of its own). */
const HULL_CORNERS = 12;

export interface ShardInit {
  /** Outline and island holes in pane-local metres */
  outer: Poly;
  holes: Poly[];
  linvel: THREE.Vector3;
  angvel: THREE.Vector3;
  /** Seconds the piece has already been flying (spawned late): start from its ballistic position */
  age?: number;
}

interface Shard {
  index: number;
  body: RAPIER.RigidBody | null;
  /** Outline relative to the shard origin (its centroid), shard-local x/y = pane x/y at release */
  outer: Poly;
  /** Pane-local position of the shard origin (for uv mapping of pieces broken off later) */
  ox: number;
  oy: number;
  area: number;
  size: number;
  mass: number;
  alive: boolean;
  /** Velocity at the end of the previous step (pre-impact velocity for contact events) */
  v: THREE.Vector3;
  sleepFor: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  generation: number;
}

interface PendingBreak {
  shard: Shard;
  vn: number;
  point: THREE.Vector3 | null;
  impulse: number;
}

export interface ShardEvents {
  /** Spawn dice for a tiny piece (world outline centre, area, velocity) */
  dice(position: THREE.Vector3, area: number, velocity: THREE.Vector3): void;
  /** A shard burst on landing */
  shatter(position: THREE.Vector3, area: number): void;
  /** A shard struck the floor (sound / glitter) */
  contact(position: THREE.Vector3, impulse: number, size: number): void;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _r = new THREE.Vector3();

/**
 * Loose pieces of an annealed pane: thin convex rigid bodies (Rapier convex hull of the extruded
 * outline; density scaled so the mass is that of the true, possibly concave, piece), drawn as one
 * merged geometry per pass whose vertices are moved by a per-shard matrix from a float texture.
 * Hard landings break shards again (Griffith energy balance, see model.shardPieces); pieces too
 * small to be worth a body become dice. Sleeping shards give their body back and stay where they lie.
 */
export class Shards {
  readonly group = new THREE.Group();
  count = 0;
  private readonly ctx: SimContext;
  private readonly material: MaterialProps;
  private readonly t: number;
  private readonly W: number;
  private readonly H: number;
  private readonly events: ShardEvents;
  private readonly rnd: () => number;
  private shards: Shard[] = [];
  private pending: PendingBreak[] = [];
  private geometry: THREE.BufferGeometry;
  private cap = 0;
  private used = 0;
  private iUsed = 0;
  private pos!: Float32Array;
  private nrm!: Float32Array;
  private uv!: Float32Array;
  private rim!: Float32Array;
  private sid!: Float32Array;
  private index!: Uint32Array;
  private readonly texData = new Float32Array(4 * 4 * MAX_SHARDS);
  private readonly tex: THREE.DataTexture;
  private readonly texUniform: THREE.IUniform<THREE.Texture | null>;
  private readonly matT: THREE.ShaderMaterial;
  private readonly matR: THREE.MeshPhysicalMaterial;
  private readonly meshT: THREE.Mesh;
  private readonly meshR: THREE.Mesh;
  private texDirty = false;

  constructor(ctx: SimContext, uniforms: GlassUniforms, material: MaterialProps, thickness: number, W: number, H: number, events: ShardEvents, rnd: () => number) {
    this.ctx = ctx;
    this.material = material;
    this.t = thickness;
    this.W = W;
    this.H = H;
    this.events = events;
    this.rnd = rnd;
    this.tex = new THREE.DataTexture(this.texData, 4, MAX_SHARDS, THREE.RGBAFormat, THREE.FloatType);
    this.tex.magFilter = this.tex.minFilter = THREE.NearestFilter;
    this.tex.needsUpdate = true;
    this.texUniform = { value: this.tex };
    this.matT = createTransmissionMaterial(uniforms, { shards: true, shardTex: this.texUniform });
    this.matR = createReflectionMaterial(uniforms, { shards: true, shardTex: this.texUniform });
    this.geometry = new THREE.BufferGeometry();
    this.allocate(4096, 12288);
    this.meshT = new THREE.Mesh(this.geometry, this.matT);
    this.meshR = new THREE.Mesh(this.geometry, this.matR);
    for (const m of [this.meshT, this.meshR]) {
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = m === this.meshR;
      m.name = 'glass-shards';
      this.group.add(m);
    }
    this.group.name = 'glass-shards';
  }

  private allocate(verts: number, indices: number): void {
    const old = this.cap > 0 ? { pos: this.pos, nrm: this.nrm, uv: this.uv, rim: this.rim, sid: this.sid, index: this.index } : null;
    this.cap = verts;
    this.pos = new Float32Array(3 * verts);
    this.nrm = new Float32Array(3 * verts);
    this.uv = new Float32Array(2 * verts);
    this.rim = new Float32Array(verts);
    this.sid = new Float32Array(verts);
    this.index = new Uint32Array(indices);
    if (old) {
      this.pos.set(old.pos);
      this.nrm.set(old.nrm);
      this.uv.set(old.uv);
      this.rim.set(old.rim);
      this.sid.set(old.sid);
      this.index.set(old.index);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    g.setAttribute('aRim', new THREE.BufferAttribute(this.rim, 1));
    g.setAttribute('aShard', new THREE.BufferAttribute(this.sid, 1));
    g.setIndex(new THREE.BufferAttribute(this.index, 1));
    g.setDrawRange(0, this.iUsed);
    if (this.geometry) {
      this.geometry.dispose();
      if (this.meshT) this.meshT.geometry = g;
      if (this.meshR) this.meshR.geometry = g;
    }
    this.geometry = g;
  }

  /** The reflection-pass material (for the reflection probe). */
  get reflectionMaterial(): THREE.MeshPhysicalMaterial {
    return this.matR;
  }

  get full(): boolean {
    return this.count >= MAX_SHARDS;
  }

  /** Live rigid shards. */
  get live(): number {
    let n = 0;
    for (const s of this.shards) if (s.alive && s.body) n++;
    return n;
  }

  /**
   * Release a piece of the pane as a rigid shard. `paneMatrix` is the pane's world matrix; the shard
   * starts where the piece was, with the given velocities. Returns false when the budget is spent.
   */
  add(init: ShardInit, paneMatrix: THREE.Matrix4, generation = 0, uvOrigin?: [number, number]): boolean {
    if (this.count >= MAX_SHARDS) return false;
    const area = polyArea(init.outer) + init.holes.reduce((s, h) => s + polyArea(h), 0);
    if (!(area > 0)) return false;
    const c = polyCentroid(init.outer);
    const outer = init.outer.map((v, i) => v - c[i & 1]!);
    const holes = init.holes.map((h) => h.map((v, i) => v - c[i & 1]!));
    const ox = (uvOrigin?.[0] ?? 0) + c[0], oy = (uvOrigin?.[1] ?? 0) + c[1];
    const b = polyBounds(outer);
    const size = Math.max(b[2] - b[0], b[3] - b[1]);
    const index = this.count++;
    this.buildGeometry(index, outer, holes, ox, oy);
    const mass = this.material.density * this.t * area;
    const pos = new THREE.Vector3(c[0], c[1], 0).applyMatrix4(paneMatrix);
    const quat = new THREE.Quaternion().setFromRotationMatrix(_m.extractRotation(paneMatrix));
    const age = init.age ?? 0;
    if (age > 0) {
      // Drag-free flight over the delay (a few steps at most): x += v t + ½ g t², v += g t.
      pos.addScaledVector(init.linvel, age);
      pos.y -= 0.5 * 9.80665 * age * age;
      init.linvel.y -= 9.80665 * age;
    }
    const shard: Shard = {
      index, body: null, outer, ox, oy, area, size, mass, alive: true, v: init.linvel.clone(), sleepFor: 0,
      pos, quat, generation,
    };
    shard.body = this.createBody(shard, outer, init.linvel, init.angvel);
    this.shards.push(shard);
    this.writeMatrix(shard);
    return true;
  }

  private createBody(s: Shard, outer: Poly, linvel: THREE.Vector3, angvel: THREE.Vector3): RAPIER.RigidBody | null {
    const phys = this.ctx.physics;
    const R = phys.R;
    // The collider is the hull of the extruded outline: hull the 2D outline first (cheap) and keep
    // at most HULL_CORNERS well separated corners, so Rapier's quickhull sees a small, clean input
    // (one crack-traced shard of dozens of nearly collinear corners once took it seconds).
    const b0 = polyBounds(outer);
    const hull = simplifyConvex(convexHull(outer), Math.max(0.0015, 0.02 * Math.max(b0[2] - b0[0], b0[3] - b0[1])), HULL_CORNERS);
    const n = hull.length >> 1;
    const pts = new Float32Array(6 * n);
    const h = 0.5 * this.t;
    for (let i = 0; i < n; i++) {
      const x = hull[2 * i]!, y = hull[2 * i + 1]!;
      pts[6 * i] = x; pts[6 * i + 1] = y; pts[6 * i + 2] = h;
      pts[6 * i + 3] = x; pts[6 * i + 4] = y; pts[6 * i + 5] = -h;
    }
    // Hull area ≥ piece area: scale the density so the body has the piece's true mass.
    const hullA = Math.max(polyArea(hull), s.area);
    let desc = n >= 3 ? R.ColliderDesc.convexHull(pts) : null;
    if (!desc) {
      const b = polyBounds(outer);
      desc = R.ColliderDesc.cuboid(Math.max(0.5 * (b[2] - b[0]), h), Math.max(0.5 * (b[3] - b[1]), h), h);
    }
    desc.setDensity(this.material.density * (s.area / hullA)).setFriction(0.55).setRestitution(0.15);
    const owner: PhysicsOwner = {
      kind: 'glass-shard',
      material: this.material,
      onContactForce: (info) => this.onContact(s, info),
    };
    const speed = linvel.length();
    try {
      return phys.createDynamic({
        position: s.pos, quaternion: s.quat, colliders: [desc], owner, linvel, angvel,
        ccd: speed > 6, contactForceThreshold: Math.max(5, s.mass * 30), linearDamping: 0.05, angularDamping: 0.15,
      });
    } catch {
      return null;
    }
  }

  private onContact(s: Shard, info: ContactForceInfo): void {
    if (!s.alive) return;
    // Normal speed of the strike from the pre-step velocity along the contact force direction.
    const vn = Math.abs(s.v.dot(info.direction));
    this.pending.push({ shard: s, vn, point: info.point ? info.point.clone() : null, impulse: info.totalForce * info.dt });
  }

  /** Triangulate a piece: front and back faces plus rim quads along every outline. */
  private buildGeometry(index: number, outer: Poly, holes: Poly[], ox: number, oy: number): void {
    const contour = toV2(outer);
    const hv = holes.map(toV2);
    const tris = THREE.ShapeUtils.triangulateShape(contour, hv);
    const all = contour.concat(...hv);
    const rings = [outer, ...holes];
    let rimVerts = 0;
    for (const r of rings) rimVerts += 4 * (r.length >> 1);
    const nv = 2 * all.length + rimVerts;
    const ni = 6 * tris.length + 1.5 * rimVerts;
    if (this.used + nv > this.cap || this.iUsed + ni > this.index.length) {
      this.allocate(Math.max(2 * this.cap, this.used + nv + 1024), Math.max(2 * this.index.length, this.iUsed + ni + 3072));
    }
    const h = 0.5 * this.t;
    const base = this.used;
    const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number, rim: number) => {
      const k = this.used++;
      this.pos[3 * k] = x; this.pos[3 * k + 1] = y; this.pos[3 * k + 2] = z;
      this.nrm[3 * k] = nx; this.nrm[3 * k + 1] = ny; this.nrm[3 * k + 2] = nz;
      this.uv[2 * k] = (x + ox + this.W / 2) / this.W;
      this.uv[2 * k + 1] = (y + oy + this.H / 2) / this.H;
      this.rim[k] = rim;
      this.sid[k] = index;
      return k;
    };
    for (const p of all) put(p.x, p.y, h, 0, 0, 1, 0);
    for (const p of all) put(p.x, p.y, -h, 0, 0, -1, 0);
    const nAll = all.length;
    for (const [a, b, c] of tris) {
      const ccw = (all[b]!.x - all[a]!.x) * (all[c]!.y - all[a]!.y) - (all[b]!.y - all[a]!.y) * (all[c]!.x - all[a]!.x) > 0;
      const [p, q, r] = ccw ? [a, b, c] : [a, c, b];
      this.index.set([base + p!, base + q!, base + r!], this.iUsed);
      this.index.set([base + nAll + p!, base + nAll + r!, base + nAll + q!], this.iUsed + 3);
      this.iUsed += 6;
    }
    for (const ring of rings) {
      const n = ring.length >> 1;
      for (let i = 0; i < n; i++) {
        const x0 = ring[2 * i]!, y0 = ring[2 * i + 1]!, x1 = ring[2 * ((i + 1) % n)]!, y1 = ring[2 * ((i + 1) % n) + 1]!;
        const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1;
        const nx = dy / l, ny = -dx / l;
        const a = put(x0, y0, h, nx, ny, 0, 1), b = put(x1, y1, h, nx, ny, 0, 1), c = put(x1, y1, -h, nx, ny, 0, 1), d = put(x0, y0, -h, nx, ny, 0, 1);
        this.index.set([a, d, c, a, c, b], this.iUsed);
        this.iUsed += 6;
      }
    }
    const g = this.geometry;
    for (const name of ['position', 'normal', 'uv', 'aRim', 'aShard']) {
      const at = g.getAttribute(name) as THREE.BufferAttribute;
      at.addUpdateRange(base * at.itemSize, (this.used - base) * at.itemSize);
      at.needsUpdate = true;
    }
    const idx = g.getIndex()!;
    idx.needsUpdate = true;
    g.setDrawRange(0, this.iUsed);
  }

  private writeMatrix(s: Shard): void {
    const o = 16 * s.index;
    if (!s.alive) {
      this.texData.fill(0, o, o + 16);
    } else {
      _m.compose(s.pos, s.quat, _one);
      const e = _m.elements;
      // Rows of the 3×4 affine matrix (column-major elements → row r = e[r], e[4+r], e[8+r], e[12+r]).
      for (let r = 0; r < 3; r++) {
        this.texData[o + 4 * r] = e[r]!;
        this.texData[o + 4 * r + 1] = e[4 + r]!;
        this.texData[o + 4 * r + 2] = e[8 + r]!;
        this.texData[o + 4 * r + 3] = e[12 + r]!;
      }
    }
    this.texDirty = true;
  }

  /** After the physics step: resolve pending breaks, record velocities, retire sleeping bodies. */
  fixedUpdate(dt: number): void {
    if (this.pending.length) {
      // Within the scene's glass budget (at least two per step); the rest break a step later.
      const list = this.pending;
      this.pending = [];
      const done = new Set<Shard>();
      let k = 0;
      for (; k < list.length; k++) {
        const p = list[k]!;
        if (done.has(p.shard) || !p.shard.alive) continue;
        if (done.size >= 2 && exhausted(this.ctx)) break;
        done.add(p.shard);
        const t0 = performance.now();
        if (p.vn > 0.8) this.events.contact(p.point ?? p.shard.pos, p.impulse, p.shard.size);
        this.tryBreak(p);
        spend(this.ctx, performance.now() - t0);
      }
      for (; k < list.length; k++) this.pending.push(list[k]!);
    }
    const phys = this.ctx.physics;
    for (const s of this.shards) {
      const b = s.body;
      if (!s.alive || !b) continue;
      if (!b.isValid()) {
        s.body = null;
        continue;
      }
      const v = b.linvel();
      s.v.set(v.x, v.y, v.z);
      const moving = s.v.lengthSq() > 1e-4;
      s.sleepFor = b.isSleeping() || !moving ? s.sleepFor + dt : 0;
      if (s.sleepFor > 1.5 || !b.isDynamic()) {
        this.readPose(s);
        this.writeMatrix(s);
        if (b.isDynamic()) phys.removeBody(b);
        s.body = null;
      }
    }
  }

  private readPose(s: Shard): void {
    const b = s.body;
    if (!b) return;
    const t = b.translation(), r = b.rotation();
    s.pos.set(t.x, t.y, t.z);
    s.quat.set(r.x, r.y, r.z, r.w);
  }

  /** Copy body poses into the transform texture (per rendered frame). */
  frameUpdate(): void {
    for (const s of this.shards) {
      if (!s.alive || !s.body || !s.body.isValid()) continue;
      if (s.body.isSleeping()) continue;
      this.readPose(s);
      this.writeMatrix(s);
    }
    if (this.texDirty) {
      this.tex.needsUpdate = true;
      this.texDirty = false;
    }
  }

  /** Burst a shard that struck hard: Voronoi split of its outline around the contact point. */
  private tryBreak(p: PendingBreak): void {
    const s = p.shard;
    const pieces = shardPieces(s.mass, p.vn, s.size, this.t);
    if (pieces < 2 || s.generation >= 3) return;
    const b = s.body;
    if (!b || !b.isValid()) return;
    this.readPose(s);
    const inv = _m.compose(s.pos, s.quat, _one).invert();
    const cp = (p.point ?? s.pos).clone().applyMatrix4(inv);
    const lin = b.linvel(), ang = b.angvel();
    const v0 = new THREE.Vector3(lin.x, lin.y, lin.z), w0 = new THREE.Vector3(ang.x, ang.y, ang.z);
    // Seeds: the strike point and random points inside the outline.
    const seeds: number[] = [Math.max(-s.size, Math.min(s.size, cp.x)), Math.max(-s.size, Math.min(s.size, cp.y))];
    const bb = polyBounds(s.outer);
    for (let k = 0, tries = 0; k < pieces - 1 && tries < 60; tries++) {
      const x = bb[0] + this.rnd() * (bb[2] - bb[0]), y = bb[1] + this.rnd() * (bb[3] - bb[1]);
      if (!pointInPoly(s.outer, x, y)) continue;
      seeds.push(x, y);
      k++;
    }
    const cells: Poly[] = [];
    const n = seeds.length >> 1;
    for (let i = 0; i < n; i++) {
      let cell: Poly = s.outer.slice();
      const xi = seeds[2 * i]!, yi = seeds[2 * i + 1]!;
      for (let j = 0; j < n && cell.length >= 6; j++) {
        if (j === i) continue;
        const xj = seeds[2 * j]!, yj = seeds[2 * j + 1]!;
        // Keep the side of the bisector nearer seed i: (xj − xi)·p ≤ (|xj|² − |xi|²)/2.
        const nx = xj - xi, ny = yj - yi;
        cell = clipHalfPlane(cell, nx, ny, 0.5 * (xj * xj + yj * yj - xi * xi - yi * yi));
      }
      if (cell.length >= 6 && polyArea(cell) > 1e-7) cells.push(cell);
    }
    if (cells.length < 2) return;
    // Retire the parent.
    s.alive = false;
    this.writeMatrix(s);
    this.ctx.physics.removeBody(b);
    s.body = null;
    const paneLike = _m.compose(s.pos, s.quat, _one).clone();
    for (const cell of cells) {
      const c = polyCentroid(cell);
      const area = polyArea(cell);
      _r.set(c[0], c[1], 0).applyQuaternion(s.quat);
      const v = new THREE.Vector3().crossVectors(w0, _r).add(v0);
      // Pieces fly apart: a fraction of the strike speed, mostly upward and away from the strike.
      _v.set(c[0] - cp.x, c[1] - cp.y, 0).applyQuaternion(s.quat);
      if (_v.lengthSq() > 1e-10) _v.normalize();
      v.addScaledVector(_v, (0.15 + 0.25 * this.rnd()) * p.vn).add(_w.set(0, (0.1 + 0.25 * this.rnd()) * p.vn, 0));
      const wp = new THREE.Vector3(c[0], c[1], 0).applyMatrix4(paneLike);
      if (area < DICE_AREA || this.count >= MAX_SHARDS) {
        this.events.dice(wp, area, v);
        continue;
      }
      const w = new THREE.Vector3((this.rnd() - 0.5) * 8, (this.rnd() - 0.5) * 8, (this.rnd() - 0.5) * 8).add(w0);
      this.add({ outer: cell, holes: [], linvel: v, angvel: w }, paneLike, s.generation + 1, [s.ox, s.oy]);
    }
    this.events.shatter(s.pos, s.area);
  }

  dispose(): void {
    const phys = this.ctx.physics;
    for (const s of this.shards) {
      if (s.body && s.body.isValid()) {
        try {
          phys.removeBody(s.body);
        } catch {
          /* world already replaced */
        }
      }
      s.body = null;
    }
    this.shards.length = 0;
    this.group.removeFromParent();
    this.geometry.dispose();
    this.matT.dispose();
    this.matR.dispose();
    this.tex.dispose();
  }
}

function toV2(p: Poly): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < p.length; i += 2) out.push(new THREE.Vector2(p[i]!, p[i + 1]!));
  return out;
}
