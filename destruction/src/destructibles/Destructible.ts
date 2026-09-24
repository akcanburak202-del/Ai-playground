import * as THREE from 'three';
import type { MaterialProps } from '../physics/materials.ts';
import type { BlastLoad, ImpactEvent, ThicknessProbe } from '../physics/ballistics/types.ts';

/** Result of a detailed ray test against one destructible. */
export interface RayHit {
  target: Destructible;
  /** World-space entry point */
  point: THREE.Vector3;
  /** Outward world-space surface normal at the entry point */
  normal: THREE.Vector3;
  /** Distance from the ray origin, m */
  distance: number;
  /** Material at the entry point */
  material: MaterialProps;
  /** Optional sub-part (rebar bar index, beam node, glass shard …) */
  part?: number;
}

export type DestructibleKind = 'voxel' | 'plate' | 'beam' | 'glass' | 'terrain' | 'rebar';

/**
 * A structural participant: something that can hold other elements up, and/or be held up.
 * Implemented by structural elements (walls, columns, slabs, beams, panes) and consumed by the
 * StructureGraph, which propagates support loss and gravity loads.
 */
export interface Structural {
  /** Own weight, N (current, after material loss) */
  weight(): number;
  /**
   * Register a support region: material of this element inside `regionWorld` is held fixed by
   * whatever is behind `anchorId` (the ground, a column head, a wall top) until it is released.
   */
  addAnchor(anchorId: string, regionWorld: THREE.Box3): void;
  /**
   * How much of this element is still present and in place inside a world-space region, 0..1.
   * The graph asks a supporter this about each contact region it provides.
   */
  supportPresence(regionWorld: THREE.Box3): number;
  /** The supporter behind anchor `anchorId` is gone; stop treating that region as fixed. */
  releaseAnchor(anchorId: string): void;
  /** Axial / gravity load arriving from supported elements, N. Used for crushing & buckling checks. */
  setImposedLoad(newtons: number): void;
  /** True once the element has failed completely (fell, crushed, detached) */
  hasFailed(): boolean;
}

/**
 * Everything a projectile or a blast can hurt implements this. Implementations own their meshes
 * (added under `root`) and any physics bodies they need.
 */
export interface Destructible {
  readonly id: number;
  readonly kind: DestructibleKind;
  readonly name: string;
  /** Scene-graph root for all of this destructible's visuals */
  readonly root: THREE.Object3D;
  /** Conservative world-space AABB; implementations keep it current as they move or deform */
  readonly bounds: THREE.Box3;
  /** Set when the object no longer exists; the registry drops it on the next sweep */
  readonly disposed: boolean;
  /** Present when this element participates in the structural graph */
  readonly structural?: Structural;

  /**
   * Detailed ray test in world space. `dir` is normalised. Return the nearest entry within maxDist.
   * `radius` is the projectile's radius (0 / omitted for a thin ray): a hole or gap narrower than
   * it counts as solid, so a round cannot slip through a hole smaller than itself.
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, radius?: number): RayHit | null;

  /**
   * Walk the shot line from the entry point and report the first contiguous run of solid material
   * (see ThicknessProbe). Must be cheap: called for every bullet that hits.
   */
  probe(hit: RayHit, dir: THREE.Vector3, maxDepth: number): ThicknessProbe;

  /** Realise a resolved impact: remove/deform material, spawn debris, emit events. */
  applyImpact(impact: ImpactEvent): void;

  /** Realise a blast load that reached this object. Called once per blast when the shock front arrives. */
  applyBlast(load: BlastLoad): void;

  /** Fixed-rate simulation step (PBD, fracture bookkeeping). Optional. */
  fixedUpdate?(dt: number): void;

  /** Per-rendered-frame work (mesh rebuilds, transform sync). Optional. */
  frameUpdate?(dt: number): void;

  dispose(): void;
}

let nextId = 1;
export function allocateDestructibleId(): number {
  return nextId++;
}

const _inv = new THREE.Vector3();

/**
 * Slab test of a ray against an AABB. Returns the entry distance (0 if the origin is inside) or
 * Infinity when it misses within maxDist.
 */
export function rayBoxEntry(box: THREE.Box3, origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number {
  _inv.set(1 / dir.x, 1 / dir.y, 1 / dir.z);
  let tmin = 0;
  let tmax = maxDist;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? origin.x : a === 1 ? origin.y : origin.z;
    const inv = a === 0 ? _inv.x : a === 1 ? _inv.y : _inv.z;
    const lo = a === 0 ? box.min.x : a === 1 ? box.min.y : box.min.z;
    const hi = a === 0 ? box.max.x : a === 1 ? box.max.y : box.max.z;
    let t0 = (lo - o) * inv;
    let t1 = (hi - o) * inv;
    if (t0 > t1) {
      const t = t0;
      t0 = t1;
      t1 = t;
    }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmax < tmin) return Infinity;
  }
  return tmin;
}
