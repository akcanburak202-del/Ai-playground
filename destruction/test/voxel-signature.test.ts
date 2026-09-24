import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createVoxelElement } from '../src/destructibles/voxel/index.ts';
import { VoxelElement } from '../src/destructibles/voxel/VoxelElement.ts';
import { STUB_AMMO, fireStub, measureCrater } from '../src/destructibles/voxel/testing.ts';
import { makeCtx } from '../src/destructibles/voxel/headless.ts';

/**
 * THE signature behaviour: sustained 5.56 fire on one spot of a 25 cm RC wall digs a crater that
 * widens and deepens, exposes the rebar mesh and eventually holes through behind the bars
 * (cf. FM 3-06.11: 5.56 mm needs ~250 rounds to loophole 20 cm of reinforced concrete and cannot
 * cut the bars).
 */
test('200+ rounds of 5.56 on one spot of a 25 cm RC wall', async () => {
  const ctx = await makeCtx();
  const t0 = performance.now();
  const wall = createVoxelElement(ctx, {
    name: 'rc-wall', material: 'concrete', finish: 'board-formed-concrete', shape: { type: 'box', size: [4, 3, 0.25] },
    position: [0, 1.5, 0], rebar: { diameter: 0.016, spacing: 0.2, cover: 0.04, layout: 'two-faces' },
  }) as VoxelElement;
  const buildMs = performance.now() - t0;
  ctx.structure.link('ground', wall, new THREE.Box3(new THREE.Vector3(-2, -0.05, -0.2), new THREE.Vector3(2, 0.05, 0.2)));
  const aim = new THREE.Vector3(0.1, 1.45, 0.125);
  const from = new THREE.Vector3(0.1, 1.5, 25);
  // A burst at 25 m: ±5 cm (2σ) at the wall.
  const sigma = 0.025;
  const rng = ctx.rng;
  const log: string[] = [`build ${buildMs.toFixed(0)} ms`];
  let carveMs = 0, shots = 0;
  const report = (n: number) => {
    const m = measureCrater(wall, aim, new THREE.Vector3(0, 0, 1), 0.3, 0.01);
    log.push(`${n} rounds: crater Ø ${(m.diameter * 100).toFixed(1)} cm (extent ${(m.extent * 100).toFixed(0)} cm), depth ${(m.maxDepth * 100).toFixed(1)} cm, through ${m.through}, on bars ${m.onBar}`);
    return m;
  };
  const stages: Record<number, ReturnType<typeof measureCrater>> = {};
  for (let i = 1; i <= 300; i++) {
    const at = aim.clone().add(new THREE.Vector3(rng.gaussian(0, sigma), rng.gaussian(0, sigma), 0));
    const t = performance.now();
    fireStub(ctx, STUB_AMMO.m855, from, at);
    carveMs += wall.stats.lastCarveMs;
    shots++;
    void t;
    for (let s = 0; s < 5; s++) ctx.step(0.075 / 5);
    if (i === 1 || i === 30 || i === 100 || i === 200 || i === 250 || i === 300) stages[i] = report(i);
  }
  log.push(`mean carve ${(carveMs / shots).toFixed(3)} ms/hit, last check ${wall.stats.lastCheckMs.toFixed(1)} ms`);
  console.log(log.join('\n'));
  const s1 = stages[1]!, s30 = stages[30]!, s100 = stages[100]!, s200 = stages[200]!, s250 = stages[250]!;
  // Single hit: calibration table (Ø 40–90 mm, depth 15–40 mm).
  assert.ok(s1.diameter > 0.035 && s1.diameter < 0.1, `single crater Ø ${s1.diameter}`);
  assert.ok(s1.maxDepth > 0.012 && s1.maxDepth < 0.045, `single crater depth ${s1.maxDepth}`);
  // Progressive: wider and deeper with every stage.
  assert.ok(s30.diameter > s1.diameter && s100.diameter > s30.diameter && s200.diameter >= s100.diameter * 0.95);
  assert.ok(s100.maxDepth > s30.maxDepth);
  // 200 rounds: crater 15–30 cm wide, past the bars (cover 40 mm + 16 mm bar).
  assert.ok(s200.diameter > 0.15 && s200.diameter < 0.32, `200-round crater Ø ${s200.diameter}`);
  assert.ok(s200.maxDepth > 0.1, `200-round depth ${s200.maxDepth}`);
  // Not holed too early.
  assert.ok(s100.through === 0, 'holed through by 100 rounds');
  assert.ok(s200.onBar > 0, 'rebar exposed');
  // ~250 rounds: holed through behind the bars.
  assert.ok(s250.through > 0 || stages[300]!.through > 0, 'no loophole after 300 rounds');
  // Generous bound: the suite often runs beside headless render jobs on a shared machine.
  // Wall-clock: only catch gross regressions (the suite often shares the machine with render jobs).
  assert.ok(carveMs / shots < 12, `carve cost ${carveMs / shots} ms`);
});
