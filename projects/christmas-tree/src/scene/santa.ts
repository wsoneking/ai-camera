import * as THREE from 'three';

/**
 * Shared materials. Every part of the rig is one of a handful of surfaces, so
 * building them once keeps the flyby to a small number of draw calls' worth of
 * distinct state.
 */
const MAT = {
  hide: new THREE.MeshStandardMaterial({ color: 0x7a4a28, roughness: 0.75 }),
  hideDark: new THREE.MeshStandardMaterial({ color: 0x4e2f1a, roughness: 0.8 }),
  antler: new THREE.MeshStandardMaterial({ color: 0xd8c39a, roughness: 0.6 }),
  nose: new THREE.MeshStandardMaterial({
    color: 0xff2a2a,
    emissive: 0xff2a2a,
    // Just over the bloom threshold, so the nose glows without flaring into a
    // blob that swallows the whole rig.
    emissiveIntensity: 1.3,
    roughness: 0.3,
  }),
  sleigh: new THREE.MeshStandardMaterial({ color: 0xb3121f, roughness: 0.45, metalness: 0.15 }),
  gold: new THREE.MeshStandardMaterial({
    color: 0xe8c56a,
    roughness: 0.38,
    metalness: 0.8,
    // Kept modest: a mirror-bright gold catches the key light hard enough to
    // cross the bloom threshold and flare the whole rig white.
    envMapIntensity: 0.7,
  }),
  suit: new THREE.MeshStandardMaterial({ color: 0xd62230, roughness: 0.55 }),
  fur: new THREE.MeshStandardMaterial({ color: 0xf7f3ea, roughness: 0.85 }),
  skin: new THREE.MeshStandardMaterial({ color: 0xe8b08a, roughness: 0.65 }),
  belt: new THREE.MeshStandardMaterial({ color: 0x2a1b14, roughness: 0.6 }),
  rein: new THREE.MeshStandardMaterial({ color: 0x3c2a1c, roughness: 0.7 }),
  parcel: new THREE.MeshStandardMaterial({ color: 0x11543a, roughness: 0.6 }),
} as const;

const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(1, 16, 12),
  cylinder: new THREE.CylinderGeometry(1, 1, 1, 10),
  cone: new THREE.ConeGeometry(1, 1, 12),
  capsule: new THREE.CapsuleGeometry(1, 1, 6, 12),
  torus: new THREE.TorusGeometry(1, 0.18, 6, 14),
} as const;

function part(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  position: [number, number, number],
  scale: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0]
): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.rotation.set(...rotation);
  return mesh;
}

interface Leg {
  pivot: THREE.Object3D;
  /** Offset into the gallop cycle, so the legs don't move as one. */
  phase: number;
}

