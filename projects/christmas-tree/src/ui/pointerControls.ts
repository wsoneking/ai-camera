/**
 * Mouse / trackpad / touch fallback for the camera-driven controls: drag
 * horizontally to spin the tree, scroll to resize it. Shares the same
 * `addSpin` / `addZoom` entry points the gestures use, so the two inputs
 * compose instead of fighting.
 */
export interface PointerControlHandlers {
  onSpin(delta: number): void;
  onZoom(delta: number): void;
}

export class PointerControls {
  private dragging = false;
  private lastX = 0;

  constructor(
    private target: HTMLElement,
    private handlers: PointerControlHandlers
  ) {
    target.style.cursor = 'grab';
    target.style.touchAction = 'none';

    target.addEventListener('pointerdown', this.onDown);
    target.addEventListener('pointermove', this.onMove);
    target.addEventListener('pointerup', this.onUp);
    target.addEventListener('pointercancel', this.onUp);
    target.addEventListener('wheel', this.onWheel, { passive: false });
  }

  private onDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.lastX = e.clientX;
    this.target.style.cursor = 'grabbing';
    // Keeps the drag alive if the cursor leaves the canvas mid-gesture.
    this.target.setPointerCapture(e.pointerId);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    this.lastX = e.clientX;
    // Normalize by width so the feel is the same at any window size: a full
    // sweep across the canvas is about one and a half turns.
    this.handlers.onSpin((dx / this.target.clientWidth) * 9);
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.target.style.cursor = 'grab';
    if (this.target.hasPointerCapture(e.pointerId)) {
      this.target.releasePointerCapture(e.pointerId);
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.handlers.onZoom(-e.deltaY * 0.0012);
  };
}
