import { CHUNK, CHUNK_MASK, EMPTY, FULL, ISO, MIXED, type VoxelGrid } from './grid.ts';
import { cellMatchesShape, type ShapeSdf } from './shape.ts';

/**
 * Naive Surface Nets (Gibson 1998, "Constrained elastic surface nets"; formulation after
 * M. Lysenko, "Smooth voxel terrain", 2012) over one 16³ chunk.
 *
 * Seam rule: a chunk owns the quads whose *minimum* cell lies inside it, so its mesh spans cell
 * centres [c0 + ½, c0 + N + ½] (in sample units) and meets its neighbours without gaps or overlaps.
 * Normals come from the density gradient (central differences, trilinearly interpolated), except
 * on untouched cells which snap onto the analytic shape.
 *
 * Untouched faces of a box are flat and carry no damage, so the quads on them are merged: each
 * maximal rectangle of such quads in a chunk becomes a fan around its centre through every vertex
 * of its rim (so the rim still meets the neighbouring quads vertex for vertex — no T-junctions,
 * watertight), and the vertices inside it are dropped. A 16 × 16 patch of face costs 64
 * triangles instead of 512; a pristine slab piece a few percent of its Surface Nets count.
 */
export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  /** Continuum damage 0..1 */
  damage: Float32Array;
  /** Depth below the original surface (−sdf of the pristine shape), m */
  depth: Float32Array;
  /** Soot 0..1 */
  soot: Float32Array;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
  indexCount: number;
}

const N = CHUNK;
const P = N + 4; // padded block: samples c0−1 … c0+N+2
const P2 = P * P;
const CELLS = N + 1;
const blockD = new Uint8Array(P * P * P);
const blockM = new Uint8Array(P * P * P);
const blockS = new Uint8Array(P * P * P);
const cellVert = new Int32Array(CELLS * CELLS * CELLS);
const MAXV = CELLS * CELLS * CELLS;
const sPos = new Float32Array(MAXV * 3);
const sNrm = new Float32Array(MAXV * 3);
const sDmg = new Float32Array(MAXV);
const sDep = new Float32Array(MAXV);
const sSoot = new Float32Array(MAXV);
/** Per vertex: untouched box-face vertex, 1 + axis·2 + (outward sign > 0), else 0 */
const sFace = new Uint8Array(MAXV);
const sIdx = new Uint32Array(MAXV * 18);
/** Quads marked for merging, per (axis, cell layer): value 1 + (starts inside) at [a + CELLS·b] */
const faceMasks = new Map<number, Uint8Array>();
const usedV = new Int32Array(MAXV);
/** Fewest quads a merged rectangle must replace (smaller ones stay as they are) */
const MERGE_MIN = 6;
const OFF = new Int32Array(8);
for (let c = 0; c < 8; c++) OFF[c] = (c & 1) + P * ((c >> 1) & 1) + P2 * ((c >> 2) & 1);
// 12 cube edges as corner pairs (corner bit 0 = x, bit 1 = y, bit 2 = z)
const E0 = [0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3];
const E1 = [1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7];
const snapPos = new Float64Array(3);
const snapNrm = new Float64Array(3);

/**
 * Copy samples [c0−1, c0+N+2]³ of chunk (a,b,c) and its neighbours into the padded block, one
 * source chunk at a time. Returns false when the block holds no iso crossing (nothing to mesh).
 */
