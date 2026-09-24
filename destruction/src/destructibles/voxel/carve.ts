import { Noise3 } from '../../core/noise.ts';
import { EMPTY, FULL, ISO, MIXED, carveDensity, type VoxelGrid } from './grid.ts';

/**
 * Material removal and damage on the density grid. Every operation works in element-local metres,
 * applies CSG subtraction as `density = min(density, carveDensity)`, perturbs its distance field
 * with coherent noise so craters come out lobed and chipped instead of as clean primitives, and
 * reports the removed volume so effects can be scaled to it.
 */

const noise = new Noise3(0x51ab);

/**
 * Smooth pseudo-random lobe field in about [−1, 1] from nested sines (a few times cheaper than
 * gradient noise; only used for crater-scale lobes where its regularity is invisible).
 */
function lobes(x: number, y: number, z: number): number {
  return (
    0.55 * Math.sin(x * 1.7 + 1.3 * Math.sin(y * 1.9 + z * 0.8)) +
    0.45 * Math.sin(y * 2.3 - x * 0.9 + 1.1 * Math.sin(z * 2.1 + x * 0.6)) * Math.cos(z * 1.3 + y * 0.4)
  );
}

/** Accumulated result of carving calls since the last `reset()`. */
export class CarveStats {
  /** Removed volume, m³ */
  removed = 0;
  /** Sample box where material was removed (inclusive; c1 < c0 when none) */
  ci0 = Infinity;
  cj0 = Infinity;
  ck0 = Infinity;
  ci1 = -Infinity;
  cj1 = -Infinity;
  ck1 = -Infinity;
  carved(i0: number, j0: number, k0: number, i1: number, j1: number, k1: number): void {
    if (i0 < this.ci0) this.ci0 = i0;
    if (j0 < this.cj0) this.cj0 = j0;
    if (k0 < this.ck0) this.ck0 = k0;
    if (i1 > this.ci1) this.ci1 = i1;
    if (j1 > this.cj1) this.cj1 = j1;
    if (k1 > this.ck1) this.ck1 = k1;
  }
  /** Touched sample box (inclusive); i1 < i0 when nothing was touched */
  i0 = Infinity;
  j0 = Infinity;
  k0 = Infinity;
  i1 = -Infinity;
  j1 = -Infinity;
  k1 = -Infinity;
  reset(): void {
    this.removed = 0;
    this.ci0 = this.cj0 = this.ck0 = Infinity;
    this.ci1 = this.cj1 = this.ck1 = -Infinity;
    this.i0 = this.j0 = this.k0 = Infinity;
    this.i1 = this.j1 = this.k1 = -Infinity;
  }
  touch(i0: number, j0: number, k0: number, i1: number, j1: number, k1: number): void {
    if (i0 < this.i0) this.i0 = i0;
    if (j0 < this.j0) this.j0 = j0;
    if (k0 < this.k0) this.k0 = k0;
    if (i1 > this.i1) this.i1 = i1;
    if (j1 > this.j1) this.j1 = j1;
    if (k1 > this.k1) this.k1 = k1;
  }
  get empty(): boolean {
    return this.i1 < this.i0;
  }
}

/** Damage level given to freshly fractured faces (micro-cracked skin of every crater), 0..255. */
const FRESH_DAMAGE = 50;

/** Signed distance of a carve primitive at a local point, negative inside the removed region. */
type CarveSdf = (x: number, y: number, z: number) => number;

/**
 * Noise used to roughen carve boundaries: large lobes (radial fracture lobes of a spall crater) plus
 * grain-scale chipping at about one and a half voxels.
 */
export interface Roughness {
  /** Lobe amplitude, m */
  lobe: number;
  /** Lobe wavelength, m */
  lobeScale: number;
  /** Grain amplitude, m */
  grain: number;
  /** Per-event noise domain offset */
  seed: number;
}

export class Carver {
  readonly grid: VoxelGrid;
  readonly stats = new CarveStats();
  private stack = new Int32Array(4096);
  private field = new Float32Array(0);

  constructor(grid: VoxelGrid) {
    this.grid = grid;
  }

