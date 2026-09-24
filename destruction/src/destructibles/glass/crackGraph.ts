import { interiorPoint, polyArea, polyBounds, pointInPoly, type Poly } from './polygon.ts';

/**
 * The crack network of one pane as a planar straight-line graph in pane-local metres (origin at the
 * pane centre, x along the width, y along the height). The pane outline is part of the graph, so
 * the faces of the graph are exactly the pieces the glass has broken into.
 *
 * Cracks are inserted with the fractographic sequencing rule: a running crack is arrested by any
 * free surface it meets — the pane edge, a hole, or an earlier crack (the "four R" / sequence rule
 * of glass fractography: radial cracks of a later shot terminate on the cracks of an earlier one;
 * Thornton & Cashman 1986, J. Forensic Sci. 31; Haag & Haag, "Shooting Incident Reconstruction",
 * 2011, ch. 11). So new cracks never cross old ones and the graph only ever gains T-junctions,
 * which keeps it planar without general arrangement code. Hole outlines (bullet holes) are the one
 * exception: they cut through whatever lies under them (`loop`).
 */

export const SEG_BOUNDARY = 0;
export const SEG_RADIAL = 1;
export const SEG_BRANCH = 2;
export const SEG_ARC = 3;
export const SEG_HOLE = 4;

/** Vertices closer than this are the same vertex, m. */
export const SNAP = 2e-4;
/** A crack step that would stop within this of another crack joins it instead (no hairline slivers), m. */
const REACH = 1.5e-3;
const EMPTY_LINKS: number[] = [];

export interface GraphHit {
  seg: number;
  /** Parameter along the query segment */
  t: number;
  /** Parameter along the struck segment */
  u: number;
  x: number;
  y: number;
}

/** One piece of the pane: a face of the crack graph. */
export interface Face {
  /** Counter-clockwise outline, flat [x, y, …] */
  outer: Poly;
  /** Clockwise outlines of islands inside it */
  holes: Poly[];
  /** Net area (outline minus holes), m² */
  area: number;
  /** Length of pane edge the piece bears on: [bottom, right, top, left], m */
  edge: [number, number, number, number];
  /** A point strictly inside the piece */
  sample: [number, number];
  bounds: [number, number, number, number];
  /**
   * Contacts with the neighbouring pieces, 4 numbers per boundary edge (outline and island
   * outlines): [neighbour face index (−1: pane edge), edge length m, outward normal x, y]. The
   * normals say which way this piece presses on each neighbour, i.e. whether it bears on it.
   */
  links: number[];
}

export interface GrowResult {
  /** Vertex the crack tip is at after the step */
  v: number;
  /** The crack ran into a free surface and stopped */
  blocked: boolean;
}

export class CrackGraph {
  readonly w: number;
  readonly h: number;
  readonly vx: number[] = [];
  readonly vy: number[] = [];
  readonly sa: number[] = [];
  readonly sb: number[] = [];
  readonly kind: number[] = [];
  readonly live: number[] = [];
  /** Already drawn into the crack texture (inherited by the halves of a split segment) */
  readonly painted: number[] = [];
  /** Bumped on every change, so derived data (faces) can be cached */
  version = 0;
  private readonly cell: number;
  private readonly gw: number;
  private readonly gh: number;
  private readonly segCells: number[][];
  private readonly vertCells: number[][];
  private stamp = new Int32Array(1024);
  private stampId = 0;
  private hits: GraphHit[] = [];

  constructor(width: number, height: number, cell = 0.025) {
    this.w = width;
    this.h = height;
    this.cell = cell;
    this.gw = Math.max(1, Math.ceil(width / cell));
    this.gh = Math.max(1, Math.ceil(height / cell));
    this.segCells = Array.from({ length: this.gw * this.gh }, () => []);
    this.vertCells = Array.from({ length: this.gw * this.gh }, () => []);
    const x0 = -width / 2, x1 = width / 2, y0 = -height / 2, y1 = height / 2;
    const a = this.addVertex(x0, y0), b = this.addVertex(x1, y0), c = this.addVertex(x1, y1), d = this.addVertex(x0, y1);
    this.segment(a, b, SEG_BOUNDARY, 1);
    this.segment(b, c, SEG_BOUNDARY, 1);
    this.segment(c, d, SEG_BOUNDARY, 1);
    this.segment(d, a, SEG_BOUNDARY, 1);
  }

