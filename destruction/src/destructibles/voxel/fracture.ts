import { Noise3 } from '../../core/noise.ts';
import type { Rng } from '../../core/rng.ts';
import { CHUNK, CHUNK_MASK, CHUNK_SHIFT, CHUNK_VOL, EMPTY, ISO, MIXED, VoxelGrid, carveDensity, densityFromSdf } from './grid.ts';

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
 * Output of an incremental split (splitSteps). With `deferClear` the parent grid is left intact:
 * every sample moved to (or cut away between) the pieces is labelled with its seed instead
 * (label = seed index + 1), and the parent loses a piece's material only when that piece is
 * committed (clearPieceLabels), so the uncut remainder keeps rendering and colliding in place
 * while the pieces are built over several steps.
 */
export interface SplitOutput {
  pieces: Piece[];
  /** Per parent chunk: seed label per sample, or null (deferred clear only) */
  labels: (Uint8Array | null)[] | null;
  /** Per seed: labelled sample box [i0,j0,k0,i1,j1,k1] (deferred clear only) */
  labelBox: Int32Array | null;
  /** Solid parent samples labelled (deferred clear only): all of them = the whole element goes */
  labelledSolid?: number;
}

/**
 * Move the selected material of `parent` into Voronoi pieces around `seeds` (xyz triples, local).
 * Parent samples are cleared (cells) or carved (regions). Returns the pieces, empty ones dropped.
 */
export function splitSelection(parent: VoxelGrid, sel: Selection, seeds: number[], gap: number, warp: number, seedOffset: number): Piece[] {
  const out: SplitOutput = { pieces: [], labels: null, labelBox: null };
  const it = splitSteps(parent, sel, seeds, gap, warp, seedOffset, out, false);
  while (!it.next().done);
  return out.pieces;
}

/** Blocks examined / taken whole by splits (reports). */
export const splitCounters = { blocks: 0, sole: 0 };

/**
 * Work units (jobs.ts: 1 unit ≈ 50 ns on a desktop) of a sample copied whole with its block, of a
 * sample through the per-sample Voronoi/warp test (measured ≈ 8× dearer), and of a chunk's setup.
 */
const SLOW_SAMPLE_UNITS = 8;
const CHUNK_UNITS = 512;

/**
 * splitSelection as a generator: yields the work done (≈ samples visited) after every chunk and
 * every piece built, so a large split can be spread over steps (see jobs.ts). `out.pieces` is
 * filled when it finishes. With `deferClear` (cell selections only) the parent is not written:
 * see SplitOutput.
 */
