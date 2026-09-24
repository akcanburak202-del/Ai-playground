import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { StructureGraph, PRESENCE_MIN, delay, type GraphHost } from '../src/structure/StructureGraph.ts';
import type { Destructible, DestructibleKind, RayHit, Structural } from '../src/destructibles/Destructible.ts';
import { MATERIALS } from '../src/physics/materials.ts';
import type { SimEvents, StructuralFailureEvent } from '../src/app/contracts.ts';

/**
 * Mock element: a box with a weight. It records anchors and imposed loads, reports a settable
 * presence, and — like the real elements — falls (fails) when its last anchor is released.
 */
class MockEl implements Destructible, Structural {
  static next = 1;
  readonly id = MockEl.next++;
  readonly root = new THREE.Object3D();
  readonly bounds: THREE.Box3;
  readonly structural: Structural = this;
  disposed = false;
  failed = false;
  presence = 1;
  imposed: number[] = [];
  anchors = new Set<string>();
  released: { id: string; time: number }[] = [];
  presenceCalls = 0;
  readonly kind: DestructibleKind;
  readonly name: string;
  private readonly w: number;
  private readonly host: Host;
  constructor(host: Host, name: string, min: [number, number, number], max: [number, number, number], weightN: number, kind: DestructibleKind = 'voxel') {
    this.host = host;
    this.name = name;
    this.bounds = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
    this.w = weightN;
    this.kind = kind;
  }
  weight(): number {
    return this.failed ? 0 : this.w;
  }
  addAnchor(id: string): void {
    this.anchors.add(id);
  }
  supportPresence(): number {
    this.presenceCalls++;
    return this.failed ? 0 : this.presence;
  }
  releaseAnchor(id: string): void {
    this.anchors.delete(id);
    this.released.push({ id, time: this.host.time.now });
    if (this.anchors.size === 0) this.failed = true;
  }
  setImposedLoad(n: number): void {
    this.imposed.push(n);
  }
  hasFailed(): boolean {
    return this.failed;
  }
  get lastLoad(): number {
    return this.imposed.at(-1) ?? 0;
  }
  raycast(_o: THREE.Vector3, _d: THREE.Vector3, _max: number): RayHit | null {
    return null;
  }
  probe() {
    return { segments: [], exits: true };
  }
  applyImpact(): void {}
  applyBlast(): void {}
  dispose(): void {
    this.disposed = true;
  }
}

interface Host extends GraphHost {
  time: { now: number };
  failures: StructuralFailureEvent[];
}

function host(): Host {
  const failures: StructuralFailureEvent[] = [];
  return {
    time: { now: 0 },
    failures,
    events: {
      emit<K extends keyof SimEvents>(type: K, payload: SimEvents[K]) {
        if (type === 'structuralFailure') failures.push(payload as StructuralFailureEvent);
      },
    },
  };
}

function run(g: StructureGraph, h: Host, seconds: number, dt = 1 / 60): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    h.time.now += dt;
    g.update(dt);
  }
}

/** Contact band at the top of `a` under `b`. */
function top(a: MockEl, b: MockEl): THREE.Box3 {
  return new THREE.Box3(
    new THREE.Vector3(Math.max(a.bounds.min.x, b.bounds.min.x), a.bounds.max.y - 0.05, Math.max(a.bounds.min.z, b.bounds.min.z)),
    new THREE.Vector3(Math.min(a.bounds.max.x, b.bounds.max.x), a.bounds.max.y + 0.05, Math.min(a.bounds.max.z, b.bounds.max.z)),
  );
}
function base(a: MockEl): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(a.bounds.min.x, -0.05, a.bounds.min.z), new THREE.Vector3(a.bounds.max.x, 0.05, a.bounds.max.z));
}

