import type { VoxelShape } from '../../app/contracts.ts';
import { CHUNK, CHUNK_VOL, EMPTY, FULL, ISO, MIXED, VoxelGrid, densityFromSdf, type GridLayout } from './grid.ts';

/**
 * Analytic description of an element's original (pristine) shape in element-local metres. The grid
 * is filled from it, Surface Nets snaps untouched cells onto it (so a remeshed pristine chunk
 * matches the analytic base mesh exactly), and `aDepth` = −sdf tells the shader how far below the
 * original surface a fractured face lies.
 */
export interface ShapeSdf {
  readonly type: 'box' | 'cylinder' | 'sdf';
  /** Half extents of the local bounding box, m */
  readonly half: [number, number, number];
  /** Smallest structural dimension (wall/slab thickness, column diameter), m */
  readonly thickness: number;
  /** Analytic volume, m³ */
  readonly volume: number;
  /** Signed distance, negative inside (m). Exact for boxes; a Lipschitz ≤ ~1.2 bound otherwise. */
  sdf(x: number, y: number, z: number): number;
  /** Fast test of sdf ≤ 0 (the sample would be solid in the pristine grid). */
  solidAt(x: number, y: number, z: number): boolean;
  /**
   * Place the Surface Nets vertex of an untouched cell exactly on the analytic surface.
   * (cx,cy,cz) is the cell's minimum sample corner; writes a local position in metres into `out`
   * (and the analytic outward normal into `n`). Returns false to keep the plain Surface Nets vertex.
   */
  snap(grid: VoxelGrid, cx: number, cy: number, cz: number, out: Float64Array, n: Float64Array): boolean;
}

export class BoxShape implements ShapeSdf {
  readonly type = 'box';
  readonly half: [number, number, number];
  readonly thickness: number;
  readonly volume: number;

  constructor(size: [number, number, number]) {
    this.half = [size[0] / 2, size[1] / 2, size[2] / 2];
    this.thickness = Math.min(size[0], size[1], size[2]);
    this.volume = size[0] * size[1] * size[2];
  }

  solidAt(x: number, y: number, z: number): boolean {
    return Math.abs(x) <= this.half[0] && Math.abs(y) <= this.half[1] && Math.abs(z) <= this.half[2];
  }

  sdf(x: number, y: number, z: number): number {
    // Exact box SDF (Inigo Quilez, "distance functions").
    const qx = Math.abs(x) - this.half[0], qy = Math.abs(y) - this.half[1], qz = Math.abs(z) - this.half[2];
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
    return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0);
  }

  snap(g: VoxelGrid, cx: number, cy: number, cz: number, out: Float64Array, n: Float64Array): boolean {
    // Each axis whose face plane passes through the cell snaps onto it; others take the cell
    // centre. Face cells land on the plane, edge cells on the edge line, corner cells on the corner.
    const h = g.h;
    let nx = 0, ny = 0, nz = 0;
    const x0 = g.ox + cx * h, y0 = g.oy + cy * h, z0 = g.oz + cz * h;
    const [hx, hy, hz] = this.half;
    let x = x0 + 0.5 * h, y = y0 + 0.5 * h, z = z0 + 0.5 * h;
    if (-hx >= x0 && -hx <= x0 + h) { x = -hx; nx = -1; } else if (hx >= x0 && hx <= x0 + h) { x = hx; nx = 1; }
    if (-hy >= y0 && -hy <= y0 + h) { y = -hy; ny = -1; } else if (hy >= y0 && hy <= y0 + h) { y = hy; ny = 1; }
    if (-hz >= z0 && -hz <= z0 + h) { z = -hz; nz = -1; } else if (hz >= z0 && hz <= z0 + h) { z = hz; nz = 1; }
    if (nx === 0 && ny === 0 && nz === 0) return false;
    out[0] = x; out[1] = y; out[2] = z;
    const l = Math.hypot(nx, ny, nz);
    n[0] = nx / l; n[1] = ny / l; n[2] = nz / l;
    return true;
  }
}

/**
 * Vertical (local Y) cylinder with optional entasis-like linear taper and concave flutes that meet
 * in sharp arrises (Doric profile: parabolic flute section of depth ≈ radius/12).
 */