export function* splitSteps(parent: VoxelGrid, sel: Selection, seeds: number[], gap: number, warp: number, seedOffset: number, out: SplitOutput, deferClear: boolean): Generator<number, void, void> {
  const h = parent.h;
  const ns = seeds.length / 3;
  const cm = sel.cells ?? null;
  const defer = deferClear && !!cm && ns < 255;
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
  const bounds = new Int32Array(ns * 6);
  for (let q = 0; q < ns; q++) bounds.set([0x7fffffff, 0x7fffffff, 0x7fffffff, -1, -1, -1], q * 6);
  const labels: (Uint8Array | null)[] | null = defer ? new Array(parent.chunkCount).fill(null) : null;
  const labelBox = defer ? new Int32Array(ns * 6) : null;
  if (labelBox) for (let q = 0; q < ns; q++) labelBox.set([0x7fffffff, 0x7fffffff, 0x7fffffff, -1, -1, -1], q * 6);
  out.labels = labels;
  out.labelBox = labelBox;
  out.labelledSolid = 0;
  let labelledSolid = 0;
  const sx = new Float64Array(ns), sy = new Float64Array(ns), sz = new Float64Array(ns);
  for (let q = 0; q < ns; q++) { sx[q] = seeds[q * 3]!; sy[q] = seeds[q * 3 + 1]!; sz[q] = seeds[q * 3 + 2]!; }
  const cand = new Int32Array(64 * ns), candDist = new Float64Array(ns);
  // Seed that owns a whole 4³ block outright (−1: per-sample test). A sample's point, warped or
  // not, lies in the convex hull of the block's 8 lattice corners, plain or warped (the warp is
  // trilinear over the block, so p + w(p) is a trilinear map of the corners). The distance to the
  // bisector plane of seeds a, b is linear in the point, so when it is ≥ 2.5 h at all 16 corners
  // for every other candidate b, every sample of the block goes to a whole: uncut, unwarped, not
  // on a fracture face (m ≥ 2.5 h also clears the gap ramp, gap/2 + h). Exactly what the
  // per-sample path gives there, at a small fraction of the cost.
  const hullX = new Float64Array(16), hullY = new Float64Array(16), hullZ = new Float64Array(16);
  const soleM = 2.5 * h + 1e-9;
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
  const F = cm ? cm.F : 1;
  // Walk the parent chunk by chunk; piece grids share the layout, so chunk/local indices match.
  for (let C = k0 >> CHUNK_SHIFT; C <= k1 >> CHUNK_SHIFT; C++)
    for (let B = j0 >> CHUNK_SHIFT; B <= j1 >> CHUNK_SHIFT; B++)
      for (let A = i0 >> CHUNK_SHIFT; A <= i1 >> CHUNK_SHIFT; A++) {
        const ci = parent.chunkIndex(A, B, C);
        const pst = parent.state[ci]!;
        if (pst === EMPTY) continue;
        const ka = Math.max(k0, C * CHUNK), kb = Math.min(k1, C * CHUNK + CHUNK - 1);
        const ja = Math.max(j0, B * CHUNK), jb = Math.min(j1, B * CHUNK + CHUNK - 1);
        const ia = Math.max(i0, A * CHUNK), ib = Math.min(i1, A * CHUNK + CHUNK - 1);
        // Coarse cells of the chunk: none selected → skip it; all selected → no per-sample test.
        let allIn = !cm;
        if (cm) {
          const I0 = (ia / F) | 0, I1 = (ib / F) | 0, J0 = (ja / F) | 0, J1 = (jb / F) | 0, K0 = (ka / F) | 0, K1 = (kb / F) | 0;
          let any = false;
          allIn = true;
          for (let K = K0; K <= K1; K++)
            for (let J = J0; J <= J1; J++) {
              const row = cm.nx * (J + cm.ny * K);
              for (let I = I0; I <= I1; I++) {
                if (cm.mask[I + row]) any = true;
                else allIn = false;
              }
            }
          if (!any) continue;
        }
        const PD = pst === MIXED ? parent.dens[ci]! : null, PM = parent.dmg[ci], PS = parent.soot[ci];
        if (!defer) parent.ensureMixed(ci);
        const WD = defer ? null : parent.dens[ci]!;
        let LB: Uint8Array | null = null;
        let visited = 0;
        // Block by block (4³ samples): the owner test is made once per block, and blocks one seed
        // owns outright are copied in a tight loop.
        const bkA = (ka & CHUNK_MASK) >> 2, bkB = (kb & CHUNK_MASK) >> 2;
        const bjA = (ja & CHUNK_MASK) >> 2, bjB = (jb & CHUNK_MASK) >> 2;
        const biA = (ia & CHUNK_MASK) >> 2, biB = (ib & CHUNK_MASK) >> 2;
        for (let bk = bkA; bk <= bkB; bk++)
          for (let bj = bjA; bj <= bjB; bj++)
            for (let bi = biA; bi <= biB; bi++) {
              const qi0 = Math.max(ia, A * CHUNK + bi * 4), qi1 = Math.min(ib, A * CHUNK + bi * 4 + 3);
              const qj0 = Math.max(ja, B * CHUNK + bj * 4), qj1 = Math.min(jb, B * CHUNK + bj * 4 + 3);
              const qk0 = Math.max(ka, C * CHUNK + bk * 4), qk1 = Math.min(kb, C * CHUNK + bk * 4 + 3);
              if (PD) {
                let any = false;
                for (let k = qk0; k <= qk1 && !any; k++)
                  for (let j = qj0; j <= qj1 && !any; j++) {
                    const row = ((j & CHUNK_MASK) << 4) | ((k & CHUNK_MASK) << 8);
                    for (let i = qi0; i <= qi1; i++) if (PD[(i & CHUNK_MASK) | row]) { any = true; break; }
                  }
                if (!any) continue;
              }
              // Candidate seeds of this block (only those that can be nearest or second-nearest
              // anywhere in it, with margin for the warp) and its sole owner, if any.
              const blk = bi | (bj << 2) | (bk << 4);
              const cOff = blk * ns;
              const bx = parent.ox + ((qi0 & ~3) + 1.5) * h, by = parent.oy + ((qj0 & ~3) + 1.5) * h, bz = parent.oz + ((qk0 & ~3) + 1.5) * h;
              let d1 = Infinity, d2 = Infinity, q1 = 0;
              for (let q = 0; q < ns; q++) {
                const ex = bx - sx[q]!, ey = by - sy[q]!, ez = bz - sz[q]!;
                const dd = Math.sqrt(ex * ex + ey * ey + ez * ez);
                candDist[q] = dd;
                if (dd < d1) { d2 = d1; d1 = dd; q1 = q; } else if (dd < d2) d2 = dd;
              }
              const reach = d2 + 2 * (2.6 * h + warp);
              let nc = 0;
              for (let q = 0; q < ns; q++) if (candDist[q]! <= reach) cand[cOff + nc++] = q;
              let sole = q1;
              if (ns > 1) {
                if (warpChunk !== ci) {
                  warpLattice(A, B, C);
                  warpChunk = ci;
                }
                for (let v = 0; v < 8; v++) {
                  const ox = v & 1, oy = (v >> 1) & 1, oz = v >> 2;
                  const q = bi + ox + WL * (bj + oy + WL * (bk + oz));
                  const cx = parent.ox + ((qi0 & ~3) + 4 * ox) * h, cy = parent.oy + ((qj0 & ~3) + 4 * oy) * h, cz = parent.oz + ((qk0 & ~3) + 4 * oz) * h;
                  hullX[v] = cx; hullY[v] = cy; hullZ[v] = cz;
                  hullX[v + 8] = cx + warpX[q]!; hullY[v + 8] = cy + warpY[q]!; hullZ[v + 8] = cz + warpZ[q]!;
                }
                const ax = sx[q1]!, ay = sy[q1]!, az = sz[q1]!;
                for (let c = 0; c < nc && sole >= 0; c++) {
                  const q = cand[cOff + c]!;
                  if (q === q1) continue;
                  const ex = ax - sx[q]!, ey = ay - sy[q]!, ez = az - sz[q]!;
                  const inv = 1 / (Math.sqrt(ex * ex + ey * ey + ez * ez) + 1e-12);
                  const mx = 0.5 * (ax + sx[q]!), my = 0.5 * (ay + sy[q]!), mz = 0.5 * (az + sz[q]!);
                  for (let v = 0; v < 16; v++) {
                    if (((hullX[v]! - mx) * ex + (hullY[v]! - my) * ey + (hullZ[v]! - mz) * ez) * inv < soleM) { sole = -1; break; }
                  }
                }
              }
              splitCounters.blocks++;
              if (sole >= 0 && cm) {
                // Whole block to one piece: plain copy (density, damage, soot), counted per row.
                splitCounters.sole++;
                const g = grids[sole]!;
                if (g.state[ci] !== MIXED) g.ensureMixed(ci);
                const GD = g.dens[ci]!, GM = g.dmg[ci]!, GS = g.soot[ci]!;
                let taken = 0;
                if (defer) LB ??= labels![ci] ??= new Uint8Array(CHUNK_VOL);
                for (let k = qk0; k <= qk1; k++) {
                  const Kc = cm.ny * ((k / F) | 0);
                  for (let j = qj0; j <= qj1; j++) {
                    const row = ((j & CHUNK_MASK) << 4) | ((k & CHUNK_MASK) << 8);
                    const cRow = cm.nx * (((j / F) | 0) + Kc);
                    let solidRow = 0;
                    for (let i = qi0; i <= qi1; i++) {
                      const li = (i & CHUNK_MASK) | row;
                      const d = PD ? PD[li]! : 255;
                      if (d === 0) continue;
                      if (!allIn && !cm.mask[((i / F) | 0) + cRow]) continue;
                      GD[li] = d;
                      if (PM) GM[li] = PM[li]!;
                      if (PS) GS[li] = PS[li]!;
                      if (d >= ISO) solidRow++;
                      if (WD) parent.writeDensity(ci, li, j, 0);
                      else {
                        LB![li] = sole + 1;
                        if (d >= ISO) labelledSolid++;
                      }
                      taken++;
                    }
                    if (solidRow) {
                      g.solid[ci]! += solidRow;
                      g.rowSolid[j]! += solidRow;
                      g.totalSolid += solidRow;
                    }
                  }
                }
                if (!taken) continue;
                visited += taken;
                g.version++;
                const bo = sole * 6;
                if (qi0 < bounds[bo]!) bounds[bo] = qi0;
                if (qj0 < bounds[bo + 1]!) bounds[bo + 1] = qj0;
                if (qk0 < bounds[bo + 2]!) bounds[bo + 2] = qk0;
                if (qi1 > bounds[bo + 3]!) bounds[bo + 3] = qi1;
                if (qj1 > bounds[bo + 4]!) bounds[bo + 4] = qj1;
                if (qk1 > bounds[bo + 5]!) bounds[bo + 5] = qk1;
                if (labelBox) {
                  if (qi0 < labelBox[bo]!) labelBox[bo] = qi0;
                  if (qj0 < labelBox[bo + 1]!) labelBox[bo + 1] = qj0;
                  if (qk0 < labelBox[bo + 2]!) labelBox[bo + 2] = qk0;
                  if (qi1 > labelBox[bo + 3]!) labelBox[bo + 3] = qi1;
                  if (qj1 > labelBox[bo + 4]!) labelBox[bo + 4] = qj1;
                  if (qk1 > labelBox[bo + 5]!) labelBox[bo + 5] = qk1;
                }
                continue;
              }
              for (let k = qk0; k <= qk1; k++) {
                const z = parent.oz + k * h;
                const Kc = cm ? cm.ny * ((k / F) | 0) : 0;
                for (let j = qj0; j <= qj1; j++) {
                  const y = parent.oy + j * h;
                  const row = ((j & CHUNK_MASK) << 4) | ((k & CHUNK_MASK) << 8);
                  const cRow = cm ? cm.nx * (((j / F) | 0) + Kc) : 0;
                  for (let i = qi0; i <= qi1; i++) {
                    const li = (i & CHUNK_MASK) | row;
                    const d = PD ? PD[li]! : 255;
                    if (d === 0) continue;
                    const x = parent.ox + i * h;
                    let t = 1;
                    let take = d;
                    if (cm) {
                      if (!allIn && !cm.mask[((i / F) | 0) + cRow]) continue;
                    } else {
                      t = sel.test(i, j, k, x, y, z);
                      if (sel.sdf) {
                        if (t > h) continue;
                        take = Math.min(d, densityFromSdf(t, h));
                      } else if (t <= 0) continue;
                    }
                    visited += SLOW_SAMPLE_UNITS;
                    let a = sole, b = -1;
                    // Distance to the bisector plane of the nearest two seeds (valid when b ≥ 0).
                    let m = 0;
                    if (a < 0) {
                      // Nearest and second-nearest seed; bend the bisectors with a domain warp
                      // near them.
                      let px = x, py = y, pz = z;
                      let da = Infinity, db = Infinity;
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
                        // Low-frequency, aperiodic warp of the cell boundaries (gradient noise,
                        // sampled on the block lattice of this chunk).
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
                      if (b >= 0) {
                        // Distance to the bisector plane of seeds a, b: (db − da) / (2 |sa − sb|).
                        const ex = sx[a]! - sx[b]!, ey = sy[a]! - sy[b]!, ez = sz[a]! - sz[b]!;
                        m = (db - da) / (2 * Math.sqrt(ex * ex + ey * ey + ez * ez) + 1e-9);
                      }
                    }
                    let v = take;
                    let nearCut = false;
                    if (b >= 0) {
                      nearCut = m < 2.5 * h;
                      // Chipped, stepped fracture faces: voxel-scale roughness on the cut.
                      if (nearCut) m += 0.6 * h * noise.noise3(x * fg + so, y * fg - so, z * fg + 1.7);
                      v = Math.min(v, densityFromSdf(gap / 2 - m, h));
                    }
                    const dmg = PM ? PM[li]! : 0, soot = PS ? PS[li]! : 0;
                    // Clear (or carve) the parent sample, or label it for a deferred clear.
                    if (WD) parent.writeDensity(ci, li, j, sel.sdf ? Math.min(d, carveDensity(t, h)) : 0);
                    else {
                      LB ??= labels![ci] ??= new Uint8Array(CHUNK_VOL);
                      LB[li] = a + 1;
                      if (d >= ISO) labelledSolid++;
                      const lo = a * 6;
                      if (i < labelBox![lo]!) labelBox![lo] = i;
                      if (j < labelBox![lo + 1]!) labelBox![lo + 1] = j;
                      if (k < labelBox![lo + 2]!) labelBox![lo + 2] = k;
                      if (i > labelBox![lo + 3]!) labelBox![lo + 3] = i;
                      if (j > labelBox![lo + 4]!) labelBox![lo + 4] = j;
                      if (k > labelBox![lo + 5]!) labelBox![lo + 5] = k;
                    }
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
        out.labelledSolid = labelledSolid;
        yield CHUNK_UNITS + visited;
      }
  if (!defer) parent.markDirty(i0, j0, k0, i1, j1, k1);
  for (let q = 0; q < ns; q++) {
    const g = grids[q]!;
    if (g.totalSolid === 0) continue;
    const bo = q * 6;
    const piece = adoptPiece(g, [bounds[bo]!, bounds[bo + 1]!, bounds[bo + 2]!, bounds[bo + 3]!, bounds[bo + 4]!, bounds[bo + 5]!]);
    out.pieces.push({ grid: piece, volume: piece.solidVolume(), seed: [sx[q]!, sy[q]!, sz[q]!], seedIndex: q, seeds, bounds: piece.solidSampleBounds() });
    yield CHUNK_UNITS * 4;
  }
  if (!defer) for (let c = 0; c < parent.chunkCount; c++) if (parent.state[c] === MIXED && parent.solid[c] === 0) parent.compact(c);
}

/**
 * The piece's own grid: a window of the full-layout split grid, aligned to whole chunks (with at
 * least 3 samples of air around the written bounds) so its chunk arrays are handed over as they
 * are instead of copied sample by sample (the copy was ~15 % of splitting a wall).
 */
function adoptPiece(src: VoxelGrid, b: [number, number, number, number, number, number]): VoxelGrid {
  const PAD = 3;
  const a0 = Math.floor((b[0] - PAD) / CHUNK), c0 = Math.floor((b[1] - PAD) / CHUNK), e0 = Math.floor((b[2] - PAD) / CHUNK);
  const a1 = Math.floor((b[3] + PAD) / CHUNK), c1 = Math.floor((b[4] + PAD) / CHUNK), e1 = Math.floor((b[5] + PAD) / CHUNK);
  const out = new VoxelGrid({
    h: src.h,
    origin: [src.ox + a0 * CHUNK * src.h, src.oy + c0 * CHUNK * src.h, src.oz + e0 * CHUNK * src.h],
    n: [(a1 - a0 + 1) * CHUNK, (c1 - c0 + 1) * CHUNK, (e1 - e0 + 1) * CHUNK],
  });
  for (let C = Math.max(0, e0); C <= Math.min(src.cz - 1, e1); C++)
    for (let B = Math.max(0, c0); B <= Math.min(src.cy - 1, c1); B++)
      for (let A = Math.max(0, a0); A <= Math.min(src.cx - 1, a1); A++) {
        const sci = src.chunkIndex(A, B, C);
        if (src.state[sci] !== MIXED) continue;
        const oci = out.chunkIndex(A - a0, B - c0, C - e0);
        out.state[oci] = MIXED;
        out.dens[oci] = src.dens[sci]!;
        out.dmg[oci] = src.dmg[sci]!;
        out.soot[oci] = src.soot[sci]!;
        src.dens[sci] = src.dmg[sci] = src.soot[sci] = null;
        src.state[sci] = EMPTY;
        out.compact(oci);
      }
  // Solid bookkeeping carries over (the split kept it per chunk and per source row).
  out.recount();
  return out;
}

/**
 * Commit piece `q` of a deferred split: clear the parent samples labelled with it (its material
 * and the cut gap next to it) and mark them for remeshing and collider updates. Returns the
 * samples visited (work units).
 */
export function clearPieceLabels(parent: VoxelGrid, out: SplitOutput, q: number): number {
  const labels = out.labels, lb = out.labelBox;
  if (!labels || !lb) return 0;
  const o = q * 6;
  if (lb[o + 3]! < 0) return 0;
  return clearLabels(parent, labels, q + 1, lb[o]!, lb[o + 1]!, lb[o + 2]!, lb[o + 3]!, lb[o + 4]!, lb[o + 5]!);
}

/** Clear every sample still labelled by a deferred split and drop the labels. */
export function clearAllLabels(parent: VoxelGrid, out: SplitOutput): number {
  const labels = out.labels;
  if (!labels) return 0;
  let n = 0;
  for (let ci = 0; ci < labels.length; ci++) {
    if (!labels[ci]) continue;
    const a = ci % parent.cx, b = Math.floor(ci / parent.cx) % parent.cy, c = Math.floor(ci / (parent.cx * parent.cy));
    n += clearLabels(parent, labels, -1, a * CHUNK, b * CHUNK, c * CHUNK, Math.min(parent.nx - 1, a * CHUNK + CHUNK - 1), Math.min(parent.ny - 1, b * CHUNK + CHUNK - 1), Math.min(parent.nz - 1, c * CHUNK + CHUNK - 1));
    labels[ci] = null;
    if (parent.state[ci] === MIXED && parent.solid[ci] === 0) parent.compact(ci);
  }
  out.labels = null;
  return n;
}

/** Clear parent samples labelled `want` (−1: any label) inside a sample box. */
function clearLabels(parent: VoxelGrid, labels: (Uint8Array | null)[], want: number, i0: number, j0: number, k0: number, i1: number, j1: number, k1: number): number {
  let n = 0, any = false;
  for (let C = k0 >> CHUNK_SHIFT; C <= k1 >> CHUNK_SHIFT; C++)
    for (let B = j0 >> CHUNK_SHIFT; B <= j1 >> CHUNK_SHIFT; B++)
      for (let A = i0 >> CHUNK_SHIFT; A <= i1 >> CHUNK_SHIFT; A++) {
        const ci = parent.chunkIndex(A, B, C);
        const L = labels[ci];
        if (!L || parent.state[ci] === EMPTY) continue;
        const ka = Math.max(k0, C * CHUNK), kb = Math.min(k1, C * CHUNK + CHUNK - 1);
        const ja = Math.max(j0, B * CHUNK), jb = Math.min(j1, B * CHUNK + CHUNK - 1);
        const ia = Math.max(i0, A * CHUNK), ib = Math.min(i1, A * CHUNK + CHUNK - 1);
        for (let k = ka; k <= kb; k++)
          for (let j = ja; j <= jb; j++) {
            const row = ((j & CHUNK_MASK) << 4) | ((k & CHUNK_MASK) << 8);
            for (let i = ia; i <= ib; i++) {
              const li = (i & CHUNK_MASK) | row;
              const l = L[li]!;
              if (l === 0 || (want >= 0 && l !== want)) continue;
              L[li] = 0;
              if (parent.state[ci] !== MIXED) parent.ensureMixed(ci);
              parent.writeDensity(ci, li, j, 0);
              any = true;
            }
          }
        n += (ib - ia + 1) * (jb - ja + 1) * (kb - ka + 1);
      }
  if (any) parent.markDirty(i0, j0, k0, i1, j1, k1);
  return n;
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
