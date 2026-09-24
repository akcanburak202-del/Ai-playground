import { ISO, type VoxelGrid } from './grid.ts';
import type { RebarSet } from './rebar.ts';

/**
 * Ray queries against the density field in element-local space.
 *
 * `traceRay` walks the cells the ray crosses (Amanatides & Woo 1987, "A fast voxel traversal
 * algorithm"), finds the first crossing of the trilinear density through the iso value by
 * sub-stepping and bisection, and also tests the rebar segments registered in the chunks it passes.
 * `probeRun` then marches on from the entry point collecting the contiguous solid run, split into
 * concrete / steel / concrete segments, with the damage-reduced strength of each.
 */
export interface TraceHit {
  /** Distance along the ray, m */
  t: number;
  /** Local hit point */
  x: number;
  y: number;
  z: number;
  /** Local outward normal */
  nx: number;
  ny: number;
  nz: number;
  /** Rebar segment index when a bar was hit first, else −1 */
  bar: number;
}

export interface RunSegment {
  steel: boolean;
  /** Distance from the entry point, m */
  start: number;
  end: number;
  /** Mean damage-reduced strength factor (1 − 0.8·D) or remaining bar area */
  strength: number;
  /** Bar segment index for steel segments */
  bar: number;
}

const iv = new Float64Array(2);
const segList: number[] = [];
const _clip = new Float64Array(2);
const _n3 = { x: 0, y: 0, z: 0 };

/** Narrow [_clip[0], _clip[1]] to where the ray is between lo and hi on one axis. */
function clipAxis(o: number, d: number, lo: number, hi: number): boolean {
  if (Math.abs(d) < 1e-12) return o >= lo && o <= hi;
  let t0 = (lo - o) / d, t1 = (hi - o) / d;
  if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
  if (t0 > _clip[0]!) _clip[0] = t0;
  if (t1 < _clip[1]!) _clip[1] = t1;
  return _clip[1]! >= _clip[0]!;
}

/** Sample-space AABB [i0,j0,k0,i1,j1,k1] of material the tracer should consider (tight bounds). */
export type SampleBox = [number, number, number, number, number, number];

