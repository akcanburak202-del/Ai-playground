import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/PhysicsWorld.ts';

/**
 * Keep a collapse from aborting the simulation step on a degenerate collision hull.
 *
 * rapier.js computes a convex hull when the collider is created, not in `ColliderDesc.convexHull`
 * (which always returns a desc), so a sliver of rubble whose hull points are coplanar throws
 * "expected instance of …" from `createCollider` — in the middle of whatever element was cutting
 * rubble, leaving it half-built and skipping the rest of the step. The fix belongs where hulls
 * are built (see the M7 report); until then, a failed hull is replaced by its bounding box with
 * the same mass, material and event settings.
 */
export function guardDegenerateHulls(physics: PhysicsWorld): void {
  const tagged = physics as PhysicsWorld & { __hullGuard?: boolean };
  if (tagged.__hullGuard) return;
  tagged.__hullGuard = true;
  const attach = physics.attachCollider.bind(physics);
  physics.attachCollider = (body, desc, owner) => {
    try {
      return attach(body, desc, owner);
    } catch (err) {
      const box = boundingBoxDesc(physics.R, desc);
      if (!box) throw err;
      return attach(body, box, owner);
    }
  };
}

function boundingBoxDesc(R: typeof RAPIER, desc: RAPIER.ColliderDesc): RAPIER.ColliderDesc | null {
  const v = (desc.shape as { vertices?: Float32Array }).vertices;
  if (!v || v.length < 3) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i + 2 < v.length; i += 3) {
    const x = v[i]!, y = v[i + 1]!, z = v[i + 2]!;
    if (!Number.isFinite(x + y + z)) continue;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  if (!(x1 >= x0 && y1 >= y0 && z1 >= z0)) return null;
  // A flat sliver still needs some thickness to collide: 5 mm at least.
  const h = (a: number, b: number) => Math.max(0.005, (b - a) / 2);
  const box = R.ColliderDesc.cuboid(h(x0, x1), h(y0, y1), h(z0, z1));
  box.setTranslation(desc.translation.x + (x0 + x1) / 2, desc.translation.y + (y0 + y1) / 2, desc.translation.z + (z0 + z1) / 2);
  box.setRotation(desc.rotation);
  box.massPropsMode = desc.massPropsMode;
  box.mass = desc.mass;
  box.density = desc.density;
  box.centerOfMass = desc.centerOfMass;
  box.principalAngularInertia = desc.principalAngularInertia;
  box.angularInertiaLocalFrame = desc.angularInertiaLocalFrame;
  box.friction = desc.friction;
  box.restitution = desc.restitution;
  box.collisionGroups = desc.collisionGroups;
  box.solverGroups = desc.solverGroups;
  box.activeEvents = desc.activeEvents;
  box.contactForceEventThreshold = desc.contactForceEventThreshold;
  return box;
}
