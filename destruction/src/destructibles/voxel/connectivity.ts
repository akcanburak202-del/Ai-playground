import { CHUNK, EMPTY, FULL, ISO, type VoxelGrid } from './grid.ts';
import type { RebarSet } from './rebar.ts';

/**
 * Coarse occupancy graph for support checks. Each coarse cell covers F³ samples and is a node when
 * it holds any solid sample; nodes connect to their 6 neighbours and along intact rebar (a bar
 * holds concrete on both sides of a crack or a breach together until it is cut).
 *
 * `analyze` flood-fills from anchored cells and returns the islands that lost support. Distances are
 * horizontal geodesics (vertical steps are free — a wall standing on the ground carries its weight
 * in compression). A cell stays supported if its nearest anchor is within the cantilever reach
 * (~10 thicknesses) or if two different anchors hold it with a combined distance within the span
 * limit (~35 thicknesses, the span/depth ratio of ordinary RC slabs, EN 1992-1-1 §7.4.2). So a
 * slab on two walls stands; lose one wall and everything beyond the cantilever reach breaks off.
 */
export interface Island {
  cells: number[];
  /** Solid samples inside the island */
  samples: number;
  /** Coarse-cell bounds (inclusive) */
  min: [number, number, number];
  max: [number, number, number];
}

export interface AnalyzeOptions {
  /** One mask of fixed coarse cells per support (1 = anchored); null when never anchored */
  anchors: Uint8Array[] | null;
  rebar: RebarSet | null;
  /** Horizontal length (m) of one coarse step along local x, y, z (0 for vertical axes) */
  horizontal: [number, number, number];
  /** Cantilever reach from one support, m (≈ 10 × thickness); Infinity disables */
  cantilever: number;
  /** Largest span between two supports, m (≈ 35 × thickness) */
  span: number;
}

export class Connectivity {
  readonly F: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly n: number;
  /** Solid sample count per coarse cell */
  readonly count: Uint16Array;
  /**
   * Face links: bit 0/1/2 set when this cell touches its +x/+y/+z neighbour through at least one
   * pair of solid samples across the shared face (so a crack thinner than a coarse cell still
   * separates the two sides).
   */
  readonly link: Uint8Array;
  /** Bumped by every occupancy update (bar-tie cache key) */
  private occVersion = 0;
  private dist: Int32Array;
  private dist2: Int32Array;
  private distTmp: Int32Array;
  private label: Int32Array;
  private queue: Int32Array;

  constructor(grid: VoxelGrid, F: number) {
    this.F = F;
    this.nx = Math.ceil(grid.nx / F);
    this.ny = Math.ceil(grid.ny / F);
    this.nz = Math.ceil(grid.nz / F);
    this.n = this.nx * this.ny * this.nz;
    this.count = new Uint16Array(this.n);
    this.link = new Uint8Array(this.n);
    this.dist = new Int32Array(this.n);
    this.dist2 = new Int32Array(this.n);
    this.distTmp = new Int32Array(this.n);
    this.label = new Int32Array(this.n);
    this.queue = new Int32Array(this.n + 16);
  }

  cellOf(g: VoxelGrid, x: number, y: number, z: number): number {
    const F = this.F;
    const I = Math.floor(Math.round(g.gx(x)) / F), J = Math.floor(Math.round(g.gy(y)) / F), K = Math.floor(Math.round(g.gz(z)) / F);
    if (I < 0 || J < 0 || K < 0 || I >= this.nx || J >= this.ny || K >= this.nz) return -1;
    return I + this.nx * (J + this.ny * K);
  }