function gather(g: VoxelGrid, a: number, b: number, c: number): boolean {
  const bi0 = a * N - 1, bj0 = b * N - 1, bk0 = c * N - 1;
  let anyIn = false, anyOut = false;
  // Source chunk range overlapping the block: a−1 … a+1 per axis.
  for (let C = c - 1; C <= c + 1; C++) {
    const kLo = Math.max(bk0, C * N), kHi = Math.min(bk0 + P - 1, C * N + N - 1);
    if (kLo > kHi) continue;
    for (let B = b - 1; B <= b + 1; B++) {
      const jLo = Math.max(bj0, B * N), jHi = Math.min(bj0 + P - 1, B * N + N - 1);
      if (jLo > jHi) continue;
      for (let A = a - 1; A <= a + 1; A++) {
        const iLo = Math.max(bi0, A * N), iHi = Math.min(bi0 + P - 1, A * N + N - 1);
        if (iLo > iHi) continue;
        const outside = A < 0 || B < 0 || C < 0 || A >= g.cx || B >= g.cy || C >= g.cz;
        const ci = outside ? -1 : A + g.cx * (B + g.cy * C);
        const st = outside ? EMPTY : g.state[ci]!;
        if (st !== MIXED) {
          const v = st === FULL ? 255 : 0;
          if (v) anyIn = true;
          else anyOut = true;
          for (let k = kLo; k <= kHi; k++)
            for (let j = jLo; j <= jHi; j++) {
              const p0 = iLo - bi0 + P * (j - bj0 + P * (k - bk0));
              const len = iHi - iLo + 1;
              blockD.fill(v, p0, p0 + len);
              blockM.fill(0, p0, p0 + len);
              blockS.fill(0, p0, p0 + len);
            }
          continue;
        }
        const D = g.dens[ci]!, M = g.dmg[ci]!, S = g.soot[ci]!;
        for (let k = kLo; k <= kHi; k++)
          for (let j = jLo; j <= jHi; j++) {
            const src = ((j & CHUNK_MASK) << 4) | ((k & CHUNK_MASK) << 8);
            const dst = P * (j - bj0 + P * (k - bk0)) - bi0;
            for (let i = iLo; i <= iHi; i++) {
              const li = (i & CHUNK_MASK) | src;
              const v = D[li]!;
              blockD[dst + i] = v;
              blockM[dst + i] = M[li]!;
              blockS[dst + i] = S[li]!;
              if (v >= ISO) anyIn = true;
              else anyOut = true;
            }
          }
      }
    }
  }
  // Samples beyond the grid's sample count inside partial chunks are never written (always 0).
  return anyIn && anyOut;
}

