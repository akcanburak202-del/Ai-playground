import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VoxelGrid } from '../src/destructibles/voxel/grid.ts';
import { BoxShape, fillGrid, layoutFor } from '../src/destructibles/voxel/shape.ts';
import { Connectivity } from '../src/destructibles/voxel/connectivity.ts';
import { Carver } from '../src/destructibles/voxel/carve.ts';
import { layoutRebar } from '../src/destructibles/voxel/rebar.ts';
import { pickSeeds, splitSelection } from '../src/destructibles/voxel/fracture.ts';
import { createVoxelElement } from '../src/destructibles/voxel/index.ts';
import type { VoxelElement } from '../src/destructibles/voxel/VoxelElement.ts';
import { Rng } from '../src/core/rng.ts';
import { makeCtx } from '../src/destructibles/voxel/headless.ts';

const flat = { lobe: 0, lobeScale: 1, grain: 0, seed: 0 };

function wall(size: [number, number, number], h = 0.025) {
  const shape = new BoxShape(size);
  const g = new VoxelGrid(layoutFor(shape, h));
  fillGrid(g, shape);
  return { g, shape };
}

test('a cut across a ground-anchored wall releases the upper part as one island', () => {
  const { g } = wall([2, 2, 0.2]);
  const c = new Carver(g);
  // Slot through the full thickness and width at mid-height.
  c.carve(-1.2, -0.05, -0.2, 1.2, 0.05, 0.2, (_x, y) => Math.abs(y) - 0.04, flat);
  const conn = new Connectivity(g, 2);
  conn.update(g, null);
  const ground = new Uint8Array(conn.n);
  conn.markBox(g, -1.1, -1.05, -0.2, 1.1, -0.95, 0.2, ground);
  const islands = conn.analyze(g, { anchors: [ground], rebar: null, horizontal: [0.05, 0, 0.05], cantilever: 2, span: 7 });
  assert.equal(islands.length, 1);
  const vol = islands[0]!.samples * g.h ** 3;
  assert.ok(Math.abs(vol - 2 * 0.96 * 0.2) < 0.08, `island volume ${vol}`);
});

test('intact rebar keeps a cut wall together until the bars are cut', () => {
  const { g, shape } = wall([2, 2, 0.2]);
  const rebar = layoutRebar(shape, { diameter: 0.016, spacing: 0.2, cover: 0.03, layout: 'two-faces' })!;
  rebar.register(g);
  const c = new Carver(g);
  c.carve(-1.2, -0.05, -0.2, 1.2, 0.05, 0.2, (_x, y) => Math.abs(y) - 0.04, flat);
  const conn = new Connectivity(g, 2);
  conn.update(g, null);
  const ground = new Uint8Array(conn.n);
  conn.markBox(g, -1.1, -1.05, -0.2, 1.1, -0.95, 0.2, ground);
  const opts = { anchors: [ground], rebar, horizontal: [0.05, 0, 0.05] as [number, number, number], cantilever: 2, span: 7 };
  assert.equal(conn.analyze(g, opts).length, 0, 'bars hold the upper part');
  // Cut every bar segment crossing the slot.
  const n = rebar.nodes;
  for (let s = 0; s < rebar.segCount; s++) {
    const ya = n[rebar.segA[s]! * 3 + 1]!, yb = n[rebar.segB[s]! * 3 + 1]!;
    if (Math.min(ya, yb) < 0.05 && Math.max(ya, yb) > -0.05) rebar.cut(s, 0);
  }
  rebar.version++;
  assert.equal(conn.analyze(g, opts).length, 1, 'cut bars release it');
});

test('exposed bars longer than ~20 d do not hold the wall above a blown-out band', () => {
  const { g, shape } = wall([2, 2, 0.2]);
  const rebar = layoutRebar(shape, { diameter: 0.012, spacing: 0.2, cover: 0.03, layout: 'two-faces' })!;
  rebar.register(g);
  // A 60 cm band gone at mid-height: the bars span it intact (free length 50 d).
  new Carver(g).carve(-1.2, -0.35, -0.2, 1.2, 0.35, 0.2, (_x, y) => Math.abs(y) - 0.3, flat);
  const conn = new Connectivity(g, 2);
  conn.update(g, null);
  const ground = new Uint8Array(conn.n);
  conn.markBox(g, -1.1, -1.05, -0.2, 1.1, -0.95, 0.2, ground);
  const islands = conn.analyze(g, { anchors: [ground], rebar, horizontal: [0.05, 0, 0.05], cantilever: 2, span: 7 });
  assert.equal(islands.length, 1, 'the upper part hangs on slender bars');
});

test('span and cantilever rules: a slab on two supports stands, on one it breaks at ~10 t', () => {
  const t = 0.2;
  const { g } = wall([4.2, t, 2.4], 0.05);
  const conn = new Connectivity(g, 1);
  conn.update(g, null);
  const left = new Uint8Array(conn.n), right = new Uint8Array(conn.n);
  conn.markBox(g, -2.1, -0.1, -1.2, -1.9, 0.1, 1.2, left);
  conn.markBox(g, 1.9, -0.1, -1.2, 2.1, 0.1, 1.2, right);
  const opts = { rebar: null, horizontal: [0.05, 0, 0.05] as [number, number, number], cantilever: 10 * t, span: 35 * t };
  assert.equal(conn.analyze(g, { ...opts, anchors: [left, right] }).length, 0);
  const isl = conn.analyze(g, { ...opts, anchors: [right] });
  assert.equal(isl.length, 1);
  // Everything farther than 2 m from the right support falls: x < 2.1 − 0.2 − 2.0 ≈ −0.1.
  const xMax = g.lx((isl[0]!.max[0] + 1) * conn.F);
  assert.ok(xMax > -0.25 && xMax < 0.1, `break line at x = ${xMax}`);
});

