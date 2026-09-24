import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AimHold, approach, fovForZoom, isFollowable, rampTimeScale, RecoilSpring, wrapAngle } from '../src/player/motion.ts';
import { scopeAperture, scopeFov } from '../src/ui/crosshair.ts';
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
  // A rifle bullet slowed below 400 m/s by a perforation is still a bullet.
  assert.equal(isFollowable(getAmmo('m855'), 350), false);
  assert.equal(isFollowable(getAmmo('m2ap'), 300), false);
  assert.ok(Math.abs(wrapAngle(3 * Math.PI) - Math.PI) < 1e-12);
  assert.ok(Math.abs(wrapAngle(-Math.PI / 2) + Math.PI / 2) < 1e-12);
});

test('sights: the aperture spans the real true field, so 1 mil on the reticle is 1 mrad', () => {
  const aspect = 16 / 9;
  // Riflescope at 10×: 2.17° true field across the eyepiece (Leupold Mark 4 LR/T).
  const fov = scopeFov('rifle', 10, aspect);
  const k = scopeAperture('rifle', aspect);
  const trueField = 2 * Math.atan(Math.tan((fov * Math.PI) / 360) * k);
  assert.ok(Math.abs((trueField * 180) / Math.PI - 2.17) < 0.005, `true field ${(trueField * 180) / Math.PI}°`);
  // Eyepiece radius in mil ≈ 19 (a real 10× tactical scope: ≈ 19 mil), posts at ±5 mil well inside.
  const radiusMil = (Math.tan(trueField / 2) * 1000);
  assert.ok(radiusMil > 17 && radiusMil < 21, `radius ${radiusMil} mil`);
  // Javelin CLU day sight: 4.8° vertical across its display at 4×.
  const clu = scopeFov('clu', 4, aspect);
  const cluField = 2 * Math.atan(Math.tan((clu * Math.PI) / 360) * scopeAperture('clu', aspect));
  assert.ok(Math.abs((cluField * 180) / Math.PI - 4.8) < 0.01);
  // Portrait phone: the apertures shrink with the width and the field of view grows to match.
  assert.ok(scopeAperture('rifle', 390 / 844) < 0.5 && scopeFov('rifle', 10, 390 / 844) > fov);
  for (const a of [NaN, 0, -1, 1e-6, 50]) assert.ok(Number.isFinite(scopeFov('rifle', 10, a)) && scopeFov('rifle', 10, a) > 0);
});

test('aim hold: a sustained burst stays on the spot, the kicks stay, release neither jumps nor dips', () => {
  const dt = 1 / 60;
  const run = (hold: boolean) => {
    const s = new RecoilSpring(16, 0.75);
    const h = new AimHold();
    let t = 0, next = 0, sum = 0, n = 0, prev = 0, maxJump = 0, minAfter = 0, peakKick = 0;
    for (; t < 3; t += dt) {
      const firing = t < 2;
      if (firing) while (next <= t) {
        s.kick(0.216); // 2.4 × 0.12 × 600/800 rad/s per round at 800 rpm (the full, unscaled M4A1 kick: worst case)
        next += 0.075;
      }
      const raw = s.update(dt);
      const x = hold ? h.update(s, dt, firing) : raw;
      if (t > 1 && t < 2) {
        sum += x;
        n++;
        peakKick = Math.max(peakKick, x - sum / n);
      }
      if (t > 1.9) maxJump = Math.max(maxJump, Math.abs(x - prev));
      if (t >= 2) minAfter = Math.min(minAfter, x);
      prev = x;
    }
    return { mean: sum / n, maxJump, minAfter, end: prev };
  };
  const free = run(false), held = run(true);
  assert.ok(free.mean > 0.009, `free climb ${free.mean}`);
  assert.ok(Math.abs(held.mean) < free.mean * 0.3, `held mean ${held.mean} vs ${free.mean}`);
  assert.ok(held.maxJump < 0.01, `no jump at release ${held.maxJump}`);
  assert.ok(held.minAfter > -0.003, `no dip below the aim ${held.minAfter}`);
  assert.ok(Math.abs(held.end) < 1e-3);
});
