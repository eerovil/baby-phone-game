/**
 * All sound is synthesised on the device with WebAudio.
 *
 * Nothing is fetched during play, so a phone on a weak connection still makes
 * noise, and there is no media file to fail to decode on an old browser.
 *
 * Mobile browsers only let audio start from a user gesture. `unlock()` is
 * called from the tap that creates or joins a room, which is what makes a
 * server-triggered turn minutes later able to play at all.
 */

/** Note patterns, one per visual variant. Values are MIDI-ish semitone offsets. */
const PATTERNS: number[][] = [
  [0, 4, 7, 12],
  [0, 5, 9, 5],
  [12, 7, 4, 7],
  [0, 7, 12, 7],
];

/** A friendly, un-shrill base pitch: A4. */
const BASE_HZ = 440;

const NOTE_MS = 300;

export class Sound {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private timer: number | null = null;
  private step = 0;

  /** True once a real user gesture has started the audio context. */
  get ready(): boolean {
    return this.context !== null && this.context.state === 'running';
  }

  /**
   * Must be called synchronously from a tap. Creating the context and playing a
   * silent blip is what Safari and Chrome accept as consent.
   */
  async unlock(): Promise<void> {
    if (!this.context) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.context = new Ctor();
      this.gain = this.context.createGain();
      // The device's own media volume is the only volume control. No tricks.
      this.gain.gain.value = 0.25;
      this.gain.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();

    const silent = this.context.createBufferSource();
    silent.buffer = this.context.createBuffer(1, 1, this.context.sampleRate);
    silent.connect(this.context.destination);
    silent.start(0);
  }

  /** The context can fall asleep when the app is backgrounded; wake it again. */
  async resume(): Promise<void> {
    if (this.context && this.context.state === 'suspended') await this.context.resume();
  }

  /** Start the looping attention sound for one turn. */
  start(variant: number): void {
    this.stop();
    if (!this.context || !this.gain) return;
    const pattern = PATTERNS[variant % PATTERNS.length];
    this.step = 0;
    const playNext = () => {
      this.playNote(pattern[this.step % pattern.length]);
      this.step += 1;
    };
    playNext();
    this.timer = window.setInterval(playNext, NOTE_MS);
  }

  /** Silence, immediately — this runs on the child's touch. */
  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private playNote(semitones: number): void {
    const context = this.context;
    const gain = this.gain;
    if (!context || !gain) return;

    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();

    oscillator.type = 'triangle';
    oscillator.frequency.value = BASE_HZ * Math.pow(2, semitones / 12);

    // A short fade in and out: a square-edged note clicks unpleasantly.
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(1, now + 0.02);
    envelope.gain.linearRampToValueAtTime(0, now + NOTE_MS / 1000);

    oscillator.connect(envelope);
    envelope.connect(gain);
    oscillator.start(now);
    oscillator.stop(now + NOTE_MS / 1000 + 0.05);
  }
}
