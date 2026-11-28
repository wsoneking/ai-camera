import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * The backdrop grove: a stand of plain snow-dusted pines flanking the main
 * tree, there purely to give the scene depth and a horizon.
 *
 * Everything here is baked at construction into a single geometry and never
 * touched again — no per-frame work, no animation, no interaction. The main
 * tree is the only thing on stage that moves or can be decorated, and keeping
 * the grove visibly simpler (cones, not fronds; no highlights, no shadows) is
 * what keeps the eye on it.
 */

/** Where the grove may stand, as two bands so the stand reads as having depth. */
const BANDS = [
  // Near band: short trees close in on either side, well clear of the tree's
  // skirts and of the spot the user reaches into to hang baubles.
  { count: 8, minX: 6.2, maxX: 12.5, minZ: -7.5, maxZ: -3.2, minH: 2.2, maxH: 3.6 },
  // Far band: taller trees, allowed in closer to the centre line because at
  // that depth they sit behind the tree rather than beside it.
  { count: 10, minX: 2.6, maxX: 14.5, minZ: -12.5, maxZ: -8.0, minH: 3.2, maxH: 5.4 },
] as const;

/**
 * Cone tiers per pine. Four is enough to read as a fir at this distance; the
 * band heights above stay well under the main tree's 6.4 so the backdrop never
 * competes with it.
 */
const TIERS = 4;

const SHADOW_GREEN = new THREE.Color(0x0c2a20);
const MID_GREEN = new THREE.Color(0x1d4f36);
const FROST = new THREE.Color(0xc3d8ee);
const SNOW = new THREE.Color(0x7e97ba);

/**
 * Deterministic layout. The grove is hand-tuned to sit clear of the tree, the
 * photo wall and the HUD, so it must not be re-rolled on every load — one
 * unlucky draw putting a 5-metre pine in front of the star is not a trade
 * worth making for variety nobody sees twice.
 */
function makeRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Paints a cone tier: deep green in the shade of its underside, frosted over
 * the top where snow would settle. Done per tier (rather than once over the
 * whole tree) so every tier gets its own snow line, which is what makes a
 * stack of cones read as a snowy pine.
 */
function paintTier(geo: THREE.BufferGeometry, height: number, rand: () => number): void {
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();

  const tint = 0.3 + rand() * 0.5;
  for (let i = 0; i < pos.count; i++) {
    const frac = Math.max(0, Math.min(1, pos.getY(i) / height));
    c.copy(SHADOW_GREEN).lerp(MID_GREEN, Math.pow(frac, 0.7) * tint);
    c.lerp(FROST, smoothstep(0.45, 1.0, frac) * 0.45);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function paintFlat(geo: THREE.BufferGeometry, color: THREE.Color): void {
  const count = geo.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** One pine, centred on the origin with its base at y=0. */
function makePine(height: number, rand: () => number): THREE.BufferGeometry {
  const radius = height * (0.3 + rand() * 0.06);
  const trunkHeight = height * 0.16;
  const parts: THREE.BufferGeometry[] = [];

  const trunk = new THREE.CylinderGeometry(radius * 0.1, radius * 0.16, trunkHeight, 6, 1);
  trunk.translate(0, trunkHeight / 2, 0);
  paintFlat(trunk, new THREE.Color(0x2b1d14));
  parts.push(trunk);

  // Tiers shrink going up and overlap by a third of their height, so no gap
  // opens between them when the grove is seen from the side.
  for (let i = 0; i < TIERS; i++) {
    const t = i / TIERS;
    const tierH = (height - trunkHeight) * (0.42 - t * 0.07);
    const tierR = radius * (1 - t * 0.78);
    const geo = new THREE.ConeGeometry(tierR, tierH, 7, 1);
    geo.translate(0, tierH / 2, 0);
    paintTier(geo, tierH, rand);
    geo.translate(0, trunkHeight + t * (height - trunkHeight) * 0.93, 0);
    parts.push(geo);
  }

  // A low drift of snow around the foot, which is what keeps the trunk from
  // looking like it was pushed into a flat floor.
  const mound = new THREE.SphereGeometry(radius * 0.8, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  mound.scale(1, 0.14, 1);
  paintFlat(mound, SNOW);
  parts.push(mound);

  return mergeGeometries(parts)!;
}

export class Grove {
  readonly group = new THREE.Group();

  constructor() {
    const rand = makeRandom(0x5eed1e);
    const trees: THREE.BufferGeometry[] = [];
    const matrix = new THREE.Matrix4();

    for (const band of BANDS) {
      for (let i = 0; i < band.count; i++) {
        const height = band.minH + rand() * (band.maxH - band.minH);
        const geo = makePine(height, rand);

        // Spread along the band rather than drawn freely, so the stand has no
        // bald patches, then jittered so the spacing does not read as a row.
        const spread = (i + 0.5) / band.count + (rand() - 0.5) * 0.7 / band.count;
        const x = band.minX + Math.min(1, Math.max(0, spread)) * (band.maxX - band.minX);
        const side = i % 2 === 0 ? 1 : -1;
        const z = band.minZ + rand() * (band.maxZ - band.minZ);

        matrix.makeRotationY(rand() * Math.PI * 2);
        matrix.setPosition(x * side, 0, z);
        geo.applyMatrix4(matrix);
        trees.push(geo);
      }
    }

    const mesh = new THREE.Mesh(
      mergeGeometries(trees)!,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.85,
        metalness: 0.0,
        flatShading: true,
      })
    );
    // No shadows either way: the grove stands outside the key light's shadow
    // frustum, and a stand of pines dropping shadows across the ground disc
    // pulls attention off the tree for no gain.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.group.add(mesh);
  }
}
