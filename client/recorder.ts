/**
 * Records the adult's voice through WebAudio.
 *
 * Not `MediaRecorder`: it is missing before iOS 14.3, and where it exists each
 * browser writes its own compressed format that another phone may not play.
 * A script processor hands over raw samples on every browser back to the
 * oldest this app supports, and `src/voice.ts` turns them into a clip any
 * phone can decode.
 */

import {
  encodeMuLaw,
  resample,
  tidyRecording,
  VOICE_MAX_MS,
  VOICE_SAMPLE_RATE,
} from '../src/voice';
import { toBase64 } from './audio';

type LegacyGetUserMedia = (
  constraints: MediaStreamConstraints,
  ok: (stream: MediaStream) => void,
  fail: (error: unknown) => void,
) => void;

function legacyGetUserMedia(): LegacyGetUserMedia | undefined {
  return (navigator as unknown as { webkitGetUserMedia?: LegacyGetUserMedia }).webkitGetUserMedia;
}

/** True when this browser can reach a microphone at all. Needs HTTPS. */
export function canRecord(): boolean {
  // Undefined on browsers older than the flag itself, which are not refused.
  if (window.isSecureContext === false) return false;
  return Boolean(navigator.mediaDevices?.getUserMedia || legacyGetUserMedia());
}

function microphone(): Promise<MediaStream> {
  const constraints = { audio: true, video: false };
  if (navigator.mediaDevices?.getUserMedia) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }
  const legacy = legacyGetUserMedia();
  if (!legacy) return Promise.reject(new Error('no microphone'));
  return new Promise((resolve, reject) => legacy.call(navigator, constraints, resolve, reject));
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private length = 0;
  private rate = 0;

  get recording(): boolean {
    return this.processor !== null;
  }

  /**
   * Start listening. `onFull` runs once the length limit is reached, so the
   * caller can stop and keep the clip. Rejects when the microphone is refused.
   */
  async start(context: AudioContext, onFull: () => void): Promise<void> {
    this.discard();
    const stream = await microphone();
    this.stream = stream;
    this.rate = context.sampleRate;
    this.source = context.createMediaStreamSource(stream);
    this.processor = context.createScriptProcessor(4096, 1, 1);
    const limit = (this.rate * VOICE_MAX_MS) / 1000;
    let full = false;
    this.processor.onaudioprocess = (event) => {
      if (full) return;
      this.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      this.length += event.inputBuffer.length;
      if (this.length >= limit) {
        full = true;
        onFull();
      }
    };
    // A processor whose output goes nowhere is never run by Chrome, so it is
    // wired to the speaker through a gain of zero: heard by the graph, not by
    // the room.
    this.sink = context.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(context.destination);
  }

  /**
   * Stop and return the clip as base64, or `null` when nothing but silence was
   * heard.
   */
  finish(): string | null {
    const raw = new Float32Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      raw.set(chunk.subarray(0, Math.min(chunk.length, raw.length - offset)), offset);
      offset += chunk.length;
    }
    const rate = this.rate;
    this.discard();

    const clipped = raw.subarray(0, Math.min(raw.length, (rate * VOICE_MAX_MS) / 1000));
    const samples = tidyRecording(resample(clipped, rate, VOICE_SAMPLE_RATE), VOICE_SAMPLE_RATE);
    // Under a tenth of a second is a tap on the button, not a voice.
    if (samples.length < VOICE_SAMPLE_RATE / 10) return null;
    return toBase64(encodeMuLaw(samples));
  }

  /** Let go of the microphone without keeping anything. */
  discard(): void {
    if (this.processor) this.processor.onaudioprocess = null;
    this.source?.disconnect();
    this.processor?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.source = null;
    this.processor = null;
    this.sink = null;
    this.chunks = [];
    this.length = 0;
  }
}