export class CylinderShape implements ShapeSdf {
  readonly type = 'cylinder';
  readonly half: [number, number, number];
  readonly thickness: number;
  readonly volume: number;
  readonly radius: number;
  readonly height: number;
  readonly flutes: number;
  readonly taper: number;
  readonly fluteDepth: number;

  constructor(radius: number, height: number, flutes = 0, taper = 0) {
    this.radius = radius;
    this.height = height;
    this.flutes = Math.max(0, Math.round(flutes));
    this.taper = Math.min(0.5, Math.max(0, taper));
    this.fluteDepth = this.flutes > 0 ? Math.min(radius * 0.08, (Math.PI * radius) / this.flutes * 0.28) : 0;
    this.half = [radius, height / 2, radius];
    this.thickness = 2 * radius * (1 - this.taper);
    // Frustum volume minus the flute sections (parabolic segment area = 2/3 · width · depth).
    const r0 = radius, r1 = radius * (1 - this.taper);
    const frustum = (Math.PI * height * (r0 * r0 + r0 * r1 + r1 * r1)) / 3;
    const rm = (r0 + r1) / 2;
    const fluteArea = this.flutes * (2 / 3) * ((2 * Math.PI * rm) / Math.max(1, this.flutes)) * this.fluteDepth;
    this.volume = frustum - fluteArea * height;
  }

  /** Radius of the arris circle at height y. */
  radiusAt(y: number): number {
    const t = (y + this.height / 2) / this.height;
    return this.radius * (1 - this.taper * Math.min(1, Math.max(0, t)));
  }

  /** 2D signed distance to the (fluted) section at height y. */
  sdf2(x: number, z: number, y: number): number {
    const rho = Math.hypot(x, z);
    let r = this.radiusAt(y);
    if (this.flutes > 0 && rho > 1e-9) {
      // Parabolic flute: depth fd·(1 − u²), u ∈ [−1, 1] across one flute; arrises at u = ±1.
      const a = Math.atan2(z, x);
      const f = (a / (2 * Math.PI)) * this.flutes;
      const u = 2 * (f - Math.floor(f)) - 1;
      r -= this.fluteDepth * (1 - u * u) * (r / this.radius);
    }
    return rho - r;
  }

  solidAt(x: number, y: number, z: number): boolean {
    if (Math.abs(y) > this.height / 2) return false;
    const r = this.radiusAt(y);
    const rho2 = x * x + z * z;
    if (rho2 > r * r) return false;
    const inner = r - this.fluteDepth;
    if (rho2 <= inner * inner) return true;
    return this.sdf2(x, z, y) <= 0;
  }