/** One reindeer, built nose-forward along +X. `lead` gets the red nose. */
function makeReindeer(lead: boolean): { group: THREE.Group; legs: Leg[] } {
  const group = new THREE.Group();
  const legs: Leg[] = [];

  // Barrel: a capsule laid along the travel axis.
  group.add(part(GEO.capsule, MAT.hide, [0, 0, 0], [0.2, 0.34, 0.2], [0, 0, Math.PI / 2]));
  // Neck, angled up toward the head.
  group.add(part(GEO.capsule, MAT.hide, [0.42, 0.26, 0], [0.11, 0.2, 0.11], [0, 0, -0.9]));
  // Head + muzzle.
  group.add(part(GEO.sphere, MAT.hide, [0.62, 0.46, 0], [0.15, 0.13, 0.13]));
  group.add(part(GEO.sphere, MAT.hideDark, [0.76, 0.42, 0], [0.09, 0.07, 0.07]));
  group.add(part(GEO.sphere, lead ? MAT.nose : MAT.hideDark, [0.845, 0.42, 0], [0.045, 0.045, 0.045]));
  // Ears.
  for (const z of [-0.1, 0.1]) {
    group.add(part(GEO.sphere, MAT.hideDark, [0.58, 0.56, z], [0.05, 0.03, 0.06]));
  }
  // Antlers: a main spike per side with two forward tines.
  for (const z of [-0.07, 0.07]) {
    const side = Math.sign(z);
    group.add(
      part(GEO.cylinder, MAT.antler, [0.6, 0.64, z * 1.2], [0.016, 0.26, 0.016], [side * 0.3, 0, -0.2])
    );
    group.add(
      part(GEO.cylinder, MAT.antler, [0.68, 0.76, z * 1.5], [0.013, 0.16, 0.013], [side * 0.5, 0, -0.8])
    );
    group.add(
      part(GEO.cylinder, MAT.antler, [0.55, 0.8, z * 1.5], [0.013, 0.14, 0.013], [side * 0.5, 0, 0.5])
    );
  }
  // Tail.
  group.add(part(GEO.sphere, MAT.fur, [-0.36, 0.1, 0], [0.06, 0.08, 0.06]));

  // Legs hang from pivots at the shoulder/hip so they swing from the top.
  for (const x of [0.26, -0.24]) {
    for (const z of [-0.14, 0.14]) {
      const pivot = new THREE.Object3D();
      pivot.position.set(x, -0.1, z);
      const upper = part(GEO.cylinder, MAT.hide, [0, -0.17, 0], [0.04, 0.34, 0.04]);
      const hoof = part(GEO.cylinder, MAT.hideDark, [0, -0.36, 0], [0.045, 0.06, 0.045]);
      pivot.add(upper, hoof);
      group.add(pivot);
      legs.push({ pivot, phase: (x > 0 ? 0 : Math.PI) + (z > 0 ? 0.6 : 0) });
    }
  }

  // A jingling collar.
  group.add(
    part(GEO.torus, MAT.gold, [0.38, 0.2, 0], [0.13, 0.13, 0.13], [0, 0, Math.PI / 2 - 0.5])
  );

  return { group, legs };
}

/** The sleigh with Santa aboard, also facing +X. */
function makeSleigh(): THREE.Group {
  const group = new THREE.Group();

  // Hull: a main tub, a flared front and a curled-over back rail.
  group.add(part(GEO.box, MAT.sleigh, [0, 0, 0], [1.25, 0.42, 0.7]));
  group.add(part(GEO.box, MAT.sleigh, [0.68, 0.08, 0], [0.4, 0.5, 0.64], [0, 0, 0.25]));
  group.add(part(GEO.box, MAT.sleigh, [-0.6, 0.18, 0], [0.16, 0.66, 0.68], [0, 0, -0.18]));
  group.add(
    part(GEO.torus, MAT.sleigh, [-0.66, 0.52, 0], [0.22, 0.22, 0.6], [Math.PI / 2, 0, 0])
  );
  // Gold trim along the gunwale.
  for (const z of [-0.36, 0.36]) {
    group.add(part(GEO.box, MAT.gold, [0, 0.22, z], [1.3, 0.07, 0.06]));
  }

  // Runners: a rail each side with an upturned curl at the front.
  for (const z of [-0.3, 0.3]) {
    group.add(part(GEO.box, MAT.gold, [0, -0.3, z], [1.4, 0.06, 0.07]));
    group.add(part(GEO.box, MAT.gold, [0.76, -0.22, z], [0.3, 0.06, 0.07], [0, 0, 0.6]));
    group.add(part(GEO.box, MAT.gold, [-0.3, -0.16, z], [0.06, 0.3, 0.06]));
    group.add(part(GEO.box, MAT.gold, [0.3, -0.16, z], [0.06, 0.3, 0.06]));
  }

  // A sack of presents in the back.
  group.add(part(GEO.sphere, MAT.parcel, [-0.34, 0.34, 0], [0.26, 0.24, 0.26]));
  group.add(part(GEO.box, MAT.gold, [-0.3, 0.56, 0.1], [0.16, 0.14, 0.16], [0, 0.4, 0.2]));
  group.add(part(GEO.box, MAT.suit, [-0.46, 0.54, -0.12], [0.14, 0.13, 0.14], [0, -0.3, -0.2]));

  // Santa, sitting up front and facing the reindeer.
  const santa = new THREE.Group();
  santa.position.set(0.18, 0.28, 0);
  santa.add(part(GEO.capsule, MAT.suit, [0, 0.16, 0], [0.19, 0.12, 0.17]));
  santa.add(part(GEO.box, MAT.belt, [0, 0.12, 0], [0.4, 0.07, 0.36]));
  santa.add(part(GEO.box, MAT.gold, [0.2, 0.12, 0], [0.04, 0.08, 0.1]));
  santa.add(part(GEO.sphere, MAT.skin, [0.04, 0.44, 0], [0.13, 0.13, 0.12]));
  santa.add(part(GEO.sphere, MAT.fur, [0.12, 0.36, 0], [0.1, 0.11, 0.1]));
  // Hat: cone plus brim and bobble.
  santa.add(part(GEO.cone, MAT.suit, [0.0, 0.62, 0], [0.13, 0.26, 0.13], [0, 0, -0.35]));
  santa.add(part(GEO.cylinder, MAT.fur, [0.03, 0.54, 0], [0.135, 0.06, 0.13]));
  santa.add(part(GEO.sphere, MAT.fur, [-0.1, 0.72, 0], [0.055, 0.055, 0.055]));
  // Arms reaching forward to the reins.
  for (const z of [-0.16, 0.16]) {
    santa.add(part(GEO.capsule, MAT.suit, [0.2, 0.22, z], [0.055, 0.12, 0.055], [0, 0, -1.1]));
    santa.add(part(GEO.sphere, MAT.fur, [0.37, 0.28, z], [0.05, 0.05, 0.05]));
  }
  group.add(santa);

  return group;
}