export function traceRay(
  g: VoxelGrid, box: SampleBox, rebar: RebarSet | null,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, out: TraceHit,
): boolean {
  const h = g.h;
  // Clip against the material box, expanded by one cell (surfaces lie between samples).
  const bx0 = g.ox + (box[0] - 1) * h, by0 = g.oy + (box[1] - 1) * h, bz0 = g.oz + (box[2] - 1) * h;
  const bx1 = g.ox + (box[3] + 1) * h, by1 = g.oy + (box[4] + 1) * h, bz1 = g.oz + (box[5] + 1) * h;
  // Slab clip, one axis at a time (no temporaries: this runs for every projectile sweep).
  _clip[0] = 0;
  _clip[1] = maxDist;
  if (!clipAxis(ox, dx, bx0, bx1) || !clipAxis(oy, dy, by0, by1) || !clipAxis(oz, dz, bz0, bz1)) return false;
  const tmin = _clip[0]!, tmax = _clip[1]!;
  // DDA in sample space: cell (i,j,k) spans samples [i, i+1] on each axis.
  const gx0 = (ox - g.ox) / h, gy0 = (oy - g.oy) / h, gz0 = (oz - g.oz) / h;
  const tStart = tmin + 1e-7;
  let i = Math.floor(gx0 + (dx * tStart) / h), j = Math.floor(gy0 + (dy * tStart) / h), k = Math.floor(gz0 + (dz * tStart) / h);
  const si = dx > 0 ? 1 : -1, sj = dy > 0 ? 1 : -1, sk = dz > 0 ? 1 : -1;
  const tdx = Math.abs(dx) > 1e-12 ? h / Math.abs(dx) : Infinity;
  const tdy = Math.abs(dy) > 1e-12 ? h / Math.abs(dy) : Infinity;
  const tdz = Math.abs(dz) > 1e-12 ? h / Math.abs(dz) : Infinity;
  const nextBoundary = (g0: number, d: number, c: number) => (d > 0 ? ((c + 1 - g0) * h) / d : d < 0 ? ((c - g0) * h) / d : Infinity);
  let tx = nextBoundary(gx0, dx, i), ty = nextBoundary(gy0, dy, j), tz = nextBoundary(gz0, dz, k);
  let tEnter = tmin;
  let barT = Infinity, barSeg = -1;
  let lastChunk = -1;
  const stamp = rebar ? rebar.nextStamp() : 0;
  let hitT = -1;
  for (let guard = 0; guard < 100000; guard++) {
    const tExit = Math.min(tx, ty, tz, tmax);
    // Rebar in this cell's chunk (each segment tested once per query).
    if (rebar && i >= 0 && j >= 0 && k >= 0) {
      const ci = (i >> 4) + g.cx * ((j >> 4) + g.cy * (k >> 4));
      if (ci !== lastChunk) {
        lastChunk = ci;
        const list = rebar.chunkSegs.get(ci);
        if (list) {
          for (const s of list) {
            if (rebar.segGone[s] || rebar.seen(s, stamp)) continue;
            if (rebar.segCut[s] && rebar.segArea[s]! < 0.05) continue;
            if (rebar.rayInterval(s, ox, oy, oz, dx, dy, dz, iv) && iv[1]! >= tmin && iv[0]! < barT) {
              const t = Math.max(iv[0]!, tmin);
              if (t < barT) { barT = t; barSeg = s; }
            }
          }
        }
      }
    }
    if (barT <= tEnter) break;
    const d000 = g.density(i, j, k), d100 = g.density(i + 1, j, k), d010 = g.density(i, j + 1, k), d110 = g.density(i + 1, j + 1, k);
    const d001 = g.density(i, j, k + 1), d101 = g.density(i + 1, j, k + 1), d011 = g.density(i, j + 1, k + 1), d111 = g.density(i + 1, j + 1, k + 1);
    const mx = Math.max(d000, d100, d010, d110, d001, d101, d011, d111);
    if (mx >= ISO) {
      const f = (t: number) => {
        const u = gx0 + (dx * t) / h - i, v = gy0 + (dy * t) / h - j, w = gz0 + (dz * t) / h - k;
        const x00 = d000 + (d100 - d000) * u, x10 = d010 + (d110 - d010) * u;
        const x01 = d001 + (d101 - d001) * u, x11 = d011 + (d111 - d011) * u;
        const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
        return y0 + (y1 - y0) * w - ISO;
      };
      let a = tEnter, fa = f(a);
      if (fa >= 0) {
        hitT = a;
      } else {
        const steps = 4;
        for (let s = 1; s <= steps; s++) {
          const b = tEnter + ((tExit - tEnter) * s) / steps;
          const fb = f(b);
          if (fb >= 0) {
            let lo = a, hi = b;
            for (let it = 0; it < 8; it++) {
              const m = 0.5 * (lo + hi);
              if (f(m) >= 0) hi = m; else lo = m;
            }
            hitT = hi;
            break;
          }
          a = b;
          fa = fb;
        }
      }
      if (hitT >= 0) break;
    }
    if (tExit >= tmax) break;
    tEnter = tExit;
    if (tx <= ty && tx <= tz) { i += si; tx += tdx; } else if (ty <= tz) { j += sj; ty += tdy; } else { k += sk; tz += tdz; }
  }
  if (barSeg >= 0 && (hitT < 0 || barT < hitT) && barT <= maxDist) {
    out.t = barT;
    out.x = ox + dx * barT; out.y = oy + dy * barT; out.z = oz + dz * barT;
    // Normal of the bar surface: away from the bar axis.
    const n = rebar!.nodes, sa = rebar!.segA[barSeg]! * 3, sb = rebar!.segB[barSeg]! * 3;
    const ax = n[sa]!, ay = n[sa + 1]!, az = n[sa + 2]!;
    const ex = n[sb]! - ax, ey = n[sb + 1]! - ay, ez = n[sb + 2]! - az;
    const L2 = ex * ex + ey * ey + ez * ez || 1;
    const tt = ((out.x - ax) * ex + (out.y - ay) * ey + (out.z - az) * ez) / L2;
    let nx = out.x - (ax + ex * tt), ny = out.y - (ay + ey * tt), nz = out.z - (az + ez * tt);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    out.nx = nx; out.ny = ny; out.nz = nz;
    out.bar = barSeg;
    return true;
  }
  if (hitT < 0) return false;
  out.t = hitT;
  out.x = ox + dx * hitT; out.y = oy + dy * hitT; out.z = oz + dz * hitT;
  const n3 = _n3;
  g.normalAt(gx0 + (dx * hitT) / h, gy0 + (dy * hitT) / h, gz0 + (dz * hitT) / h, n3);
  // A normal facing along the ray means the gradient is noisy (thin sliver): fall back to −dir.
  if (n3.x * dx + n3.y * dy + n3.z * dz > -0.05) {
    n3.x = -dx; n3.y = -dy; n3.z = -dz;
  }
  out.nx = n3.x; out.ny = n3.y; out.nz = n3.z;
  out.bar = -1;
  return true;
}