  sdf(x: number, y: number, z: number): number {
    const d = this.sdf2(x, z, y);
    const dy = Math.abs(y) - this.height / 2;
    const ox = Math.max(d, 0), oy = Math.max(dy, 0);
    return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(d, dy), 0);
  }

  snap(g: VoxelGrid, cx: number, cy: number, cz: number, out: Float64Array, n: Float64Array): boolean {
    const h = g.h;
    const x0 = g.ox + cx * h, y0 = g.oy + cy * h, z0 = g.oz + cz * h;
    const hh = this.height / 2;
    let y = y0 + 0.5 * h;
    let capN = 0;
    if (-hh >= y0 && -hh <= y0 + h) { y = -hh; capN = -1; } else if (hh >= y0 && hh <= y0 + h) { y = hh; capN = 1; }
    // Radial crossing inside the cell footprint?
    const yy = Math.min(hh - 1e-6, Math.max(-hh + 1e-6, y));
    const s00 = this.sdf2(x0, z0, yy), s10 = this.sdf2(x0 + h, z0, yy);
    const s01 = this.sdf2(x0, z0 + h, yy), s11 = this.sdf2(x0 + h, z0 + h, yy);
    const anyIn = s00 < 0 || s10 < 0 || s01 < 0 || s11 < 0;
    const anyOut = s00 >= 0 || s10 >= 0 || s01 >= 0 || s11 >= 0;
    let x = x0 + 0.5 * h, z = z0 + 0.5 * h;
    let nx = 0, nz = 0;
    if (anyIn && anyOut) {
      // Solve along the dominant horizontal axis through the cell centre so the other two
      // coordinates stay on cell-centre planes (chunk seams then line up with the base mesh).
      const e = 1e-4;
      const gxx = this.sdf2(x + e, z, yy) - this.sdf2(x - e, z, yy);
      const gzz = this.sdf2(x, z + e, yy) - this.sdf2(x, z - e, yy);
      const alongX = Math.abs(gxx) >= Math.abs(gzz);
      let lo = alongX ? x0 : z0, hi = lo + h;
      const f = (t: number) => (alongX ? this.sdf2(t, z, yy) : this.sdf2(x, t, yy));
      let flo = f(lo), fhi = f(hi);
      if (flo < 0 === fhi < 0) return false;
      for (let it = 0; it < 24; it++) {
        const mid = 0.5 * (lo + hi);
        const fm = f(mid);
        if (fm < 0 === flo < 0) { lo = mid; flo = fm; } else { hi = mid; fhi = fm; }
      }
      const t = 0.5 * (lo + hi);
      if (alongX) x = t; else z = t;
      const gx2 = this.sdf2(x + e, z, yy) - this.sdf2(x - e, z, yy);
      const gz2 = this.sdf2(x, z + e, yy) - this.sdf2(x, z - e, yy);
      const l = Math.hypot(gx2, gz2) || 1;
      nx = gx2 / l;
      nz = gz2 / l;
    } else if (capN === 0) {
      return false;
    }
    out[0] = x; out[1] = y; out[2] = z;
    let ny = capN;
    if (capN !== 0 && (nx !== 0 || nz !== 0)) {
      nx *= 0.7071; nz *= 0.7071; ny *= 0.7071;
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    n[0] = nx / l; n[1] = ny / l; n[2] = nz / l;
    return true;
  }
}

/** User-supplied SDF within bounds centred on the origin; untouched cells keep plain Surface Nets. */
export class CustomShape implements ShapeSdf {
  readonly type = 'sdf';
  readonly half: [number, number, number];
  readonly thickness: number;
  volume: number;
  private fn: (x: number, y: number, z: number) => number;

  constructor(bounds: [number, number, number], fn: (x: number, y: number, z: number) => number) {
    this.half = [bounds[0] / 2, bounds[1] / 2, bounds[2] / 2];
    this.thickness = Math.min(bounds[0], bounds[1], bounds[2]);
    this.fn = fn;
    this.volume = bounds[0] * bounds[1] * bounds[2]; // replaced by the voxel count after filling
  }

  sdf(x: number, y: number, z: number): number {
    return this.fn(x, y, z);
  }

  solidAt(x: number, y: number, z: number): boolean {
    return this.fn(x, y, z) <= 0;
  }

  snap(): boolean {
    return false;
  }
}

function vec3(v: [number, number, number] | { x: number; y: number; z: number }): [number, number, number] {
  return Array.isArray(v) ? [v[0], v[1], v[2]] : [v.x, v.y, v.z];
}

export function makeShape(s: VoxelShape): ShapeSdf {
  switch (s.type) {
    case 'box':
      return new BoxShape(vec3(s.size));
    case 'cylinder':
      return new CylinderShape(s.radius, s.height, s.flutes ?? 0, s.taper ?? 0);
    case 'sdf':
      return new CustomShape(vec3(s.bounds), s.sdf);
  }
}

/** Largest element we voxelise at full resolution (samples). */
export const MAX_SAMPLES = 3_000_000;

/**
 * Pick the voxel size and the grid placement for a shape. The grid carries two empty samples of
 * padding on every side and puts the −X/−Y/−Z faces of a box (and the thin dimension's both
 * faces) on mid-planes between samples, where the linear density ramp reconstructs them exactly.
 */