  /**
   * Remove the region where `sdf + roughness·noise < 0`, within the local box [min, max].
   * Returns the removed volume (m³).
   */
  carve(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, sdf: CarveSdf, r: Roughness): number {
    const g = this.grid;
    const h = g.h;
    const pad = r.lobe + r.grain + h;
    const i0 = Math.max(0, Math.floor(g.gx(minX - pad))), i1 = Math.min(g.nx - 1, Math.ceil(g.gx(maxX + pad)));
    const j0 = Math.max(0, Math.floor(g.gy(minY - pad))), j1 = Math.min(g.ny - 1, Math.ceil(g.gy(maxY + pad)));
    const k0 = Math.max(0, Math.floor(g.gz(minZ - pad))), k1 = Math.min(g.nz - 1, Math.ceil(g.gz(maxZ + pad)));
    if (i1 < i0 || j1 < j0 || k1 < k0) return 0;
    const band = r.lobe + r.grain + h;
    const fl = 1 / Math.max(1e-4, r.lobeScale), fg = 1 / (1.6 * h);
    const so = r.seed * 17.31;
    let removed = 0;
    let ri0 = Infinity, rj0 = Infinity, rk0 = Infinity, ri1 = -1, rj1 = -1, rk1 = -1;
    for (let k = k0; k <= k1; k++) {
      const z = g.oz + k * h;
      for (let j = j0; j <= j1; j++) {
        const y = g.oy + j * h;
        for (let i = i0; i <= i1; i++) {
          g.locate(i, j, k);
          const ci = g.ci;
          const st = g.state[ci];
          if (st === EMPTY) continue;
          // Nothing to remove from air (and air needs no fracture skin).
          if (st === MIXED && g.dens[ci]![g.li]! === 0) continue;
          const x = g.ox + i * h;
          let s = sdf(x, y, z);
          if (s > band) continue;
          if (s > -band) {
            // Lobes from a cheap low-frequency pattern, chipping from voxel-scale gradient noise.
            s += r.lobe * lobes(x * fl + so, y * fl - so, z * fl + 0.5 * so);
            if (r.grain > 0) s += r.grain * noise.noise3(x * fg - so, y * fg + 0.37 * so, z * fg + so) * 1.6;
          }
          const v = carveDensity(s, h);
          if (g.state[ci] === FULL) {
            if (v >= 255) continue;
            g.ensureMixed(ci);
          }
          const li = g.li;
          const old = g.dens[ci]![li]!;
          if (v < old) {
            g.writeDensity(ci, li, j, v);
            removed += old - v;
            if (i < ri0) ri0 = i;
            if (j < rj0) rj0 = j;
            if (k < rk0) rk0 = k;
            if (i > ri1) ri1 = i;
            if (j > rj1) rj1 = j;
            if (k > rk1) rk1 = k;
          }
          // The skin of a fresh fracture (about one voxel) is micro-cracked.
          if (s < 1.2 * h && g.dens[ci]![li]! > 40) {
            const dm = g.dmg[ci]!;
            if (dm[li]! < FRESH_DAMAGE) dm[li] = FRESH_DAMAGE;
          }
        }
      }
    }
    g.markDirty(i0, j0, k0, i1, j1, k1);
    this.stats.touch(i0, j0, k0, i1, j1, k1);
    if (ri1 >= 0) this.stats.carved(ri0, rj0, rk0, ri1, rj1, rk1);
    const vol = (removed / 255) * h * h * h;
    this.stats.removed += vol;
    return vol;
  }