/** Ground → two walls → slab → block on the slab (off centre). */
function frame(h: Host) {
  const g = new StructureGraph(h);
  const wallA = new MockEl(h, 'wall A', [-3, 0, -2], [-2.8, 3, 2], 60e3);
  const wallB = new MockEl(h, 'wall B', [2.8, 0, -2], [3, 3, 2], 60e3);
  const slab = new MockEl(h, 'slab', [-3, 3, -2], [3, 3.2, 2], 100e3);
  const block = new MockEl(h, 'block', [-1.5, 3.2, -0.5], [-0.5, 4.2, 0.5], 20e3);
  g.link('ground', wallA, base(wallA));
  g.link('ground', wallB, base(wallB));
  g.link(wallA, slab, top(wallA, slab));
  g.link(wallB, slab, top(wallB, slab));
  g.link(slab, block, top(slab, block));
  return { g, wallA, wallB, slab, block };
}

test('gravity load flows top-down by the lever rule', () => {
  const h = host();
  const { g, wallA, wallB, slab, block } = frame(h);
  run(g, h, 1 / 60);
  // The block sits 1 m left of centre on a 5.8 m span: by the lever rule the left wall takes
  // (2.9 + 1)/5.8 of it; the slab itself is centred and splits evenly.
  assert.equal(slab.lastLoad, 20e3);
  const expectA = 50e3 + 20e3 * (3.9 / 5.8);
  assert.ok(Math.abs(wallA.lastLoad - expectA) < 0.01 * expectA, `wall A ${wallA.lastLoad} vs ${expectA}`);
  assert.ok(wallA.lastLoad > wallB.lastLoad, 'the nearer wall takes more of the block');
  // Everything reaches the ground: 120 kN of slab + block over the two walls.
  assert.ok(Math.abs(wallA.lastLoad + wallB.lastLoad - 120e3) < 1);
  // Nothing is pushed again while nothing changes.
  const pushes = g.stats.pushes;
  run(g, h, 2);
  assert.equal(g.stats.pushes, pushes);
  assert.equal(block.imposed.length, 0, 'an element that carries nothing gets no load');
});

test('a continuous member shares its load by tributary lengths', () => {
  const h = host();
  const g = new StructureGraph(h);
  // A 12 m beam over three columns, and a floor strip resting on the whole beam.
  const cols = [-6, 0, 6].map((x) => new MockEl(h, `col ${x}`, [x - 0.1, 0, -0.1], [x + 0.1, 3.4, 0.1], 5e3, 'beam'));
  const beam = new MockEl(h, 'beam', [-6.1, 3.4, -0.1], [6.1, 3.8, 0.1], 7e3, 'beam');
  const floor = new MockEl(h, 'floor', [-6.3, 3.8, -1], [6.3, 4, 1], 250e3);
  for (const c of cols) {
    g.link('ground', c, base(c));
    g.link(c, beam, new THREE.Box3(new THREE.Vector3(c.bounds.min.x - 0.1, 3.3, -0.2), new THREE.Vector3(c.bounds.max.x + 0.1, 3.8, 0.2)));
  }
  g.link(beam, floor, top(beam, floor));
  run(g, h, 1 / 60);
  const total = cols.reduce((s, c) => s + c.lastLoad, 0);
  assert.ok(Math.abs(total - 257e3) < 1, `total ${total}`);
  const [a, m, b] = cols.map((c) => c.lastLoad / total);
  // Tributary lengths give 25 / 50 / 25 %; a 2-span continuous beam 19 / 62 / 19 %. Anything in
  // that neighbourhood is fine; the old centroid rule gave the middle 93 %.
  assert.ok(m! > 0.4 && m! < 0.65, `middle ${m}`);
  assert.ok(a! > 0.17 && a! < 0.32 && Math.abs(a! - b!) < 1e-6, `ends ${a} ${b}`);
});

