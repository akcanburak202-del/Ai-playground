import { CrackGraph, SEG_ARC, SEG_BRANCH, SEG_HOLE, SEG_RADIAL } from './crackGraph.ts';
import type { StarSpec } from './model.ts';
import type { Poly } from './polygon.ts';

/**
 * Grows crack patterns into a CrackGraph: the ragged outline of a bullet hole, radial cracks that
 * wander, bifurcate and stop on free surfaces, and concentric arcs between neighbouring radials.
 */

export interface StarResult {
  /** Outline of the through-hole (empty for blast patterns), flat CCW */
  hole: Poly;
  /** Vertex chains of the radial cracks (primary and branches) */
  chains: number[][];
}

interface Walker {
  v: number;
  dir: number;
  left: number;
  kind: number;
  depth: number;
  chain: number[];
  /** Radial distance of every chain vertex from the star centre */
  dist: number[];
}

const TAU = Math.PI * 2;

function wrap(a: number): number {
  a %= TAU;
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}

/** Standard normal from a uniform source (Box–Muller). */
function gauss(rnd: () => number): number {
  let u = rnd();
  if (u < 1e-12) u = 1e-12;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rnd());
}

/**
 * Irregular hole outline around (cx, cy): radius r with ±25 % lobes, kept 1 mm inside the pane so it
 * never runs along the pane edge.
 */
export function holeOutline(g: CrackGraph, cx: number, cy: number, r: number, rnd: () => number): Poly {
  const n = Math.max(8, Math.min(22, Math.round(10 + r * 400)));
  const ph = rnd() * TAU, a1 = 0.12 + 0.1 * rnd(), a2 = 0.08 * rnd();
  const out: Poly = [];
  const mx = g.w / 2 - 1e-3, my = g.h / 2 - 1e-3;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const k = 1 + a1 * Math.sin(3 * a + ph) + a2 * Math.sin(5 * a + 2 * ph) + 0.12 * (rnd() - 0.5);
    const x = Math.min(mx, Math.max(-mx, cx + r * k * Math.cos(a)));
    const y = Math.min(my, Math.max(-my, cy + r * k * Math.sin(a)));
    out.push(x, y);
  }
  return out;
}

/**
 * Grow a crack star centred on (cx, cy). With holeR > 0 the hole outline is cut first and the
 * radials start on it; otherwise they all start at the centre (blast origin). `blocked(x, y)` says
 * whether glass is already gone there (released pieces): cracks are not started into such regions.
 */
export function growStar(
  g: CrackGraph, cx: number, cy: number, holeR: number, spec: StarSpec, rnd: () => number,
  blocked: (x: number, y: number) => boolean = () => false,
): StarResult {
  const hole = holeR > 0 ? holeOutline(g, cx, cy, holeR, rnd) : [];
  let ring: number[] = [];
  let centre = -1;
  if (hole.length) ring = g.loop(hole, SEG_HOLE);
  else {
    centre = g.pointVertex(cx, cy, 2e-4);
    if (centre < 0) centre = g.vertex(cx, cy);
  }
  const theta0 = rnd() * TAU;
  const walkers: Walker[] = [];
  const n = spec.radials;
  for (let i = 0; i < n; i++) {
    const dir = theta0 + (i / n) * TAU + (rnd() - 0.5) * (0.7 * TAU) / n;
    let v = centre;
    if (ring.length) {
      // Start on the hole outline where it faces this direction.
      let best = -1, bestDot = -Infinity;
      for (const r of ring) {
        const d = Math.cos(Math.atan2(g.vy[r]! - cy, g.vx[r]! - cx) - dir);
        if (d > bestDot) {
          bestDot = d;
          best = r;
        }
      }
      v = best;
    }
    const sx = g.vx[v]! + Math.cos(dir) * spec.step * 0.5, sy = g.vy[v]! + Math.sin(dir) * spec.step * 0.5;
    if (!g.inside(sx, sy) || blocked(sx, sy)) continue;
    const L = spec.length * (0.55 + 0.9 * rnd());
    walkers.push({ v, dir, left: L, kind: SEG_RADIAL, depth: 0, chain: [v], dist: [Math.hypot(g.vx[v]! - cx, g.vy[v]! - cy)] });
  }
  const chains: number[][] = [];
  const radials: Walker[] = [];
  for (let k = 0; k < walkers.length; k++) {
    const w = walkers[k]!;
    walk(g, cx, cy, w, spec, rnd, walkers);
    chains.push(w.chain);
    if (w.depth === 0) radials.push(w);
  }
  arcs(g, cx, cy, radials, spec, rnd);
  return { hole, chains };
}

