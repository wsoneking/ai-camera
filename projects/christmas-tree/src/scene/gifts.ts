import * as THREE from 'three';

/** Wrapping paper / ribbon pairs, picked to read clearly against the snow. */
const WRAPS = [
  { paper: 0xb3121f, ribbon: 0xe8c56a }, // red + gold
  { paper: 0x11543a, ribbon: 0xf0e6d2 }, // forest green + cream
  { paper: 0x1b3a6b, ribbon: 0xc9d7ea }, // navy + silver
  { paper: 0xe6dac2, ribbon: 0xc0392b }, // cream + red
  { paper: 0x6b2742, ribbon: 0xe8c56a }, // burgundy + gold
  { paper: 0x0f5e63, ribbon: 0xf0e6d2 }, // teal + cream
];

const GIFT_COUNT = 14;

interface Gift {
  group: THREE.Group;
  /** Growth progress at which this box pops in. */
  birth: number;
  restY: number;
}

/**
 * A scatter of wrapped presents on the snow around the trunk. They live in
 * stage space rather than under the tree, so spinning or resizing the tree
 * leaves them sitting still on the ground.
 */
export class Gifts {
  readonly group = new THREE.Group();

  private gifts: Gift[] = [];
  private progress = 0;
  private target = 0;

  /** Shared across every box; only the materials differ per gift. */
  private readonly boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private readonly bowGeo = new THREE.TorusGeometry(0.12, 0.035, 8, 16);

  constructor() {
    for (let i = 0; i < GIFT_COUNT; i++) {
      // Even angular spread with jitter, kept clear of the lowest branches.
      const angle = (i / GIFT_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const radius = 2.45 + Math.random() * 1.05;

      const w = 0.42 + Math.random() * 0.4;
      const h = 0.3 + Math.random() * 0.34;
      const d = 0.42 + Math.random() * 0.4;

      const wrap = WRAPS[i % WRAPS.length];
      const paperMat = new THREE.MeshStandardMaterial({
        color: wrap.paper,
        roughness: 0.68,
        metalness: 0.03,
      });
      const ribbonMat = new THREE.MeshStandardMaterial({
        color: wrap.ribbon,
        roughness: 0.34,
        metalness: 0.55,
        envMapIntensity: 1.2,
      });

      const gift = new THREE.Group();

      const box = new THREE.Mesh(this.boxGeo, paperMat);
      box.scale.set(w, h, d);
      box.castShadow = true;
      box.receiveShadow = true;
      gift.add(box);

      // Two ribbon bands crossing over the lid, slightly proud of the paper.
      const bandA = new THREE.Mesh(this.boxGeo, ribbonMat);
      bandA.scale.set(w * 1.02, h * 1.03, d * 0.16);
      bandA.castShadow = true;
      const bandB = new THREE.Mesh(this.boxGeo, ribbonMat);
      bandB.scale.set(w * 0.16, h * 1.03, d * 1.02);
      bandB.castShadow = true;
      gift.add(bandA, bandB);

      // Bow: two tilted loops where the bands meet.
      const bowScale = Math.min(w, d) * 1.5;
      for (const tilt of [0.6, -0.6]) {
        const loop = new THREE.Mesh(this.bowGeo, ribbonMat);
        loop.scale.setScalar(bowScale);
        loop.position.y = h / 2 + 0.03 * bowScale;
        loop.rotation.set(Math.PI / 2, 0, tilt);
        loop.castShadow = true;
        gift.add(loop);
      }

      gift.position.set(Math.cos(angle) * radius, h / 2, Math.sin(angle) * radius);
      gift.rotation.y = Math.random() * Math.PI * 2;

      this.gifts.push({
        group: gift,
        // Boxes appear after the tree has started filling out.
        // birth + 0.18 must stay <= 1 so every box finishes popping in.
        birth: 0.2 + (i / GIFT_COUNT) * 0.55 + Math.random() * 0.05,
        restY: h / 2,
      });
      this.group.add(gift);
    }

    this.group.visible = false;
    this.writeTransforms();
  }

  /** Smooth 0→1 ramp. */
  private static ease(x: number): number {
    const c = Math.max(0, Math.min(1, x));
    return c * c * (3 - 2 * c);
  }

  private writeTransforms(): void {
    for (const gift of this.gifts) {
      const local = Gifts.ease((this.progress - gift.birth) / 0.18);
      if (local <= 0) {
        gift.group.scale.setScalar(0.001);
        gift.group.visible = false;
        continue;
      }
      gift.group.visible = true;

      // Drop in with a squash-and-settle bounce.
      const bounce = Math.sin(Math.min(1, local) * Math.PI);
      gift.group.scale.set(
        local * (1 + bounce * 0.22),
        local * (1 - bounce * 0.14),
        local * (1 + bounce * 0.22)
      );
      gift.group.position.y = gift.restY + (1 - local) * 1.6;
    }
  }

  /** True once the presents have been planted and not yet cleared away. */
  get isPlanted(): boolean {
    return this.target > 0;
  }

  plant(): void {
    this.group.visible = true;
    this.target = 1;
  }

  reset(): void {
    this.progress = 0;
    this.target = 0;
    this.group.visible = false;
    this.writeTransforms();
  }

  update(dt: number): void {
    if (this.progress < this.target) {
      this.progress = Math.min(this.target, this.progress + dt * 0.42);
      this.writeTransforms();
    }
  }
}