  /** Recount the coarse cells inside the given chunks (all chunks when list is null). */
  update(g: VoxelGrid, chunks: readonly number[] | null): void {
    this.occVersion++;
    const F = this.F;
    const per = CHUNK / F;
    const visit = (ci: number) => {
      const a = ci % g.cx, b = Math.floor(ci / g.cx) % g.cy, c = Math.floor(ci / (g.cx * g.cy));
      const st = g.state[ci];
      const I0 = a * per, J0 = b * per, K0 = c * per;
      for (let K = K0; K < Math.min(this.nz, K0 + per); K++)
        for (let J = J0; J < Math.min(this.ny, J0 + per); J++)
          for (let I = I0; I < Math.min(this.nx, I0 + per); I++) {
            const cell = I + this.nx * (J + this.ny * K);
            if (st === EMPTY) {
              this.count[cell] = 0;
              continue;
            }
            const i0 = I * F, j0 = J * F, k0 = K * F;
            const i1 = Math.min(g.nx, i0 + F), j1 = Math.min(g.ny, j0 + F), k1 = Math.min(g.nz, k0 + F);
            if (st === FULL) {
              this.count[cell] = (i1 - i0) * (j1 - j0) * (k1 - k0);
              continue;
            }
            const d = g.dens[ci]!;
            let n = 0;
            for (let k = k0; k < k1; k++)
              for (let j = j0; j < j1; j++)
                for (let i = i0; i < i1; i++) if (d[(i & 15) | ((j & 15) << 4) | ((k & 15) << 8)]! >= ISO) n++;
            this.count[cell] = n;
          }
    };
    if (chunks) for (const ci of chunks) visit(ci);
    else for (let ci = 0; ci < g.chunkCount; ci++) visit(ci);
    // Relink the visited cells and their −x/−y/−z neighbours (whose + links reach into them).
    const relink = (I0: number, J0: number, K0: number, I1: number, J1: number, K1: number) => {
      for (let K = Math.max(0, K0); K <= Math.min(this.nz - 1, K1); K++)
        for (let J = Math.max(0, J0); J <= Math.min(this.ny - 1, J1); J++)
          for (let I = Math.max(0, I0); I <= Math.min(this.nx - 1, I1); I++) this.linkCell(g, I, J, K);
    };
    if (chunks) {
      for (const ci of chunks) {
        const a = ci % g.cx, b = Math.floor(ci / g.cx) % g.cy, c = Math.floor(ci / (g.cx * g.cy));
        relink(a * per - 1, b * per - 1, c * per - 1, a * per + per - 1, b * per + per - 1, c * per + per - 1);
      }
    } else relink(0, 0, 0, this.nx - 1, this.ny - 1, this.nz - 1);
  }

