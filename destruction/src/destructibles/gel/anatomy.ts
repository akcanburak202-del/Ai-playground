/**
 * The ballistic dummy's anatomy as data: a 50th-percentile adult mannequin (1.80 m, ≈ 75 kg of
 * 10 % gelatin) cast in eleven articulated pieces around a simplified synthetic skeleton — skull,
 * spine, rib cage, pelvic ring and the long bones. Everything is given in the dummy's own frame at
 * rest: feet on y = 0, facing +z, its left side towards +x. Pure data and helpers (no DOM, no
 * THREE objects), so the anatomy is testable under Node.
 *
 * Proportions follow anthropometric tables for a 50th-percentile male (NASA-STD-3000 vol. I,
 * ch. 3; ISO 7250): shoulder height 1.45 m, hip joint 0.93 m, knee 0.49 m, chest depth 0.24 m,
 * shoulder breadth 0.40 m. Bone sizes from standard anatomy (femoral shaft Ø 28 mm with ≈ 6 mm
 * cortex, humerus Ø 22 mm, skull wall 6–7 mm).
 */

export type V3 = [number, number, number];

/** One cross-section of a lofted gel shell: position along the axis (0..1), half width and half depth, offsets, superellipse exponent. */
export interface Section {
  t: number;
  /** Half width along the shell's `across` direction, m */
  w: number;
  /** Half depth (perpendicular to width and axis), m */
  d: number;
  /** Offsets of the section centre along width / depth, m */
  ox?: number;
  oz?: number;
  /** Superellipse exponent (2 = ellipse, larger = boxier) */
  n?: number;
}

/** A closed gel surface lofted along the segment a → b, with domed (or flat) ends. */
export interface ShellSpec {
  a: V3;
  b: V3;
  sections: Section[];
  /** Direction the section width lies along (projected off the axis); default +x */
  across?: V3;
  /** Dome length beyond a and b, m (0: flat end) */
  caps: [number, number];
}

/** Synthetic bone primitives the probe can intersect analytically. */
export type BoneSpec =
  /** Long bone: a tube (cortex) from a to b, outer / inner radius (inner 0: solid) */
  | { type: 'tube'; name: string; a: V3; b: V3; ro: number; ri: number }
  /** Skull: an ellipsoidal shell centred at c with outer radii r and wall t */
  | { type: 'shell'; name: string; c: V3; r: V3; t: number }
  /**
   * Rib cage (or pelvic ring): an elliptic cylinder wall about the vertical through (cx, cz) from
   * y0 to y1, outer radii rx, rz, wall t; only bands `width` high every `pitch` are bone (ribs and
   * the gaps between them).
   */
  | { type: 'ribs'; name: string; cx: number; cz: number; y0: number; y1: number; rx: number; rz: number; t: number; pitch: number; width: number };

export type ColliderSpec =
  | { type: 'capsule'; a: V3; b: V3; r: number }
  | { type: 'ball'; c: V3; r: number }
  | { type: 'box'; c: V3; h: V3 };

export interface JointSpec {
  type: 'spherical' | 'revolute';
  /** Joint centre in the dummy frame, m */
  at: V3;
  /** Hinge axis (revolute) */
  axis?: V3;
  /** Hinge limits, rad (revolute) */
  limits?: [number, number];
  /**
   * Pose-holding stiffness of the joint while the dummy stands, N·m/rad (the damping is ≈ 8 % of
   * it): a mannequin's joints are friction-locked, stiff enough that gravity bends none of them
   * by more than ≈ 0.5° (the hips carry the legs' forward-heavy feet).
   */
  stiffness: number;
}

export interface SegmentSpec {
  id: string;
  nameTr: string;
  parent?: string;
  joint?: JointSpec;
  shells: ShellSpec[];
  bones: BoneSpec[];
  colliders: ColliderSpec[];
}

const A_POSE = (10 * Math.PI) / 180;
const sa = Math.sin(A_POSE), ca = Math.cos(A_POSE);

function along(p: V3, dir: V3, len: number): V3 {
  return [p[0] + dir[0] * len, p[1] + dir[1] * len, p[2] + dir[2] * len];
}

