/**
 * GLSL for the brittle-material family, injected into MeshStandardMaterial through
 * onBeforeCompile. Everything is evaluated in object (element-local) space so textures, form-tie
 * holes, brick coursing and marble veins stay attached to the element and continue into fracture
 * faces and into debris pieces (which share their parent's local frame).
 */

export const VERT_PARS = /* glsl */ `
varying vec3 vObjPos;
varying vec3 vObjNrm;
#ifdef VOXEL_ATTRS
attribute float aDamage;
attribute float aDepth;
attribute float aSoot;
varying float vDamage;
varying float vDepth;
varying float vSoot;
#endif
`;

export const VERT_MAIN = /* glsl */ `
vObjPos = position;
vObjNrm = objectNormal;
#ifdef VOXEL_ATTRS
vDamage = aDamage;
vDepth = aDepth;
vSoot = aSoot;
#endif
`;

export const FRAG_VARYINGS = /* glsl */ `
varying vec3 vObjPos;
varying vec3 vObjNrm;
#ifdef VOXEL_ATTRS
varying float vDamage;
varying float vDepth;
varying float vSoot;
#endif
`;

/** Chunk discard for the analytic base mesh (colour and shadow passes). */
export const FRAG_DISCARD = /* glsl */ `
#ifdef VOXEL_DISCARD
uniform highp sampler3D uChunkMask;
uniform vec3 uGridOrigin;
uniform float uVoxel;
uniform vec3 uChunkDims;
// A base-mesh fragment is dropped when it lies in a chunk that renders its own Surface Nets mesh.
// Near a seam with an un-meshed chunk it is kept (a 0.6-voxel overlap band) so a slightly curved
// Surface Nets rim can never open a gap against the analytic mesh.
bool voxelMeshedAt(vec3 g) {
  vec3 c = floor(g / 16.0);
  if (any(lessThan(c, vec3(0.0))) || any(greaterThanEqual(c, uChunkDims))) return true;
  return texelFetch(uChunkMask, ivec3(c), 0).r > 0.5;
}
bool voxelDiscard(vec3 p) {
  vec3 g = (p - uGridOrigin) / uVoxel - 0.5;
  vec3 c = floor(g / 16.0);
  if (any(lessThan(c, vec3(0.0))) || any(greaterThanEqual(c, uChunkDims))) return false;
  if (texelFetch(uChunkMask, ivec3(c), 0).r < 0.5) return false;
  const float b = 0.6;
  for (int i = 0; i < 8; i++) {
    vec3 s = vec3((i & 1) == 0 ? -b : b, (i & 2) == 0 ? -b : b, (i & 4) == 0 ? -b : b);
    if (!voxelMeshedAt(g + s)) return false;
  }
  return true;
}
#endif
`;

export const FRAG_NOISE = /* glsl */ `
float vxHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
vec3 vxHash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}
float vxNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(vxHash(i), vxHash(i + vec3(1, 0, 0)), f.x), mix(vxHash(i + vec3(0, 1, 0)), vxHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(vxHash(i + vec3(0, 0, 1)), vxHash(i + vec3(1, 0, 1)), f.x), mix(vxHash(i + vec3(0, 1, 1)), vxHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float vxFbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vxNoise(p); p = p * 2.03 + 17.13; a *= 0.5; }
  return s / 0.9375;
}
// Cellular noise: x = F1, y = F2, z = hash of the nearest cell.
vec3 vxWorley(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 r = g + vxHash3(i + g) - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; id = vxHash(i + g); }
        else if (d < d2) { d2 = d; }
      }
  return vec3(sqrt(d1), sqrt(d2), id);
}
// Screen-space derivative bump mapping (Mikkelsen 2010, "Bump mapping unparametrized surfaces on
// the GPU"), evaluated in object space: N' from the height field's screen derivatives.
vec3 vxBump(vec3 N, vec3 p, float h, float scale) {
  vec3 dpdx = dFdx(p), dpdy = dFdy(p);
  float hx = dFdx(h) * scale, hy = dFdy(h) * scale;
  vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (hx * r1 + hy * r2);
  return normalize(abs(det) * N - grad);
}
`;

/**
 * The surface model. Produces albedo, roughness, object-space normal and cavity AO. Finish
 * features are selected with FINISH_* defines.
 */
