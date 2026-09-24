import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createVoxelElement } from '../src/destructibles/voxel/index.ts';
import { VoxelElement } from '../src/destructibles/voxel/VoxelElement.ts';
import { Carver } from '../src/destructibles/voxel/carve.ts';
import { STUB_AMMO, fireStub, makeBlastLoadStub, measureCrater, resolveBulletStub } from '../src/destructibles/voxel/testing.ts';
import { makeCtx } from '../src/destructibles/voxel/headless.ts';

const flat = { lobe: 0, lobeScale: 1, grain: 0, seed: 0 };

/** Build a wall, saw it through at mid-height with cut bars, and let the top fall at time step dt. */
async function collapseAt(dt: number, seconds: number) {
  const ctx = await makeCtx();
  const wall = createVoxelElement(ctx, {
    name: 'w', material: 'concrete', finish: 'smooth-concrete', shape: { type: 'box', size: [2, 2, 0.2] }, position: [0, 1, 0],
    rebar: { diameter: 0.012, spacing: 0.2, cover: 0.03, layout: 'two-faces' },
  }) as VoxelElement;
  ctx.structure.link('ground', wall, new THREE.Box3(new THREE.Vector3(-1, -0.05, -0.2), new THREE.Vector3(1, 0.05, 0.2)));
  new Carver(wall.grid).carve(-1.2, -0.05, -0.2, 1.2, 0.05, 0.2, (_x, y) => Math.abs(y) - 0.04, flat);
  const rb = wall.rebar!;
  for (let s = 0; s < rb.segCount; s++) {
    const ya = rb.nodes[rb.segA[s]! * 3 + 1]!, yb = rb.nodes[rb.segB[s]! * 3 + 1]!;
    if (Math.min(ya, yb) < 0.05 && Math.max(ya, yb) > -0.05) rb.cut(s, 0);
  }
  rb.version++;
  (wall as unknown as { checkAt: number }).checkAt = 0;
  let contacts = 0;
  ctx.events.on('debrisContact', () => contacts++);
  let maxSpeed = 0;
  for (let t = 0; t < seconds; t += dt) {
    ctx.step(dt);
    for (const d of ctx.registry.all()) {
      const b = (d as unknown as { body: { linvel(): { x: number; y: number; z: number } } | null }).body;
      if (d instanceof VoxelElement && d.dynamic && !d.disposed && b) { const v = b.linvel(); maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z)); }
    }
  }
  const pieces = ctx.registry.all().filter((d): d is VoxelElement => d instanceof VoxelElement && d.dynamic && !d.disposed);
  return { ctx, wall, pieces, contacts, maxSpeed };
}

for (const dt of [1 / 60, 0.001]) {
  test(`released pieces fall and settle without NaNs at dt = ${dt.toFixed(4)} s`, async () => {
    const { pieces, contacts, maxSpeed } = await collapseAt(dt, dt < 0.01 ? 0.6 : 2.5);
    assert.ok(pieces.length >= 4, `pieces ${pieces.length}`);
    for (const p of pieces) {
      const { x, y, z } = p.root.position;
      assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), 'NaN position');
      // root.position is the parent's frame origin; the piece itself must rest on the ground.
      assert.ok(p.bounds.max.y > 0 && p.bounds.min.y > -0.3 && p.bounds.max.y < 2.5, `piece spans y ${p.bounds.min.y}..${p.bounds.max.y}`);
      assert.ok(!p.bounds.isEmpty());
    }
    // Released with no load behind them, pieces only fall (≈ 4.4 m/s after 1 m): sibling hulls
    // must not start interpenetrating and kick each other apart.
    assert.ok(maxSpeed < 7, `pieces kicked to ${maxSpeed.toFixed(1)} m/s`);
    if (dt > 0.01) {
      assert.ok(contacts > 0, 'no debrisContact events on landing');
      // Everything came down below the cut.
      for (const p of pieces) assert.ok(p.bounds.min.y < 1.2, `piece still up at ${p.bounds.min.y}`);
    }
  });
}

