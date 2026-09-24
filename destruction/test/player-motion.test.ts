import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approach, fovForZoom, isFollowable, rampTimeScale, RecoilSpring, wrapAngle } from '../src/player/motion.ts';
import { getAmmo } from '../src/physics/ballistics/ammo.ts';

test('approach is frame-rate independent', () => {
  let a = 0;
  for (let i = 0; i < 1000; i++) a = approach(a, 1, 0.001, 0.1);
  const b = approach(0, 1, 1, 0.1);
  assert.ok(Math.abs(a - b) < 1e-9);
  assert.equal(approach(0.3, 1, 0, 0.1), 0.3);
  assert.equal(approach(0.3, 1, 0.01, 0), 1);
});

test('recoil spring: stable and returning at any frame time', () => {
  for (const dt of [0.0005, 0.001, 1 / 240, 1 / 60, 1 / 20, 0.1, 0.25]) {
    const s = new RecoilSpring(16, 0.75);
    s.kick(1);
    let peak = 0;
    for (let t = 0; t < 3; t += dt) {
      const x = s.update(dt);
      assert.ok(Number.isFinite(x), `finite at dt=${dt}`);
      peak = Math.max(peak, Math.abs(x));
    }
    // Sampled coarsely a large dt can step over the peak (≈ 70 ms after the kick); it must never exceed it.
    assert.ok(peak < 0.1 && (dt > 0.05 || peak > 0.01), `peak ${peak} at dt=${dt}`);
    assert.ok(Math.abs(s.x) < 1e-4, `settled at dt=${dt}: ${s.x}`);
  }
  const s = new RecoilSpring();
  s.kick(NaN);
  assert.equal(s.update(0.016), 0);
});

test('scope field of view: tan(φ/2) scales with 1/zoom', () => {
  assert.ok(Math.abs(fovForZoom(70, 1) - 70) < 1e-9);
  const f = fovForZoom(70, 10);
  assert.ok(Math.abs(Math.tan((f * Math.PI) / 360) - Math.tan((70 * Math.PI) / 360) / 10) < 1e-12);
  assert.equal(fovForZoom(70, 0.5), 70);
});

test('slow-motion ramp lands exactly and never overshoots', () => {
  for (const dt of [0.001, 1 / 60, 0.1]) {
    let s = 1;
    let steps = 0;
    while (s !== 0.1 && steps < 10000) {
      const n = rampTimeScale(s, 0.1, dt);
      assert.ok(n <= s && n >= 0.1);
      s = n;
      steps++;
    }
    assert.equal(s, 0.1);
    let u = 0.1;
    for (let i = 0; i < 10000 && u !== 1; i++) u = rampTimeScale(u, 1, dt);
    assert.equal(u, 1);
  }
});

test('bullet camera follows rockets, shells and bombs, not bullets or fragments', () => {
  assert.equal(isFollowable(getAmmo('pg7vl'), 290), true);
  assert.equal(isFollowable(getAmmo('m829a4'), 1555), true);
  assert.equal(isFollowable(getAmmo('gbu38'), 280), true);
  assert.equal(isFollowable(getAmmo('m433'), 76), true);
  assert.equal(isFollowable(getAmmo('m855'), 900), false);
  assert.equal(isFollowable(getAmmo('pgu14'), 1000), false);
  assert.equal(isFollowable({ ...getAmmo('m795'), kind: 'fragment' }, 200), false);
  assert.ok(Math.abs(wrapAngle(3 * Math.PI) - Math.PI) < 1e-12);
  assert.ok(Math.abs(wrapAngle(-Math.PI / 2) + Math.PI / 2) < 1e-12);
});
