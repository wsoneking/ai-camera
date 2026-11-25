import { HAND_BONES, LM } from '../vision/handTracker';
import type { HandState } from '../gestures/recognizer';

const GESTURE_COLOR: Record<string, string> = {
  none: '#8fa3c0',
  open_palm: '#7ce7c1',
  fist: '#ffb199',
  pinch: '#ffd79a',
  point: '#9fd0ff',
  victory: '#d8a8ff',
};

/** Draws the tracked hand skeleton over the camera preview. */
export class HandOverlay {
  private ctx: CanvasRenderingContext2D;
  private dpr = Math.min(window.devicePixelRatio, 2);

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Match the backing store to the element's CSS box. */
  resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    const bw = Math.round(w * this.dpr);
    const bh = Math.round(h * this.dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
  }

  draw(hands: HandState[]): void {
    this.resize();
    const { ctx } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    for (const hand of hands) {
      const color = GESTURE_COLOR[hand.gesture] ?? GESTURE_COLOR.none;
      const pts = hand.landmarks.map((p) => ({ x: p.x * w, y: p.y * h }));

      ctx.lineWidth = Math.max(1.5, 2.2 * this.dpr);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      for (const [a, b] of HAND_BONES) {
        ctx.moveTo(pts[a].x, pts[a].y);
        ctx.lineTo(pts[b].x, pts[b].y);
      }
      ctx.stroke();

      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      for (let i = 0; i < pts.length; i++) {
        const isTip = i === LM.THUMB_TIP || i === LM.INDEX_TIP || i === LM.MIDDLE_TIP ||
          i === LM.RING_TIP || i === LM.PINKY_TIP;
        const r = (isTip ? 3.6 : 2.2) * this.dpr;
        ctx.beginPath();
        ctx.arc(pts[i].x, pts[i].y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Highlight the pinch gap, which is the main interaction affordance.
      if (hand.gesture === 'pinch') {
        ctx.strokeStyle = '#fff';
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1.6 * this.dpr;
        ctx.beginPath();
        ctx.arc(hand.pinchPoint.x * w, hand.pinchPoint.y * h, 11 * this.dpr, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }
}
