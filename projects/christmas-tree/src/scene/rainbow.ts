import * as THREE from 'three';

const VERT = /* glsl */ `
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vLocal;

  uniform float uInner;
  uniform float uOuter;
  uniform float uOpacity;

  const float PI = 3.14159265;

  vec3 hue2rgb(float h) {
    vec3 p = abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0;
    return clamp(p, 0.0, 1.0);
  }

  void main() {
    // The band is a flat half-annulus, so radius gives the colour and the
    // polar angle says how far along the arc we are.
    float r = length(vLocal.xy);
    float t = (r - uInner) / (uOuter - uInner);
    if (t < 0.0 || t > 1.0) discard;

    // Violet on the inside through to red on the outside, like the real thing.
    // Pulled toward white because fully saturated hues on an additive band
    // read as a cartoon decal rather than light in the air.
    vec3 col = mix(hue2rgb(mix(0.78, 0.0, t)), vec3(1.0), 0.22);

    // Soft on both edges so the band has no hard rim.
    float band = smoothstep(0.0, 0.16, t) * smoothstep(1.0, 0.84, t);

    // Fade out where the arc meets the ground, so it melts into the horizon
    // instead of ending in two cut-off stumps.
    float ang = atan(vLocal.y, vLocal.x);
    float ends = smoothstep(0.0, 0.55, ang) * smoothstep(PI, PI - 0.55, ang);

    gl_FragColor = vec4(col, band * ends * uOpacity);
  }
`;

type Phase = 'off' | 'in' | 'hold' | 'out';

/**
 * A rainbow arching over the scene behind the tree, summoned by drawing an arc
 * in the air. A flat half-annulus facing the camera: a real 3D bow would be
 * invisible from a fixed viewpoint, and the colours come from the fragment's
 * radius so one mesh covers all seven bands with no banding seams.
 */
export class Rainbow {
  readonly mesh: THREE.Mesh;

  private material: THREE.ShaderMaterial;
  private phase: Phase = 'off';
  private timer = 0;
  private opacity = 0;

  /** Sized and placed so the bow frames the tree instead of swamping it. */
  private static readonly INNER = 8.0;
  private static readonly OUTER = 10.2;
  /** Far enough back to sit behind the tree and read as sky, not scenery. */
  private static readonly DEPTH = -12;
  private static readonly FADE_IN = 0.7;
  private static readonly HOLD = 5;
  private static readonly FADE_OUT = 1.5;
  private static readonly PEAK_OPACITY = 0.4;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uInner: { value: Rainbow.INNER },
        uOuter: { value: Rainbow.OUTER },
        uOpacity: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      // Additive keeps it looking like light in the air rather than a painted
      // plane, and sidesteps sorting against the snow and sparkles.
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(
      // Half a ring: thetaStart 0, thetaLength π, so it spans the sky from the
      // ground on one side to the ground on the other.
      new THREE.RingGeometry(Rainbow.INNER, Rainbow.OUTER, 128, 1, 0, Math.PI),
      this.material
    );
    this.mesh.position.set(0, 0.1, Rainbow.DEPTH);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  get isVisible(): boolean {
    return this.phase !== 'off';
  }

  /** Arcs in, holds for `HOLD` seconds, then fades away. Re-arming restarts it. */
  show(): void {
    this.phase = 'in';
    this.timer = 0;
    this.mesh.visible = true;
  }

  reset(): void {
    this.phase = 'off';
    this.opacity = 0;
    this.material.uniforms.uOpacity.value = 0;
    this.mesh.visible = false;
  }

  update(dt: number): void {
    if (this.phase === 'off') return;

    this.timer += dt;
    let target = Rainbow.PEAK_OPACITY;

    switch (this.phase) {
      case 'in':
        target *= Math.min(1, this.timer / Rainbow.FADE_IN);
        if (this.timer >= Rainbow.FADE_IN) {
          this.phase = 'hold';
          this.timer = 0;
        }
        break;
      case 'hold':
        if (this.timer >= Rainbow.HOLD) {
          this.phase = 'out';
          this.timer = 0;
        }
        break;
      case 'out':
        target *= Math.max(0, 1 - this.timer / Rainbow.FADE_OUT);
        if (this.timer >= Rainbow.FADE_OUT) {
          this.reset();
          return;
        }
        break;
    }

    this.opacity = target;
    this.material.uniforms.uOpacity.value = this.opacity;
  }
}
