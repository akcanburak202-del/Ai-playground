import type { MaterialProps } from '../physics/materials.ts';
import type { Rng } from '../core/rng.ts';

/**
 * Modal synthesis of struck metal and glass: the ring of a plate or beam is a sum of exponentially
 * damped sinusoids at the structure's natural frequencies. Frequencies come from thin-plate and
 * beam theory with the real material constants, so a 10 mm armour plate, a chromed cruciform
 * column and a 6 mm window each ring at their own pitch. Pure (no Web Audio): buffers are
 * rendered into Float32Arrays and cached by the engine.
 */

export interface Mode {
  /** Frequency, Hz */
  f: number;
  /** Relative amplitude */
  amp: number;
  /** Time for the mode to decay by 60 dB, s */
  t60: number;
  /** Start phase, rad */
  phase: number;
}

/** Plate flexural rigidity term √(D / (ρh)) with D = E h³ / (12 (1 − ν²)), m²/s. */
function plateStiffness(m: MaterialProps, h: number): number {
  return h * Math.sqrt(m.youngModulus / (12 * (1 - m.poisson * m.poisson) * m.density));
}

/**
 * Natural frequencies of a simply supported rectangular Kirchhoff plate a × b × h:
 *   f_mn = (π/2) · √(D/(ρh)) · [(m/a)² + (n/b)²]
 * (A. W. Leissa, "Vibration of Plates", NASA SP-160, 1969, §4.1). Returns the lowest `count`
 * frequencies above `fMin` (sorted), which is where an impact's energy goes audibly.
 */
export function plateFrequencies(m: MaterialProps, a: number, b: number, h: number, count: number, fMin = 40, fMax = 16000): number[] {
  const k = (Math.PI / 2) * plateStiffness(m, Math.max(h, 1e-4));
  const A = Math.max(a, 0.02), B = Math.max(b, 0.02);
  const out: number[] = [];
  for (let i = 1; i <= 40; i++) {
    for (let j = 1; j <= 40; j++) {
      const f = k * ((i / A) ** 2 + (j / B) ** 2);
      if (f >= fMin && f <= fMax) out.push(f);
    }
  }
  out.sort((x, y) => x - y);
  // Keep a spread of modes rather than a dense cluster: skip near-duplicates (< 1.5 % apart).
  const picked: number[] = [];
  for (const f of out) {
    if (picked.length && f / picked[picked.length - 1]! < 1.015) continue;
    picked.push(f);
    if (picked.length >= count) break;
  }
  return picked;
}

/**
 * Bending modes of a free–free (or clamped–clamped) Euler–Bernoulli beam of length L:
 *   f_n = (β_n L)² / (2π L²) · √(E I / (ρ A)) = (β_n L)² / (2π L²) · r_g · √(E/ρ)
 * with β_n L = 4.730, 7.853, 10.996, 14.137, … and radius of gyration r_g (R. D. Blevins,
 * "Formulas for Natural Frequency and Mode Shape", 1979, Table 8-1). For rolled I/H sections
 * r_g ≈ 0.42 h of the section depth h.
 */
export function beamFrequencies(m: MaterialProps, length: number, depth: number, count: number): number[] {
  const L = Math.max(length, 0.1);
  const rg = 0.42 * Math.max(depth, 0.01);
  const c = Math.sqrt(m.youngModulus / m.density);
  const out: number[] = [];
  for (let n = 1; n <= count; n++) {
    const bl = n <= 4 ? [4.73, 7.853, 10.996, 14.137][n - 1]! : (2 * n + 1) * (Math.PI / 2);
    out.push(((bl * bl) / (2 * Math.PI * L * L)) * rg * c);
  }
  return out;
}

/**
 * Decay time from the loss factor η: amplitude decays as e^(−π f η t), so T60 = ln(1000)/(π f η)
 * ≈ 2.2 / (η f). Bolted steel frames η ≈ 0.01, welded plates ≈ 0.003, glass in gaskets ≈ 0.01
 * (Cremer, Heckl & Petersson, "Structure-Borne Sound", 3rd ed., Table 5.1).
 */
export function t60FromLoss(f: number, eta: number): number {
  return 2.2 / (Math.max(eta, 1e-5) * Math.max(f, 1));
}

/**
 * Relative excitation of a mode by an impact of contact duration τ: a half-sine force pulse has
 * a flat spectrum up to ≈ 1/τ and falls off above it, so a bullet (τ ≈ 20 µs) rings every mode
 * while a heavy slow strike (τ ≈ 1 ms) mostly excites the low ones.
 */
export function contactWeight(f: number, contactTime: number): number {
  const x = Math.PI * f * contactTime;
  return 1 / Math.sqrt(1 + x * x);
}

export interface ModalSpec {
  frequencies: number[];
  eta: number;
  contactTime: number;
  /** Frequency jitter for inharmonic variety, fraction */
  jitter: number;
  maxT60?: number;
}

/** Build the mode list for a strike: amplitude falls as 1/√n and with the contact spectrum. */
export function buildModes(spec: ModalSpec, rng: Rng): Mode[] {
  const maxT60 = spec.maxT60 ?? 2.5;
  return spec.frequencies.map((f0, i) => {
    const f = f0 * (1 + rng.range(-spec.jitter, spec.jitter));
    return {
      f,
      amp: contactWeight(f, spec.contactTime) / Math.sqrt(i + 1),
      t60: Math.min(maxT60, Math.max(0.02, t60FromLoss(f, spec.eta))),
      phase: rng.range(0, Math.PI * 2),
    };
  });
}

/**
 * Render damped sinusoids into `out` at `sampleRate`: x(t) = Σ a_i e^(−6.91 t / T60_i) sin(2π f_i t + φ_i),
 * then normalise to a peak of `peak`. Uses a per-mode complex rotator (two multiplies per sample)
 * instead of sin/exp per sample. Modes above Nyquist are skipped.
 */
export function renderModes(out: Float32Array, sampleRate: number, modes: readonly Mode[], peak = 0.9): Float32Array {
  out.fill(0);
  const nyq = sampleRate * 0.45;
  for (const m of modes) {
    if (!(m.f > 0) || m.f >= nyq || !(m.amp > 0)) continue;
    const w = (2 * Math.PI * m.f) / sampleRate;
    const decay = Math.exp(-6.907755 / (m.t60 * sampleRate));
    const cr = Math.cos(w) * decay, ci = Math.sin(w) * decay;
    let re = Math.cos(m.phase) * m.amp, im = Math.sin(m.phase) * m.amp;
    const n = Math.min(out.length, Math.ceil(m.t60 * sampleRate * 1.2));
    for (let i = 0; i < n; i++) {
      out[i]! += im;
      const r2 = re * cr - im * ci;
      im = re * ci + im * cr;
      re = r2;
    }
  }
  // A 1.5 ms raised-cosine onset removes the click of modes starting at non-zero phase.
  const ramp = Math.min(out.length, Math.round(sampleRate * 0.0015));
  for (let i = 0; i < ramp; i++) out[i]! *= 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp);
  let max = 0;
  for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i]!));
  if (max > 0) {
    const g = peak / max;
    for (let i = 0; i < out.length; i++) out[i]! *= g;
  }
  return out;
}
