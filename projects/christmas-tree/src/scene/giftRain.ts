import * as THREE from 'three';

/** Wrapping paper / ribbon pairs. Mirrors the palette of the static presents. */
const WRAPS = [
  { paper: 0xb3121f, ribbon: 0xe8c56a },
  { paper: 0x11543a, ribbon: 0xf0e6d2 },
  { paper: 0x1b3a6b, ribbon: 0xc9d7ea },
  { paper: 0xe6dac2, ribbon: 0xc0392b },
  { paper: 0x6b2742, ribbon: 0xe8c56a },
  { paper: 0x0f5e63, ribbon: 0xf0e6d2 },
];

const CAPACITY = 48;

interface Parcel {
  alive: boolean;
  /** Seconds before the parcel enters the frame. */
  delay: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Tumble rate while airborne, in rad/s. */
  spin: THREE.Vector3;
  rotation: THREE.Euler;
  size: THREE.Vector3;
  /** Resting height of the box centre. */
  rest: number;
  /** Set once the box has stopped bouncing and is settling flat. */
  landed: boolean;
}

/**
 * Presents raining out of the sky, tumbling as they fall and bouncing to a
 * stop on the snow. Drawn as three instanced meshes — box, and two crossing
 * ribbon bands — so the whole shower costs three draw calls.
 *
 * Lives in stage space, like the static `Gifts`, so the parcels stay put on
 * the ground when the tree spins.
 */
export class GiftRain {
  readonly group = new THREE.Group();

  private box: THREE.InstancedMesh;
  private bandA: THREE.InstancedMesh;
  private bandB: THREE.InstancedMesh;

  private parcels: Parcel[] = [];
  private cursor = 0;

  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor() {
    const geo = new THREE.BoxGeometry(1, 1, 1);

    this.box = new THREE.InstancedMesh(
      geo,
      new THREE.MeshStandardMaterial({ roughness: 0.68, metalness: 0.03 }),
      CAPACITY
    );
    this.bandA = new THREE.InstancedMesh(
      geo,
      new THREE.MeshStandardMaterial({ roughness: 0.34, metalness: 0.55, envMapIntensity: 1.2 }),
      CAPACITY
    );
    this.bandB = new THREE.InstancedMesh(
      geo,
      new THREE.MeshStandardMaterial({ roughness: 0.34, metalness: 0.55, envMapIntensity: 1.2 }),
      CAPACITY
    );

    for (const mesh of [this.box, this.bandA, this.bandB]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Instance colours are assigned on spawn; allocate the buffer up front.
      mesh.setColorAt(0, new THREE.Color(0xffffff));
      this.group.add(mesh);
    }

    for (let i = 0; i < CAPACITY; i++) {
      this.parcels.push({
        alive: false,
        delay: 0,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        rotation: new THREE.Euler(),
        size: new THREE.Vector3(0.5, 0.4, 0.5),
        rest: 0.2,
        landed: false,
      });
      this.box.setMatrixAt(i, this.hidden);
      this.bandA.setMatrixAt(i, this.hidden);
      this.bandB.setMatrixAt(i, this.hidden);
    }

    // The pool is always fully drawn; dead slots carry a zero-scale matrix,
    // which keeps `count` stable and avoids reshuffling live parcels.
    for (const mesh of [this.box, this.bandA, this.bandB]) mesh.count = CAPACITY;
  }

  /** Drops `count` parcels from the sky, staggered over about a second. */
  burst(count = 18): void {
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % CAPACITY;
      const p = this.parcels[i];

      // Kept clear of the trunk so parcels do not fall through the branches,
      // and squashed along z so none of them land in the camera's lap.
      const angle = Math.random() * Math.PI * 2;
      const radius = 2.7 + Math.random() * 4.2;
      const w = 0.4 + Math.random() * 0.42;
      const h = 0.3 + Math.random() * 0.34;
      const d = 0.4 + Math.random() * 0.42;

      p.alive = true;
      p.landed = false;
      p.delay = Math.random() * 1.0;
      p.size.set(w, h, d);
      p.rest = h / 2;
      p.position.set(
        Math.cos(angle) * radius,
        14 + Math.random() * 8,
        Math.sin(angle) * radius * 0.55
      );
      p.velocity.set(0, -1.5 - Math.random() * 1.5, 0);
      p.spin.set(
        (Math.random() - 0.5) * 5,
        (Math.random() - 0.5) * 5,
        (Math.random() - 0.5) * 5
      );
      p.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);

      const wrap = WRAPS[(Math.random() * WRAPS.length) | 0];
      this.box.setColorAt(i, new THREE.Color(wrap.paper));
      this.bandA.setColorAt(i, new THREE.Color(wrap.ribbon));
      this.bandB.setColorAt(i, new THREE.Color(wrap.ribbon));
    }

    this.box.instanceColor!.needsUpdate = true;
    this.bandA.instanceColor!.needsUpdate = true;
    this.bandB.instanceColor!.needsUpdate = true;
    this.group.visible = true;
  }

  reset(): void {
    for (let i = 0; i < CAPACITY; i++) {
      this.parcels[i].alive = false;
      this.box.setMatrixAt(i, this.hidden);
      this.bandA.setMatrixAt(i, this.hidden);
      this.bandB.setMatrixAt(i, this.hidden);
    }
    this.flush();
    this.group.visible = false;
  }

  get count(): number {
    return this.parcels.reduce((n, p) => n + (p.alive ? 1 : 0), 0);
  }

  private flush(): void {
    this.box.instanceMatrix.needsUpdate = true;
    this.bandA.instanceMatrix.needsUpdate = true;
    this.bandB.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    let dirty = false;

    for (let i = 0; i < CAPACITY; i++) {
      const p = this.parcels[i];
      if (!p.alive) continue;

      if (p.delay > 0) {
        p.delay -= dt;
        continue;
      }
      dirty = true;

      if (!p.landed) {
        p.velocity.y -= 11 * dt;
        p.position.addScaledVector(p.velocity, dt);
        p.rotation.x += p.spin.x * dt;
        p.rotation.y += p.spin.y * dt;
        p.rotation.z += p.spin.z * dt;

        if (p.position.y <= p.rest) {
          p.position.y = p.rest;
          // Bounce, bleeding off both height and tumble each time.
          p.velocity.y = -p.velocity.y * 0.32;
          p.spin.multiplyScalar(0.35);
          if (p.velocity.y < 1.2) {
            p.velocity.set(0, 0, 0);
            p.landed = true;
          }
        }
      } else {
        // Settle flat: ease the tilt out and keep the facing it landed with.
        const k = Math.min(1, dt * 5);
        p.rotation.x += (0 - p.rotation.x) * k;
        p.rotation.z += (0 - p.rotation.z) * k;
        p.position.y += (p.rest - p.position.y) * k;
      }

      this.quat.setFromEuler(p.rotation);

      this.scale.copy(p.size);
      this.matrix.compose(p.position, this.quat, this.scale);
      this.box.setMatrixAt(i, this.matrix);

      // Bands sit a hair proud of the paper, crossing over the lid.
      this.scale.set(p.size.x * 1.02, p.size.y * 1.03, p.size.z * 0.16);
      this.matrix.compose(p.position, this.quat, this.scale);
      this.bandA.setMatrixAt(i, this.matrix);

      this.scale.set(p.size.x * 0.16, p.size.y * 1.03, p.size.z * 1.02);
      this.matrix.compose(p.position, this.quat, this.scale);
      this.bandB.setMatrixAt(i, this.matrix);
    }

    if (dirty) this.flush();
  }
}
