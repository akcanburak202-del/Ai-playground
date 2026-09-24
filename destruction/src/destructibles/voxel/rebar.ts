import type { RebarSpec } from '../../app/contracts.ts';
import { MATERIALS } from '../../physics/materials.ts';
import { CHUNK_SHIFT, type VoxelGrid } from './grid.ts';
import { BoxShape, CylinderShape, type ShapeSdf } from './shape.ts';

/**
 * Reinforcing bars as polylines in element-local space. Bars are chains of nodes (~7.5 cm apart);
 * each segment carries its remaining cross-section fraction (nicks from hits), a cut flag, and is
 * registered in every voxel chunk its capsule overlaps so rays and carving find it quickly.
 * Node positions are mutable: blast impulses bend exposed spans permanently.
 */
export class RebarSet {
  /** Current node positions (xyz) */
  nodes: Float32Array;
  nodeCount: number;
  segA: Int32Array;
  segB: Int32Array;
  /** Nominal bar radius per segment, m */
  segR: Float32Array;
  /** Remaining area fraction 0..1 */
  segArea: Float32Array;
  segCut: Uint8Array;
  /** Segment moved to another element (a falling piece) */
  segGone: Uint8Array;
  segCount: number;
  /** chunk index → segment ids overlapping that chunk */
  chunkSegs = new Map<number, number[]>();
  private stamp: Uint32Array;
  private stampValue = 1;
  /**
   * Bumped whenever geometry, area or visibility changes (instancing refresh, cached mass). Code
   * that edits nodes, segArea, segCut or segGone directly must bump it.
   */
  version = 0;
  private massCache = -1;
  private massVersion = -1;

  constructor(nodes: Float32Array, nodeCount: number, segA: Int32Array, segB: Int32Array, segR: Float32Array, segCount: number) {
    this.nodes = nodes;
    this.nodeCount = nodeCount;
    this.segA = segA;
    this.segB = segB;
    this.segR = segR;
    this.segCount = segCount;
    this.segArea = new Float32Array(segCount).fill(1);
    this.segCut = new Uint8Array(segCount);
    this.segGone = new Uint8Array(segCount);
    this.stamp = new Uint32Array(segCount);
  }

  /** Fresh query stamp (dedupe segments seen through several chunks). */
  nextStamp(): number {
    this.stampValue = (this.stampValue + 1) >>> 0 || 1;
    return this.stampValue;
  }
  seen(s: number, stamp: number): boolean {
    if (this.stamp[s] === stamp) return true;
    this.stamp[s] = stamp;
    return false;
  }

  alive(s: number): boolean {
    return !this.segCut[s] && !this.segGone[s];
  }

  /** Effective radius of segment s (area loss thins it). */
  radius(s: number): number {
    return this.segR[s]! * Math.sqrt(Math.max(0.05, this.segArea[s]!));
  }

  /** (Re)register every live segment into the chunks its capsule touches. */
  register(g: VoxelGrid): void {
    this.chunkSegs.clear();
    for (let s = 0; s < this.segCount; s++) if (!this.segGone[s]) this.registerSeg(g, s);
  }

  registerSeg(g: VoxelGrid, s: number): void {
    const a = this.segA[s]! * 3, b = this.segB[s]! * 3, n = this.nodes;
    const pad = this.segR[s]! + g.h;
    const lo = (v0: number, v1: number) => Math.min(v0, v1) - pad;
    const hi = (v0: number, v1: number) => Math.max(v0, v1) + pad;
    const a0 = clampI(Math.floor(g.gx(lo(n[a]!, n[b]!))) >> CHUNK_SHIFT, g.cx), a1 = clampI(Math.floor(g.gx(hi(n[a]!, n[b]!))) >> CHUNK_SHIFT, g.cx);
    const b0 = clampI(Math.floor(g.gy(lo(n[a + 1]!, n[b + 1]!))) >> CHUNK_SHIFT, g.cy), b1 = clampI(Math.floor(g.gy(hi(n[a + 1]!, n[b + 1]!))) >> CHUNK_SHIFT, g.cy);
    const c0 = clampI(Math.floor(g.gz(lo(n[a + 2]!, n[b + 2]!))) >> CHUNK_SHIFT, g.cz), c1 = clampI(Math.floor(g.gz(hi(n[a + 2]!, n[b + 2]!))) >> CHUNK_SHIFT, g.cz);
    for (let c = c0; c <= c1; c++)
      for (let bb = b0; bb <= b1; bb++)
        for (let aa = a0; aa <= a1; aa++) {
          const ci = aa + g.cx * (bb + g.cy * c);
          let list = this.chunkSegs.get(ci);
          if (!list) this.chunkSegs.set(ci, (list = []));
          list.push(s);
        }
  }

