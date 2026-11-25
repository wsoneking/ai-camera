import * as THREE from 'three';
import { radiusAtFraction, TREE } from './tree';
import { makeGlowTexture } from './stage';

const BULB_COLORS = [0xffd9a0, 0xff7b6b, 0x8fd9ff, 0xaef5c4, 0xffe9f2, 0xffc45e];

interface Bulb {
  base: THREE.Color;
  phase: number;
  speed: number;
  /** Progress of the light string sweeping on, 0→1. */
  birth: number;
}

/**
 * A garland of fairy lights wound around the canopy. Rendered as emissive
 * spheres plus an additive sprite halo, so the bloom pass does the glowing.
 */
export class FairyLights {
  readonly group = new THREE.Group();

  private bulbs: Bulb[] = [];
  private mesh: THREE.InstancedMesh;
  private halos: THREE.Points;
  private haloColors: THREE.BufferAttribute;
  /** Flat xyz triples of every bulb's anchor on the helix. */
  private positions: Float32Array;

  private readonly count = 150;
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scl = new THREE.Vector3();
  private readonly color = new THREE.Color();

  private elapsed = 0;
  private reveal = 0;
  private on = false;

  constructor() {
    const positions = new Float32Array(this.count * 3);
    const colors = new Float32Array(this.count * 3);
    this.positions = positions;

    // 4.5 turns of a helix riding just outside the needle surface.
    const turns = 4.5;
    for (let i = 0; i < this.count; i++) {
      const t = i / (this.count - 1);
      const angle = t * turns * Math.PI * 2;
      const y = TREE.trunkHeight * 0.7 + t * (TREE.height * 0.9 - TREE.trunkHeight * 0.7);
      // Just outside the needle surface, like the ornaments, so the bulbs
      // are not buried in the foliage.
      const r = radiusAtFraction(y / TREE.height) * 1.02 + 0.13;

      positions[i * 3] = Math.cos(angle) * r;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(angle) * r;

      this.bulbs.push({
        base: new THREE.Color(BULB_COLORS[i % BULB_COLORS.length]),
        phase: Math.random() * Math.PI * 2,
        speed: 0.8 + Math.random() * 1.8,
        birth: t,
      });
    }

    const geo = new THREE.SphereGeometry(0.075, 10, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    const haloGeo = new THREE.BufferGeometry();
    haloGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.haloColors = new THREE.BufferAttribute(colors, 3);
    haloGeo.setAttribute('color', this.haloColors);
    this.halos = new THREE.Points(
      haloGeo,
      new THREE.PointsMaterial({
        size: 0.72,
        map: makeGlowTexture(),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
        toneMapped: false,
      })
    );
    this.group.add(this.halos);

    this.group.visible = false;
  }

  get isOn(): boolean {
    return this.on;
  }

  toggle(): boolean {
    this.on = !this.on;
    if (this.on) this.group.visible = true;
    return this.on;
  }

  reset(): void {
    this.on = false;
    this.reveal = 0;
    this.group.visible = false;
  }

  update(dt: number): void {
    this.elapsed += dt;

    const target = this.on ? 1 : 0;
    // Lights sweep on from the base over ~1s, and fade out a touch faster.
    this.reveal += (target - this.reveal) * Math.min(1, dt * (this.on ? 2.6 : 4.5));
    if (!this.on && this.reveal < 0.01) {
      this.group.visible = false;
      return;
    }

    const colors = this.haloColors.array as Float32Array;

    for (let i = 0; i < this.count; i++) {
      const b = this.bulbs[i];
      const lit = Math.max(0, Math.min(1, (this.reveal - b.birth * 0.75) / 0.25));
      // Each bulb breathes on its own clock so the string shimmers.
      const twinkle = 0.55 + 0.45 * Math.sin(this.elapsed * b.speed + b.phase);
      const strength = lit * (0.35 + twinkle * 0.95);

      this.pos.set(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]);
      this.scl.setScalar(lit * (0.75 + twinkle * 0.5));
      this.matrix.compose(this.pos, this.quat, this.scl);
      this.mesh.setMatrixAt(i, this.matrix);

      this.color.copy(b.base).multiplyScalar(strength);
      this.mesh.setColorAt(i, this.color);

      colors[i * 3] = this.color.r;
      colors[i * 3 + 1] = this.color.g;
      colors[i * 3 + 2] = this.color.b;
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    this.haloColors.needsUpdate = true;
  }
}