export const FRAG_SURFACE = /* glsl */ `
uniform sampler2D uAR;
uniform sampler2D uNH;
uniform float uTexScale;
uniform vec3 uTint;
uniform vec3 uHalf;
uniform float uSeed;
uniform mat3 normalMatrix;

// Analytic original shape for per-fragment depth: x = kind (0 none, 1 box, 2 cylinder),
// y = radius, z = half height, w = taper; uShape2 = (flutes, flute depth).
uniform vec4 uShape;
uniform vec2 uShape2;

struct VxSurf { vec3 albedo; float rough; vec3 n; float ao; vec3 emissive; };

// Depth below the original surface (−SDF), or −1 when the shape has no analytic form here.
float vxOriginalDepth(vec3 p) {
  if (uShape.x < 0.5) return -1.0;
  if (uShape.x < 1.5) {
    vec3 q = abs(p) - uHalf;
    return -(length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0));
  }
  float t = clamp((p.y + uShape.z) / (2.0 * uShape.z), 0.0, 1.0);
  float r = uShape.y * (1.0 - uShape.w * t);
  float rho = length(p.xz);
  if (uShape2.x > 0.5) {
    float f = atan(p.z, p.x) / 6.2831853 * uShape2.x;
    float u = 2.0 * fract(f) - 1.0;
    r -= uShape2.y * (1.0 - u * u) * (r / uShape.y);
  }
  float d = rho - r;
  float dy = abs(p.y) - uShape.z;
  return -(length(max(vec2(d, dy), 0.0)) + min(max(d, dy), 0.0));
}

// Exact outward normal of the untouched cylinder (flutes, taper, caps) at object-space p: the
// gradient of the section SDF  s = ρ − r(y)·(1 − f_d(1 − u²)/R),  u = 2·fract(aN/2π) − 1,
// in cylindrical coordinates, ∇s = e_ρ + e_a·(1/ρ)·∂s/∂a + e_y·∂s/∂y.
vec3 vxShapeNormal(vec3 p, vec3 fallback) {
  float H = uShape.z;
  float t = clamp((p.y + H) / (2.0 * H), 0.0, 1.0);
  float r = uShape.y * (1.0 - uShape.w * t);
  float rho = length(p.xz);
  if (rho < 1e-5) return fallback;
  vec3 er = vec3(p.x / rho, 0.0, p.z / rho);
  vec3 ea = vec3(-er.z, 0.0, er.x);
  float dsda = 0.0, k = 1.0;
  if (uShape2.x > 0.5) {
    float u = 2.0 * fract(atan(p.z, p.x) / 6.2831853 * uShape2.x) - 1.0;
    dsda = -2.0 * u * uShape2.y * (r / uShape.y) * (uShape2.x / 3.14159265);
    k = 1.0 - uShape2.y * (1.0 - u * u) / uShape.y;
  }
  float side = rho - r * k;
  float cap = abs(p.y) - H;
  if (cap > side) return vec3(0.0, sign(p.y), 0.0);
  float dsdy = uShape.y * uShape.w / (2.0 * H) * k;
  return normalize(er + ea * (dsda / rho) + vec3(0.0, dsdy, 0.0));
}

// Object-space triplanar sampling with whiteout-blended normals (Golus 2017, "Normal mapping for
// a triplanar shader"), UVs mirrored on back faces.
void vxTriplanar(vec3 p, vec3 N, float scale, out vec4 ar, out vec4 nh, out vec3 nOut) {
  vec3 w = pow(abs(N), vec3(4.0));
  w /= (w.x + w.y + w.z);
  vec3 sg = vec3(N.x < 0.0 ? -1.0 : 1.0, N.y < 0.0 ? -1.0 : 1.0, N.z < 0.0 ? -1.0 : 1.0);
  vec2 uvX = p.zy * scale; uvX.x *= sg.x;
  vec2 uvY = p.xz * scale; uvY.x *= sg.y;
  vec2 uvZ = p.xy * scale; uvZ.x *= -sg.z;
  vec4 aX = texture2D(uAR, uvX), aY = texture2D(uAR, uvY), aZ = texture2D(uAR, uvZ);
  vec4 hX = texture2D(uNH, uvX), hY = texture2D(uNH, uvY), hZ = texture2D(uNH, uvZ);
  ar = aX * w.x + aY * w.y + aZ * w.z;
  nh = hX * w.x + hY * w.y + hZ * w.z;
  vec3 tX = hX.xyz * 2.0 - 1.0, tY = hY.xyz * 2.0 - 1.0, tZ = hZ.xyz * 2.0 - 1.0;
  tX.x *= sg.x; tY.x *= sg.y; tZ.x *= -sg.z;
  tX = vec3(tX.xy + N.zy, abs(tX.z) * N.x);
  tY = vec3(tY.xy + N.xz, abs(tY.z) * N.y);
  tZ = vec3(tZ.xy + N.xy, abs(tZ.z) * N.z);
  nOut = normalize(tX.zyx * w.x + tY.xzy * w.y + tZ.xyz * w.z);
}

float vxH1(float n) { return fract(sin(n * 91.345 + uSeed) * 47453.5453); }
float vxH2(vec2 n) { return fract(sin(dot(n, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }
float vxH3(vec3 n) { return fract(sin(dot(n, vec3(12.9898, 78.233, 37.719)) + uSeed) * 43758.5453); }

VxSurf vxSurface(vec3 p, vec3 N, float damage, float depth, float soot) {
  VxSurf s;
  vec4 ar, nh;
  vec3 nTex;
  vec3 texP = p;
#ifdef FINISH_BOARD
  // Every timber board prints its own stretch of grain.
  float bIdx0 = floor((p.y + uHalf.y) / 0.178);
  texP += vec3(vxH1(bIdx0) * 5.3, 0.0, vxH1(bIdx0 + 7.0) * 5.3);
#endif
  vxTriplanar(texP, N, uTexScale, ar, nh, nTex);
  s.albedo = ar.rgb * uTint;
  s.rough = ar.a;
  s.n = nTex;
  s.ao = 1.0;
  s.emissive = vec3(0.0);
  float height = 0.0; // extra relief (m) for derivative bump mapping
  // Skin = the original formed/polished surface (a 1–2 mm laitance or polish layer); anything
  // chipped deeper than that is fracture surface, so even a shallow bullet chip shows it.
  float skin = 1.0 - smoothstep(0.0015, 0.005, depth);
  float fresh = smoothstep(0.0015, 0.007, depth);
  // Large-scale tonal drift so texture repeats never read.
  float macro = vxFbm(p * 0.9 + uSeed);
  s.albedo *= 0.94 + 0.12 * macro;
  vec3 q = p + uHalf; // from the element's minimum corner

#if defined(FINISH_BOARD) || defined(FINISH_SMOOTH) || defined(FINISH_AGGREGATE)
  float vertical = 1.0 - smoothstep(0.55, 0.8, abs(N.y));
  // Horizontal in-plane coordinate of the face, measured from the element's corner.
  float u = abs(N.x) > abs(N.z) ? q.z : q.x;
  // Main faces are the ones normal to the thinnest axis (form-tie holes go through them).
  float thinAxisX = step(uHalf.x, min(uHalf.y, uHalf.z));
  float thinAxisZ = step(uHalf.z, min(uHalf.x, uHalf.y)) * (1.0 - thinAxisX);
  float mainFace = vertical * (thinAxisX * step(0.7, abs(N.x)) + thinAxisZ * step(0.7, abs(N.z)));
  // Plywood panels 1.8 × 0.9 m (Ando): seams and a faint per-panel tone.
  vec2 pc = vec2(u / 1.8, q.y / 0.9);
  float panel = vxH2(floor(pc));
  s.albedo *= 1.0 + (panel - 0.5) * 0.05 * vertical * skin;
  vec2 pe = min(fract(pc), 1.0 - fract(pc)) * vec2(1.8, 0.9);
  float seam = (1.0 - smoothstep(0.0006, 0.0016, min(pe.x, pe.y))) * vertical * skin;
  s.albedo *= 1.0 - 0.22 * seam;
  height += 0.0008 * seam;
#endif

#ifdef FINISH_BOARD
  // Timber boards ~18 cm: each board prints its own grain offset and tone; thin joints.
  float boardH = 0.178;
  float bi = floor(q.y / boardH);
  float bh = vxH1(bi + floor(u / 3.6) * 17.0);
  s.albedo *= 1.0 + (bh - 0.5) * 0.07 * vertical * skin;
  float fy = fract(q.y / boardH) * boardH;
  float dj = min(fy, boardH - fy);
  float joint = (1.0 - smoothstep(0.0004, 0.0014, dj)) * vertical * skin;
  s.albedo *= 1.0 - 0.12 * joint;
  height -= 0.0006 * joint;
  s.rough = mix(s.rough, s.rough + 0.05, bh);
#endif

#if defined(FINISH_BOARD) || defined(FINISH_SMOOTH)
  // Form-tie holes on a 600 × 450 mm grid, offset half a pitch from the panel edges: shallow
  // conical recesses (Ø 30 mm, ~25 mm deep) with a grey mortar plug at the bottom.
  vec2 f2 = vec2(u, q.y);
  vec2 pitch = vec2(0.6, 0.45);
  vec2 c = (floor((f2 - vec2(0.3, 0.225)) / pitch + 0.5)) * pitch + vec2(0.3, 0.225);
  vec2 dv = f2 - c;
  float r = length(dv);
  float R = 0.015;
  float tie = mainFace * skin;
  if (tie > 0.0 && r < R * 1.8) {
    float wall = smoothstep(R, R * 0.92, r) * smoothstep(R * 0.35, R * 0.45, r);
    float plug = 1.0 - smoothstep(R * 0.35, R * 0.45, r);
    float rim = smoothstep(R * 1.8, R * 1.05, r) * (1.0 - smoothstep(R * 1.02, R * 0.98, r));
    // Cone depth profile as relief: 25 mm at the plug, 0 at the rim.
    float cone = clamp((R - r) / (R * 0.6), 0.0, 1.0);
    height -= 0.02 * cone * tie;
    // The recess is the same concrete; the relief and cavity shading make it read, the plug is
    // a slightly darker grey mortar.
    s.albedo *= mix(1.0, 0.8, wall * tie);
    s.albedo = mix(s.albedo, s.albedo * vec3(0.7, 0.7, 0.71), plug * tie);
    s.albedo *= 1.0 - 0.06 * rim * tie;
    s.ao *= 1.0 - (0.45 * wall + 0.3 * plug) * tie;
    s.rough = mix(s.rough, 0.9, (wall + plug) * tie);
  }
#endif

#ifdef FINISH_MARBLE
  // Carrara: a white ground with soft blue-grey clouds, crossed by veins that follow the
  // metamorphic flow. Veins are the zero lines of a sine along a flow direction, bent by domain
  // warping (Perlin 1985, "An image synthesizer": marble = sin(x + turbulence)); unlike iso-lines
  // of plain noise they run on as long, branching streaks instead of closing into loops. A slow
  // mask lets them fade in and out along their length; a finer network runs across them.
  vec3 mq = p * 1.6 + uSeed;
  vec3 wv = vec3(vxFbm(mq * 0.9), vxFbm(mq * 0.9 + 5.2), vxFbm(mq * 0.9 + 9.7)) - 0.5;
  float turb = vxFbm(mq * 1.3 + 2.4 * wv) + 0.3 * vxFbm(mq * 6.0 + 1.3 * wv);
  float flow = dot(p, vec3(0.62, 0.7, 0.35)) * 3.6 + 2.2 * turb;
  // Soft grey clouding banded along the flow ("nuvolato").
  float cloud = smoothstep(0.35, 0.95, 0.5 + 0.5 * sin(flow * 1.5708 + 1.3)) * smoothstep(0.3, 0.7, vxFbm(mq * 0.7 + 3.0));
  s.albedo *= mix(vec3(1.0), vec3(0.84, 0.855, 0.88), 0.7 * cloud);
  float vd = abs(sin(flow * 3.14159265));
  float present = smoothstep(0.3, 0.55, vxFbm(mq * 0.45 + 7.0));
  float width = 0.03 + 0.09 * smoothstep(0.4, 0.8, vxFbm(mq * 2.1 + 3.3));
  float vein = (1.0 - smoothstep(0.0, width, vd)) * present;
  float halo = (1.0 - smoothstep(0.0, width * 5.0, vd)) * present;
  float flow2 = dot(p, vec3(-0.45, 0.3, 0.84)) * 7.0 + 3.0 * vxFbm(mq * 2.6 + 1.7 * wv);
  float vein2 = (1.0 - smoothstep(0.0, 0.06, abs(sin(flow2 * 3.14159265)))) * smoothstep(0.5, 0.72, vxFbm(mq * 1.2 + 11.0));
  s.albedo = mix(s.albedo, s.albedo * vec3(0.82, 0.835, 0.865), halo * 0.55);
  s.albedo = mix(s.albedo, s.albedo * vec3(0.46, 0.48, 0.52), vein * 0.85);
  s.albedo = mix(s.albedo, s.albedo * vec3(0.68, 0.69, 0.73), vein2 * 0.55);
#endif

#ifdef FINISH_TRAVERTINE
  // Vein-cut Roman travertine: low-contrast, wavy bedding and soft cloudy patches; the character
  // comes from the solution voids — flattened along the bedding, of many sizes, darker inside.
  vec3 tq = p + uSeed;
  float warpY = vxFbm(tq * vec3(1.2, 0.8, 1.2)) * 0.12;
  float band = vxFbm(vec3(tq.x * 0.9, (tq.y + warpY) * 9.0, tq.z * 0.9));
  float cloudy = vxFbm(tq * 2.2 + 4.0);
  vec3 ivory = vec3(1.02, 1.0, 0.96), walnut = vec3(0.88, 0.8, 0.68);
  s.albedo *= mix(ivory, walnut, clamp(0.55 * smoothstep(0.35, 0.8, band) + 0.35 * smoothstep(0.45, 0.8, cloudy), 0.0, 1.0));
  float porous = smoothstep(0.4, 0.7, band);
  vec3 wA = vxWorley(vec3(tq.x * 9.0, (tq.y + warpY) * 30.0, tq.z * 9.0));
  vec3 wB = vxWorley(vec3(tq.x * 22.0, (tq.y + warpY) * 60.0, tq.z * 22.0) + 3.0);
  float pitA = step(wA.z, 0.1 + 0.25 * porous) * (1.0 - smoothstep(0.12, 0.3, wA.x));
  float pitB = step(wB.z, 0.15 + 0.3 * porous) * (1.0 - smoothstep(0.1, 0.22, wB.x));
  float pit = max(pitA, 0.8 * pitB);
  s.albedo = mix(s.albedo, s.albedo * vec3(0.68, 0.62, 0.54), pit);
  s.ao *= 1.0 - 0.5 * pit;
  s.rough = mix(s.rough, 0.95, pit);
  height -= 0.004 * pit;
#endif

#ifdef FINISH_ONYX
  // Honey onyx: wavy growth bands from amber to cream, thin brown lines, a warm translucent glow.
  float t = p.y * 11.0 + vxFbm(p * 1.2 + uSeed) * 6.0 + p.x * 1.4;
  float bnd = 0.5 + 0.5 * sin(t * 2.1);
  float fineB = 0.5 + 0.5 * sin(t * 9.0 + vxNoise(p * 8.0) * 3.0);
  vec3 amber = vec3(0.58, 0.4, 0.19), cream = vec3(0.93, 0.86, 0.7);
  s.albedo = mix(amber, cream, smoothstep(0.15, 0.85, bnd * 0.8 + fineB * 0.2)) * uTint;
  float line = 1.0 - smoothstep(0.0, 0.04, abs(fract(t * 0.37) - 0.5) - 0.45);
  s.albedo *= 1.0 - 0.3 * line;
  s.emissive = s.albedo * vec3(1.0, 0.82, 0.55) * 0.12 * (0.5 + 0.5 * bnd) * skin;
#endif

#ifdef FINISH_BRICK
  // Running bond, 215 × 102.5 × 65 mm bricks with 10 mm mortar, coursing in object space so
  // fractures show brick and mortar at the right places.
  float course = 0.075;
  // Coursing offset so a wall of whole courses ends on brick faces, not on a bed joint.
  float qy = q.y + 0.004;
  float ci = floor(qy / course);
  float yIn = qy - ci * course;
  bool alongX = uHalf.x >= uHalf.z;
  float along = (alongX ? q.x : q.z) + mod(ci, 2.0) * 0.1125;
  float bIdx = floor(along / 0.225);
  float aIn = along - bIdx * 0.225;
  float jw = 0.01;
  // Collar joints between wythes (102.5 mm + 10 mm), laid out from the wall's centre plane so a
  // one-brick wall has its single joint in the middle and none just under either face.
  float halfT = alongX ? uHalf.z : uHalf.x;
  float acrossC = alongX ? p.z : p.x;
  float nW = max(1.0, floor(2.0 * halfT / 0.1125 + 0.5));
  float jOff = mod(nW, 2.0) < 0.5 ? 0.0 : 0.5 * 0.1125;
  float jPos = (floor((acrossC - jOff) / 0.1125 + 0.5)) * 0.1125 + jOff;
  float mt = (1.0 - smoothstep(0.5 * jw - 0.0008, 0.5 * jw + 0.0008, abs(acrossC - jPos))) * step(abs(jPos), halfT - 0.03);
  float wy = floor((acrossC - jOff) / 0.1125);
  float my = smoothstep(course - jw - 0.0008, course - jw + 0.0008, yIn) + (1.0 - smoothstep(0.0, 0.0008, yIn));
  float ma = smoothstep(0.225 - jw - 0.0008, 0.225 - jw + 0.0008, aIn);
  float mortar = clamp(my + ma + mt, 0.0, 1.0);
  float bh = vxH3(vec3(ci, bIdx, wy));
  // Kiln variation: most bricks close to the body colour, some darker/purple from the hot end,
  // some paler under-fired ones.
  vec3 bc = bh < 0.1 ? vec3(0.62, 0.58, 0.62) : bh < 0.22 ? vec3(0.8, 0.72, 0.74) : bh < 0.8 ? vec3(1.0) : vec3(1.12, 1.06, 0.98);
  vec3 brickCol = s.albedo * bc * (0.9 + 0.2 * vxH1(bh * 31.0));
  // Arrises are slightly worn and darker.
  vec3 mortarCol = vec3(0.24, 0.225, 0.2) * (0.85 + 0.3 * vxNoise(p * 90.0));
  s.albedo = mix(brickCol, mortarCol, mortar);
  s.rough = mix(s.rough, 0.95, mortar);
  // Joints struck ~5 mm back from the face.
  height -= 0.005 * mortar * skin;
  s.ao *= 1.0 - 0.35 * mortar * skin;
#endif

#ifdef VOXEL_ATTRS
  // ── Damage ────────────────────────────────────────────────────────────────────────────────
  // Fresh fracture face (below the original skin and micro-cracked): lighter, rougher, and in
  // concrete the aggregate shows.
  fresh *= smoothstep(0.04, 0.16, damage);
  if (fresh > 0.0) {
#if defined(FINISH_BOARD) || defined(FINISH_SMOOTH) || defined(FINISH_AGGREGATE)
    // Crushed-stone aggregate (4–16 mm) as warped Voronoi cells packed in cement paste; the
    // fracture runs around and through the stones. Films of paste separate neighbouring cells.
    vec3 warp = vec3(vxNoise(p * 140.0), vxNoise(p * 140.0 + 3.1), vxNoise(p * 140.0 + 7.7)) - 0.5;
    vec3 wa = vxWorley(p * 90.0 + uSeed + 0.7 * warp);
    float edge = wa.y - wa.x;
    // Coarse aggregate is ~40 % of a normal concrete's volume: plenty of paste shows between stones.
    float isStone = step(0.45, wa.z);
    float stone = isStone * smoothstep(0.05, 0.13, edge);
    float k = fract(wa.z * 7.13);
    // Limestone/granite crushed stone: mostly greys close to the paste, a few darker and warmer.
    vec3 pal = k < 0.3 ? vec3(0.3, 0.295, 0.285) : k < 0.55 ? vec3(0.37, 0.36, 0.34) : k < 0.72 ? vec3(0.2, 0.2, 0.2) : k < 0.86 ? vec3(0.33, 0.305, 0.275) : vec3(0.44, 0.435, 0.42);
    pal *= 0.88 + 0.24 * vxNoise(p * 600.0);
    float sand = vxNoise(p * 900.0);
    vec3 paste = vec3(0.35, 0.345, 0.33) * (0.86 + 0.28 * sand);
    vec3 interior = mix(paste, pal, stone);
    s.albedo = mix(s.albedo, interior * uTint, fresh);
    s.rough = mix(s.rough, mix(0.95, 0.72, stone), fresh);
    // Stones stand proud with rounded tops (the fracture runs around them), paste is sandy and
    // pitted; a coarse undulation gives the conchoidal steps of the fracture surface.
    height += fresh * (0.0012 * stone * smoothstep(0.0, 0.35, edge) + 0.0004 * sand + 0.003 * vxNoise(p * 40.0));
#elif defined(FINISH_MARBLE)
    // Fresh marble fractures are sugary white and matte (cleaved calcite crystals).
    vec3 cr = vxWorley(p * 260.0);
    s.albedo = mix(s.albedo, s.albedo * (1.02 + 0.06 * cr.z) + 0.02, fresh);
    s.rough = mix(s.rough, 0.7, fresh);
    height += fresh * (0.0008 * (cr.y - cr.x) + 0.0015 * vxNoise(p * 60.0));
#elif defined(FINISH_BRICK)
    // The fired body inside a brick is brighter and more salmon than its kiln-darkened face.
    s.albedo = mix(s.albedo, mix(s.albedo * vec3(1.3, 1.14, 1.02), mortarCol * 1.15, mortar), fresh * 0.8);
    s.rough = mix(s.rough, 0.97, fresh);
    height += fresh * (0.0015 * vxNoise(p * 220.0) + 0.0015 * vxNoise(p * 50.0));
#else
    s.rough = mix(s.rough, 0.78, fresh);
    s.albedo = mix(s.albedo, s.albedo * 1.03, fresh);
    height += fresh * (0.0012 * vxNoise(p * 260.0) + 0.0015 * vxNoise(p * 55.0));
    s.emissive *= 1.0 - fresh;
#endif
  }
  // Cavity: crater interiors see less of the sky (a chip's pit already darkens a little).
  s.ao *= 1.0 - 0.5 * smoothstep(0.006, 0.12, depth);
  // Micro-cracks grow with continuum damage: borders of warped Voronoi cells, broken into
  // segments so they read as a crack pattern rather than a net.
  float dmgVis = smoothstep(0.2, 0.75, damage);
  if (dmgVis > 0.0) {
    vec3 cw = vec3(vxNoise(p * 45.0), vxNoise(p * 45.0 + 5.3), 0.0) - 0.5;
    vec3 c1 = vxWorley(p * 22.0 + 7.0 + uSeed + 0.8 * cw);
    float seg = smoothstep(0.45, 0.7, vxNoise(p * 16.0 + 2.0));
    float crack = (1.0 - smoothstep(0.0, 0.006 + 0.02 * damage, c1.y - c1.x)) * mix(seg, 1.0, damage * damage * damage);
    if (damage > 0.45) {
      vec3 c2 = vxWorley(p * 70.0 - 3.0 + 0.6 * cw);
      crack = max(crack, 0.6 * (1.0 - smoothstep(0.0, 0.02, c2.y - c2.x)) * smoothstep(0.45, 0.8, damage));
    }
    crack *= dmgVis;
#if defined(FINISH_BRICK)
    // Masonry cracks mostly follow the joints; hairlines across the red body barely darken it.
    s.albedo *= 1.0 - 0.3 * crack;
#else
    s.albedo *= 1.0 - 0.5 * crack;
#endif
    s.rough = min(1.0, s.rough + 0.15 * crack);
    height -= 0.0006 * crack;
    s.ao *= 1.0 - 0.3 * crack;
    // Pulverised powder dusts the skin right around impacts (the pale ring of a bullet strike).
    float powder = smoothstep(0.22, 0.8, damage) * skin * (0.5 + 0.5 * vxNoise(p * 70.0));
#if defined(FINISH_BRICK)
    vec3 powderCol = vec3(0.56, 0.34, 0.26);
#elif defined(FINISH_MARBLE) || defined(FINISH_ONYX)
    vec3 powderCol = vec3(0.86, 0.85, 0.83);
#else
    vec3 powderCol = vec3(0.5, 0.49, 0.47) * uTint;
#endif
    s.albedo = mix(s.albedo, powderCol, 0.3 * powder);
    s.rough = mix(s.rough, 0.95, powder);
  }
  if (soot > 0.01) {
    float st = soot * (0.75 + 0.5 * vxNoise(p * 12.0));
    s.albedo *= 1.0 - 0.92 * clamp(st, 0.0, 1.0);
    s.rough = mix(s.rough, 0.97, clamp(st, 0.0, 1.0));
    s.emissive *= 1.0 - clamp(st, 0.0, 1.0);
  }
#endif
  if (height != 0.0) s.n = vxBump(s.n, p, height, 1.0);
  return s;
}
`;