  private linkCell(g: VoxelGrid, I: number, J: number, K: number): void {
    const F = this.F;
    const cell = I + this.nx * (J + this.ny * K);
    let bits = 0;
    if (this.count[cell]) {
      const i0 = I * F, j0 = J * F, k0 = K * F;
      const i1 = i0 + F - 1, j1 = j0 + F - 1, k1 = k0 + F - 1;
      if (I + 1 < this.nx && this.count[cell + 1]) {
        search: for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) if (g.density(i1, j, k) >= ISO && g.density(i1 + 1, j, k) >= ISO) { bits |= 1; break search; }
      }
      if (J + 1 < this.ny && this.count[cell + this.nx]) {
        search: for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) if (g.density(i, j1, k) >= ISO && g.density(i, j1 + 1, k) >= ISO) { bits |= 2; break search; }
      }
      if (K + 1 < this.nz && this.count[cell + this.nx * this.ny]) {
        search: for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (g.density(i, j, k1) >= ISO && g.density(i, j, k1 + 1) >= ISO) { bits |= 4; break search; }
      }
    }
    this.link[cell] = bits;
  }

  private barCache: { rebar: RebarSet; version: number; occ: number; adj: Map<number, number[]> } | null = null;

  /**
   * Adjacency from intact bars: coarse cell → cells it is tied to (cached per rebar and occupancy
   * version). A bar ties concrete together only across a short gap: an exposed run longer than
   * BAR_FREE_LENGTH diameters between embedments buckles before it yields (Euler: σ_cr = f_y at
   * KL/r = π√(E/f_y) ≈ 63, i.e. L ≈ 16–31 d for B500; EN 1992-1-1 §9.5.3 restrains column bars
   * at ≤ 20 φ), so a wall top whose base was blown out does not hang on its bent bars.
   */
  private barEdges(g: VoxelGrid, rebar: RebarSet | null): Map<number, number[]> | null {
    if (!rebar) return null;
    const c = this.barCache;
    if (c && c.rebar === rebar && c.version === rebar.version && c.occ === this.occVersion) return c.adj;
    const adj = new Map<number, number[]>();
    const n = rebar.nodes;
    const slack = this.slackBars(g, rebar);
    for (let s = 0; s < rebar.segCount; s++) {
      if (!rebar.alive(s) || rebar.segArea[s]! < 0.2 || slack[s]) continue;
      const a = rebar.segA[s]! * 3, b = rebar.segB[s]! * 3;
      const ca = this.cellOf(g, n[a]!, n[a + 1]!, n[a + 2]!), cb = this.cellOf(g, n[b]!, n[b + 1]!, n[b + 2]!);
      if (ca < 0 || cb < 0 || ca === cb) continue;
      let la = adj.get(ca);
      if (!la) adj.set(ca, (la = []));
      la.push(cb);
      let lb = adj.get(cb);
      if (!lb) adj.set(cb, (lb = []));
      lb.push(ca);
    }
    this.barCache = { rebar, version: rebar.version, occ: this.occVersion, adj };
    return adj;
  }

  /** Segments lying in exposed runs too long to act as ties (1), walking each bar's chain. */
  private slackBars(g: VoxelGrid, rebar: RebarSet): Uint8Array {
    const out = new Uint8Array(rebar.segCount);
    const n = rebar.nodes;
    const embedded = (node: number) => {
      const c = this.cellOf(g, n[node * 3]!, n[node * 3 + 1]!, n[node * 3 + 2]!);
      return c >= 0 && this.count[c]! > 0;
    };
    let s = 0;
    while (s < rebar.segCount) {
      let e = s;
      while (e + 1 < rebar.segCount && rebar.segB[e] === rebar.segA[e + 1]) e++;
      let q0 = s, len = 0;
      for (let q = s; q <= e; q++) {
        const a = rebar.segA[q]! * 3, b = rebar.segB[q]! * 3;
        len += Math.hypot(n[b]! - n[a]!, n[b + 1]! - n[a + 1]!, n[b + 2]! - n[a + 2]!);
        if (q === e || embedded(rebar.segB[q]!)) {
          if (len > BAR_FREE_LENGTH * 2 * rebar.segR[q]!) for (let k = q0; k <= q; k++) out[k] = 1;
          q0 = q + 1;
          len = 0;
        }
      }
      s = e + 1;
    }
    return out;
  }

  /**
   * Horizontal geodesic distances from one support's cells, in integer units of a quarter coarse
   * step (Dial's bucket-queue Dijkstra, Dial 1969 — O(V + E) for small integer weights).
   */
  private geodesic(o: AnalyzeOptions, anchors: Uint8Array, adj: Map<number, number[]> | null, dist: Int32Array): void {
    const { nx, ny, nz, count, link } = this;
    const nxy = nx * ny;
    dist.fill(INF);
    const unit = this.unit(o);
    const wx = Math.round(o.horizontal[0] / unit), wy = Math.round(o.horizontal[1] / unit), wz = Math.round(o.horizontal[2] / unit);
    let W = Math.max(1, wx, wy, wz);
    const barW = (a: number, b: number) => {
      const dI = (b % nx) - (a % nx), dJ = (Math.floor(b / nx) % ny) - (Math.floor(a / nx) % ny), dK = Math.floor(b / nxy) - Math.floor(a / nxy);
      return Math.round(Math.hypot(dI * o.horizontal[0], dJ * o.horizontal[1], dK * o.horizontal[2]) / unit);
    };
    if (adj) for (const [a, list] of adj) for (const b of list) W = Math.max(W, barW(a, b));
    const nb = W + 1;
    const buckets: number[][] = [];
    for (let q = 0; q < nb; q++) buckets.push([]);
    let pending = 0;
    for (let c = 0; c < this.n; c++) {
      if (anchors[c] && (count[c]! > 0 || adj?.has(c))) {
        dist[c] = 0;
        buckets[0]!.push(c);
        pending++;
      }
    }
    for (let d = 0; pending > 0; d++) {
      const bucket = buckets[d % nb]!;
      while (bucket.length) {
        const c = bucket.pop()!;
        pending--;
        if (dist[c] !== d) continue;
        const I = c % nx, J = ((c / nx) | 0) % ny, K = (c / nxy) | 0;
        if (count[c]) {
          let t: number, nd: number;
          if (I > 0 && link[(t = c - 1)]! & 1 && (nd = d + wx) < dist[t]!) { dist[t] = nd; buckets[nd % nb]!.push(t); pending++; }
          if (I < nx - 1 && link[c]! & 1 && (nd = d + wx) < dist[(t = c + 1)]!) { dist[t] = nd; buckets[nd % nb]!.push(t); pending++; }
          if (J > 0 && link[(t = c - nx)]! & 2 && (nd = d + wy) < dist[t]!) { dist[t] = nd; buckets[nd % nb]!.push(t); pending++; }
          if (J < ny - 1 && link[c]! & 2 && (nd = d + wy) < dist[(t = c + nx)]!) { dist[t] = nd; buckets[nd % nb]!.push(t); pending++; }
          if (K > 0 && link[(t = c - nxy)]! & 4 && (nd = d + wz) < dist[t]!) { dist[t] = nd; buckets[nd % nb]!.push(t); pending++; }
          if (K < nz - 1 && link[c]! & 4 && (nd = d + wz) < dist[(t = c + nxy)]!) { dist[t] = nd; buckets[nd % nb]!.push(t); pending++; }
        }
        const bl = adj?.get(c);
        if (bl) {
          for (const t of bl) {
            const nd = d + barW(c, t);
            if (nd < dist[t]!) { dist[t] = nd; buckets[nd % nb]!.push(t); pending++; }
          }
        }
      }
    }
  }

  private unit(o: AnalyzeOptions): number {
    const m = Math.max(o.horizontal[0], o.horizontal[1], o.horizontal[2]);
    return m > 0 ? m / 4 : 1;
  }

  /**
   * Unsupported islands. Anchored mode: everything not reachable from anchors within the
   * cantilever allowance. Unanchored mode: everything except the largest component.
   */
  analyze(g: VoxelGrid, o: AnalyzeOptions): Island[] {
    const { nx, ny, nz, count, link } = this;
    const nxy = nx * ny;
    const adj = this.barEdges(g, o.rebar);
    const label = this.label; // 1 = supported, 0 = not yet, ≥ 2 component id
    label.fill(0);
    if (o.anchors) {
      // Two smallest distances from different supports per cell.
      const best1 = this.dist, best2 = this.dist2;
      best1.fill(INF);
      best2.fill(INF);
      const tmp = this.distTmp;
      for (const mask of o.anchors) {
        this.geodesic(o, mask, adj, tmp);
        for (let c = 0; c < this.n; c++) {
          const d = tmp[c]!;
          if (d < best1[c]!) { best2[c] = best1[c]!; best1[c] = d; } else if (d < best2[c]!) best2[c] = d;
        }
      }
      const unit = this.unit(o);
      const reach = isFinite(o.cantilever) ? Math.round(o.cantilever / unit) : INF;
      const span = isFinite(o.span) ? Math.round(o.span / unit) : INF;
      for (let c = 0; c < this.n; c++) {
        const d1 = best1[c]!;
        if (d1 >= INF) continue;
        if (d1 <= reach || (best2[c]! < INF && d1 + best2[c]! <= span)) label[c] = 1;
      }
    }
    // Components of unsupported solid cells (6-neighbours through solid cells, plus bar ties).
    const comps: Island[] = [];
    for (let c = 0; c < this.n; c++) {
      if (label[c] !== 0 || count[c] === 0) continue;
      const id = comps.length + 2;
      const island: Island = { cells: [], samples: 0, min: [Infinity, Infinity, Infinity], max: [-1, -1, -1] };
      let queue = this.queue;
      let qh = 0, qt = 0;
      queue[qt++] = c;
      label[c] = id;
      while (qh < qt) {
        const cur = queue[qh++]!;
        island.cells.push(cur);
        island.samples += count[cur]!;
        const I = cur % nx, J = ((cur / nx) | 0) % ny, K = (cur / nxy) | 0;
        if (I < island.min[0]) island.min[0] = I;
        if (J < island.min[1]) island.min[1] = J;
        if (K < island.min[2]) island.min[2] = K;
        if (I > island.max[0]) island.max[0] = I;
        if (J > island.max[1]) island.max[1] = J;
        if (K > island.max[2]) island.max[2] = K;
        if (qt + 8 >= queue.length) queue = this.queue = growI32(queue);
        if (count[cur]) {
          let t: number;
          if (I > 0 && link[(t = cur - 1)]! & 1 && label[t] === 0) { label[t] = id; queue[qt++] = t; }
          if (I < nx - 1 && link[cur]! & 1 && label[(t = cur + 1)] === 0) { label[t] = id; queue[qt++] = t; }
          if (J > 0 && link[(t = cur - nx)]! & 2 && label[t] === 0) { label[t] = id; queue[qt++] = t; }
          if (J < ny - 1 && link[cur]! & 2 && label[(t = cur + nx)] === 0) { label[t] = id; queue[qt++] = t; }
          if (K > 0 && link[(t = cur - nxy)]! & 4 && label[t] === 0) { label[t] = id; queue[qt++] = t; }
          if (K < nz - 1 && link[cur]! & 4 && label[(t = cur + nxy)] === 0) { label[t] = id; queue[qt++] = t; }
        }
        const bl = adj?.get(cur);
        if (bl) {
          for (const t of bl) {
            if (label[t] !== 0) continue;
            label[t] = id;
            if (qt >= queue.length) queue = this.queue = growI32(queue);
            queue[qt++] = t;
          }
        }
      }
      if (island.samples > 0) comps.push(island);
    }
    if (!o.anchors && comps.length > 0) {
      // Never anchored: the largest component stays put, the rest are loose.
      let best = 0;
      for (let q = 1; q < comps.length; q++) if (comps[q]!.samples > comps[best]!.samples) best = q;
      comps.splice(best, 1);
    }
    return comps;
  }

  /** Coarse cells overlapping a local box → mask (for anchors). */
  markBox(g: VoxelGrid, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, mask: Uint8Array): number {
    const F = this.F;
    const I0 = Math.max(0, Math.floor(g.gx(minX) / F)), I1 = Math.min(this.nx - 1, Math.floor(g.gx(maxX) / F));
    const J0 = Math.max(0, Math.floor(g.gy(minY) / F)), J1 = Math.min(this.ny - 1, Math.floor(g.gy(maxY) / F));
    const K0 = Math.max(0, Math.floor(g.gz(minZ) / F)), K1 = Math.min(this.nz - 1, Math.floor(g.gz(maxZ) / F));
    let n = 0;
    for (let K = K0; K <= K1; K++)
      for (let J = J0; J <= J1; J++)
        for (let I = I0; I <= I1; I++) {
          mask[I + this.nx * (J + this.ny * K)] = 1;
          n++;
        }
    return n;
  }
}

const INF = 0x3fffffff;
/** Longest exposed bar run (in bar diameters) that still ties concrete together; see barEdges */
const BAR_FREE_LENGTH = 20;

function growI32(a: Int32Array): Int32Array {
  const b = new Int32Array(a.length * 2);
  b.set(a);
  return b;
}
