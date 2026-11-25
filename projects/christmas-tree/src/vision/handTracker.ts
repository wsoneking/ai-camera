import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Handedness = 'Left' | 'Right';

export interface HandSample {
  /** Which of the user's real hands this is, as they see themselves on screen. */
  handedness: Handedness;
  /**
   * 21 landmarks in normalized screen space of the *mirrored* preview:
   * x,y in [0,1] with origin top-left, z roughly in landmark units
   * (negative = closer to camera).
   */
  landmarks: Vec3[];
  /** 21 landmarks in metres, origin at the hand's geometric centre. */
  world: Vec3[];
  confidence: number;
}

export interface HandFrame {
  hands: HandSample[];
  /** Video timestamp (ms) the sample was produced from. */
  timestamp: number;
}

const EMPTY_FRAME: HandFrame = { hands: [], timestamp: 0 };

export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private lastVideoTime = -1;
  private frame: HandFrame = EMPTY_FRAME;

  async init(): Promise<void> {
    // wasm + model are vendored under /public, so this works fully offline.
    const fileset = await FilesetResolver.forVisionTasks('/wasm');
    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: '/models/hand_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  /**
   * Runs detection if the video has advanced since the last call, otherwise
   * returns the previous frame. Cheap to call every animation frame.
   */
  detect(video: HTMLVideoElement, nowMs: number): HandFrame {
    if (!this.landmarker || video.readyState < 2 || !video.videoWidth) {
      return this.frame;
    }
    if (video.currentTime === this.lastVideoTime) {
      return this.frame;
    }
    this.lastVideoTime = video.currentTime;

    const raw = this.landmarker.detectForVideo(video, nowMs);
    const hands: HandSample[] = [];

    for (let i = 0; i < raw.landmarks.length; i++) {
      const category = raw.handedness[i]?.[0];
      // The preview is mirrored, so mirror x to keep gesture motion aligned
      // with what the user sees. MediaPipe labels handedness as if the input
      // were already a selfie view, so flipping x means flipping the label too.
      const mirrored = raw.landmarks[i].map((p) => ({ x: 1 - p.x, y: p.y, z: p.z }));
      const world = (raw.worldLandmarks[i] ?? []).map((p) => ({ x: -p.x, y: p.y, z: p.z }));

      hands.push({
        handedness: category?.categoryName === 'Left' ? 'Right' : 'Left',
        landmarks: mirrored,
        world,
        confidence: category?.score ?? 0,
      });
    }

    this.frame = { hands, timestamp: nowMs };
    return this.frame;
  }

  dispose(): void {
    this.landmarker?.close();
    this.landmarker = null;
  }
}

/** Landmark indices, named for readability. */
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

/** Bone pairs for drawing the hand skeleton. */
export const HAND_BONES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