/** Replaces #include <map_fragment>: compute the surface once, reused by later chunks. */
export const FRAG_MAP = /* glsl */ `
vec3 vxN = normalize(vObjNrm);
float vxDamage = 0.0, vxDepth = 0.0, vxSootV = 0.0;
#ifdef VOXEL_ATTRS
vxDamage = vDamage;
float vxDepthA = vxOriginalDepth(vObjPos);
vxDepth = vxDepthA >= 0.0 ? vxDepthA : vDepth;
vxSootV = vSoot;
// Facet normal of the triangle. Untouched box faces use it outright (crisp edges that match the
// analytic base mesh); fracture faces lean on it so broken concrete reads angular, not smooth.
vec3 vxNf = normalize(cross(dFdx(vObjPos), dFdy(vObjPos)));
if (dot(vxNf, vxN) < 0.0) vxNf = -vxNf;
// Broken concrete and stone are angular at the scale of a voxel. Loose debris leans well into the
// facet normal so rubble reads as broken, not as pebbles worn smooth; craters in place keep more
// of the smooth normal, since their facets would line up with the grid into visible terraces.
#ifdef VOXEL_DEBRIS
float vxFacet = 0.85 * smoothstep(0.004, 0.02, vxDepth);
#else
float vxFacet = 0.3 * smoothstep(0.004, 0.02, vxDepth);
#endif
#ifdef VOXEL_FLAT_PRISTINE
vxFacet = max(vxFacet, 1.0 - smoothstep(0.0, 0.03, vDamage + vDepth * 30.0));
#endif
vxN = normalize(mix(vxN, vxNf, vxFacet));
#endif
if (uShape.x > 1.5) {
  // Cylinders: the exact normal wherever the surface is still the original one, identical on
  // the base mesh and on remeshed chunks (crisp flute arrises, no seam where the two meet).
  float vxW = 1.0 - smoothstep(0.004, 0.012, vxDepth);
  if (vxW > 0.0) vxN = normalize(mix(vxN, vxShapeNormal(vObjPos, vxN), vxW));
}
#ifdef VOXEL_ATTRS
else if (uShape.x > 0.5) {
  // Boxes: where a fracture meets an original face, Surface Nets rounds the arris over about a
  // voxel. Keeping the exact face normal down to a few millimetres below the face turns that
  // into a crisp crease, so broken slabs read as stone, not soap.
  vec3 vxQ = abs(vObjPos) - uHalf;
  vec3 vxFn = vxQ.x > max(vxQ.y, vxQ.z) ? vec3(sign(vObjPos.x), 0.0, 0.0) : vxQ.y > vxQ.z ? vec3(0.0, sign(vObjPos.y), 0.0) : vec3(0.0, 0.0, sign(vObjPos.z));
  float vxW = 1.0 - smoothstep(0.0015, 0.006, vxDepth);
  if (vxW > 0.0 && dot(vxFn, vxN) > 0.0) vxN = normalize(mix(vxN, vxFn, vxW));
}
#endif
VxSurf vxS = vxSurface(vObjPos, vxN, vxDamage, vxDepth, vxSootV);
diffuseColor.rgb *= vxS.albedo;
`;

