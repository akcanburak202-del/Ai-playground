import { Noise3 } from '../../core/noise.ts';
import type { Rng } from '../../core/rng.ts';
import { CHUNK, CHUNK_MASK, CHUNK_SHIFT, EMPTY, ISO, MIXED, VoxelGrid, carveDensity, cropGrid, densityFromSdf } from './grid.ts';

/**
 * Cutting material out of a grid into new "piece" grids (same layout and local frame, so a piece
 * keeps its parent's textures, original-surface depth and rebar coordinates).
 *
 * Large releases are split into Voronoi cells (the classic prefractured-debris approach, e.g.
 * Müller et al. 2013, "Real time dynamic fracture with volumetric approximate convex
 * decompositions"): seeds are denser near the last impact, the bisector planes are bent by noise
 * and pulled apart by a small gap so neighbouring pieces start separated, and the cut faces get
 * micro-crack damage so they render as fresh fractures.
 */
export interface Selection {
  /** Inclusive sample box to scan */
  box: [number, number, number, number, number, number];
  /** Fast path for coarse-cell selections: take samples whose coarse cell (F³ samples) is set */
  cells?: { mask: Uint8Array; F: number; nx: number; ny: number };
  /**
   * Membership: for cell selections, return 1 (take the whole sample) or 0 (skip). For region
   * selections (`sdf` true), return the region's signed distance (m, negative inside).
   */
  test(i: number, j: number, k: number, x: number, y: number, z: number): number;
  sdf: boolean;
}

export interface Piece {
  grid: VoxelGrid;
  /** Solid volume, m³ */
  volume: number;
  /** Seed (local) */
  seed: [number, number, number];
  /** Index of the seed this piece grew from (order of the `seeds` argument) */
  seedIndex: number;
  /** All seeds of the split (xyz triples, local), shared by the sibling pieces */
  seeds: number[];
  /** Solid sample bounds (inclusive) or null if empty */
  bounds: [number, number, number, number, number, number] | null;
}

const noise = new Noise3(0x7a11);
const FRACTURE_DAMAGE = 80;

/** Pick `n` seeds among candidate points, biased towards `focus` (weights 1/(d + 0.25)²). */
export function pickSeeds(candidates: Float64Array, count: number, n: number, focus: [number, number, number] | null, minSpacing: number, rng: Rng): number[] {
  const seeds: number[] = [];
  if (count === 0) return seeds;
  // Prefix sums of the weights; each draw is a binary search.
  const cdf = new Float64Array(count);
  let total = 0;
  for (let c = 0; c < count; c++) {
    let wt = 1;
    if (focus) {
      const d = Math.hypot(candidates[c * 3]! - focus[0], candidates[c * 3 + 1]! - focus[1], candidates[c * 3 + 2]! - focus[2]);
      wt = 1 / ((d + 0.25) * (d + 0.25));
    }
    total += wt;
    cdf[c] = total;
  }
  const ms2 = minSpacing * minSpacing;
  for (let attempt = 0; attempt < n * 30 && seeds.length < n * 3; attempt++) {
    const r = rng.next() * total;
    let lo = 0, hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid]! < r) lo = mid + 1;
      else hi = mid;
    }
    const c = lo;
    const x = candidates[c * 3]!, y = candidates[c * 3 + 1]!, z = candidates[c * 3 + 2]!;
    let ok = true;
    for (let s = 0; s < seeds.length; s += 3) {
      const dx = seeds[s]! - x, dy = seeds[s + 1]! - y, dz = seeds[s + 2]! - z;
      if (dx * dx + dy * dy + dz * dz < ms2) { ok = false; break; }
    }
    if (ok) seeds.push(x, y, z);
    if (seeds.length >= n * 3) break;
  }
  if (!seeds.length) seeds.push(candidates[0]!, candidates[1]!, candidates[2]!);
  return seeds;
}

/**
 * Move the selected material of `parent` into Voronoi pieces around `seeds` (xyz triples, local).
 * Parent samples are cleared (cells) or carved (regions). Returns the pieces, empty ones dropped.
 */
