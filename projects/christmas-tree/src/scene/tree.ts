import * as THREE from 'three';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export const TREE = {
  height: 6.4,
  baseRadius: 2.3,
  /** How sharply the cone tapers. <1 gives the slightly convex fir profile. */
  taper: 0.8,
  /** Number of branch skirts stacked up the trunk. */
  tiers: 9,
  sprigCount: 3400,
  trunkHeight: 1.0,
} as const;

/** Cone radius at a given height fraction t in [0,1]. */
export function radiusAtFraction(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return TREE.baseRadius * Math.pow(1 - c, TREE.taper);
}

/** Cone radius at a world-space y (relative to the tree base at y=0). */
export function radiusAtHeight(y: number): number {
  return radiusAtFraction(y / TREE.height);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

interface Sprig {
  angle: number;
  /** Height fraction of the sprig's base, 0 at the bottom skirt. */
  t: number;
  /** Distance from the trunk at which the sprig starts. */
  baseRadius: number;
  y: number;
  /** Length along the branch; the tip lands on the canopy surface. */
  length: number;
  width: number;
  droop: number;
  /** Growth progress at which this sprig starts to appear. */
  birth: number;
  swayPhase: number;
}

/**
 * A procedural fir built from `TREE.tiers` stacked branch skirts. Each skirt
 * starts wide at its base and tapers upward, so the silhouette reads as
 * layered shelves rather than a uniform cone.
 *
 * Crucially, every sprig *starts* near the trunk and extends outward just far
 * enough to reach the canopy surface — growing them outward *from* the surface
 * is what makes a procedural tree look like a fuzzy bottle brush.
 */
export class ChristmasTree {
  readonly group = new THREE.Group();

  private sprigs: Sprig[] = [];
  private foliage!: THREE.InstancedMesh;
  private trunk!: THREE.Mesh;
  private mound!: THREE.Mesh;

  private progress = 0;
  private targetProgress = 0;
  private elapsed = 0;

  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly dir = new THREE.Vector3();

  constructor() {
    this.buildTrunk();
    this.buildFoliage();
    this.buildMound();
    this.group.visible = false;
  }

  private buildTrunk(): void {
    const geo = new THREE.CylinderGeometry(0.17, 0.3, TREE.trunkHeight, 16, 1);
    geo.translate(0, TREE.trunkHeight / 2, 0);
    this.trunk = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0x3d2a1c, roughness: 0.95, metalness: 0.0 })
    );
    this.trunk.castShadow = true;
    this.trunk.receiveShadow = true;
    this.group.add(this.trunk);
  }

  private buildFoliage(): void {
    // A unit-length tapered needle cluster: tip at local +Y, base at the
    // origin, flattened in Z so it reads as a frond rather than a spike.
    const geo = new THREE.ConeGeometry(0.17, 1, 6, 1);
    geo.translate(0, 0.5, 0);
    geo.scale(1, 1, 0.55);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.72,
      metalness: 0.0,
      flatShading: true,
    });

    this.foliage = new THREE.InstancedMesh(geo, mat, TREE.sprigCount);
    this.foliage.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.foliage.castShadow = true;
    this.foliage.receiveShadow = true;
    this.foliage.frustumCulled = false;

    const shadowGreen = new THREE.Color(0x0b2f1f);
    const midGreen = new THREE.Color(0x256b3a);
    const litGreen = new THREE.Color(0x4f9b50);
    const frost = new THREE.Color(0xd7e6f5);
    const tmp = new THREE.Color();

    const trunkTop = TREE.trunkHeight * 0.5;
    const span = TREE.height - trunkTop;

    for (let i = 0; i < TREE.sprigCount; i++) {
      // Bias the distribution downward so the wide lower skirts get the
      // sprigs they need to stay dense.
      const t = Math.pow(i / TREE.sprigCount, 0.72);

      const tierF = t * TREE.tiers;
      const tier = Math.min(TREE.tiers - 1, Math.floor(tierF));
      const frac = tierF - tier;

      // Each skirt spans from its own base radius down to a narrow waist, so
      // consecutive skirts leave a visible step in the silhouette.
      const outer = radiusAtFraction(tier / TREE.tiers);
      const waist = radiusAtFraction((tier + 1) / TREE.tiers) * 0.55;
      const reach = lerp(outer, waist, Math.pow(frac, 0.8)) * (0.9 + Math.random() * 0.17);

      // Longer fronds low down, shorter near the top.
      const length = 0.26 + reach * 0.22;
      const baseRadius = Math.max(0.04, reach - length * 0.78);
      // Branches at the outer lip of a skirt hang down the most.
      const droop = lerp(0.52, 0.2, Math.pow(frac, 0.7)) + Math.random() * 0.14;

      this.sprigs.push({
        angle: i * GOLDEN_ANGLE + Math.random() * 0.25,
        t,
        baseRadius,
        y: trunkTop + t * span,
        length,
        width: 0.82 + Math.random() * 0.4,
        droop,
        // Must satisfy birth + 0.14 <= 1, or these sprigs never finish
        // growing and the tip of the tree stays sparse forever.
        birth: Math.min(0.84, t * 0.8 + Math.random() * 0.05),
        swayPhase: Math.random() * Math.PI * 2,
      });

      // Deep shade inside the canopy, brighter toward the outer lip, with a
      // frosted edge along the top of each skirt where snow would settle.
      const depth = Math.min(1, baseRadius / Math.max(0.3, outer));
      tmp.copy(shadowGreen)
        .lerp(midGreen, depth * 0.75 + Math.random() * 0.25)
        .lerp(litGreen, Math.pow(depth, 2) * 0.55);
      const snow = smoothstep(0.22, 0.0, frac) * (0.3 + Math.random() * 0.6);
      tmp.lerp(frost, snow * 0.5);
      this.foliage.setColorAt(i, tmp);
    }
    this.foliage.instanceColor!.needsUpdate = true;

    this.group.add(this.foliage);
    this.writeMatrices();
  }

  private buildMound(): void {
    const geo = new THREE.SphereGeometry(2.7, 56, 20, 0, Math.PI * 2, 0, Math.PI / 2);
    geo.scale(1, 0.12, 1);
    this.mound = new THREE.Mesh(
      geo,
      // Deliberately dim: a bright white base gets swallowed by the bloom
      // pass and turns into a glowing plate under the tree.
      new THREE.MeshStandardMaterial({ color: 0x8ea6c6, roughness: 0.9, metalness: 0.0 })
    );
    this.mound.position.y = -0.02;
    this.mound.receiveShadow = true;
    this.group.add(this.mound);
  }

  /** Smooth 0→1 ramp. */
  private static ease(x: number): number {
    const c = Math.max(0, Math.min(1, x));
    return c * c * (3 - 2 * c);
  }

  private writeMatrices(): void {
    const g = this.progress;

    for (let i = 0; i < this.sprigs.length; i++) {
      const s = this.sprigs[i];
      // Each sprig pops in over a short window once growth passes its birth.
      const local = ChristmasTree.ease((g - s.birth) / 0.14);
      if (local <= 0) {
        this.scale.set(0, 0, 0);
        this.matrix.compose(this.position.set(0, 0, 0), this.quaternion, this.scale);
        this.foliage.setMatrixAt(i, this.matrix);
        continue;
      }

      // Slight overshoot on arrival reads as "springing" into place.
      const pop = 1 + Math.sin(Math.min(1, local) * Math.PI) * 0.18;
      const sway = Math.sin(this.elapsed * 1.1 + s.swayPhase) * 0.03 * (0.3 + s.t);
      const angle = s.angle + sway;

      this.position.set(
        Math.cos(angle) * s.baseRadius,
        s.y,
        Math.sin(angle) * s.baseRadius
      );

      // Point outward and downward like a real branch.
      this.dir.set(Math.cos(angle), -s.droop + sway * 2, Math.sin(angle)).normalize();
      this.quaternion.setFromUnitVectors(this.up, this.dir);

      // Non-uniform: Y is the frond's length axis, X/Z its width.
      const w = s.width * local * pop;
      this.scale.set(w, s.length * local * pop, w);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.foliage.setMatrixAt(i, this.matrix);
    }
    this.foliage.instanceMatrix.needsUpdate = true;
  }

  /** Begin (or restart) the grow-in animation. */
  plant(): void {
    this.group.visible = true;
    this.targetProgress = 1;
  }

  reset(): void {
    this.progress = 0;
    this.targetProgress = 0;
    this.group.visible = false;
    this.writeMatrices();
  }

  get growth(): number {
    return this.progress;
  }

  get isGrown(): boolean {
    return this.progress > 0.995;
  }

  update(dt: number): void {
    this.elapsed += dt;

    if (this.progress < this.targetProgress) {
      // Ease toward full height; ~2.4s for the whole tree.
      this.progress = Math.min(this.targetProgress, this.progress + dt * 0.42);
    }

    if (this.group.visible) {
      const reveal = ChristmasTree.ease(this.progress / 0.18);
      this.trunk.scale.set(1, Math.max(0.001, reveal), 1);
      this.mound.scale.setScalar(ChristmasTree.ease(this.progress / 0.12) || 0.001);
      this.writeMatrices();
    }
  }

  /**
   * Snaps an arbitrary point onto the canopy surface, returning the attach
   * point and its outward normal. Input and output are both in the tree's
   * local space. The radius sits slightly *outside* the needle surface so
   * hung ornaments are not buried in the foliage.
   */
  snapToSurface(local: THREE.Vector3): { point: THREE.Vector3; normal: THREE.Vector3 } {
    const minY = TREE.trunkHeight * 0.8;
    const maxY = TREE.height * 0.9;
    const y = Math.max(minY, Math.min(maxY, local.y));

    let angle = Math.atan2(local.z, local.x);
    if (!Number.isFinite(angle)) angle = 0;
    // Near the centre line the angle is meaningless, so bias toward the
    // camera-facing side where the ornament will actually be visible.
    if (Math.hypot(local.x, local.z) < 0.25) angle = Math.PI / 2;

    const r = Math.max(0.2, radiusAtHeight(y) * 1.03 + 0.06);

    return {
      point: new THREE.Vector3(Math.cos(angle) * r, y, Math.sin(angle) * r),
      normal: new THREE.Vector3(Math.cos(angle), 0.16, Math.sin(angle)).normalize(),
    };
  }

  /** Local-space top of the tree, where the star belongs. */
  get apexLocal(): THREE.Vector3 {
    return new THREE.Vector3(0, TREE.height + 0.2, 0);
  }
}