  /** Segments registered in chunks overlapping the local box (deduplicated), appended to out. */
  query(g: VoxelGrid, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: number[]): number[] {
    const a0 = clampI(Math.floor(g.gx(minX)) >> CHUNK_SHIFT, g.cx), a1 = clampI(Math.floor(g.gx(maxX)) >> CHUNK_SHIFT, g.cx);
    const b0 = clampI(Math.floor(g.gy(minY)) >> CHUNK_SHIFT, g.cy), b1 = clampI(Math.floor(g.gy(maxY)) >> CHUNK_SHIFT, g.cy);
    const c0 = clampI(Math.floor(g.gz(minZ)) >> CHUNK_SHIFT, g.cz), c1 = clampI(Math.floor(g.gz(maxZ)) >> CHUNK_SHIFT, g.cz);
    const st = this.nextStamp();
    for (let c = c0; c <= c1; c++)
      for (let b = b0; b <= b1; b++)
        for (let a = a0; a <= a1; a++) {
          const list = this.chunkSegs.get(a + g.cx * (b + g.cy * c));
          if (!list) continue;
          for (const s of list) if (!this.segGone[s] && !this.seen(s, st)) out.push(s);
        }
    return out;
  }

  /**
   * Entry/exit distances of a ray through segment s modelled as a cylinder clipped to the segment
   * slab (neighbouring segments cover the joints). Writes [t0, t1] into out, returns false on miss.
   */
  rayInterval(s: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, out: Float64Array): boolean {
    const n = this.nodes, a = this.segA[s]! * 3, b = this.segB[s]! * 3;
    const ax = n[a]!, ay = n[a + 1]!, az = n[a + 2]!;
    const bax = n[b]! - ax, bay = n[b + 1]! - ay, baz = n[b + 2]! - az;
    const oax = ox - ax, oay = oy - ay, oaz = oz - az;
    const baba = bax * bax + bay * bay + baz * baz;
    if (baba < 1e-12) return false;
    const bard = bax * dx + bay * dy + baz * dz;
    const baoa = bax * oax + bay * oay + baz * oaz;
    const rdoa = dx * oax + dy * oay + dz * oaz;
    const oaoa = oax * oax + oay * oay + oaz * oaz;
    const r = this.radius(s);
    // Ray–infinite-cylinder quadratic (I. Quilez, "intersectors"), then clip to the segment slab.
    const A = baba - bard * bard;
    const B = baba * rdoa - baoa * bard;
    const C = baba * oaoa - baoa * baoa - r * r * baba;
    let t0: number, t1: number;
    if (Math.abs(A) < 1e-12) {
      if (C > 0) return false;
      t0 = -Infinity;
      t1 = Infinity;
    } else {
      const disc = B * B - A * C;
      if (disc < 0) return false;
      const sq = Math.sqrt(disc);
      t0 = (-B - sq) / A;
      t1 = (-B + sq) / A;
    }
    if (Math.abs(bard) < 1e-12) {
      if (baoa < 0 || baoa > baba) return false;
    } else {
      let s0 = -baoa / bard, s1 = (baba - baoa) / bard;
      if (s0 > s1) { const t = s0; s0 = s1; s1 = t; }
      if (s0 > t0) t0 = s0;
      if (s1 < t1) t1 = s1;
    }
    if (t1 < t0) return false;
    out[0] = t0;
    out[1] = t1;
    return true;
  }

  /** Squared distance from point p to segment s's axis. */
  distance2(s: number, px: number, py: number, pz: number): number {
    const n = this.nodes, a = this.segA[s]! * 3, b = this.segB[s]! * 3;
    return pointSegDist2(px, py, pz, n[a]!, n[a + 1]!, n[a + 2]!, n[b]!, n[b + 1]!, n[b + 2]!);
  }

  /** Mass of live steel, kg (cached per version: the structure graph asks for weights often). */
  mass(): number {
    if (this.massVersion === this.version) return this.massCache;
    let m = 0;
    const rho = MATERIALS.rebar_b500.density;
    for (let s = 0; s < this.segCount; s++) {
      if (this.segGone[s]) continue;
      const a = this.segA[s]! * 3, b = this.segB[s]! * 3, n = this.nodes;
      const L = Math.hypot(n[b]! - n[a]!, n[b + 1]! - n[a + 1]!, n[b + 2]! - n[a + 2]!);
      m += rho * Math.PI * this.segR[s]! ** 2 * this.segArea[s]! * L;
    }
    this.massCache = m;
    this.massVersion = this.version;
    return m;
  }

