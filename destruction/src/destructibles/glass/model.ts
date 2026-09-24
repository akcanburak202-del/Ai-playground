import type { MaterialProps } from '../../physics/materials.ts';

/**
 * Fracture physics of architectural glass: the numbers the pane realises. Pure functions, SI units.
 *
 * Glass has no plasticity: every impact that exceeds the local strength ends in cracks. What
 * differs between the three products is what the stored and delivered energy does next:
 *  - fully tempered: the residual stress field holds ~19 kJ/m³ of strain energy; once a crack reaches
 *    the tensile core it runs everywhere at the terminal crack speed and the whole pane dices;
 *  - annealed float: cracks are driven only by the impact energy — a star of radial cracks with
 *    concentric arcs, cutting the pane into large sharp shards;
 *  - laminated: the same star in both plies, but the PVB interlayer holds the fragments, so the pane
 *    stays in the frame, loses stiffness and sags as damage accumulates.
 */

export type GlassType = 'tempered' | 'laminated' | 'annealed';

export const GRAVITY = 9.80665;

/**
 * Terminal crack velocity of soda-lime glass, m/s: 1.5 km/s (Schardin 1959, "Velocity effects in
 * fracture", in Averbach et al., Fracture, MIT Press; ≈ 0.47 of the Rayleigh wave speed). The
 * fracture front of a tempered pane runs outward from the origin at this speed.
 */
export const CRACK_SPEED = 1500;

/**
 * Mid-plane residual tension of fully tempered glass, Pa. EN 12150-1 / ASTM C1048 require a surface
 * compression ≥ 90 MPa (≈ 69 MPa ASTM minimum, typical 90–120 MPa); the parabolic through-thickness
 * profile has σ_surface = −2 σ_m (Gardon 1980, "Thermal tempering of glass", Glass Sci. Technol. 5).
 */
export const TEMPER_TENSION = 46e6;

/**
 * Depth of the compressive surface layer as a fraction of the thickness: the parabolic profile
 * σ(ξ) = σ_m (1 − 3ξ²), ξ = 2z/t, changes sign at ξ = 1/√3, i.e. 0.211 t below each face. A flaw
 * must reach the tensile core before a tempered pane fails.
 */
export const COMPRESSION_DEPTH = (1 - 1 / Math.sqrt(3)) / 2;

/**
 * Dynamic fracture energy of soda-lime glass at branching crack speeds, J/m². The static value is
 * K_IC²/E ≈ 8 J/m²; above the micro-branching onset (≈ 0.4 c_R) the dissipated energy per unit
 * crack area rises several-fold (Sharon & Fineberg 1996, Phys. Rev. B 54; Ravi-Chandar & Knauss
 * 1984, Int. J. Fract. 26). ≈ 10× static is used for impact-driven cracks.
 */
export const G_DYN = 80;

/** Static fracture energy G_c = K_IC² / E, J/m² (Griffith–Irwin). */
export function staticFractureEnergy(m: MaterialProps): number {
  const K = m.fractureToughness ?? 0.75e6;
  return (K * K) / m.youngModulus;
}

/**
 * Strain energy per unit volume stored by the tempering stresses, J/m³: equi-biaxial stress
 * σ(ξ) = σ_m (1 − 3ξ²) has energy density (1 − ν) σ²/E; its thickness average is ⟨(1 − 3ξ²)²⟩ = 4/5,
 * so U = 4 (1 − ν) σ_m² / (5 E) (Barsom 1968, "Fracture of tempered glass", J. Am. Ceram. Soc. 51).
 */
export function temperStrainEnergy(m: MaterialProps, sigmaM = TEMPER_TENSION): number {
  return (0.8 * (1 - m.poisson) * sigmaM * sigmaM) / m.youngModulus;
}

/**
 * Fraction of the released tempering energy that ends up as new crack surface. Calibrated so fully
 * tempered glass (σ_m ≈ 46 MPa) gives ≈ 8 mm dice — EN 12150-1 fragmentation test: ≥ 40 particles
 * in a 50 × 50 mm square (mean particle ≤ 7.9 mm); the rest of the energy goes to elastic waves,
 * heat and fragment motion.
 */
export const FRAGMENT_EFFICIENCY = 0.106;

/**
 * Edge length of a tempered-glass die, m. Energy balance of the fragmentation (Barsom 1968;
 * Warren 2001, "Fragmentation of thermally strengthened glass", Ceram. Trans. 122): a square
 * particle of edge d owns 2·d·t of new crack area (each crack shared by two particles) and releases
 * U·d²·t, so ε U d² t = 2 G_c d t → d = 2 G_c / (ε U). Higher residual stress → finer dice
 * (d ∝ 1/σ_m²; heat-strengthened glass at σ_m ≈ 23 MPa breaks into ~4× larger pieces).
 */
