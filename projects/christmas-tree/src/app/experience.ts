import * as THREE from 'three';
import { Stage } from '../scene/stage';
import { ChristmasTree } from '../scene/tree';
import { Ornaments, ORNAMENT_CAPACITY } from '../scene/ornaments';
import { FairyLights } from '../scene/fairyLights';
import { TreeStar } from '../scene/star';
import { Snow, Sparkles, MagicOrb } from '../scene/effects';
import { Gifts } from '../scene/gifts';
import { GiftRain } from '../scene/giftRain';
import { Fireworks } from '../scene/fireworks';
import { SantaSleigh } from '../scene/santa';
import { Rainbow } from '../scene/rainbow';
import { PhotoWall } from '../scene/photoWall';
import { LM } from '../vision/handTracker';
import { capturePhoto } from '../vision/capture';
import type { Gesture, HandState } from '../gestures/recognizer';
import { TwoHandRecognizer } from '../gestures/twoHand';
import { ArcStrokeDetector } from '../gestures/strokes';
import type { Hint, Hud } from '../ui/hud';

/**
 * The slice of the music box the experience needs. Narrow on purpose: the
 * scene asks for a sound, it does not reach into the audio graph.
 */
export interface SoundEffects {
  sleighBells(duration: number): void;
}

type Phase = 'idle' | 'growing' | 'decorating';

/** Seconds a gesture must be held to fire each action. */
const HOLD = {
  plant: 1.2,
  star: 1.0,
  lights: 0.7,
  santa: 0.9,
  photo: 0.5,
  clear: 3.0,
  reset: 1.8,
} as const;

/** Seconds between the shutter arming and the photo being taken. */
const PHOTO_TIMER = 3;

/**
 * Maps a normalized preview coordinate onto a world box in front of the tree.
 * An explicit affine map (rather than an unprojection) means a full sweep of
 * the camera frame covers exactly the tree and nothing more.
 */
const REACH = { spanX: 5.6, spanY: 7.2, baseY: 0.2, planeZ: 2.6 } as const;

function handToWorld(nx: number, ny: number): THREE.Vector3 {
  return new THREE.Vector3(
    (nx - 0.5) * REACH.spanX,
    (1 - ny) * REACH.spanY + REACH.baseY,
    REACH.planeZ
  );
}

/** Ghost bauble + target ring shown while the user is pinching. */
class PinchPreview {
  readonly group = new THREE.Group();
  private ghost: THREE.Mesh;
  private marker: THREE.Mesh;
  private ghostMat: THREE.MeshPhysicalMaterial;
  private markerMat: THREE.MeshBasicMaterial;
  private opacity = 0;
  /** A torus's hole points down +Z, which is what we align to the normal. */
  private static readonly RING_AXIS = new THREE.Vector3(0, 0, 1);

  constructor() {
    this.ghostMat = new THREE.MeshPhysicalMaterial({
      color: 0xfff1cf,
      emissive: 0xffd79a,
      emissiveIntensity: 0.7,
      roughness: 0.08,
      metalness: 0.3,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.ghost = new THREE.Mesh(new THREE.SphereGeometry(0.115, 20, 14), this.ghostMat);

    this.markerMat = new THREE.MeshBasicMaterial({
      color: 0xffe3a8,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
    });
    this.marker = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.014, 8, 32), this.markerMat);

    this.group.add(this.ghost, this.marker);
    this.group.visible = false;
  }

  show(at: THREE.Vector3, target: THREE.Vector3, normal: THREE.Vector3, size: number): void {
    this.group.visible = true;
    this.ghost.position.copy(at);
    this.ghost.scale.setScalar(size);
    this.marker.position.copy(target);
    // lookAt() would treat `normal` as a world-space target, which breaks once
    // the user spins the tree. Align the ring's axis to the normal directly.
    this.marker.quaternion.setFromUnitVectors(PinchPreview.RING_AXIS, normal);
    this.opacity = 1;
  }

