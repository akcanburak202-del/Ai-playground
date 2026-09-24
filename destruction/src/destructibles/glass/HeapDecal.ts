import * as THREE from 'three';
import { createHeapMaterial } from './look.ts';

/**
 * The resting heap of one shattered pane on one floor level: a ground quad with a density texture
 * splatted from where the dice came to rest (known in closed form at spawn time). It fades in while
 * the instanced dice fade out, so a scene keeps its glitter without keeping thousands of dice.
 */
export class HeapDecal {
  readonly mesh: THREE.Mesh;
  private readonly tex: THREE.DataTexture;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly fade: THREE.IUniform<THREE.Vector2>;

  /**
   * @param points  resting positions [x, z, …]
   * @param floorY  floor height the dice rest on
   * @param die     die size (visual cell size of the mosaic), m
   * @param fadeAt  time the heap starts to appear, s
   */
  constructor(points: ArrayLike<number>, floorY: number, die: number, cover: number, tint: THREE.Color, fadeAt: number, time: THREE.IUniform<number>) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < points.length; i += 2) {
      x0 = Math.min(x0, points[i]!);
      x1 = Math.max(x1, points[i]!);
      z0 = Math.min(z0, points[i + 1]!);
      z1 = Math.max(z1, points[i + 1]!);
    }
    const m = 2 * Math.max(die, cover);
    x0 -= m; z0 -= m; x1 += m; z1 += m;
    const sx = x1 - x0, sz = z1 - z0;
    const cell = Math.max(0.015, Math.max(sx, sz) / 128);
    const nx = Math.max(4, Math.ceil(sx / cell)), nz = Math.max(4, Math.ceil(sz / cell));
    const acc = new Float32Array(nx * nz);
    // Each die covers ≈ cover² of floor; splat with a small tent so single dice read as specks.
    const a = (cover * cover) / (cell * cell);
    for (let i = 0; i < points.length; i += 2) {
      const fx = (points[i]! - x0) / cell - 0.5, fz = (points[i + 1]! - z0) / cell - 0.5;
      const ix = Math.floor(fx), iz = Math.floor(fz), u = fx - ix, v = fz - iz;
      if (ix < 0 || iz < 0 || ix + 1 >= nx || iz + 1 >= nz) continue;
      const k = iz * nx + ix;
      acc[k] += a * (1 - u) * (1 - v);
      acc[k + 1] += a * u * (1 - v);
      acc[k + nx] += a * (1 - u) * v;
      acc[k + nx + 1] += a * u * v;
    }
    const data = new Uint8Array(nx * nz);
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        // 3×3 box blur: loose dice scatter a little beyond their computed rest points.
        let s = 0, n = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx, Z = z + dz;
          if (X >= 0 && Z >= 0 && X < nx && Z < nz) {
            s += acc[Z * nx + X]! * (dx === 0 && dz === 0 ? 2 : 1);
            n += dx === 0 && dz === 0 ? 2 : 1;
          }
        }
        data[z * nx + x] = Math.min(255, Math.round(255 * Math.min(1, s / n)));
      }
    }
    this.tex = new THREE.DataTexture(data, nx, nz, THREE.RedFormat, THREE.UnsignedByteType);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    this.geometry = new THREE.PlaneGeometry(sx, sz).rotateX(-Math.PI / 2);
    // PlaneGeometry uv: u along +x, v along −z after the rotation; flip v so texel rows follow +z.
    const uv = this.geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    this.fade = { value: new THREE.Vector2(fadeAt, 1.5) };
    this.material = createHeapMaterial(this.tex, new THREE.Vector2(sx, sz), die, tint, this.fade, time);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.position.set(0.5 * (x0 + x1), floorY + 0.002, 0.5 * (z0 + z1));
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = -1;
    this.mesh.name = 'glass-heap';
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.tex.dispose();
  }
}