  /**
   * Cone crater: base circle of `radius` at the entry point p, apex `depth` along the unit axis a.
   * Continues `above`·depth above the entry (t < 0) so crater rims on uneven ground break away too.
   */
  cone(px: number, py: number, pz: number, ax: number, ay: number, az: number, radius: number, depth: number, r: Roughness, above = 0.5): number {
    if (radius <= 0 || depth <= 0) return 0;
    const cosA = depth / Math.hypot(depth, radius);
    const up = Math.max(0.05, above) * depth;
    const sdf: CarveSdf = (x, y, z) => {
      const vx = x - px, vy = y - py, vz = z - pz;
      const t = vx * ax + vy * ay + vz * az;
      const rx = vx - t * ax, ry = vy - t * ay, rz = vz - t * az;
      const rho = Math.sqrt(rx * rx + ry * ry + rz * rz);
      const side = (rho - radius * (1 - t / depth)) * cosA;
      return Math.max(side, t - depth, -t - up);
    };
    // Tight box: the widest disc (radius e, at the top of the extension) plus the apex. A disc of
    // radius e with unit normal a spans e·√(1 − a_k²) along axis k.
    const e = radius * (1 + up / depth);
    const ex = px + ax * depth, ey = py + ay * depth, ez = pz + az * depth;
    const ux = px - ax * up, uy = py - ay * up, uz = pz - az * up;
    const sx = e * Math.sqrt(Math.max(0, 1 - ax * ax)), sy = e * Math.sqrt(Math.max(0, 1 - ay * ay)), sz = e * Math.sqrt(Math.max(0, 1 - az * az));
    return this.carve(
      Math.min(ex, ux - sx), Math.min(ey, uy - sy), Math.min(ez, uz - sz),
      Math.max(ex, ux + sx), Math.max(ey, uy + sy), Math.max(ez, uz + sz), sdf, r,
    );
  }

  /** Capsule (tunnel) from a to b with radius rad. */
  capsule(ax: number, ay: number, az: number, bx: number, by: number, bz: number, rad: number, r: Roughness): number {
    if (rad <= 0) return 0;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const L2 = dx * dx + dy * dy + dz * dz || 1e-12;
    const sdf: CarveSdf = (x, y, z) => {
      const vx = x - ax, vy = y - ay, vz = z - az;
      let t = (vx * dx + vy * dy + vz * dz) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = vx - t * dx, qy = vy - t * dy, qz = vz - t * dz;
      return Math.sqrt(qx * qx + qy * qy + qz * qz) - rad;
    };
    return this.carve(
      Math.min(ax, bx) - rad, Math.min(ay, by) - rad, Math.min(az, bz) - rad,
      Math.max(ax, bx) + rad, Math.max(ay, by) + rad, Math.max(az, bz) + rad, sdf, r,
    );
  }

  sphere(cx: number, cy: number, cz: number, rad: number, r: Roughness): number {
    if (rad <= 0) return 0;
    const sdf: CarveSdf = (x, y, z) => Math.hypot(x - cx, y - cy, z - cz) - rad;
    return this.carve(cx - rad, cy - rad, cz - rad, cx + rad, cy + rad, cz + rad, sdf, r);
  }

  /**
   * Finite cylinder of radius `rad` around the axis a (unit) from p to p + a·len (breach hole).
   */
  cylinder(px: number, py: number, pz: number, ax: number, ay: number, az: number, len: number, rad: number, r: Roughness): number {
    if (rad <= 0 || len <= 0) return 0;
    const sdf: CarveSdf = (x, y, z) => {
      const vx = x - px, vy = y - py, vz = z - pz;
      const t = vx * ax + vy * ay + vz * az;
      const qx = vx - t * ax, qy = vy - t * ay, qz = vz - t * az;
      return Math.max(Math.sqrt(qx * qx + qy * qy + qz * qz) - rad, -t, t - len);
    };
    const ex = px + ax * len, ey = py + ay * len, ez = pz + az * len;
    return this.carve(
      Math.min(px, ex) - rad, Math.min(py, ey) - rad, Math.min(pz, ez) - rad,
      Math.max(px, ex) + rad, Math.max(py, ey) + rad, Math.max(pz, ez) + rad, sdf, r,
    );
  }