  /**
   * Remove `frac` of segment s's area; past 80 % loss the bar is cut and its two ends spring
   * apart a few millimetres. Returns true if this call cut it.
   */
  nick(s: number, frac: number, jitter: number): boolean {
    if (!this.alive(s) || frac <= 0) return false;
    this.segArea[s] = Math.max(0, this.segArea[s]! - frac);
    this.version++;
    if (this.segArea[s]! > 0.2) return false;
    this.cut(s, jitter);
    return true;
  }

  cut(s: number, jitter: number): void {
    if (this.segCut[s]) return;
    this.segCut[s] = 1;
    const n = this.nodes, a = this.segA[s]! * 3, b = this.segB[s]! * 3;
    const tx = n[b]! - n[a]!, ty = n[b + 1]! - n[a + 1]!, tz = n[b + 2]! - n[a + 2]!;
    const L = Math.hypot(tx, ty, tz) || 1;
    // Elastic spring-back of the severed ends (a few mm) plus a slight kink.
    const gap = 0.004 + 0.004 * Math.abs(jitter);
    n[a] -= (tx / L) * gap; n[a + 1] -= (ty / L) * gap; n[a + 2] -= (tz / L) * gap;
    n[b] += (tx / L) * gap; n[b + 1] += (ty / L) * gap; n[b + 2] += (tz / L) * gap;
    const k = 0.006 * jitter;
    n[a + 1] += k; n[b + 1] -= k;
    this.version++;
  }

  /**
   * Drop bar pieces that no longer touch any concrete: live segments are kept only if a chain of
   * live segments links them to a node inside material (`embedded(x, y, z)`). Returns the number
   * of segments dropped.
   */
  pruneFloating(embedded: (x: number, y: number, z: number) => boolean): number {
    const n = this.nodes;
    const nodeSegs: number[][] = [];
    for (let i = 0; i < this.nodeCount; i++) nodeSegs.push([]);
    for (let s = 0; s < this.segCount; s++) {
      if (!this.alive(s)) continue;
      nodeSegs[this.segA[s]!]!.push(s);
      nodeSegs[this.segB[s]!]!.push(s);
    }
    const keep = new Uint8Array(this.segCount);
    const stack: number[] = [];
    for (let s = 0; s < this.segCount; s++) {
      if (!this.alive(s) || keep[s]) continue;
      const a = this.segA[s]! * 3, b = this.segB[s]! * 3;
      if (embedded(n[a]!, n[a + 1]!, n[a + 2]!) || embedded(n[b]!, n[b + 1]!, n[b + 2]!)) {
        keep[s] = 1;
        stack.push(s);
      }
    }
    while (stack.length) {
      const s = stack.pop()!;
      for (const node of [this.segA[s]!, this.segB[s]!]) {
        for (const t of nodeSegs[node]!) {
          if (keep[t]) continue;
          keep[t] = 1;
          stack.push(t);
        }
      }
    }
    let dropped = 0;
    for (let s = 0; s < this.segCount; s++) {
      if (this.alive(s) && !keep[s]) {
        this.segGone[s] = 1;
        dropped++;
      }
    }
    if (dropped) this.version++;
    return dropped;
  }

  /** Copy the segments selected by `take` into a new set (same local frame); mark them gone here. */
  split(take: (s: number) => boolean): RebarSet | null {
    const pick: number[] = [];
    for (let s = 0; s < this.segCount; s++) if (!this.segGone[s] && take(s)) pick.push(s);
    if (!pick.length) return null;
    const map = new Map<number, number>();
    const nodes: number[] = [];
    const node = (i: number) => {
      let m = map.get(i);
      if (m === undefined) {
        m = nodes.length / 3;
        map.set(i, m);
        nodes.push(this.nodes[i * 3]!, this.nodes[i * 3 + 1]!, this.nodes[i * 3 + 2]!);
      }
      return m;
    };
    const A = new Int32Array(pick.length), B = new Int32Array(pick.length), R = new Float32Array(pick.length);
    pick.forEach((s, q) => {
      A[q] = node(this.segA[s]!);
      B[q] = node(this.segB[s]!);
      R[q] = this.segR[s]!;
    });
    const out = new RebarSet(new Float32Array(nodes), nodes.length / 3, A, B, R, pick.length);
    pick.forEach((s, q) => {
      out.segArea[q] = this.segArea[s]!;
      out.segCut[q] = this.segCut[s]!;
      this.segGone[s] = 1;
    });
    this.version++;
    return out;
  }
}

