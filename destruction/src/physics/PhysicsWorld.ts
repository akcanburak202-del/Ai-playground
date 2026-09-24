import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { MaterialProps } from './materials.ts';
import type { Destructible } from '../destructibles/Destructible.ts';

export type Rapier = typeof RAPIER;

/** Collision groups: membership bits in the high half, filter bits in the low half. */
export const GROUP_STATIC = 0x0001; // terrain and static structure
export const GROUP_DEBRIS = 0x0002; // dynamic rubble, fallen elements
export const GROUP_SMALL = 0x0004; // tiny chips/shards: collide with static + debris, not with each other
export const groups = (membership: number, filter: number) => ((membership & 0xffff) << 16) | (filter & 0xffff);
export const GROUPS_STATIC = groups(GROUP_STATIC, GROUP_DEBRIS | GROUP_SMALL);
export const GROUPS_DEBRIS = groups(GROUP_DEBRIS, GROUP_STATIC | GROUP_DEBRIS | GROUP_SMALL);
export const GROUPS_SMALL = groups(GROUP_SMALL, GROUP_STATIC | GROUP_DEBRIS);

export interface ContactForceInfo {
  /** This owner's collider */
  self: RAPIER.Collider;
  other: RAPIER.Collider;
  otherOwner: PhysicsOwner | undefined;
  /** Sum of contact force magnitudes during the step, N */
  totalForce: number;
  /** Largest single contact force, N */
  maxForce: number;
  /** Unit direction of the strongest force (world), pointing from self towards other when known */
  direction: THREE.Vector3;
  /** A world contact point when the manifold has one */
  point: THREE.Vector3 | null;
  /** Step length, s. force × dt ≈ impulse. */
  dt: number;
}

/** Anything that owns colliders: lets contact events find their way back to game objects. */
export interface PhysicsOwner {
  kind: string;
  material?: MaterialProps;
  destructible?: Destructible;
  /** Called for contact-force events above the collider's threshold */
  onContactForce?(info: ContactForceInfo): void;
}

export interface DynamicBodyOptions {
  position: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  colliders: RAPIER.ColliderDesc[];
  owner?: PhysicsOwner;
  linvel?: THREE.Vector3;
  angvel?: THREE.Vector3;
  ccd?: boolean;
  /** Contact force threshold (N) above which owner.onContactForce fires; omit to disable */
  contactForceThreshold?: number;
  small?: boolean;
  linearDamping?: number;
  angularDamping?: number;
}

const tmpV = new THREE.Vector3();

/**
 * Thin wrapper over a Rapier world: owns the world and event queue, maps colliders to owners,
 * enforces a dynamic-body budget, and exposes the handful of queries the simulation needs.
 */
export class PhysicsWorld {
  readonly R: Rapier;
  /** The live Rapier world. Replaced by `reset()`, so never cache it across scene loads. */
  world: RAPIER.World;
  private events: RAPIER.EventQueue;
  private owners = new Map<number, PhysicsOwner>();
  private dynamicBodies: { body: RAPIER.RigidBody; born: number }[] = [];
  private clock = 0;
  /** Hard cap on simultaneously simulated dynamic bodies; the oldest sleeping ones get frozen first. */
  maxDynamicBodies = 900;
  private frozenListeners = new Set<(body: RAPIER.RigidBody) => void>();
  /** Bodies the budget must never freeze (architecture that starts as sleeping rigid bodies). */
  private exempt = new WeakSet<RAPIER.RigidBody>();
  /** Set after Rapier traps (a WASM panic leaves the world unusable); stepping stops, the app goes on. */
  failed = false;
  /** Flat ground slab the Simulation adds on every scene load; terrain replaces it via removeDefaultGround(). */
  defaultGround: RAPIER.RigidBody | null = null;

  private constructor(R: Rapier) {
    this.R = R;
    this.world = new R.World({ x: 0, y: -9.80665, z: 0 });
    this.world.timestep = 1 / 60;
    this.world.integrationParameters.numSolverIterations = 6;
    this.events = new R.EventQueue(true);
  }

