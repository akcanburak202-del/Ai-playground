import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Noise3 } from '../core/noise.ts';
import { Rng } from '../core/rng.ts';

/**
 * Unit-height tree geometry for the distant planting (instanced by the decor): Mediterranean
 * species that read at 80–300 m in low sun — Italian cypress, Italian stone pine, olive / holm
 * oak. A crown is built from many noisy foliage clumps rather than one smooth solid: it is the
 * broken silhouette and the light-to-dark modelling inside the crown that make a tree read as a
 * tree and not a lollipop. Each vertex carries its own colour (per-clump hue, lighter tops, darker
 * undersides and core); normals are bent towards the crown's own radial direction so the crown
 * shades as one mass with ragged edges, the way foliage does in raking light.
 *
 * Pure geometry: no DOM, no renderer.
 */

export const TREE_KINDS = ['cypress', 'pine', 'olive'] as const;
export type TreeKind = (typeof TREE_KINDS)[number];

interface Clump {
  x: number; y: number; z: number;
  /** Half extents of the clump ellipsoid */
  rx: number; ry: number; rz: number;
  /** Linear RGB of the foliage in this clump */
  color: THREE.Color;
  /** Icosphere subdivision (1: 80 faces, 0: 20) */
  detail: number;
}

const _v = new THREE.Vector3();
const _r = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * Merge foliage clumps and woody parts into one geometry with vertex colours. `centre` and
 * `axisScale` define the crown's own ellipsoid, used to bend the normals outwards.
 */
function assemble(clumps: Clump[], wood: THREE.BufferGeometry[], centre: THREE.Vector3, axisScale: THREE.Vector3, seed: number): THREE.BufferGeometry {
  const n = new Noise3(seed);
  const parts: THREE.BufferGeometry[] = [];
  const bark = new THREE.Color(0x4a3b2e);
  for (const w of wood) {
    const g = w.index ? w.toNonIndexed() : w;
    g.deleteAttribute('uv');
    g.computeVertexNormals();
    const col = new Float32Array(g.getAttribute('position').count * 3);
    for (let i = 0; i < col.length; i += 3) bark.toArray(col, i);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
    if (g !== w) w.dispose();
  }
  clumps.forEach((c, k) => {
    const ico = new THREE.IcosahedronGeometry(1, c.detail);
    ico.deleteAttribute('uv');
    ico.deleteAttribute('normal');
    const g = mergeVertices(ico, 1e-5);
    ico.dispose();
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i);
      // Ragged foliage surface: two octaves of displacement at leaf-mass scale.
      const d = 1 + 0.32 * n.fbm(_v.x * 1.9 + k * 7.3, _v.y * 1.9 + k * 1.7, _v.z * 1.9, 2);
      const up = _v.y;
      pos.setXYZ(i, c.x + _v.x * c.rx * d, c.y + _v.y * c.ry * d, c.z + _v.z * c.rz * d);
      // Self-shadowing inside the crown: lighter tops, darker undersides and hollows.
      const s = (0.62 + 0.38 * (0.5 + 0.5 * up)) * (0.8 + 0.25 * (d - 0.68));
      col[3 * i] = c.color.r * s;
      col[3 * i + 1] = c.color.g * s;
      col[3 * i + 2] = c.color.b * s;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    // Bend normals towards the crown's radial direction (volume shading, see header).
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i);
      _r.subVectors(_v, centre).divide(axisScale).normalize();
      _n.fromBufferAttribute(nor, i).multiplyScalar(0.45).addScaledVector(_r, 0.55).normalize();
      nor.setXYZ(i, _n.x, _n.y, _n.z);
    }
    const flat = g.toNonIndexed();
    g.dispose();
    parts.push(flat);
  });
  const merged = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return merged;
}

/** A tapered cylinder between two points (trunk, branch). */
function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, sides = 6): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, sides, 1, true);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), _v.subVectors(b, a).normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}

function srgb(hex: number, jitter: number, rng: Rng): THREE.Color {
  const c = new THREE.Color(hex);
  const k = 1 + rng.range(-jitter, jitter);
  const hueShift = rng.range(-0.012, 0.012);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return c.setHSL(hsl.h + hueShift, hsl.s, Math.min(1, hsl.l * k));
}

/**
 * Italian cypress (Cupressus sempervirens 'Stricta'): a dense, very dark flame 1/7 as wide as it
 * is tall, foliage almost to the ground, slightly irregular outline from its fastigiate branches.
 */
