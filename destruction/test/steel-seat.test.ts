/**
 * Bearing seats (a member resting on piers), the global push a contact charge gives a heavy box
 * girder, and the dish's sky occlusion.
 *
 *   node --test test/steel-seat.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld.ts';
import { DestructibleRegistry } from '../src/destructibles/Registry.ts';
import { EventBus } from '../src/core/events.ts';
import { Rng } from '../src/core/rng.ts';
import type { SimContext, SimEvents } from '../src/app/contracts.ts';
import type { Destructible } from '../src/destructibles/Destructible.ts';
import { getAmmo } from '../src/physics/ballistics/ammo.ts';
import { createBlastLoad } from '../src/physics/ballistics/blast.ts';
import { createSteelBeam, SteelBeam } from '../src/destructibles/steel/index.ts';
import { contactImpulse } from '../src/destructibles/steel/steelMaterial.ts';
import { dishOcclusion } from '../src/destructibles/steel/profileMesh.ts';

async function makeCtx() {
  const physics = await PhysicsWorld.create();
  const registry = new DestructibleRegistry();
  const world = new THREE.Group();
  const ctx = {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: null as unknown as THREE.WebGLRenderer, physics, registry,
    events: new EventBus<SimEvents>(), world, time: { now: 0, scale: 1, fixedDt: 1 / 60 }, rng: new Rng(3),
    projectiles: { spawn: () => { throw new Error('no projectiles'); }, active: [] },
    blasts: { detonate() {} },
    fx: { chips() {}, dust() {}, sparks() {}, smoke() {}, flash() {}, shake() {} },
    audio: { unlock() {}, setMuted() {}, muted: true },
    structure: { link: () => 'a', touch() {}, remove() {}, update() {} },
    addDestructible(d: Destructible) {
      registry.add(d);
      if (!d.root.parent) world.add(d.root);
    },
    ammo: getAmmo,
  } as unknown as SimContext;
  const step = (dt: number) => {
    ctx.time.now += dt;
    ctx.time.fixedDt = dt;
    physics.step(dt);
    for (const d of registry.all()) if (!d.disposed) d.fixedUpdate?.(dt);
    registry.sweep();
    for (const d of registry.all()) if (!d.disposed) d.frameUpdate?.(dt);
  };
  return { ctx, step };
}

/** A member of the range's heavy-steel stand on its two piers (x = ±1.8 m, 0.5 × 0.8 m tops at y = 1.1). */
function onPiers(ctx: SimContext, box: boolean): SteelBeam {
  const half = box ? 0.25 : 0.15, Y = 1.1 + half;
  const b = createSteelBeam(ctx, {
    name: box ? 'Kutu kiriş' : 'HEB 300 kiriş (yan)', material: 'steel_s355',
    profile: box ? { type: 'box', h: 0.5, b: 0.4, t: 0.04 } : { type: 'I', h: 0.3, b: 0.3, tw: 0.011, tf: 0.019 },
    start: [-2, Y, 0], end: [2, Y, 0], up: box ? [0, 1, 0] : [0, 0, 1], ends: { start: 'free', end: 'free' }, finish: 'painted',
  }) as SteelBeam;
  ctx.addDestructible(b);
  for (const x of [-1.8, 1.8]) b.structural!.addAnchor(`pier${x}`, new THREE.Box3(new THREE.Vector3(x - 0.25, 0, -0.4), new THREE.Vector3(x + 0.25, 1.1, 0.4)));
  return b;
}

test('a member on piers rests on seats: held at rest, lifts off when the reaction reverses', async () => {
  const { ctx, step } = await makeCtx();
  const b = onPiers(ctx, false);
  assert.equal(b.sim.seats.size, 2, 'two seats');
  for (let k = 0; k < 60; k++) step(1 / 60);
  assert.equal(b.mode, 'fixed', 'rests on its seats');
  const w = (b.sim.totalMass() * 9.80665) / 2;
  for (const st of b.sim.seats.values()) assert.ok(Math.abs(st.rv - w) < 0.25 * w, `seat reaction ${st.rv.toFixed(0)} N ≈ half the weight ${w.toFixed(0)} N`);
  // A sustained upward pull at one end larger than what the seat carries: nothing holds it down.
  const n = b.sim.n;
  b.sim.loads[3 * (n - 1) + 1] = 3 * w;
  (b as unknown as { wake(): void }).wake();
  for (let k = 0; k < 60 && b.mode === 'fixed'; k++) step(1 / 60);
  assert.equal(b.mode, 'rigid', 'lifted off its seat and fell');
});

