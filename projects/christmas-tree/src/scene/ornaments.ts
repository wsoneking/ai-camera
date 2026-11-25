import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeGlowTexture, POINT_SCALE } from './stage';

/**
 * Saturated jewel tones only. Pearl/white baubles were getting lost against
 * the snow and the frosted branch tips.
 */
const PALETTE = [
  0xe01b3c, // crimson
  0xffb01f, // amber
  0x1f6feb, // sapphire
  0x00c9b1, // teal
  0x9b3dff, // violet
  0x12b886, // emerald
  0xff4f94, // magenta
  0xffd43b, // gold
];

export const ORNAMENT_CAPACITY = 220;

interface Ornament {
  from: THREE.Vector3;
  to: THREE.Vector3;
  normal: THREE.Vector3;
  /** Flight progress 0→1; reaches 1 when the bauble is hung. */
  flight: number;
  flightSpeed: number;
  radius: number;
  spin: number;
  bobPhase: number;
  color: THREE.Color;
}

/**
 * All hung baubles in three instanced/batched draws: the glass sphere, its
 * gold cap, and an additive halo that makes each one pop against the dark
 * foliage (the bloom pass picks the halo up).
 */
export class Ornaments {
  readonly group = new THREE.Group();

  private mesh: THREE.InstancedMesh;
  private caps: THREE.InstancedMesh;
  private halos: THREE.Points;
  private haloPos: THREE.BufferAttribute;
  private haloColor: THREE.BufferAttribute;
  private haloSize: THREE.BufferAttribute;

  private items: Ornament[] = [];
  private elapsed = 0;

  private readonly matrix = new THREE.Matrix4();
  private readonly capMatrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly capPos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scl = new THREE.Vector3();
  private readonly euler = new THREE.Euler();
  private readonly control = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor() {
    const geo = new THREE.SphereGeometry(1, 28, 20);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0.35,
      roughness: 0.06,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      // Pushed up so the baubles catch a crisp highlight and read as glass
      // even where the foliage behind them is in shadow.
      envMapIntensity: 2.4,
      sheen: 0.4,
      sheenRoughness: 0.3,
      sheenColor: 0xffffff,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, ORNAMENT_CAPACITY);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;

    // Little brass cap + hanging loop: the detail that makes a sphere read as
    // an ornament rather than a ball.
    const capBody = new THREE.CylinderGeometry(0.34, 0.42, 0.34, 12, 1);
    capBody.translate(0, 0.17, 0);
    const capLoop = new THREE.TorusGeometry(0.2, 0.055, 6, 14);
    capLoop.rotateY(Math.PI / 2);
    capLoop.translate(0, 0.46, 0);
    const capGeo = mergeGeometries([capBody, capLoop])!;

    this.caps = new THREE.InstancedMesh(
      capGeo,
      new THREE.MeshStandardMaterial({
        color: 0xd9ab52,
        metalness: 1,
        roughness: 0.28,
        envMapIntensity: 1.8,
      }),
      ORNAMENT_CAPACITY
    );
    this.caps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.caps.castShadow = true;
    this.caps.frustumCulled = false;
    this.caps.count = 0;

