import { Noise3 } from '../core/noise.ts';

/**
 * Trauma-based camera shake (Eiserloh, "Juicing Your Cameras With Math", GDC 2016): events add
 * trauma in [0, 1]; the displacement is trauma² times smooth Perlin noise, so small bumps stay
 * subtle and big blasts kick hard; trauma decays linearly in real time. Pure logic (no three.js).
 */
export class CameraShake {
  trauma = 0;
  /** Trauma lost per second */
  decay = 0.9;
  /** Peak angles, radians (yaw, pitch, roll) and peak translation, m */
  maxYaw = 0.035;
  maxPitch = 0.03;
  maxRoll = 0.045;
  maxOffset = 0.06;
  /** Noise frequency, Hz */
  frequency = 17;
  readonly out = { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 0 };
  private t = 0;
  private noise = new Noise3(911);

  add(amount: number): void {
    if (!(amount > 0)) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Advance by real seconds and return whether the camera is displaced this frame. */
  update(realDt: number): boolean {
    const dt = Number.isFinite(realDt) ? Math.max(0, Math.min(realDt, 0.25)) : 0;
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - this.decay * dt);
    const s = this.trauma * this.trauma;
    const o = this.out;
    if (s <= 1e-5) {
      o.yaw = o.pitch = o.roll = o.x = o.y = o.z = 0;
      return false;
    }
    const f = this.t * this.frequency;
    const n = this.noise;
    o.yaw = this.maxYaw * s * n.noise3(f, 0.5, 1.7);
    o.pitch = this.maxPitch * s * n.noise3(f, 3.1, 5.3);
    o.roll = this.maxRoll * s * n.noise3(f, 7.7, 2.9);
    o.x = this.maxOffset * s * n.noise3(f, 11.3, 0.2);
    o.y = this.maxOffset * s * n.noise3(f, 13.9, 8.4);
    o.z = this.maxOffset * 0.5 * s * n.noise3(f, 17.2, 4.6);
    return true;
  }

  reset(): void {
    this.trauma = 0;
    this.update(0);
  }
}