function clampI(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

export function pointSegDist2(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const L2 = dx * dx + dy * dy + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qy = ay + t * dy - py, qz = az + t * dz - pz;
  return qx * qx + qy * qy + qz * qz;
}

/** Closest distance² between segments p0p1 and q0q1 (Ericson, Real-Time Collision Detection §5.1.9). */
export function segSegDist2(
  p0x: number, p0y: number, p0z: number, p1x: number, p1y: number, p1z: number,
  q0x: number, q0y: number, q0z: number, q1x: number, q1y: number, q1z: number,
): number {
  const d1x = p1x - p0x, d1y = p1y - p0y, d1z = p1z - p0z;
  const d2x = q1x - q0x, d2y = q1y - q0y, d2z = q1z - q0z;
  const rx = p0x - q0x, ry = p0y - q0y, rz = p0z - q0z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) return rx * rx + ry * ry + rz * rz;
  if (a <= 1e-12) {
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-12) {
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const den = a * e - b * b;
      s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  const cx = p0x + d1x * s - (q0x + d2x * t);
  const cy = p0y + d1y * s - (q0y + d2y * t);
  const cz = p0z + d1z * s - (q0z + d2z * t);
  return cx * cx + cy * cy + cz * cz;
}

class Builder {
  nodes: number[] = [];
  segA: number[] = [];
  segB: number[] = [];
  segR: number[] = [];
  step: number;
  constructor(step: number) {
    this.step = step;
  }
  /** Polyline through `pts` (xyz triples), subdivided to ~step, optionally closed. */
  bar(pts: number[], radius: number, closed: boolean): void {
    const first = this.nodes.length / 3;
    const n = pts.length / 3;
    const segs = closed ? n : n - 1;
    let prev = -1;
    for (let q = 0; q < segs; q++) {
      const a = q * 3, b = ((q + 1) % n) * 3;
      const L = Math.hypot(pts[b]! - pts[a]!, pts[b + 1]! - pts[a + 1]!, pts[b + 2]! - pts[a + 2]!);
      const m = Math.max(1, Math.round(L / this.step));
      for (let u = 0; u < m; u++) {
        const t = u / m;
        const idx = this.nodes.length / 3;
        this.nodes.push(pts[a]! + (pts[b]! - pts[a]!) * t, pts[a + 1]! + (pts[b + 1]! - pts[a + 1]!) * t, pts[a + 2]! + (pts[b + 2]! - pts[a + 2]!) * t);
        if (prev >= 0) this.seg(prev, idx, radius);
        prev = idx;
      }
    }
    if (closed) {
      this.seg(prev, first, radius);
    } else {
      const idx = this.nodes.length / 3;
      const b = (n - 1) * 3;
      this.nodes.push(pts[b]!, pts[b + 1]!, pts[b + 2]!);
      this.seg(prev, idx, radius);
    }
  }
  seg(a: number, b: number, r: number): void {
    this.segA.push(a);
    this.segB.push(b);
    this.segR.push(r);
  }
  build(): RebarSet | null {
    if (!this.segA.length) return null;
    return new RebarSet(new Float32Array(this.nodes), this.nodes.length / 3, new Int32Array(this.segA), new Int32Array(this.segB), new Float32Array(this.segR), this.segA.length);
  }
}

/** Evenly spaced bar positions spanning [−half + edge, half − edge] at ≤ spacing (end bars at the edges). */
function positions(half: number, edge: number, spacing: number): number[] {
  const span = 2 * (half - edge);
  if (span <= 1e-6) return [0];
  const n = Math.ceil(span / spacing - 1e-6) + 1;
  const step = span / (n - 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(-span / 2 + i * step);
  return out;
}

/**
 * Lay out reinforcement for a shape (EN 1992-1-1 detailing conventions: cover to the bar surface,
 * links ≥ max(6 mm, φ/4)). Walls/slabs: orthogonal meshes in the plane of the two larger box
 * dimensions ('two-faces': one mesh behind each face; 'center': one mid-plane mesh). Columns:
 * longitudinal bars on a perimeter inside closed links ('cage'). Returns null for SDF shapes.
 */
export function layoutRebar(shape: ShapeSdf, spec: RebarSpec): RebarSet | null {
  const d = Math.min(0.04, Math.max(0.006, spec.diameter));
  const r = d / 2;
  const spacing = Math.max(0.05, spec.spacing);
  const cover = Math.max(0.01, spec.cover);
  const b = new Builder(0.075);
  if (shape instanceof BoxShape) {
    const half = shape.half;
    const order = [0, 1, 2].sort((p, q) => half[p]! - half[q]!);
    const t = order[0]!;
    const cageAxis = order[2]!;
    const pt = (ax: number, av: number, bx: number, bv: number, cx: number, cv: number): [number, number, number] => {
      const p: [number, number, number] = [0, 0, 0];
      p[ax] = av;
      p[bx] = bv;
      p[cx] = cv;
      return p;
    };
    if (spec.layout === 'cage') {
      // Column cage along the longest axis L; section axes p, q.
      const L = cageAxis, p = order[0]!, q = order[1]!;
      const ds = Math.max(0.006, d / 4);
      const inP = half[p]! - cover - ds - r, inQ = half[q]! - cover - ds - r;
      const hoopP = half[p]! - cover - ds / 2, hoopQ = half[q]! - cover - ds / 2;
      const len0 = -half[L]! + cover, len1 = half[L]! - cover;
      const ring: [number, number][] = [];
      for (const sp of positions(inP + r, r, spacing)) ring.push([sp, -inQ], [sp, inQ]);
      for (const sq of positions(inQ + r, r, spacing).slice(1, -1)) ring.push([-inP, sq], [inP, sq]);
      for (const [sp, sq] of ring) b.bar([...pt(L, len0, p, sp, q, sq), ...pt(L, len1, p, sp, q, sq)], r, false);
      for (const sl of positions(half[L]!, cover + ds, spacing)) {
        b.bar([...pt(L, sl, p, -hoopP, q, -hoopQ), ...pt(L, sl, p, hoopP, q, -hoopQ), ...pt(L, sl, p, hoopP, q, hoopQ), ...pt(L, sl, p, -hoopP, q, hoopQ)], ds / 2, true);
      }
      return b.build();
    }
    const u = order[1]!, v = order[2]!;
    const layers: { tOuter: number; tInner: number }[] = [];
    if (spec.layout === 'two-faces') {
      for (const s of [-1, 1]) layers.push({ tOuter: s * (half[t]! - cover - r), tInner: s * (half[t]! - cover - 3 * r) });
    } else {
      layers.push({ tOuter: -r, tInner: r });
    }
    for (const layer of layers) {
      // Bars along v (outer layer), spaced along u.
      for (const su of positions(half[u]!, cover + r, spacing)) {
        b.bar([...pt(t, layer.tOuter, u, su, v, -half[v]! + cover), ...pt(t, layer.tOuter, u, su, v, half[v]! - cover)], r, false);
      }
      // Bars along u (inner layer), spaced along v.
      for (const sv of positions(half[v]!, cover + r, spacing)) {
        b.bar([...pt(t, layer.tInner, v, sv, u, -half[u]! + cover), ...pt(t, layer.tInner, v, sv, u, half[u]! - cover)], r, false);
      }
    }
    return b.build();
  }
  if (shape instanceof CylinderShape) {
    const ds = Math.max(0.006, d / 4);
    const hh = shape.height / 2;
    const y0 = -hh + cover, y1 = hh - cover;
    const inset = (y: number) => shape.radiusAt(y) - shape.fluteDepth - cover;
    const rb0 = inset(y0) - ds - r, rb1 = inset(y1) - ds - r;
    if (rb1 <= r) return null;
    const n = Math.max(6, Math.round((2 * Math.PI * rb1) / spacing));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.PI / n;
      const c = Math.cos(a), s = Math.sin(a);
      b.bar([rb0 * c, y0, rb0 * s, rb1 * c, y1, rb1 * s], r, false);
    }
    for (const y of positions(hh, cover + ds, spacing)) {
      const rh = inset(y) - ds / 2;
      const m = Math.max(12, Math.round((2 * Math.PI * rh) / 0.075));
      const pts: number[] = [];
      for (let i = 0; i < m; i++) {
        const a = (i / m) * Math.PI * 2;
        pts.push(rh * Math.cos(a), y, rh * Math.sin(a));
      }
      b.bar(pts, ds / 2, true);
    }
    return b.build();
  }
  return null;
}
