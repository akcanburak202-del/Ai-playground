import * as THREE from 'three';
import { rayBoxEntry, type Destructible, type RayHit } from './Destructible.ts';

/**
 * Holds every live destructible and answers spatial queries for projectiles and blasts.
 * A flat list with AABB culling is enough for the few hundred objects a scene holds.
 */
export class DestructibleRegistry {
  private items: Destructible[] = [];
  private byId = new Map<number, Destructible>();
  private scratch = new THREE.Box3();

  add(d: Destructible): void {
    if (this.byId.has(d.id)) return;
    this.items.push(d);
    this.byId.set(d.id, d);
  }

  remove(d: Destructible): void {
    if (!this.byId.delete(d.id)) return;
    const i = this.items.indexOf(d);
    if (i >= 0) this.items.splice(i, 1);
  }

  get(id: number): Destructible | undefined {
    return this.byId.get(id);
  }

  all(): readonly Destructible[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  /**
   * Nearest hit along a ray (dir must be normalised). `ignore` skips one object (e.g. the one just
   * exited); `radius` is the projectile radius passed on to each destructible (see Destructible.raycast).
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, ignore?: Destructible, radius?: number): RayHit | null {
    let best: RayHit | null = null;
    let bestDist = maxDist;
    const grow = radius && radius > 0 ? radius : 0;
    for (const d of this.items) {
      if (d.disposed || d === ignore) continue;
      // A fat round can clip an object whose box its centre line misses.
      let box = d.bounds;
      if (grow > 0) box = this.scratch.copy(d.bounds).expandByScalar(grow);
      const entry = rayBoxEntry(box, origin, dir, bestDist);
      if (entry === Infinity || entry > bestDist) continue;
      const hit = d.raycast(origin, dir, bestDist, radius);
      if (hit && hit.distance <= bestDist) {
        best = hit;
        bestDist = hit.distance;
      }
    }
    return best;
  }

  /** All destructibles whose AABB intersects the sphere. */
  querySphere(center: THREE.Vector3, radius: number, out: Destructible[] = []): Destructible[] {
    const s = new THREE.Sphere(center, radius);
    for (const d of this.items) {
      if (!d.disposed && d.bounds.intersectsSphere(s)) out.push(d);
    }
    return out;
  }

  queryBox(box: THREE.Box3, out: Destructible[] = []): Destructible[] {
    for (const d of this.items) {
      if (!d.disposed && d.bounds.intersectsBox(box)) out.push(d);
    }
    return out;
  }

  /** Drop disposed entries. Called once per frame by the simulation. */
  sweep(): void {
    if (!this.items.some((d) => d.disposed)) return;
    this.items = this.items.filter((d) => {
      if (d.disposed) this.byId.delete(d.id);
      return !d.disposed;
    });
  }
}