  hide(): void {
    this.opacity = 0;
  }

  update(dt: number, elapsed: number): void {
    const target = this.opacity;
    const current = this.ghostMat.opacity;
    const next = current + (target * 0.72 - current) * Math.min(1, dt * 14);
    this.ghostMat.opacity = next;
    this.markerMat.opacity = next * 0.95;
    this.marker.scale.setScalar(1 + Math.sin(elapsed * 4) * 0.08);
    if (next < 0.01 && target === 0) this.group.visible = false;
  }
}

interface PinchTrack {
  active: boolean;
  duration: number;
  world: THREE.Vector3;
  size: number;
}

/**
 * The gesture-driven Christmas tree experience.
 *
 * - open palm (hold)      → plant the tree
 * - pinch, then release   → hang an ornament where your hand was
 * - victory sign (hold)   → crown the tree with the star
 * - one thumb up (hold)   → toggle the fairy lights
 * - open palm(s), moved   → drag sideways to spin the tree
 * - two open palms        → move apart/together to resize
 * - index finger          → sprinkle sparkles
 * - index finger, arc     → draw a rainbow over the scene
 * - two hands, three up   → sweep the scene clean (the photos stay)
 * - clap both hands       → a blizzard, a shower of presents, and fireworks
 * - pinky up (hold)       → Santa's sleigh flies across the sky
 * - two thumbs up         → 3-second timer, then a photo onto the back wall
 * - both index (hold)     → reset
 */
export class Experience {
  private tree = new ChristmasTree();
  private ornaments = new Ornaments();
  private lights = new FairyLights();
  private star = new TreeStar();
  private gifts = new Gifts();
  private giftRain = new GiftRain();
  private fireworks = new Fireworks();
  private santa = new SantaSleigh();
  private rainbow = new Rainbow();
  private photoWall = new PhotoWall();
  private snow = new Snow();
  private sparkles = new Sparkles();
  private orb = new MagicOrb();
  private preview = new PinchPreview();
  private twoHand = new TwoHandRecognizer();
  private arc = new ArcStrokeDetector();

  /** Seconds left on the photo timer, or null when no photo is pending. */
  private shutter: number | null = null;
  /** Seconds left on the "pinned to the wall" confirmation. */
  private photoToast = 0;

  private phase: Phase = 'idle';
  private elapsed = 0;

  /** Actions already fired for the current continuous hold. */
  private fired = new Set<string>();
  private pinches: Record<'Left' | 'Right', PinchTrack> = {
    Left: { active: false, duration: 0, world: new THREE.Vector3(), size: 1 },
    Right: { active: false, duration: 0, world: new THREE.Vector3(), size: 1 },
  };

  private treeSpin = 0;
  private treeScale = 1;
  private targetScale = 1;
  private scaleBaseline: number | null = null;
  /** Mean palm x from the previous frame, anchoring the turntable grab. */
  private grabMidX: number | null = null;
  /** How many palms that anchor was taken from, so we can re-anchor. */
  private grabCount = 0;

  /** Previous fingertip position, so the glitter can be emitted as a ribbon. */
  private lastTip: THREE.Vector3 | null = null;
  /** Previous sleigh position, for the same reason. */
  private lastSleigh: THREE.Vector3 | null = null;
  private readonly tipVel = new THREE.Vector3();
  private readonly wandColor = new THREE.Color();
  private readonly sleighColor = new THREE.Color(0xffd79a);
  /** Extra bloom from a celebration, decaying back to the baseline. */
  private bloomBoost = 0;

