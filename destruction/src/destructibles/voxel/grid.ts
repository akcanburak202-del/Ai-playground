/**
 * Sparse voxel grid in element-local space.
 *
 * Density is sampled at grid *points* p(i,j,k) = origin + (i,j,k)·h and stored as Uint8 with the
 * surface at the iso value 128 (density = 128 − 128·sdf/h, clamped), so a signed distance field
 * maps linearly onto the byte range across one voxel on either side of the surface. That keeps
 * flat faces exact after trilinear reconstruction and makes CSG carving a plain `min`.
 *
 * Samples are grouped in 16³ chunks: EMPTY and FULL chunks hold no arrays at all, MIXED chunks hold
 * density, damage (continuum damage D·255) and soot (0..255) arrays. Per-chunk and per-row (local
 * y) solid counts are maintained on every write so mass, supports and crushing checks never have to
 * rescan the grid.
 */
export const CHUNK = 16;
export const CHUNK_SHIFT = 4;
export const CHUNK_MASK = 15;
export const CHUNK_VOL = CHUNK * CHUNK * CHUNK;
export const ISO = 128;

export const EMPTY = 0;
export const FULL = 1;
export const MIXED = 2;

export interface GridLayout {
  /** Voxel edge / sample spacing, m */
  h: number;
  /** Local position of sample (0,0,0), m */
  origin: [number, number, number];
  /** Sample counts per axis */
  n: [number, number, number];
}

/**
 * Density byte for a signed distance (negative inside), per the linear one-voxel ramp. The iso
 * value itself is never stored: a sample exactly at 128 would put Surface Nets vertices of several
 * cells on the same point and produce degenerate triangles.
 */
export function densityFromSdf(sdf: number, h: number): number {
  const d = Math.round(ISO - (ISO * sdf) / h);
  if (d === ISO) return sdf <= 0 ? ISO + 1 : ISO - 1;
  return d < 0 ? 0 : d > 255 ? 255 : d;
}

