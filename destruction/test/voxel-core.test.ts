import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoxelGrid, ISO } from '../src/destructibles/voxel/grid.ts';
import { BoxShape, CylinderShape, CustomShape, fillGrid, layoutFor } from '../src/destructibles/voxel/shape.ts';
import { meshAll, type MeshData } from '../src/destructibles/voxel/mesher.ts';
import { Carver } from '../src/destructibles/voxel/carve.ts';
import { traceRay, probeRun, type TraceHit, type RunSegment } from '../src/destructibles/voxel/trace.ts';
import { layoutRebar } from '../src/destructibles/voxel/rebar.ts';

function build(shape: BoxShape | CylinderShape | CustomShape, h = 0.025) {
  const g = new VoxelGrid(layoutFor(shape, h));
  fillGrid(g, shape);
  return g;
}

/** Merge vertices by exact position and count how many triangles use each undirected edge. */
function edgeUse(m: MeshData): { bad: number; odd: number; edges: number; oriented: boolean } {
  const key = new Map<string, number>();
  const id = new Int32Array(m.vertexCount);
  for (let v = 0; v < m.vertexCount; v++) {
    const k = `${m.positions[v * 3]},${m.positions[v * 3 + 1]},${m.positions[v * 3 + 2]}`;
    let i = key.get(k);
    if (i === undefined) key.set(k, (i = key.size));
    id[v] = i;
  }
  const count = new Map<string, number>();
  const directed = new Map<string, number>();
  for (let t = 0; t < m.indexCount; t += 3) {
    const a = id[m.indices[t]!]!, b = id[m.indices[t + 1]!]!, c = id[m.indices[t + 2]!]!;
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const k = p < q ? `${p}-${q}` : `${q}-${p}`;
      count.set(k, (count.get(k) ?? 0) + 1);
      const dk = `${p}>${q}`;
      directed.set(dk, (directed.get(dk) ?? 0) + 1);
    }
  }
  let bad = 0, odd = 0;
  for (const n of count.values()) {
    if (n !== 2) bad++;
    if (n % 2 === 1) odd++;
  }
  let oriented = true;
  for (const [k, n] of directed) {
    const [p, q] = k.split('>');
    if (n !== 1 || directed.get(`${q}>${p}`) !== 1) oriented = false;
  }
  return { bad, odd, edges: count.size, oriented };
}

test('box grid: faces on mid-planes, solid volume matches', () => {
  const shape = new BoxShape([1.0, 0.5, 0.25]);
  const g = build(shape);
  assert.ok(Math.abs(g.solidVolume() - shape.volume) / shape.volume < 0.02, `volume ${g.solidVolume()} vs ${shape.volume}`);
  // −X face lies halfway between samples 1 and 2.
  assert.ok(Math.abs(g.ox + 1.5 * g.h + 0.5) < 1e-9);
});

test('surface nets: pristine box is watertight, consistently oriented and exactly coplanar', () => {
  for (const size of [[1.0, 0.5, 0.25], [1.013, 0.47, 0.23]] as [number, number, number][]) {
    const shape = new BoxShape(size);
    const g = build(shape);
    const m = meshAll(g, shape)!;
    const e = edgeUse(m);
    assert.equal(e.bad, 0, `non-manifold edges: ${e.bad} of ${e.edges}`);
    assert.ok(e.oriented, 'inconsistent winding');
    const [hx, hy, hz] = shape.half;
    let onFace = 0;
    for (let v = 0; v < m.vertexCount; v++) {
      const x = m.positions[v * 3]!, y = m.positions[v * 3 + 1]!, z = m.positions[v * 3 + 2]!;
      // Every pristine vertex lies on the box surface.
      const d = Math.min(Math.abs(Math.abs(x) - hx), Math.abs(Math.abs(y) - hy), Math.abs(Math.abs(z) - hz));
      assert.ok(d < 1e-5, `vertex off the surface by ${d}`);
      assert.ok(Math.abs(x) <= hx + 1e-5 && Math.abs(y) <= hy + 1e-5 && Math.abs(z) <= hz + 1e-5);
      if (Math.abs(z - hz) < 1e-6) onFace++;
    }
    assert.ok(onFace > 100);
    // Outward orientation: triangles on the +Z face have +Z geometric normals.
    for (let t = 0; t < m.indexCount; t += 3) {
      const a = m.indices[t]! * 3, b = m.indices[t + 1]! * 3, c = m.indices[t + 2]! * 3;
      const P = m.positions;
      if (Math.abs(P[a + 2]! - hz) > 1e-6 || Math.abs(P[b + 2]! - hz) > 1e-6 || Math.abs(P[c + 2]! - hz) > 1e-6) continue;
      const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!;
      assert.ok(ux * vy - uy * vx > 0, 'front face points inwards');
    }
  }
});