function mirror(s: SegmentSpec, id: string, nameTr: string, parent?: string): SegmentSpec {
  const m = (v: V3): V3 => [-v[0], v[1], v[2]];
  return {
    id, nameTr, parent: parent ?? s.parent,
    // A hinge axis is a pseudovector: mirrored in x it keeps its x component and flips the others.
    joint: s.joint && { ...s.joint, at: m(s.joint.at), axis: s.joint.axis && [s.joint.axis[0], -s.joint.axis[1], -s.joint.axis[2]] },
    shells: s.shells.map((sh) => ({ ...sh, a: m(sh.a), b: m(sh.b), across: sh.across && m(sh.across), sections: sh.sections.map((c) => ({ ...c, ox: c.ox !== undefined ? -c.ox : undefined })) })),
    bones: s.bones.map((b) => {
      switch (b.type) {
        case 'tube': return { ...b, a: m(b.a), b: m(b.b) };
        case 'shell': return { ...b, c: m(b.c) };
        case 'ribs': return { ...b, cx: -b.cx };
      }
    }),
    colliders: s.colliders.map((c) => {
      switch (c.type) {
        case 'capsule': return { ...c, a: m(c.a), b: m(c.b) };
        case 'ball': return { ...c, c: m(c.c) };
        case 'box': return { ...c, c: m(c.c) };
      }
    }),
  };
}