/** Carve density byte for a carve-SDF value s (negative inside the removed region). */
export function carveDensity(s: number, h: number): number {
  const v = Math.round(ISO + (ISO * s) / h);
  if (v === ISO) return s >= 0 ? ISO + 1 : ISO - 1;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export class VoxelGrid {
  readonly h: number;
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly chunkCount: number;
  readonly state: Uint8Array;
  readonly dens: (Uint8Array | null)[];
  readonly dmg: (Uint8Array | null)[];
  readonly soot: (Uint8Array | null)[];
  /** Samples with density ≥ ISO per chunk */
  readonly solid: Int32Array;
  /** Samples with density ≥ ISO per local-y row j (column crushing) */
  readonly rowSolid: Int32Array;
  totalSolid = 0;
  /** Chunks whose surface mesh is stale (set by every write that can change the mesh) */
  readonly dirty: Uint8Array;
  readonly dirtyList: number[] = [];
  /** Chunks whose coarse occupancy (connectivity, colliders) is stale */
  readonly occDirty: Uint8Array;
  readonly occDirtyList: number[] = [];
  /** Bumped on every density write; cheap change detection for caches */
  version = 0;

  /** Scratch outputs of `locate` (avoids allocating a tuple per sample). */
  ci = 0;
  li = 0;

  constructor(layout: GridLayout) {
    this.h = layout.h;
    [this.ox, this.oy, this.oz] = layout.origin;
    [this.nx, this.ny, this.nz] = layout.n;
    this.cx = Math.ceil(this.nx / CHUNK);
    this.cy = Math.ceil(this.ny / CHUNK);
    this.cz = Math.ceil(this.nz / CHUNK);
    this.chunkCount = this.cx * this.cy * this.cz;
    this.state = new Uint8Array(this.chunkCount);
    this.dens = new Array(this.chunkCount).fill(null);
    this.dmg = new Array(this.chunkCount).fill(null);
    this.soot = new Array(this.chunkCount).fill(null);
    this.solid = new Int32Array(this.chunkCount);
    this.rowSolid = new Int32Array(this.ny);
    this.dirty = new Uint8Array(this.chunkCount);
    this.occDirty = new Uint8Array(this.chunkCount);
  }

  layout(): GridLayout {
    return { h: this.h, origin: [this.ox, this.oy, this.oz], n: [this.nx, this.ny, this.nz] };
  }

  chunkIndex(a: number, b: number, c: number): number {
    return a + this.cx * (b + this.cy * c);
  }

  inside(i: number, j: number, k: number): boolean {
    return i >= 0 && j >= 0 && k >= 0 && i < this.nx && j < this.ny && k < this.nz;
  }

  /** Sets `ci`/`li` for sample (i,j,k), which must be inside the grid. */
  locate(i: number, j: number, k: number): void {
    this.ci = (i >> CHUNK_SHIFT) + this.cx * ((j >> CHUNK_SHIFT) + this.cy * (k >> CHUNK_SHIFT));
    this.li = (i & CHUNK_MASK) | ((j & CHUNK_MASK) << 4) | ((k & CHUNK_MASK) << 8);
  }

  density(i: number, j: number, k: number): number {
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return 0;
    const ci = (i >> CHUNK_SHIFT) + this.cx * ((j >> CHUNK_SHIFT) + this.cy * (k >> CHUNK_SHIFT));
    const s = this.state[ci]!;
    if (s === EMPTY) return 0;
    if (s === FULL) return 255;
    return this.dens[ci]![(i & CHUNK_MASK) | ((j & CHUNK_MASK) << 4) | ((k & CHUNK_MASK) << 8)]!;
  }

  damage(i: number, j: number, k: number): number {
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return 0;
    const ci = (i >> CHUNK_SHIFT) + this.cx * ((j >> CHUNK_SHIFT) + this.cy * (k >> CHUNK_SHIFT));
    const a = this.dmg[ci];
    if (!a) return 0;
    return a[(i & CHUNK_MASK) | ((j & CHUNK_MASK) << 4) | ((k & CHUNK_MASK) << 8)]!;
  }

  sootAt(i: number, j: number, k: number): number {
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return 0;
    const ci = (i >> CHUNK_SHIFT) + this.cx * ((j >> CHUNK_SHIFT) + this.cy * (k >> CHUNK_SHIFT));
    const a = this.soot[ci];
    if (!a) return 0;
    return a[(i & CHUNK_MASK) | ((j & CHUNK_MASK) << 4) | ((k & CHUNK_MASK) << 8)]!;
  }

  /** Give chunk `ci` its arrays (EMPTY → zeros, FULL → 255) so it can be written. */
  ensureMixed(ci: number): void {
    const s = this.state[ci]!;
    if (s === MIXED) return;
    const d = new Uint8Array(CHUNK_VOL);
    if (s === FULL) d.fill(255);
    this.dens[ci] = d;
    this.dmg[ci] = new Uint8Array(CHUNK_VOL);
    this.soot[ci] = new Uint8Array(CHUNK_VOL);
    this.state[ci] = MIXED;
  }

  /**
   * Write a density byte through the solid bookkeeping. `ci`/`li` from `locate`, `j` the sample
   * row. The chunk must be MIXED.
   */
  writeDensity(ci: number, li: number, j: number, v: number): void {
    const a = this.dens[ci]!;
    const old = a[li]!;
    if (old === v) return;
    a[li] = v;
    this.version++;
    if (old >= ISO !== v >= ISO) {
      const s = v >= ISO ? 1 : -1;
      this.solid[ci]! += s;
      this.rowSolid[j]! += s;
      this.totalSolid += s;
    }
  }

  /** Lower the density of sample (i,j,k) to at most `v` (CSG subtraction). Returns bytes removed. */
  carveSample(i: number, j: number, k: number, v: number): number {
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return 0;
    this.locate(i, j, k);
    const ci = this.ci;
    const s = this.state[ci]!;
    if (s === EMPTY) return 0;
    if (s === FULL) {
      if (v >= 255) return 0;
      this.ensureMixed(ci);
    }
    const old = this.dens[ci]![this.li]!;
    if (v >= old) return 0;
    this.writeDensity(ci, this.li, j, v);
    return old - v;
  }

  /**
   * Mark chunks whose meshes depend on samples in [i0,i1]×[j0,j1]×[k0,k1] as dirty. A sample
   * feeds the cells [s−1, s] and, through central-difference normals, cells [s−2, s+1].
   */
  markDirty(i0: number, j0: number, k0: number, i1: number, j1: number, k1: number): void {
    const a0 = Math.max(0, (i0 - 2) >> CHUNK_SHIFT), a1 = Math.min(this.cx - 1, (i1 + 1) >> CHUNK_SHIFT);
    const b0 = Math.max(0, (j0 - 2) >> CHUNK_SHIFT), b1 = Math.min(this.cy - 1, (j1 + 1) >> CHUNK_SHIFT);
    const c0 = Math.max(0, (k0 - 2) >> CHUNK_SHIFT), c1 = Math.min(this.cz - 1, (k1 + 1) >> CHUNK_SHIFT);
    for (let c = c0; c <= c1; c++)
      for (let b = b0; b <= b1; b++)
        for (let a = a0; a <= a1; a++) {
          const ci = a + this.cx * (b + this.cy * c);
          if (!this.dirty[ci]) {
            this.dirty[ci] = 1;
            this.dirtyList.push(ci);
          }
        }
    const oa0 = Math.max(0, i0 >> CHUNK_SHIFT), oa1 = Math.min(this.cx - 1, i1 >> CHUNK_SHIFT);
    const ob0 = Math.max(0, j0 >> CHUNK_SHIFT), ob1 = Math.min(this.cy - 1, j1 >> CHUNK_SHIFT);
    const oc0 = Math.max(0, k0 >> CHUNK_SHIFT), oc1 = Math.min(this.cz - 1, k1 >> CHUNK_SHIFT);
    for (let c = oc0; c <= oc1; c++)
      for (let b = ob0; b <= ob1; b++)
        for (let a = oa0; a <= oa1; a++) {
          const ci = a + this.cx * (b + this.cy * c);
          if (!this.occDirty[ci]) {
            this.occDirty[ci] = 1;
            this.occDirtyList.push(ci);
          }
        }
  }

  /** Drop the arrays of a MIXED chunk that became uniform again. */
  compact(ci: number): void {
    if (this.state[ci] !== MIXED) return;
    const d = this.dens[ci]!;
    const dm = this.dmg[ci]!;
    const so = this.soot[ci]!;
    let allZero = true;
    for (let i = 0; i < CHUNK_VOL; i++) if (d[i] !== 0) { allZero = false; break; }
    if (allZero) {
      this.state[ci] = EMPTY;
      this.dens[ci] = this.dmg[ci] = this.soot[ci] = null;
      return;
    }
    for (let i = 0; i < CHUNK_VOL; i++) if (d[i] !== 255 || dm[i] !== 0 || so[i] !== 0) return;
    this.state[ci] = FULL;
    this.dens[ci] = this.dmg[ci] = this.soot[ci] = null;
  }

  /** Sample bounds of non-empty chunks, [i0,j0,k0,i1,j1,k1] inclusive, or null if empty. */
  occupiedSampleBounds(): [number, number, number, number, number, number] | null {
    let a0 = Infinity, b0 = Infinity, c0 = Infinity, a1 = -1, b1 = -1, c1 = -1;
    for (let c = 0; c < this.cz; c++)
      for (let b = 0; b < this.cy; b++)
        for (let a = 0; a < this.cx; a++) {
          const ci = a + this.cx * (b + this.cy * c);
          if (this.state[ci] === EMPTY) continue;
          if (this.state[ci] === MIXED && this.solid[ci] === 0 && !this.hasAnyDensity(ci)) continue;
          if (a < a0) a0 = a;
          if (b < b0) b0 = b;
          if (c < c0) c0 = c;
          if (a > a1) a1 = a;
          if (b > b1) b1 = b;
          if (c > c1) c1 = c;
        }
    if (a1 < 0) return null;
    return [
      a0 * CHUNK, b0 * CHUNK, c0 * CHUNK,
      Math.min(this.nx - 1, a1 * CHUNK + CHUNK - 1), Math.min(this.ny - 1, b1 * CHUNK + CHUNK - 1), Math.min(this.nz - 1, c1 * CHUNK + CHUNK - 1),
    ];
  }

  /** Exact sample bounds of solid material, or null. Scans MIXED chunks only. */
  solidSampleBounds(): [number, number, number, number, number, number] | null {
    let i0 = Infinity, j0 = Infinity, k0 = Infinity, i1 = -1, j1 = -1, k1 = -1;
    for (let c = 0; c < this.cz; c++)
      for (let b = 0; b < this.cy; b++)
        for (let a = 0; a < this.cx; a++) {
          const ci = a + this.cx * (b + this.cy * c);
          const s = this.state[ci]!;
          if (s === EMPTY || (s === MIXED && this.solid[ci] === 0)) continue;
          const bi = a * CHUNK, bj = b * CHUNK, bk = c * CHUNK;
          if (s === FULL) {
            i0 = Math.min(i0, bi); j0 = Math.min(j0, bj); k0 = Math.min(k0, bk);
            i1 = Math.max(i1, bi + CHUNK - 1); j1 = Math.max(j1, bj + CHUNK - 1); k1 = Math.max(k1, bk + CHUNK - 1);
            continue;
          }
          const d = this.dens[ci]!;
          for (let li = 0; li < CHUNK_VOL; li++) {
            if (d[li]! < ISO) continue;
            const x = bi + (li & 15), y = bj + ((li >> 4) & 15), z = bk + (li >> 8);
            if (x < i0) i0 = x;
            if (y < j0) j0 = y;
            if (z < k0) k0 = z;
            if (x > i1) i1 = x;
            if (y > j1) j1 = y;
            if (z > k1) k1 = z;
          }
        }
    if (i1 < 0) return null;
    return [i0, j0, k0, Math.min(i1, this.nx - 1), Math.min(j1, this.ny - 1), Math.min(k1, this.nz - 1)];
  }

  private hasAnyDensity(ci: number): boolean {
    const d = this.dens[ci];
    if (!d) return this.state[ci] === FULL;
    for (let i = 0; i < CHUNK_VOL; i++) if (d[i] !== 0) return true;
    return false;
  }

  /** Trilinear density at continuous sample coordinates. */
  densityAt(gx: number, gy: number, gz: number): number {
    const i = Math.floor(gx), j = Math.floor(gy), k = Math.floor(gz);
    const fx = gx - i, fy = gy - j, fz = gz - k;
    const d000 = this.density(i, j, k), d100 = this.density(i + 1, j, k);
    const d010 = this.density(i, j + 1, k), d110 = this.density(i + 1, j + 1, k);
    const d001 = this.density(i, j, k + 1), d101 = this.density(i + 1, j, k + 1);
    const d011 = this.density(i, j + 1, k + 1), d111 = this.density(i + 1, j + 1, k + 1);
    const x00 = d000 + (d100 - d000) * fx, x10 = d010 + (d110 - d010) * fx;
    const x01 = d001 + (d101 - d001) * fx, x11 = d011 + (d111 - d011) * fx;
    const y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
    return y0 + (y1 - y0) * fz;
  }

  /** Nearest-sample damage 0..1 at continuous sample coordinates. */
  damageAt(gx: number, gy: number, gz: number): number {
    return this.damage(Math.round(gx), Math.round(gy), Math.round(gz)) / 255;
  }

  /** Outward normal (−∇density) at continuous sample coordinates, via central differences. */
  normalAt(gx: number, gy: number, gz: number, out: { x: number; y: number; z: number }): void {
    const e = 0.75;
    const nx = this.densityAt(gx - e, gy, gz) - this.densityAt(gx + e, gy, gz);
    const ny = this.densityAt(gx, gy - e, gz) - this.densityAt(gx, gy + e, gz);
    const nz = this.densityAt(gx, gy, gz - e) - this.densityAt(gx, gy, gz + e);
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-6) {
      out.x = 0; out.y = 1; out.z = 0;
      return;
    }
    out.x = nx / l; out.y = ny / l; out.z = nz / l;
  }

  /** Solid volume, m³ */
  solidVolume(): number {
    return this.totalSolid * this.h * this.h * this.h;
  }

  /** Local position of a sample coordinate along one axis. */
  lx(g: number): number {
    return this.ox + g * this.h;
  }
  ly(g: number): number {
    return this.oy + g * this.h;
  }
  lz(g: number): number {
    return this.oz + g * this.h;
  }
  /** Sample coordinate of a local position along one axis. */
  gx(x: number): number {
    return (x - this.ox) / this.h;
  }
  gy(y: number): number {
    return (y - this.oy) / this.h;
  }
  gz(z: number): number {
    return (z - this.oz) / this.h;
  }

  /** Recount solid bookkeeping from scratch (after bulk construction). */
  recount(): void {
    this.solid.fill(0);
    this.rowSolid.fill(0);
    this.totalSolid = 0;
    for (let c = 0; c < this.cz; c++)
      for (let b = 0; b < this.cy; b++)
        for (let a = 0; a < this.cx; a++) {
          const ci = a + this.cx * (b + this.cy * c);
          const s = this.state[ci]!;
          if (s === EMPTY) continue;
          const bj = b * CHUNK;
          const ni = Math.min(CHUNK, this.nx - a * CHUNK), nj = Math.min(CHUNK, this.ny - bj), nk = Math.min(CHUNK, this.nz - c * CHUNK);
          if (s === FULL) {
            const perRow = ni * nk;
            for (let y = 0; y < nj; y++) this.rowSolid[bj + y]! += perRow;
            this.solid[ci] = perRow * nj;
            this.totalSolid += perRow * nj;
            continue;
          }
          const d = this.dens[ci]!;
          let n = 0;
          for (let z = 0; z < nk; z++)
            for (let y = 0; y < nj; y++)
              for (let x = 0; x < ni; x++) {
                if (d[x | (y << 4) | (z << 8)]! >= ISO) {
                  n++;
                  this.rowSolid[bj + y]!++;
                }
              }
          this.solid[ci] = n;
          this.totalSolid += n;
        }
  }
}

