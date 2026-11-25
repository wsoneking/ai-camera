/**
 * Webcam acquisition. Prefers a front-facing camera at a modest resolution —
 * hand tracking does not benefit from 1080p and the extra pixels cost latency.
 */
export async function startCamera(video: HTMLVideoElement): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      '当前浏览器不支持摄像头 API。请使用 Chrome / Edge / Safari，并通过 http://localhost 或 https 访问。'
    );
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 60 },
    },
  });

  video.srcObject = stream;
  await video.play();

  // Metadata can still be pending right after play() on some browsers.
  if (!video.videoWidth) {
    await new Promise<void>((resolve) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    });
  }
}

export function cameraErrorMessage(err: unknown): string {
  const name = (err as DOMException)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '摄像头权限被拒绝。请在浏览器地址栏的权限设置中允许摄像头，然后刷新页面。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '没有检测到可用的摄像头设备。';
    case 'NotReadableError':
      return '摄像头被其他应用占用（例如 Zoom / FaceTime）。请关闭它们后重试。';
    default:
      return `摄像头启动失败：${(err as Error)?.message ?? String(err)}`;
  }
}