  /** Drop every body and start an empty world (scene change). */
  reset(): void {
    this.world.free();
    this.events.free();
    this.world = new this.R.World({ x: 0, y: -9.80665, z: 0 });
    this.world.timestep = 1 / 60;
    this.world.integrationParameters.numSolverIterations = 6;
    this.events = new this.R.EventQueue(true);
    this.owners.clear();
    this.dynamicBodies = [];
    this.clock = 0;
    this.defaultGround = null;
    this.exempt = new WeakSet();
    this.failed = false;
  }

  static async create(): Promise<PhysicsWorld> {
    await RAPIER.init();
    return new PhysicsWorld(RAPIER);
  }

  get time(): number {
    return this.clock;
  }

  /** Advance by dt seconds (callers keep dt ≤ 1/60). */
  step(dt: number): void {
    if (this.failed) return;
    this.clock += dt;
    this.world.timestep = dt;
    try {
      this.world.step(this.events);
    } catch (err) {
      // A Rapier panic ("unreachable") poisons the WASM instance; keep the rest of the app alive.
      this.failed = true;
      console.error('Rapier step failed; rigid-body physics stopped until the scene reloads.', err);
      return;
    }
    this.events.drainContactForceEvents((ev) => {
      const c1 = this.world.getCollider(ev.collider1());
      const c2 = this.world.getCollider(ev.collider2());
      if (!c1 || !c2) return;
      const o1 = this.owners.get(c1.handle);
      const o2 = this.owners.get(c2.handle);
      if (!o1?.onContactForce && !o2?.onContactForce) return;
      const d = ev.maxForceDirection();
      const dir = new THREE.Vector3(d.x, d.y, d.z);
      let point: THREE.Vector3 | null = null;
      this.world.contactPair(c1, c2, (manifold) => {
        if (point || manifold.numSolverContacts() === 0) return;
        const p = manifold.solverContactPoint(0);
        if (p) point = new THREE.Vector3(p.x, p.y, p.z);
      });
      const total = ev.totalForceMagnitude();
      const max = ev.maxForceMagnitude();
      o1?.onContactForce?.({ self: c1, other: c2, otherOwner: o2, totalForce: total, maxForce: max, direction: dir, point, dt });
      o2?.onContactForce?.({
        self: c2, other: c1, otherOwner: o1, totalForce: total, maxForce: max,
        direction: dir.clone().negate(), point, dt,
      });
    });
    this.enforceBudget();
  }

