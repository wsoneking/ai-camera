import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/** Radial alpha falloff so the ground disc melts into the fog instead of ending. */
function makeFalloffTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.85)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** Soft round sprite used for snow and glow points. */
export function makeGlowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.75)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const SKY_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  varying vec3 vWorld;
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uBottom;
  uniform vec3 uGlowColor;
  uniform float uGlow;

  void main() {
    vec3 dir = normalize(vWorld);
    float h = dir.y;
    vec3 col = h > 0.0
      ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.7))
      : mix(uHorizon, uBottom, pow(clamp(-h, 0.0, 1.0), 0.55));

    // warm pool of light behind the tree, keeps the silhouette readable
    float centre = smoothstep(0.55, 1.0, 1.0 - length(dir.xz * vec2(0.9, 1.0)));
    col += uGlowColor * centre * uGlow * (1.0 - smoothstep(0.0, 0.7, abs(h - 0.1)));

    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface StageOptions {
  canvas: HTMLCanvasElement;
}

/**
 * Shared uniform that converts a world-space diameter into `gl_PointSize`
 * pixels: `gl_PointSize = diameter * POINT_SCALE.value / -mvPosition.z`.
 * Stage keeps it in sync with the viewport and FOV, and every Points shader
 * references this same object so point sprites stay the right physical size
 * at any window size or pixel ratio.
 */
export const POINT_SCALE: THREE.IUniform<number> = { value: 1000 };

/**
 * Owns the renderer, camera, environment and post-processing chain. Content
 * (tree, ornaments, snow) is added to `world`, which the stage slowly rotates.
 */
export class Stage {
  readonly scene = new THREE.Scene();
  readonly world = new THREE.Group();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private elapsed = 0;
  /** Camera distance that keeps the whole tree framed; set by resize(). */
  private distance = 14;

  /** Half-extents of the volume the camera must keep in frame. */
  private static readonly FRAME = { halfHeight: 4.6, halfWidth: 4.2, centreY: 3.4 };

  constructor({ canvas }: StageOptions) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.camera.position.set(0, 4.2, 13.5);
    this.camera.lookAt(0, 3.4, 0);

    this.scene.fog = new THREE.FogExp2(0x0a1322, 0.022);
    this.scene.add(this.world);

    // A prefiltered room probe. Drives the specular highlights that make the
    // glass baubles and the gold star read as real materials.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.5;
    pmrem.dispose();

    // --- environment -------------------------------------------------------
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(80, 32, 24),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uTop: { value: new THREE.Color(0x030611) },
          uHorizon: { value: new THREE.Color(0x14233d) },
          uBottom: { value: new THREE.Color(0x05070e) },
          uGlowColor: { value: new THREE.Color(0x2a4f7a) },
          uGlow: { value: 0.4 },
        },
      })
    );
    this.scene.add(sky);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(26, 96),
      new THREE.MeshStandardMaterial({
        color: 0x16233a,
        roughness: 0.82,
        metalness: 0.08,
        transparent: true,
        alphaMap: makeFalloffTexture(),
        depthWrite: false,
      })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // --- lighting ----------------------------------------------------------
    this.scene.add(new THREE.HemisphereLight(0x5e7fb0, 0x0a0f1a, 0.55));

    const keyLight = new THREE.DirectionalLight(0xffe2b8, 1.45);
    keyLight.position.set(5.5, 9, 6.5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 32;
    keyLight.shadow.camera.left = -9;
    keyLight.shadow.camera.right = 9;
    keyLight.shadow.camera.top = 12;
    keyLight.shadow.camera.bottom = -2;
    keyLight.shadow.bias = -0.0012;
    keyLight.shadow.normalBias = 0.03;
    this.scene.add(keyLight);

    const rim = new THREE.DirectionalLight(0x6fa8ff, 0.9);
    rim.position.set(-7, 5, -6);
    this.scene.add(rim);

    const fill = new THREE.PointLight(0x7fd8ff, 7, 24, 2);
    fill.position.set(0, 3.2, 8.5);
    this.scene.add(fill);

    this.scene.add(this.makeBackgroundStars());

    // --- post-processing ---------------------------------------------------
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Threshold matters more than strength here. At a low threshold the lit
    // snow and the brighter needles bloom too, which washes the whole tree
    // out; at ~1.0 only the genuinely emissive things (lights, star, glitter)
    // flare.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.55, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private makeBackgroundStars(): THREE.Points {
    const count = 900;
    const pos = new Float32Array(count * 3);
    const scale = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Spherical shell, biased above the horizon.
      const r = 42 + Math.random() * 28;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(1 - Math.random() * 1.45);
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = Math.abs(r * Math.cos(phi)) * 0.8 + 2;
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      scale[i] = 0.5 + Math.random() * 1.6;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));

    const mat = new THREE.PointsMaterial({
      size: 0.42,
      sizeAttenuation: true,
      map: makeGlowTexture(),
      color: 0xbcd4ff,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    return new THREE.Points(geo, mat);
  }

  setBloom(strength: number): void {
    this.bloom.strength = strength;
  }

  update(dt: number): void {
    this.elapsed += dt;
    // Slow drift gives the still scene some life without fighting the user.
    this.world.rotation.y = Math.sin(this.elapsed * 0.08) * 0.14;
    const { centreY } = Stage.FRAME;
    this.camera.position.set(
      Math.sin(this.elapsed * 0.11) * 0.55,
      centreY + 0.7 + Math.sin(this.elapsed * 0.17) * 0.16,
      this.distance
    );
    this.camera.lookAt(0, centreY, 0);
  }

  render(): void {
    this.composer.render();
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const aspect = w / h;

    this.camera.aspect = aspect;

    // Pull back far enough that both the full height and the full width of the
    // framing box fit — a portrait window is width-limited and would otherwise
    // crop the tree's skirts.
    const { halfHeight, halfWidth } = Stage.FRAME;
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const forHeight = halfHeight / tanHalfFov;
    const forWidth = halfWidth / (tanHalfFov * aspect);
    this.distance = Math.max(forHeight, forWidth) * 1.1;

    // Point sprites are sized in world units; this is the world→pixel factor
    // at unit depth, in device pixels (which is what gl_PointSize expects).
    const pixelRatio = this.renderer.getPixelRatio();
    POINT_SCALE.value = (h * pixelRatio * 0.5) / tanHalfFov;

    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
  }
}