/**
 * March from local point p along d collecting the contiguous solid run (concrete and rebar) up to
 * maxDepth. Returns whether the run ended in air (`exits`).
 */
export function probeRun(
  g: VoxelGrid, rebar: RebarSet | null,
  px: number, py: number, pz: number, dx: number, dy: number, dz: number, maxDepth: number, out: RunSegment[],
): boolean {
  const h = g.h;
  // Bar intervals along the probe line.
  const bars: { t0: number; t1: number; s: number }[] = [];
  if (rebar) {
    segList.length = 0;
    const ex = px + dx * maxDepth, ey = py + dy * maxDepth, ez = pz + dz * maxDepth;
    const pad = 0.03;
    rebar.query(g, Math.min(px, ex) - pad, Math.min(py, ey) - pad, Math.min(pz, ez) - pad, Math.max(px, ex) + pad, Math.max(py, ey) + pad, Math.max(pz, ez) + pad, segList);
    for (const s of segList) {
      if (rebar.segCut[s] && rebar.segArea[s]! < 0.05) continue;
      if (rebar.rayInterval(s, px, py, pz, dx, dy, dz, iv) && iv[1]! > 0 && iv[0]! < maxDepth) {
        bars.push({ t0: Math.max(0, iv[0]!), t1: Math.min(maxDepth, iv[1]!), s });
      }
    }
    bars.sort((a, b) => a.t0 - b.t0);
    // Merge overlapping intervals of the same bar (joints between segments).
    for (let q = bars.length - 1; q > 0; q--) {
      if (bars[q]!.t0 <= bars[q - 1]!.t1 + 1e-4) {
        bars[q - 1]!.t1 = Math.max(bars[q - 1]!.t1, bars[q]!.t1);
        bars.splice(q, 1);
      }
    }
  }
  const step = h / 3;
  const gx0 = (px - g.ox) / h, gy0 = (py - g.oy) / h, gz0 = (pz - g.oz) / h;
  let t = 0;
  let cur: RunSegment | null = null;
  let dsum = 0, dn = 0;
  let exits = false;
  let bi = 0;
  const close = (end: number) => {
    if (!cur) return;
    cur.end = end;
    if (!cur.steel) cur.strength = dn > 0 ? Math.max(0.2, 1 - (0.8 * dsum) / dn) : 1;
    if (cur.end > cur.start + 1e-5) out.push(cur);
    cur = null;
    dsum = 0;
    dn = 0;
  };
  while (t < maxDepth) {
    // Inside a bar interval?
    while (bi < bars.length && bars[bi]!.t1 <= t) bi++;
    const bar = bi < bars.length && bars[bi]!.t0 <= t ? bars[bi]! : null;
    if (bar) {
      if (!cur || !cur.steel) {
        close(bar.t0 > 0 ? Math.max(cur ? cur.start : 0, bar.t0) : 0);
        const area = rebar!.segArea[bar.s]!;
        cur = { steel: true, start: Math.max(0, bar.t0), end: bar.t1, strength: Math.max(0.05, area), bar: bar.s };
      }
      t = bar.t1 + 1e-5;
      close(bar.t1);
      continue;
    }
    const gx = gx0 + (dx * t) / h, gy = gy0 + (dy * t) / h, gz = gz0 + (dz * t) / h;
    const dens = g.densityAt(gx, gy, gz);
    // The entry point sits on the iso surface; tolerate half a voxel of "air" right at the start.
    let solid = dens >= ISO || t < 0.5 * h;
    if (!solid) {
      // Bridge cracks and old bullet tunnels: air shorter than ~1.5 voxels with material behind
      // it is part of the same run (a projectile does not see a free surface there).
      const bridge = 1.5 * h;
      for (let a = step; a <= bridge && t + a < maxDepth; a += step) {
        if (g.densityAt(gx0 + (dx * (t + a)) / h, gy0 + (dy * (t + a)) / h, gz0 + (dz * (t + a)) / h) >= ISO) {
          solid = true;
          break;
        }
      }
    }
    if (!solid) {
      exits = true;
      break;
    }
    if (!cur) cur = { steel: false, start: t, end: t, strength: 1, bar: -1 };
    dsum += g.damageAt(gx, gy, gz);
    dn++;
    let nt = t + step;
    if (bi < bars.length && bars[bi]!.t0 < nt) nt = bars[bi]!.t0;
    if (nt <= t) nt = t + 1e-5;
    t = nt;
  }
  if (!exits) close(maxDepth);
  else close(t);
  return exits;
}
