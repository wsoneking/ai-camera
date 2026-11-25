/**
 * Procedural Christmas music box.
 *
 * Everything is synthesised with WebAudio at runtime, so there are no audio
 * assets to ship and no licensing questions: the tune is "Jingle Bells"
 * (James Lord Pierpont, 1857), which is public domain.
 *
 * Voices: a glockenspiel-ish bell for the melody, a soft sine pad for the
 * chords, and a filtered-noise sleigh-bell shaker on the eighths. All of it
 * goes through a procedurally generated reverb.
 */

const TEMPO = 112;
const BEATS_PER_BAR = 4;
/** How far ahead of the clock we queue notes, in seconds. */
const LOOKAHEAD = 0.6;
const TICK_MS = 60;

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Melody as [midi, beats]; C4 = 60. Bars are exactly 4 beats, none tied. */
const MELODY: ReadonlyArray<readonly [number, number]> = [
  // "Jingle bells, jingle bells, jingle all the way"
  [64, 1], [64, 1], [64, 2],
  [64, 1], [64, 1], [64, 2],
  [64, 1], [67, 1], [60, 1.5], [62, 0.5],
  [64, 4],
  // "Oh what fun it is to ride in a one-horse open sleigh"
  [65, 1], [65, 1], [65, 1.5], [65, 0.5],
  [65, 1], [64, 1], [64, 1], [64, 0.5], [64, 0.5],
  [64, 1], [62, 1], [62, 1], [64, 1],
  [62, 2], [67, 2],
  // repeat
  [64, 1], [64, 1], [64, 2],
  [64, 1], [64, 1], [64, 2],
  [64, 1], [67, 1], [60, 1.5], [62, 0.5],
  [64, 4],
  [65, 1], [65, 1], [65, 1.5], [65, 0.5],
  [65, 1], [64, 1], [64, 1], [64, 0.5], [64, 0.5],
  [67, 1], [67, 1], [65, 1], [62, 1],
  [60, 4],
];

/** One chord per bar, as midi triads. */
const CHORDS: ReadonlyArray<ReadonlyArray<number>> = [
  [60, 64, 67], [60, 64, 67], [60, 64, 67], [60, 64, 67],
  [65, 69, 72], [60, 64, 67], [67, 71, 74], [67, 71, 74],
  [60, 64, 67], [60, 64, 67], [60, 64, 67], [60, 64, 67],
  [65, 69, 72], [60, 64, 67], [67, 71, 74], [60, 64, 67],
];

interface BarNote {
  midi: number;
  /** Beats from the start of its bar. */
  offset: number;
  beats: number;
}

/** Group the flat melody into bars once, at module load. */
const BARS: BarNote[][] = (() => {
  const bars: BarNote[][] = [];
  let current: BarNote[] = [];
  let beat = 0;

  for (const [midi, beats] of MELODY) {
    current.push({ midi, offset: beat, beats });
    beat += beats;
    if (beat >= BEATS_PER_BAR) {
      bars.push(current);
      current = [];
      beat = 0;
    }
  }
  if (current.length) bars.push(current);
  return bars;
})();

export class MusicBox {
  private ctx: AudioContext | null = null;
  /** Final output. Everything — music and effects — lands here. */
  private out!: GainNode;
  /** Music level, which the on/off toggle fades. Effects bypass it. */
  private musicGain!: GainNode;
  private bellBus!: GainNode;
  private padBus!: GainNode;
  private shakerBus!: GainNode;
  private sfxBus!: GainNode;
  private noise!: AudioBuffer;

  private timer: number | null = null;
  private barIndex = 0;
  private nextBarTime = 0;
  private playing = false;

  private readonly beat = 60 / TEMPO;
  private readonly barDuration = (60 / TEMPO) * BEATS_PER_BAR;

  get isOn(): boolean {
    return this.playing;
  }

  /**
   * Must be called from a user gesture (a click), otherwise browsers refuse to
   * start the audio clock.
   */
  async toggle(): Promise<boolean> {
    if (this.playing) {
      this.stop();
    } else {
      await this.start();
    }
    return this.playing;
  }