  get segmentCount(): number {
    return this.sa.length;
  }

  /** Number of live crack segments (pane outline excluded). */
  crackCount(): number {
    let n = 0;
    for (let s = 0; s < this.sa.length; s++) if (this.live[s] && this.kind[s] !== SEG_BOUNDARY) n++;
    return n;
  }

  inside(x: number, y: number, margin = 0): boolean {
    return Math.abs(x) <= this.w / 2 - margin && Math.abs(y) <= this.h / 2 - margin;
  }

  // ─── Construction ────────────────────────────────────────────────────────────────────────

  private cellOf(x: number, y: number): number {
    let i = Math.floor((x + this.w / 2) / this.cell);
    let j = Math.floor((y + this.h / 2) / this.cell);
    i = i < 0 ? 0 : i >= this.gw ? this.gw - 1 : i;
    j = j < 0 ? 0 : j >= this.gh ? this.gh - 1 : j;
    return j * this.gw + i;
  }

  private addVertex(x: number, y: number): number {
    const id = this.vx.length;
    this.vx.push(x);
    this.vy.push(y);
    this.vertCells[this.cellOf(x, y)]!.push(id);
    return id;
  }

  /** Existing vertex within SNAP of (x, y), or -1. */
  findVertex(x: number, y: number): number {
    const i0 = Math.floor((x - SNAP + this.w / 2) / this.cell), i1 = Math.floor((x + SNAP + this.w / 2) / this.cell);
    const j0 = Math.floor((y - SNAP + this.h / 2) / this.cell), j1 = Math.floor((y + SNAP + this.h / 2) / this.cell);
    for (let j = Math.max(0, j0); j <= Math.min(this.gh - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(this.gw - 1, i1); i++) {
        for (const v of this.vertCells[j * this.gw + i]!) {
          const dx = this.vx[v]! - x, dy = this.vy[v]! - y;
          if (dx * dx + dy * dy < SNAP * SNAP) return v;
        }
      }
    }
    return -1;
  }

  /** Vertex at (x, y), merged with an existing one within SNAP. */
  vertex(x: number, y: number): number {
    const v = this.findVertex(x, y);
    return v >= 0 ? v : this.addVertex(x, y);
  }

  private register(s: number): void {
    const ax = this.vx[this.sa[s]!]!, ay = this.vy[this.sa[s]!]!, bx = this.vx[this.sb[s]!]!, by = this.vy[this.sb[s]!]!;
    this.forCells(Math.min(ax, bx) - SNAP, Math.min(ay, by) - SNAP, Math.max(ax, bx) + SNAP, Math.max(ay, by) + SNAP, (c) => {
      this.segCells[c]!.push(s);
    });
  }

