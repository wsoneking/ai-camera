import * as THREE from 'three';
import { makeGlowTexture, POINT_SCALE } from './stage';

const SNOW_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  uniform float uTime;
  uniform float uSize;
  uniform float uScale;
  varying float vFade;

  void main() {
    vec3 p = position;
    // Drift sideways on a per-flake clock so the fall never looks like a grid.
    p.x += sin(uTime * 0.35 + aPhase) * 0.9;
    p.z += cos(uTime * 0.27 + aPhase * 1.7) * 0.7;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float depth = max(0.001, -mv.z);
    gl_Position = projectionMatrix * mv;
    // Capped: a flake drifting right past the lens would otherwise blow up
    // into a screen-filling blob.
    gl_PointSize = min(uSize * aSize * uScale / depth, 36.0);

    // Fade flakes near the ground, close to the lens, and far into the fog.
    vFade = smoothstep(0.0, 1.6, p.y)
      * smoothstep(1.5, 7.0, depth)
      * smoothstep(60.0, 18.0, depth);
  }
`;

const SNOW_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  varying float vFade;

  void main() {
    vec4 tex = texture2D(uMap, gl_PointCoord);
    gl_FragColor = vec4(uColor, tex.a * vFade * 0.8);
  }
`;

/**
 * Falling snow as a single Points draw, recycled by wrapping around in y.
 *
 * The pool is sized for a blizzard but only `BASE_COUNT` flakes are drawn at
 * rest; `surge()` opens the draw range up to the full pool and lets it ease
 * back down, which is how a celebration turns the weather up.
 */
export class Snow {
  readonly points: THREE.Points;

  private readonly count = 6400;
  private readonly velocities: Float32Array;
  private readonly bounds = { x: 26, y: 20, z: 24 };
  private readonly material: THREE.ShaderMaterial;
  private positions: THREE.BufferAttribute;
  /** 1 right after a celebration, easing to 0 over `SURGE_SECONDS`. */
  private surgeAmount = 0;

  /** Flakes drawn with no surge running. */
  private static readonly BASE_COUNT = 2600;
  private static readonly SURGE_SECONDS = 11;
  private static readonly BASE_SIZE = 0.075;

