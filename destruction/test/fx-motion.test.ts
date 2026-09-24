import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driftA, driftB, landingTime, motionAt, GRAVITY, type MotionState } from '../src/fx/motion.ts';
import { CameraShake } from '../src/fx/shake.ts';

const m: MotionState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };

test('drift integrals match the exact expressions on both sides of the small-kt series switch', () => {
  for (const k of [0.1, 1, 10]) {
    for (const f of [0.5, 0.999, 1.001, 2, 1000]) {
      const t = (1e-3 * f) / k;
      const kt = k * t;
      const A = -Math.expm1(-kt) / k;
      // B = (kt − 1 + e^−kt)/k² via a long series (no cancellation) for small kt.
      let B = 0, term = (t * t) / 2;
      for (let n = 0; n < 12; n++) {
        B += term;
        term *= -kt / (n + 3);
      }
      if (kt > 0.5) B = (kt - 1 + Math.exp(-kt)) / (k * k);
      assert.ok(Math.abs(driftA(k, t) - A) / A < 1e-9, `A at k=${k} kt=${kt}`);
      assert.ok(Math.abs(driftB(k, t) - B) / B < 1e-6, `B at k=${k} kt=${kt}`);
    }
  }
});

test('without drag the motion is the ballistic parabola', () => {
  motionAt(0, 10, 0, 3, 4, -2, 1e-7, 1, 0, 0, 0, 1.3, m);
  assert.ok(Math.abs(m.x - 3.9) < 1e-5);
  assert.ok(Math.abs(m.y - (10 + 4 * 1.3 - 0.5 * GRAVITY * 1.69)) < 1e-5);
  assert.ok(Math.abs(m.vy - (4 - GRAVITY * 1.3)) < 1e-5);
});

test('with drag the velocity relaxes to wind + g/k (terminal velocity)', () => {
  const k = 4, w = [1.5, 0, 0.5];
  motionAt(0, 0, 0, 50, 20, -30, k, 1, w[0]!, w[1]!, w[2]!, 20, m);
  assert.ok(Math.abs(m.vx - 1.5) < 1e-6 && Math.abs(m.vz - 0.5) < 1e-6);
  assert.ok(Math.abs(m.vy + GRAVITY / k) < 1e-6);
  // Buoyant smoke rises at |g·gs|/k.
  motionAt(0, 0, 0, 0, 0, 0, 0.5, -0.05, 0, 0, 0, 60, m);
  assert.ok(Math.abs(m.vy - (GRAVITY * 0.05) / 0.5) < 1e-6);
});

test('position is the time integral of velocity (finite-difference check)', () => {
  const s: MotionState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  for (const k of [1e-5, 0.3, 3, 30]) {
    for (const t of [0.001, 0.2, 2, 9]) {
      const h = 1e-4;
      motionAt(1, 2, 3, 12, 7, -4, k, 1, 1, 0, 0.3, t + h, s);
      const yp = s.y, xp = s.x;
      motionAt(1, 2, 3, 12, 7, -4, k, 1, 1, 0, 0.3, t - h, s);
      const ym = s.y, xm = s.x;
      motionAt(1, 2, 3, 12, 7, -4, k, 1, 1, 0, 0.3, t, m);
      assert.ok(Math.abs((yp - ym) / (2 * h) - m.vy) < 1e-3 * (1 + Math.abs(m.vy)), `vy k=${k} t=${t}`);
      assert.ok(Math.abs((xp - xm) / (2 * h) - m.vx) < 1e-3 * (1 + Math.abs(m.vx)), `vx k=${k} t=${t}`);
    }
  }
});

test('motion stays finite for extreme drag, time and slow-motion steps', () => {
  for (const k of [1e-9, 1e-4, 1, 1e3]) {
    for (const t of [0, 1e-6, 1e-3, 1 / 60, 10, 1e4]) {
      motionAt(0, 0, 0, 900, 10, 0, k, 1, 2, 0, 1, t, m);
      assert.ok([m.x, m.y, m.z, m.vx, m.vy, m.vz].every(Number.isFinite), `k=${k} t=${t}`);
    }
  }
});

test('landing time matches free fall and is −1 for rising smoke', () => {
  const t = landingTime(10, 0, 1e-7, 1, 0, 0, 5);
  assert.ok(Math.abs(t - Math.sqrt((2 * 10) / GRAVITY)) < 1e-4, `t = ${t}`);
  // Thrown upward from the floor: lands after 2 v / g.
  const t2 = landingTime(0, 9.8, 1e-7, 1, 0, 0, 5);
  assert.ok(Math.abs(t2 - (2 * 9.8) / GRAVITY) < 1e-3, `t2 = ${t2}`);
  assert.equal(landingTime(1, 2, 1, -0.1, 0, 0, 30), -1);
  // With drag the fall takes longer than in vacuum.
  assert.ok(landingTime(10, 0, 2, 1, 0, 0, 20) > Math.sqrt(20 / GRAVITY));
});

test('camera shake: trauma² scaling, linear decay, bounded, safe with bad dt', () => {
  const s = new CameraShake();
  assert.equal(s.update(1 / 60), false);
  s.add(0.5);
  s.add(0.8);
  assert.equal(s.trauma, 1);
  let maxYaw = 0;
  for (let i = 0; i < 30; i++) {
    s.update(1 / 60);
    maxYaw = Math.max(maxYaw, Math.abs(s.out.yaw));
    assert.ok(Math.abs(s.out.roll) <= s.maxRoll + 1e-12);
  }
  assert.ok(maxYaw > 0 && maxYaw <= s.maxYaw);
  assert.ok(Math.abs(s.trauma - (1 - 0.5 * s.decay)) < 1e-9);
  s.update(Number.NaN);
  s.update(-1);
  assert.ok(Number.isFinite(s.out.yaw) && Number.isFinite(s.trauma));
  s.update(10);
  assert.equal(s.trauma < 1, true);
  s.reset();
  assert.equal(s.out.x, 0);
});