  /** Create a fixed (static) body with colliders. Static colliders use GROUPS_STATIC by default. */
  createFixed(position: THREE.Vector3, quaternion: THREE.Quaternion | undefined, colliders: RAPIER.ColliderDesc[], owner?: PhysicsOwner): RAPIER.RigidBody {
    const desc = this.R.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z);
    if (quaternion) desc.setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w });
    const body = this.world.createRigidBody(desc);
    for (const cd of colliders) this.attachCollider(body, cd.setCollisionGroups(GROUPS_STATIC), owner);
    return body;
  }

  createDynamic(o: DynamicBodyOptions): RAPIER.RigidBody {
    const desc = this.R.RigidBodyDesc.dynamic().setTranslation(o.position.x, o.position.y, o.position.z);
    if (o.quaternion) desc.setRotation({ x: o.quaternion.x, y: o.quaternion.y, z: o.quaternion.z, w: o.quaternion.w });
    if (o.linvel) desc.setLinvel(o.linvel.x, o.linvel.y, o.linvel.z);
    if (o.angvel) desc.setAngvel({ x: o.angvel.x, y: o.angvel.y, z: o.angvel.z });
    if (o.ccd) desc.setCcdEnabled(true);
    desc.setLinearDamping(o.linearDamping ?? 0.02);
    desc.setAngularDamping(o.angularDamping ?? 0.08);
    const body = this.world.createRigidBody(desc);
    const grp = o.small ? GROUPS_SMALL : GROUPS_DEBRIS;
    for (const cd of o.colliders) {
      cd.setCollisionGroups(grp);
      if (o.contactForceThreshold !== undefined) {
        cd.setActiveEvents(this.R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(o.contactForceThreshold);
      }
      this.attachCollider(body, cd, o.owner);
    }
    this.dynamicBodies.push({ body, born: this.clock });
    return body;
  }

  attachCollider(body: RAPIER.RigidBody, desc: RAPIER.ColliderDesc, owner?: PhysicsOwner): RAPIER.Collider {
    const c = this.world.createCollider(desc, body);
    if (owner) this.owners.set(c.handle, owner);
    return c;
  }

  removeCollider(c: RAPIER.Collider): void {
    this.owners.delete(c.handle);
    this.world.removeCollider(c, true);
  }

  removeBody(body: RAPIER.RigidBody): void {
    const n = body.numColliders();
    for (let i = 0; i < n; i++) this.owners.delete(body.collider(i).handle);
    const idx = this.dynamicBodies.findIndex((e) => e.body === body);
    if (idx >= 0) this.dynamicBodies.splice(idx, 1);
    this.world.removeRigidBody(body);
  }

  removeDefaultGround(): void {
    if (this.defaultGround) this.world.removeRigidBody(this.defaultGround);
    this.defaultGround = null;
  }

  /** Keep a body out of the budget's freezing (e.g. temple drums that must stay able to topple). */
  exemptFromBudget(body: RAPIER.RigidBody): void {
    this.exempt.add(body);
  }

  ownerOf(c: RAPIER.Collider): PhysicsOwner | undefined {
    return this.owners.get(c.handle);
  }

  /** Fired when the budget freezes a body (switches it to fixed). Owners may merge/bake it. */
  onFrozen(fn: (body: RAPIER.RigidBody) => void): () => void {
    this.frozenListeners.add(fn);
    return () => this.frozenListeners.delete(fn);
  }

  get dynamicCount(): number {
    return this.dynamicBodies.length;
  }

  /** Apply an impulse (N·s) at a world point, waking the body. */
  applyImpulseAt(body: RAPIER.RigidBody, impulse: THREE.Vector3, point: THREE.Vector3): void {
    body.applyImpulseAtPoint({ x: impulse.x, y: impulse.y, z: impulse.z }, { x: point.x, y: point.y, z: point.z }, true);
  }

  /** Nearest collider hit along a ray, with normal. */
  castRay(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, filterGroups?: number): { collider: RAPIER.Collider; distance: number; normal: THREE.Vector3; point: THREE.Vector3 } | null {
    const ray = new this.R.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z });
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, filterGroups);
    if (!hit) return null;
    const point = tmpV.copy(dir).multiplyScalar(hit.timeOfImpact).add(origin).clone();
    return { collider: hit.collider, distance: hit.timeOfImpact, normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z), point };
  }

  /** Every dynamic body whose collider intersects a sphere (for blast impulses). */
  bodiesInSphere(center: THREE.Vector3, radius: number): RAPIER.RigidBody[] {
    const out = new Set<RAPIER.RigidBody>();
    const shape = new this.R.Ball(radius);
    this.world.intersectionsWithShape({ x: center.x, y: center.y, z: center.z }, { x: 0, y: 0, z: 0, w: 1 }, shape, (c) => {
      const b = c.parent();
      if (b && b.isDynamic()) out.add(b);
      return true;
    });
    return [...out];
  }

  /**
   * Keep the number of simulated bodies bounded: once over budget, the oldest sleeping bodies are
   * made fixed (they stay where they came to rest and still collide).
   */
  private enforceBudget(): void {
    if (this.dynamicBodies.length <= this.maxDynamicBodies) return;
    let excess = this.dynamicBodies.length - this.maxDynamicBodies;
    for (let i = 0; i < this.dynamicBodies.length && excess > 0; ) {
      const e = this.dynamicBodies[i]!;
      if (!this.exempt.has(e.body) && (e.body.isSleeping() || this.clock - e.born > 30)) {
        e.body.setBodyType(this.R.RigidBodyType.Fixed, false);
        this.dynamicBodies.splice(i, 1);
        excess--;
        for (const fn of this.frozenListeners) fn(e.body);
      } else i++;
    }
  }
}