export function diceSize(m: MaterialProps, sigmaM = TEMPER_TENSION): number {
  const U = temperStrainEnergy(m, sigmaM);
  return (2 * staticFractureEnergy(m)) / (FRAGMENT_EFFICIENCY * U);
}

/** Share of the released tempering energy that becomes fragment kinetic energy. */
export const EJECTA_EFFICIENCY = 0.05;

/**
 * Typical speed dice are thrown at by the release of the tempering stresses alone, m/s:
 * ½ ρ v² = κ U (energy partition as above) — the gentle "burst" of a pane that fails spontaneously.
 */
export function diceEjectionSpeed(m: MaterialProps, sigmaM = TEMPER_TENSION): number {
  return Math.sqrt((2 * EJECTA_EFFICIENCY * temperStrainEnergy(m, sigmaM)) / m.density);
}

/** Time for the fracture front to travel `r` metres from its origin, s. */
export function frontArrival(r: number): number {
  return Math.max(0, r) / CRACK_SPEED;
}

/**
 * Does an impact break a tempered pane? It must perforate or push damage through the compressive
 * skin into the tensile core (depth ≥ 0.21 t); a shallow chip leaves the pane intact.
 */
export function temperedFails(outcome: string, depth: number, craterDepth: number, thickness: number): boolean {
  if (outcome === 'perforate') return true;
  return Math.max(depth, craterDepth) >= COMPRESSION_DEPTH * thickness;
}

// ─── Impact crack stars (annealed and laminated) ───────────────────────────────────────────

export interface StarSpec {
  /** Number of primary radial cracks */
  radials: number;
  /** Mean radial crack length, m */
  length: number;
  /** Radii of concentric (cone/bending) cracks, m */
  rings: number[];
  /** Probability that an arc exists between two neighbouring radials, per ring (inner first) */
  ringProb: number[];
  /** Branching probability per walk step at the origin (decays outward) */
  branchProb: number;
  /** Half-angle of a crack bifurcation, rad */
  branchAngle: number;
  /** Walk step, m */
  step: number;
  /** Random direction change per step (std), rad */
  wander: number;
}

/** Fraction of the energy absorbed by the pane that drives the radial cracks (calibrated). */
export const RADIAL_EFFICIENCY = 0.006;

/**
 * Crack star for a projectile impact that absorbed `energy` J in a pane of thickness `t`.
 *
 * Count: the number of radial cracks grows with the impact energy and saturates
 * (Vandenberghe, Vermorel & Villermaux 2013, "Star-shaped crack pattern of broken windows",
 * Phys. Rev. Lett. 110, 174302: N rises with impact speed and plate thickness): n = 3 + 2 ln(1 + E/20 J),
 * 4…16 — about nine for a 5.56 mm ball round through float glass, sixteen for 30 mm.
 *
 * Length: energy balance of the star, n · L · t · G_dyn = η E (Griffith, with the dynamic fracture
 * energy), η calibrated so a rifle bullet through 6 mm float glass runs radials of ≈ 0.5 m, as in
 * forensic photographs; the PVB interlayer of laminated glass arrests them at roughly half that.
 *
 * Concentric cracks form where the conical flexure of the struck plate puts the impact face in
 * tension (Hertzian cone → bending rings, e.g. Chaudhri & Walley 1978 Phil. Mag. A 37); a monolith
 * shows two or three, laminated glass a dense spider web.
 */
export function impactStar(type: GlassType, energy: number, t: number, holeR: number, diag: number, rnd: () => number): StarSpec {
  const E = Math.max(energy, 0);
  const lam = type === 'laminated';
  const n = Math.round(Math.min(16, Math.max(4, 3 + 2 * Math.log(1 + E / 20) + (lam ? 1.5 : 0) + (rnd() - 0.5))));
  let L = (RADIAL_EFFICIENCY * E) / (n * Math.max(t, 1e-3) * G_DYN);
  if (lam) L *= 0.5;
  L = Math.min(Math.max(L, 6 * holeR, 0.02), 2 * diag);
  const rings: number[] = [];
  const ringProb: number[] = [];
  if (lam) {
    for (let r = Math.max(4 * holeR, 0.012); r < 0.85 * L; r *= 1.45 + 0.25 * rnd()) {
      rings.push(r);
      ringProb.push(0.9 - 0.25 * (rings.length / 8));
    }
  } else {
    for (const k of [5, 13, 30, 60]) {
      const r = holeR * k * (0.8 + 0.4 * rnd());
      if (r > 0.6 * L) break;
      rings.push(r);
      ringProb.push(0.75 - 0.15 * rings.length);
    }
  }
  return {
    radials: n,
    length: L,
    rings,
    ringProb,
    branchProb: lam ? 0.16 : 0.1,
    branchAngle: 0.28,
    step: Math.min(0.035, Math.max(0.006, L / 16)),
    wander: 0.1,
  };
}

