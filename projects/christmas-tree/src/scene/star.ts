import * as THREE from 'three';

/** Four-spoke starburst flare, drawn once into a canvas texture. */
function makeFlareTexture(): THREE.Texture {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const mid = size / 2;

  const glow = ctx.createRadialGradient(mid, mid, 0, mid, mid, mid * 0.3);
  glow.addColorStop(0, 'rgba(255,245,215,0.85)');
  glow.addColorStop(0.35, 'rgba(255,224,165,0.3)');
  glow.addColorStop(1, 'rgba(255,205,115,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  // Spokes: two long, two short, mirrored into eight.
  ctx.translate(mid, mid);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 8; i++) {
    const long = i % 2 === 0;
    const len = mid * (long ? 0.95 : 0.4);
    const width = long ? 5 : 2.5;
    const grad = ctx.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0, 'rgba(255,246,220,0.5)');
    grad.addColorStop(0.3, 'rgba(255,224,160,0.14)');
    grad.addColorStop(1, 'rgba(255,200,110,0)');
    ctx.save();
    ctx.rotate((i * Math.PI) / 4);
    ctx.beginPath();
    ctx.moveTo(0, -width);
    ctx.lineTo(len, 0);
    ctx.lineTo(0, width);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Flat 5-pointed star outline. */
function makeStarShape(outer: number, inner: number): THREE.Shape {
  const shape = new THREE.Shape();
  const points = 5;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    // Start at the top so one point aims straight up.
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

/**
 * The tree topper: a bevelled gold star with its own point light, halo flare
 * and a rise-and-spin entrance.
 */
export class TreeStar {
  readonly group = new THREE.Group();

  private mesh: THREE.Mesh;
  private material: THREE.MeshStandardMaterial;
  private flare: THREE.Sprite;
  private light: THREE.PointLight;

  private anchor = new THREE.Vector3();
  private progress = 0;
  private placed = false;
  private elapsed = 0;

  constructor() {
    // Sized as a topper, not a landmark: roughly a sixth of the tree's base
    // width across the points.
    const geo = new THREE.ExtrudeGeometry(makeStarShape(0.38, 0.155), {
      depth: 0.1,
      bevelEnabled: true,
      bevelThickness: 0.05,
      bevelSize: 0.05,
      bevelSegments: 2,
      curveSegments: 1,
    });
    geo.center();
    geo.computeVertexNormals();

    // Gold metal that is lit, not self-illuminated. Both a high emissive and
    // a high envMapIntensity on a pure metal clip straight to white, which is
    // what turned the whole treetop into a glowing blob.
    this.material = new THREE.MeshStandardMaterial({
      color: 0xffc64a,
      emissive: 0xffa83c,
      emissiveIntensity: 0.22,
      metalness: 0.9,
      roughness: 0.34,
      envMapIntensity: 0.9,
      flatShading: true,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.castShadow = true;
    this.group.add(this.mesh);

    this.flare = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeFlareTexture(),
        color: 0xffd79a,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      })
    );
    this.flare.scale.setScalar(0.9);
    this.group.add(this.flare);

    // Sits well below the star so it lights the upper branches without
    // sitting *inside* the star geometry, where inverse-square falloff would
    // blast its own surface at near-zero distance.
    this.light = new THREE.PointLight(0xffc987, 0, 6, 2);
    this.light.position.set(0, -1.0, 0);
    this.group.add(this.light);

    this.group.visible = false;
  }

  get isPlaced(): boolean {
    return this.placed;
  }

  /** Drops the star onto the apex with an entrance animation. */
  place(anchorLocal: THREE.Vector3): void {
    if (this.placed) return;
    this.anchor.copy(anchorLocal);
    this.placed = true;
    this.progress = 0;
    this.group.visible = true;
  }

  reset(): void {
    this.placed = false;
    this.progress = 0;
    this.group.visible = false;
  }

  update(dt: number): void {
    this.elapsed += dt;
    if (!this.placed) return;

    this.progress = Math.min(1, this.progress + dt * 0.85);
    // Back-eased landing: overshoots slightly, then settles.
    const p = this.progress;
    const eased = 1 - Math.pow(1 - p, 3);
    const settle = Math.sin(p * Math.PI) * 0.18;

    this.group.position.copy(this.anchor);
    this.group.position.y += (1 - eased) * 2.0 + settle * 0.25;

    const breathe = 1 + Math.sin(this.elapsed * 1.5) * 0.035;
    this.group.scale.setScalar(Math.max(0.001, eased * breathe * (1 + settle)));

    // Fast spin on entry easing into a lazy rotation.
    this.mesh.rotation.y += dt * (7.5 * (1 - eased) + 0.45);
    this.mesh.rotation.z = Math.sin(this.elapsed * 0.8) * 0.06;

    const pulse = 0.82 + 0.18 * Math.sin(this.elapsed * 2.1);
    this.material.emissiveIntensity = 0.18 + eased * 0.22 * pulse;
    this.light.intensity = eased * 5 * pulse;
    this.flare.scale.setScalar((0.85 + Math.sin(this.elapsed * 1.3) * 0.1) * eased);
    (this.flare.material as THREE.SpriteMaterial).opacity = eased * 0.55;
    this.flare.material.rotation = this.elapsed * 0.08;
  }
}