/** The standing mannequin, scaled to `height` (default 1.80 m). */
export function mannequin(height = 1.8): SegmentSpec[] {
  const armDir: V3 = [sa, -ca, 0];
  const shoulder: V3 = [0.195, 1.41, 0];
  const elbow = along(shoulder, armDir, 0.28);
  const wrist = along(elbow, armDir, 0.245);
  const hip: V3 = [0.092, 0.925, 0];
  const knee: V3 = [0.1, 0.49, 0.01];

  const torso: SegmentSpec = {
    id: 'torso', nameTr: 'gövde',
    shells: [{
      a: [0, 1.07, 0], b: [0, 1.44, 0], caps: [0.03, 0.065],
      sections: [
        { t: 0, w: 0.142, d: 0.1, n: 2.3 },
        { t: 0.25, w: 0.138, d: 0.1, oz: 0.004, n: 2.3 },
        { t: 0.55, w: 0.155, d: 0.114, oz: 0.008, n: 2.4 },
        { t: 0.8, w: 0.176, d: 0.12, oz: 0.004, n: 2.5 },
        { t: 1, w: 0.19, d: 0.1, oz: -0.01, n: 2.6 },
      ],
    }],
    bones: [
      { type: 'tube', name: 'omurga (göğüs)', a: [0, 1.06, -0.066], b: [0, 1.47, -0.052], ro: 0.018, ri: 0 },
      { type: 'ribs', name: 'kaburga', cx: 0, cz: 0.004, y0: 1.17, y1: 1.42, rx: 0.13, rz: 0.098, t: 0.009, pitch: 0.028, width: 0.013 },
    ],
    colliders: [{ type: 'box', c: [0, 1.265, 0.004], h: [0.15, 0.2, 0.105] }],
  };
  const pelvis: SegmentSpec = {
    id: 'pelvis', nameTr: 'kalça', parent: 'torso',
    joint: { type: 'spherical', at: [0, 1.065, -0.02], stiffness: 1500 },
    shells: [{
      a: [0, 0.88, 0], b: [0, 1.05, 0], caps: [0.055, 0.02],
      sections: [
        { t: 0, w: 0.152, d: 0.1, n: 2.3 },
        { t: 0.5, w: 0.166, d: 0.11, oz: -0.006, n: 2.4 },
        { t: 1, w: 0.148, d: 0.1, n: 2.3 },
      ],
    }],
    bones: [
      { type: 'tube', name: 'omurga (bel)', a: [0, 0.93, -0.062], b: [0, 1.08, -0.066], ro: 0.02, ri: 0 },
      { type: 'ribs', name: 'leğen kemiği', cx: 0, cz: -0.004, y0: 0.95, y1: 1.02, rx: 0.132, rz: 0.086, t: 0.007, pitch: 1, width: 1 },
    ],
    colliders: [{ type: 'box', c: [0, 0.965, -0.004], h: [0.145, 0.085, 0.1] }],
  };
  const head: SegmentSpec = {
    id: 'head', nameTr: 'baş', parent: 'torso',
    joint: { type: 'spherical', at: [0, 1.47, -0.02], stiffness: 250 },
    shells: [
      { a: [0, 1.45, -0.012], b: [0, 1.6, -0.006], caps: [0.02, 0.02], sections: [{ t: 0, w: 0.056, d: 0.058 }, { t: 1, w: 0.054, d: 0.056 }] },
      {
        a: [0, 1.595, 0.006], b: [0, 1.745, 0.006], caps: [0.035, 0.055],
        sections: [
          { t: 0, w: 0.058, d: 0.072, oz: 0.012 },
          { t: 0.3, w: 0.073, d: 0.094, oz: 0.012 },
          { t: 0.62, w: 0.078, d: 0.1 },
          { t: 1, w: 0.072, d: 0.092, oz: -0.005 },
        ],
      },
    ],
    bones: [
      { type: 'shell', name: 'kafatası', c: [0, 1.7, 0.004], r: [0.066, 0.083, 0.088], t: 0.0065 },
      { type: 'tube', name: 'omurga (boyun)', a: [0, 1.46, -0.03], b: [0, 1.62, -0.022], ro: 0.012, ri: 0 },
    ],
    colliders: [{ type: 'ball', c: [0, 1.69, 0.008], r: 0.092 }, { type: 'capsule', a: [0, 1.49, -0.01], b: [0, 1.58, -0.006], r: 0.05 }],
  };
  const upperArm: SegmentSpec = {
    id: 'arm-l', nameTr: 'sol üst kol', parent: 'torso',
    joint: { type: 'spherical', at: shoulder, stiffness: 150 },
    shells: [{ a: along(shoulder, armDir, 0.0), b: elbow, caps: [0.045, 0.035], sections: [{ t: 0, w: 0.05, d: 0.052 }, { t: 0.45, w: 0.047, d: 0.049 }, { t: 1, w: 0.039, d: 0.041 }] }],
    bones: [{ type: 'tube', name: 'üst kol kemiği', a: along(shoulder, armDir, 0.02), b: along(elbow, armDir, -0.01), ro: 0.011, ri: 0.0055 }],
    colliders: [{ type: 'capsule', a: along(shoulder, armDir, 0.01), b: elbow, r: 0.045 }],
  };
  const forearm: SegmentSpec = {
    id: 'forearm-l', nameTr: 'sol ön kol', parent: 'arm-l',
    joint: { type: 'revolute', at: elbow, axis: [ca, sa, 0], limits: [-2.4, 0], stiffness: 60 },
    shells: [
      { a: along(elbow, armDir, 0.005), b: wrist, caps: [0.035, 0.012], sections: [{ t: 0, w: 0.04, d: 0.042 }, { t: 0.35, w: 0.043, d: 0.041 }, { t: 1, w: 0.03, d: 0.022, n: 2.3 }] },
      { a: along(wrist, armDir, 0.01), b: along(wrist, armDir, 0.13), across: [0, 0, 1], caps: [0.012, 0.035], sections: [{ t: 0, w: 0.044, d: 0.016, n: 2.6 }, { t: 1, w: 0.042, d: 0.014, n: 2.6 }] },
    ],
    bones: [
      { type: 'tube', name: 'önkol kemiği (radius)', a: [elbow[0], elbow[1] - 0.015, 0.012], b: [wrist[0], wrist[1] + 0.01, 0.012], ro: 0.008, ri: 0.004 },
      { type: 'tube', name: 'önkol kemiği (ulna)', a: [elbow[0], elbow[1] - 0.015, -0.012], b: [wrist[0], wrist[1] + 0.01, -0.012], ro: 0.008, ri: 0.004 },
    ],
    colliders: [
      { type: 'capsule', a: along(elbow, armDir, 0.03), b: wrist, r: 0.035 },
      { type: 'box', c: along(wrist, armDir, 0.08), h: [0.018, 0.07, 0.042] },
    ],
  };
  const thigh: SegmentSpec = {
    id: 'thigh-l', nameTr: 'sol uyluk', parent: 'pelvis',
    joint: { type: 'spherical', at: hip, stiffness: 1500 },
    shells: [{
      a: [hip[0] + 0.003, hip[1] - 0.02, 0.004], b: [knee[0], knee[1] + 0.01, knee[2]], caps: [0.05, 0.04],
      sections: [{ t: 0, w: 0.086, d: 0.088 }, { t: 0.4, w: 0.076, d: 0.082, oz: 0.006 }, { t: 1, w: 0.052, d: 0.056 }],
    }],
    bones: [{ type: 'tube', name: 'uyluk kemiği', a: [hip[0], hip[1] - 0.03, 0], b: [knee[0], knee[1] + 0.02, 0.006], ro: 0.014, ri: 0.008 }],
    colliders: [{ type: 'capsule', a: [hip[0], hip[1] - 0.04, 0.004], b: [knee[0], knee[1] + 0.03, knee[2]], r: 0.07 }],
  };
  const ankle: V3 = [0.1, 0.085, -0.005];
  const shin: SegmentSpec = {
    id: 'shin-l', nameTr: 'sol baldır', parent: 'thigh-l',
    joint: { type: 'revolute', at: knee, axis: [1, 0, 0], limits: [0, 2.4], stiffness: 800 },
    shells: [
      {
        a: [knee[0], knee[1] - 0.01, 0.006], b: ankle, caps: [0.04, 0.03],
        sections: [{ t: 0, w: 0.05, d: 0.052 }, { t: 0.25, w: 0.052, d: 0.058, oz: -0.01 }, { t: 1, w: 0.032, d: 0.035 }],
      },
      {
        a: [0.1, 0.038, -0.035], b: [0.106, 0.034, 0.15], across: [1, 0, 0], caps: [0.03, 0.03],
        sections: [{ t: 0, w: 0.034, d: 0.034 }, { t: 0.6, w: 0.045, d: 0.027 }, { t: 1, w: 0.04, d: 0.02 }],
      },
    ],
    bones: [
      { type: 'tube', name: 'kaval kemiği', a: [knee[0], knee[1] - 0.02, 0.014], b: [ankle[0], ankle[1] + 0.02, 0.006], ro: 0.012, ri: 0.007 },
      { type: 'tube', name: 'baldır kemiği', a: [knee[0] + 0.024, knee[1] - 0.04, -0.012], b: [ankle[0] + 0.022, ankle[1] + 0.025, -0.01], ro: 0.006, ri: 0 },
    ],
    colliders: [
      { type: 'capsule', a: [knee[0], knee[1] - 0.03, 0.004], b: [ankle[0], ankle[1] + 0.02, ankle[2]], r: 0.045 },
      { type: 'box', c: [0.103, 0.036, 0.05], h: [0.04, 0.03, 0.11] },
    ],
  };
  const segs = [
    torso, pelvis, head,
    upperArm, mirror(upperArm, 'arm-r', 'sağ üst kol'),
    forearm, mirror(forearm, 'forearm-r', 'sağ ön kol', 'arm-r'),
    thigh, mirror(thigh, 'thigh-r', 'sağ uyluk'),
    shin, mirror(shin, 'shin-r', 'sağ baldır', 'thigh-r'),
  ];
  return height === 1.8 ? segs : segs.map((s) => scaleSegment(s, height / 1.8));
}

