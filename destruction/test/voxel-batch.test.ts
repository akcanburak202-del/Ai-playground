import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GrowingBatch } from '../src/destructibles/voxel/batch.ts';
import { VoxelGrid } from '../src/destructibles/voxel/grid.ts';
import { BoxShape, fillGrid, layoutFor } from '../src/destructibles/voxel/shape.ts';
import { meshAll } from '../src/destructibles/voxel/mesher.ts';
import { layoutRebar } from '../src/destructibles/voxel/rebar.ts';
import { finishMaps, hasFinishMaps, warmFinishMaps } from '../src/destructibles/voxel/textures.ts';
import { makeCtx } from '../src/destructibles/voxel/headless.ts';
import { createVoxelElement, VoxelElement } from '../src/destructibles/voxel/index.ts';

/** A quad strip of `n` quads as batch attributes (position, normal) + index. */
function strip(n: number, x0 = 0): { attrs: Record<string, THREE.BufferAttribute>; index: THREE.BufferAttribute } {
  const pos = new Float32Array((n + 1) * 2 * 3), nrm = new Float32Array((n + 1) * 2 * 3);
  for (let i = 0; i <= n; i++) {
    pos.set([x0 + i, 0, 0, x0 + i, 1, 0], i * 6);
    nrm.set([0, 0, 1, 0, 0, 1], i * 6);
  }
  const idx = new Uint16Array(n * 6);
  for (let i = 0; i < n; i++) idx.set([2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 1, 2 * i + 2, 2 * i + 3], i * 6);
  return { attrs: { position: new THREE.BufferAttribute(pos, 3), normal: new THREE.BufferAttribute(nrm, 3) }, index: new THREE.BufferAttribute(idx, 1) };
}

test('growing batch: adds, updates in place, grows and repacks without losing geometry', () => {
  const b = new GrowingBatch(new THREE.MeshBasicMaterial(), 't', false, 2, 64, 192);
  const m = new THREE.Matrix4();
  const slots = [];
  for (let k = 0; k < 20; k++) {
    const s = strip(4 + k, k * 100);
    slots.push(b.add(s.attrs, s.index, m.makeTranslation(k, 0, 0)));
  }
  assert.equal(b.count, 20);
  // Every slot still draws its own strip after several grow steps: first vertex at x = k·100.
  const pos = b.mesh.geometry.getAttribute('position');
  const idx = b.mesh.geometry.getIndex()!;
  const info = (b.mesh as unknown as { _geometryInfo: { indexStart: number; indexCount: number }[] })._geometryInfo;
  slots.forEach((s, k) => {
    const gi = info[s.geometryId]!;
    assert.equal(gi.indexCount, (4 + k) * 6);
    assert.equal(pos.getX(idx.getX(gi.indexStart)), k * 100);
  });
  // A smaller geometry fits in place; a larger one moves (new slot), the old space is reclaimed later.
  const small = strip(3, 5000);
  assert.equal(b.update(slots[5]!, small.attrs, small.index, m), slots[5]);
  const big = strip(200, 7000);
  const moved = b.update(slots[6]!, big.attrs, big.index, m);
  assert.notEqual(moved, slots[6], 'outgrown slot is re-added');
  assert.ok(moved.rv >= 402);
  assert.equal(b.count, 20);
  for (const s of slots.slice(10)) b.remove(s);
  assert.equal(b.count, 10);
  b.dispose();
});

test('a released piece draws through its family batch and leaves it on dispose', async () => {
  const ctx = await makeCtx();
  const el = createVoxelElement(ctx, {
    name: 'slab', material: 'concrete', finish: 'smooth-concrete', shape: { type: 'box', size: [1.6, 0.2, 1.0] }, position: [0, 3, 0],
    voxelSize: 0.05, rebar: { diameter: 0.012, spacing: 0.2, cover: 0.03, layout: 'two-faces' },
  }) as VoxelElement;
  const id = ctx.structure.link('ground', el, new THREE.Box3(new THREE.Vector3(-0.8, 2.85, -0.5), new THREE.Vector3(-0.6, 2.95, 0.5)));
  el.releaseAnchor(id);
  ctx.step();
  const pieces = ctx.registry.all().filter((d) => (d as VoxelElement).dynamic) as VoxelElement[];
  assert.ok(pieces.length >= 1, 'the slab fell as pieces');
  for (const p of pieces) p.flushMeshes();
  const batches = ctx.world.children.filter((o) => (o as THREE.BatchedMesh).isBatchedMesh) as THREE.BatchedMesh[];
  const solid = batches.filter((b) => b.name.includes(':rubble') && !b.name.includes('rebar'));
  assert.ok(solid.length >= 1, 'rubble batch in the scene');
  assert.equal(solid.reduce((n, b) => n + b.instanceCount, 0), pieces.length, 'one instance per piece');
  // Pieces own no meshes of their own any more.
  for (const p of pieces) p.root.traverse((o) => assert.ok(!(o as THREE.Mesh).isMesh || o === p.root, `piece mesh ${o.name}`));
  // Embedded bars are not drawn: far fewer bar triangles than segments × 16.
  const bars = batches.find((b) => b.name.includes('rebar'));
  const segs = pieces.reduce((n, p) => n + (p.rebar?.segCount ?? 0), 0);
  const barTris = bars ? (bars.geometry.getIndex()!.count - bars.unusedIndexCount) / 3 : 0;
  assert.ok(barTris < segs * 16 * 0.6, `bar triangles ${barTris} for ${segs} segments`);
  for (const p of pieces) p.dispose();
  assert.equal(solid.reduce((n, b) => n + b.instanceCount, 0), 0, 'instances removed with their pieces');
  assert.ok(!ctx.world.children.some((o) => (o as THREE.BatchedMesh).isBatchedMesh), 'batches disposed with the family');
});