/** Spacing between the reindeer, nose to tail, in world units. */
const TEAM_SPACING = 1.5;
const TEAM_SIZE = 3;

/**
 * The flight path, as control points for a smooth curve through the scene.
 *
 * Read as an S from the camera: in from the left and across the sky *behind*
 * the tree, out past the right edge, then back *in front* of it — low and
 * close — before curving away to the left and off.
 *
 * The x values are picked against the frustum, since how far off-centre is
 * "off-screen" depends entirely on depth (the visible half-width is about
 * 0.65 × the distance from the camera, which sits at z ≈ 13). The turns
 * therefore happen just outside the frame: wider and the sleigh vanishes for
 * seconds at a time, narrower and it never appears to leave. The front pass
 * is held to z ≈ 3 — any closer and it is a blur across the lens.
 */
const PATH: ReadonlyArray<readonly [number, number, number]> = [
  [-26, 9.0, -17],
  [-13, 8.4, -15.5],
  [2, 7.8, -14],
  [13, 7.0, -11],
  [18, 6.0, -6],
  [14, 4.8, -0.5],
  [5, 3.9, 3.2],
  [-5, 3.8, 3.4],
  [-13, 4.6, 0],
  [-21, 6.4, -6],
  [-30, 8.4, -15],
];

/**
 * Santa's sleigh crossing the scene, summoned by the pinky-up gesture.
 *
 * The rig is modelled facing +X and is steered by the curve's tangent, so it
 * banks and turns through the S by itself; nothing about the path is baked
 * into the model.
 */
export class SantaSleigh {
  readonly group = new THREE.Group();

  private legs: Leg[] = [];
  private team: THREE.Group[] = [];
  private flying = false;
  private t = 0;
  private curve: THREE.CatmullRomCurve3;
  /** Yaw from the previous frame, which the banking is derived from. */
  private prevYaw: number | null = null;
  private roll = 0;

  /** Seconds for one full pass. */
  static readonly FLIGHT_SECONDS = 12;

  private readonly here = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly tail = new THREE.Vector3();

