import { GESTURE_LABEL, type HandState } from '../gestures/recognizer';

export interface Hint {
  /** Short gesture name shown in the left column. */
  key: string;
  label: string;
  active?: boolean;
  done?: boolean;
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 54;

/** All DOM chrome: gesture chips, the hint list, the centre prompt, stats. */
export class Hud {
  private root = document.getElementById('hud')!;
  private chips = new Map<'Left' | 'Right', HTMLElement>();
  private hintList = document.getElementById('hud-hints')!;
  private stats = document.getElementById('hud-stats')!;
  private prompt = document.getElementById('prompt')!;
  private promptText = document.getElementById('prompt-text')!;
  private promptSub = document.getElementById('prompt-sub')!;
  private ring = document.getElementById('prompt-ring')!;
  private ringFg = this.ring.querySelector('.fg') as SVGCircleElement;
  private flashEl = document.getElementById('flash')!;

  private hintSignature = '';
  private promptSignature = '';

  constructor() {
    for (const hand of ['left', 'right'] as const) {
      const el = document.querySelector<HTMLElement>(`.hand-chip[data-hand="${hand}"]`)!;
      this.chips.set(hand === 'left' ? 'Left' : 'Right', el);
    }
  }

  ready(): void {
    this.root.classList.add('ready');
  }

  setHands(hands: HandState[]): void {
    for (const [key, el] of this.chips) {
      const hand = hands.find((h) => h.handedness === key);
      el.classList.toggle('live', Boolean(hand));
      const label = hand ? GESTURE_LABEL[hand.gesture] : '—';
      const span = el.querySelector('span')!;
      if (span.textContent !== label) span.textContent = label;
    }
  }

  setHints(hints: Hint[]): void {
    // Rebuilding the list every frame would thrash the DOM; only touch it when
    // the content actually changes.
    const signature = hints.map((h) => `${h.key}|${h.label}|${h.active}|${h.done}`).join('~');
    if (signature === this.hintSignature) return;
    this.hintSignature = signature;

    this.hintList.replaceChildren(
      ...hints.map((h) => {
        const li = document.createElement('li');
        if (h.active) li.classList.add('active');
        const i = document.createElement('i');
        i.textContent = h.key;
        const text = document.createElement('span');
        text.textContent = h.done ? `${h.label} ✓` : h.label;
        li.append(i, text);
        return li;
      })
    );
  }

  /**
   * Centre prompt. `progress` in [0,1] draws the hold ring; pass null to hide
   * the ring, or `null` text to hide the prompt entirely. `emphasis` blows the
   * text up, for the photo countdown.
   */
  setPrompt(
    text: string | null,
    sub = '',
    progress: number | null = null,
    emphasis = false
  ): void {
    this.prompt.classList.toggle('big', emphasis);

    const signature = `${text}|${sub}`;
    if (signature !== this.promptSignature) {
      this.promptSignature = signature;
      this.promptText.textContent = text ?? '';
      this.promptSub.textContent = sub;
      this.prompt.classList.toggle('show', Boolean(text));
    }

    const showRing = progress !== null;
    this.ring.classList.toggle('show', showRing);
    if (showRing) {
      const p = Math.max(0, Math.min(1, progress));
      this.ringFg.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - p));
    }
  }

  setStats(text: string): void {
    if (this.stats.textContent !== text) this.stats.textContent = text;
  }

  /** Camera-shutter flash, for when a photo is taken. */
  flash(): void {
    this.flashEl.classList.remove('fire');
    // Reading a layout property restarts the animation; without this the class
    // goes straight back on in the same frame and nothing replays.
    void this.flashEl.offsetWidth;
    this.flashEl.classList.add('fire');
  }
}