/** Walk one crack outward until its length budget is spent or it meets a free surface. */
function walk(g: CrackGraph, cx: number, cy: number, w: Walker, spec: StarSpec, rnd: () => number, queue: Walker[]): void {
  let travelled = 0;
  const L0 = w.left;
  let guard = 0;
  while (w.left > 1e-4 && guard++ < 400) {
    const step = Math.min(w.left, spec.step * (0.7 + 0.6 * rnd()));
    const x = g.vx[w.v]!, y = g.vy[w.v]!;
    // Radial cracks follow the hoop-stress trajectories of the struck plate: steer back towards
    // the local radial direction, plus a random wander (rough fracture path).
    const radial = Math.atan2(y - cy, x - cx);
    const r = Math.hypot(x - cx, y - cy);
    if (r > 1e-4) w.dir += 0.25 * wrap(radial - w.dir);
    w.dir += gauss(rnd) * spec.wander;
    const tx = x + step * Math.cos(w.dir), ty = y + step * Math.sin(w.dir);
    const res = g.grow(w.v, tx, ty, w.kind);
    if (res.v === w.v) return;
    w.v = res.v;
    w.chain.push(res.v);
    w.dist.push(Math.hypot(g.vx[res.v]! - cx, g.vy[res.v]! - cy));
    travelled += step;
    w.left -= step;
    if (res.blocked) return;
    // Bifurcation: likeliest near the origin where the crack still carries excess energy.
    if (w.depth < 2 && w.left > 3 * spec.step && rnd() < spec.branchProb * Math.exp(-travelled / (0.35 * L0))) {
      const side = rnd() < 0.5 ? -1 : 1;
      const half = spec.branchAngle * (0.7 + 0.6 * rnd());
      queue.push({
        v: w.v, dir: w.dir + side * half, left: w.left * (0.35 + 0.5 * rnd()), kind: SEG_BRANCH, depth: w.depth + 1,
        chain: [w.v], dist: [Math.hypot(g.vx[w.v]! - cx, g.vy[w.v]! - cy)],
      });
      w.dir -= side * half * 0.6;
    }
  }
}

/** Point on a chain at radial distance r from the centre (linear between chain vertices), or null. */
function chainPoint(g: CrackGraph, w: Walker, r: number): [number, number] | null {
  for (let i = 1; i < w.chain.length; i++) {
    const d0 = w.dist[i - 1]!, d1 = w.dist[i]!;
    if (d0 <= r && d1 >= r && d1 > d0) {
      const f = (r - d0) / (d1 - d0);
      const a = w.chain[i - 1]!, b = w.chain[i]!;
      return [g.vx[a]! + f * (g.vx[b]! - g.vx[a]!), g.vy[a]! + f * (g.vy[b]! - g.vy[a]!)];
    }
  }
  return null;
}

/** Concentric arcs between angularly neighbouring radials (the spider web). */
function arcs(g: CrackGraph, cx: number, cy: number, radials: Walker[], spec: StarSpec, rnd: () => number): void {
  if (radials.length < 2 || !spec.rings.length) return;
  const sorted = radials
    .map((w) => ({ w, a: Math.atan2(g.vy[w.chain[Math.min(2, w.chain.length - 1)]!]! - cy, g.vx[w.chain[Math.min(2, w.chain.length - 1)]!]! - cx) }))
    .sort((p, q) => p.a - q.a);
  for (let k = 0; k < spec.rings.length; k++) {
    const r0 = spec.rings[k]!;
    const p = spec.ringProb[k] ?? 0.5;
    for (let i = 0; i < sorted.length; i++) {
      if (rnd() > p) continue;
      const A = sorted[i]!, B = sorted[(i + 1) % sorted.length]!;
      const gap = (((B.a - A.a) % TAU) + TAU) % TAU;
      if (gap > Math.PI * 0.9 || gap < 1e-3) continue;
      const r = r0 * (0.85 + 0.3 * rnd());
      const pa = chainPoint(g, A.w, r), pb = chainPoint(g, B.w, r * (0.9 + 0.2 * rnd()));
      if (!pa || !pb) continue;
      const va = g.pointVertex(pa[0], pa[1], 1e-6);
      if (va < 0) continue;
      const aA = Math.atan2(pa[1] - cy, pa[0] - cx);
      const aB = aA + wrap(Math.atan2(pb[1] - cy, pb[0] - cx) - aA);
      const rA = Math.hypot(pa[0] - cx, pa[1] - cy), rB = Math.hypot(pb[0] - cx, pb[1] - cy);
      const arcLen = Math.abs(aB - aA) * 0.5 * (rA + rB);
      const steps = Math.max(1, Math.round(arcLen / spec.step));
      // Concentric cracks are nearly straight chords that bow slightly towards the centre.
      const bow = 0.06 * (rnd() - 0.3);
      let v = va;
      for (let s = 1; s <= steps; s++) {
        const f = s / steps;
        let tx: number, ty: number;
        if (s === steps) {
          tx = pb[0];
          ty = pb[1];
        } else {
          const a = aA + f * (aB - aA);
          const rr = (rA + f * (rB - rA)) * (1 - bow * Math.sin(Math.PI * f)) + gauss(rnd) * 0.15 * spec.step;
          tx = cx + rr * Math.cos(a);
          ty = cy + rr * Math.sin(a);
        }
        const res = g.grow(v, tx, ty, SEG_ARC);
        if (res.v === v) break;
        v = res.v;
        if (res.blocked) break;
      }
    }
  }
}