  constructor(
    private stage: Stage,
    private hud: Hud,
    /** Live camera feed, which the photo gesture grabs its stills from. */
    private video: HTMLVideoElement,
    private sfx: SoundEffects
  ) {
    this.tree.group.add(this.ornaments.group, this.lights.group, this.star.group, this.preview.group);
    this.stage.world.add(this.tree.group);
    this.stage.world.add(this.gifts.group, this.giftRain.group, this.santa.group);
    this.stage.world.add(this.snow.points, this.sparkles.points, this.orb.group, this.fireworks.points);
    this.stage.world.add(this.rainbow.mesh, this.photoWall.group);

    window.addEventListener('keydown', (e) => {
      switch (e.key.toLowerCase()) {
        case 'r':
          this.reset();
          break;
        // Keyboard stand-ins for the gestures that are awkward to demo without
        // a camera (and handy for checking the effects in isolation).
        case '1':
          this.celebrate();
          break;
        case '2':
          this.undecorate();
          break;
        case '3':
          this.launchSanta();
          break;
        case '4':
          this.plant();
          break;
        case '5':
          this.rainbow.show();
          break;
        case '6':
          this.takePhoto();
          break;
      }
    });
  }

  /** Grows the tree and lays out the presents. */
  private plant(): void {
    if (this.phase !== 'idle') return;
    this.phase = 'growing';
    this.tree.plant();
    this.gifts.plant();
    this.sparkles.burst(new THREE.Vector3(0, 0.4, 0), {
      color: 0x9af0d2,
      count: 110,
      speed: 3.2,
      size: 1.5,
      life: 1.8,
      gravity: 1.2,
      swirl: 2.0,
    });
  }

  private reset(): void {
    this.phase = 'idle';
    this.tree.reset();
    this.ornaments.clear();
    this.lights.reset();
    this.star.reset();
    this.gifts.reset();
    this.giftRain.reset();
    this.fireworks.clear();
    this.santa.reset();
    this.rainbow.reset();
    this.photoWall.reset();
    this.shutter = null;
    this.photoToast = 0;
    this.fired.clear();
    this.treeSpin = 0;
    this.treeScale = this.targetScale = 1;
    this.scaleBaseline = null;
    this.grabMidX = null;
    this.grabCount = 0;
    this.lastSleigh = null;
    this.bloomBoost = 0;
    this.tree.group.rotation.y = 0;
    this.tree.group.scale.setScalar(1);
  }

  /** First hand showing `gesture`, if any. */
  private find(hands: HandState[], gesture: Gesture): HandState | undefined {
    return hands.find((h) => h.gesture === gesture);
  }

  /**
   * Fires `key` once per continuous hold of `gesture`, and reports progress so
   * the HUD can draw a charge ring.
   */
  private hold(
    hands: HandState[],
    gesture: Gesture,
    duration: number,
    key: string,
    /**
     * How many hands must show the gesture. `'one'` means *exactly* one, which
     * is what keeps one thumb up (fairy lights) from also charging the action
     * bound to two thumbs up (photo).
     */
    need: 'any' | 'one' | 'two' = 'any'
  ): { progress: number; fired: boolean } {
    const matching = hands.filter((h) => h.gesture === gesture);
    const enough =
      need === 'two' ? matching.length >= 2
      : need === 'one' ? matching.length === 1
      : matching.length >= 1;

    if (!enough) {
      this.fired.delete(key);
      return { progress: 0, fired: false };
    }

    // With two hands required, the shorter hold governs.
    const held =
      need === 'two'
        ? Math.min(...matching.map((h) => h.heldFor))
        : Math.max(...matching.map((h) => h.heldFor));
    const progress = Math.min(1, held / duration);

    if (progress >= 1 && !this.fired.has(key)) {
      this.fired.add(key);
      return { progress, fired: true };
    }
    return { progress, fired: false };
  }

  /**
   * Hand coordinates live in stage space, but ornaments and the preview are
   * children of the tree so they inherit its spin and scale. The tree only
   * ever has a Y rotation and a uniform scale, so the conversion is explicit
   * rather than going through matrix round-trips.
   */
  private toTreeLocal(p: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(-this.treeSpin);
    const s = Math.sin(-this.treeSpin);
    const inv = 1 / this.treeScale;
    return new THREE.Vector3(
      (p.x * c + p.z * s) * inv,
      p.y * inv,
      (-p.x * s + p.z * c) * inv
    );
  }