export function splitSelection(parent: VoxelGrid, sel: Selection, seeds: number[], gap: number, warp: number, seedOffset: number): Piece[] {
  const h = parent.h;
  const ns = seeds.length / 3;
  const grids: VoxelGrid[] = [];
  for (let q = 0; q < ns; q++) grids.push(new VoxelGrid(parent.layout()));
  const i0 = Math.max(0, sel.box[0]), j0 = Math.max(0, sel.box[1]), k0 = Math.max(0, sel.box[2]);
  const i1 = Math.min(parent.nx - 1, sel.box[3]), j1 = Math.min(parent.ny - 1, sel.box[4]), k1 = Math.min(parent.nz - 1, sel.box[5]);
  // Warp feature size grows with its amplitude (≈ 3× the displacement), so a strongly warped cut
  // meanders instead of zig-zagging: a fixed 0.18 m-scale sine warp of ±0.36 m (a released roof,
  // warp = 0.25·cell) drew regular saw teeth along every slab edge.
  const fw = 1 / Math.max(0.18, 3 * warp);
  const fg = 1 / (1.8 * h);
  const so = seedOffset * 13.1;
  const cm = sel.cells ?? null;
  const bounds = new Int32Array(ns * 6);
  for (let q = 0; q < ns; q++) bounds.set([Infinity, Infinity, Infinity, -1, -1, -1].map((v) => (v === Infinity ? 0x7fffffff : v)), q * 6);
  const sx = new Float64Array(ns), sy = new Float64Array(ns), sz = new Float64Array(ns);
  for (let q = 0; q < ns; q++) { sx[q] = seeds[q * 3]!; sy[q] = seeds[q * 3 + 1]!; sz[q] = seeds[q * 3 + 2]!; }
  const candReady = new Uint8Array(64), candN = new Int32Array(64), cand = new Int32Array(64 * ns), candDist = new Float64Array(ns);
  // The warp is low-frequency (features ≥ 0.18 m ≈ 7 samples): evaluate it on the 5³ corners of
  // the chunk's 4-sample blocks and interpolate trilinearly (~30× fewer noise evaluations; the
  // warp field was ~40 % of the time to split a whole wall).
  const WL = 5, warpX = new Float64Array(WL * WL * WL), warpY = new Float64Array(WL * WL * WL), warpZ = new Float64Array(WL * WL * WL);
  let warpChunk = -1;
  const warpLattice = (A: number, B: number, C: number) => {
    for (let c = 0; c < WL; c++)
      for (let b = 0; b < WL; b++)
        for (let a = 0; a < WL; a++) {
          const x = parent.ox + (A * CHUNK + 4 * a) * h, y = parent.oy + (B * CHUNK + 4 * b) * h, z = parent.oz + (C * CHUNK + 4 * c) * h;
          const u = x * fw + so, w = y * fw, e = z * fw - so;
          const q = a + WL * (b + WL * c);
          warpX[q] = 1.4 * warp * noise.noise3(u, w, e);
          warpY[q] = 1.4 * warp * noise.noise3(w + 31.7, e - 11.3, u + 5.1);
          warpZ[q] = 1.4 * warp * noise.noise3(e - 7.9, u + 19.3, w - 23.1);
        }
  };
  const lerp3 = (f: Float64Array, q: number, tx: number, ty: number, tz: number) => {
    const a0 = f[q]! + (f[q + 1]! - f[q]!) * tx, a1 = f[q + WL]! + (f[q + WL + 1]! - f[q + WL]!) * tx;
    const q2 = q + WL * WL;
    const b0 = f[q2]! + (f[q2 + 1]! - f[q2]!) * tx, b1 = f[q2 + WL]! + (f[q2 + WL + 1]! - f[q2 + WL]!) * tx;
    const c0 = a0 + (a1 - a0) * ty, c1 = b0 + (b1 - b0) * ty;
    return c0 + (c1 - c0) * tz;
  };
  // Walk the parent chunk by chunk; piece grids share the layout, so chunk/local indices match.
  for (let C = k0 >> CHUNK_SHIFT; C <= k1 >> CHUNK_SHIFT; C++)
    for (let B = j0 >> CHUNK_SHIFT; B <= j1 >> CHUNK_SHIFT; B++)
      for (let A = i0 >> CHUNK_SHIFT; A <= i1 >> CHUNK_SHIFT; A++) {
        const ci = parent.chunkIndex(A, B, C);
        if (parent.state[ci] === EMPTY) continue;
        parent.ensureMixed(ci);
        candReady.fill(0);
        const PD = parent.dens[ci]!, PM = parent.dmg[ci]!, PS = parent.soot[ci]!;
        const ka = Math.max(k0, C * CHUNK), kb = Math.min(k1, C * CHUNK + CHUNK - 1);
        const ja = Math.max(j0, B * CHUNK), jb = Math.min(j1, B * CHUNK + CHUNK - 1);
        const ia = Math.max(i0, A * CHUNK), ib = Math.min(i1, A * CHUNK + CHUNK - 1);
        for (let k = ka; k <= kb; k++) {
          const z = parent.oz + k * h;
          for (let j = ja; j <= jb; j++) {
            const y = parent.oy + j * h;
            const row = ((j & CHUNK_MASK) << 4) | ((k & CHUNK_MASK) << 8);
            for (let i = ia; i <= ib; i++) {
              const li = (i & CHUNK_MASK) | row;
              const d = PD[li]!;
              if (d === 0) continue;
              const x = parent.ox + i * h;
              let t = 1;
              let take = d;
              if (cm) {
                if (!cm.mask[((i / cm.F) | 0) + cm.nx * (((j / cm.F) | 0) + cm.ny * ((k / cm.F) | 0))]) continue;
              } else {
                t = sel.test(i, j, k, x, y, z);
                if (sel.sdf) {
                  if (t > h) continue;
                  take = Math.min(d, densityFromSdf(t, h));
                } else if (t <= 0) continue;
              }
              // Candidate seeds of this 4³-sample block (only those that can be nearest or
              // second-nearest anywhere in it, with margin for the warp).
              const blk = ((i & CHUNK_MASK) >> 2) | (((j & CHUNK_MASK) >> 2) << 2) | (((k & CHUNK_MASK) >> 2) << 4);
              const cOff = blk * ns;
              if (!candReady[blk]) {
                candReady[blk] = 1;
                const bx = parent.ox + ((i & ~3) + 1.5) * h, by = parent.oy + ((j & ~3) + 1.5) * h, bz = parent.oz + ((k & ~3) + 1.5) * h;
                let d1 = Infinity, d2 = Infinity;
                for (let q = 0; q < ns; q++) {
                  const dd = Math.hypot(bx - sx[q]!, by - sy[q]!, bz - sz[q]!);
                  candDist[q] = dd;
                  if (dd < d1) { d2 = d1; d1 = dd; } else if (dd < d2) d2 = dd;
                }
                const reach = d2 + 2 * (2.6 * h + warp);
                let m = 0;
                for (let q = 0; q < ns; q++) if (candDist[q]! <= reach) cand[cOff + m++] = q;
                candN[blk] = m;
              }
              const nc = candN[blk]!;
              // Nearest and second-nearest seed; bend the bisectors with a domain warp near them.
              let px = x, py = y, pz = z;
              let a = 0, b = -1, da = Infinity, db = Infinity;
              for (let pass = 0; pass < 2; pass++) {
                a = cand[cOff]!; b = -1; da = Infinity; db = Infinity;
                for (let c = 0; c < nc; c++) {
                  const q = cand[cOff + c]!;
                  const dx = px - sx[q]!, dy = py - sy[q]!, dz = pz - sz[q]!;
                  const dd = dx * dx + dy * dy + dz * dz;
                  if (dd < da) { db = da; b = a; da = dd; a = q; } else if (dd < db) { db = dd; b = q; }
                }
                if (db === Infinity) b = -1;
                if (pass === 1 || ns < 2 || Math.sqrt(db) - Math.sqrt(da) > 2 * warp + 2 * h) break;
                // Low-frequency, aperiodic warp of the cell boundaries (gradient noise, sampled on
                // the block lattice of this chunk).
                if (warpChunk !== ci) {
                  warpLattice(A, B, C);
                  warpChunk = ci;
                }
                const li4 = i & CHUNK_MASK, lj4 = j & CHUNK_MASK, lk4 = k & CHUNK_MASK;
                const q = (li4 >> 2) + WL * ((lj4 >> 2) + WL * (lk4 >> 2));
                const tx = (li4 & 3) / 4, ty = (lj4 & 3) / 4, tz = (lk4 & 3) / 4;
                px = x + lerp3(warpX, q, tx, ty, tz);
                py = y + lerp3(warpY, q, tx, ty, tz);
                pz = z + lerp3(warpZ, q, tx, ty, tz);
              }
              let v = take;
              let nearCut = false;
              if (b >= 0) {
                // Distance to the bisector plane of seeds a, b: (db − da) / (2 |sa − sb|).
                const ex = sx[a]! - sx[b]!, ey = sy[a]! - sy[b]!, ez = sz[a]! - sz[b]!;
                let m = (db - da) / (2 * Math.sqrt(ex * ex + ey * ey + ez * ez) + 1e-9);
                nearCut = m < 2.5 * h;
                // Chipped, stepped fracture faces: voxel-scale roughness on the cut.
                if (nearCut) m += 0.6 * h * noise.noise3(x * fg + so, y * fg - so, z * fg + 1.7);
                v = Math.min(v, densityFromSdf(gap / 2 - m, h));
              }
              const dmg = PM[li]!, soot = PS[li]!;
              // Clear (or carve) the parent sample.
              parent.writeDensity(ci, li, j, sel.sdf ? Math.min(d, carveDensity(t, h)) : 0);
              if (v === 0) continue;
              const g = grids[a]!;
              if (g.state[ci] !== MIXED) g.ensureMixed(ci);
              g.writeDensity(ci, li, j, v);
              g.dmg[ci]![li] = nearCut ? Math.max(dmg, FRACTURE_DAMAGE) : dmg;
              g.soot[ci]![li] = soot;
              const bo = a * 6;
              if (i < bounds[bo]!) bounds[bo] = i;
              if (j < bounds[bo + 1]!) bounds[bo + 1] = j;
              if (k < bounds[bo + 2]!) bounds[bo + 2] = k;
              if (i > bounds[bo + 3]!) bounds[bo + 3] = i;
              if (j > bounds[bo + 4]!) bounds[bo + 4] = j;
              if (k > bounds[bo + 5]!) bounds[bo + 5] = k;
            }
          }
        }
      }
  parent.markDirty(i0, j0, k0, i1, j1, k1);
  const out: Piece[] = [];
  for (let q = 0; q < ns; q++) {
    const g = grids[q]!;
    if (g.totalSolid === 0) continue;
    const bo = q * 6;
    // Samples just outside the written bounds are air in the piece; one ring keeps the ramp.
    const box: [number, number, number, number, number, number] = [
      Math.max(0, bounds[bo]! - 1), Math.max(0, bounds[bo + 1]! - 1), Math.max(0, bounds[bo + 2]! - 1),
      Math.min(g.nx - 1, bounds[bo + 3]! + 1), Math.min(g.ny - 1, bounds[bo + 4]! + 1), Math.min(g.nz - 1, bounds[bo + 5]! + 1),
    ];
    const cropped = cropGrid(g, box, 2);
    out.push({ grid: cropped, volume: cropped.solidVolume(), seed: [sx[q]!, sy[q]!, sz[q]!], seedIndex: q, seeds, bounds: cropped.solidSampleBounds() });
  }
  for (let c = 0; c < parent.chunkCount; c++) if (parent.state[c] === MIXED && parent.solid[c] === 0) parent.compact(c);
  return out;
}

