import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { CIRCUMSOLAR_G, type SkyParams, type SunLighting } from './skyModel.ts';

/**
 * The visible sky dome and the image-based lighting derived from it.
 *
 * The dome is three's Preetham `Sky` shader with these changes: it is drawn as one fullscreen
 * triangle at the far plane whose view rays come from the camera's own matrices (the stock 12-triangle
 * box with z = w is clipped at w = 0 where a face crosses the near plane, and a rasteriser that clips
 * before dividing — SwiftShader — smears such a face across the sky as a hazy wedge); a radiance
 * scale so the sky sits at the same exposure as the sun-lit geometry (see skyModel.deriveLighting);
 * a bounded sun disc (a raw Preetham disc is ~10⁴× brighter than anything else and would flood the
 * bloom); a ground hemisphere below the horizon (lit ground fading into horizon haze) so reflections
 * and the diffuse environment see the ground instead of a mirrored sky; and, for the lighting copy,
 * a saturation control and an attenuated circumsolar lobe (skyModel.circumsolarLobe).
 */
export function createSkyMaterial(): THREE.ShaderMaterial {
  const shader = Sky.SkyShader as unknown as { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string };
  const uniforms = THREE.UniformsUtils.clone(shader.uniforms) as Record<string, THREE.IUniform>;
  uniforms.skyScale = { value: 0.25 };
  uniforms.sunDiscScale = { value: 1.0 };
  uniforms.groundRadiance = { value: new THREE.Color(0.08, 0.075, 0.07) };
  uniforms.saturation = { value: 1.0 };
  uniforms.circumsolar = { value: 0.0 };
  // Fullscreen triangle (see createSkyGeometry): position.xy is the NDC corner. The far-plane point of
  // that corner in view space is affine in NDC for any perspective projection, so interpolating it is
  // exact; every vertex has w = 1, so nothing is ever clipped against the near plane.
  let vs = shader.vertexShader;
  const vsFrom = vs.indexOf('vec4 worldPosition = modelMatrix');
  const vsTo = vs.indexOf('gl_Position.z = gl_Position.w;');
  if (vsFrom < 0 || vsTo < 0) throw new Error('three Sky vertex shader changed: update sky.ts');
  vs = `${vs.slice(0, vsFrom)}vec4 farView = inverse( projectionMatrix ) * vec4( position.xy, 1.0, 1.0 );
			vWorldPosition = cameraPosition + mat3( inverse( viewMatrix ) ) * ( farView.xyz / farView.w );
			gl_Position = vec4( position.xy, 1.0, 1.0 );${vs.slice(vs.indexOf('\n', vsTo))}`;
  let fs = shader.fragmentShader;
  fs = fs.replace('uniform float time;', 'uniform float time;\n\t\tuniform float skyScale;\n\t\tuniform float sunDiscScale;\n\t\tuniform vec3 groundRadiance;\n\t\tuniform float saturation;\n\t\tuniform float circumsolar;');
  // Bounded disc: ~40× the sun-lit white wall (bright enough to bloom, not to flood).
  fs = fs.replace(
    'vec3 sundiscColor = ( 760.0 * sundisc ) * min( vSunE * Fex, 80.0 );',
    'vec3 sundiscColor = sundisc * sunDiscScale / skyScale * Fex / max(max(Fex.r, Fex.g), max(Fex.b, 1e-4));',
  );
  const g = CIRCUMSOLAR_G.toFixed(3);
  fs = fs.replace(
    'gl_FragColor = vec4( texColor, 1.0 );',
    `vec3 skyCol = texColor * skyScale;
			// Lighting copy: remove the Preetham overshoot of the circumsolar glow (skyModel.circumsolarLobe).
			skyCol *= 1.0 - circumsolar * pow( ( 1.0 - ${g} ) * ( 1.0 - ${g} ) / ( 1.0 + ${g} * ${g} - 2.0 * ${g} * cosTheta ), 1.5 );
			// Below the horizon: lit ground seen through a thickening layer of horizon haze.
			float below = smoothstep( 0.0, 0.18, - direction.y );
			skyCol = mix( skyCol, groundRadiance, below );
			skyCol = mix( vec3( dot( skyCol, vec3( 0.2126, 0.7152, 0.0722 ) ) ), skyCol, saturation );
			gl_FragColor = vec4( skyCol, 1.0 );`,
  );
  return new THREE.ShaderMaterial({
    name: 'DestructionSky',
    uniforms,
    vertexShader: vs,
    fragmentShader: fs,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: false,
  });
}