export function layoutFor(shape: ShapeSdf, requested: number): GridLayout {
  let h = requested;
  const [hx, hy, hz] = shape.half;
  const count = (hh: number) => Math.ceil((2 * (hx + 0.001)) / hh + 4) * Math.ceil((2 * (hy + 0.001)) / hh + 4) * Math.ceil((2 * (hz + 0.001)) / hh + 4);
  if (count(h) > MAX_SAMPLES) h *= Math.cbrt(count(h) / MAX_SAMPLES) * 1.02;
  if (shape.type === 'box') {
    // Make the thinnest dimension an exact multiple of h so both of its faces sit on mid-planes.
    const t = shape.thickness;
    const m = Math.max(2, Math.round(t / h));
    h = t / m;
  }
  const n: [number, number, number] = [0, 0, 0];
  const origin: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const half = shape.half[a]!;
    origin[a] = -half - 1.5 * h;
    n[a] = Math.ceil((2 * half) / h - 1e-6) + 4;
  }
  return { h, origin, n };
}

/**
 * Fill a fresh grid from the shape. Chunks far from the surface are classified EMPTY/FULL from one
 * SDF evaluation at their centre (the SDF is a distance bound), the rest are sampled.
 */
export function fillGrid(grid: VoxelGrid, shape: ShapeSdf): void {
  const h = grid.h;
  const reach = (CHUNK / 2) * h * Math.sqrt(3) * 1.25 + 2 * h;
  for (let c = 0; c < grid.cz; c++)
    for (let b = 0; b < grid.cy; b++)
      for (let a = 0; a < grid.cx; a++) {
        const ci = grid.chunkIndex(a, b, c);
        const i0 = a * CHUNK, j0 = b * CHUNK, k0 = c * CHUNK;
        const mx = grid.ox + (i0 + (CHUNK - 1) / 2) * h;
        const my = grid.oy + (j0 + (CHUNK - 1) / 2) * h;
        const mz = grid.oz + (k0 + (CHUNK - 1) / 2) * h;
        const sc = shape.sdf(mx, my, mz);
        const partial = i0 + CHUNK > grid.nx || j0 + CHUNK > grid.ny || k0 + CHUNK > grid.nz;
        if (sc > reach) {
          grid.state[ci] = EMPTY;
          continue;
        }
        if (sc < -reach && !partial) {
          grid.state[ci] = FULL;
          continue;
        }
        const d = new Uint8Array(CHUNK_VOL);
        let any = false, all = true;
        for (let z = 0; z < CHUNK; z++) {
          const k = k0 + z;
          const lz = grid.oz + k * h;
          for (let y = 0; y < CHUNK; y++) {
            const j = j0 + y;
            const ly = grid.oy + j * h;
            for (let x = 0; x < CHUNK; x++) {
              const i = i0 + x;
              let v = 0;
              if (i < grid.nx && j < grid.ny && k < grid.nz) v = densityFromSdf(shape.sdf(grid.ox + i * h, ly, lz), h);
              d[x | (y << 4) | (z << 8)] = v;
              if (v !== 0) any = true;
              if (v !== 255) all = false;
            }
          }
        }
        if (!any) grid.state[ci] = EMPTY;
        else if (all) grid.state[ci] = FULL;
        else {
          grid.state[ci] = MIXED;
          grid.dens[ci] = d;
          grid.dmg[ci] = new Uint8Array(CHUNK_VOL);
          grid.soot[ci] = new Uint8Array(CHUNK_VOL);
        }
      }
  grid.recount();
  if (shape instanceof CustomShape) shape.volume = grid.solidVolume();
}

/** True if sample densities still agree in sign with the analytic shape at the 8 cell corners. */
export function cellMatchesShape(grid: VoxelGrid, shape: ShapeSdf, cx: number, cy: number, cz: number, dens: ArrayLike<number>, base: number, offs: ArrayLike<number>): boolean {
  const h = grid.h;
  const x0 = grid.ox + cx * h, y0 = grid.oy + cy * h, z0 = grid.oz + cz * h;
  for (let c = 0; c < 8; c++) {
    const inside = dens[base + offs[c]!]! >= ISO;
    if (inside !== shape.solidAt(x0 + (c & 1) * h, y0 + ((c >> 1) & 1) * h, z0 + ((c >> 2) & 1) * h)) return false;
  }
  return true;
}
