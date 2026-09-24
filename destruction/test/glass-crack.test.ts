import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CrackGraph, SEG_ARC, SEG_RADIAL } from '../src/destructibles/glass/crackGraph.ts';
import { growStar } from '../src/destructibles/glass/cracks.ts';
import { blastStar, impactStar } from '../src/destructibles/glass/model.ts';
import { polyArea, pointInPoly } from '../src/destructibles/glass/polygon.ts';
import { Rng } from '../src/core/rng.ts';

function rngFn(seed: number): () => number {
  const r = new Rng(seed);
  return () => r.next();
}

/** Faces must be closed CCW polygons whose net areas tile the pane. */
function checkTiling(g: CrackGraph, label: string): number {
  const faces = g.faces();
  let sum = 0;
  for (const f of faces) {
    assert.ok(f.outer.length >= 6, `${label}: face with fewer than 3 vertices`);
    assert.ok(polyArea(f.outer) > 0, `${label}: outline must be counter-clockwise`);
    for (const h of f.holes) assert.ok(polyArea(h) < 0, `${label}: holes must be clockwise`);
    assert.ok(f.area > 0, `${label}: net area must be positive`);
    assert.ok(pointInPoly(f.outer, f.sample[0], f.sample[1]), `${label}: sample point outside its face`);
    for (const h of f.holes) assert.ok(!pointInPoly(h, f.sample[0], f.sample[1]), `${label}: sample point inside a hole`);
    sum += f.area;
  }
  const A = g.w * g.h;
  assert.ok(Math.abs(sum - A) / A < 0.01, `${label}: face areas sum to ${sum.toFixed(5)} m², pane ${A.toFixed(5)} m²`);
  return faces.length;
}

test('an uncracked pane is one face with the full area', () => {
  const g = new CrackGraph(1.5, 1.0);
  const faces = g.faces();
  assert.equal(faces.length, 1);
  assert.ok(Math.abs(faces[0]!.area - 1.5) < 1e-12);
  assert.deepEqual(faces[0]!.edge.map((e) => Number(e.toFixed(9))), [1.5, 1, 1.5, 1]);
});

test('a straight crack across the pane splits it into two faces that tile it', () => {
  const g = new CrackGraph(2, 1);
  let v = g.pointVertex(0, -0.5, 1e-6);
  assert.ok(v >= 0, 'start vertex on the bottom edge');
  for (let y = -0.4; y < 0.6; y += 0.1) {
    const r = g.grow(v, 0.02 * Math.sin(y * 9), y, SEG_RADIAL);
    v = r.v;
    if (r.blocked) break;
  }
  assert.equal(checkTiling(g, 'split'), 2);
});

test('a later crack terminates on an earlier one (no crossings)', () => {
  const g = new CrackGraph(1, 1);
  let v = g.pointVertex(-0.5, 0, 1e-6);
  for (let x = -0.4; x <= 0.55; x += 0.1) v = g.grow(v, x, 0, SEG_RADIAL).v;
  let u = g.pointVertex(0.05, -0.5, 1e-6);
  let stoppedAt = 0;
  for (let y = -0.4; y <= 0.55; y += 0.1) {
    const r = g.grow(u, 0.05, y, SEG_RADIAL);
    u = r.v;
    if (r.blocked) {
      stoppedAt = g.vy[u]!;
      break;
    }
  }
  assert.ok(Math.abs(stoppedAt) < 1e-9, `second crack stopped at y = ${stoppedAt}`);
  assert.equal(checkTiling(g, 'T'), 3);
});

test('rifle hit on annealed glass: hole, radials and arcs tile the pane; loose spider cells exist', () => {
  const rnd = rngFn(11);
  const g = new CrackGraph(1.5, 1.6);
  const spec = impactStar('annealed', 342, 0.006, 0.0045, Math.hypot(1.5, 1.6), rnd);
  assert.ok(spec.radials >= 7 && spec.radials <= 12, `radials ${spec.radials}`);
  assert.ok(spec.length > 0.25 && spec.length < 1.5, `radial length ${spec.length}`);
  const res = growStar(g, 0.1, -0.05, 0.0045, spec, rnd);
  assert.ok(res.hole.length >= 16);
  assert.ok(g.crackCount() > spec.radials * 5);
  checkTiling(g, 'single hit');
});

test('many overlapping hits (sustained fire) still tile the pane within 1 %', () => {
  const rnd = rngFn(3);
  const g = new CrackGraph(1.5, 1.6);
  for (let k = 0; k < 40; k++) {
    const x = (rnd() - 0.5) * 0.5, y = (rnd() - 0.5) * 0.5;
    const spec = impactStar('annealed', 150 + 400 * rnd(), 0.008, 0.004, 2.2, rnd);
    growStar(g, x, y, 0.004 + 0.002 * rnd(), spec, rnd);
    if (k % 10 === 9) checkTiling(g, `burst ${k + 1}`);
  }
  const n = checkTiling(g, 'burst 40');
  assert.ok(n > 40, `expected many pieces, got ${n}`);
});

test('hits right at the pane edge and corner keep the graph valid', () => {
  const rnd = rngFn(5);
  const g = new CrackGraph(1.2, 0.8);
  for (const [x, y] of [[0.598, 0.1], [-0.6, -0.4], [0.3, 0.399], [0.0, -0.3995]] as const) {
    growStar(g, x, y, 0.005, impactStar('annealed', 500, 0.006, 0.005, 1.5, rnd), rnd);
    checkTiling(g, `edge hit ${x},${y}`);
  }
});

test('blast pattern breaks the pane into many pieces sized by the damage number', () => {
  const small = new CrackGraph(1.5, 1.0);
  growStar(small, 0, 0, 0, blastStar(1.2, 1.5, 1.0, rngFn(2)), rngFn(4));
  const nSmall = checkTiling(small, 'blast D=1.2');
  const big = new CrackGraph(1.5, 1.0);
  growStar(big, 0, 0, 0, blastStar(8, 1.5, 1.0, rngFn(2)), rngFn(4));
  const nBig = checkTiling(big, 'blast D=8');
  assert.ok(nBig > nSmall * 1.5, `higher load must give finer fragments: ${nSmall} vs ${nBig}`);
});

test('laminated star is a denser spider web than annealed', () => {
  const a = impactStar('annealed', 500, 0.01, 0.004, 2, rngFn(9));
  const l = impactStar('laminated', 500, 0.01, 0.004, 2, rngFn(9));
  assert.ok(l.rings.length > a.rings.length);
  assert.ok(l.length < a.length);
  const g = new CrackGraph(1.2, 1.2);
  growStar(g, 0, 0, 0.004, l, rngFn(10));
  let arcs = 0;
  for (let s = 0; s < g.segmentCount; s++) if (g.live[s] && g.kind[s] === SEG_ARC) arcs++;
  assert.ok(arcs > 20, `arc segments ${arcs}`);
  checkTiling(g, 'laminated');
});