test('Voronoi split conserves material and keeps pieces apart', () => {
  const { g } = wall([1, 1, 0.3]);
  const before = g.totalSolid;
  const rng = new Rng(3);
  const cand = new Float64Array(3 * 200);
  for (let i = 0; i < 200; i++) {
    cand[i * 3] = rng.range(-0.45, 0.45);
    cand[i * 3 + 1] = rng.range(-0.45, 0.45);
    cand[i * 3 + 2] = rng.range(-0.1, 0.1);
  }
  const seeds = pickSeeds(cand, 200, 6, null, 0.2, rng);
  const pieces = splitSelection(g, { box: [0, 0, 0, g.nx - 1, g.ny - 1, g.nz - 1], sdf: false, test: () => 1 }, seeds, 0.5 * g.h, 0.05, 1);
  assert.equal(g.totalSolid, 0, 'parent emptied');
  assert.ok(pieces.length >= 4);
  const after = pieces.reduce((a, p) => a + p.grid.totalSolid, 0);
  // Only the thin gaps between pieces are lost.
  assert.ok(after / before > 0.85 && after <= before, `kept ${after / before}`);
  for (const p of pieces) assert.ok(p.grid.nx < g.nx + 1 && p.volume > 0);
});

test('column crushing: a notched column under load crushes and drops its top', async () => {
  const ctx = await makeCtx();
  const col = createVoxelElement(ctx, { name: 'col', material: 'concrete', finish: 'smooth-concrete', shape: { type: 'box', size: [0.3, 3, 0.3] }, position: [0, 1.5, 0] }) as VoxelElement;
  ctx.structure.link('ground', col, new THREE.Box3(new THREE.Vector3(-0.2, -0.05, -0.2), new THREE.Vector3(0.2, 0.05, 0.2)));
  let crushed = false;
  ctx.events.on('structuralFailure', (e) => { if (e.cause === 'crushing') crushed = true; });
  // 0.09 m² × 40 MPa ≈ 3.6 MN squash load: 2 MN holds.
  col.structural!.setImposedLoad(2e6);
  ctx.step();
  assert.equal(crushed, false);
  // Notch the column at 1 m until ~15 % of the section remains, then load it.
  const c = new Carver(col.grid);
  c.carve(-0.3, -0.55, -0.3, 0.3, -0.45, 0.3, (x, _y, z) => 0.06 - Math.max(Math.abs(x), Math.abs(z)), flat);
  (col as unknown as { checkAt: number }).checkAt = 0;
  for (let i = 0; i < 10; i++) ctx.step();
  assert.ok(crushed, 'no crushing');
  assert.ok(ctx.physics.dynamicCount > 0, 'top did not fall');
});

test('overturning: a wall left on a narrow stub at one end tips over, on a central stub it stands', async () => {
  for (const [stubX, falls] of [[0.9, true], [0, false]] as const) {
    const ctx = await makeCtx();
    const w = createVoxelElement(ctx, { name: 'w', material: 'concrete', finish: 'smooth-concrete', shape: { type: 'box', size: [2, 2, 0.2] }, position: [0, 1, 0] }) as VoxelElement;
    ctx.structure.link('ground', w, new THREE.Box3(new THREE.Vector3(-1, -0.05, -0.2), new THREE.Vector3(1, 0.05, 0.2)));
    let cause = '';
    ctx.events.on('structuralFailure', (e) => (cause = e.cause));
    // Blow out the base band 0.1–0.6 m above the ground except a 16 cm wide stub at x = stubX.
    new Carver(w.grid).carve(-1.2, -0.95, -0.2, 1.2, -0.35, 0.2, (x, y) => Math.max(Math.abs(y + 0.65) - 0.25, 0.08 - Math.abs(x - stubX)), flat);
    (w as unknown as { checkAt: number }).checkAt = 0;
    ctx.step();
    assert.equal(cause === 'overload', falls, `stub at x = ${stubX}: cause '${cause}'`);
    assert.equal(ctx.physics.dynamicCount > 0, falls, `stub at x = ${stubX}: ${ctx.physics.dynamicCount} bodies`);
  }
});

test('never-anchored elements keep their largest part; small detached bits fall', async () => {
  const ctx = await makeCtx();
  const block = createVoxelElement(ctx, { name: 'b', material: 'granite', finish: 'granite', shape: { type: 'box', size: [1, 0.5, 0.5] }, position: [0, 0.25, 0] }) as VoxelElement;
  const c = new Carver(block.grid);
  // Saw off a 20 cm end.
  c.carve(0.25, -0.4, -0.4, 0.35, 0.4, 0.4, (x) => Math.abs(x - 0.3) - 0.03, flat);
  (block as unknown as { checkAt: number }).checkAt = 0;
  ctx.step();
  assert.equal(block.hasFailed(), false);
  assert.ok(ctx.physics.dynamicCount >= 1, 'end piece should fall');
  assert.ok(block.grid.solidVolume() > 0.17, `kept ${block.grid.solidVolume()}`);
});