/**
 * Copy the sample box [i0..i1]×[j0..j1]×[k0..k1] (padded by `pad` samples) into a new, smaller grid
 * on the same lattice and local frame: sample (i,j,k) of the source is sample (i−i0+pad, …) of the
 * result. Debris pieces use this so their cost scales with their own size, not their parent's.
 */
export function cropGrid(src: VoxelGrid, box: [number, number, number, number, number, number], pad = 2): VoxelGrid {
  const [i0, j0, k0, i1, j1, k1] = box;
  const a0 = i0 - pad, b0 = j0 - pad, c0 = k0 - pad;
  const out = new VoxelGrid({
    h: src.h,
    origin: [src.ox + a0 * src.h, src.oy + b0 * src.h, src.oz + c0 * src.h],
    n: [i1 - i0 + 1 + 2 * pad, j1 - j0 + 1 + 2 * pad, k1 - k0 + 1 + 2 * pad],
  });
  // Copy source chunk by chunk (direct array reads).
  for (let C = k0 >> CHUNK_SHIFT; C <= k1 >> CHUNK_SHIFT; C++)
    for (let B = j0 >> CHUNK_SHIFT; B <= j1 >> CHUNK_SHIFT; B++)
      for (let A = i0 >> CHUNK_SHIFT; A <= i1 >> CHUNK_SHIFT; A++) {
        const sci = src.chunkIndex(A, B, C);
        const st = src.state[sci]!;
        if (st === EMPTY) continue;
        const SD = src.dens[sci], SM = src.dmg[sci], SS = src.soot[sci];
        const ka = Math.max(k0, C * CHUNK), kb = Math.min(k1, C * CHUNK + CHUNK - 1);
        const ja = Math.max(j0, B * CHUNK), jb = Math.min(j1, B * CHUNK + CHUNK - 1);
        const ia = Math.max(i0, A * CHUNK), ib = Math.min(i1, A * CHUNK + CHUNK - 1);
        for (let k = ka; k <= kb; k++)
          for (let j = ja; j <= jb; j++) {
            const row = ((j & CHUNK_MASK) << 4) | ((k & CHUNK_MASK) << 8);
            for (let i = ia; i <= ib; i++) {
              const li = (i & CHUNK_MASK) | row;
              const d = SD ? SD[li]! : 255;
              if (d === 0) continue;
              out.locate(i - a0, j - b0, k - c0);
              const ci = out.ci, oli = out.li;
              if (out.state[ci] !== MIXED) out.ensureMixed(ci);
              out.dens[ci]![oli] = d;
              if (SM) out.dmg[ci]![oli] = SM[li]!;
              if (SS) out.soot[ci]![oli] = SS[li]!;
            }
          }
      }
  for (let ci = 0; ci < out.chunkCount; ci++) out.compact(ci);
  out.recount();
  return out;
}