/** Mesh chunk (a,b,c). Returns null when it has no surface. Output arrays are fresh copies. */
export function meshChunk(g: VoxelGrid, shape: ShapeSdf | null, a: number, b: number, c: number): MeshData | null {
  if (!gather(g, a, b, c)) return null;
  const h = g.h;
  const depthAttr = !!shape && shape.type === 'sdf';
  const flatFaces = !!shape && shape.type === 'box';
  const i0 = a * N, j0 = b * N, k0 = c * N;
  let nv = 0;
  // Pass 1: one vertex per surface-crossing cell.
  for (let k = 0; k < CELLS; k++)
    for (let j = 0; j < CELLS; j++)
      for (let i = 0; i < CELLS; i++) {
        const cidx = i + CELLS * (j + CELLS * k);
        const base = i + 1 + P * (j + 1) + P2 * (k + 1);
        let mask = 0;
        for (let q = 0; q < 8; q++) if (blockD[base + OFF[q]!]! >= ISO) mask |= 1 << q;
        if (mask === 0 || mask === 255) {
          cellVert[cidx] = -1;
          continue;
        }
        let sx = 0, sy = 0, sz = 0, ne = 0;
        for (let e = 0; e < 12; e++) {
          const q0 = E0[e]!, q1 = E1[e]!;
          const in0 = (mask >> q0) & 1, in1 = (mask >> q1) & 1;
          if (in0 === in1) continue;
          const d0 = blockD[base + OFF[q0]!]!, d1 = blockD[base + OFF[q1]!]!;
          const t = (ISO - d0) / (d1 - d0);
          const ax = q0 & 1, ay = (q0 >> 1) & 1, az = (q0 >> 2) & 1;
          sx += ax + ((q1 & 1) - ax) * t;
          sy += ay + (((q1 >> 1) & 1) - ay) * t;
          sz += az + (((q1 >> 2) & 1) - az) * t;
          ne++;
        }
        let fx = sx / ne, fy = sy / ne, fz = sz / ne;
        // Damage / soot weighted towards the solid corners (air samples carry no damage).
        let wsum = 0, dsum = 0, ssum = 0, dmax = 0;
        for (let q = 0; q < 8; q++) {
          const o = base + OFF[q]!;
          const w = blockD[o]! + 1;
          const m = blockM[o]!;
          wsum += w;
          dsum += w * m;
          ssum += w * blockS[o]!;
          if (m > dmax) dmax = m;
        }
        const cx = i0 + i, cy = j0 + j, cz = k0 + k;
        const vo = nv * 3;
        let snapped = false;
        if (dmax === 0 && shape && cellMatchesShape(g, shape, cx, cy, cz, blockD, base, OFF)) {
          snapped = shape.snap(g, cx, cy, cz, snapPos, snapNrm);
        }
        let px: number, py: number, pz: number;
        sFace[nv] = 0;
        if (snapped) {
          px = snapPos[0]!; py = snapPos[1]!; pz = snapPos[2]!;
          sNrm[vo] = snapNrm[0]!; sNrm[vo + 1] = snapNrm[1]!; sNrm[vo + 2] = snapNrm[2]!;
          // A face (not edge or corner) vertex of a box, without soot: mergeable.
          if (flatFaces && ssum === 0) {
            const nx = snapNrm[0]!, ny = snapNrm[1]!, nz = snapNrm[2]!;
            if (ny === 0 && nz === 0) sFace[nv] = 1 + (nx > 0 ? 1 : 0);
            else if (nx === 0 && nz === 0) sFace[nv] = 3 + (ny > 0 ? 1 : 0);
            else if (nx === 0 && ny === 0) sFace[nv] = 5 + (nz > 0 ? 1 : 0);
          }
        } else {
          px = g.ox + (cx + fx) * h;
          py = g.oy + (cy + fy) * h;
          pz = g.oz + (cz + fz) * h;
          // Trilinear blend of the corner central-difference gradients.
          let gx = 0, gy = 0, gz = 0;
          for (let q = 0; q < 8; q++) {
            const o = base + OFF[q]!;
            const wx = q & 1 ? fx : 1 - fx, wy = (q >> 1) & 1 ? fy : 1 - fy, wz = (q >> 2) & 1 ? fz : 1 - fz;
            const w = wx * wy * wz;
            gx += w * (blockD[o + 1]! - blockD[o - 1]!);
            gy += w * (blockD[o + P]! - blockD[o - P]!);
            gz += w * (blockD[o + P2]! - blockD[o - P2]!);
          }
          const l = Math.hypot(gx, gy, gz);
          if (l > 1e-6) {
            sNrm[vo] = -gx / l; sNrm[vo + 1] = -gy / l; sNrm[vo + 2] = -gz / l;
          } else {
            sNrm[vo] = 0; sNrm[vo + 1] = 1; sNrm[vo + 2] = 0;
          }
        }
        sPos[vo] = px; sPos[vo + 1] = py; sPos[vo + 2] = pz;
        sDmg[nv] = dsum / wsum / 255;
        sSoot[nv] = ssum / wsum / 255;
        // Boxes and cylinders get their depth per fragment in the shader; others need it here.
        sDep[nv] = depthAttr ? Math.max(0, -shape!.sdf(px, py, pz)) : 0;
        cellVert[cidx] = nv++;
      }
  if (nv === 0) return null;
  // Pass 2: one quad per sign-changing edge whose minimum cell lies in this chunk.
  let ni = 0;
  for (const m of faceMasks.values()) m.fill(0);
  let marked = 0;
  /** Mark a quad on an untouched box face for merging instead of emitting it. */
  const mark = (axis: number, layer: number, qa: number, qb: number, c0: number, c1: number, c2: number, c3: number, inside: boolean): boolean => {
    const f = sFace[cellVert[c0]!]!;
    if (f === 0 || (f - 1) >> 1 !== axis || sFace[cellVert[c1]!] !== f || sFace[cellVert[c2]!] !== f || sFace[cellVert[c3]!] !== f) return false;
    const key = axis * 64 + layer;
    let m = faceMasks.get(key);
    if (!m) faceMasks.set(key, (m = new Uint8Array(CELLS * CELLS)));
    m[qa + CELLS * qb] = inside ? 2 : 1;
    marked++;
    return true;
  };
  for (let k = 0; k < CELLS; k++)
    for (let j = 0; j < CELLS; j++)
      for (let i = 0; i < CELLS; i++) {
        const cidx = i + CELLS * (j + CELLS * k);
        if (cellVert[cidx]! < 0) continue;
        const base = i + 1 + P * (j + 1) + P2 * (k + 1);
        const inside = blockD[base]! >= ISO;
        // +X edge: cells (i, j−1..j, k−1..k)
        if (i < N && j > 0 && k > 0 && (blockD[base + 1]! >= ISO) !== inside) {
          const q0 = cidx - CELLS - CELLS * CELLS, q1 = cidx - CELLS * CELLS, q3 = cidx - CELLS;
          if (!flatFaces || !mark(0, i, j, k, q0, q1, cidx, q3, inside)) ni = emitQuad(ni, q0, q1, cidx, q3, inside);
        }
        // +Y edge: cells (i−1..i, j, k−1..k); ordered in the (z, x) plane
        if (j < N && i > 0 && k > 0 && (blockD[base + P]! >= ISO) !== inside) {
          const q0 = cidx - 1 - CELLS * CELLS, q1 = cidx - 1, q3 = cidx - CELLS * CELLS;
          if (!flatFaces || !mark(1, j, i, k, q0, q1, cidx, q3, inside)) ni = emitQuad(ni, q0, q1, cidx, q3, inside);
        }
        // +Z edge: cells (i−1..i, j−1..j, k); ordered in the (x, y) plane
        if (k < N && i > 0 && j > 0 && (blockD[base + P2]! >= ISO) !== inside) {
          const q0 = cidx - 1 - CELLS, q1 = cidx - CELLS, q3 = cidx - 1;
          if (!flatFaces || !mark(2, k, i, j, q0, q1, cidx, q3, inside)) ni = emitQuad(ni, q0, q1, cidx, q3, inside);
        }
      }
  if (marked > 0) {
    const r = mergeFaces(nv, ni);
    nv = r.nv;
    ni = r.ni;
  }
  if (ni === 0) return null;
  const indices = nv < 65536 ? new Uint16Array(ni) : new Uint32Array(ni);
  for (let q = 0; q < ni; q++) indices[q] = sIdx[q]!;
  return {
    positions: sPos.slice(0, nv * 3),
    normals: sNrm.slice(0, nv * 3),
    damage: sDmg.slice(0, nv),
    depth: sDep.slice(0, nv),
    soot: sSoot.slice(0, nv),
    indices,
    vertexCount: nv,
    indexCount: ni,
  };
}