test('the bow of a member on seats does not hang from the seats (no catenary pull held)', async () => {
  const { ctx, step } = await makeCtx();
  const b = onPiers(ctx, false);
  for (let k = 0; k < 30; k++) step(1 / 60);
  for (let h = 0; h < 3; h++) {
    b.applyBlast(createBlastLoad({ center: new THREE.Vector3(0.3 + 0.03 * h, 1.25, 0.21), tntKg: 4.8, kind: 'hesh', contactTargetId: b.id, normal: new THREE.Vector3(0, 0, 1) }, ctx.time.now));
    for (let k = 0; k < 60; k++) step(1 / 60);
  }
  assert.equal(b.mode, 'fixed', 'still on its piers');
  const w = b.sim.totalMass() * 9.80665;
  // A seat only holds friction along the axis (C_f = 0.2 of its reaction) plus what the last
  // substeps' slip had not yet relieved; a pin would hold a catenary pull of hundreds of kN.
  for (const st of b.sim.seats.values()) assert.ok(Math.abs(st.ax) < 30e3 + 0.2 * w, `axial seat force ${(st.ax / 1000).toFixed(1)} kN`);
});

test('a member that has slid off its seat comes off the pier', async () => {
  const { ctx, step } = await makeCtx();
  const b = onPiers(ctx, false);
  for (let k = 0; k < 30; k++) step(1 / 60);
  // Slide both seat points 0.5 m towards the middle (as a bow shortening the chord would): the
  // left end (0.2 m past the pier centre) no longer lies over the left pier.
  for (const i of b.sim.seats.keys()) b.sim.lockPos[3 * i] = b.sim.lockPos[3 * i]! + (i < b.sim.n / 2 ? 0.5 : -0.5);
  (b as unknown as { wake(): void }).wake();
  for (let k = 0; k < 30 && b.mode === 'fixed'; k++) step(1 / 60);
  assert.equal(b.mode, 'rigid', 'off its piers');
});

test('HESH on the box girder: the impulse reaches the member (awake, momentum ≈ the contact impulse)', async () => {
  const { ctx, step } = await makeCtx();
  const b = onPiers(ctx, true);
  for (let k = 0; k < 60; k++) step(1 / 60);
  assert.equal(b.stats.awake, false, 'asleep before the hit');
  b.applyBlast(createBlastLoad({ center: new THREE.Vector3(0.3, 1.4, 0.26), tntKg: 4.8, kind: 'hesh', contactTargetId: b.id, normal: new THREE.Vector3(0, 0, 1) }, ctx.time.now));
  let pz = 0;
  for (let i = 0; i < b.sim.n; i++) pz += b.sim.mass[i]! * b.sim.v[3 * i + 2]!;
  const J = contactImpulse(4.8, 'hesh');
  assert.ok(-pz > 0.8 * J && -pz <= 1.001 * J, `momentum ${(-pz).toFixed(0)} of ${J} N·s`);
  step(1 / 60);
  assert.ok(b.stats.awake && b.stats.substeps > 2, 'steps the transient');
});

test('dish sky occlusion: 1 − cos²β at the centre (β = atan δ/R), fading to the rim', () => {
  const d = { s: 0, y: 0, z: 0, dy: -1, dz: 0, R: 0.15, depth: 0.084 };
  const k = 0.084 / 0.15;
  assert.ok(Math.abs(dishOcclusion(d, 0.084) - Math.min(0.6, (1.5 * k * k) / (1 + k * k))) < 1e-9);
  assert.ok(dishOcclusion(d, 0.042) < dishOcclusion(d, 0.084));
  assert.equal(dishOcclusion({ ...d, depth: 0 }, 0), 0);
  assert.ok(dishOcclusion({ ...d, depth: 0.005 }, 0.005) < 0.002, 'a shallow dent hardly shades');
});
