import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SimContext } from '../app/contracts.ts';
import { Rng } from '../core/rng.ts';
import { Noise3 } from '../core/noise.ts';

/**
 * Non-destructible scene dressing: reflecting-pool water, a distant tree line, painted signs and
 * the odd prop. Kept deliberately small — everything that can be shot at is a real element. The
 * group lives under `ctx.world`; when a scene load clears the world it frees its own GPU resources
 * (the three.js 'removed' event), so scenes never have to remember to.
 */
export class Decor {
  readonly group = new THREE.Group();
  private readonly ctx: SimContext;
  private readonly owned: { dispose(): void }[] = [];
  private readonly clock: { t: number } = { t: 0 };
  private disposed = false;

  constructor(ctx: SimContext) {
    this.ctx = ctx;
    this.group.name = 'decor';
    ctx.world.add(this.group);
    this.group.addEventListener('removed', () => this.dispose());
  }

  track<T extends { dispose(): void }>(x: T): T {
    this.owned.push(x);
    return x;
  }

  add(o: THREE.Object3D): THREE.Object3D {
    this.group.add(o);
    return o;
  }

  /** Plain static mesh (props, sign posts); geometry and material are owned by the decor. */
  mesh(geo: THREE.BufferGeometry, mat: THREE.Material, pos: THREE.Vector3Like, rotY = 0, shadows = true): THREE.Mesh {
    const m = new THREE.Mesh(this.track(geo), this.track(mat));
    m.position.set(pos.x, pos.y, pos.z);
    m.rotation.y = rotY;
    m.castShadow = m.receiveShadow = shadows;
    this.group.add(m);
    return m;
  }

  /**
   * A still pool: a planar mirror (three's Reflector, re-rendered at reduced resolution) mixed
   * with the deep-water colour by the Fresnel reflectance of water. Schlick's approximation
   * R(θ) = R₀ + (1 − R₀)(1 − cos θ)⁵ with R₀ = ((n − 1)/(n + 1))² = 0.020 for n = 1.333 (Schlick
   * 1994): nearly black looking down, a mirror at grazing angles, which is what makes a reflecting
   * pool read in photographs. A faint two-scale ripple normal keeps it from looking like glass.
   */
  water(o: { x0: number; x1: number; z0: number; z1: number; y: number; deep?: number; ripple?: number }): THREE.Mesh {
    const w = o.x1 - o.x0, d = o.z1 - o.z0;
    const geo = new THREE.PlaneGeometry(w, d);
    const renderer = this.ctx.renderer;
    // Headless builds (tests) have no renderer: a dark matte stand-in keeps the scene valid.
    if (!renderer) {
      const m = this.mesh(geo, new THREE.MeshStandardMaterial({ color: o.deep ?? 0x0b1110, roughness: 0.05 }), new THREE.Vector3((o.x0 + o.x1) / 2, o.y, (o.z0 + o.z1) / 2), 0, false);
      m.rotation.x = -Math.PI / 2;
      return m;
    }
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const tw = Math.max(256, Math.min(1024, Math.round(size.x * 0.5)));
    const th = Math.max(256, Math.min(1024, Math.round(size.y * 0.5)));
    const normals = this.track(rippleTexture());
    const mirror = new Reflector(this.track(geo), {
      textureWidth: tw, textureHeight: th, clipBias: 0.002, multisample: 0, color: o.deep ?? 0x0b1110, shader: WATER_SHADER,
    });
    this.track(mirror);
    const u = (mirror.material as THREE.ShaderMaterial).uniforms;
    u.tNormal!.value = normals;
    u.ripple!.value = o.ripple ?? 0.012;
    const clock = this.clock;
    const t0 = performance.now();
    mirror.onAfterRender = () => {
      clock.t = (performance.now() - t0) / 1000;
      u.time!.value = clock.t;
    };
    mirror.rotation.x = -Math.PI / 2;
    mirror.position.set((o.x0 + o.x1) / 2, o.y, (o.z0 + o.z1) / 2);
    mirror.name = 'water';
    mirror.receiveShadow = false;
    this.group.add(mirror);
    return mirror;
  }