/** Cell index of in-plane quad corner (u, v) on `layer` of a face normal to `axis`. */
function cellOf(axis: number, layer: number, u: number, v: number): number {
  // In-plane axes: X faces (j, k), Y faces (i, k), Z faces (i, j).
  return axis === 0 ? layer + CELLS * (u + CELLS * v) : axis === 1 ? u + CELLS * (layer + CELLS * v) : u + CELLS * (v + CELLS * layer);
}

/**
 * Replace the marked quads by merged rectangles (fans around a new centre vertex through every
 * rim vertex), emit leftovers as plain quads, then drop vertices no triangle uses. A quad at edge
 * (qa, qb) spans cells qa−1..qa × qb−1..qb, so a rectangle of quads qa0..qa1 × qb0..qb1 has its
 * rim on the ring of cells qa0−1..qa1 × qb0−1..qb1.
 */
function mergeFaces(nv0: number, ni0: number): { nv: number; ni: number } {
  let nv = nv0, ni = ni0;
  for (const [key, m] of faceMasks) {
    const axis = key >> 6, layer = key & 63;
    for (let qb = 1; qb < CELLS; qb++)
      for (let qa = 1; qa < CELLS; qa++) {
        const val = m[qa + CELLS * qb]!;
        if (!val) continue;
        // Greedy maximal rectangle: widen along a, then grow along b while whole rows match.
        let a1 = qa;
        while (a1 + 1 < CELLS && m[a1 + 1 + CELLS * qb] === val) a1++;
        let b1 = qb;
        grow: while (b1 + 1 < CELLS) {
          for (let x = qa; x <= a1; x++) if (m[x + CELLS * (b1 + 1)] !== val) break grow;
          b1++;
        }
        for (let y = qb; y <= b1; y++) for (let x = qa; x <= a1; x++) m[x + CELLS * y] = 0;
        const inside = val === 2;
        const wa = a1 - qa + 1, wb = b1 - qb + 1;
        if (wa * wb < MERGE_MIN || wa < 2 || wb < 2 || nv >= MAXV) {
          for (let y = qb; y <= b1; y++)
            for (let x = qa; x <= a1; x++) {
              const c00 = cellOf(axis, layer, x - 1, y - 1), c10 = cellOf(axis, layer, x, y - 1);
              const c11 = cellOf(axis, layer, x, y), c01 = cellOf(axis, layer, x - 1, y);
              // Same corner order as pass 2 for this axis (X: (j,k); Y: (z,x)-ordered; Z: (x,y)).
              if (axis === 1) ni = emitQuad(ni, c00, c01, c11, c10, inside);
              else ni = emitQuad(ni, c00, c10, c11, c01, inside);
            }
          continue;
        }
        // Rim cells, counter-clockwise in (u, v): u0..u1 × v0..v1.
        const u0 = qa - 1, u1 = a1, v0 = qb - 1, v1 = b1;
        const rim: number[] = [];
        for (let u = u0; u < u1; u++) rim.push(cellVert[cellOf(axis, layer, u, v0)]!);
        for (let v = v0; v < v1; v++) rim.push(cellVert[cellOf(axis, layer, u1, v)]!);
        for (let u = u1; u > u0; u--) rim.push(cellVert[cellOf(axis, layer, u, v1)]!);
        for (let v = v1; v > v0; v--) rim.push(cellVert[cellOf(axis, layer, u0, v)]!);
        const ca = rim[0]!, cb = cellVert[cellOf(axis, layer, u1, v1)]!;
        const cv = nv++;
        for (let q = 0; q < 3; q++) {
          sPos[cv * 3 + q] = 0.5 * (sPos[ca * 3 + q]! + sPos[cb * 3 + q]!);
          sNrm[cv * 3 + q] = sNrm[ca * 3 + q]!;
        }
        sDmg[cv] = 0; sDep[cv] = 0; sSoot[cv] = 0; sFace[cv] = sFace[ca]!;
        // (u, v) counter-clockwise faces +X for X faces (y × z = x), −Y for Y faces (x × z = −y),
        // +Z for Z faces; flip to the outward normal.
        const f = sFace[ca]!;
        const outward = (f & 1) === 0 ? 1 : -1; // f = 1 + 2·axis + (sign > 0)
        const ccwNormal = axis === 1 ? -1 : 1;
        const flip = outward * ccwNormal < 0;
        for (let q = 0; q < rim.length; q++) {
          const p0 = rim[q]!, p1 = rim[(q + 1) % rim.length]!;
          sIdx[ni++] = cv;
          if (flip) { sIdx[ni++] = p1; sIdx[ni++] = p0; } else { sIdx[ni++] = p0; sIdx[ni++] = p1; }
        }
      }
  }
  // Compact: vertices inside merged rectangles are no longer referenced.
  usedV.fill(-1, 0, nv);
  let n = 0;
  for (let q = 0; q < ni; q++) {
    const v = sIdx[q]!;
    if (usedV[v] === -1) usedV[v] = -2;
  }
  for (let v = 0; v < nv; v++) {
    if (usedV[v] !== -2) continue;
    usedV[v] = n;
    if (v !== n) {
      sPos[n * 3] = sPos[v * 3]!; sPos[n * 3 + 1] = sPos[v * 3 + 1]!; sPos[n * 3 + 2] = sPos[v * 3 + 2]!;
      sNrm[n * 3] = sNrm[v * 3]!; sNrm[n * 3 + 1] = sNrm[v * 3 + 1]!; sNrm[n * 3 + 2] = sNrm[v * 3 + 2]!;
      sDmg[n] = sDmg[v]!; sDep[n] = sDep[v]!; sSoot[n] = sSoot[v]!;
    }
    n++;
  }
  for (let q = 0; q < ni; q++) sIdx[q] = usedV[sIdx[q]!]!;
  return { nv: n, ni };
}

