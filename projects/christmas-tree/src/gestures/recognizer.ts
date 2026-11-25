import { LM, type HandSample, type Vec3 } from '../vision/handTracker';

export type Gesture =
  | 'none'
  | 'open_palm'
  | 'fist'
  | 'pinch'
  | 'point'
  | 'three'
  | 'victory'
  | 'thumbs_up'
  | 'pinky_up';

export const GESTURE_LABEL: Record<Gesture, string> = {
  none: '—',
  open_palm: '张开手掌',
  fist: '握拳',
  pinch: '捏合',
  point: '食指指向',
  three: '三指张开',
  victory: '胜利手势',
  thumbs_up: '竖起拇指',
  pinky_up: '竖起小拇指',
};

export interface HandState {
  handedness: 'Left' | 'Right';
  gesture: Gesture;
  /** Gesture before smoothing — useful for debugging, not for logic. */
  rawGesture: Gesture;
  /** Normalized screen position of the palm centre (mirrored preview space). */
  palm: Vec3;
  /** Normalized screen position of the thumb/index midpoint. */
  pinchPoint: Vec3;
  /** 0 = fingers touching, 1 = wide pinch. Drives the ornament preview size. */
  pinchAmount: number;
  /** 0 = closed fist, 1 = fully splayed hand. */
  openness: number;
  /** Seconds the smoothed gesture has been held continuously. */
  heldFor: number;
  confidence: number;
  landmarks: Vec3[];
}

const FINGERS = [
  [LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_TIP],
  [LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_TIP],
  [LM.RING_MCP, LM.RING_PIP, LM.RING_TIP],
  [LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_TIP],
] as const;

/**
 * On-screen hand width (wrist→middle knuckle) in normalized frame units.
 * Motion thresholds are expressed in multiples of this so a gesture means the
 * same thing whether the user is leaning into the lens or standing back.
 */
export function handWidth(hand: Pick<HandState, 'landmarks'>): number {
  const w = hand.landmarks[LM.WRIST];
  const m = hand.landmarks[LM.MIDDLE_MCP];
  return Math.max(Math.hypot(w.x - m.x, w.y - m.y), 1e-4);
}

