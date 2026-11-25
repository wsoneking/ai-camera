/**
 * Detection for gestures that are a *movement* rather than a hand shape: one
 * sample per frame in, a one-shot event out.
 */

interface StrokePoint {
  x: number;
  y: number;
  /** Seconds since this sample was taken. */
  age: number;
}

/**
 * An arc drawn in the air: a sweep sideways that bulges upward in the middle,
 * i.e. the shape of a rainbow.
 *
 * Points come in normalized frame coordinates (y grows downward). Only the
 * most recent run in one horizontal direction is considered, so pointing
 * around beforehand cannot spoil the stroke that follows.
 */
export class ArcStrokeDetector {
  private points: StrokePoint[] = [];
  private cooldown = 0;

  /** Only the last couple of seconds of movement can form one stroke. */
  private static readonly WINDOW = 2.0;
  private static readonly MAX_POINTS = 180;
  /** Fraction of the frame width the sweep must cover. */
  private static readonly MIN_SPAN = 0.3;
  /** How far the apex must sit above the higher of the two ends. */
  private static readonly MIN_RISE = 0.07;
  private static readonly COOLDOWN = 1.5;

  /** `tip` in normalized frame coordinates, or null when not pointing. */
  update(tip: { x: number; y: number } | null, dt: number): boolean {
    this.cooldown = Math.max(0, this.cooldown - dt);

    if (!tip) {
      this.points.length = 0;
      return false;
    }

    for (const p of this.points) p.age += dt;
    while (this.points.length > 0 && this.points[0].age > ArcStrokeDetector.WINDOW) {
      this.points.shift();
    }
    this.points.push({ x: tip.x, y: tip.y, age: 0 });
    if (this.points.length > ArcStrokeDetector.MAX_POINTS) this.points.shift();

    if (this.cooldown > 0 || this.points.length < 10) return false;
    return this.detect();
  }

  private detect(): boolean {
    const pts = this.points;
    const n = pts.length;

    // Direction of the last few samples, then walk back to where the hand
    // last turned around: that run is the candidate stroke.
    const recent = pts[n - 1].x - pts[Math.max(0, n - 6)].x;
    if (Math.abs(recent) < 1e-4) return false;
    const sign = recent > 0 ? 1 : -1;

    let from = n - 1;
    while (from > 0 && (pts[from].x - pts[from - 1].x) * sign >= -0.004) from--;

    const seg = pts.slice(from);
    if (seg.length < 10) return false;

    const start = seg[0];
    const end = seg[seg.length - 1];
    const span = end.x - start.x;
    if (Math.abs(span) < ArcStrokeDetector.MIN_SPAN) return false;

    let apex = seg[0];
    for (const p of seg) if (p.y < apex.y) apex = p;
    if (Math.min(start.y, end.y) - apex.y < ArcStrokeDetector.MIN_RISE) return false;

    // The high point has to sit in the middle of the sweep. Without this a
    // plain diagonal swipe (apex at one end) would read as an arc.
    const along = (apex.x - start.x) / span;
    if (along < 0.25 || along > 0.75) return false;

    this.points.length = 0;
    this.cooldown = ArcStrokeDetector.COOLDOWN;
    return true;
  }
}