/**
 * Two triangles for the quad (q0,q1,q2,q3), counter-clockwise around the edge axis when the edge
 * starts inside (outward normal along +axis), split along the shorter diagonal.
 */
function emitQuad(ni: number, c0: number, c1: number, c2: number, c3: number, forward: boolean): number {
  let v0 = cellVert[c0]!, v1 = cellVert[c1]!, v2 = cellVert[c2]!, v3 = cellVert[c3]!;
  if (!forward) {
    const t = v1;
    v1 = v3;
    v3 = t;
  }
  const d02 = dist2(v0, v2), d13 = dist2(v1, v3);
  if (d02 <= d13) {
    sIdx[ni++] = v0; sIdx[ni++] = v1; sIdx[ni++] = v2;
    sIdx[ni++] = v0; sIdx[ni++] = v2; sIdx[ni++] = v3;
  } else {
    sIdx[ni++] = v0; sIdx[ni++] = v1; sIdx[ni++] = v3;
    sIdx[ni++] = v1; sIdx[ni++] = v2; sIdx[ni++] = v3;
  }
  return ni;
}

function dist2(a: number, b: number): number {
  const dx = sPos[a * 3]! - sPos[b * 3]!, dy = sPos[a * 3 + 1]! - sPos[b * 3 + 1]!, dz = sPos[a * 3 + 2]! - sPos[b * 3 + 2]!;
  return dx * dx + dy * dy + dz * dz;
}

