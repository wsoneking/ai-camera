import { Stage } from './scene/stage';
import { Experience } from './app/experience';
import { HandTracker } from './vision/handTracker';
import { GestureRecognizer } from './gestures/recognizer';
import { cameraErrorMessage, startCamera } from './vision/camera';
import { Hud } from './ui/hud';
import { HandOverlay } from './ui/handOverlay';
import { PointerControls } from './ui/pointerControls';
import { MusicBox } from './audio/music';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const video = document.getElementById('cam') as HTMLVideoElement;
const camPanel = document.getElementById('cam-panel')!;
const camOverlay = document.getElementById('cam-overlay') as HTMLCanvasElement;
const controls = document.getElementById('controls')!;
const musicBtn = document.getElementById('music-btn') as HTMLButtonElement;
const gate = document.getElementById('gate')!;
const gateBtn = document.getElementById('gate-btn') as HTMLButtonElement;
const gateError = document.getElementById('gate-error')!;

const stage = new Stage({ canvas });
const hud = new Hud();
const overlay = new HandOverlay(camOverlay);
const tracker = new HandTracker();
const recognizer = new GestureRecognizer();
const music = new MusicBox();
const experience = new Experience(stage, hud, video, music);

// Mouse / trackpad fallback: drag the canvas to spin, scroll to resize.
new PointerControls(canvas, {
  onSpin: (d) => experience.addSpin(d),
  onZoom: (d) => experience.addZoom(d),
});

function syncMusicButton(on: boolean): void {
  musicBtn.setAttribute('aria-pressed', String(on));
  musicBtn.querySelector('.lbl')!.textContent = on ? '音乐 开' : '音乐 关';
}

musicBtn.addEventListener('click', async () => {
  musicBtn.disabled = true;
  try {
    syncMusicButton(await music.toggle());
  } catch (err) {
    console.error('音乐启动失败', err);
    syncMusicButton(false);
  } finally {
    musicBtn.disabled = false;
  }
});
syncMusicButton(false);

// Keep rendering the empty scene behind the gate so the first frame the user
// sees after granting permission is already warm.
let running = false;
let lastTime = performance.now();
let fps = 0;
let statsTimer = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);

  // Clamp dt so a backgrounded tab doesn't fast-forward every animation.
  const dt = Math.min((now - lastTime) / 1000, 1 / 20);
  lastTime = now;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.1;

  if (running) {
    const { hands } = tracker.detect(video, now);
    const states = recognizer.update(hands, dt);
    experience.update(states, dt);
    overlay.draw(states);

    statsTimer -= dt;
    if (statsTimer <= 0) {
      statsTimer = 0.25;
      hud.setStats(`${experience.statsLine} · ${fps.toFixed(0)} FPS`);
    }
  } else {
    experience.update([], dt);
  }

  experience.render(dt);
}

requestAnimationFrame(frame);

async function boot(): Promise<void> {
  gateBtn.disabled = true;
  gateBtn.textContent = '正在启动…';
  gateError.textContent = '';

  try {
    await startCamera(video);

    gateBtn.textContent = '正在加载手势模型…';
    await tracker.init();

    // Match the preview box to the real camera aspect so `object-fit: cover`
    // crops nothing and the skeleton overlay lines up exactly.
    camPanel.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;

    running = true;
    gate.classList.add('hide');
    camPanel.classList.add('ready');
    controls.classList.add('ready');
    hud.ready();

    // The gate click counts as the user gesture browsers require before audio
    // may start, so the carol can come up with the scene. The button turns it
    // off; flip this line if you would rather it start silent.
    try {
      syncMusicButton(await music.toggle());
    } catch (err) {
      console.error('音乐启动失败', err);
    }
  } catch (err) {
    console.error(err);
    gateError.textContent = cameraErrorMessage(err);
    gateBtn.disabled = false;
    gateBtn.textContent = '重试';
  }
}

gateBtn.addEventListener('click', boot);