  constructor() {
    const pos = new Float32Array(this.count * 3);
    const size = new Float32Array(this.count);
    const phase = new Float32Array(this.count);
    this.velocities = new Float32Array(this.count);

    for (let i = 0; i < this.count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * this.bounds.x;
      pos[i * 3 + 1] = Math.random() * this.bounds.y;
      pos[i * 3 + 2] = (Math.random() - 0.5) * this.bounds.z;
      size[i] = 0.35 + Math.random() * 1.0;
      phase[i] = Math.random() * Math.PI * 2;
      this.velocities[i] = 0.35 + Math.random() * 0.75;
    }

    const geo = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(pos, 3);
    geo.setAttribute('position', this.positions);
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setDrawRange(0, Snow.BASE_COUNT);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 8, 0), 40);

    this.material = new THREE.ShaderMaterial({
      vertexShader: SNOW_VERT,
      fragmentShader: SNOW_FRAG,
      uniforms: {
        uTime: { value: 0 },
        // Flake diameter in world units.
        uSize: { value: Snow.BASE_SIZE },
        uScale: POINT_SCALE,
        uMap: { value: makeGlowTexture() },
        uColor: { value: new THREE.Color(0xdcebff) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }

  /**
   * Turns the snowfall up to a blizzard, then eases back to a gentle drift.
   * The extra flakes are respawned high above the scene so they cascade in
   * from the top rather than popping into existence mid-air.
   */
  surge(): void {
    const arr = this.positions.array as Float32Array;
    for (let i = Snow.BASE_COUNT; i < this.count; i++) {
      arr[i * 3] = (Math.random() - 0.5) * this.bounds.x;
      arr[i * 3 + 1] = this.bounds.y * (0.75 + Math.random() * 1.6);
      arr[i * 3 + 2] = (Math.random() - 0.5) * this.bounds.z;
    }
    this.positions.needsUpdate = true;
    this.surgeAmount = 1;
  }

  update(dt: number, elapsed: number): void {
    this.material.uniforms.uTime.value = elapsed;

    this.surgeAmount = Math.max(0, this.surgeAmount - dt / Snow.SURGE_SECONDS);
    // Smoothstep so the blizzard ramps out instead of switching off.
    const s = this.surgeAmount * this.surgeAmount * (3 - 2 * this.surgeAmount);
    this.points.geometry.setDrawRange(
      0,
      Math.round(Snow.BASE_COUNT + (this.count - Snow.BASE_COUNT) * s)
    );
    this.material.uniforms.uSize.value = Snow.BASE_SIZE * (1 + s * 0.45);
    const speed = 1 + s * 1.1;

    const arr = this.positions.array as Float32Array;

    // Every flake keeps falling, drawn or not, so widening the draw range
    // reveals a live snowfall rather than a frozen one.
    for (let i = 0; i < this.count; i++) {
      const y = arr[i * 3 + 1] - this.velocities[i] * speed * dt;
      if (y < -0.4) {
        // Respawn at the top at a fresh x/z.
        arr[i * 3] = (Math.random() - 0.5) * this.bounds.x;
        arr[i * 3 + 1] = this.bounds.y;
        arr[i * 3 + 2] = (Math.random() - 0.5) * this.bounds.z;
      } else {
        arr[i * 3 + 1] = y;
      }
    }
    this.positions.needsUpdate = true;
  }
}

/**
 * The glowing bead that sits on the user's fingertip while they are pointing,
 * so the glitter visibly has a source. Fades itself in and out.
 */
export class MagicOrb {
  readonly group = new THREE.Group();

  private sprite: THREE.Sprite;
  private light: THREE.PointLight;
  private material: THREE.SpriteMaterial;
  private visible = false;
  private strength = 0;

  constructor() {
    this.material = new THREE.SpriteMaterial({
      map: makeGlowTexture(),
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.light = new THREE.PointLight(0xffffff, 0, 5, 2);
    this.group.add(this.sprite, this.light);
    this.group.visible = false;
  }

  show(at: THREE.Vector3, color: THREE.Color): void {
    this.group.visible = true;
    this.group.position.copy(at);
    this.material.color.copy(color);
    this.light.color.copy(color);
    this.visible = true;
  }

  hide(): void {
    this.visible = false;
  }

  update(dt: number, elapsed: number): void {
    const target = this.visible ? 1 : 0;
    this.strength += (target - this.strength) * Math.min(1, dt * 12);
    if (this.strength < 0.01 && !this.visible) {
      this.group.visible = false;
      return;
    }
    const pulse = 0.85 + 0.15 * Math.sin(elapsed * 9);
    // Sprite scale is a world-space diameter; keep the bead small relative to
    // the tree so it reads as a spark on the fingertip, not a floating moon.
    this.sprite.scale.setScalar(this.strength * pulse * 0.45);
    this.material.opacity = this.strength * 0.95;
    this.light.intensity = this.strength * 6 * pulse;
  }
}

const SPARKLE_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aLife;   // 1 at birth → 0 at death
  attribute float aSeed;

  uniform float uTime;
  uniform float uScale;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vSpin;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    float age = 1.0 - aLife;
    // Snap in, then shrink along a soft curve.
    float pop = smoothstep(0.0, 0.09, age);
    float decay = pow(aLife, 0.55);
    // Fast per-particle flicker is what sells "glitter" over "dots".
    float flicker = 0.62 + 0.38 * sin(uTime * 22.0 + aSeed * 43.0);

    float s = aSize * pop * decay * flicker;
    gl_PointSize = s * uScale / max(0.001, -mv.z);

    // White-hot at birth, settling into its own colour, then dimming out.
    vColor = mix(aColor, vec3(1.0), pow(aLife, 4.0) * 0.85);
    vAlpha = decay * flicker;
    vSpin = aSeed * 6.2831;
  }
`;

const SPARKLE_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSpin;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;

    // Rotate the flare spokes per particle so they don't all align.
    float c = cos(vSpin);
    float s = sin(vSpin);
    vec2 r = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);

    float d = length(uv);
    if (d > 0.5) discard;

    float core = exp(-d * d * 90.0);
    float halo = exp(-d * d * 11.0) * 0.4;
    // Four-point starburst: two crossed streaks, faded toward the edge.
    float streak = max(0.0, 1.0 - abs(r.x) * 26.0) + max(0.0, 1.0 - abs(r.y) * 26.0);
    streak *= smoothstep(0.5, 0.02, d) * 0.55;

    float a = (core + halo + streak) * vAlpha;
    // Overdrive the core so the bloom pass turns it into a real flare.
    gl_FragColor = vec4(vColor * (1.0 + core * 2.2), a);
  }
`;

/** Base glitter diameter in world units; `size` in the options scales this. */
const SPARKLE_BASE_SIZE = 0.11;

export interface SparkleOptions {
  color: THREE.ColorRepresentation;
  count?: number;
  /** Initial speed in units/sec. */
  speed?: number;
  size?: number;
  life?: number;
  /** Positive falls, negative floats upward. */
  gravity?: number;
  /** Rotation rate around the spawn point's vertical axis. */
  swirl?: number;
  /** Extra velocity added to every particle, e.g. the hand's motion. */
  inherit?: THREE.Vector3;
}

/**
 * Shader-driven magic glitter. Each particle spirals around its own spawn
 * point, flickers on its own clock, starts white-hot and cools into its
 * colour. Used for the finger trail and for celebratory bursts.
 */
export class Sparkles {
  readonly points: THREE.Points;

  private readonly capacity = 1600;
  private readonly vel: Float32Array;
  private readonly origin: Float32Array;
  private readonly grav: Float32Array;
  private readonly swirl: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly remaining: Float32Array;

  private positions: THREE.BufferAttribute;
  private colors: THREE.BufferAttribute;
  private sizes: THREE.BufferAttribute;
  private lives: THREE.BufferAttribute;
  private material: THREE.ShaderMaterial;
  private cursor = 0;

  private readonly scratch = new THREE.Color();
  private readonly segment = new THREE.Vector3();

  constructor() {
    const n = this.capacity;
    const pos = new Float32Array(n * 3);
    pos.fill(9999);

    this.vel = new Float32Array(n * 3);
    this.origin = new Float32Array(n * 3);
    this.grav = new Float32Array(n);
    this.swirl = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.remaining = new Float32Array(n);

    this.positions = new THREE.BufferAttribute(pos, 3);
    this.colors = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.sizes = new THREE.BufferAttribute(new Float32Array(n), 1);
    this.lives = new THREE.BufferAttribute(new Float32Array(n), 1);
    const seeds = new Float32Array(n);
    for (let i = 0; i < n; i++) seeds[i] = Math.random();

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', this.positions);
    geo.setAttribute('aColor', this.colors);
    geo.setAttribute('aSize', this.sizes);
    geo.setAttribute('aLife', this.lives);
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 4, 0), 60);

    this.material = new THREE.ShaderMaterial({
      vertexShader: SPARKLE_VERT,
      fragmentShader: SPARKLE_FRAG,
      uniforms: { uTime: { value: 0 }, uScale: POINT_SCALE },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }

  private spawn(at: THREE.Vector3, o: Required<Omit<SparkleOptions, 'inherit'>> & {
    inherit?: THREE.Vector3;
  }): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;

    const pos = this.positions.array as Float32Array;
    const col = this.colors.array as Float32Array;
    const size = this.sizes.array as Float32Array;
    const life = this.lives.array as Float32Array;

    pos[i * 3] = at.x;
    pos[i * 3 + 1] = at.y;
    pos[i * 3 + 2] = at.z;
    this.origin[i * 3] = at.x;
    this.origin[i * 3 + 1] = at.y;
    this.origin[i * 3 + 2] = at.z;

    // Random direction, biased upward so dust puffs outward and then falls.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(1 - Math.random() * 1.5);
    const speed = o.speed * (0.25 + Math.random() * 1.1);
    this.vel[i * 3] = Math.sin(phi) * Math.cos(theta) * speed;
    this.vel[i * 3 + 1] = Math.abs(Math.cos(phi)) * speed * 0.9 + o.speed * 0.15;
    this.vel[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed;

    if (o.inherit) {
      this.vel[i * 3] += o.inherit.x;
      this.vel[i * 3 + 1] += o.inherit.y;
      this.vel[i * 3 + 2] += o.inherit.z;
    }

    // Hue jitter keeps a single-colour emitter from looking flat.
    this.scratch.set(o.color);
    this.scratch.offsetHSL((Math.random() - 0.5) * 0.12, 0, (Math.random() - 0.5) * 0.15);
    col[i * 3] = this.scratch.r;
    col[i * 3 + 1] = this.scratch.g;
    col[i * 3 + 2] = this.scratch.b;

    size[i] = o.size * SPARKLE_BASE_SIZE * (0.45 + Math.random() * 1.1);
    // A third of the dust floats instead of falling — reads as magic, not debris.
    this.grav[i] = Math.random() < 0.33 ? -o.gravity * 0.35 : o.gravity;
    this.swirl[i] = o.swirl * (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random());

    this.maxLife[i] = o.life * (0.6 + Math.random() * 0.8);
    this.remaining[i] = this.maxLife[i];
    life[i] = 1;
  }

  private static defaults(o: SparkleOptions) {
    return {
      color: o.color,
      count: o.count ?? 24,
      speed: o.speed ?? 1.6,
      size: o.size ?? 1,
      life: o.life ?? 1.1,
      gravity: o.gravity ?? 1.9,
      swirl: o.swirl ?? 2.2,
      inherit: o.inherit,
    };
  }

  /** Radial burst, for celebratory moments. */
  burst(at: THREE.Vector3, options: SparkleOptions): void {
    const o = Sparkles.defaults(options);
    for (let n = 0; n < o.count; n++) this.spawn(at, o);
    this.flushSpawn();
  }

  /**
   * Emits along the segment the emitter travelled this frame, so a fast swipe
   * leaves a continuous ribbon instead of dotted clumps.
   */
  trail(from: THREE.Vector3, to: THREE.Vector3, options: SparkleOptions): void {
    const o = Sparkles.defaults(options);
    for (let n = 0; n < o.count; n++) {
      this.segment.lerpVectors(from, to, (n + Math.random()) / o.count);
      this.spawn(this.segment, o);
    }
    this.flushSpawn();
  }

  private flushSpawn(): void {
    this.positions.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.sizes.needsUpdate = true;
    this.lives.needsUpdate = true;
  }

  update(dt: number, elapsed: number): void {
    this.material.uniforms.uTime.value = elapsed;

    const pos = this.positions.array as Float32Array;
    const life = this.lives.array as Float32Array;
    let dirty = false;

    for (let i = 0; i < this.capacity; i++) {
      if (this.remaining[i] <= 0) continue;
      dirty = true;

      this.remaining[i] -= dt;
      if (this.remaining[i] <= 0) {
        pos[i * 3] = pos[i * 3 + 1] = pos[i * 3 + 2] = 9999;
        life[i] = 0;
        continue;
      }
      life[i] = this.remaining[i] / this.maxLife[i];

      // Spiral around the spawn point's vertical axis.
      const dx = pos[i * 3] - this.origin[i * 3];
      const dz = pos[i * 3 + 2] - this.origin[i * 3 + 2];
      const k = this.swirl[i] * dt;
      this.vel[i * 3] += -dz * k;
      this.vel[i * 3 + 2] += dx * k;

      this.vel[i * 3 + 1] -= this.grav[i] * dt;

      const drag = 1 - Math.min(0.9, dt * 1.6);
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 1] *= drag;
      this.vel[i * 3 + 2] *= drag;

      pos[i * 3] += this.vel[i * 3] * dt;
      pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }

    if (dirty) {
      this.positions.needsUpdate = true;
      this.lives.needsUpdate = true;
    }
  }
}