  private fromTreeLocal(p: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(this.treeSpin);
    const s = Math.sin(this.treeSpin);
    const k = this.treeScale;
    return new THREE.Vector3(
      (p.x * c + p.z * s) * k,
      p.y * k,
      (-p.x * s + p.z * c) * k
    );
  }

  /**
   * Pinch is a press-and-release gesture: we track it per hand and commit the
   * ornament on release, at the position the hand last held.
   */
  private updatePinches(hands: HandState[], dt: number): void {
    for (const key of ['Left', 'Right'] as const) {
      const track = this.pinches[key];
      const hand = hands.find((h) => h.handedness === key);

      if (hand && hand.gesture === 'pinch' && this.phase === 'decorating') {
        track.active = true;
        track.duration += dt;
        track.world.copy(handToWorld(hand.pinchPoint.x, hand.pinchPoint.y));
        // A tighter pinch makes a smaller bauble.
        track.size = 0.85 + hand.pinchAmount * 0.4;

        const local = this.toTreeLocal(track.world);
        const snap = this.tree.snapToSurface(local);
        this.preview.show(local, snap.point, snap.normal, track.size);
      } else if (track.active) {
        // Released (or hand left the frame): hang it, if the pinch was real.
        if (track.duration > 0.12) this.hangOrnament(track.world, track.size);
        track.active = false;
        track.duration = 0;
      }
    }

    if (!this.pinches.Left.active && !this.pinches.Right.active) {
      this.preview.hide();
    }
  }

  private hangOrnament(stageFrom: THREE.Vector3, size: number): void {
    const from = this.toTreeLocal(stageFrom);
    const snap = this.tree.snapToSurface(from);
    const color = this.ornaments.add(from, snap.point, snap.normal, size);
    if (!color) return;

    // Burst in the bauble's own colour so the feedback reads as "that one".
    this.sparkles.burst(this.fromTreeLocal(snap.point), {
      color,
      count: 30,
      speed: 1.5,
      size: 1.1,
      life: 1.0,
      swirl: 2.6,
    });
  }

  /** Rotate the tree by `delta` radians. Shared by gestures and the mouse. */
  addSpin(delta: number): void {
    this.treeSpin += delta;
  }

  /** Resize the tree by a relative amount. Shared by gestures and the wheel. */
  addZoom(delta: number): void {
    this.targetScale = THREE.MathUtils.clamp(this.targetScale * (1 + delta), 0.65, 1.5);
  }

  /**
   * The clap payoff: the weather turns, presents rain down, and shells go up.
   * Clapping again while it is still running simply stacks more on top.
   */
  private celebrate(): void {
    this.snow.surge();
    this.giftRain.burst(16);
    this.fireworks.show(5);
    this.bloomBoost = 0.45;

    // A flash of glitter at the tree's crown ties the burst to the scene
    // rather than leaving it all happening in the sky.
    this.sparkles.burst(this.fromTreeLocal(this.tree.apexLocal), {
      color: 0xfff0c8,
      count: 90,
      speed: 3.4,
      size: 1.6,
      life: 1.6,
      gravity: 1.2,
      swirl: 3.2,
    });
  }