test('falling debris stays shootable (raycast + probe + impact on a moving piece)', async () => {
  const { ctx, pieces } = await collapseAt(1 / 60, 0.3);
  const piece = pieces.sort((a, b) => b.grid.solidVolume() - a.grid.solidVolume())[0]!;
  const c = piece.bounds.getCenter(new THREE.Vector3());
  const from = c.clone().add(new THREE.Vector3(0, 0, 5));
  const hit = ctx.registry.raycast(from, new THREE.Vector3(0, 0, -1), 10);
  assert.ok(hit, 'no hit on the piece');
  const probe = hit!.target.probe(hit!, new THREE.Vector3(0, 0, -1), 1);
  assert.ok(probe.segments.length > 0);
  const before = (hit!.target as VoxelElement).grid.solidVolume();
  fireStub(ctx, STUB_AMMO.m2ap, from, c);
  assert.ok((hit!.target as VoxelElement).grid.solidVolume() < before, 'no material removed from the piece');
});

test('a contact charge breaches a 25 cm RC wall, throws debris and bends the bars outward', async () => {
  const ctx = await makeCtx();
  const wall = createVoxelElement(ctx, {
    name: 'rc', material: 'concrete', finish: 'board-formed-concrete', shape: { type: 'box', size: [3, 2.5, 0.25] }, position: [0, 1.25, 0],
    rebar: { diameter: 0.016, spacing: 0.2, cover: 0.04, layout: 'two-faces' },
  }) as VoxelElement;
  ctx.structure.link('ground', wall, new THREE.Box3(new THREE.Vector3(-1.5, -0.05, -0.2), new THREE.Vector3(1.5, 0.05, 0.2)));
  const rest = wall.rebar!.nodes.slice();
  let fractures = 0;
  ctx.events.on('fracture', () => fractures++);
  const load = makeBlastLoadStub(new THREE.Vector3(0, 1.2, 0.175), 3, { normal: new THREE.Vector3(0, 0, 1), contactTargetId: wall.id });
  wall.applyBlast(load);
  for (let i = 0; i < 10; i++) ctx.step(1 / 60);
  // Through-hole at the charge.
  const hit = ctx.registry.raycast(new THREE.Vector3(0.02, 1.21, 2), new THREE.Vector3(0, 0, -1), 5);
  assert.ok(!hit || hit.target !== wall || hit.material.id === 'rebar_b500', 'no breach');
  assert.ok(fractures > 0 && ctx.physics.dynamicCount > 0, 'no debris thrown');
  // Some exposed bars were pushed away from the charge (towards −z).
  const n = wall.rebar!.nodes;
  let bent = 0;
  for (let i = 0; i < wall.rebar!.nodeCount; i++) if (!wall.rebar!.segGone[Math.min(i, wall.rebar!.segCount - 1)] && n[i * 3 + 2]! < rest[i * 3 + 2]! - 0.01) bent++;
  assert.ok(bent > 0, 'no bars bent');
  // Soot only on the charge side.
  const g = wall.grid;
  let front = 0, back = 0;
  for (let k = 0; k < g.nz; k++)
    for (let i = 0; i < g.nx; i++) {
      const s = g.sootAt(i, Math.round(g.gy(0.45)), k);
      if (g.lz(k) > 0) front += s; else back += s;
    }
  assert.ok(front > back * 5, `soot front ${front} back ${back}`);
});

