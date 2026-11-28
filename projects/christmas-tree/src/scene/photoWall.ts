import * as THREE from 'three';
import { PHOTO_ASPECT } from '../vision/capture';

/**
 * Alpha for the backdrop: solid at the bottom, dissolving into the night sky
 * toward the top. The falloff is purely vertical and the panel is wider than
 * the view, so the wall has no visible edge anywhere on screen — a radial
 * vignette instead reads as an odd bright ellipse floating behind the tree.
 */
function makeWallFalloff(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0.0, 'rgba(255,255,255,0)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.72)');
  g.addColorStop(0.75, 'rgba(255,255,255,1)');
  g.addColorStop(1.0, 'rgba(255,255,255,1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const PHOTO_WIDTH = 4.2;
const PHOTO_HEIGHT = PHOTO_WIDTH / PHOTO_ASPECT;
const FRAME_BORDER = 0.18;

/** How many photos hang at once; the oldest is replaced after that. */
const CAPACITY = 8;

/**
 * Where on the wall a photo may land. The middle is kept clear so pictures
 * never hang in front of the tree, and the band sits high enough that no photo
 * projects below the horizon — at this depth anything under about y=4 reads as
 * standing in the snow rather than hanging on a wall.
 */
const AREA = { halfWidth: 12.2, minY: 5.6, maxY: 9.2, keepOut: 5.8 } as const;

/**
 * The HUD panel sits over the upper-left of the screen, so photos avoid that
 * corner of the wall — a picture hung there is half-hidden behind the hint
 * list no matter how nice it is.
 */
const HUD_CORNER = { x: -7.0, y: 6.2 } as const;

interface Frame {
  group: THREE.Group;
  material: THREE.MeshBasicMaterial;
  /** 0 → 1 pop-in progress; stays at 1 once settled. */
  entrance: number;
  /** The slight hang-askew angle this photo got. */
  tilt: number;
  /** Where it hangs; the entrance animation drops down to `y`. */
  x: number;
  y: number;
  used: boolean;
}

/**
 * The backdrop wall behind the tree, and the photos pinned to it.
 *
 * Each new photo picks a random free spot by rejection sampling: positions are
 * drawn until one lands clear of the tree and of the photos already hanging,
 * so the wall fills up scattered rather than in a grid. Frames are pooled and
 * recycled oldest-first once the wall is full.
 */
export class PhotoWall {
  readonly group = new THREE.Group();

  private frames: Frame[] = [];
  /** Next frame to write, which is also the oldest once we wrap around. */
  private cursor = 0;
  private taken = 0;

  private static readonly DEPTH = -14;

  constructor() {
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(44, 16),
      new THREE.MeshStandardMaterial({
        color: 0x18223c,
        roughness: 0.95,
        metalness: 0.02,
        transparent: true,
        // Left semi-transparent so the background stars still show through and
        // the night does not turn into a closed room.
        opacity: 0.62,
        alphaMap: makeWallFalloff(),
        depthWrite: false,
      })
    );
    wall.position.set(0, 5.0, PhotoWall.DEPTH);
    this.group.add(wall);

    const frameGeo = new THREE.PlaneGeometry(
      PHOTO_WIDTH + FRAME_BORDER * 2,
      PHOTO_HEIGHT + FRAME_BORDER * 2
    );
    const photoGeo = new THREE.PlaneGeometry(PHOTO_WIDTH, PHOTO_HEIGHT);
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0xf4ead6,
      roughness: 0.6,
      metalness: 0.05,
    });
    const pinMat = new THREE.MeshStandardMaterial({
      color: 0xe8c56a,
      roughness: 0.3,
      metalness: 0.9,
      envMapIntensity: 0.8,
    });
    const pinGeo = new THREE.SphereGeometry(0.075, 10, 8);

    for (let i = 0; i < CAPACITY; i++) {
      const group = new THREE.Group();
      // Staggered in depth so two frames that end up overlapping cannot
      // z-fight against each other.
      group.position.set(0, 0, PhotoWall.DEPTH + 0.06 + i * 0.012);

      group.add(new THREE.Mesh(frameGeo, frameMat));

      // Unlit, so the photo stays legible against the dark wall no matter how
      // the scene lighting swings.
      const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const photo = new THREE.Mesh(photoGeo, material);
      photo.position.z = 0.02;
      group.add(photo);

      const pin = new THREE.Mesh(pinGeo, pinMat);
      pin.position.set(0, PHOTO_HEIGHT / 2 + FRAME_BORDER, 0.06);
      group.add(pin);

      group.visible = false;
      this.group.add(group);
      this.frames.push({ group, material, entrance: 0, tilt: 0, x: 0, y: 0, used: false });
    }
  }

  /**
   * A free-ish spot on the wall. Falls back to an unchecked position once the
   * wall is crowded enough that rejection sampling stops finding room.
   */
  private findSpot(skip: Frame): { x: number; y: number } {
    const spanY = AREA.maxY - AREA.minY;
    const pick = () => ({
      // Either side of the tree, never across it.
      x:
        (AREA.keepOut + Math.random() * (AREA.halfWidth - AREA.keepOut)) *
        (Math.random() < 0.5 ? -1 : 1),
      y: AREA.minY + Math.random() * spanY,
    });

    for (let attempt = 0; attempt < 40; attempt++) {
      const spot = pick();
      if (spot.x < HUD_CORNER.x && spot.y > HUD_CORNER.y) continue;
      const clear = this.frames.every(
        (f) =>
          f === skip ||
          !f.used ||
          Math.abs(f.x - spot.x) > PHOTO_WIDTH * 1.08 ||
          Math.abs(f.y - spot.y) > PHOTO_HEIGHT * 1.08
      );
      if (clear) return spot;
    }
    return pick();
  }

  get count(): number {
    return this.taken;
  }

  /** Pins `canvas` somewhere free, replacing the oldest photo if full. */
  add(canvas: HTMLCanvasElement): void {
    const frame = this.frames[this.cursor];
    this.cursor = (this.cursor + 1) % this.frames.length;

    // Each photo owns its texture; this frame's previous one is now unreachable.
    frame.material.map?.dispose();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    frame.material.map = texture;
    frame.material.needsUpdate = true;

    const spot = this.findSpot(frame);
    frame.x = spot.x;
    frame.y = spot.y;
    frame.group.position.x = spot.x;
    frame.group.position.y = spot.y;
    frame.entrance = 0;
    frame.tilt = (Math.random() - 0.5) * 0.16;
    frame.used = true;
    frame.group.visible = true;
    this.taken = Math.min(this.taken + 1, this.frames.length);
  }

  reset(): void {
    for (const frame of this.frames) {
      frame.material.map?.dispose();
      frame.material.map = null;
      frame.material.needsUpdate = true;
      frame.group.visible = false;
      frame.used = false;
      frame.entrance = 0;
    }
    this.cursor = 0;
    this.taken = 0;
  }

  update(dt: number): void {
    for (const frame of this.frames) {
      if (!frame.used || frame.entrance >= 1) continue;

      frame.entrance = Math.min(1, frame.entrance + dt * 2.6);
      const e = 1 - Math.pow(1 - frame.entrance, 3);
      // Swings in from above and overshoots a touch, like being hung on a nail.
      const swing = Math.sin(frame.entrance * Math.PI) * 0.18;
      frame.group.scale.setScalar(0.4 + 0.6 * e + swing * 0.25);
      frame.group.rotation.z = frame.tilt * e + swing * (frame.tilt > 0 ? 0.6 : -0.6);
      frame.group.position.y = frame.y + (1 - e) * 0.9;
    }
  }
}