/**
 * A standard FBI-protocol gel block, 16 × 6 × 6 in (40.6 × 15.2 × 15.2 cm, ≈ 9.8 kg), long axis
 * along z (shots go down its length). `bone` casts a synthetic femur shaft along its axis.
 */
export function gelBlock(size: V3 = [0.152, 0.152, 0.406], bone = false): SegmentSpec[] {
  const [sx, sy, sz] = size;
  return [{
    id: 'block', nameTr: bone ? 'kemikli jel blok' : 'jel blok',
    shells: [{
      a: [0, 0, -sz / 2], b: [0, 0, sz / 2], across: [1, 0, 0], caps: [0, 0],
      sections: [{ t: 0, w: sx / 2, d: sy / 2, n: 10 }, { t: 1, w: sx / 2, d: sy / 2, n: 10 }],
    }],
    bones: bone ? [{ type: 'tube', name: 'uyluk kemiği (sentetik)', a: [0, 0.01, -sz / 2 + 0.05], b: [0, 0.01, sz / 2 - 0.05], ro: 0.014, ri: 0.008 }] : [],
    colliders: [{ type: 'box', c: [0, 0, 0], h: [sx / 2, sy / 2, sz / 2] }],
  }];
}

function scaleSegment(s: SegmentSpec, k: number): SegmentSpec {
  const v = (p: V3): V3 => [p[0] * k, p[1] * k, p[2] * k];
  return {
    ...s,
    joint: s.joint && { ...s.joint, at: v(s.joint.at), stiffness: s.joint.stiffness * k ** 5 },
    shells: s.shells.map((sh) => ({
      ...sh, a: v(sh.a), b: v(sh.b), caps: [sh.caps[0] * k, sh.caps[1] * k] as [number, number],
      sections: sh.sections.map((c) => ({ ...c, w: c.w * k, d: c.d * k, ox: c.ox !== undefined ? c.ox * k : undefined, oz: c.oz !== undefined ? c.oz * k : undefined })),
    })),
    bones: s.bones.map((b) => {
      switch (b.type) {
        case 'tube': return { ...b, a: v(b.a), b: v(b.b), ro: b.ro * k, ri: b.ri * k };
        case 'shell': return { ...b, c: v(b.c), r: v(b.r), t: b.t * k };
        case 'ribs': return { ...b, cx: b.cx * k, cz: b.cz * k, y0: b.y0 * k, y1: b.y1 * k, rx: b.rx * k, rz: b.rz * k, t: b.t * k, pitch: b.pitch * k, width: b.width * k };
      }
    }),
    colliders: s.colliders.map((c) => {
      switch (c.type) {
        case 'capsule': return { ...c, a: v(c.a), b: v(c.b), r: c.r * k };
        case 'ball': return { ...c, c: v(c.c), r: c.r * k };
        case 'box': return { ...c, c: v(c.c), h: v(c.h) };
      }
    }),
  };
}