  /**
   * Continuum damage splat (isotropic scalar damage D, Kachanov 1958 / Lemaitre 1985): ΔD falls
   * off quadratically from `peak` at the centre to 0 at radius R, modulated ±45 % by noise so the
   * micro-crack field (and the crumbling that follows) is patchy like real concrete. D saturates at
   * 1. Returns the number of samples affected.
   *
   * `accumulate` = 1 adds ΔD (each bullet crushes new material locally). Below 1 the new field
   * combines as max(D, ΔD) + accumulate·min(D, ΔD): a repeated sub-critical structural load (a
   * second blast at the same stand-off) extends the existing crack field only a little instead of
   * doubling it (low-cycle damage; cf. Lemaitre, "A Course on Damage Mechanics", §7).
   */
  damage(cx: number, cy: number, cz: number, R: number, peak: number, seed: number, accumulate = 1): number {
    if (R <= 0 || peak <= 0) return 0;
    const g = this.grid;
    const h = g.h;
    const i0 = Math.max(0, Math.floor(g.gx(cx - R))), i1 = Math.min(g.nx - 1, Math.ceil(g.gx(cx + R)));
    const j0 = Math.max(0, Math.floor(g.gy(cy - R))), j1 = Math.min(g.ny - 1, Math.ceil(g.gy(cy + R)));
    const k0 = Math.max(0, Math.floor(g.gz(cz - R))), k1 = Math.min(g.nz - 1, Math.ceil(g.gz(cz + R)));
    if (i1 < i0 || j1 < j0 || k1 < k0) return 0;
    // Patchiness at ≥ 4 voxels: finer noise would leave isolated saturated samples that crumble
    // into voxel-sized pits.
    const f = 1 / Math.max(4 * h, 0.5 * R);
    const so = seed * 11.7;
    const invR2 = 1 / (R * R);
    let n = 0;
    for (let k = k0; k <= k1; k++) {
      const z = g.oz + k * h;
      const dz2 = (z - cz) * (z - cz) * invR2;
      if (dz2 >= 1) continue;
      for (let j = j0; j <= j1; j++) {
        const y = g.oy + j * h;
        const dyz2 = dz2 + (y - cy) * (y - cy) * invR2;
        if (dyz2 >= 1) continue;
        for (let i = i0; i <= i1; i++) {
          const x = g.ox + i * h;
          const d2 = dyz2 + (x - cx) * (x - cx) * invR2;
          if (d2 >= 1) continue;
          g.locate(i, j, k);
          const ci = g.ci;
          if (g.state[ci] === EMPTY) continue;
          if (g.state[ci] === FULL) g.ensureMixed(ci);
          const li = g.li;
          if (g.dens[ci]![li] === 0) continue;
          const d = Math.sqrt(d2);
          const w = (1 - d) * (1 - d);
          const m = 1 + 0.45 * noise.noise3(x * f + so, y * f + 3.1 * so, z * f - so) * 1.6;
          const dd = peak * w * (m > 0 ? m : 0) * 255;
          const dm = g.dmg[ci]!;
          const old = dm[li]!;
          const nv = accumulate >= 1 ? old + dd : Math.max(old, dd) + accumulate * Math.min(old, dd);
          dm[li] = nv >= 255 ? 255 : nv;
          n++;
        }
      }
    }
    g.markDirty(i0, j0, k0, i1, j1, k1);
    this.stats.touch(i0, j0, k0, i1, j1, k1);
    return n;
  }