/** One triangle covering the whole viewport (NDC corners (−1,−1), (3,−1), (−1,3)). */
export function createSkyGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

export interface SkyRig {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  /** Blurred, mip-mapped sky cube used for view-dependent haze colour */
  cube: THREE.WebGLCubeRenderTarget;
  /** Prefiltered (PMREM) environment for image-based lighting */
  env: THREE.WebGLRenderTarget | null;
  update(renderer: THREE.WebGLRenderer, sunDir: THREE.Vector3, p: SkyParams, light: SunLighting, sunDiscScale: number): void;
  dispose(): void;
}

export function createSkyRig(): SkyRig {
  const material = createSkyMaterial();
  const mesh = new THREE.Mesh(createSkyGeometry(), material);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  // Its geometry is in NDC, not world space: never let a raycast hit it.
  mesh.raycast = () => {};
  mesh.renderOrder = -1000;

  // Captures: same shader, no disc (it would become a hot spot in every rough reflection). The haze
  // cube keeps the visible sky's circumsolar glow (distant haze must melt into the sky behind it);
  // the lighting cube has it attenuated (see skyModel.deriveLighting).
  const envMaterial = createSkyMaterial();
  const envMesh = new THREE.Mesh(createSkyGeometry(), envMaterial);
  envMesh.frustumCulled = false;
  const envScene = new THREE.Scene();
  envScene.add(envMesh);
  const cubeOpts = { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter } as const;
  const cube = new THREE.WebGLCubeRenderTarget(128, cubeOpts);
  const lightCube = new THREE.WebGLCubeRenderTarget(128, cubeOpts);
  const cubeCamera = new THREE.CubeCamera(1, 200, cube);
  envScene.add(cubeCamera);

  let pmrem: THREE.PMREMGenerator | null = null;
  const rig: SkyRig = {
    mesh,
    material,
    cube,
    env: null,
    update(renderer, sunDir, p, light, sunDiscScale) {
      for (const m of [material, envMaterial]) {
        const u = m.uniforms;
        u.turbidity!.value = p.turbidity;
        u.rayleigh!.value = p.rayleigh;
        u.mieCoefficient!.value = p.mieCoefficient;
        u.mieDirectionalG!.value = p.mieDirectionalG;
        (u.sunPosition!.value as THREE.Vector3).copy(sunDir);
        u.skyScale!.value = light.skyScale;
        (u.groundRadiance!.value as THREE.Color).setRGB(...light.groundRadiance);
        u.cloudCoverage!.value = 0.16;
        u.cloudDensity!.value = 0.28;
        u.cloudElevation!.value = 0.55;
      }
      material.uniforms.sunDiscScale!.value = sunDiscScale;
      const eu = envMaterial.uniforms;
      eu.showSunDisc!.value = 0;
      // The Preetham sky is bluer than measured skylight at low sun (it lacks multiple scattering
      // and the warm bounce of sunlit surroundings); light the scene with a partly desaturated copy.
      eu.saturation!.value = 0.85;
      eu.circumsolar!.value = 0;
      cubeCamera.renderTarget = cube;
      cubeCamera.update(renderer, envScene);
      eu.circumsolar!.value = light.circumsolar;
      cubeCamera.renderTarget = lightCube;
      cubeCamera.update(renderer, envScene);
      if (!pmrem) pmrem = new THREE.PMREMGenerator(renderer);
      rig.env?.dispose();
      rig.env = pmrem.fromCubemap(lightCube.texture);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
      envMesh.geometry.dispose();
      envMaterial.dispose();
      cube.dispose();
      lightCube.dispose();
      rig.env?.dispose();
      rig.env = null;
      pmrem?.dispose();
      pmrem = null;
    },
  };
  return rig;
}
