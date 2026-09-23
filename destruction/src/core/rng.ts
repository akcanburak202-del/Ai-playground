import * as THREE from 'three';

/**
 * Seeded pseudo-random generator (sfc32). Every stochastic decision in the simulation draws from an
 * instance of this class so a scripted run (see `window.__sim`) is reproducible.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed = 0x9e3779b9) {
    this.a = 0x9e3779b9 ^ seed;
    this.b = 0x243f6a88 ^ (seed * 31);
    this.c = 0xb7e15162 ^ (seed * 17);
    this.d = seed | 0;
    for (let i = 0; i < 16; i++) this.next();
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.a |= 0; this.b |= 0; this.c |= 0; this.d |= 0;
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(minInclusive: number, maxExclusive: number): number {
    return Math.floor(this.range(minInclusive, maxExclusive));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Standard normal sample (Box-Muller). */
  gaussian(mean = 0, std = 1): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Uniform point on the unit sphere. */
  onSphere(out = new THREE.Vector3()): THREE.Vector3 {
    const z = this.range(-1, 1);
    const phi = this.range(0, Math.PI * 2);
    const r = Math.sqrt(1 - z * z);
    return out.set(r * Math.cos(phi), z, r * Math.sin(phi));
  }

  /** Uniform point inside the unit ball. */
  inBall(out = new THREE.Vector3()): THREE.Vector3 {
    this.onSphere(out);
    return out.multiplyScalar(Math.cbrt(this.next()));
  }

  /**
   * Unit vector inside a cone around `axis` with the given half angle (radians), uniform over the
   * cap's solid angle.
   */
  inCone(axis: THREE.Vector3, halfAngle: number, out = new THREE.Vector3()): THREE.Vector3 {
    const cosMax = Math.cos(halfAngle);
    const z = this.range(cosMax, 1);
    const phi = this.range(0, Math.PI * 2);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const t = TMP_T.set(1, 0, 0);
    if (Math.abs(axis.x) > 0.9) t.set(0, 1, 0);
    const u = TMP_U.crossVectors(axis, t).normalize();
    const w = TMP_W.crossVectors(axis, u);
    return out
      .copy(axis)
      .multiplyScalar(z)
      .addScaledVector(u, r * Math.cos(phi))
      .addScaledVector(w, r * Math.sin(phi))
      .normalize();
  }

  /** Independent child generator, so subsystems don't perturb each other's sequences. */
  fork(): Rng {
    return new Rng(Math.floor(this.next() * 0xffffffff));
  }
}

const TMP_T = new THREE.Vector3();
const TMP_U = new THREE.Vector3();
const TMP_W = new THREE.Vector3();
