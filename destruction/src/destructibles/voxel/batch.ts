import * as THREE from 'three';

/**
 * Rubble batching. Every loose piece of one element family (an element and the debris cut from
 * it) draws through a few shared THREE.BatchedMesh objects instead of owning its meshes: concrete
 * of pieces large enough to cast a visible shadow, concrete of small pieces (no shadow), and
 * rebar. One batch is one multi-draw per render pass, so a roof collapse into a few hundred
 * pieces costs a handful of draw calls per pass instead of two meshes per piece in the colour,
 * depth and shadow passes (measured before: ~1 400 calls for 200 pieces of the pavilion roof).
 *
 * Pieces keep their geometry in their own (the family's) local frame, so the object-space
 * surface shader textures them exactly as before; the batch carries each piece's rigid transform
 * as its instance matrix. Clients mark themselves dirty and push their pending geometry and
 * transform in their frameUpdate (never while rendering: a batch that grows replaces its
 * geometry, which the renderer may already have bound for the pass).
 */

/** A piece that owns instances in the family's batches. */
export interface BatchClient {
  /** Push pending geometry and transform into the batches. */
  flushBatch(): void;
}

/** One geometry + one instance in a batch. */
export interface BatchSlot {
  geometryId: number;
  instanceId: number;
  /** Reserved vertex / index space */
  rv: number;
  ri: number;
}

const _sphere = new THREE.Sphere();

/** Bounding sphere of `count` xyz positions (box centre, max distance) — for per-piece culling. */
function sphereOf(pos: ArrayLike<number>, count: number, out: THREE.Sphere): THREE.Sphere {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < count * 3; i += 3) {
    const x = pos[i]!, y = pos[i + 1]!, z = pos[i + 2]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  let r2 = 0;
  for (let i = 0; i < count * 3; i += 3) {
    const dx = pos[i]! - cx, dy = pos[i + 1]! - cy, dz = pos[i + 2]! - cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2) r2 = d;
  }
  out.center.set(cx, cy, cz);
  out.radius = Math.sqrt(r2);
  return out;
}

/** A BatchedMesh that grows (and repacks) on demand. */
export class GrowingBatch {
  readonly mesh: THREE.BatchedMesh;
  private capV: number;
  private capI: number;
  /** Space held by deleted geometries (reclaimed by optimize()) */
  private freeV = 0;
  private freeI = 0;
  private readonly scratch = new THREE.BufferGeometry();

  constructor(material: THREE.Material, name: string, castShadow: boolean, instances = 64, vertices = 1 << 15, indices = 3 << 15) {
    this.capV = vertices;
    this.capI = indices;
    this.mesh = new THREE.BatchedMesh(instances, vertices, indices, material);
    this.mesh.name = name;
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = true;
    // Instances move every step: the batch's own bounds would be stale. Each piece is culled
    // against the view (and the shadow cameras) through its own sphere instead.
    this.mesh.frustumCulled = false;
    this.mesh.perObjectFrustumCulled = true;
  }

  get count(): number {
    return this.mesh.instanceCount;
  }

  /**
   * Add a geometry given as attributes (all batches of a kind carry the same attribute set) and
   * one instance of it with `matrix`. Reserves a little slack so later remeshes fit in place.
   */
  add(attrs: Record<string, THREE.BufferAttribute>, index: THREE.BufferAttribute, matrix: THREE.Matrix4): BatchSlot {
    const g = this.fill(attrs, index);
    const v = attrs.position!.count, i = index.count;
    const rv = Math.ceil(v * 1.25) + 16, ri = Math.ceil(i * 1.25) + 48;
    this.ensure(rv, ri);
    const geometryId = this.mesh.addGeometry(g, rv, ri);
    const instanceId = this.mesh.addInstance(geometryId);
    this.mesh.setMatrixAt(instanceId, matrix);
    return { geometryId, instanceId, rv, ri };
  }

  /** Replace a slot's geometry; returns the (possibly new) slot. */
  update(slot: BatchSlot, attrs: Record<string, THREE.BufferAttribute>, index: THREE.BufferAttribute, matrix: THREE.Matrix4): BatchSlot {
    if (attrs.position!.count <= slot.rv && index.count <= slot.ri) {
      this.mesh.setGeometryAt(slot.geometryId, this.fill(attrs, index));
      return slot;
    }
    this.remove(slot);
    return this.add(attrs, index, matrix);
  }

  remove(slot: BatchSlot): void {
    // Deleting the geometry deletes its instance too.
    this.mesh.deleteGeometry(slot.geometryId);
    this.freeV += slot.rv;
    this.freeI += slot.ri;
  }