test('breach plug pieces keep their launch speed (sibling hulls do not overlap)', async () => {
  const ctx = await makeCtx();
  const wall = createVoxelElement(ctx, {
    name: 'rc', material: 'concrete', finish: 'board-formed-concrete', shape: { type: 'box', size: [3, 2.5, 0.25] }, position: [0, 1.25, 0],
    rebar: { diameter: 0.016, spacing: 0.2, cover: 0.04, layout: 'two-faces' },
  }) as VoxelElement;
  ctx.structure.link('ground', wall, new THREE.Box3(new THREE.Vector3(-1.5, -0.05, -0.2), new THREE.Vector3(1.5, 0.05, 0.2)));
  wall.applyBlast(makeBlastLoadStub(new THREE.Vector3(0, 1.2, 0.175), 3, { normal: new THREE.Vector3(0, 0, 1), contactTargetId: wall.id }));
  const speed = (d: VoxelElement) => {
    const v = (d as unknown as { body: { linvel(): { x: number; y: number; z: number } } }).body.linvel();
    return Math.hypot(v.x, v.y, v.z);
  };
  const thrown = ctx.registry.all().filter((d): d is VoxelElement => d instanceof VoxelElement && d.dynamic && speed(d) > 3);
  assert.ok(thrown.length >= 2, `thrown pieces ${thrown.length}`);
  const v0 = thrown.map(speed);
  for (let i = 0; i < 4; i++) ctx.step(1 / 60);
  // Without cell-bounded hulls the plug pieces spawned inside each other and kept ~40 %.
  const kept = thrown.reduce((a, d, q) => a + (d.disposed ? 1 : speed(d) / v0[q]!), 0) / thrown.length;
  assert.ok(kept > 0.85, `kept ${(kept * 100).toFixed(0)} % of the launch speed`);
});

test('a single 5.56 chip is visible wherever it lands between samples', async () => {
  const ctx = await makeCtx();
  const w = createVoxelElement(ctx, { name: 'w', material: 'concrete', finish: 'smooth-concrete', shape: { type: 'box', size: [3, 2, 0.25] }, position: [0, 1, 0] }) as VoxelElement;
  const g = w.grid;
  let worst = Infinity;
  for (let q = 0; q < 8; q++) {
    // Aim exactly between four sample columns (the worst case), at well separated spots. Without
    // centring the chip on a column the shallowest of these left a 6 × 8 mm dent.
    const x = g.ox + (Math.round((-1.2 + 0.35 * q - g.ox) / g.h) + 0.5) * g.h;
    const y = 1 + g.oy + (Math.round((-0.4 + 0.25 * (q % 3) - g.oy) / g.h) + 0.5) * g.h;
    const from = new THREE.Vector3(x, y, 20), dir = new THREE.Vector3(0, 0, -1);
    const hit = ctx.registry.raycast(from, dir, 50)!;
    const e = resolveBulletStub(STUB_AMMO.m855, hit, dir, hit.target.probe(hit, dir, 0.8), 0);
    // M1's single-hit numbers for M855 on C40: crater Ø47 × 17 mm, stopped at 32 mm.
    e.craterRadius = 0.0233; e.craterDepth = 0.0171; e.depth = 0.032; e.tunnelRadius = 0.0034; e.damageRadius = 0.093;
    w.applyImpact(e);
    worst = Math.min(worst, measureCrater(w, new THREE.Vector3(x, y, 0.125), new THREE.Vector3(0, 0, 1), 0.06, 0.004).maxDepth);
  }
  assert.ok(worst > 0.012, `shallowest chip ${(worst * 1000).toFixed(1)} mm`);
});

test('dispose releases bodies and GPU resources', async () => {
  const ctx = await makeCtx();
  const el = createVoxelElement(ctx, { name: 'b', material: 'marble', finish: 'marble', shape: { type: 'cylinder', radius: 0.3, height: 2, flutes: 20 }, position: [0, 1, 0], voxelSize: 0.02 });
  let n = 0;
  ctx.physics.world.forEachCollider(() => n++);
  el.dispose();
  let m = 0;
  ctx.physics.world.forEachCollider(() => m++);
  assert.equal(m, n - 1);
  assert.equal(el.root.parent, null);
  assert.ok(el.disposed);
});