test('rebar mass is cached per version and follows nicks', () => {
  const rb = layoutRebar(new BoxShape([2, 1, 0.25]), { diameter: 0.016, spacing: 0.2, cover: 0.04, layout: 'two-faces' })!;
  const m0 = rb.mass();
  assert.equal(rb.mass(), m0);
  rb.nick(0, 0.5, 0);
  const m1 = rb.mass();
  assert.ok(m1 < m0, 'mass drops when a bar loses area');
  const a = rb.segA[0]! * 3, b = rb.segB[0]! * 3;
  const L = Math.hypot(rb.nodes[b]! - rb.nodes[a]!, rb.nodes[b + 1]! - rb.nodes[a + 1]!, rb.nodes[b + 2]! - rb.nodes[a + 2]!);
  const expected = 7850 * Math.PI * 0.008 ** 2 * 0.5 * L;
  assert.ok(Math.abs(m0 - m1 - expected) < 1e-6 * m0 + 1e-3, `Δm ${m0 - m1} vs ${expected}`);
});

test('untouched box faces are merged: a large slab meshes into a few triangles per chunk', () => {
  const shape = new BoxShape([13.2, 7, 0.2]);
  const g = new VoxelGrid(layoutFor(shape, 0.05));
  fillGrid(g, shape);
  const m = meshAll(g, shape)!;
  // 2 × 264 × 140 face quads alone were 148 k triangles before merging.
  assert.ok(m.indexCount / 3 < 40000, `triangles ${m.indexCount / 3}`);
  // No vertex is left unreferenced.
  const used = new Uint8Array(m.vertexCount);
  for (let i = 0; i < m.indexCount; i++) used[m.indices[i]!] = 1;
  assert.ok(used.every((u) => u === 1));
});

test('finish maps warm up in slices and match the synchronous result', async () => {
  let pauses = 0;
  await warmFinishMaps(['onyx'], 128, 1, async () => {
    pauses++;
  });
  assert.ok(hasFinishMaps('onyx', 128));
  assert.ok(pauses > 3, `pauses ${pauses}`);
  const a = finishMaps('onyx', 128);
  assert.equal(finishMaps('onyx', 128), a, 'cached');
  assert.equal(a.albedoRough.length, 128 * 128 * 4);
});

test('debris bars are closed tubes wound outward', async () => {
  const ctx = await makeCtx();
  const el = createVoxelElement(ctx, {
    name: 'beam', material: 'concrete', finish: 'smooth-concrete', shape: { type: 'box', size: [1.2, 0.3, 0.3] }, position: [0, 3, 0],
    voxelSize: 0.05, rebar: { diameter: 0.02, spacing: 0.1, cover: 0.03, layout: 'cage' }, dynamic: true,
  }) as VoxelElement;
  // Strip the concrete off so every bar shows.
  for (let k = 0; k < el.grid.nz; k++) for (let j = 0; j < el.grid.ny; j++) for (let i = 0; i < el.grid.nx; i++) if (el.grid.density(i, j, k) > 0) {
    el.grid.locate(i, j, k);
    if (el.grid.state[el.grid.ci] !== 2) el.grid.ensureMixed(el.grid.ci);
    el.grid.writeDensity(el.grid.ci, el.grid.li, j, 0);
  }
  el.rebar!.version++;
  el.frameUpdate(0);
  const bars = ctx.world.children.find((o) => o.name.includes('rubble-rebar')) as THREE.BatchedMesh;
  assert.ok(bars, 'rebar batch');
  const g = bars.geometry, P = g.getAttribute('position'), N = g.getAttribute('normal'), I = g.getIndex()!;
  const used = I.count - bars.unusedIndexCount;
  assert.ok(used > 0);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  let outward = 0, tris = 0;
  for (let t = 0; t < used; t += 3) {
    a.fromBufferAttribute(P, I.getX(t)); b.fromBufferAttribute(P, I.getX(t + 1)); c.fromBufferAttribute(P, I.getX(t + 2));
    n.fromBufferAttribute(N, I.getX(t));
    const f = b.sub(a).cross(c.sub(a));
    if (f.lengthSq() === 0) continue;
    tris++;
    if (f.dot(n) > 0) outward++;
  }
  assert.equal(outward, tris, `${tris - outward} of ${tris} bar triangles face inwards`);
  el.dispose();
});
