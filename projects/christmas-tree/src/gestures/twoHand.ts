import { handWidth, type HandState } from './recognizer';

export interface TwoHandState {
  /**
   * Both hands are in frame and close enough together that the single-hand
   * controls (turntable spin, two-palm resize) must stand down — otherwise
   * bringing the hands together would also fling and shrink the tree.
   */
  engaged: boolean;
  /** Palm-centre separation in hand-widths; Infinity while a hand is missing. */
  separation: number;
}

/**
 * Separation below which the one-hand palm controls yield. Measured in
 * hand-widths, so the threshold holds whether the user is leaning into the
 * lens or standing back.
 */
const ENGAGE = 3.2;

/**
 * Tracks the relationship *between* the two hands — the thing a per-hand
 * classifier cannot see.
 */
export class TwoHandRecognizer {
  update(hands: HandState[]): TwoHandState {
    const left = hands.find((h) => h.handedness === 'Left');
    const right = hands.find((h) => h.handedness === 'Right');
    if (!left || !right) return { engaged: false, separation: Infinity };

    const scale = (handWidth(left) + handWidth(right)) / 2;
    const separation =
      Math.hypot(left.palm.x - right.palm.x, left.palm.y - right.palm.y) / scale;

    return { engaged: separation < ENGAGE, separation };
  }
}