  /**
   * Many damage splats of one event at once (blast patches): the splats are summed into a scratch
   * field first, so each sample is located, noise-modulated and accumulated once however many
   * splats overlap it. `splats` holds (x, y, z, R, peak) quintuples.
   */
  damageBatch(splats: ArrayLike<number>, count: number, seed: number, accumulate = 1): number {
    if (count <= 0) return 0;
    const g = this.grid;
    const h = g.h;
    let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity, rSum = 0;
    for (let q = 0; q < count; q++) {
      const x = splats[q * 5]!, y = splats[q * 5 + 1]!, z = splats[q * 5 + 2]!, R = splats[q * 5 + 3]!;
      bx0 = Math.min(bx0, x - R); by0 = Math.min(by0, y - R); bz0 = Math.min(bz0, z - R);
      bx1 = Math.max(bx1, x + R); by1 = Math.max(by1, y + R); bz1 = Math.max(bz1, z + R);
      rSum += R;
    }
    const i0 = Math.max(0, Math.floor(g.gx(bx0))), i1 = Math.min(g.nx - 1, Math.ceil(g.gx(bx1)));
    const j0 = Math.max(0, Math.floor(g.gy(by0))), j1 = Math.min(g.ny - 1, Math.ceil(g.gy(by1)));
    const k0 = Math.max(0, Math.floor(g.gz(bz0))), k1 = Math.min(g.nz - 1, Math.ceil(g.gz(bz1)));
    if (i1 < i0 || j1 < j0 || k1 < k0) return 0;
    const sx = i1 - i0 + 1, sy = j1 - j0 + 1, sz = k1 - k0 + 1;
    const need = sx * sy * sz;
    if (this.field.length < need) this.field = new Float32Array(Math.max(need, this.field.length * 2));
    const fld = this.field;
    fld.fill(0, 0, need);
    for (let q = 0; q < count; q++) {
      const cx = splats[q * 5]!, cy = splats[q * 5 + 1]!, cz = splats[q * 5 + 2]!, R = splats[q * 5 + 3]!, peak = splats[q * 5 + 4]!;
      if (R <= 0 || peak <= 0) continue;
      const invR2 = 1 / (R * R);
      const a0 = Math.max(i0, Math.floor(g.gx(cx - R))), a1 = Math.min(i1, Math.ceil(g.gx(cx + R)));
      const b0 = Math.max(j0, Math.floor(g.gy(cy - R))), b1 = Math.min(j1, Math.ceil(g.gy(cy + R)));
      const c0 = Math.max(k0, Math.floor(g.gz(cz - R))), c1 = Math.min(k1, Math.ceil(g.gz(cz + R)));
      for (let k = c0; k <= c1; k++) {
        const z = g.oz + k * h;
        const dz2 = (z - cz) * (z - cz) * invR2;
        if (dz2 >= 1) continue;
        for (let j = b0; j <= b1; j++) {
          const y = g.oy + j * h;
          const dyz2 = dz2 + (y - cy) * (y - cy) * invR2;
          if (dyz2 >= 1) continue;
          const row = (k - k0) * sx * sy + (j - j0) * sx - i0;
          for (let i = a0; i <= a1; i++) {
            const x = g.ox + i * h;
            const d2 = dyz2 + (x - cx) * (x - cx) * invR2;
            if (d2 >= 1) continue;
            const d = Math.sqrt(d2);
            fld[row + i] += peak * (1 - d) * (1 - d);
          }
        }
      }
    }
    const f = 1 / Math.max(4 * h, 0.5 * (rSum / count));
    const so = seed * 11.7;
    let n = 0;
    for (let k = k0; k <= k1; k++) {
      const z = g.oz + k * h;
      for (let j = j0; j <= j1; j++) {
        const y = g.oy + j * h;
        const row = (k - k0) * sx * sy + (j - j0) * sx - i0;
        for (let i = i0; i <= i1; i++) {
          const v = fld[row + i]!;
          if (v <= 0) continue;
          g.locate(i, j, k);
          const ci = g.ci;
          if (g.state[ci] === EMPTY) continue;
          if (g.state[ci] === FULL) g.ensureMixed(ci);
          const li = g.li;
          if (g.dens[ci]![li] === 0) continue;
          const x = g.ox + i * h;
          const m = 1 + 0.45 * noise.noise3(x * f + so, y * f + 3.1 * so, z * f - so) * 1.6;
          const dd = v * (m > 0 ? m : 0) * 255;
          const dm = g.dmg[ci]!;
          const old = dm[li]!;
          const nv = accumulate >= 1 ? old + dd : Math.max(old, dd) + accumulate * Math.min(old, dd);
          dm[li] = nv >= 255 ? 255 : nv;
          n++;
        }
      }
    }
    g.markDirty(i0, j0, k0, i1, j1, k1);
    this.stats.touch(i0, j0, k0, i1, j1, k1);
    return n;
  }

