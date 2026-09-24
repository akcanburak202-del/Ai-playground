import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { SkyParams, SunLighting } from './skyModel.ts';

/**
 * The visible sky dome and the image-based lighting derived from it.
 *
 * The dome is three's Preetham `Sky` shader with four additions: a radiance scale so the sky sits
 * at the same exposure as the sun-lit geometry (see skyModel.deriveLighting), a bounded sun disc
 * (a raw Preetham disc is ~10⁴× brighter than anything else and would flood the bloom), and a
 * ground hemisphere below the horizon (lit ground fading into horizon haze) so reflections and the
 * diffuse environment see the ground instead of a mirrored sky, and a saturation control used
 * for the lighting copy.
 */
export function createSkyMaterial(): THREE.ShaderMaterial {
  const shader = Sky.SkyShader as unknown as { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string };
  const uniforms = THREE.UniformsUtils.clone(shader.uniforms) as Record<string, THREE.IUniform>;
  uniforms.skyScale = { value: 0.25 };
  uniforms.sunDiscScale = { value: 1.0 };
  uniforms.groundRadiance = { value: new THREE.Color(0.08, 0.075, 0.07) };
  uniforms.saturation = { value: 1.0 };
  let fs = shader.fragmentShader;
  fs = fs.replace('uniform float time;', 'uniform float time;\n\t\tuniform float skyScale;\n\t\tuniform float sunDiscScale;\n\t\tuniform vec3 groundRadiance;\n\t\tuniform float saturation;');
  // Bounded disc: ~40× the sun-lit white wall (bright enough to bloom, not to flood).
  fs = fs.replace(
    'vec3 sundiscColor = ( 760.0 * sundisc ) * min( vSunE * Fex, 80.0 );',
    'vec3 sundiscColor = sundisc * sunDiscScale / skyScale * Fex / max(max(Fex.r, Fex.g), max(Fex.b, 1e-4));',
  );
  fs = fs.replace(
    'gl_FragColor = vec4( texColor, 1.0 );',
    `vec3 skyCol = texColor * skyScale;
			// Below the horizon: lit ground seen through a thickening layer of horizon haze.
			float below = smoothstep( 0.0, 0.18, - direction.y );
			skyCol = mix( skyCol, groundRadiance, below );
			skyCol = mix( vec3( dot( skyCol, vec3( 0.2126, 0.7152, 0.0722 ) ) ), skyCol, saturation );
			gl_FragColor = vec4( skyCol, 1.0 );`,
  );
  return new THREE.ShaderMaterial({
    name: 'DestructionSky',
    uniforms,
    vertexShader: shader.vertexShader,
    fragmentShader: fs,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
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
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.name = 'sky';
  mesh.scale.setScalar(1500);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;

  // Environment capture: same shader, no disc (it would become a hot spot in every rough reflection).
  const envMaterial = createSkyMaterial();
  const envMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), envMaterial);
  envMesh.scale.setScalar(50);
  const envScene = new THREE.Scene();
  envScene.add(envMesh);
  const cube = new THREE.WebGLCubeRenderTarget(128, {
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
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
      envMaterial.uniforms.showSunDisc!.value = 0;
      // The Preetham sky is bluer than measured skylight at low sun (it lacks multiple scattering
      // and the warm bounce of sunlit surroundings); light the scene with a partly desaturated copy.
      envMaterial.uniforms.saturation!.value = 0.7;
      cubeCamera.update(renderer, envScene);
      if (!pmrem) pmrem = new THREE.PMREMGenerator(renderer);
      rig.env?.dispose();
      rig.env = pmrem.fromCubemap(cube.texture);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
      envMesh.geometry.dispose();
      envMaterial.dispose();
      cube.dispose();
      rig.env?.dispose();
      rig.env = null;
      pmrem?.dispose();
      pmrem = null;
    },
  };
  return rig;
}
