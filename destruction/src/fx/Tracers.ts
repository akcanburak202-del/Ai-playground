import * as THREE from 'three';
import { ATMOSPHERE_GLSL, SOFT_FADE_GLSL, atmosphereUniforms, type Atmosphere } from '../render/atmosphere.ts';

/**
 * Tracer streaks for rounds in flight. Rebuilt every frame from the live projectiles: the streak
 * runs from where the round was one exposure ago to where it is now (a 1/120 s shutter, scaled
 * with slow motion), with a white-hot core and a red strontium-nitrate glow (M856, M62, T-46 are
 * red; burning magnesium / Sr(NO₃)₂ composition). HDR bright so the bloom picks it up.
 */
export class Tracers {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private geometry: THREE.InstancedBufferGeometry;
  private material: THREE.ShaderMaterial;
  private head: THREE.InstancedBufferAttribute;
  private tail: THREE.InstancedBufferAttribute;
  private color: THREE.InstancedBufferAttribute;
  private n = 0;

  constructor(atmo: Atmosphere, capacity = 384) {
    this.capacity = capacity;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.head = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.tail = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    for (const a of [this.head, this.tail, this.color]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aHead', this.head);
    g.setAttribute('aTail', this.tail);
    g.setAttribute('aCol', this.color);
    g.instanceCount = 0;
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      name: 'fx-tracers',
      uniforms: atmosphereUniforms(atmo),
      vertexShader: /* glsl */ `
        ${ATMOSPHERE_GLSL}
        attribute vec3 aHead;
        attribute vec3 aTail;
        attribute vec4 aCol;
        varying vec3 vCol;
        varying float vAcross;
        varying float vAlong;
        varying float vDepth;
        varying float vT;
        void main() {
          vec4 ch = projectionMatrix * viewMatrix * vec4(aHead, 1.0);
          vec4 ct = projectionMatrix * viewMatrix * vec4(aTail, 1.0);
          // Clip the streak against the near plane so rounds passing the camera stay sane.
          if (ch.w < 0.05 && ct.w < 0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          if (ch.w < 0.05) ch = mix(ct, ch, (ct.w - 0.05) / (ct.w - ch.w));
          if (ct.w < 0.05) ct = mix(ch, ct, (ch.w - 0.05) / (ch.w - ct.w));
          vec2 sh = ch.xy / ch.w * uResolution * 0.5;
          vec2 st = ct.xy / ct.w * uResolution * 0.5;
          vec2 axis = sh - st;
          float len = length(axis);
          vec2 dir = len > 1e-3 ? axis / len : vec2(1.0, 0.0);
          vec2 nrm = vec2(-dir.y, dir.x);
          float focal = projectionMatrix[1][1] * uResolution.y * 0.5;
          float wpx = aCol.w * focal / ch.w;
          float w = max(2.0, wpx);
          vec2 c = position.xy;
          vec2 base = c.x < 0.0 ? st : sh;
          vec4 clip = c.x < 0.0 ? ct : ch;
          vec2 px = base + dir * c.x * w + nrm * c.y * w * 2.0;
          gl_Position = vec4(px / (uResolution * 0.5) * clip.w, clip.z, clip.w);
          // A tracer is a point source: keep it clearly visible at range (that is its purpose).
          vCol = aCol.rgb * clamp(wpx / w, 0.6, 1.0);
          vAcross = c.y;
          vAlong = c.x * 0.5 + 0.5;
          vDepth = clip.w;
          vec3 wp = c.x < 0.0 ? aTail : aHead;
          vec3 d = wp - cameraPosition;
          vT = hazeTransmittance(length(d), max(cameraPosition.y, 0.0), max(wp.y, 0.0));
        }`,
      fragmentShader: /* glsl */ `
        ${ATMOSPHERE_GLSL}
      ${SOFT_FADE_GLSL}
        varying vec3 vCol;
        varying float vAcross;
        varying float vAlong;
        varying float vDepth;
        varying float vT;
        void main() {
          float y2 = vAcross * vAcross;
          // Hot white core inside a red glow; the tail end fades (the trail of burning composition).
          float core = exp(-30.0 * y2);
          float halo = exp(-4.0 * y2);
          float along = smoothstep(0.0, 0.7, vAlong);
          vec3 c = (vCol * halo * 0.6 + vec3(1.0, 0.85, 0.7) * length(vCol) * 0.5 * core) * along;
          float a = softFade(vDepth, 0.05);
          gl_FragColor = vec4(c * a * vT, 0.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'fx-tracers';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
  }

  begin(): void {
    this.n = 0;
  }

  /** Add a streak; colour is linear HDR (intensity included), width in metres. */
  add(hx: number, hy: number, hz: number, tx: number, ty: number, tz: number, r: number, g: number, b: number, width: number): void {
    if (this.n >= this.capacity) return;
    const i = this.n++;
    const H = this.head.array as Float32Array, T = this.tail.array as Float32Array, C = this.color.array as Float32Array;
    H[i * 3] = hx; H[i * 3 + 1] = hy; H[i * 3 + 2] = hz;
    T[i * 3] = tx; T[i * 3 + 1] = ty; T[i * 3 + 2] = tz;
    C[i * 4] = r; C[i * 4 + 1] = g; C[i * 4 + 2] = b; C[i * 4 + 3] = width;
  }

  end(): void {
    this.geometry.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n === 0) return;
    upload(this.head, this.n * 3);
    upload(this.tail, this.n * 3);
    upload(this.color, this.n * 4);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

function upload(a: THREE.InstancedBufferAttribute, count: number): void {
  a.clearUpdateRanges();
  a.addUpdateRange(0, count);
  a.needsUpdate = true;
}