  /**
   * Crumbling: material whose damage has (nearly) saturated falls out once it is exposed. Starting
   * from saturated samples next to air, the allowed density drops from 255 at D = 0.85 to 0 at D = 1
   * (surface at D ≈ 0.92); every sample that turns to air exposes its neighbours, so loose rubble
   * peels off until it reaches material that still holds together. Confined rubble stays in place.
   * Returns the removed volume (m³).
   */
  crumble(i0: number, j0: number, k0: number, i1: number, j1: number, k1: number): number {
    const g = this.grid;
    i0 = Math.max(0, i0); j0 = Math.max(0, j0); k0 = Math.max(0, k0);
    i1 = Math.min(g.nx - 1, i1); j1 = Math.min(g.ny - 1, j1); k1 = Math.min(g.nz - 1, k1);
    const D0 = 0.85 * 255, D1 = 255;
    const nx = g.nx, nxy = g.nx * g.ny;
    let sp = 0;
    const push = (idx: number) => {
      if (sp >= this.stack.length) {
        const s = new Int32Array(this.stack.length * 2);
        s.set(this.stack);
        this.stack = s;
      }
      this.stack[sp++] = idx;
    };
    // Rubble falls out as a mass, not grain by grain: a sample only crumbles when its solid
    // neighbours are broken up too (mean damage ≥ 0.7).
    const loose = (i: number, j: number, k: number) => {
      let sum = 0, n = 0;
      const add = (a: number, b: number, c: number) => {
        if (g.density(a, b, c) >= ISO) { sum += g.damage(a, b, c); n++; }
      };
      add(i - 1, j, k); add(i + 1, j, k); add(i, j - 1, k); add(i, j + 1, k); add(i, j, k - 1); add(i, j, k + 1);
      return n === 0 || sum / n >= 0.7 * 255;
    };
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          if (g.damage(i, j, k) < D0) continue;
          if (g.density(i, j, k) < ISO) continue;
          if (
            g.density(i - 1, j, k) < ISO || g.density(i + 1, j, k) < ISO || g.density(i, j - 1, k) < ISO ||
            g.density(i, j + 1, k) < ISO || g.density(i, j, k - 1) < ISO || g.density(i, j, k + 1) < ISO
          ) push(i + nx * j + nxy * k);
        }
    let removed = 0;
    let ti0 = Infinity, tj0 = Infinity, tk0 = Infinity, ti1 = -1, tj1 = -1, tk1 = -1;
    while (sp > 0) {
      const idx = this.stack[--sp]!;
      const k = Math.floor(idx / nxy), j = Math.floor((idx - k * nxy) / nx), i = idx - k * nxy - j * nx;
      const dmg = g.damage(i, j, k);
      if (dmg < D0) continue;
      if (!loose(i, j, k)) continue;
      g.locate(i, j, k);
      const ci = g.ci, li = g.li;
      if (g.state[ci] !== 2) continue;
      const old = g.dens[ci]![li]!;
      if (old < ISO) continue;
      let allowed = Math.round((255 * (D1 - dmg)) / (D1 - D0));
      if (allowed === ISO) allowed = ISO - 1;
      if (allowed >= old) continue;
      g.writeDensity(ci, li, j, allowed);
      removed += old - allowed;
      if (i < ti0) ti0 = i;
      if (j < tj0) tj0 = j;
      if (k < tk0) tk0 = k;
      if (i > ti1) ti1 = i;
      if (j > tj1) tj1 = j;
      if (k > tk1) tk1 = k;
      if (allowed >= ISO) continue;
      // Newly exposed neighbours inside the region may crumble too.
      if (i > i0) push(idx - 1);
      if (i < i1) push(idx + 1);
      if (j > j0) push(idx - nx);
      if (j < j1) push(idx + nx);
      if (k > k0) push(idx - nxy);
      if (k < k1) push(idx + nxy);
    }
    if (ti1 >= 0) {
      g.markDirty(ti0, tj0, tk0, ti1, tj1, tk1);
      this.stats.touch(ti0, tj0, tk0, ti1, tj1, tk1);
      this.stats.carved(ti0, tj0, tk0, ti1, tj1, tk1);
    }
    const vol = (removed / 255) * g.h * g.h * g.h;
    this.stats.removed += vol;
    return vol;
  }

  /**
   * Remove damaged slivers one sample thick (air on two opposite sides). Fractured concrete that
   * thin does not hold together, and at voxel scale such slivers mesh as square windows.
   * Returns the removed volume (m³).
   */
  cleanSlivers(i0: number, j0: number, k0: number, i1: number, j1: number, k1: number, passes = 2): number {
    const g = this.grid;
    i0 = Math.max(1, i0 - 1); j0 = Math.max(1, j0 - 1); k0 = Math.max(1, k0 - 1);
    i1 = Math.min(g.nx - 2, i1 + 1); j1 = Math.min(g.ny - 2, j1 + 1); k1 = Math.min(g.nz - 2, k1 + 1);
    let removed = 0;
    for (let pass = 0; pass < passes; pass++) {
      let any = false;
      for (let k = k0; k <= k1; k++)
        for (let j = j0; j <= j1; j++)
          for (let i = i0; i <= i1; i++) {
            g.locate(i, j, k);
            if (g.state[g.ci] !== MIXED) continue;
            const d = g.dens[g.ci]![g.li]!;
            if (d < ISO || g.dmg[g.ci]![g.li]! < 40) continue;
            const thin =
              (g.density(i - 1, j, k) < ISO && g.density(i + 1, j, k) < ISO) ||
              (g.density(i, j - 1, k) < ISO && g.density(i, j + 1, k) < ISO) ||
              (g.density(i, j, k - 1) < ISO && g.density(i, j, k + 1) < ISO);
            if (!thin) continue;
            g.locate(i, j, k);
            g.writeDensity(g.ci, g.li, j, ISO - 40);
            removed += d - (ISO - 40);
            any = true;
          }
      if (!any) break;
    }
    if (removed > 0) {
      g.markDirty(i0, j0, k0, i1, j1, k1);
      this.stats.touch(i0, j0, k0, i1, j1, k1);
    }
    const vol = (removed / 255) * g.h * g.h * g.h;
    this.stats.removed += vol;
    return vol;
  }

  /** Blacken exposed surface samples within R (blast soot), `amount` 0..1 at the centre. */
  sootSplat(cx: number, cy: number, cz: number, R: number, amount: number, seed: number): void {
    if (R <= 0 || amount <= 0) return;
    const g = this.grid;
    const h = g.h;
    const i0 = Math.max(0, Math.floor(g.gx(cx - R))), i1 = Math.min(g.nx - 1, Math.ceil(g.gx(cx + R)));
    const j0 = Math.max(0, Math.floor(g.gy(cy - R))), j1 = Math.min(g.ny - 1, Math.ceil(g.gy(cy + R)));
    const k0 = Math.max(0, Math.floor(g.gz(cz - R))), k1 = Math.min(g.nz - 1, Math.ceil(g.gz(cz + R)));
    if (i1 < i0 || j1 < j0 || k1 < k0) return;
    const so = seed * 5.3;
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const x = g.ox + i * h, y = g.oy + j * h, z = g.oz + k * h;
          const dist = Math.hypot(x - cx, y - cy, z - cz);
          const d = dist / R;
          if (d >= 1) continue;
          g.locate(i, j, k);
          const ci = g.ci;
          if (g.state[ci] !== 2) continue;
          const li = g.li;
          const dv = g.dens[ci]![li]!;
          if (dv === 0 || dv === 255) continue;
          // Only faces that see the fireball: outward normal (−∇density) towards the charge.
          const gx = g.density(i - 1, j, k) - g.density(i + 1, j, k);
          const gy = g.density(i, j - 1, k) - g.density(i, j + 1, k);
          const gz = g.density(i, j, k - 1) - g.density(i, j, k + 1);
          const facing = (gx * (cx - x) + gy * (cy - y) + gz * (cz - z)) / (Math.hypot(gx, gy, gz) * dist + 1e-9);
          if (facing < 0.05) continue;
          // Radial streaks: noise over the direction from the charge, slowly varying with range.
          const ux = (x - cx) / (dist + 1e-9), uy = (y - cy) / (dist + 1e-9), uz = (z - cz) / (dist + 1e-9);
          const streak = Math.max(0, 0.7 + 0.6 * noise.noise3(ux * 9 + so, uy * 9, uz * 9 - so + d * 1.5));
          const add = amount * Math.pow(1 - d, 1.6) * streak * Math.sqrt(facing) * 255;
          if (add <= 0) continue;
          const s = g.soot[ci]!;
          s[li] = Math.min(255, s[li]! + add);
        }
    // Soot changes appearance only: remesh, but no occupancy change.
    g.markDirty(i0, j0, k0, i1, j1, k1);
  }
}