  /**
   * A distant tree line in a ring around the site: Italian cypresses, umbrella pines and rounded
   * broadleaves (olive / holm oak), instanced and unshadowed (beyond the shadow range anyway).
   */
  trees(o: {
    center?: [number, number]; inner?: number; outer?: number; count: number; seed?: number; mix?: [number, number, number]; gaps?: [number, number][];
    /** Plant in this rectangle [x0, z0, x1, z1] instead of the ring */
    rect?: [number, number, number, number];
    /** Height multiplier */
    scale?: number;
  }): void {
    const rng = new Rng(o.seed ?? 7);
    const [cx, cz] = o.center ?? [0, 0];
    const mix = o.mix ?? [0.45, 0.25, 0.3];
    const kinds = [cypressGeometry(), pineGeometry(), broadleafGeometry()];
    const mats = kinds.map(() => this.track(new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, vertexColors: true })));
    const lists: THREE.Matrix4[][] = [[], [], []];
    const tints: THREE.Color[][] = [[], [], []];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const base = [new THREE.Color(0x26331c), new THREE.Color(0x323d22), new THREE.Color(0x4a5234)];
    for (let i = 0; i < o.count; i++) {
      if (o.rect) {
        const [x0, z0, x1, z1] = o.rect;
        p.set(rng.range(x0, x1), -0.1, rng.range(z0, z1));
      } else {
        const a = rng.range(0, Math.PI * 2);
        if (o.gaps?.some(([g0, g1]) => angleIn(a, g0, g1))) continue;
        const inner = o.inner ?? 100, outer = o.outer ?? 250;
        const r = Math.sqrt(rng.range(inner * inner, outer * outer));
        p.set(cx + r * Math.cos(a), -0.1, cz + r * Math.sin(a));
      }
      const u = rng.next();
      const k = u < mix[0] ? 0 : u < mix[0] + mix[1] ? 1 : 2;
      const h = (k === 0 ? rng.range(9, 15) : k === 1 ? rng.range(8, 13) : rng.range(5, 8)) * (o.scale ?? 1);
      q.setFromAxisAngle(UP, rng.range(0, Math.PI * 2));
      const wide = k === 0 ? rng.range(0.85, 1.15) : rng.range(0.8, 1.25);
      s.set(h * wide, h, h * wide);
      lists[k]!.push(m.compose(p, q, s).clone());
      tints[k]!.push(base[k]!.clone().multiplyScalar(rng.range(0.8, 1.15)));
    }
    kinds.forEach((geo, k) => {
      const list = lists[k]!;
      if (!list.length) {
        geo.dispose();
        return;
      }
      const im = new THREE.InstancedMesh(this.track(geo), mats[k]!, list.length);
      list.forEach((mm, i) => {
        im.setMatrixAt(i, mm);
        im.setColorAt(i, tints[k]![i]!);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = false;
      im.receiveShadow = false;
      im.frustumCulled = false;
      im.name = 'trees';
      this.track({ dispose: () => im.dispose() });
      this.group.add(im);
    });
  }

  /**
   * Painted sign boards on two posts (title line, then detail lines), all drawn into one texture
   * atlas: the boards are one mesh and the posts another, whatever their number. A board faces +z
   * before `rotY`. Needs a DOM canvas; headless builds skip them.
   */
  signs(list: SignSpec[]): void {
    if (typeof document === 'undefined' || !list.length) return;
    const CELL_W = 512, CELL_H = 256;
    const cols = 4, rows = Math.ceil(list.length / cols);
    const canvas = document.createElement('canvas');
    canvas.width = CELL_W * cols;
    canvas.height = CELL_H * rows;
    const g = canvas.getContext('2d');
    if (!g) return;
    const faces: THREE.BufferGeometry[] = [];
    const posts: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    list.forEach((o, i) => {
      const cx = (i % cols) * CELL_W, cy = Math.floor(i / cols) * CELL_H;
      const W = o.width ?? 0.9, H = o.height ?? 0.45;
      // Cells are 2:1; a board of another aspect uses the top-left part of its cell.
      const pw = CELL_W, ph = Math.min(CELL_H, Math.round((CELL_W * H) / W));
      paintSign(g, cx, cy, pw, ph, o);
      const face = new THREE.PlaneGeometry(W, H);
      const uv = face.getAttribute('uv') as THREE.BufferAttribute;
      for (let k = 0; k < uv.count; k++) {
        const u = (cx + uv.getX(k) * pw) / canvas.width;
        const v = 1 - (cy + (1 - uv.getY(k)) * ph) / canvas.height;
        uv.setXY(k, u, v);
      }
      const back = new THREE.BoxGeometry(W + 0.02, H + 0.02, 0.02).translate(0, 0, -0.011);
      back.deleteAttribute('uv');
      const top = 0.35 + H;
      const [x, y0, z] = o.at;
      const place = (geo: THREE.BufferGeometry, lx: number, ly: number, lz: number, tilt: number) => {
        q.setFromEuler(e.set(tilt, o.rotY ?? 0, 0, 'YXZ'));
        m.compose(new THREE.Vector3(lx, ly, lz).applyEuler(new THREE.Euler(0, o.rotY ?? 0, 0)).add(new THREE.Vector3(x, y0, z)), q, ONE);
        geo.applyMatrix4(m);
      };
      place(face, 0, 0.35 + H / 2, 0, -0.12);
      place(back, 0, 0.35 + H / 2, 0, -0.12);
      faces.push(face);
      posts.push(back);
      for (const sx of [-1, 1]) {
        const p = new THREE.BoxGeometry(0.05, top - 0.05, 0.05);
        p.deleteAttribute('uv');
        place(p, sx * (W / 2 - 0.08), (top - 0.05) / 2, -0.05, 0);
        posts.push(p);
      }
    });
    const tex = this.track(new THREE.CanvasTexture(canvas));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const faceGeo = mergeGeometries(faces, false);
    const postGeo = mergeGeometries(posts, false);
    for (const f of [...faces, ...posts]) f.dispose();
    if (faceGeo) this.mesh(faceGeo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }), ORIGIN).name = 'signs';
    if (postGeo) this.mesh(postGeo, new THREE.MeshStandardMaterial({ color: 0x2b2d2f, roughness: 0.55, metalness: 0.6 }), ORIGIN).name = 'sign-posts';
  }

  /**
   * An earth berm (range backstop): a trapezoidal bank with a lumpy crest, grassed on top and
   * bare on the faces the bullets keep scouring.
   */
  berm(o: { x0: number; x1: number; z: number; height: number; base: number; crest: number }): void {
    const nx = 96, nz = 12;
    const geo = new THREE.PlaneGeometry(1, 1, nx, nz);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    const n = new Noise3(911);
    const soil = new THREE.Color(0x6e5a44), grass = new THREE.Color(0x4f5431), c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i) + 0.5, v = pos.getY(i) + 0.5;
      const x = o.x0 + u * (o.x1 - o.x0);
      // Section across the bank: v = 0 front toe, 1 back toe; flat crest in the middle.
      const zOff = (v - 0.5) * o.base;
      const half = o.base / 2, crest = o.crest / 2;
      const a = Math.abs(zOff);
      let y = a <= crest ? o.height : o.height * Math.max(0, (half - a) / (half - crest));
      const ends = Math.min(1, Math.min(u, 1 - u) * 12);
      y *= Math.pow(ends, 0.6);
      y += (0.35 * n.fbm(x * 0.08, zOff * 0.2, 1.7, 3) + 0.12 * n.noise3(x * 0.6, zOff, 3.1)) * Math.min(1, y);
      pos.setXYZ(i, x, Math.max(-0.05, y), o.z + zOff);
      const bare = a > crest ? 0.65 + 0.35 * n.noise3(x * 0.3, zOff * 0.5, 5) : 0.15;
      c.copy(grass).lerp(soil, Math.min(1, Math.max(0, bare)));
      c.multiplyScalar(0.85 + 0.2 * n.noise3(x * 0.9, zOff * 0.9, 8));
      col[3 * i] = c.r;
      col[3 * i + 1] = c.g;
      col[3 * i + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mesh = this.mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, side: THREE.DoubleSide }), ORIGIN);
    mesh.name = 'berm';
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const x of this.owned) x.dispose();
    this.owned.length = 0;
    this.group.clear();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const ORIGIN = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);

