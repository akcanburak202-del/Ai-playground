import * as THREE from 'three';
import { KB } from '../physics/ballistics/blast.ts';
import { ATMOSPHERE_GLSL, SOFT_FADE_GLSL, atmosphereUniforms, type Atmosphere } from '../render/atmosphere.ts';

interface Front {
  ring: THREE.Mesh;
  shell: THREE.Mesh;
  ringMat: THREE.ShaderMaterial;
  shellMat: THREE.ShaderMaterial;
  start: number;
  w3: number;
  /** Radius where the front has weakened to ~3 kPa (end of the visible effect), m */
  rMax: number;
  /** (time, radius) samples of the front, s / m */
  ts: Float32Array;
  rs: Float32Array;
  active: boolean;
}

const SAMPLES = 24;

/**
 * The visible shock front of a blast: a thin band sweeping over the ground (the flash of dust and
 * the refraction shimmer where the front hugs the surface) and a faint hemispherical shell (the
 * refractive / condensation shell seen in high-speed footage of large charges). Its radius follows
 * the Kingery–Bulmash arrival time t_a(R) (UFC 3-340-02), inverted from a table, so the ring
 * starts supersonic and settles towards the speed of sound; its contrast follows the incident
 * overpressure at the front.
 */
export class ShockFronts {
  readonly group = new THREE.Group();
  private fronts: Front[] = [];
  private ringGeo = new THREE.RingGeometry(0.965, 1.0, 128, 1).rotateX(-Math.PI / 2);
  private shellGeo = new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2);

  constructor(atmo: Atmosphere, count = 4) {
    this.group.name = 'fx-shock';
    for (let i = 0; i < count; i++) {
      const ringMat = new THREE.ShaderMaterial({
        uniforms: { ...atmosphereUniforms(atmo), uStrength: { value: 0 }, uColor: { value: new THREE.Color() } },
        vertexShader: /* glsl */ `
          varying vec2 vUv; varying float vDepth; varying vec3 vWorld;
          void main() {
            vUv = uv;
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xyz;
            vec4 mv = viewMatrix * w;
            vDepth = -mv.z;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          ${ATMOSPHERE_GLSL}
      ${SOFT_FADE_GLSL}
          uniform float uStrength; uniform vec3 uColor;
          varying vec2 vUv; varying float vDepth; varying vec3 vWorld;
          void main() {
            float r = length(vUv - 0.5) * 2.0;
            float band = smoothstep(0.965, 0.985, r) * (1.0 - smoothstep(0.985, 1.0, r));
            float a = band * uStrength * softFade(vDepth, 0.3);
            vec3 lit = uColor * (uSunColor * max(uSunDir.y, 0.15) + uSkyAmbient);
            gl_FragColor = vec4(applyHaze(lit, vWorld, cameraPosition) * a, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      });
      const shellMat = new THREE.ShaderMaterial({
        uniforms: { ...atmosphereUniforms(atmo), uStrength: { value: 0 } },
        vertexShader: /* glsl */ `
          varying vec3 vN; varying vec3 vV; varying float vDepth;
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vN = normalize(mat3(modelMatrix) * normal);
            vV = normalize(cameraPosition - w.xyz);
            vec4 mv = viewMatrix * w;
            vDepth = -mv.z;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          ${ATMOSPHERE_GLSL}
      ${SOFT_FADE_GLSL}
          uniform float uStrength;
          varying vec3 vN; varying vec3 vV; varying float vDepth;
          void main() {
            // A thin refractive rim only (the shell itself is invisible; its edge bends the
            // background enough to read as a faint bright line in high-speed footage).
            float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 8.0);
            float a = rim * uStrength * softFade(vDepth, 0.5);
            vec3 c = uSunColor * 0.15 + uSkyAmbient;
            gl_FragColor = vec4(c * a, a * 0.25);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          }`,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      });
      const ring = new THREE.Mesh(this.ringGeo, ringMat);
      const shell = new THREE.Mesh(this.shellGeo, shellMat);
      ring.frustumCulled = shell.frustumCulled = false;
      ring.visible = shell.visible = false;
      ring.renderOrder = shell.renderOrder = 5;
      this.group.add(ring, shell);
      this.fronts.push({ ring, shell, ringMat, shellMat, start: 0, w3: 1, rMax: 1, ts: new Float32Array(SAMPLES), rs: new Float32Array(SAMPLES), active: false });
    }
  }

  /** Start a front for an equivalent hemispherical charge W (kg TNT) at `center` on ground height `groundY`. */
  spawn(now: number, center: THREE.Vector3, groundY: number, W: number, dustColor: THREE.Color): void {
    let f = this.fronts.find((x) => !x.active);
    if (!f) f = this.fronts.reduce((a, b) => (a.start < b.start ? a : b));
    const w3 = Math.cbrt(Math.max(W, 1e-3));
    f.w3 = w3;
    f.start = now;
    f.active = true;
    // Visible until the front has decayed to ≈3 kPa (it no longer lifts dust).
    let zMax = 2;
    while (zMax < 60 && KB.incidentPressure(zMax) > 3000) zMax *= 1.1;
    f.rMax = zMax * w3;
    for (let i = 0; i < SAMPLES; i++) {
      const r = f.rMax * Math.pow((i + 1) / SAMPLES, 1.6);
      f.rs[i] = r;
      f.ts[i] = KB.arrivalTime(r / w3) * w3;
    }
    f.ring.position.set(center.x, groundY + 0.03, center.z);
    f.shell.position.copy(center);
    (f.ringMat.uniforms.uColor!.value as THREE.Color).copy(dustColor);
  }

  update(now: number): void {
    for (const f of this.fronts) {
      if (!f.active) continue;
      const t = now - f.start;
      const r = this.radiusAt(f, t);
      if (r < 0 || r >= f.rMax) {
        if (t > 0) {
          f.active = false;
          f.ring.visible = f.shell.visible = false;
        }
        continue;
      }
      const p = KB.incidentPressure(Math.max(r, 0.05) / f.w3);
      f.ring.visible = true;
      f.ring.scale.setScalar(Math.max(r, 0.01));
      f.ringMat.uniforms.uStrength!.value = Math.min(0.55, 0.12 * Math.log10(Math.max(p, 1) / 2000) + 0.05) * (1 - r / f.rMax);
      // Shell only while the front is strong (≳ 30 kPa) and the charge is big enough to show it.
      const sv = f.w3 > 1.2 ? Math.min(0.25, 0.25 * Math.max(0, Math.log10(p / 30000))) : 0;
      f.shell.visible = sv > 0.005;
      f.shell.scale.setScalar(Math.max(r, 0.01));
      f.shellMat.uniforms.uStrength!.value = sv;
    }
  }

  private radiusAt(f: Front, t: number): number {
    if (t <= 0) return -1;
    if (t < f.ts[0]!) return (f.rs[0]! * t) / f.ts[0]!;
    for (let i = 1; i < SAMPLES; i++) {
      if (t < f.ts[i]!) {
        const u = (t - f.ts[i - 1]!) / (f.ts[i]! - f.ts[i - 1]!);
        return f.rs[i - 1]! + u * (f.rs[i]! - f.rs[i - 1]!);
      }
    }
    return f.rMax;
  }

  clear(): void {
    for (const f of this.fronts) {
      f.active = false;
      f.ring.visible = f.shell.visible = false;
    }
  }

  dispose(): void {
    this.ringGeo.dispose();
    this.shellGeo.dispose();
    for (const f of this.fronts) {
      f.ringMat.dispose();
      f.shellMat.dispose();
    }
    this.group.removeFromParent();
  }
}
