/**
 * Small 2D polygon toolkit for pane-space geometry (metres, pane-local x right / y up). Polygons are
 * flat coordinate arrays [x0, y0, x1, y1, …] without a repeated closing vertex; outer boundaries
 * are counter-clockwise (positive area), holes clockwise.
 */

export type Poly = number[];

/** Signed shoelace area: positive for counter-clockwise polygons. */
export function polyArea(p: ArrayLike<number>): number {
  const n = p.length >> 1;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += p[2 * j]! * p[2 * i + 1]! - p[2 * i]! * p[2 * j + 1]!;
  return 0.5 * a;
}

/** Area centroid (falls back to the vertex mean for degenerate polygons). */
export function polyCentroid(p: ArrayLike<number>, out: [number, number] = [0, 0]): [number, number] {
  const n = p.length >> 1;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xj = p[2 * j]!, yj = p[2 * j + 1]!, xi = p[2 * i]!, yi = p[2 * i + 1]!;
    const c = xj * yi - xi * yj;
    a += c;
    cx += (xj + xi) * c;
    cy += (yj + yi) * c;
  }
  if (Math.abs(a) < 1e-14) {
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) {
      sx += p[2 * i]!;
      sy += p[2 * i + 1]!;
    }
    out[0] = sx / Math.max(n, 1);
    out[1] = sy / Math.max(n, 1);
    return out;
  }
  out[0] = cx / (3 * a);
  out[1] = cy / (3 * a);
  return out;
}

/** Even–odd point-in-polygon test. */
export function pointInPoly(p: ArrayLike<number>, x: number, y: number): boolean {
  const n = p.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[2 * i]!, yi = p[2 * i + 1]!, xj = p[2 * j]!, yj = p[2 * j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polyBounds(p: ArrayLike<number>, out: [number, number, number, number] = [0, 0, 0, 0]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i]!, y = p[i + 1]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  out[0] = x0; out[1] = y0; out[2] = x1; out[3] = y1;
  return out;
}

/** Squared distance from (x, y) to segment a→b. */
export function segDist2(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - x, ey = ay + t * dy - y;
  return ex * ex + ey * ey;
}

/** Distance from (x, y) to the polygon outline. */
export function polyEdgeDist(p: ArrayLike<number>, x: number, y: number): number {
  const n = p.length >> 1;
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const d = segDist2(x, y, p[2 * j]!, p[2 * j + 1]!, p[2 * i]!, p[2 * i + 1]!);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Keep the part of `p` with nx·x + ny·y ≤ d (Sutherland–Hodgman against one half-plane). */
export function clipHalfPlane(p: ArrayLike<number>, nx: number, ny: number, d: number): Poly {
  const out: Poly = [];
  const n = p.length >> 1;
  if (n === 0) return out;
  let px = p[2 * (n - 1)]!, py = p[2 * (n - 1) + 1]!;
  let pd = nx * px + ny * py - d;
  for (let i = 0; i < n; i++) {
    const cx = p[2 * i]!, cy = p[2 * i + 1]!;
    const cd = nx * cx + ny * cy - d;
    if (cd <= 0) {
      if (pd > 0) {
        const t = pd / (pd - cd);
        out.push(px + t * (cx - px), py + t * (cy - py));
      }
      out.push(cx, cy);
    } else if (pd <= 0) {
      const t = pd / (pd - cd);
      out.push(px + t * (cx - px), py + t * (cy - py));
    }
    px = cx; py = cy; pd = cd;
  }
  return out;
}

/** Convex hull (Andrew's monotone chain), counter-clockwise. */
export function convexHull(points: ArrayLike<number>): Poly {
  const n = points.length >> 1;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  idx.sort((a, b) => points[2 * a]! - points[2 * b]! || points[2 * a + 1]! - points[2 * b + 1]!);
  const cross = (o: number, a: number, b: number) =>
    (points[2 * a]! - points[2 * o]!) * (points[2 * b + 1]! - points[2 * o + 1]!) -
    (points[2 * a + 1]! - points[2 * o + 1]!) * (points[2 * b]! - points[2 * o]!);
  const lower: number[] = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper: number[] = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, i) <= 0) upper.pop();
    upper.push(i);
  }
  lower.pop();
  upper.pop();
  const out: Poly = [];
  for (const i of lower.concat(upper)) out.push(points[2 * i]!, points[2 * i + 1]!);
  return out;
}