  constructor() {
    this.curve = new THREE.CatmullRomCurve3(
      PATH.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      false,
      'catmullrom',
      0.5
    );

    const sleigh = makeSleigh();
    this.group.add(sleigh);

    for (let i = 0; i < TEAM_SIZE; i++) {
      const { group, legs } = makeReindeer(i === TEAM_SIZE - 1);
      // Teamed up ahead of the sleigh, rising slightly toward the front.
      group.position.set(1.5 + i * TEAM_SPACING, 0.12 + i * 0.05, 0);
      this.group.add(group);
      this.team.push(group);
      this.legs.push(...legs);

      // Reins from the sleigh's dash up to this reindeer's collar.
      const from = new THREE.Vector3(0.55, 0.5, 0);
      const to = new THREE.Vector3(group.position.x + 0.38, group.position.y + 0.2, 0);
      for (const z of [-0.16, 0.16]) {
        const mid = from.clone().lerp(to, 0.5);
        mid.z = z;
        const span = from.distanceTo(to);
        const rein = part(GEO.cylinder, MAT.rein, [mid.x, mid.y, mid.z], [0.012, span, 0.012]);
        // Lay the cylinder (built along Y) along the rein direction.
        rein.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          to.clone().sub(from).normalize()
        );
        this.group.add(rein);
      }
    }

    this.group.visible = false;
  }

  get isFlying(): boolean {
    return this.flying;
  }

  /** Starts a pass. Returns false (and does nothing) if one is already running. */
  fly(): boolean {
    if (this.flying) return false;
    this.t = 0;
    this.flying = true;
    this.prevYaw = null;
    this.roll = 0;
    this.group.visible = true;
    this.writePose(1 / 60);
    return true;
  }

  reset(): void {
    this.flying = false;
    this.group.visible = false;
  }

  /** Where the sparkle trail should be emitted from, or null when grounded. */
  get trailPoint(): THREE.Vector3 | null {
    return this.flying ? this.tail : null;
  }

  private writePose(dt: number): void {
    const u = Math.min(1, this.t / SantaSleigh.FLIGHT_SECONDS);
    // Arc-length sampling, so the sleigh holds a steady speed through the
    // curve's tight turns instead of lurching.
    this.curve.getPointAt(u, this.here);
    this.curve.getTangentAt(u, this.tangent);

    this.group.position.copy(this.here);
    // Gentle bob on top of the path so the rig never looks like it is on rails.
    this.group.position.y += Math.sin(this.t * 2.1) * 0.16;

    // A +X-facing model yawed by θ points along (cos θ, 0, −sin θ).
    const yaw = -Math.atan2(this.tangent.z, this.tangent.x);
    const pitch = Math.atan2(this.tangent.y, Math.hypot(this.tangent.x, this.tangent.z)) * 0.8;

    // Bank into the turns, from how fast the heading is changing. The wrap
    // keeps a yaw crossing ±π from reading as a violent swerve.
    let turn = this.prevYaw === null ? 0 : yaw - this.prevYaw;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    this.prevYaw = yaw;
    const targetRoll = THREE.MathUtils.clamp((turn / Math.max(dt, 1e-3)) * 0.45, -0.5, 0.5);
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 4);

    this.group.rotation.set(0, yaw, pitch);
    // Roll is about the travel axis, which is the model's own X.
    this.group.rotateX(this.roll);

    // Gallop: legs swing fore and aft, each on its own phase.
    for (const leg of this.legs) {
      leg.pivot.rotation.z = Math.sin(this.t * 9 + leg.phase) * 0.55;
    }
    // Each reindeer bounds on its own beat.
    for (let i = 0; i < this.team.length; i++) {
      this.team[i].position.y = 0.12 + i * 0.05 + Math.sin(this.t * 9 - i * 0.7) * 0.07;
    }

    // Trail streams from behind the sleigh, in world space.
    this.tail.set(-1.1, -0.1, 0).applyQuaternion(this.group.quaternion).add(this.group.position);
  }

  update(dt: number): void {
    if (!this.flying) return;

    this.t += dt;
    if (this.t >= SantaSleigh.FLIGHT_SECONDS) {
      this.reset();
      return;
    }
    this.writePose(dt);
  }
}