export const FRAG_ROUGHNESS = /* glsl */ `
float roughnessFactor = clamp(roughness * vxS.rough, 0.04, 1.0);
`;

export const FRAG_NORMAL = /* glsl */ `
normal = normalize(normalMatrix * vxS.n);
`;

export const FRAG_EMISSIVE = /* glsl */ `
totalEmissiveRadiance += vxS.emissive;
`;

export const FRAG_AO = /* glsl */ `
reflectedLight.indirectDiffuse *= vxS.ao;
reflectedLight.indirectSpecular *= mix(1.0, vxS.ao, 0.7);
reflectedLight.directDiffuse *= mix(1.0, vxS.ao, 0.35);
`;

/** Rusty deformed-bar steel (B500): mill scale, orange-brown rust patches, transverse ribs. */
export const REBAR_VERT_PARS = /* glsl */ `
attribute float aLen;
varying vec3 vBarPos;
varying float vBarAlong;
`;
export const REBAR_VERT_MAIN = /* glsl */ `
vBarAlong = (position.y + 0.5) * aLen;
#ifdef USE_INSTANCING
vBarPos = (instanceMatrix * vec4(position, 1.0)).xyz;
#else
vBarPos = position;
#endif
`;
export const REBAR_FRAG_PARS = /* glsl */ `
varying vec3 vBarPos;
varying float vBarAlong;
`;
export const REBAR_FRAG_MAP = /* glsl */ `
float rust = vxFbm(vBarPos * 30.0);
float rust2 = vxNoise(vBarPos * 140.0);
// Mill scale (dark blue-grey oxide) with flash rust and a film of cement paste.
vec3 scale = vec3(0.055, 0.055, 0.058);
vec3 rustCol = mix(vec3(0.12, 0.055, 0.025), vec3(0.2, 0.095, 0.04), rust2);
float rr = smoothstep(0.3, 0.75, rust);
diffuseColor.rgb = mix(scale, rustCol, rr);
float paste = smoothstep(0.66, 0.85, vxNoise(vBarPos * 40.0 + 4.0));
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.195, 0.185), paste * 0.45);
float barRough = mix(0.5, 0.92, max(rr, paste));
float barMetal = mix(0.6, 0.05, max(rr, paste));
// Transverse ribs every ~0.7 d (EN 10080 deformed bar), as a normal ripple.
float rib = sin(vBarAlong * 6.2831 / 0.011);
`;
