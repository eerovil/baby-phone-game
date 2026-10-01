/**
 * All sound is made on the device with WebAudio: a synthesised tune, or the
 * room's recorded voice when an adult has made one.
 *
 * Nothing is fetched during play, so a phone on a weak connection still makes
 * noise, and there is no media file to fail to decode on an old browser — the
 * voice arrives over the room socket ahead of time and is decoded by hand.
 *
 * Mobile browsers only let audio start from a user gesture. `unlock()` is
 * called from the tap that creates or joins a room, which is what makes a
 * server-triggered turn minutes later able to play at all.
 */

import { decodeMuLaw, resample, VOICE_SAMPLE_RATE } from '../src/voice';

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

/** The quiet between one repeat of the recorded voice and the next. */
const VOICE_PAUSE_MS = 700;

export class Sound {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private timer: number | null = null;
  private step = 0;
  /** The room's recorded voice at 16 kHz, or null to play the tune. */
  private voice: Float32Array | null = null;
  /** `voice` at the context's own rate, built the first time it plays. */
  private voiceBuffer: AudioBuffer | null = null;
  private voiceSource: AudioBufferSourceNode | null = null;

  /** The running context, for the recorder to listen through. */
  get audioContext(): AudioContext | null {
    return this.context;
  }

  /** True when a turn will play the recorded voice rather than the tune. */
  get hasVoice(): boolean {
    return this.voice !== null;
  }

  /** Use this clip, or go back to the tune with `null`. */
  setVoice(clip: string | null): void {
    this.voice = clip === null ? null : decodeMuLaw(fromBase64(clip));
    this.voiceBuffer = null;
  }

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
    if (this.voice) {
      const playVoice = () => {
        const duration = this.playVoice();
        this.timer = window.setTimeout(playVoice, duration + VOICE_PAUSE_MS);
      };
      playVoice();
      return;
    }
    const pattern = PATTERNS[variant % PATTERNS.length];
    this.step = 0;
    const playNext = () => {
      this.playNote(pattern[this.step % pattern.length]);
      this.step += 1;
    };
    playNext();
    this.timer = window.setInterval(playNext, NOTE_MS);
  }

  /** Play the recorded voice once, for the adult to hear what they made. */
  preview(): void {
    this.stop();
    this.playVoice();
  }

  /** Silence, immediately — this runs on the child's touch. */
  stop(): void {
    if (this.timer !== null) {
      // One id space for both, so this clears the tune's interval and the
      // voice's timeout alike.
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.voiceSource) {
      try {
        this.voiceSource.stop();
      } catch {
        // Already finished.
      }
      this.voiceSource = null;
    }
  }

  /** Start one play of the voice and return how long it lasts, in ms. */
  private playVoice(): number {
    const context = this.context;
    if (!context || !this.voice) return 0;
    if (!this.voiceBuffer) {
      // Resampled here rather than handed to the browser at 16 kHz: older
      // Safari refuses buffers below 22 050 Hz.
      const samples = resample(this.voice, VOICE_SAMPLE_RATE, context.sampleRate);
      this.voiceBuffer = context.createBuffer(1, samples.length, context.sampleRate);
      this.voiceBuffer.getChannelData(0).set(samples);
    }
    const source = context.createBufferSource();
    source.buffer = this.voiceBuffer;
    // Straight to the speaker, not through the tune's quiet gain: the clip was
    // already levelled when it was recorded.
    source.connect(context.destination);
    source.start(0);
    this.voiceSource = source;
    return this.voiceBuffer.duration * 1000;
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

/** Base64 text to bytes, with the browser's own decoder. */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Bytes to base64 text. Built in pieces: one 80 kB call overflows old stacks. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x2000)));
  }
  return btoa(binary);
}
