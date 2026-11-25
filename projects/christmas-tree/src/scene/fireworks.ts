import * as THREE from 'three';
import { POINT_SCALE } from './stage';

const VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aLife;   // 1 at birth → 0 at death
  attribute float aSeed;

  uniform float uTime;
  uniform float uScale;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    // Each ember twinkles on its own clock, which is most of what sells a
    // firework over a plain expanding dot cloud.
    float twinkle = 0.45 + 0.55 * sin(uTime * 24.0 + aSeed * 61.0);
    // Embers shrink as they cool, but never to nothing before they fade out.
    float shrink = 0.35 + 0.65 * aLife;
    gl_PointSize = min(aSize * shrink * uScale / max(0.001, -mv.z), 48.0);

    // White-hot at the flash, cooling into the shell's colour.
    vColor = mix(aColor, vec3(1.0), pow(aLife, 3.0) * 0.85);
    vAlpha = pow(aLife, 0.75) * twinkle;
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;

    float core = exp(-d * d * 70.0);
    float halo = exp(-d * d * 9.0) * 0.45;
    float a = (core + halo) * vAlpha;
    // Overdriven core so the bloom pass turns each ember into a real flare.
    gl_FragColor = vec4(vColor * (1.0 + core * 2.6), a);
  }
`;

/** Shell colours, picked to stay distinct against the blue night sky. */
const SHELL_COLORS = [
  0xff3b5c, // red
  0xffd34d, // gold
  0x5ed1ff, // ice blue
  0xa66bff, // violet
  0x5bff9d, // mint
  0xff8a3d, // tangerine
  0xfff3c4, // warm white
];

interface Rocket {
  /** Seconds before this shell launches. */
  delay: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Seconds of climb left before the shell bursts. */
  fuse: number;
  color: THREE.Color;
  /** Accumulator so the trail emits at a fixed rate, not per frame. */
  emit: number;
}

/**
 * Firework shells: a rocket climbs leaving a spark trail, then bursts into a
 * twinkling shell of embers that arc down under gravity. All embers from all
 * shells live in one pooled Points draw.
 */
export class Fireworks {
  readonly points: THREE.Points;

  private readonly capacity = 4200;
  private readonly vel: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly remaining: Float32Array;

  private positions: THREE.BufferAttribute;
  private colors: THREE.BufferAttribute;
  private sizes: THREE.BufferAttribute;
  private lives: THREE.BufferAttribute;
  private material: THREE.ShaderMaterial;
  private cursor = 0;

  private rockets: Rocket[] = [];
  private readonly scratch = new THREE.Color();

  constructor() {
    const n = this.capacity;
    const pos = new Float32Array(n * 3);
    pos.fill(9999);

    this.vel = new Float32Array(n * 3);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);
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
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 10, 0), 70);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTime: { value: 0 }, uScale: POINT_SCALE },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }

  /** Launches `count` shells over the next couple of seconds. */
  show(count = 5): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 3 + Math.random() * 4.5;
      this.rockets.push({
        delay: i * 0.32 + Math.random() * 0.22,
        position: new THREE.Vector3(
          Math.cos(angle) * radius,
          0.5,
          Math.sin(angle) * radius * 0.6 - 2
        ),
        // Climb and fuse are tuned together so the shells burst around head
        // height of the treetop — any higher and the camera crops the flower.
        velocity: new THREE.Vector3(
          (Math.random() - 0.5) * 1.4,
          7.0 + Math.random() * 1.8,
          (Math.random() - 0.5) * 1.0
        ),
        fuse: 0.85 + Math.random() * 0.3,
        color: new THREE.Color(SHELL_COLORS[(Math.random() * SHELL_COLORS.length) | 0]),
        emit: 0,
      });
    }
  }

  /** True while any shell is still waiting to launch or climbing. */
  get isBusy(): boolean {
    return this.rockets.length > 0;
  }

  clear(): void {
    this.rockets.length = 0;
    const pos = this.positions.array as Float32Array;
    pos.fill(9999);
    this.remaining.fill(0);
    (this.lives.array as Float32Array).fill(0);
    this.positions.needsUpdate = true;
    this.lives.needsUpdate = true;
  }

  private spawn(
    at: THREE.Vector3,
    vx: number,
    vy: number,
    vz: number,
    color: THREE.Color,
    size: number,
    life: number,
    gravity: number,
    drag: number
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;

    const pos = this.positions.array as Float32Array;
    const col = this.colors.array as Float32Array;
    const sizes = this.sizes.array as Float32Array;
    const lives = this.lives.array as Float32Array;

    pos[i * 3] = at.x;
    pos[i * 3 + 1] = at.y;
    pos[i * 3 + 2] = at.z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;

    // Per-ember hue jitter keeps a single-colour shell from looking printed on.
    this.scratch.copy(color).offsetHSL((Math.random() - 0.5) * 0.07, 0, (Math.random() - 0.5) * 0.12);
    col[i * 3] = this.scratch.r;
    col[i * 3 + 1] = this.scratch.g;
    col[i * 3 + 2] = this.scratch.b;

    sizes[i] = size;
    this.grav[i] = gravity;
    this.drag[i] = drag;
    this.maxLife[i] = life;
    this.remaining[i] = life;
    lives[i] = 1;
  }

  private burst(rocket: Rocket): void {
    const count = 170 + ((Math.random() * 90) | 0);
    // Speed against drag sets the flower's radius: ~2.5 world units, which is
    // about a third of the tree's height and fits the frame at this altitude.
    const speed = 4.2 + Math.random() * 1.6;
    // Flat-ish rings read better from a fixed camera than perfect spheres, so
    // the shell is squashed slightly along z.
    for (let i = 0; i < count; i++) {
      // Even sphere sampling; without the acos the embers bunch at the poles.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(1 - 2 * Math.random());
      // A spread of speeds fills the shell instead of leaving it hollow.
      const s = speed * (0.55 + Math.random() * 0.55);
      this.spawn(
        rocket.position,
        Math.sin(phi) * Math.cos(theta) * s,
        Math.cos(phi) * s + rocket.velocity.y * 0.12,
        Math.sin(phi) * Math.sin(theta) * s * 0.7,
        rocket.color,
        0.085 * (0.6 + Math.random() * 0.9),
        1.3 + Math.random() * 0.9,
        3.4,
        1.9
      );
    }

    // A handful of slow, long-lived glitter embers that linger and drift down.
    for (let i = 0; i < 26; i++) {
      const theta = Math.random() * Math.PI * 2;
      this.spawn(
        rocket.position,
        Math.cos(theta) * 1.2,
        Math.random() * 1.0,
        Math.sin(theta) * 0.9,
        rocket.color,
        0.07,
        2.4 + Math.random() * 1.4,
        1.0,
        0.6
      );
    }
  }

  update(dt: number, elapsed: number): void {
    this.material.uniforms.uTime.value = elapsed;

    // ---- rockets -----------------------------------------------------------
    for (let r = this.rockets.length - 1; r >= 0; r--) {
      const rocket = this.rockets[r];
      if (rocket.delay > 0) {
        rocket.delay -= dt;
        continue;
      }

      rocket.velocity.y -= 4.2 * dt;
      rocket.position.addScaledVector(rocket.velocity, dt);

      // Trail at a fixed rate so it looks the same at any frame rate.
      rocket.emit += dt;
      while (rocket.emit > 0.012) {
        rocket.emit -= 0.012;
        this.spawn(
          rocket.position,
          (Math.random() - 0.5) * 0.7,
          -0.6 - Math.random() * 0.8,
          (Math.random() - 0.5) * 0.7,
          rocket.color,
          0.055,
          0.32 + Math.random() * 0.22,
          1.6,
          2.4
        );
      }

      rocket.fuse -= dt;
      if (rocket.fuse <= 0) {
        this.burst(rocket);
        this.rockets.splice(r, 1);
      }
    }

    // ---- embers ------------------------------------------------------------
    const pos = this.positions.array as Float32Array;
    const lives = this.lives.array as Float32Array;
    let dirty = false;

    for (let i = 0; i < this.capacity; i++) {
      if (this.remaining[i] <= 0) continue;
      dirty = true;

      this.remaining[i] -= dt;
      if (this.remaining[i] <= 0) {
        pos[i * 3] = pos[i * 3 + 1] = pos[i * 3 + 2] = 9999;
        lives[i] = 0;
        continue;
      }
      lives[i] = this.remaining[i] / this.maxLife[i];

      this.vel[i * 3 + 1] -= this.grav[i] * dt;

      const k = 1 - Math.min(0.9, this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] *= k;
      this.vel[i * 3 + 2] *= k;

      pos[i * 3] += this.vel[i * 3] * dt;
      pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }

    if (dirty || this.rockets.length > 0) {
      this.positions.needsUpdate = true;
      this.colors.needsUpdate = true;
      this.sizes.needsUpdate = true;
      this.lives.needsUpdate = true;
    }
  }
}