export interface SignSpec {
  at: [number, number, number];
  rotY?: number;
  lines: string[];
  width?: number;
  height?: number;
  accent?: string;
  paper?: string;
  ink?: string;
}

/** One board into its atlas cell: weathered paper, an accent band, a bold title and detail lines. */
function paintSign(g: CanvasRenderingContext2D, x0: number, y0: number, px: number, py: number, o: SignSpec): void {
  g.save();
  g.translate(x0, y0);
  g.fillStyle = o.paper ?? '#dcd6c8';
  g.fillRect(0, 0, px, py);
  // Weathering: faint mottling and a darker lower edge, so the board is not a flat decal.
  const n = new Noise3(o.lines.join('').length * 17 + 3);
  const img = g.getImageData(x0, y0, px, py);
  for (let y = 0; y < py; y++)
    for (let x = 0; x < px; x++) {
      const k = 4 * (y * px + x);
      const v = 1 + 0.04 * n.fbm(x / 60, y / 60, 0.5, 3) - 0.07 * Math.pow(y / py, 5);
      img.data[k] = img.data[k]! * v;
      img.data[k + 1] = img.data[k + 1]! * v;
      img.data[k + 2] = img.data[k + 2]! * v;
    }
  g.putImageData(img, x0, y0);
  g.fillStyle = o.accent ?? '#a8432b';
  g.fillRect(0, 0, px, Math.round(py * 0.07));
  g.fillStyle = o.ink ?? '#1f1d1a';
  const [title, ...rest] = o.lines;
  const fam = '"Archivo Narrow", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
  let size = Math.round(py * 0.27);
  g.font = `700 ${size}px ${fam}`;
  while (g.measureText(title ?? '').width > px * 0.9 && size > 10) g.font = `700 ${--size}px ${fam}`;
  g.textBaseline = 'alphabetic';
  g.fillText(title ?? '', px * 0.05, py * 0.4);
  let y = py * 0.4 + size * 0.2;
  let small = Math.round(py * 0.14);
  g.font = `500 ${small}px ${fam}`;
  for (const line of rest) if (g.measureText(line).width > px * 0.9) small = Math.min(small, Math.floor((small * px * 0.9) / g.measureText(line).width));
  g.font = `500 ${small}px ${fam}`;
  for (const line of rest) {
    y += small * 1.25;
    g.fillText(line, px * 0.05, y);
  }
  g.restore();
}