/**
 * A convex polygon (counter-clockwise) with fewer, well separated corners: corners closer than
 * `minEdge` to their predecessor are merged, then the corner whose removal loses the least area
 * (the smallest triangle with its neighbours) is dropped until at most `maxVerts` remain. The
 * result stays convex and inside the original. For collision hulls: crack-traced outlines carry
 * dozens of nearly collinear corners, and a 3D hull of their thin extrusion is nearly coplanar
 * everywhere — the degenerate input quickhull is slowest and least robust on.
 */
export function simplifyConvex(hull: ArrayLike<number>, minEdge: number, maxVerts: number): Poly {
  const xs: number[] = [], ys: number[] = [];
  const n = hull.length >> 1;
  for (let i = 0; i < n; i++) {
    const x = hull[2 * i]!, y = hull[2 * i + 1]!;
    if (xs.length && Math.hypot(x - xs[xs.length - 1]!, y - ys[ys.length - 1]!) < minEdge) continue;
    xs.push(x);
    ys.push(y);
  }
  while (xs.length > 3 && Math.hypot(xs[0]! - xs[xs.length - 1]!, ys[0]! - ys[ys.length - 1]!) < minEdge) {
    xs.pop();
    ys.pop();
  }
  const tri = (i: number) => {
    const m = xs.length, a = (i - 1 + m) % m, b = (i + 1) % m;
    return Math.abs((xs[i]! - xs[a]!) * (ys[b]! - ys[a]!) - (ys[i]! - ys[a]!) * (xs[b]! - xs[a]!));
  };
  while (xs.length > Math.max(3, maxVerts)) {
    let best = 0, bestA = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const a = tri(i);
      if (a < bestA) {
        bestA = a;
        best = i;
      }
    }
    xs.splice(best, 1);
    ys.splice(best, 1);
  }
  const out: Poly = [];
  for (let i = 0; i < xs.length; i++) out.push(xs[i]!, ys[i]!);
  return out;
}

/**
 * A point strictly inside a polygon with holes: the middle of the widest interior interval along
 * a few horizontal scan lines. Robust for concave and slit (weakly simple) polygons where the
 * centroid may fall outside.
 */
export function interiorPoint(outer: ArrayLike<number>, holes: readonly ArrayLike<number>[] = []): [number, number] {
  const b = polyBounds(outer);
  let bestW = -1, bx = 0.5 * (b[0] + b[2]), by = 0.5 * (b[1] + b[3]);
  const xs: number[] = [];
  const collect = (p: ArrayLike<number>, y: number) => {
    const n = p.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = p[2 * i + 1]!, yj = p[2 * j + 1]!;
      if (yi > y !== yj > y) {
        const xi = p[2 * i]!, xj = p[2 * j]!;
        xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
      }
    }
  };
  for (const f of [0.5, 0.31, 0.69, 0.17, 0.83, 0.43, 0.57]) {
    const y = b[1] + f * (b[3] - b[1]);
    xs.length = 0;
    collect(outer, y);
    for (const h of holes) collect(h, y);
    xs.sort((a, c) => a - c);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const w = xs[k + 1]! - xs[k]!;
      if (w > bestW) {
        bestW = w;
        bx = 0.5 * (xs[k]! + xs[k + 1]!);
        by = y;
      }
    }
    if (bestW > 0.25 * (b[2] - b[0])) break;
  }
  return [bx, by];
}
