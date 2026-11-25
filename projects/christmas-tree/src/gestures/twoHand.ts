import { LM } from '../vision/handTracker';
import { handWidth, type HandState } from './recognizer';

export interface TwoHandState {
  /**
   * Both hands are in frame and close enough together that the single-hand
   * controls (turntable spin, two-palm resize) must stand down — otherwise
   * bringing the hands together to clap would also fling and shrink the tree.
   */
  engaged: boolean;
  /** Palm-centre separation in hand-widths; Infinity while a hand is missing. */
  separation: number;
  /** True on the one frame a clap impact is detected. */
  clapped: boolean;
}

/**
 * All distances are in hand-widths, so every threshold holds whether the user
 * is leaning into the lens or standing back.
 */
const TOGETHER = 2.5;
/** Separation below which the one-hand palm controls yield. */
const ENGAGE = 3.2;
/** Closing speed, in hand-widths per second, that counts as an impact. */
const CLAP_SPEED = 5.5;
const CLAP_COOLDOWN = 0.45;

/**
 * Raw (unsmoothed) palm centre. `HandState.palm` is exponentially smoothed,
 * which lags the impact frame and flattens the closing speed a clap is
 * detected by, so the clap test reads the landmarks directly.
 */
function palmOf(h: HandState): { x: number; y: number } {
  const w = h.landmarks[LM.WRIST];
  const m = h.landmarks[LM.MIDDLE_MCP];
  return { x: (w.x + m.x) / 2, y: (w.y + m.y) / 2 };
}

/**
 * Detects a clap: two open palms meeting fast. What makes it a clap rather
 * than "hands that happen to be near each other" is the closing *speed*, so
 * the detector tracks how the palm separation changes frame to frame.
 */
export class TwoHandRecognizer {
  private prevSeparation: number | null = null;
  private cooldown = 0;

  update(hands: HandState[], dt: number): TwoHandState {
    this.cooldown = Math.max(0, this.cooldown - dt);

    const left = hands.find((h) => h.handedness === 'Left');
    const right = hands.find((h) => h.handedness === 'Right');
    if (!left || !right) {
      this.prevSeparation = null;
      return { engaged: this.cooldown > 0, separation: Infinity, clapped: false };
    }

    const scale = (handWidth(left) + handWidth(right)) / 2;
    const a = palmOf(left);
    const b = palmOf(right);
    const separation = Math.hypot(a.x - b.x, a.y - b.y) / scale;

    const closing =
      this.prevSeparation === null ? 0 : (this.prevSeparation - separation) / Math.max(dt, 1e-3);
    this.prevSeparation = separation;

    // Classification is unreliable with palms seen edge-on, so openness (not
    // the gesture label) is what distinguishes clapping hands from fists.
    const bothOpen = left.openness > 0.3 && right.openness > 0.3;
    let clapped = false;
    if (bothOpen && separation < TOGETHER && closing > CLAP_SPEED && this.cooldown === 0) {
      clapped = true;
      this.cooldown = CLAP_COOLDOWN;
    }

    return {
      engaged: separation < ENGAGE || this.cooldown > 0,
      separation,
      clapped,
    };
  }
}