  private forCells(x0: number, y0: number, x1: number, y1: number, fn: (cell: number) => void): void {
    const i0 = Math.max(0, Math.floor((x0 + this.w / 2) / this.cell)), i1 = Math.min(this.gw - 1, Math.floor((x1 + this.w / 2) / this.cell));
    const j0 = Math.max(0, Math.floor((y0 + this.h / 2) / this.cell)), j1 = Math.min(this.gh - 1, Math.floor((y1 + this.h / 2) / this.cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * this.gw + i);
  }

  /** Add a segment between two vertices (no intersection checks). */
  segment(a: number, b: number, kind: number, painted = 0): number {
    if (a === b) return -1;
    const dup = this.edgeBetween(a, b);
    if (dup >= 0) return dup;
    const s = this.sa.length;
    this.sa.push(a);
    this.sb.push(b);
    this.kind.push(kind);
    this.live.push(1);
    this.painted.push(painted);
    this.register(s);
    this.version++;
    return s;
  }

  /** Live segment joining vertices a and b, or -1. */
  edgeBetween(a: number, b: number): number {
    for (const s of this.segCells[this.cellOf(this.vx[a]!, this.vy[a]!)]!) {
      if (this.live[s] && ((this.sa[s] === a && this.sb[s] === b) || (this.sa[s] === b && this.sb[s] === a))) return s;
    }
    return -1;
  }

  /** Replace segment s by two halves through vertex v (which must lie on it). */
  split(s: number, v: number): void {
    const a = this.sa[s]!, b = this.sb[s]!;
    if (v === a || v === b) return;
    this.live[s] = 0;
    this.segment(a, v, this.kind[s]!, this.painted[s]!);
    this.segment(v, b, this.kind[s]!, this.painted[s]!);
  }

  private nextStamp(): number {
    if (this.stamp.length < this.sa.length) {
      const n = new Int32Array(Math.max(this.sa.length, this.stamp.length * 2));
      n.set(this.stamp);
      this.stamp = n;
    }
    return ++this.stampId;
  }

  /**
   * Intersections of segment a→b with live segments not incident to vertices `skip0`/`skip1`,
   * nearest first when `all`, otherwise only the nearest (returned in hits[0]).
   */
  private query(ax: number, ay: number, bx: number, by: number, skip0: number, skip1: number, all: boolean): GraphHit[] {
    const out = this.hits;
    out.length = 0;
    const id = this.nextStamp();
    const dx = bx - ax, dy = by - ay;
    let best = Infinity;
    this.forCells(Math.min(ax, bx) - SNAP, Math.min(ay, by) - SNAP, Math.max(ax, bx) + SNAP, Math.max(ay, by) + SNAP, (c) => {
      for (const s of this.segCells[c]!) {
        if (!this.live[s] || this.stamp[s] === id) continue;
        this.stamp[s] = id;
        const p = this.sa[s]!, q = this.sb[s]!;
        if (p === skip0 || q === skip0 || p === skip1 || q === skip1) continue;
        const px = this.vx[p]!, py = this.vy[p]!;
        const ex = this.vx[q]! - px, ey = this.vy[q]! - py;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-18) continue; // parallel: collinear overlaps never arise from the growth rules
        const wx = px - ax, wy = py - ay;
        const t = (wx * ey - wy * ex) / den;
        const u = (wx * dy - wy * dx) / den;
        if (t <= 1e-12 || t > 1 || u < -1e-9 || u > 1 + 1e-9) continue;
        if (!all && t >= best) continue;
        best = t;
        const hit = { seg: s, t, u: u < 0 ? 0 : u > 1 ? 1 : u, x: ax + t * dx, y: ay + t * dy };
        if (all) out.push(hit);
        else out[0] = hit;
      }
    });
    if (all) out.sort((p, q) => p.t - q.t);
    return out;
  }

  /** Nearest crack/edge the segment a→b runs into (ignoring those at vertex `skip`), or null. */
  firstHit(ax: number, ay: number, bx: number, by: number, skip = -1): GraphHit | null {
    const h = this.query(ax, ay, bx, by, skip, -1, false);
    return h.length ? { ...h[0]! } : null;
  }

  /** Vertex at a hit point on its segment (reusing an endpoint when the hit is within SNAP of it). */
  private junction(hit: GraphHit): number {
    const s = hit.seg;
    const a = this.sa[s]!, b = this.sb[s]!;
    const len = Math.hypot(this.vx[b]! - this.vx[a]!, this.vy[b]! - this.vy[a]!);
    if (hit.u * len < SNAP) return a;
    if ((1 - hit.u) * len < SNAP) return b;
    const v = this.addVertex(hit.x, hit.y);
    this.split(s, v);
    return v;
  }

  /**
   * Extend a crack from vertex `v` towards (x, y). The crack stops at the first free surface it
   * meets (T-junction); a step ending within REACH of a crack joins it.
   */
  grow(v: number, x: number, y: number, kind: number): GrowResult {
    const px = this.vx[v]!, py = this.vy[v]!;
    const dx = x - px, dy = y - py;
    const len = Math.hypot(dx, dy);
    if (len < SNAP) return { v, blocked: false };
    const ux = dx / len, uy = dy / len;
    const h = this.query(px, py, x + ux * REACH, y + uy * REACH, v, -1, false);
    if (h.length) {
      const hit = h[0]!;
      if (hit.t * (len + REACH) < SNAP) return { v, blocked: true };
      const j = this.junction({ ...hit });
      if (j !== v) this.segment(v, j, kind);
      return { v: j, blocked: true };
    }
    const existing = this.findVertex(x, y);
    const nv = existing >= 0 ? existing : this.addVertex(x, y);
    if (nv === v) return { v, blocked: false };
    this.segment(v, nv, kind);
    return { v: nv, blocked: existing >= 0 };
  }