function cypress(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const clumps: Clump[] = [];
  const N = 14;
  const lean = rng.range(-0.012, 0.012), leanZ = rng.range(-0.012, 0.012);
  for (let i = 0; i < N; i++) {
    const t = 0.05 + (i / (N - 1)) * 0.9;
    // Widest a quarter of the way up, then an ogival taper to the point.
    const R = t < 0.25 ? 0.062 + 0.1 * t : 0.087 * Math.pow((1 - t) / 0.75, 0.75);
    const cx = lean * t + rng.range(-0.18, 0.18) * R, cz = leanZ * t + rng.range(-0.18, 0.18) * R;
    clumps.push({ x: cx, y: t, z: cz, rx: R * 1.05, ry: Math.max(0.035, R * 1.7), rz: R * 1.05, color: srgb(0x223019, 0.12, rng), detail: 1 });
    // Branch tips standing out of the column break the outline.
    const sides = t > 0.9 ? 0 : 2;
    for (let s = 0; s < sides; s++) {
      const a = rng.range(0, Math.PI * 2);
      clumps.push({
        x: cx + Math.cos(a) * R * 0.75, y: t + rng.range(-0.02, 0.02), z: cz + Math.sin(a) * R * 0.75,
        rx: R * 0.5, ry: R * 0.9, rz: R * 0.5, color: srgb(0x2a3a1f, 0.15, rng), detail: 0,
      });
    }
  }
  const trunk = limb(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.1, 0), 0.012, 0.009);
  return assemble(clumps, [trunk], new THREE.Vector3(0, 0.4, 0), new THREE.Vector3(0.09, 0.5, 0.09), seed);
}

/**
 * Italian stone pine (Pinus pinea): a bare, often leaning trunk forking into a few limbs under a
 * broad, flat-topped umbrella of foliage masses ~0.9× the tree's height across.
 */
function stonePine(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const clumps: Clump[] = [];
  const lean = new THREE.Vector3(rng.range(-0.08, 0.08), 0, rng.range(-0.08, 0.08));
  const fork = new THREE.Vector3(lean.x, 0.55, lean.z);
  const wood = [limb(new THREE.Vector3(0, 0, 0), fork, 0.026, 0.018, 7)];
  const cy = 0.8, spread = 0.4;
  const ctr = new THREE.Vector3(lean.x * 1.2, cy, lean.z * 1.2);
  // Limbs from the fork to the crown's underside.
  const limbs = rng.int(3, 5);
  for (let i = 0; i < limbs; i++) {
    const a = (i / limbs) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const r = rng.range(0.14, 0.26);
    const tip = new THREE.Vector3(ctr.x + Math.cos(a) * r, 0.72 + rng.range(-0.02, 0.03), ctr.z + Math.sin(a) * r);
    wood.push(limb(fork, tip, 0.012, 0.005, 5));
  }
  // The umbrella: a centre mass and two rings, domed, flattened, irregular at the rim.
  const rings: [number, number, number, number][] = [[0, 1, 0.13, 0.84], [0.17, 6, 0.12, 0.8], [0.31, 10, 0.1, 0.76]];
  for (const [rad, count, size, y] of rings) {
    const off = rng.range(0, Math.PI * 2);
    for (let i = 0; i < count; i++) {
      const a = off + (i / count) * Math.PI * 2 + rng.range(-0.25, 0.25);
      const rr = rad * rng.range(0.85, 1.15) * (spread / 0.4);
      const s = size * rng.range(0.8, 1.2);
      clumps.push({
        x: ctr.x + Math.cos(a) * rr, y: y + rng.range(-0.02, 0.02), z: ctr.z + Math.sin(a) * rr,
        rx: s, ry: s * rng.range(0.42, 0.55), rz: s, color: srgb(rad < 0.2 ? 0x34431f : 0x3b4a24, 0.14, rng), detail: 1,
      });
    }
  }
  return assemble(clumps, wood, ctr, new THREE.Vector3(0.4, 0.12, 0.4), seed);
}

/** Olive / holm oak: a short trunk and a rounded, lumpy, grey-green crown. */
function olive(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const clumps: Clump[] = [];
  const top = new THREE.Vector3(rng.range(-0.04, 0.04), 0.38, rng.range(-0.04, 0.04));
  const wood = [limb(new THREE.Vector3(0, 0, 0), top, 0.04, 0.028, 7)];
  const ctr = new THREE.Vector3(top.x, 0.66, top.z);
  for (let i = 0; i < 11; i++) {
    const a = rng.range(0, Math.PI * 2), e = rng.range(-0.3, 1);
    const rr = rng.range(0.12, 0.24);
    const s = rng.range(0.12, 0.19);
    clumps.push({
      x: ctr.x + Math.cos(a) * rr * Math.cos(e), y: ctr.y + rr * Math.sin(e) * 0.8, z: ctr.z + Math.sin(a) * rr * Math.cos(e),
      rx: s, ry: s * 0.82, rz: s, color: srgb(0x4d5638, 0.14, rng), detail: 1,
    });
  }
  return assemble(clumps, wood, ctr, new THREE.Vector3(0.3, 0.25, 0.3), seed);
}

/** Two variants of each kind, so neighbouring trees do not repeat. */
export function treeGeometry(kind: TreeKind, variant: number): THREE.BufferGeometry {
  const seed = 101 + variant * 977 + TREE_KINDS.indexOf(kind) * 31;
  return kind === 'cypress' ? cypress(seed) : kind === 'pine' ? stonePine(seed) : olive(seed);
}

/** Typical heights, m (min, max): cypress 12–18, stone pine 10–15, olive / holm oak 5–8. */
export const TREE_HEIGHT: Record<TreeKind, [number, number]> = { cypress: [12, 18], pine: [10, 15], olive: [5, 8] };