test('a failed support cascades level by level with realistic delays', () => {
  const h = host();
  const { g, wallA, wallB, slab, block } = frame(h);
  run(g, h, 0.1);
  // Wall A loses its top (material shot away) and B is blown down entirely.
  wallA.presence = 0.5; // still holds
  g.touch(wallA);
  run(g, h, 0.2);
  assert.equal(slab.released.length, 0, `presence 0.5 ≥ ${PRESENCE_MIN} keeps the slab`);
  const t0 = h.time.now;
  wallB.failed = true;
  wallA.presence = 0.1;
  g.touch(wallA);
  run(g, h, 1);
  assert.equal(slab.released.length, 2, 'both slab anchors released');
  for (const r of slab.released) {
    const dt = r.time - t0;
    assert.ok(dt >= 0.03 && dt <= 0.15 + 1 / 60, `slab release after ${dt.toFixed(3)} s`);
  }
  assert.ok(slab.failed, 'slab fell');
  assert.equal(block.released.length, 1, 'block released after the slab went');
  const tSlab = Math.max(...slab.released.map((r) => r.time));
  const tBlock = block.released[0]!.time;
  assert.ok(tBlock - tSlab >= 0.03, `the block goes one level later (${(tBlock - tSlab).toFixed(3)} s)`);
  // One failure event per element that lost its last support, in order.
  assert.deepEqual(h.failures.map((f) => f.label), ['slab', 'block']);
  assert.equal(h.failures[0]!.cause, 'support-lost');
  assert.ok(Math.abs(h.failures[0]!.mass - 100e3 / 9.80665) < 1);
  // Ground links are permanent.
  assert.equal(wallA.released.length, 0);
  assert.equal(wallB.released.length, 0);
});

test('remove() of a supporter releases its dependents and unloads the walls', () => {
  const h = host();
  const { g, wallA, wallB, slab, block } = frame(h);
  run(g, h, 0.1);
  const before = wallA.lastLoad;
  slab.disposed = true;
  g.remove(slab);
  run(g, h, 0.5);
  assert.equal(block.released.length, 1);
  assert.ok(block.failed);
  // The walls no longer carry the slab or the block (a decrease is pushed after its hold-off).
  assert.ok(before > 50e3);
  assert.equal(wallA.lastLoad, 0);
  assert.equal(wallB.lastLoad, 0);
});

test('release timing does not depend on the step (slow motion)', () => {
  const times: number[] = [];
  for (const dt of [1 / 60, 1 / 240, 0.001]) {
    const h = host();
    const { g, wallB, slab } = frame(h);
    run(g, h, 0.05, dt);
    wallB.failed = true;
    const t0 = h.time.now;
    run(g, h, 0.4, dt);
    const r = slab.released.find((x) => x.id.length > 0)!;
    times.push(r.time - t0);
    for (const l of g.linksOf()) assert.ok(Number.isFinite(l.load));
  }
  // Same delay to within one coarse step.
  assert.ok(Math.max(...times) - Math.min(...times) <= 1 / 60 + 1e-9, times.join(', '));
});

test('lateral restraints carry gravity only when nothing bears underneath', () => {
  const h = host();
  const g = new StructureGraph(h);
  const side = new MockEl(h, 'side wall', [-0.3, 0, -3], [0, 6, 3], 300e3);
  // A panel resting on the ground and tied to the side wall at its edge …
  const lower = new MockEl(h, 'lower panel', [0, 0, 0.1], [0.3, 3.5, 2.9], 60e3);
  // … and one above a slit, held only by its edge.
  const upper = new MockEl(h, 'upper panel', [0, 3.7, 0.1], [0.3, 6, 2.9], 40e3);
  g.link('ground', side, base(side));
  g.link('ground', lower, base(lower));
  const edge = (p: MockEl) => new THREE.Box3(new THREE.Vector3(-0.05, p.bounds.min.y, 0.1), new THREE.Vector3(0.05, p.bounds.max.y, 0.4));
  g.link(side, lower, edge(lower));
  g.link(side, upper, edge(upper));
  run(g, h, 1 / 60);
  const links = g.linksOf(upper);
  assert.equal(links.length, 1);
  assert.equal(links[0]!.bearing, false);
  assert.equal(g.linksOf(lower).filter((l) => l.bearing).length, 1);
  // The side wall takes the hanging panel but not the one standing on the ground.
  assert.ok(Math.abs(side.lastLoad - 40e3) < 1, `side wall ${side.lastLoad}`);
});

test('cycles and degenerate input stay finite', () => {
  const h = host();
  const g = new StructureGraph(h);
  const a = new MockEl(h, 'a', [0, 0, 0], [1, 1, 1], 10e3);
  const b = new MockEl(h, 'b', [0, 1, 0], [1, 2, 1], 10e3);
  const nan = new MockEl(h, 'nan', [0, 2, 0], [1, 3, 1], Number.NaN);
  g.link('ground', a, base(a));
  g.link(a, b, top(a, b));
  g.link(b, a, top(a, b)); // a mistake a scene could make
  g.link(b, nan, top(b, nan));
  run(g, h, 0.2);
  for (const el of [a, b]) for (const n of el.imposed) assert.ok(Number.isFinite(n) && n >= 0);
  g.update(0);
  g.update(Number.NaN);
  assert.ok(g.stats.flows >= 1);
});