  private async start(): Promise<void> {
    if (!this.ctx) this.build();
    const ctx = this.ctx!;
    if (ctx.state === 'suspended') await ctx.resume();

    this.playing = true;
    this.musicGain.gain.cancelScheduledValues(ctx.currentTime);
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, ctx.currentTime);
    this.musicGain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 1.2);

    // Start on the next clock tick, not retroactively.
    this.nextBarTime = ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private stop(): void {
    const ctx = this.ctx;
    this.playing = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!ctx) return;
    // Already-queued notes keep playing, but into a gain that is fading out.
    this.musicGain.gain.cancelScheduledValues(ctx.currentTime);
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, ctx.currentTime);
    this.musicGain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.7);
  }

  /**
   * Hands back a running context, building one on first use. Returns null if
   * the browser will not let audio start yet — effects are then simply silent
   * rather than throwing from a gesture callback.
   */
  private ensureContext(): AudioContext | null {
    if (!this.ctx) this.build();
    const ctx = this.ctx!;
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx.state === 'closed' ? null : ctx;
  }

  /**
   * Sleigh bells for the Santa flyby: a shaker on every eighth under a short
   * bell motif, the whole thing swelling as he comes past and thinning out as
   * he leaves. Plays whether or not the music is on, and never throws.
   */
  sleighBells(duration: number): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const at = ctx.currentTime + 0.05;
    const step = 0.15;
    const hits = Math.max(1, Math.floor(duration / step));

    for (let i = 0; i < hits; i++) {
      const t = i / hits;
      // Peaks a little past the middle of the flight, where the sleigh makes
      // its close pass in front of the tree.
      const near = Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.08)), 1.5);
      const accent = i % 2 === 0 ? 1 : 0.62;
      this.playShaker(at + i * step, (0.3 + 1.5 * near) * accent, this.sfxBus);
    }

    // "Jingle bells" opening phrase, twice: once on the way in, once up close.
    const motif = [64, 64, 64, 64, 64, 64];
    for (const [pass, offset] of [[0, 0.6], [1, duration * 0.52]] as const) {
      for (let i = 0; i < motif.length; i++) {
        const gain = pass === 0 ? 0.5 : 1;
        this.playBell(
          midiToFreq(motif[i] + 12),
          at + offset + i * 0.3,
          0.9,
          this.sfxBus,
          gain
        );
      }
    }
  }

  private build(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;

    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(ctx.destination);

    // The music toggle fades this, not the output, so sound effects keep
    // working with the carol switched off.
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0.0001;
    this.musicGain.connect(this.out);

    // Procedural reverb: exponentially decaying noise as an impulse response.
    const reverb = ctx.createConvolver();
    reverb.buffer = this.makeImpulse(2.6, 2.4);
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    reverb.connect(wet);
    // Straight to the output: routed through musicGain, the reverb tail of an
    // effect would be muted along with the music.
    wet.connect(this.out);

    const route = (gain: number, wetAmount: number, into: GainNode): GainNode => {
      const bus = ctx.createGain();
      bus.gain.value = gain;
      bus.connect(into);
      const send = ctx.createGain();
      send.gain.value = wetAmount;
      bus.connect(send);
      send.connect(reverb);
      return bus;
    };

    this.bellBus = route(0.5, 1.0, this.musicGain);
    this.padBus = route(0.17, 0.6, this.musicGain);
    this.shakerBus = route(0.12, 0.5, this.musicGain);
    this.sfxBus = route(0.3, 0.7, this.out);

    // Mono noise for the shaker, generated once.
    const len = Math.floor(ctx.sampleRate * 0.5);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buffer;
  }

  private tick(): void {
    const ctx = this.ctx;
    if (!ctx || !this.playing) return;

    while (this.nextBarTime < ctx.currentTime + LOOKAHEAD) {
      this.scheduleBar(this.barIndex, this.nextBarTime);
      this.barIndex++;
      this.nextBarTime += this.barDuration;
    }
  }

  private scheduleBar(index: number, at: number): void {
    const bar = BARS[index % BARS.length];
    const chord = CHORDS[index % CHORDS.length];

    // Pad an octave below, held for the whole bar.
    for (const midi of chord) {
      this.playPad(midiToFreq(midi - 12), at, this.barDuration);
    }

    // Melody an octave up, where a bell voice sits best.
    for (const note of bar) {
      this.playBell(
        midiToFreq(note.midi + 12),
        at + note.offset * this.beat,
        // Let bells ring past their written length, but not forever.
        Math.min(note.beats * this.beat * 2.2, 2.0)
      );
    }

    for (let i = 0; i < BEATS_PER_BAR * 2; i++) {
      this.playShaker(at + i * this.beat * 0.5, i % 2 === 0 ? 1 : 0.55);
    }
  }

  /** Glockenspiel-ish strike: a triangle fundamental plus a detuned octave. */
  private playBell(
    freq: number,
    at: number,
    duration: number,
    into: GainNode = this.bellBus,
    level = 1
  ): void {
    const ctx = this.ctx!;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.9 * level, at + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    env.connect(into);

    const fundamental = ctx.createOscillator();
    fundamental.type = 'triangle';
    fundamental.frequency.value = freq;
    fundamental.connect(env);

    // Slightly sharp octave gives the metallic shimmer of a struck bar.
    const shimmerGain = ctx.createGain();
    shimmerGain.gain.value = 0.3;
    shimmerGain.connect(env);
    const shimmer = ctx.createOscillator();
    shimmer.type = 'sine';
    shimmer.frequency.value = freq * 2.01;
    shimmer.connect(shimmerGain);

    for (const osc of [fundamental, shimmer]) {
      osc.start(at);
      osc.stop(at + duration + 0.05);
    }
  }

  private playPad(freq: number, at: number, duration: number): void {
    const ctx = this.ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.6;
    filter.connect(this.padBus);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.5, at + duration * 0.35);
    env.gain.linearRampToValueAtTime(0, at + duration);
    env.connect(filter);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(env);

    // A second voice a hair detuned keeps the pad from sounding sterile.
    const detuned = ctx.createOscillator();
    detuned.type = 'sine';
    detuned.frequency.value = freq * 1.004;
    detuned.connect(env);

    for (const o of [osc, detuned]) {
      o.start(at);
      o.stop(at + duration + 0.05);
    }
  }

  /** Sleigh bells: a short burst of bright noise. */
  private playShaker(at: number, accent: number, into: GainNode = this.shakerBus): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    // Random offset so successive hits are not identical.
    const offset = Math.random() * 0.3;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 5200;
    bandpass.Q.value = 1.4;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.5 * accent, at + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);

    src.connect(bandpass);
    bandpass.connect(env);
    env.connect(into);

    src.start(at, offset, 0.2);
    src.stop(at + 0.2);
  }
}