    const haloGeo = new THREE.BufferGeometry();
    this.haloPos = new THREE.BufferAttribute(new Float32Array(ORNAMENT_CAPACITY * 3), 3);
    this.haloColor = new THREE.BufferAttribute(new Float32Array(ORNAMENT_CAPACITY * 3), 3);
    this.haloSize = new THREE.BufferAttribute(new Float32Array(ORNAMENT_CAPACITY), 1);
    haloGeo.setAttribute('position', this.haloPos);
    haloGeo.setAttribute('aColor', this.haloColor);
    haloGeo.setAttribute('aSize', this.haloSize);
    haloGeo.setDrawRange(0, 0);
    haloGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 3, 0), 12);

    this.halos = new THREE.Points(
      haloGeo,
      new THREE.ShaderMaterial({
        uniforms: { uMap: { value: makeGlowTexture() }, uScale: POINT_SCALE },
        vertexShader: /* glsl */ `
          attribute vec3 aColor;
          attribute float aSize;
          uniform float uScale;
          varying vec3 vColor;
          void main() {
            vColor = aColor;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = aSize * uScale / max(0.001, -mv.z);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D uMap;
          varying vec3 vColor;
          void main() {
            float a = texture2D(uMap, gl_PointCoord).a;
            gl_FragColor = vec4(vColor, a * 0.42);
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.halos.frustumCulled = false;

    this.group.add(this.mesh, this.caps, this.halos);
  }

  get count(): number {
    return this.items.length;
  }

  get isFull(): boolean {
    return this.items.length >= ORNAMENT_CAPACITY;
  }

  /**
   * Hangs a new bauble that flies in from `from` and lands at `to`.
   * Returns the colour it was given, or null if the tree is full.
   */
  add(
    from: THREE.Vector3,
    to: THREE.Vector3,
    normal: THREE.Vector3,
    size = 1
  ): THREE.Color | null {
    if (this.isFull) return null;

    const index = this.items.length;
    this.color.setHex(PALETTE[index % PALETTE.length]);
    // Nudge the hue/lightness per instance so repeats never look like copies.
    this.color.offsetHSL((Math.random() - 0.5) * 0.04, 0, (Math.random() - 0.5) * 0.08);

    this.items.push({
      from: from.clone(),
      to: to.clone(),
      normal: normal.clone(),
      flight: 0,
      flightSpeed: 1.5 + Math.random() * 0.5,
      // Roughly a tenth of the tree's base radius. Anything much larger and a
      // handful of baubles visually swallows the whole tree.
      radius: (0.1 + Math.random() * 0.038) * size,
      spin: (Math.random() - 0.5) * 0.9,
      bobPhase: Math.random() * Math.PI * 2,
      color: this.color.clone(),
    });

    this.mesh.setColorAt(index, this.color);
    this.mesh.instanceColor!.needsUpdate = true;
    this.mesh.count = this.items.length;
    this.caps.count = this.items.length;

    const halo = this.haloColor.array as Float32Array;
    halo[index * 3] = this.color.r;
    halo[index * 3 + 1] = this.color.g;
    halo[index * 3 + 2] = this.color.b;
    this.haloColor.needsUpdate = true;
    this.halos.geometry.setDrawRange(0, this.items.length);

    return this.items[index].color;
  }

  /**
   * Removes every bauble and returns where each one was hanging (in tree-local
   * space), so the caller can play a farewell effect at those spots.
   */
  clear(): THREE.Vector3[] {
    const spots = this.items.map((o) => o.to.clone());
    this.items.length = 0;
    this.mesh.count = 0;
    this.caps.count = 0;
    this.halos.geometry.setDrawRange(0, 0);
    return spots;
  }

  /** Cubic ease-out — fast launch, soft landing. */
  private static easeOut(x: number): number {
    return 1 - Math.pow(1 - x, 3);
  }

  update(dt: number): void {
    this.elapsed += dt;
    if (this.items.length === 0) return;

    const haloPos = this.haloPos.array as Float32Array;
    const haloSize = this.haloSize.array as Float32Array;

    for (let i = 0; i < this.items.length; i++) {
      const o = this.items[i];

      if (o.flight < 1) {
        o.flight = Math.min(1, o.flight + dt * o.flightSpeed);
        const e = Ornaments.easeOut(o.flight);

        // Arc through a lifted control point so the throw feels physical.
        this.control
          .addVectors(o.from, o.to)
          .multiplyScalar(0.5)
          .addScaledVector(o.normal, 0.6);
        this.control.y += 0.9;

        const inv = 1 - e;
        this.pos
          .copy(o.from)
          .multiplyScalar(inv * inv)
          .addScaledVector(this.control, 2 * inv * e)
          .addScaledVector(o.to, e * e);

        // Pop in, slightly overshoot, settle.
        const grow = Math.min(1, o.flight / 0.35);
        const overshoot = 1 + Math.sin(Math.min(1, o.flight) * Math.PI) * 0.3;
        this.scl.setScalar(o.radius * grow * overshoot);
      } else {
        const bob = Math.sin(this.elapsed * 1.6 + o.bobPhase);
        this.pos.copy(o.to);
        this.pos.y += bob * 0.012;
        this.pos.x += Math.cos(this.elapsed * 0.9 + o.bobPhase) * 0.006;
        this.scl.setScalar(o.radius);
      }

      this.euler.set(
        Math.sin(this.elapsed * 0.4 + o.bobPhase) * 0.2,
        this.elapsed * o.spin,
        Math.cos(this.elapsed * 0.5 + o.bobPhase) * 0.15
      );
      this.quat.setFromEuler(this.euler);

      this.matrix.compose(this.pos, this.quat, this.scl);
      this.mesh.setMatrixAt(i, this.matrix);

      // Cap sits on top of the sphere, always upright.
      this.capPos.copy(this.pos);
      this.capPos.y += this.scl.x * 0.88;
      this.capMatrix.makeScale(this.scl.x, this.scl.x, this.scl.x);
      this.capMatrix.setPosition(this.capPos);
      this.caps.setMatrixAt(i, this.capMatrix);

      haloPos[i * 3] = this.pos.x;
      haloPos[i * 3 + 1] = this.pos.y;
      haloPos[i * 3 + 2] = this.pos.z;
      // Halo breathes gently and is proportional to the bauble.
      haloSize[i] = this.scl.x * (2.4 + Math.sin(this.elapsed * 1.3 + o.bobPhase) * 0.35);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this.caps.instanceMatrix.needsUpdate = true;
    this.haloPos.needsUpdate = true;
    this.haloSize.needsUpdate = true;
  }
}