function angleIn(a: number, a0: number, a1: number): boolean {
  const t = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const x = t(a), lo = t(a0), hi = t(a1);
  return lo <= hi ? x >= lo && x <= hi : x >= lo || x <= hi;
}

/** Colour a geometry's vertices: darker towards the base and inside the crown (fake occlusion). */
function shade(g: THREE.BufferGeometry, base: number, top: number, trunkBelow = -1): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const trunk = new THREE.Color(0x3a2e24);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = Math.min(1, Math.max(0, (y - base) / (top - base)));
    const v = y < trunkBelow ? 0 : 0.55 + 0.45 * Math.pow(t, 0.7);
    if (y < trunkBelow) {
      col[3 * i] = trunk.r;
      col[3 * i + 1] = trunk.g;
      col[3 * i + 2] = trunk.b;
    } else col.fill(v, 3 * i, 3 * i + 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Lumpy displacement so crowns are not perfect solids of revolution. */
function lumpy(g: THREE.BufferGeometry, amp: number, freq: number, seed: number): THREE.BufferGeometry {
  const n = new Noise3(seed);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const r = Math.hypot(v.x, v.z);
    if (r < 1e-4) continue;
    const k = 1 + amp * n.fbm(v.x * freq, v.y * freq, v.z * freq, 3);
    pos.setXYZ(i, v.x * k, v.y, v.z * k);
  }
  g.computeVertexNormals();
  return g;
}

/** Unit-height Italian cypress: a slender flame on a short trunk. */
function cypressGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    const y = 0.06 + t * 0.94;
    const r = 0.1 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.02)), 0.8) * (1 - 0.35 * t);
    pts.push(new THREE.Vector2(Math.max(0.004, r), y));
  }
  pts.unshift(new THREE.Vector2(0.012, 0), new THREE.Vector2(0.012, 0.06));
  const g = lumpy(new THREE.LatheGeometry(pts, 14), 0.3, 16, 11);
  return shade(g, 0.05, 1, 0.055);
}

/**
 * A crown built from several noisy blobs (so it breaks up into masses of foliage instead of one
 * smooth solid) on a thin trunk. Unit height; `blobs` are [x, y, z, radius, flatten].
 */
function crownGeometry(trunkTop: number, trunkR: number, blobs: [number, number, number, number, number][], seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(trunkR * 0.7, trunkR, trunkTop, 6, 1, true).translate(0, trunkTop / 2, 0);
  trunk.deleteAttribute('uv');
  parts.push(trunk);
  const n = new Noise3(seed);
  const v = new THREE.Vector3();
  blobs.forEach(([x, y, z, r, flat], i) => {
    // Welded icosphere, so the displaced crown shades smoothly (a polyhedron is non-indexed).
    const ico = new THREE.IcosahedronGeometry(r, 1);
    ico.deleteAttribute('uv');
    ico.deleteAttribute('normal');
    const b = mergeVertices(ico, 1e-5);
    ico.dispose();
    const pos = b.getAttribute('position') as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k);
      const d = 1 + 0.3 * n.fbm(v.x * 7 + i * 3.1, v.y * 7, v.z * 7, 3);
      pos.setXYZ(k, x + v.x * d, y + v.y * d * flat, z + v.z * d);
    }
    b.computeVertexNormals();
    parts.push(b);
  });
  trunk.computeVertexNormals();
  const merged = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return shade(merged, trunkTop, 1, trunkTop * 0.98);
}

