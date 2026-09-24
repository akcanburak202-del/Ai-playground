import * as THREE from 'three';
import { PhysicsWorld } from '../../physics/PhysicsWorld.ts';
import { DestructibleRegistry } from '../Registry.ts';
import { EventBus } from '../../core/events.ts';
import { Rng } from '../../core/rng.ts';
import type { SimContext, SimEvents, StructureApi } from '../../app/contracts.ts';
import type { Destructible } from '../Destructible.ts';
import { STUB_AMMO } from './testing.ts';

/** Minimal headless SimContext (real Rapier, no renderer) for element tests. */
export async function makeCtx(): Promise<SimContext & { step(dt?: number): void; events: EventBus<SimEvents> }> {
  const physics = await PhysicsWorld.create();
  physics.createFixed(new THREE.Vector3(0, -1, 0), undefined, [physics.R.ColliderDesc.cuboid(500, 1, 500)]);
  const registry = new DestructibleRegistry();
  const world = new THREE.Group();
  const events = new EventBus<SimEvents>();
  let n = 0;
  const structure: StructureApi = {
    link(_s, supported, region) {
      const id = `a${++n}`;
      supported.structural?.addAnchor(id, region);
      return id;
    },
    touch() {},
    remove() {},
    update() {},
  };
  const nop = () => {};
  const ctx = {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(60, 1, 0.05, 500), renderer: null as unknown as THREE.WebGLRenderer,
    physics, registry, events, rng: new Rng(7), time: { now: 0, scale: 1, fixedDt: 1 / 60 }, world,
    projectiles: { spawn: () => { throw new Error('no projectiles'); }, active: [] },
    blasts: { detonate: nop }, fx: { chips: nop, dust: nop, sparks: nop, smoke: nop, flash: nop, shake: nop },
    audio: { unlock: nop, setMuted: nop, muted: true }, structure,
    addDestructible(d: Destructible) {
      registry.add(d);
      if (!d.root.parent) world.add(d.root);
    },
    ammo: (id: string) => STUB_AMMO[id as 'm855'],
    step(dt = 1 / 60) {
      ctx.time.now += dt;
      physics.step(dt);
      for (const d of registry.all()) if (!d.disposed) d.fixedUpdate?.(dt);
      registry.sweep();
    },
  };
  ctx.camera.position.set(0, 1.5, 8);
  return ctx as SimContext & { step(dt?: number): void; events: EventBus<SimEvents> };
}