/** Angle (degrees) at `b` between b→a and b→c. 180 = perfectly straight. */
function jointAngle(a: Vec3, b: Vec3, c: Vec3): number {
  const ax = a.x - b.x, ay = a.y - b.y, az = a.z - b.z;
  const cx = c.x - b.x, cy = c.y - b.y, cz = c.z - b.z;
  const la = Math.hypot(ax, ay, az);
  const lc = Math.hypot(cx, cy, cz);
  if (la < 1e-6 || lc < 1e-6) return 180;
  const cos = (ax * cx + ay * cy + az * cz) / (la * lc);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function mid(a: Vec3, b: Vec3): Vec3 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

/**
 * Classifies a single hand from its 3D world landmarks. World landmarks are
 * metric and centred on the hand, so joint angles are independent of how far
 * the user is from the camera — much steadier than screen-space heuristics.
 */
function classify(hand: HandSample): {
  gesture: Gesture;
  pinchAmount: number;
  openness: number;
} {
  // Fall back to screen landmarks if world landmarks are unavailable.
  const p = hand.world.length === 21 ? hand.world : hand.landmarks;

  // Hand scale: wrist to middle-finger knuckle. Everything is measured in
  // multiples of this so the thresholds hold for big and small hands alike.
  const scale = Math.max(dist(p[LM.WRIST], p[LM.MIDDLE_MCP]), 1e-4);

  const extended = FINGERS.map(([mcp, pip, tip]) => {
    const angle = jointAngle(p[mcp], p[pip], p[tip]);
    return angle > 150;
  });
  const curled = FINGERS.map(([mcp, pip, tip]) => {
    const angle = jointAngle(p[mcp], p[pip], p[tip]);
    return angle < 110;
  });

  const extCount = extended.filter(Boolean).length;
  const thumbExtended = jointAngle(p[LM.THUMB_MCP], p[LM.THUMB_IP], p[LM.THUMB_TIP]) > 150;

  // Openness: mean normalized tip distance from the wrist, remapped so a
  // tight fist reads ~0 and a splayed hand ~1.
  const tipSpan =
    FINGERS.reduce((sum, [, , tip]) => sum + dist(p[tip], p[LM.WRIST]), 0) /
    (FINGERS.length * scale);
  const openness = clamp01((tipSpan - 1.05) / 0.85);

  const pinchGap = dist(p[LM.THUMB_TIP], p[LM.INDEX_TIP]) / scale;
  const pinchAmount = clamp01(pinchGap / 0.9);
  // Pinching requires thumb and index tips nearly touching while the outer
  // fingers stay folded — otherwise an open palm seen edge-on can read as pinch.
  const isPinch = pinchGap < 0.34 && curled[2] && curled[3];

  // Thumbs up: a closed fist with the thumb sticking clearly upward. "Up" is
  // only meaningful in screen space (y grows downward), so this one test uses
  // the normalized screen landmarks rather than the hand-centric world ones.
  const scr = hand.landmarks;
  const screenScale = Math.max(
    Math.hypot(
      scr[LM.WRIST].x - scr[LM.MIDDLE_MCP].x,
      scr[LM.WRIST].y - scr[LM.MIDDLE_MCP].y
    ),
    1e-4
  );
  const thumbRise = (scr[LM.INDEX_MCP].y - scr[LM.THUMB_TIP].y) / screenScale;
  const allCurled = curled[0] && curled[1] && curled[2] && curled[3];
  const isThumbsUp = thumbExtended && allCurled && thumbRise > 0.5;

  // Pinky up: only the little finger out, and raised rather than just poking
  // sideways out of a relaxed hand. Same screen-space reasoning as thumbs up.
  const pinkyRise = (scr[LM.PINKY_MCP].y - scr[LM.PINKY_TIP].y) / screenScale;
  const isPinkyUp = extended[3] && curled[0] && curled[1] && curled[2] && pinkyRise > 0.55;

  let gesture: Gesture = 'none';
  // Checked before both pinch and fist: a thumbs-up is a fist by finger count,
  // so whichever of those matched first would otherwise swallow it.
  if (isThumbsUp) {
    gesture = 'thumbs_up';
  } else if (isPinkyUp) {
    gesture = 'pinky_up';
  } else if (isPinch) {
    gesture = 'pinch';
  } else if (extended[0] && extended[1] && curled[2] && curled[3]) {
    gesture = 'victory';
  } else if (extended[0] && extended[1] && extended[2] && curled[3]) {
    // Index + middle + ring up, pinky folded. The thumb is left unconstrained:
    // it sits wherever it likes when three fingers go up.
    gesture = 'three';
  } else if (extended[0] && curled[1] && curled[2] && curled[3]) {
    gesture = 'point';
  } else if (extCount >= 4 && thumbExtended && openness > 0.55) {
    gesture = 'open_palm';
  } else if (extCount === 0 && openness < 0.3) {
    gesture = 'fist';
  }

  return { gesture, pinchAmount, openness };
}

/** Debounces per-hand classification and tracks how long a gesture is held. */
class HandSmoother {
  private committed: Gesture = 'none';
  private candidate: Gesture = 'none';
  private candidateFrames = 0;
  private heldFor = 0;

  /** A gesture must survive this many consecutive frames before it counts. */
  private static readonly CONFIRM_FRAMES = 3;

  update(raw: Gesture, dt: number): { gesture: Gesture; heldFor: number } {
    if (raw === this.committed) {
      this.candidate = raw;
      this.candidateFrames = 0;
      this.heldFor += dt;
    } else if (raw === this.candidate) {
      this.candidateFrames++;
      if (this.candidateFrames >= HandSmoother.CONFIRM_FRAMES) {
        this.committed = raw;
        this.heldFor = 0;
      }
    } else {
      this.candidate = raw;
      this.candidateFrames = 1;
    }
    return { gesture: this.committed, heldFor: this.heldFor };
  }

  reset(): void {
    this.committed = 'none';
    this.candidate = 'none';
    this.candidateFrames = 0;
    this.heldFor = 0;
  }
}

/** Exponential smoothing for the noisy normalized positions. */
class PointSmoother {
  private value: Vec3 | null = null;

  update(next: Vec3, alpha: number): Vec3 {
    if (!this.value) {
      this.value = { ...next };
    } else {
      this.value.x += (next.x - this.value.x) * alpha;
      this.value.y += (next.y - this.value.y) * alpha;
      this.value.z += (next.z - this.value.z) * alpha;
    }
    return { ...this.value };
  }

  reset(): void {
    this.value = null;
  }
}

interface Slot {
  gesture: HandSmoother;
  palm: PointSmoother;
  pinch: PointSmoother;
  openness: number;
  pinchAmount: number;
}

function makeSlot(): Slot {
  return {
    gesture: new HandSmoother(),
    palm: new PointSmoother(),
    pinch: new PointSmoother(),
    openness: 0,
    pinchAmount: 1,
  };
}

/**
 * Turns raw per-frame hand samples into stable, debounced gesture states.
 * Keyed by handedness so each hand keeps its own history across frames.
 */
export class GestureRecognizer {
  private slots: Record<'Left' | 'Right', Slot> = {
    Left: makeSlot(),
    Right: makeSlot(),
  };

  update(hands: HandSample[], dt: number): HandState[] {
    const seen = new Set<'Left' | 'Right'>();
    const states: HandState[] = [];

    for (const hand of hands) {
      // Two hands reported with the same label would otherwise fight over one
      // slot; give the duplicate the free slot instead.
      let key = hand.handedness;
      if (seen.has(key)) key = key === 'Left' ? 'Right' : 'Left';
      if (seen.has(key)) continue;
      seen.add(key);

      const slot = this.slots[key];
      const { gesture: raw, pinchAmount, openness } = classify(hand);
      const { gesture, heldFor } = slot.gesture.update(raw, dt);

      slot.openness += (openness - slot.openness) * 0.3;
      slot.pinchAmount += (pinchAmount - slot.pinchAmount) * 0.4;

      const palmRaw = mid(hand.landmarks[LM.WRIST], hand.landmarks[LM.MIDDLE_MCP]);
      const pinchRaw = mid(hand.landmarks[LM.THUMB_TIP], hand.landmarks[LM.INDEX_TIP]);

      states.push({
        handedness: key,
        gesture,
        rawGesture: raw,
        palm: slot.palm.update(palmRaw, 0.35),
        pinchPoint: slot.pinch.update(pinchRaw, 0.45),
        pinchAmount: slot.pinchAmount,
        openness: slot.openness,
        heldFor,
        confidence: hand.confidence,
        landmarks: hand.landmarks,
      });
    }

    // Any hand that left the frame forgets its history, so a returning hand
    // cannot instantly re-trigger a hold it had already charged up.
    for (const key of ['Left', 'Right'] as const) {
      if (!seen.has(key)) {
        this.slots[key].gesture.reset();
        this.slots[key].palm.reset();
        this.slots[key].pinch.reset();
      }
    }

    return states;
  }
}