/** Mesh every non-empty chunk and merge (base mesh of SDF shapes, dynamic-piece hulls, tests). */
export function meshAll(g: VoxelGrid, shape: ShapeSdf | null): MeshData | null {
  const parts: MeshData[] = [];
  let nv = 0, ni = 0;
  for (let c = 0; c < g.cz; c++)
    for (let b = 0; b < g.cy; b++)
      for (let a = 0; a < g.cx; a++) {
        if (!chunkMayHaveSurface(g, a, b, c)) continue;
        const m = meshChunk(g, shape, a, b, c);
        if (!m) continue;
        parts.push(m);
        nv += m.vertexCount;
        ni += m.indexCount;
      }
  if (!parts.length) return null;
  const out: MeshData = {
    positions: new Float32Array(nv * 3), normals: new Float32Array(nv * 3), damage: new Float32Array(nv),
    depth: new Float32Array(nv), soot: new Float32Array(nv), indices: new Uint32Array(ni), vertexCount: nv, indexCount: ni,
  };
  let vo = 0, io = 0;
  for (const m of parts) {
    out.positions.set(m.positions, vo * 3);
    out.normals.set(m.normals, vo * 3);
    out.damage.set(m.damage, vo);
    out.depth.set(m.depth, vo);
    out.soot.set(m.soot, vo);
    for (let q = 0; q < m.indexCount; q++) out.indices[io + q] = m.indices[q]! + vo;
    vo += m.vertexCount;
    io += m.indexCount;
  }
  return out;
}

/**
 * A chunk can own surface quads only if it or a neighbour on its +side (whose samples its last
 * cells read) is not uniform, or if uniform neighbours differ.
 */
export function chunkMayHaveSurface(g: VoxelGrid, a: number, b: number, c: number): boolean {
  let sawEmpty = false, sawFull = false;
  for (let dc = -1; dc <= 1; dc++)
    for (let db = -1; db <= 1; db++)
      for (let da = -1; da <= 1; da++) {
        const A = a + da, B = b + db, C = c + dc;
        if (A < 0 || B < 0 || C < 0 || A >= g.cx || B >= g.cy || C >= g.cz) {
          sawEmpty = true;
          continue;
        }
        const s = g.state[A + g.cx * (B + g.cy * C)];
        if (s === EMPTY) sawEmpty = true;
        else if (s === FULL) sawFull = true;
        else return true;
        if (sawEmpty && sawFull) return true;
      }
  return false;
}