/** Unit-height umbrella (stone) pine: a bare trunk and a flat, wide crown of several masses. */
function pineGeometry(): THREE.BufferGeometry {
  return crownGeometry(0.66, 0.022, [
    [0, 0.8, 0, 0.26, 0.42], [0.2, 0.77, 0.08, 0.2, 0.45], [-0.19, 0.78, -0.06, 0.21, 0.42], [0.05, 0.8, -0.2, 0.19, 0.45], [-0.04, 0.79, 0.2, 0.18, 0.45],
  ], 23);
}

/** Unit-height rounded broadleaf (olive, holm oak): an irregular crown of a few masses. */
function broadleafGeometry(): THREE.BufferGeometry {
  return crownGeometry(0.34, 0.03, [
    [0, 0.66, 0, 0.3, 0.9], [0.18, 0.56, 0.1, 0.22, 0.85], [-0.17, 0.58, -0.08, 0.23, 0.85], [0.05, 0.8, -0.05, 0.2, 0.9], [-0.06, 0.52, 0.2, 0.2, 0.8],
  ], 37);
}

/** Tileable ripple normal map: a few long-crested waves with integer wave numbers. */
function rippleTexture(): THREE.DataTexture {
  const N = 128;
  const data = new Uint8Array(N * N * 4);
  const rng = new Rng(4242);
  const waves = Array.from({ length: 10 }, () => ({
    kx: rng.int(-6, 7), ky: rng.int(-6, 7), a: rng.range(0.3, 1), ph: rng.range(0, Math.PI * 2),
  })).filter((w) => w.kx !== 0 || w.ky !== 0);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let dx = 0, dy = 0;
      for (const w of waves) {
        const arg = (2 * Math.PI * (w.kx * x + w.ky * y)) / N + w.ph;
        const c = Math.cos(arg) * w.a / Math.hypot(w.kx, w.ky);
        dx += c * w.kx;
        dy += c * w.ky;
      }
      const l = Math.hypot(dx * 0.15, dy * 0.15, 1);
      const k = 4 * (y * N + x);
      data[k] = Math.round(((dx * 0.15) / l * 0.5 + 0.5) * 255);
      data[k + 1] = Math.round(((dy * 0.15) / l * 0.5 + 0.5) * 255);
      data[k + 2] = Math.round((1 / l) * 255);
      data[k + 3] = 255;
    }
  const t = new THREE.DataTexture(data, N, N);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

const WATER_SHADER = {
  name: 'ReflectingPool',
  uniforms: {
    color: { value: null as THREE.Color | null },
    tDiffuse: { value: null as THREE.Texture | null },
    textureMatrix: { value: null as THREE.Matrix4 | null },
    tNormal: { value: null as THREE.Texture | null },
    ripple: { value: 0.012 },
    time: { value: 0 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform float ripple;
    uniform float time;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec2 p = vWorld.xz;
      vec3 n1 = texture2D(tNormal, p * 0.11 + vec2(0.006, 0.004) * time).xyz * 2.0 - 1.0;
      vec3 n2 = texture2D(tNormal, p * 0.37 - vec2(0.009, -0.005) * time).xyz * 2.0 - 1.0;
      vec2 slope = (n1.xy + 0.5 * n2.xy);
      vec3 N = normalize(vec3(-slope.x * ripple * 6.0, 1.0, -slope.y * ripple * 6.0));
      vec3 V = normalize(cameraPosition - vWorld);
      float cosT = clamp(dot(N, V), 0.0, 1.0);
      // Schlick's Fresnel for water, R0 = 0.020.
      float F = 0.020 + 0.980 * pow(1.0 - cosT, 5.0);
      vec4 uv = vUv;
      uv.xy += slope * ripple * uv.w;
      vec3 refl = texture2DProj(tDiffuse, uv).rgb;
      gl_FragColor = vec4(mix(color, refl, F), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};