  setMatrix(slot: BatchSlot, m: THREE.Matrix4): void {
    this.mesh.setMatrixAt(slot.instanceId, m);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.scratch.dispose();
  }

  private fill(attrs: Record<string, THREE.BufferAttribute>, index: THREE.BufferAttribute): THREE.BufferGeometry {
    const g = this.scratch;
    for (const k in attrs) g.setAttribute(k, attrs[k]!);
    g.setIndex(index);
    g.boundingSphere = sphereOf(attrs.position!.array, attrs.position!.count, _sphere);
    return g;
  }

  /** Make room for rv vertices / ri indices and one more instance. */
  private ensure(rv: number, ri: number): void {
    const m = this.mesh;
    if (m.instanceCount >= m.maxInstanceCount) m.setInstanceCount(m.maxInstanceCount * 2);
    if (m.unusedVertexCount >= rv && m.unusedIndexCount >= ri) return;
    // Repack only when it wins back a good share of the batch: optimize() copies every geometry
    // (O(batch)), and doing it for each new piece whose slot outgrew its proxy made a frame that
    // swapped 30 wall slabs from proxy to mesh quadratic in the batch size. Growing doubles.
    if (this.freeV >= this.capV / 4 || this.freeI >= this.capI / 4) {
      m.optimize();
      this.freeV = this.freeI = 0;
      if (m.unusedVertexCount >= rv && m.unusedIndexCount >= ri) return;
    }
    const usedV = this.capV - m.unusedVertexCount, usedI = this.capI - m.unusedIndexCount;
    this.capV = Math.max(this.capV * 2, usedV + rv * 2);
    this.capI = Math.max(this.capI * 2, usedI + ri * 2);
    m.setGeometrySize(this.capV, this.capI);
  }
}

/**
 * The batches of one element family: concrete with and without shadows, and rebar. Created on
 * first use, added to the scene next to the pieces, disposed with the family.
 */
export class FamilyBatches {
  private readonly dirty = new Set<BatchClient>();
  private parent: THREE.Object3D | null = null;
  private solidShadow: GrowingBatch | null = null;
  private solidFlat: GrowingBatch | null = null;
  private bars: GrowingBatch | null = null;
  private readonly solidMaterial: () => THREE.Material;
  private readonly barMaterial: () => THREE.Material;
  private readonly name: string;
  private flushing = false;

  constructor(name: string, solidMaterial: () => THREE.Material, barMaterial: () => THREE.Material) {
    this.name = name;
    this.solidMaterial = solidMaterial;
    this.barMaterial = barMaterial;
  }

  /** A client has pending geometry or a new transform. */
  markDirty(c: BatchClient): void {
    this.dirty.add(c);
  }

  forget(c: BatchClient): void {
    this.dirty.delete(c);
  }

  /** Push one client's pending work if it has any (its frameUpdate). */
  flushClient(c: BatchClient): void {
    if (this.dirty.delete(c)) c.flushBatch();
  }

  /** Flush every pending client now (tests, screenshots). */
  flush(): void {
    if (this.flushing || this.dirty.size === 0) return;
    this.flushing = true;
    try {
      for (const c of this.dirty) c.flushBatch();
      this.dirty.clear();
    } finally {
      this.flushing = false;
    }
  }

  /** The concrete batch for pieces with / without shadows, created (and parented) on demand. */
  solid(shadow: boolean, parent: THREE.Object3D): GrowingBatch {
    const make = () => this.attach(new GrowingBatch(this.solidMaterial(), `${this.name}:rubble${shadow ? '' : '-small'}`, shadow), parent);
    return shadow ? (this.solidShadow ??= make()) : (this.solidFlat ??= make());
  }

  rebar(parent: THREE.Object3D): GrowingBatch {
    // Bars in debris are too thin for their shadows to matter.
    return (this.bars ??= this.attach(new GrowingBatch(this.barMaterial(), `${this.name}:rubble-rebar`, false, 32, 1 << 14, 3 << 14), parent));
  }

  /** Instances across the batches (diagnostics). */
  get instances(): number {
    return (this.solidShadow?.count ?? 0) + (this.solidFlat?.count ?? 0) + (this.bars?.count ?? 0);
  }

  dispose(): void {
    this.solidShadow?.dispose();
    this.solidFlat?.dispose();
    this.bars?.dispose();
    this.solidShadow = this.solidFlat = this.bars = null;
    this.dirty.clear();
    this.parent = null;
  }

  private attach(b: GrowingBatch, parent: THREE.Object3D): GrowingBatch {
    this.parent ??= parent;
    this.parent.add(b.mesh);
    return b;
  }
}
