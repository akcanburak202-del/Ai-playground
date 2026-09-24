import * as THREE from 'three';

interface Flash {
  light: THREE.PointLight;
  start: number;
  duration: number;
  peak: number;
}

/**
 * A fixed pool of point lights for muzzle flashes, impacts and explosions. The pool is created
 * once and always stays visible (changing the number of visible lights would recompile every
 * material in the scene); idle lights sit at zero intensity. A new flash takes a free light or the one closest to finishing.
 * Envelope: near-instant rise, then exponential decay with time constant duration / 3.
 */
export class FlashLights {
  readonly group = new THREE.Group();
  private flashes: Flash[] = [];

  constructor(count = 4) {
    this.group.name = 'fx-lights';
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 0, 2);
      light.castShadow = false;
      this.group.add(light);
      this.flashes.push({ light, start: -1e9, duration: 0, peak: 0 });
    }
  }

  /** `intensity` in candela (three.js physical units); `range` cuts the light off, m. */
  fire(now: number, position: THREE.Vector3, color: number, intensity: number, range: number, duration: number): void {
    let best = this.flashes[0]!;
    let bestLeft = Infinity;
    for (const f of this.flashes) {
      const left = f.start + f.duration - now;
      if (left < bestLeft) {
        bestLeft = left;
        best = f;
      }
    }
    // Do not steal a much brighter flash that is still burning.
    if (bestLeft > 0 && best.peak > intensity * 4) return;
    best.start = now;
    best.duration = Math.max(1e-3, duration);
    best.peak = intensity;
    best.light.position.copy(position);
    best.light.color.setHex(color);
    best.light.distance = range;
  }

  update(now: number): void {
    for (const f of this.flashes) {
      const t = now - f.start;
      if (t < 0 || t > f.duration * 2.5) {
        f.light.intensity = 0;
        continue;
      }
      const rise = Math.min(1, t / Math.min(0.004, f.duration * 0.1));
      f.light.intensity = f.peak * rise * Math.exp((-3 * t) / f.duration);
    }
  }

  clear(): void {
    for (const f of this.flashes) {
      f.start = -1e9;
      f.light.intensity = 0;
    }
  }

  dispose(): void {
    for (const f of this.flashes) f.light.dispose();
    this.group.removeFromParent();
  }
}