test('external loads reach the ground through the supports', () => {
  const h = host();
  const g = new StructureGraph(h);
  const column = new MockEl(h, 'HEB 300', [-0.15, 0, -0.15], [0.15, 4, 0.15], 4.6e3, 'beam');
  const cap = new MockEl(h, 'load block', [-0.8, 4, -0.8], [0.8, 4.8, 0.8], 48e3);
  g.link('ground', column, base(column));
  g.link(column, cap, top(column, cap));
  g.setExternalLoad(cap, 1.152e6);
  run(g, h, 1 / 60);
  assert.ok(Math.abs(column.lastLoad - 1.2e6) < 1, `column carries ${column.lastLoad}`);
  assert.equal(g.imposedLoad(column), column.lastLoad);
});

test('the bearing delay is the free-fall time through the bearing deformation', () => {
  const h = host();
  const mk = (kind: DestructibleKind) => ({ el: new MockEl(h, kind, [0, 0, 0], [1, 1, 1], 1, kind) });
  for (let i = 0; i < 50; i++) {
    const concrete = delay({ id: `x${i}`, supporter: mk('voxel'), supported: mk('voxel') });
    const steel = delay({ id: `x${i}`, supporter: mk('beam'), supported: mk('voxel') });
    const glass = delay({ id: `x${i}`, supporter: mk('voxel'), supported: mk('glass') });
    assert.ok(concrete > 0.85 * Math.sqrt(0.04 / 9.80665) - 1e-9 && concrete < 1.15 * Math.sqrt(0.04 / 9.80665) + 1e-9);
    assert.ok(steel > concrete * 1.2);
    assert.ok(glass < concrete);
    for (const t of [concrete, steel, glass]) assert.ok(t >= 0.03 && t <= 0.15);
  }
});

test('a steel member that sags away from what it carries lets go of it', () => {
  const h = host();
  const g = new StructureGraph(h);
  // A beam whose top surface follows `top(x)`; it keeps all its material (presence stays 1).
  class SaggingBeam extends MockEl {
    sag = 0;
    override raycast(o: THREE.Vector3, d: THREE.Vector3, maxDist: number): RayHit | null {
      if (d.y > -0.99) return null;
      const t = (o.x + 3) / 6; // 0 at the fixed end, 1 at the free end
      const y = 3 - this.sag * t * t;
      const dist = o.y - y;
      if (dist < 0 || dist > maxDist || Math.abs(o.z) > 0.09) return null;
      return { target: this, point: new THREE.Vector3(o.x, y, o.z), normal: new THREE.Vector3(0, 1, 0), distance: dist, material: MATERIALS.steel_s355 };
    }
  }
  const beam = new SaggingBeam(h, 'IPE', [-3, 2.6, -0.09], [3, 3, 0.09], 3e3, 'beam');
  const slab = new MockEl(h, 'slab', [-3, 3, -2], [3, 3.2, 2], 60e3);
  const wall = new MockEl(h, 'wall', [-3, 0, 1.8], [3, 3, 2], 60e3);
  g.link('ground', beam, base(beam));
  g.link('ground', wall, base(wall));
  g.link(beam, slab, top(beam, slab));
  g.link(wall, slab, top(wall, slab));
  run(g, h, 1);
  assert.equal(slab.released.length, 0, 'in place: nothing released');
  beam.sag = 0.03; // elastic sag: still bearing
  run(g, h, 1);
  assert.equal(slab.released.length, 0, 'a 3 cm sag still bears');
  beam.sag = 0.6; // plastic hinge at the support: the far half has dropped away
  run(g, h, 1);
  assert.equal(slab.released.length, 1, 'the sagged beam lets the slab go');
  assert.equal(slab.failed, false, 'the slab still has its wall');
  assert.equal(beam.presenceCalls > 0, true);
});