  /**
   * Vertex on the live crack network at (x, y): an existing vertex, or a new one splitting the
   * nearest segment within `tol`. -1 when there is no crack there.
   */
  pointVertex(x: number, y: number, tol = 1e-6): number {
    const v = this.findVertex(x, y);
    if (v >= 0) return v;
    let best = -1, bestD = tol * tol, bu = 0;
    const id = this.nextStamp();
    this.forCells(x - tol, y - tol, x + tol, y + tol, (c) => {
      for (const s of this.segCells[c]!) {
        if (!this.live[s] || this.stamp[s] === id) continue;
        this.stamp[s] = id;
        const ax = this.vx[this.sa[s]!]!, ay = this.vy[this.sa[s]!]!;
        const ex = this.vx[this.sb[s]!]! - ax, ey = this.vy[this.sb[s]!]! - ay;
        const l2 = ex * ex + ey * ey;
        if (l2 <= 0) continue;
        const u = Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey) / l2));
        const qx = ax + u * ex - x, qy = ay + u * ey - y;
        const d = qx * qx + qy * qy;
        if (d <= bestD) {
          bestD = d;
          best = s;
          bu = u;
        }
      }
    });
    if (best < 0) return -1;
    const ax = this.vx[this.sa[best]!]!, ay = this.vy[this.sa[best]!]!;
    return this.junction({ seg: best, t: 0, u: bu, x: ax + bu * (this.vx[this.sb[best]!]! - ax), y: ay + bu * (this.vy[this.sb[best]!]! - ay) });
  }

  /**
   * Insert a closed outline (a bullet hole) that cuts through existing cracks. Returns the loop's
   * vertices in order (including the junctions where it crossed older cracks).
   */
  loop(points: ArrayLike<number>, kind: number): number[] {
    const n = points.length >> 1;
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(this.vertex(points[2 * i]!, points[2 * i + 1]!));
    const chain: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = ids[i]!, b = ids[(i + 1) % n]!;
      if (a === b) continue;
      const hits = this.query(this.vx[a]!, this.vy[a]!, this.vx[b]!, this.vy[b]!, a, b, true).map((h) => ({ ...h }));
      let cur = a;
      chain.push(a);
      for (const hit of hits) {
        if (!this.live[hit.seg]) {
          // The segment was split by an earlier crossing on this same edge; find the live piece.
          const j = this.pointVertex(hit.x, hit.y, 1e-7);
          if (j < 0 || j === cur) continue;
          this.segment(cur, j, kind);
          cur = j;
          chain.push(j);
          continue;
        }
        const j = this.junction(hit);
        if (j === cur || j === b) continue;
        this.segment(cur, j, kind);
        cur = j;
        chain.push(j);
      }
      this.segment(cur, b, kind);
    }
    return chain;
  }

  // ─── Faces ───────────────────────────────────────────────────────────────────────────────

  /**
   * The pieces: faces of the live graph. Dangling crack tips are pruned first (they do not separate
   * anything); islands (crack networks that touch nothing else, e.g. a bullet hole with its spider
   * web) become holes of the face that contains them. Face areas tile the pane exactly.
   */
  faces(): Face[] {
    const nS = this.sa.length, nV = this.vx.length;
    const keep = new Uint8Array(nS);
    const deg = new Int32Array(nV);
    for (let s = 0; s < nS; s++) {
      if (!this.live[s]) continue;
      keep[s] = 1;
      deg[this.sa[s]!]++;
      deg[this.sb[s]!]++;
    }
    // Incidence lists (CSR) over the live segments.
    const off = new Int32Array(nV + 1);
    for (let v = 0; v < nV; v++) off[v + 1] = off[v]! + deg[v]!;
    const inc = new Int32Array(off[nV]!);
    const fill = off.slice(0, nV);
    for (let s = 0; s < nS; s++) {
      if (!keep[s]) continue;
      inc[fill[this.sa[s]!]!++] = s;
      inc[fill[this.sb[s]!]!++] = s;
    }
    // Prune dangling cracks: repeatedly drop segments ending in a degree-1 vertex.
    const stack: number[] = [];
    for (let v = 0; v < nV; v++) if (deg[v] === 1) stack.push(v);
    while (stack.length) {
      const v = stack.pop()!;
      if (deg[v] !== 1) continue;
      for (let k = off[v]!; k < off[v + 1]!; k++) {
        const s = inc[k]!;
        if (!keep[s]) continue;
        keep[s] = 0;
        deg[v]--;
        const o = this.sa[s] === v ? this.sb[s]! : this.sa[s]!;
        deg[o]--;
        if (deg[o] === 1) stack.push(o);
        break;
      }
    }
    // Outgoing half-edges per vertex sorted by angle. Half-edge 2s runs sa→sb, 2s+1 runs sb→sa.
    const hoff = new Int32Array(nV + 1);
    for (let v = 0; v < nV; v++) hoff[v + 1] = hoff[v]! + deg[v]!;
    const out = new Int32Array(hoff[nV]!);
    const hfill = hoff.slice(0, nV);
    for (let s = 0; s < nS; s++) {
      if (!keep[s]) continue;
      out[hfill[this.sa[s]!]!++] = 2 * s;
      out[hfill[this.sb[s]!]!++] = 2 * s + 1;
    }
    const ang = new Float64Array(2 * nS);
    const origin = (he: number) => (he & 1 ? this.sb[he >> 1]! : this.sa[he >> 1]!);
    const target = (he: number) => (he & 1 ? this.sa[he >> 1]! : this.sb[he >> 1]!);
    const pos = new Int32Array(2 * nS);
    for (let v = 0; v < nV; v++) {
      const a = hoff[v]!, b = hoff[v + 1]!;
      if (b - a < 2) {
        if (b > a) pos[out[a]!] = 0;
        continue;
      }
      for (let k = a; k < b; k++) {
        const he = out[k]!;
        const t = target(he);
        ang[he] = Math.atan2(this.vy[t]! - this.vy[v]!, this.vx[t]! - this.vx[v]!);
      }
      // In-place insertion sort by angle (degrees are small: 2–4, rarely more).
      for (let k = a + 1; k < b; k++) {
        const he = out[k]!, an = ang[he]!;
        let m = k - 1;
        while (m >= a && ang[out[m]!]! > an) {
          out[m + 1] = out[m]!;
          m--;
        }
        out[m + 1] = he;
      }
      for (let k = a; k < b; k++) pos[out[k]!] = k - a;
    }
    // Next half-edge around the face to the left: at the target, the outgoing edge just clockwise
    // of the twin.
    const next = (he: number) => {
      const v = target(he);
      const twin = he ^ 1;
      const n = hoff[v + 1]! - hoff[v]!;
      const p = pos[twin]!;
      return out[hoff[v]! + ((p - 1 + n) % n)]!;
    };
    // Components (union–find over kept segments) to recognise islands.
    const parent = new Int32Array(nV);
    for (let v = 0; v < nV; v++) parent[v] = v;
    const find = (v: number): number => {
      while (parent[v] !== v) {
        parent[v] = parent[parent[v]!]!;
        v = parent[v]!;
      }
      return v;
    };
    for (let s = 0; s < nS; s++) if (keep[s]) parent[find(this.sa[s]!)] = find(this.sb[s]!);
    const mainComp = find(0);

    interface Cycle { poly: Poly; area: number; comp: number; edge: [number, number, number, number]; he: number[] }
    const cycles: Cycle[] = [];
    const seen = new Uint8Array(2 * nS);
    // Cycle each half-edge belongs to (the face on its left).
    const cycOf = new Int32Array(2 * nS).fill(-1);
    const hw = this.w / 2, hh = this.h / 2;
    for (let s = 0; s < nS; s++) {
      if (!keep[s]) continue;
      for (let d = 0; d < 2; d++) {
        const start = 2 * s + d;
        if (seen[start]) continue;
        const poly: Poly = [];
        const edge: [number, number, number, number] = [0, 0, 0, 0];
        const hes: number[] = [];
        let he = start;
        let guard = 0;
        while (!seen[he] && guard++ < 4 * nS + 8) {
          seen[he] = 1;
          cycOf[he] = cycles.length;
          hes.push(he);
          const o = origin(he), t = target(he);
          poly.push(this.vx[o]!, this.vy[o]!);
          const seg = he >> 1;
          if (this.kind[seg] === SEG_BOUNDARY) {
            const len = Math.hypot(this.vx[t]! - this.vx[o]!, this.vy[t]! - this.vy[o]!);
            const my = 0.5 * (this.vy[o]! + this.vy[t]!), mx = 0.5 * (this.vx[o]! + this.vx[t]!);
            if (Math.abs(my + hh) < 1e-9) edge[0] += len;
            else if (Math.abs(mx - hw) < 1e-9) edge[1] += len;
            else if (Math.abs(my - hh) < 1e-9) edge[2] += len;
            else edge[3] += len;
          }
          he = next(he);
        }
        cycles.push({ poly, area: polyArea(poly), comp: find(this.sa[s]!), edge, he: hes });
      }
    }
    type Built = Face & { comp: number; cycles: number[] };
    const faces: Built[] = [];
    const islands: number[] = [];
    // Face index of every cycle (−1: the pane outline seen from outside, or degenerate).
    const faceOf = new Int32Array(cycles.length).fill(-1);
    for (let c = 0; c < cycles.length; c++) {
      const cy = cycles[c]!;
      if (Math.abs(cy.area) < 1e-12) continue;
      if (cy.area > 0) {
        faceOf[c] = faces.length;
        faces.push({ outer: cy.poly, holes: [], area: cy.area, edge: cy.edge, sample: [0, 0], bounds: polyBounds(cy.poly), links: EMPTY_LINKS, comp: cy.comp, cycles: [c] });
      } else if (cy.comp !== mainComp) islands.push(c);
    }
    // Each island outline is a hole in the smallest face of another component that contains it:
    // faces are tried in ascending order of outline area and the first that contains it wins. (Was
    // a scan of every face per island that recomputed both polygon areas per candidate: a pane
    // peppered by blast fragments — hundreds of hole islands — then took seconds per blast.)
    const byArea = faces.map((_, k) => k);
    const outerArea = faces.map((f) => f.area);
    if (islands.length) byArea.sort((a, b) => outerArea[a]! - outerArea[b]!);
    for (const c of islands) {
      const isl = cycles[c]!;
      const x = isl.poly[0]!, y = isl.poly[1]!;
      let best: Built | null = null;
      let bestK = -1;
      for (const k of byArea) {
        const f = faces[k]!;
        if (f.comp === isl.comp) continue;
        const b = f.bounds;
        if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
        if (pointInPoly(f.outer, x, y)) {
          best = f;
          bestK = k;
          break;
        }
      }
      if (best) {
        best.holes.push(isl.poly);
        best.area += isl.area;
        best.cycles.push(c);
        faceOf[c] = bestK;
      }
    }
    for (const f of faces) {
      f.sample = interiorPoint(f.outer, f.holes);
      // Every boundary half-edge has this face on its left: the outward normal is its right-hand
      // normal, and the face across it owns the twin half-edge.
      const links: number[] = [];
      for (const c of f.cycles) {
        for (const he of cycles[c]!.he) {
          const o = origin(he), t = target(he);
          const dx = this.vx[t]! - this.vx[o]!, dy = this.vy[t]! - this.vy[o]!;
          const len = Math.sqrt(dx * dx + dy * dy);
          const tw = cycOf[he ^ 1]!;
          links.push(this.kind[he >> 1] === SEG_BOUNDARY || tw < 0 ? -1 : faceOf[tw]!, len, len > 0 ? dy / len : 0, len > 0 ? -dx / len : 0);
        }
      }
      f.links = links;
    }
    return faces;
  }
}