  /**
   * Sweeps the scene back to a bare tree: baubles, star, fairy lights, every
   * present and anything still in the air. The tree stays, and so do the
   * photos on the wall — those are the one thing here the user cannot make
   * again, so a tidy-up must not throw them away.
   */
  private undecorate(): void {
    const spots = this.ornaments.clear();

    // One puff per bauble would flood the glitter pool and drown the effect,
    // so a spread-out sample stands in for the whole tree.
    const step = Math.max(1, Math.ceil(spots.length / 16));
    for (let i = 0; i < spots.length; i += step) {
      this.sparkles.burst(this.fromTreeLocal(spots[i]), {
        color: 0xbfe6ff,
        count: 16,
        speed: 1.3,
        size: 1.0,
        life: 0.85,
        gravity: -0.5,
        swirl: 3.4,
      });
    }

    if (this.star.isPlaced) {
      this.star.reset();
      this.sparkles.burst(this.fromTreeLocal(this.tree.apexLocal), {
        color: 0xffd79a,
        count: 50,
        speed: 2.2,
        size: 1.4,
        life: 1.2,
        gravity: -0.3,
        swirl: 3.0,
      });
    }

    // toggle() rather than reset() so the strings sweep out instead of
    // vanishing between two frames.
    if (this.lights.isOn) this.lights.toggle();

    // A ring of frost around the base covers the presents disappearing.
    if (this.gifts.isPlanted || this.giftRain.count > 0) {
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2;
        this.sparkles.burst(
          new THREE.Vector3(Math.cos(angle) * 2.9, 0.35, Math.sin(angle) * 2.9),
          {
            color: 0xcfe8ff,
            count: 14,
            speed: 1.6,
            size: 1.1,
            life: 0.9,
            gravity: -0.4,
            swirl: 2.4,
          }
        );
      }
    }

