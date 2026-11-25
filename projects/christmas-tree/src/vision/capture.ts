/**
 * Grabs a still out of the live camera feed, as a canvas ready to be used as
 * a texture.
 */

/** Photos are stored 4:3, which is also what most webcams natively shoot. */
export const PHOTO_ASPECT = 4 / 3;

export function capturePhoto(
  video: HTMLVideoElement,
  width = 512
): HTMLCanvasElement | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  // Centre-crop the frame to the photo's aspect rather than squashing it.
  let sw = vw;
  let sh = vw / PHOTO_ASPECT;
  if (sh > vh) {
    sh = vh;
    sw = vh * PHOTO_ASPECT;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round(width / PHOTO_ASPECT);

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // The preview is mirrored (CSS `scaleX(-1)`) so the user sees themselves as
  // in a mirror; the still has to be mirrored the same way or the photo comes
  // out flipped relative to the pose they just struck.
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);

  return canvas;
}
