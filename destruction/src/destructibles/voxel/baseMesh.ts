import * as THREE from 'three';
import type { VoxelGrid } from './grid.ts';
import { meshAll } from './mesher.ts';
import { BoxShape, CylinderShape, type ShapeSdf } from './shape.ts';

/**
 * Analytic render mesh of a pristine element: a box is 12 triangles, a (fluted, tapered) cylinder
 * a few thousand with exact profile normals, an SDF shape its full-resolution Surface Nets mesh
 * (built from the same samples the chunks use, so seams match bit for bit).
 */
export function buildBaseGeometry(shape: ShapeSdf, grid: VoxelGrid): THREE.BufferGeometry {
  if (shape instanceof BoxShape) {
    const [hx, hy, hz] = shape.half;
    return new THREE.BoxGeometry(2 * hx, 2 * hy, 2 * hz);
  }
  if (shape instanceof CylinderShape) return cylinderGeometry(shape);
  const m = meshAll(grid, shape);
  const g = new THREE.BufferGeometry();
  if (!m) return g;
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  return g;
}

function cylinderGeometry(c: CylinderShape): THREE.BufferGeometry {
  const seg = c.flutes > 0 ? c.flutes * 10 : 64;
  const hh = c.height / 2;
  const rings = c.taper > 0 ? 2 : 2;
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const e = 1e-4;
  // Side: vertices on the analytic profile, normals from the SDF gradient.
  for (let r = 0; r < rings; r++) {
    const y = -hh + (c.height * r) / (rings - 1);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const rad = radiusAlong(c, a, y);
      const x = rad * ca, z = rad * sa;
      pos.push(x, y, z);
      const yy = Math.max(-hh + e, Math.min(hh - e, y));
      let gx = c.sdf2(x + e, z, yy) - c.sdf2(x - e, z, yy);
      let gz = c.sdf2(x, z + e, yy) - c.sdf2(x, z - e, yy);
      let gy = c.sdf2(x, z, yy + e) - c.sdf2(x, z, yy - e);
      const l = Math.hypot(gx, gy, gz) || 1;
      gx /= l; gy /= l; gz /= l;
      nrm.push(gx, gy, gz);
    }
  }
  const row = seg + 1;
  for (let r = 0; r < rings - 1; r++)
    for (let i = 0; i < seg; i++) {
      const a = r * row + i, b = a + 1, d = a + row, f = d + 1;
      idx.push(a, d, b, b, d, f);
    }
  // Caps: fans with the fluted outline.
  for (const side of [-1, 1]) {
    const y = side * hh;
    const center = pos.length / 3;
    pos.push(0, y, 0);
    nrm.push(0, side, 0);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const rad = radiusAlong(c, a, y);
      pos.push(rad * Math.cos(a), y, rad * Math.sin(a));
      nrm.push(0, side, 0);
    }
    for (let i = 0; i < seg; i++) {
      const a = center + 1 + i, b = a + 1;
      if (side > 0) idx.push(center, b, a);
      else idx.push(center, a, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

/** Radius of the fluted profile at angle a and height y (root of sdf2 along the ray). */
function radiusAlong(c: CylinderShape, a: number, y: number): number {
  const ca = Math.cos(a), sa = Math.sin(a);
  let lo = 0, hi = c.radius * 1.2;
  const yy = Math.max(-c.height / 2 + 1e-6, Math.min(c.height / 2 - 1e-6, y));
  for (let it = 0; it < 30; it++) {
    const m = 0.5 * (lo + hi);
    if (c.sdf2(m * ca, m * sa, yy) < 0) lo = m;
    else hi = m;
  }
  return 0.5 * (lo + hi);
}
