import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeCtx } from '../src/destructibles/voxel/headless.ts';
import { createElementFactories } from '../src/app/elements.ts';
import { StructureGraph, guardDegenerateHulls } from '../src/structure/index.ts';
import { SCENES } from '../src/scenes/index.ts';
import type { Destructible } from '../src/destructibles/Destructible.ts';

/**
 * Every scene builds headless (real voxel / steel / glass elements, real Rapier), every structural
 * element is held by something, and the graph's gravity load flow is statically consistent: what
 * the scene weighs (plus the declared external loads) arrives at the ground.
 */

async function build(id: string) {
  const ctx = await makeCtx();
  guardDegenerateHulls(ctx.physics);
  const graph = new StructureGraph(ctx);
  (ctx as { structure: unknown }).structure = graph;
  const def = SCENES.find((s) => s.id === id)!;
  const t0 = performance.now();
  await def.build(ctx, createElementFactories(ctx));
  const ms = performance.now() - t0;
  const step = (dt: number) => {
    ctx.time.now += dt;
    ctx.physics.step(dt);
    for (const d of ctx.registry.all()) if (!d.disposed) d.fixedUpdate?.(dt);
    graph.update(dt);
    ctx.registry.sweep();
  };
  return { ctx, graph, def, ms, step };
}

test('scene catalogue: unique ids, bilingual names, golden-hour suns', () => {
  const ids = new Set(SCENES.map((s) => s.id));
  assert.equal(ids.size, SCENES.length);
  assert.deepEqual([...ids].sort(), ['chapel', 'pavilion', 'range', 'temple', 'tower']);
  for (const s of SCENES) {
    assert.ok(s.name && s.nameTr && s.blurb && s.blurbTr, s.id);
    assert.ok(s.sun && s.sun.elevation >= 8 && s.sun.elevation <= 20, `${s.id} sun ${s.sun?.elevation}`);
    assert.ok(s.spawn.position.every(Number.isFinite) && s.spawn.lookAt.every(Number.isFinite));
  }
});

for (const def of SCENES) {
  test(`${def.id}: builds, every element is held, loads reach the ground`, async () => {
    const { ctx, graph, ms, step } = await build(def.id);
    const els = ctx.registry.all().filter((d) => d.kind !== 'terrain');
    assert.ok(els.length > 5, `${def.id} has ${els.length} elements`);
    // Structural elements are linked (dynamic stones are held by contact, not by the graph). The
    // range's plates and glass are clamped on all edges in rigid test frames (their own spec edges).
    const linked = new Set<Destructible>();
    for (const l of graph.linksOf()) linked.add(l.supported);
    const rigHeld = (d: Destructible) => def.id === 'range' && (d.kind === 'plate' || d.kind === 'glass');
    const loose = els.filter((d) => d.structural && !linked.has(d) && !rigHeld(d));
    assert.deepEqual(loose.map((d) => d.name), [], 'unlinked structural elements');
    step(1 / 60);
    // Static equilibrium of the flow: ground reactions = weights + external loads.
    let weight = 0, ground = 0;
    for (const d of linked) weight += d.structural?.weight() ?? 0;
    const external = [...linked].reduce((s, d) => s + Math.max(0, graph.imposedLoad(d) - carried(graph, d)), 0);
    for (const l of graph.linksOf()) if (l.supporter === 'ground') ground += l.load;
    assert.ok(Number.isFinite(ground) && ground > 0);
    assert.ok(Math.abs(ground - weight - external) <= 1e-6 * (weight + external), `${def.id}: ground ${ground.toFixed(0)} N vs weight ${weight.toFixed(0)} + external ${external.toFixed(0)} N`);
    // Nothing moves or breaks while nobody shoots: a few seconds of stillness.
    const before = new Map(els.map((d) => [d, d.bounds.getCenter(new THREE.Vector3())]));
    for (let i = 0; i < 120; i++) step(1 / 60);
    for (const [d, c] of before) {
      assert.equal(d.disposed, false, `${d.name} broke at rest`);
      assert.ok(d.bounds.getCenter(new THREE.Vector3()).distanceTo(c) < 0.01, `${d.name} moved at rest`);
    }
    assert.equal(graph.stats.releases, 0, 'no support released at rest');
    console.log(`  ${def.id}: ${els.length} elements, ${graph.stats.links} links, ${(weight / 9.80665 / 1000).toFixed(0)} t, build ${ms.toFixed(0)} ms (headless)`);
  });
}

/** Load that `d` receives from the elements it supports (the rest of its imposed load is external). */
function carried(graph: StructureGraph, d: Destructible): number {
  let n = 0;
  for (const l of graph.linksOf(d)) if (l.supporter === d && l.active) n += l.load;
  return n;
}

test('temple: the dry-stone colonnade stands when woken all at once, then sleeps again', async () => {
  const { ctx, step } = await build('temple');
  const stones = ctx.registry.all().filter((d) => d.kind === 'voxel' && !d.structural);
  assert.ok(stones.length >= 100, `${stones.length} loose stones`);
  const before = new Map(stones.map((d) => [d, d.bounds.getCenter(new THREE.Vector3())]));
  ctx.physics.world.forEachRigidBody((b) => {
    if (b.isDynamic()) b.wakeUp();
  });
  for (let i = 0; i < 240; i++) step(1 / 60);
  let worst = 0;
  for (const [d, c] of before) {
    assert.equal(d.disposed, false, `${d.name} broke`);
    worst = Math.max(worst, d.bounds.getCenter(new THREE.Vector3()).distanceTo(c));
  }
  assert.ok(worst < 0.01, `worst creep ${worst.toFixed(4)} m`);
  let awake = 0;
  ctx.physics.world.forEachRigidBody((b) => {
    if (b.isDynamic() && !b.isSleeping()) awake++;
  });
  assert.equal(awake, 0, 'all stones asleep again');
});

test('temple: the body budget freezes rubble, never the standing stones', async () => {
  const { ctx, step } = await build('temple');
  const phys = ctx.physics;
  const stones = new Set(ctx.registry.all().filter((d) => d.kind === 'voxel' && !d.structural));
  // Rubble well past the budget, born after the stones (the world freezes the oldest sleeping
  // bodies first, and the stones are the oldest and asleep). Let it come to rest and fall asleep.
  const extra = phys.maxDynamicBodies - phys.dynamicCount + 40;
  for (let i = 0; i < extra; i++) {
    const b = phys.createDynamic({ position: new THREE.Vector3(40 + (i % 20) * 0.5, 0.1, 40 + Math.floor(i / 20) * 0.5), colliders: [phys.R.ColliderDesc.cuboid(0.1, 0.1, 0.1)] });
    b.sleep();
  }
  for (let i = 0; i < 240; i++) step(1 / 60);
  let frozenStones = 0, live = 0;
  phys.world.forEachRigidBody((b) => {
    const el = b.numColliders() ? phys.ownerOf(b.collider(0))?.destructible : undefined;
    if (!el || !stones.has(el)) return;
    if (b.isDynamic()) live++;
    else frozenStones++;
  });
  assert.equal(frozenStones, 0, 'a standing stone was frozen');
  assert.equal(live, stones.size);
  assert.ok(phys.dynamicCount <= phys.maxDynamicBodies, `${phys.dynamicCount} bodies over a budget of ${phys.maxDynamicBodies}`);
});
