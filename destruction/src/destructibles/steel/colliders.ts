import type RAPIER from '@dimforge/rapier3d-compat';

/**
 * Defensive collider construction. rapier.js computes a convex hull when the collider is created
 * (not in `ColliderDesc.convexHull`, which always returns a desc), so a flat, collinear or tiny
 * point set — a sliver of torn sheet, a plate piece whose particles lie in one line — throws in
 * `createCollider` in the middle of a step. Point sets are therefore checked first by their
 * principal extents (PCA of the covariance); anything thinner than `minThickness` in some
 * direction becomes an oriented box that bounds the points (with at least that thickness).
 */

export interface PointExtents {
  /** Centre of the oriented bounding box */
  center: [number, number, number];
  /** Unit principal axes (columns: axis k = [ax[3k], ax[3k+1], ax[3k+2]]), largest spread first */
  axes: Float64Array;
  /** Half extents along the axes */
  half: [number, number, number];
}

/** Principal axes (Jacobi eigen-decomposition of the 3 × 3 covariance) and the OBB along them. */
export function pointExtents(pts: ArrayLike<number>): PointExtents | null {
  const n = Math.floor(pts.length / 3);
  if (n < 1) return null;
  let cx = 0, cy = 0, cz = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[3 * i]!, y = pts[3 * i + 1]!, z = pts[3 * i + 2]!;
    if (!Number.isFinite(x + y + z)) continue;
    cx += x;
    cy += y;
    cz += z;
    cnt++;
  }
  if (!cnt) return null;
  cx /= cnt;
  cy /= cnt;
  cz /= cnt;
  // Covariance (symmetric), row-major a[3r + c].
  const a = new Float64Array(9);
  for (let i = 0; i < n; i++) {
    const x = pts[3 * i]! - cx, y = pts[3 * i + 1]! - cy, z = pts[3 * i + 2]! - cz;
    if (!Number.isFinite(x + y + z)) continue;
    a[0] += x * x; a[1] += x * y; a[2] += x * z;
    a[4] += y * y; a[5] += y * z; a[8] += z * z;
  }
  a[3] = a[1]!; a[6] = a[2]!; a[7] = a[5]!;
  // Cyclic Jacobi rotations: V accumulates the eigenvectors (columns).
  const v = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  for (let sweep = 0; sweep < 12; sweep++) {
    const off = Math.abs(a[1]!) + Math.abs(a[2]!) + Math.abs(a[5]!);
    if (off < 1e-18 * (Math.abs(a[0]!) + Math.abs(a[4]!) + Math.abs(a[8]!) + 1e-30)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = a[3 * p + q]!;
      if (Math.abs(apq) < 1e-30) continue;
      const theta = (a[3 * q + q]! - a[3 * p + p]!) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[3 * k + p]!, akq = a[3 * k + q]!;
        a[3 * k + p] = c * akp - s * akq;
        a[3 * k + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[3 * p + k]!, aqk = a[3 * q + k]!;
        a[3 * p + k] = c * apk - s * aqk;
        a[3 * q + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[3 * k + p]!, vkq = v[3 * k + q]!;
        v[3 * k + p] = c * vkp - s * vkq;
        v[3 * k + q] = s * vkp + c * vkq;
      }
    }
  }
  // Order by eigenvalue (largest spread first); axis k = column k of v.
  const order = [0, 1, 2].sort((i, j) => a[4 * j]! - a[4 * i]!);
  const axes = new Float64Array(9);
  for (let k = 0; k < 3; k++) {
    const col = order[k]!;
    let x = v[col]!, y = v[3 + col]!, z = v[6 + col]!;
    const l = Math.hypot(x, y, z) || 1;
    x /= l;
    y /= l;
    z /= l;
    axes[3 * k] = x;
    axes[3 * k + 1] = y;
    axes[3 * k + 2] = z;
  }
  // Right-handed frame (a rotation, not a reflection).
  const [x0, y0, z0, x1, y1, z1] = axes;
  axes[6] = y0! * z1! - z0! * y1!;
  axes[7] = z0! * x1! - x0! * z1!;
  axes[8] = x0! * y1! - y0! * x1!;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const x = pts[3 * i]! - cx, y = pts[3 * i + 1]! - cy, z = pts[3 * i + 2]! - cz;
    if (!Number.isFinite(x + y + z)) continue;
    for (let k = 0; k < 3; k++) {
      const d = x * axes[3 * k]! + y * axes[3 * k + 1]! + z * axes[3 * k + 2]!;
      if (d < lo[k]!) lo[k] = d;
      if (d > hi[k]!) hi[k] = d;
    }
  }
  const center: [number, number, number] = [cx, cy, cz];
  const half: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const mid = 0.5 * (lo[k]! + hi[k]!);
    half[k] = 0.5 * (hi[k]! - lo[k]!);
    center[0] += mid * axes[3 * k]!;
    center[1] += mid * axes[3 * k + 1]!;
    center[2] += mid * axes[3 * k + 2]!;
  }
  return { center, axes, half };
}

/** Quaternion (x, y, z, w) of the rotation whose columns are the given axes. */
function axesQuaternion(ax: Float64Array): { x: number; y: number; z: number; w: number } {
  // Rotation matrix R with columns = axes: R[r][c] = ax[3c + r].
  const m00 = ax[0]!, m10 = ax[1]!, m20 = ax[2]!, m01 = ax[3]!, m11 = ax[4]!, m21 = ax[5]!, m02 = ax[6]!, m12 = ax[7]!, m22 = ax[8]!;
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  return { x: x / l, y: y / l, z: z / l, w: w / l };
}

/**
 * A collider for a point cloud (body-local coordinates): its convex hull when the cloud has real
 * volume, otherwise an oriented box around it at least `minThickness` thick in every direction.
 * Returns null only when there are no finite points at all.
 */
export function safeHullDesc(R: typeof RAPIER, pts: ArrayLike<number>, minThickness = 0.004): RAPIER.ColliderDesc | null {
  const e = pointExtents(pts);
  if (!e) return null;
  const n = Math.floor(pts.length / 3);
  const [h0, h1, h2] = e.half;
  // Thin in some direction relative to its size (or absolutely), or too few points for a solid.
  const flat = n < 4 || h2 < 0.5 * minThickness || h2 < 1e-3 * h0 || h1 < 0.5 * minThickness;
  if (!flat) {
    const desc = R.ColliderDesc.convexHull(pts instanceof Float32Array ? pts : Float32Array.from(pts));
    if (desc) return desc;
  }
  const m = 0.5 * minThickness;
  const q = axesQuaternion(e.axes);
  return R.ColliderDesc.cuboid(Math.max(h0, m), Math.max(h1, m), Math.max(h2, m))
    .setTranslation(e.center[0], e.center[1], e.center[2])
    .setRotation(q);
}