test('surface nets: sphere and carved box stay watertight across chunk seams', () => {
  const sphere = new CustomShape([0.9, 0.9, 0.9], (x, y, z) => Math.hypot(x, y, z) - 0.4);
  const gs = build(sphere, 0.02);
  const ms = meshAll(gs, sphere)!;
  assert.equal(edgeUse(ms).bad, 0);
  const shape = new BoxShape([1.2, 0.8, 0.3]);
  const g = build(shape);
  const c = new Carver(g);
  const r = { lobe: 0.02, lobeScale: 0.05, grain: 0.006, seed: 3 };
  c.cone(0.01, 0.02, 0.15, 0, 0, -1, 0.12, 0.1, r);
  c.capsule(-0.3, -0.2, 0.2, -0.3, -0.2, -0.2, 0.05, r); // through-hole
  c.damage(0.0, 0.0, 0.1, 0.2, 0.6, 1);
  const m = meshAll(g, shape)!;
  const e = edgeUse(m);
  // Closed everywhere (no boundary edges at chunk seams). Naive Surface Nets may pinch two sheets
  // through one vertex pair at ambiguous cells of a noisy carve: allow a handful of 4-way edges.
  assert.equal(e.odd, 0, `boundary edges after carving: ${e.odd}`);
  assert.ok(e.bad <= e.edges * 0.002, `non-manifold edges after carving: ${e.bad} of ${e.edges}`);
});

test('fluted tapered cylinder voxelises round with the right volume', () => {
  const shape = new CylinderShape(0.3, 2.0, 20, 0.1);
  const g = build(shape, 0.02);
  const rel = Math.abs(g.solidVolume() - shape.volume) / shape.volume;
  assert.ok(rel < 0.03, `volume error ${rel}`);
  const m = meshAll(g, shape)!;
  assert.equal(edgeUse(m).bad, 0);
});

test('ray trace hits the box face with the analytic normal; probe measures the thickness', () => {
  const shape = new BoxShape([2, 1, 0.25]);
  const g = build(shape);
  const hit: TraceHit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, bar: -1 };
  const box: [number, number, number, number, number, number] = [0, 0, 0, g.nx - 1, g.ny - 1, g.nz - 1];
  assert.ok(traceRay(g, box, null, 0.1, 0.05, 2, 0, 0, -1, 10, hit));
  assert.ok(Math.abs(hit.z - 0.125) < 1e-3, `hit z ${hit.z}`);
  assert.ok(hit.nz > 0.99);
  const segs: RunSegment[] = [];
  const exits = probeRun(g, null, hit.x, hit.y, hit.z, 0, 0, -1, 1, segs);
  assert.ok(exits);
  const len = segs[segs.length - 1]!.end;
  assert.ok(Math.abs(len - 0.25) < 0.015, `run ${len}`);
  assert.equal(segs[0]!.strength, 1);
  // Oblique ray
  const d = [0.3, -0.2, -1];
  const l = Math.hypot(...d);
  assert.ok(traceRay(g, box, null, -0.3, 0.2, 1, d[0]! / l, d[1]! / l, d[2]! / l, 10, hit));
  assert.ok(Math.abs(hit.z - 0.125) < 2e-3);
  // Miss
  assert.ok(!traceRay(g, box, null, 5, 5, 5, 0, 0, -1, 10, hit));
});

test('probe finds the rebar mesh and damage lowers the strength', () => {
  const shape = new BoxShape([2, 2, 0.25]);
  const g = build(shape);
  const rebar = layoutRebar(shape, { diameter: 0.016, spacing: 0.2, cover: 0.04, layout: 'two-faces' })!;
  rebar.register(g);
  const segs: RunSegment[] = [];
  // Aim straight at a vertical bar of the +Z mesh: bars along y at x = −0.92 + 0.2·i (≤ spacing, spanning).
  const n = rebar.nodes;
  let bx = 0;
  for (let s = 0; s < rebar.segCount; s++) {
    const a = rebar.segA[s]! * 3, b = rebar.segB[s]! * 3;
    if (Math.abs(n[a]! - n[b]!) < 1e-6 && n[a + 2]! > 0) { bx = n[a]!; break; }
  }
  probeRun(g, rebar, bx, 0.013, 0.125, 0, 0, -1, 1, segs);
  const steel = segs.filter((s) => s.steel);
  assert.ok(steel.length >= 2, `expected bars at both faces, got ${steel.length}`);
  assert.ok(Math.abs(steel[0]!.start - 0.04) < 0.004, `first bar at ${steel[0]!.start}`);
  const c = new Carver(g);
  c.damage(0, 0, 0.125, 0.3, 0.9, 1);
  const segs2: RunSegment[] = [];
  probeRun(g, null, 0.0, 0.0, 0.125, 0, 0, -1, 1, segs2);
  assert.ok(segs2[0]!.strength < 0.8, `strength ${segs2[0]!.strength}`);
});

test('carving removes about the analytic volume', () => {
  const shape = new BoxShape([1, 1, 0.5]);
  const g = build(shape, 0.02);
  const c = new Carver(g);
  const v0 = g.solidVolume();
  const r = { lobe: 0, lobeScale: 1, grain: 0, seed: 0 };
  c.sphere(0, 0, 0.25, 0.1, r);
  const hemi = (2 / 3) * Math.PI * 0.1 ** 3;
  const removed = v0 - g.solidVolume();
  assert.ok(Math.abs(removed - hemi) / hemi < 0.1, `removed ${removed} vs ${hemi}`);
  assert.ok(g.density(g.nx >> 1, g.ny >> 1, Math.round(g.gz(0.25 - 0.05))) < ISO);
});
