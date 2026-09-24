import * as THREE from 'three';
import { EventBus } from '../src/core/events.ts';
import { Rng } from '../src/core/rng.ts';
import { PhysicsWorld } from '../src/physics/PhysicsWorld.ts';
import { DestructibleRegistry } from '../src/destructibles/Registry.ts';
import { getAmmo } from '../src/physics/ballistics/ammo.ts';
import type { Destructible } from '../src/destructibles/Destructible.ts';
import type { SimContext, SimEvents, System } from '../src/app/contracts.ts';
import type { Simulation } from '../src/app/Simulation.ts';

/**
 * A DOM-free stand-in for `Simulation` so the ballistics systems can be exercised under Node:
 * real Rapier world, registry, event bus and fixed-step loop; no renderer.
 */
export interface TestSim {
  sim: Simulation;
  ctx: SimContext;
  systems: System[];
  step(seconds: number, dt?: number): void;
  shakes: number[];
}

export async function createTestSim(seed = 1): Promise<TestSim> {
  const physics = await PhysicsWorld.create();
  physics.defaultGround = physics.createFixed(new THREE.Vector3(0, -1, 0), undefined, [physics.R.ColliderDesc.cuboid(500, 1, 500)], { kind: 'ground' });
  const registry = new DestructibleRegistry();
  const world = new THREE.Group();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 2000);
  scene.add(world, camera);
  const shakes: number[] = [];
  const ctx = {
    scene, camera, renderer: null as never, physics, registry, events: new EventBus<SimEvents>(), rng: new Rng(seed),
    time: { now: 0, scale: 1, fixedDt: 1 / 60 }, world,
    projectiles: null as never, blasts: null as never,
    fx: { chips() {}, dust() {}, sparks() {}, smoke() {}, flash() {}, shake(a: number) { shakes.push(a); } },
    audio: { unlock() {}, setMuted() {}, muted: true },
    structure: { link: () => 'a', touch() {}, remove() {}, update() {} },
    addDestructible(d: Destructible) { registry.add(d); world.add(d.root); },
    ammo: (id: string) => getAmmo(id),
  } as SimContext;
  const systems: System[] = [];
  const sim = { ctx, addSystem: (s: System) => systems.push(s), getSystem: (n: string) => systems.find((s) => s.name === n) } as unknown as Simulation;
  const step = (seconds: number, dt = 1 / 60) => {
    let t = 0;
    while (t < seconds - 1e-9) {
      const h = Math.min(dt, seconds - t);
      ctx.time.fixedDt = h;
      ctx.time.now += h;
      for (const s of systems) s.fixedUpdate?.(h);
      physics.step(h);
      registry.sweep();
      t += h;
    }
  };
  return { sim, ctx, systems, step, shakes };
}