/**
 * Crack pattern of a pane broken by a blast wave. The load is nearly uniform, so fracture starts
 * where the plate's flexural stress peaks (the centre of an edge-supported plate, or the point
 * nearest a close charge) and fragment size falls with loading rate: dynamic fragmentation gives
 * s ∝ ε̇^(−2/3) (Grady & Kipp 1985, "Geometric statistics and dynamic fragmentation", J. Appl.
 * Phys. 58), and the strain rate scales with the P–I damage number D, so s = s₀ D^(−2/3) with
 * s₀ ≈ 0.3 m at the failure threshold.
 */
export function blastStar(damage: number, w: number, h: number, rnd: () => number): StarSpec {
  const D = Math.max(1, damage);
  const s = Math.max(0.035, 0.3 * Math.pow(D, -2 / 3));
  const R = Math.hypot(w, h);
  const rings: number[] = [];
  const ringProb: number[] = [];
  for (let r = 0.6 * s; r < R; r += s * (0.8 + 0.4 * rnd())) {
    rings.push(r);
    ringProb.push(0.95);
  }
  const n = Math.round(Math.min(16, Math.max(6, (Math.PI * 0.5 * Math.min(w, h)) / s)));
  return { radials: n, length: 3 * R, rings, ringProb, branchProb: 0.22, branchAngle: 0.3, step: Math.min(0.05, s / 3), wander: 0.12 };
}

// ─── Blast-driven motion ───────────────────────────────────────────────────────────────────

/**
 * Speed a released glass fragment leaves the frame with under a blast, m/s: impulse–momentum of the
 * free plate element, v = f · i_r / (ρ t), where i_r is the reflected specific impulse and f ≈ 0.8
 * the share not spent before fracture (flexure + frame reaction). Fletcher, Richmond & Yelverton
 * (1980, "Glass fragment hazard from windows broken by airblast", DNA 5593T) measured 10–60 m/s
 * glass fragment velocities for 3–30 kPa loads, the range this gives.
 */
export function blastFragmentSpeed(reflectedImpulse: number, density: number, thickness: number): number {
  return (0.8 * Math.max(reflectedImpulse, 0)) / (density * Math.max(thickness, 1e-4));
}

// ─── Secondary fracture of shards ─────────────────────────────────────────────────────────

/** Share of a shard's normal impact energy that goes into cracking it (the rest: rebound, heat, chips). */
export const BREAK_EFFICIENCY = 0.15;

/**
 * Pieces a falling shard breaks into when it strikes the ground at normal speed `vn` (1 = intact).
 * Griffith energy balance: cracking a shard of size L across its thickness t costs G_dyn · t · L;
 * η ½ m vn² pays for (pieces − 1) such cracks. Critical speed v_c = √(2 G_dyn / (η ρ L)): ≈ 1.5 m/s for a
 * 20 cm shard, 3 m/s for 5 cm — big shards burst on landing, small ones bounce and skitter.
 */
export function shardPieces(mass: number, vn: number, size: number, thickness: number): number {
  const Ek = 0.5 * mass * vn * vn * BREAK_EFFICIENCY;
  const Ec = G_DYN * thickness * Math.max(size, 1e-3);
  if (Ek < Ec) return 1;
  return Math.min(6, 1 + Math.floor(Ek / Ec));
}

// ─── Framed shards ────────────────────────────────────────────────────────────────────────

/**
 * Line load the glazing gasket can hold a loose shard with by friction, N/m: EPDM glazing gaskets
 * are compressed to ≈ 1–3 N/mm of edge (curtain-wall practice) with μ ≈ 0.5 against glass.
 */
export const GASKET_GRIP = 800;

/** Largest area a lost support can leave as dice instead of rigid shards, m² (≈ 3 × 3 cm). */
export const DICE_AREA = 9e-4;

// ─── Laminated glass (PVB interlayer) ─────────────────────────────────────────────────────

/**
 * Extra membrane length cracked laminated glass develops, per unit damage: fragments wedge against
 * each other and the PVB creeps, so a heavily cracked pane has more area than its frame opening and
 * must bulge (post-breakage sag; Kott & Vogel 2004, "Remaining structural capacity of broken
 * laminated safety glass", Glass Processing Days). ≈ 1.2 % at full damage.
 */
export const LAMINATED_SLACK = 0.012;

/** Damage over which a laminated pane pulls out of its frame bite under its own sag. */
export const LAMINATED_PULLOUT = 0.62;

/** Mass per unit area, kg/m². */
export function arealMass(m: MaterialProps, t: number): number {
  return m.density * t;
}
