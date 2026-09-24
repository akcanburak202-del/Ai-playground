/**
 * Heavy members under tank-class loads (the user's example: "a steel member hit by a tank shell
 * dents and bends; repeated hits perforate it"), sleeping, and defensive hull colliders.
 *
 *   node --test test/steel-heavy.test.ts
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
import { MATERIALS } from '../src/physics/materials.ts';
import { createSteelBeam, SteelBeam, steelParams } from '../src/destructibles/steel/index.ts';
import { accumulateDish, panelDish } from '../src/destructibles/steel/steelMaterial.ts';
import { pointExtents, safeHullDesc } from '../src/destructibles/steel/colliders.ts';

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

const HEB300 = { type: 'I', h: 0.3, b: 0.3, tw: 0.011, tf: 0.019 } as const;

function column(ctx: SimContext): SteelBeam {
  const b = createSteelBeam(ctx, {
    name: 'HEB 300', material: 'steel_s355', profile: HEB300, start: [0, 0, 0], end: [0, 4, 0], up: [0, 0, 1],
    ends: { start: 'fixed', end: 'fixed' }, finish: 'painted',
  }) as SteelBeam;
  b.structural!.setImposedLoad(1.2e6);
  return b;
}

const patches = (b: SteelBeam) => (b as unknown as { patches: { plate: number; dish: number; tLoss: number; torn: boolean }[] }).patches;

test('Nurick–Martin panel dish and Jones accumulation', () => {
  const p = steelParams(MATERIALS.steel_s355);
  // 400 N·s spread over a 19 mm HEB 300 flange (R = 0.15 m): φ ≈ 1.4 → δ ≈ 18 mm.
  const d = panelDish(p, 400, 0.15, 0.15, 0.019);
  assert.ok(d > 0.012 && d < 0.025, `dish ${(d * 1000).toFixed(1)} mm`);
  // Twice the impulse: δ/t = 0.480 φ + 0.277 grows by 0.48 φ (≈ 1.7× here).
  const d2 = panelDish(p, 800, 0.15, 0.15, 0.019);
  assert.ok(d2 > 1.5 * d && d2 < 2 * d, `${(d * 1000).toFixed(1)} → ${(d2 * 1000).toFixed(1)} mm`);
  // A concentrated load dishes more than the same impulse spread over the panel.
  assert.ok(panelDish(p, 400, 0.15, 0.03, 0.019) > d);
  // Rifle-class momentum stays below the 1 mm a member draws as a dish (its crater is the mark).
  assert.ok(panelDish(p, 0.004 * 900, 0.15, 0.004, 0.019) < 1e-3);
  // Equal loads: δ_N = √N δ₁ (the increment shrinks).
  let a = 0;
  for (let k = 0; k < 4; k++) a = accumulateDish(a, d);
  assert.ok(Math.abs(a - 2 * d) < 1e-9);
});

test('HE shell bursting behind a column flange dishes it, and repeated bursts deepen the dish', async () => {
  const { ctx, step } = await makeCtx();
  const b = column(ctx);
  for (let k = 0; k < 30; k++) step(1 / 60);
  const dish: number[] = [];
  for (let k = 0; k < 3; k++) {
    // M908's 1.6 kg fill, fuzed 0.25 m behind the rear flange (as after perforating the front one).
    b.applyBlast(createBlastLoad({ center: new THREE.Vector3(0.0, 1.6, -0.4), tntKg: 1.6, kind: 'he' }, ctx.time.now));
    for (let q = 0; q < 20; q++) step(1 / 60);
    const rear = patches(b).filter((p) => p.plate === 1);
    assert.equal(rear.length, 1, 'one patch on the rear flange');
    dish.push(rear[0]!.dish);
  }
  assert.ok(dish[0]! > 0.008, `first dish ${(dish[0]! * 1000).toFixed(1)} mm`);
  for (let k = 1; k < dish.length; k++) {
    assert.ok(dish[k]! > dish[k - 1]!, `deepens ${dish.map((d) => (d * 1000).toFixed(1)).join(' → ')} mm`);
    assert.ok(dish[k]! - dish[k - 1]! < dish[0]!, 'by less each time (membrane stiffening)');
  }
  assert.ok(b.stats.maxDish === dish[2]);
});

test('contact charges on a flange: dish and scab first, breach on a later hit (section lost)', async () => {
  const { ctx, step } = await makeCtx();
  const b = column(ctx);
  for (let k = 0; k < 30; k++) step(1 / 60);
  const A0 = b.sim.areaFraction(b.sim.n >> 1);
  const at = new THREE.Vector3(0.0, 2.0, 0.2);
  // M830A1's warhead blast as a shaped contact load on the front flange (+z face).
  const hit = () => b.applyBlast(createBlastLoad({ center: at, tntKg: 1.6, kind: 'shaped', contactTargetId: b.id, normal: new THREE.Vector3(0, 0, 1) }, ctx.time.now));
  hit();
  for (let q = 0; q < 10; q++) step(1 / 60);
  const front = () => patches(b).find((p) => p.plate === 0)!;
  assert.ok(front(), 'front flange dished');
  assert.ok(front().dish > 0.005, `dish ${(front().dish * 1000).toFixed(1)} mm`);
  assert.ok(!front().torn, 'first shaped-charge blast does not hole a 19 mm flange');
  assert.ok(front().tLoss > 0.004, `scab + thinning ${(front().tLoss * 1000).toFixed(1)} mm`);
  let k = 1;
  while (!front().torn && k < 6) {
    hit();
    for (let q = 0; q < 10; q++) step(1 / 60);
    k++;
  }
  assert.ok(front().torn, 'repeated hits tear the thinned flange');
  assert.ok(k <= 3, `breached on hit ${k}`);
  const node = b.sim.n > 0 ? Math.round(2.0 / b.sim.ds) : 0;
  assert.ok(b.disposed || b.sim.areaFraction(node) < A0 - 0.05, 'the breach takes flange section out');
});

test('a member at rest sleeps, and a blast-woken frame settles back to sleep', async () => {
  const { ctx, step } = await makeCtx();
  const b = column(ctx);
  const girder = createSteelBeam(ctx, {
    name: 'IPE 400', material: 'steel_s355', profile: { type: 'I', h: 0.4, b: 0.18, tw: 0.0086, tf: 0.0135 },
    start: [0, 3.8, 0], end: [6, 3.8, 0], up: [0, 1, 0], ends: { start: 'fixed', end: 'fixed' }, finish: 'painted',
  }) as SteelBeam;
  let t = 0;
  while ((b.stats.awake || girder.stats.awake || t < 0.1) && t < 3) {
    step(1 / 60);
    t += 1 / 60;
  }
  assert.ok(t < 1.5, `load on and asleep after ${t.toFixed(2)} s`);
  const builds = girder.stats.meshBuilds;
  for (let k = 0; k < 30; k++) step(1 / 60);
  assert.equal(girder.stats.meshBuilds, builds, 'no mesh rebuilds while asleep');
  // A 5 kg charge 3 m away wakes both; they must come to rest again within a few seconds.
  const load = createBlastLoad({ center: new THREE.Vector3(1.5, 2.5, 2.5), tntKg: 5, kind: 'he' }, ctx.time.now);
  b.applyBlast(load);
  girder.applyBlast(load);
  assert.ok(b.stats.awake || girder.stats.awake || b.sim.maxNodeSpeed() > 0 || girder.sim.maxNodeSpeed() > 0);
  let s = 0;
  while ((b.stats.awake || girder.stats.awake || s < 0.1) && s < 6) {
    step(1 / 60);
    s += 1 / 60;
  }
  assert.ok(s < 4, `back asleep after ${s.toFixed(2)} s`);
  assert.ok(!b.hasFailed(), 'the column still stands');
});

test('degenerate point sets never reach Rapier as hulls', async () => {
  const physics = await PhysicsWorld.create();
  const R = physics.R;
  // A torn sliver: particles in one line, both faces at the same place (zero normals).
  const line: number[] = [];
  for (let i = 0; i < 6; i++) line.push(i * 0.05, 0, 0, i * 0.05, 0, 0);
  // A flat patch (coplanar) and a single point.
  const flat: number[] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) flat.push(i * 0.1, j * 0.1, 0.3 * i * 0.1);
  const cloud: number[] = [];
  for (let i = 0; i < 20; i++) cloud.push(Math.sin(i * 1.7) * 0.2, Math.cos(i * 2.3) * 0.15, Math.sin(i * 0.9) * 0.1);
  for (const [name, pts, hull] of [['line', line, false], ['flat', flat, false], ['point', [1, 2, 3], false], ['cloud', cloud, true]] as const) {
    const desc = safeHullDesc(R, pts, 0.004)!;
    assert.ok(desc, name);
    const isHull = desc.shape.type === R.ShapeType.ConvexPolyhedron;
    assert.equal(isHull, hull, `${name}: ${isHull ? 'hull' : 'box'}`);
    desc.setMass(10);
    assert.doesNotThrow(() => physics.createDynamic({ position: new THREE.Vector3(0, 5, 0), colliders: [desc], owner: { kind: 'debris' } as never }), name);
  }
  // The box bounds the flat patch along its tilted plane.
  const e = pointExtents(flat)!;
  assert.ok(e.half[2] < 1e-6 && e.half[0] > 0.1, `extents ${e.half.map((h) => h.toFixed(3)).join(', ')}`);
  physics.step(1 / 60);
});