    this.gifts.reset();
    this.giftRain.reset();
    this.fireworks.clear();
    this.rainbow.reset();
    this.santa.reset();
    this.lastSleigh = null;
  }

  /** Sends the sleigh on its way, with bells. */
  private launchSanta(): void {
    if (this.santa.fly()) this.sfx.sleighBells(SantaSleigh.FLIGHT_SECONDS);
  }

  /**
   * Grabs a still from the camera and pins it to the back wall. Silently does
   * nothing if the feed has no frame yet, which is the only way this can fail.
   */
  private takePhoto(): void {
    const canvas = capturePhoto(this.video);
    if (!canvas) return;

    this.photoWall.add(canvas);
    this.hud.flash();
    this.photoToast = 1.8;
    this.bloomBoost = Math.max(this.bloomBoost, 0.3);
  }

  /** Arcs a rainbow over the scene, with a glint at each of its feet. */
  private summonRainbow(): void {
    this.rainbow.show();
    for (const x of [-8.6, 8.6]) {
      this.sparkles.burst(new THREE.Vector3(x, 0.5, -6), {
        color: 0xffffff,
        count: 26,
        speed: 1.8,
        size: 1.3,
        life: 1.4,
        gravity: -0.6,
        swirl: 2.0,
      });
    }
  }

  update(hands: HandState[], dt: number): void {
    this.elapsed += dt;

    const hints: Hint[] = [];
    let prompt: string | null = null;
    let promptSub = '';
    let ring: number | null = null;

    // ---- two-handed gestures ----------------------------------------------
    // Resolved before the phase logic so they work whether or not the tree is
    // up, and so `engaged` can hold off the one-hand palm controls below.
    const two = this.twoHand.update(hands, dt);
    if (two.clapped) this.celebrate();

    const santaHold = this.hold(hands, 'pinky_up', HOLD.santa, 'santa');
    if (santaHold.fired) this.launchSanta();

    // Two thumbs up arms a self-timer. Once armed the countdown runs to
    // completion on its own, so the user is free to drop their hands and pose.
    const photoHold = this.hold(hands, 'thumbs_up', HOLD.photo, 'photo', 'two');
    if (photoHold.fired && this.shutter === null) this.shutter = PHOTO_TIMER;
    if (this.shutter !== null) {
      this.shutter -= dt;
      if (this.shutter <= 0) {
        this.shutter = null;
        this.takePhoto();
      }
    }
    this.photoToast = Math.max(0, this.photoToast - dt);

    // Three fingers on *both* hands, held: sweep the scene clean. A long hold
    // and two hands, because this one throws work away.
    const clearHold = this.hold(hands, 'three', HOLD.clear, 'clear', 'two');
    if (clearHold.fired) this.undecorate();

    // ---- phase transitions -------------------------------------------------
    if (this.phase === 'idle') {
      const plant = this.hold(hands, 'open_palm', HOLD.plant, 'plant');
      if (plant.fired) this.plant();

      if (hands.length === 0) {
        prompt = '把手举到摄像头前';
        promptSub = '看到骨架出现就可以开始了';
      } else if (plant.progress > 0.02) {
        prompt = '正在种下圣诞树…';
        promptSub = '保持手掌张开';
        ring = plant.progress;
      } else if (santaHold.progress > 0.02) {
        prompt = '呼唤圣诞老人…';
        promptSub = '保持竖起小拇指';
        ring = santaHold.progress;
      } else {
        prompt = '张开手掌，种下一棵树';
        promptSub = '五指张开并保持约一秒';
        ring = 0;
      }
      hints.push({ key: '张开手掌', label: '种下圣诞树', active: true });
      hints.push({ key: '双手拍手', label: '暴雪 + 礼物雨 + 烟花', active: this.fireworks.isBusy });
      hints.push({
        key: '双手拇指',
        label: '倒数 3 秒拍照',
        active: photoHold.progress > 0 || this.shutter !== null,
      });
      hints.push({
        key: '竖起小指',
        label: '圣诞老人驾鹿车飞过',
        active: santaHold.progress > 0 || this.santa.isFlying,
      });
    } else if (this.phase === 'growing') {
      prompt = null;
      if (this.tree.isGrown) this.phase = 'decorating';
      hints.push({ key: '生长中', label: '圣诞树正在长大…', active: true });
    }

    // ---- decorating interactions ------------------------------------------
    if (this.phase === 'decorating') {
      this.updatePinches(hands, dt);

      const starHold = this.hold(hands, 'victory', HOLD.star, 'star');
      if (starHold.fired && !this.star.isPlaced) {
        this.star.place(this.tree.apexLocal);
        this.sparkles.burst(this.fromTreeLocal(this.tree.apexLocal), {
          color: 0xffd79a,
          count: 140,
          speed: 3.0,
          size: 1.7,
          life: 2.2,
          gravity: 1.5,
          swirl: 4.0,
        });
      }

      const lightsHold = this.hold(hands, 'thumbs_up', HOLD.lights, 'lights', 'one');
      if (lightsHold.fired) this.lights.toggle();

      const resetHold = this.hold(hands, 'point', HOLD.reset, 'reset', 'two');
      if (resetHold.fired) {
        this.reset();
        return this.publish(hands, hints, '已重置', '张开手掌可以重新开始', null);
      }

      // Pointing trails glitter from the fingertip. Emitting along the segment
      // the finger covered this frame turns a fast swipe into a ribbon rather
      // than a dotted line.
      const pointer = this.find(hands, 'point');
      // The same fingertip feeds the arc detector: sweep it in a dome and the
      // rainbow appears. Screen coordinates, not world, so the shape the user
      // drew is judged exactly as they saw it.
      const drewArc = this.arc.update(
        pointer ? pointer.landmarks[LM.INDEX_TIP] : null,
        dt
      );
      if (drewArc) this.summonRainbow();

      if (pointer) {
        // Cycle the hue so the dust reads as magic rather than one flat colour.
        this.wandColor.setHSL((this.elapsed * 0.11) % 1, 0.8, 0.62);
        const lm = pointer.landmarks[LM.INDEX_TIP];
        const tip = handToWorld(lm.x, lm.y);

        if (this.lastTip) {
          const travelled = tip.distanceTo(this.lastTip);
          this.tipVel
            .subVectors(tip, this.lastTip)
            .multiplyScalar(0.22 / Math.max(dt, 1e-3));
          this.sparkles.trail(this.lastTip, tip, {
            color: this.wandColor,
            count: Math.min(14, 1 + Math.round(travelled * 30)),
            speed: 0.5,
            size: 1.3,
            life: 1.5,
            gravity: 1.1,
            swirl: 3.6,
            inherit: this.tipVel,
          });
          this.lastTip.copy(tip);
        } else {
          this.lastTip = tip.clone();
        }
        this.orb.show(tip, this.wandColor);
      } else {
        this.lastTip = null;
        this.orb.hide();
      }

      // Open palms are a turntable grab. Rotation is driven by how far the
      // palms *moved* this frame, not by where they are: an absolute mapping
      // made the direction depend on which half of the frame the hand sat in,
      // so a left hand held on the left spun the tree backwards (and a hand
      // near the middle sat in the dead zone and did nothing at all).
      //
      // While the hands are together the grab stands down: swinging two open
      // palms into a clap would otherwise jolt the tree round and shrink it.
      const palms = two.engaged ? [] : hands.filter((h) => h.gesture === 'open_palm');

      if (palms.length > 0) {
        const meanX = palms.reduce((sum, h) => sum + h.palm.x, 0) / palms.length;

        // Re-anchor whenever the hand count changes, otherwise the jump from
        // one palm's x to the midpoint of two lands as a sudden jolt.
        if (this.grabMidX === null || this.grabCount !== palms.length) {
          this.grabMidX = meanX;
          this.grabCount = palms.length;
        } else {
          // Clamp so a tracking glitch cannot fling the tree.
          const step = THREE.MathUtils.clamp(meanX - this.grabMidX, -0.08, 0.08);
          this.addSpin(step * 7.5);
          this.grabMidX = meanX;
        }

        // Two palms additionally resize, from their separation. Rotation uses
        // the midpoint and scale uses the spread precisely because the two
        // barely affect each other.
        const leftPalm = palms.find((h) => h.handedness === 'Left');
        const rightPalm = palms.find((h) => h.handedness === 'Right');
        if (leftPalm && rightPalm) {
          const spread = Math.hypot(
            leftPalm.palm.x - rightPalm.palm.x,
            leftPalm.palm.y - rightPalm.palm.y
          );
          this.scaleBaseline ??= spread;
          this.targetScale = THREE.MathUtils.clamp(
            1 + (spread - this.scaleBaseline) * 1.3,
            0.65,
            1.5
          );
        } else {
          this.scaleBaseline = null;
        }
      } else {
        this.grabMidX = null;
        this.grabCount = 0;
        this.scaleBaseline = null;
      }

      const twoHandGrab = palms.length >= 2;

      // Pick whichever hold is furthest along to display.
      const active = [
        { p: starHold.progress, text: '放上星星…', sub: '保持胜利手势' },
        { p: lightsHold.progress, text: this.lights.isOn ? '关掉彩灯…' : '点亮彩灯…', sub: '保持竖起拇指' },
        { p: resetHold.progress, text: '重置场景…', sub: '双手食指保持指向' },
        { p: santaHold.progress, text: '呼唤圣诞老人…', sub: '保持竖起小拇指' },
        { p: clearHold.progress, text: '正在清空场景…', sub: '双手保持三指张开（照片会留下）' },
      ].sort((a, b) => b.p - a.p)[0];

      if (active.p > 0.02) {
        prompt = active.text;
        promptSub = active.sub;
        ring = active.p;
      } else if (this.ornaments.count === 0) {
        prompt = '捏住再松开，挂上第一个装饰球';
        promptSub = '拇指和食指捏合，移到想挂的位置后松开';
      }

      hints.push(
        { key: '捏合松开', label: '挂一个装饰球', active: this.pinches.Left.active || this.pinches.Right.active },
        { key: '胜利手势', label: '放上星星', active: starHold.progress > 0, done: this.star.isPlaced },
        { key: '单手拇指', label: this.lights.isOn ? '关闭彩灯' : '点亮彩灯', active: lightsHold.progress > 0 },
        { key: '张开手掌', label: '左右移动 = 转动圣诞树', active: palms.length > 0 },
        { key: '双手张掌', label: '两手开合 = 放大 / 缩小', active: twoHandGrab },
        { key: '食指指向', label: '撒出魔法亮粉', active: Boolean(pointer) },
        { key: '食指画弧', label: '画出一道彩虹', active: this.rainbow.isVisible },
        { key: '双手三指', label: '清空场景（照片保留）', active: clearHold.progress > 0 },
        { key: '双手拍手', label: '暴雪 + 礼物雨 + 烟花', active: this.fireworks.isBusy },
        { key: '竖起小指', label: '圣诞老人驾鹿车飞过', active: santaHold.progress > 0 || this.santa.isFlying },
        {
          key: '双手拇指',
          label: '倒数 3 秒拍照，贴到背景墙',
          active: photoHold.progress > 0 || this.shutter !== null,
        },
        { key: '双手食指', label: '重置（或按 R）', active: resetHold.progress > 0 },
        { key: '鼠标', label: '拖动旋转 · 滚轮缩放' }
      );
    }

    // ---- animate -----------------------------------------------------------
    this.treeScale += (this.targetScale - this.treeScale) * Math.min(1, dt * 5);
    this.tree.group.rotation.y = this.treeSpin;
    this.tree.group.scale.setScalar(this.treeScale);

    // The sleigh leaves a ribbon of stardust behind it.
    const sleigh = this.santa.trailPoint;
    if (sleigh) {
      if (this.lastSleigh) {
        this.sparkles.trail(this.lastSleigh, sleigh, {
          color: this.sleighColor,
          count: 4,
          speed: 0.4,
          size: 1.0,
          life: 1.3,
          gravity: 0.5,
          swirl: 1.2,
        });
        this.lastSleigh.copy(sleigh);
      } else {
        this.lastSleigh = sleigh.clone();
      }
    } else {
      this.lastSleigh = null;
    }

    // Bloom tracks the fairy lights, with a decaying boost after a clap.
    this.bloomBoost = Math.max(0, this.bloomBoost - dt * 0.18);
    this.stage.setBloom((this.lights.isOn ? 0.82 : 0.62) + this.bloomBoost);

    this.tree.update(dt);
    this.gifts.update(dt);
    this.giftRain.update(dt);
    this.ornaments.update(dt);
    this.lights.update(dt);
    this.star.update(dt);
    this.snow.update(dt, this.elapsed);
    this.sparkles.update(dt, this.elapsed);
    this.fireworks.update(dt, this.elapsed);
    this.santa.update(dt);
    this.rainbow.update(dt);
    this.photoWall.update(dt);
    this.orb.update(dt, this.elapsed);
    this.preview.update(dt, this.elapsed);

    // The photo flow speaks over any other prompt: a countdown the user cannot
    // see is worse than a hint they miss.
    if (this.shutter !== null) {
      prompt = String(Math.ceil(this.shutter));
      promptSub = '保持姿势，准备拍照';
      ring = 1 - this.shutter / PHOTO_TIMER;
    } else if (this.photoToast > 0) {
      prompt = '照片已贴到背景墙上';
      promptSub = '再次双手竖起大拇指就可以继续拍';
      ring = null;
    } else if (photoHold.progress > 0.02) {
      prompt = '准备拍照…';
      promptSub = '双手竖起大拇指';
      ring = photoHold.progress;
    }

    this.publish(hands, hints, prompt, promptSub, ring, this.shutter !== null);
  }

  private publish(
    hands: HandState[],
    hints: Hint[],
    prompt: string | null,
    sub: string,
    ring: number | null,
    emphasis = false
  ): void {
    this.hud.setHands(hands);
    this.hud.setHints(hints);
    this.hud.setPrompt(prompt, sub, ring, emphasis);
  }

  get statsLine(): string {
    return `装饰 ${this.ornaments.count}/${ORNAMENT_CAPACITY} · 彩灯 ${
      this.lights.isOn ? 'ON' : 'OFF'
    } · 星星 ${this.star.isPlaced ? 'ON' : 'OFF'} · 照片 ${this.photoWall.count}`;
  }

  render(dt: number): void {
    this.stage.update(dt);
    this.stage.render();
  }
}