/**
 * Signed distance (m) from local point p into seed `own`'s *planar* Voronoi cell (positive
 * inside): the smallest distance to a bisector plane with any other seed. The cells are convex, so
 * collision hulls built only from points inside their own cell cannot overlap, however far the
 * warped (rendered) cuts wander across the planes.
 */
export function planarCellDepth(seeds: ArrayLike<number>, own: number, x: number, y: number, z: number): number {
  const ox = seeds[own * 3]!, oy = seeds[own * 3 + 1]!, oz = seeds[own * 3 + 2]!;
  const d0 = (x - ox) ** 2 + (y - oy) ** 2 + (z - oz) ** 2;
  let best = Infinity;
  for (let q = 0; q < seeds.length / 3; q++) {
    if (q === own) continue;
    const sx = seeds[q * 3]!, sy = seeds[q * 3 + 1]!, sz = seeds[q * 3 + 2]!;
    const sep = Math.sqrt((sx - ox) ** 2 + (sy - oy) ** 2 + (sz - oz) ** 2);
    if (sep < 1e-9) continue;
    const d = ((x - sx) ** 2 + (y - sy) ** 2 + (z - sz) ** 2 - d0) / (2 * sep);
    if (d < best) best = d;
  }
  return best;
}

/** Characteristic size of a piece (cube root of volume), m. */
export function pieceSize(p: Piece): number {
  return Math.cbrt(p.volume);
}

/** True if (i,j,k) has solid density (for selection tests). */
export function solidAt(g: VoxelGrid, i: number, j: number, k: number): boolean {
  return g.density(i, j, k) >= ISO;
}
