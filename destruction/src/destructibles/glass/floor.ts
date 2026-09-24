import * as THREE from 'three';
import { groups, GROUP_STATIC, type PhysicsWorld } from '../../physics/PhysicsWorld.ts';

const STATIC_ONLY = groups(0xffff, GROUP_STATIC);
const _o = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Height of the static floor under a point (ground slab, terrain, a podium, a window sill), from a
 * downward Rapier ray against static colliders only, cached on a 0.2 m grid. Dice and fallen glass
 * rest on it; without anything below, the ground plane y = 0.
 */
export class FloorProbe {
  private readonly physics: PhysicsWorld;
  private cache = new Map<number, number>();

  constructor(physics: PhysicsWorld) {
    this.physics = physics;
  }

  heightAt(x: number, z: number, fromY: number): number {
    const cx = Math.round(x / 0.2), cz = Math.round(z / 0.2), cy = Math.round(fromY / 0.5);
    // Exact integer key (|cell| < 5·10⁴ on each axis, far beyond any scene).
    const key = (cx + 5e4) * 1e10 + (cz + 5e4) * 1e5 + (cy + 5e4);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let y = 0;
    try {
      _o.set(cx * 0.2, cy * 0.5 + 0.05, cz * 0.2);
      const r = this.physics.castRay(_o, DOWN, _o.y + 60, STATIC_ONLY);
      if (r) y = r.point.y;
    } catch {
      y = 0;
    }
    if (y > fromY) y = Math.min(0, fromY);
    this.cache.set(key, y);
    return y;
  }

  clear(): void {
    this.cache.clear();
  }
}
