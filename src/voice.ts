/**
 * The recorded voice: how a clip is shaped on the wire, and the room's rule for
 * whose clip it plays.
 *
 * A clip is mono μ-law (G.711) at 16 kHz, one byte per sample, base64 in JSON.
 * Five seconds is 80 kB of bytes and about 107 kB of text — small enough to send
 * in one WebSocket message and to keep in `localStorage`, and simple enough to
 * decode by hand on a 2015 phone, where no compressed format can be trusted to
 * record or play.
 *
 * Everything here is pure, so the server, the phone and the tests share it.
 */

export const VOICE_SAMPLE_RATE = 16_000;

/** The longest clip an adult can record. Recording stops by itself at this point. */
export const VOICE_MAX_MS = 5_000;

export const VOICE_MAX_SAMPLES = (VOICE_SAMPLE_RATE * VOICE_MAX_MS) / 1000;

/** The base64 length of the longest clip. Anything longer is refused. */
export const VOICE_MAX_CLIP_CHARS = Math.ceil(VOICE_MAX_SAMPLES / 3) * 4;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A clip as the room holds it: who recorded it, and the base64 bytes. */
export interface RoomVoice {
  deviceId: string;
  clip: string;
}

/** True for a base64 string that could be a clip within the length limit. */
export function isValidClip(clip: unknown): clip is string {
  return (
    typeof clip === 'string' &&
    clip.length > 0 &&
    clip.length <= VOICE_MAX_CLIP_CHARS &&
    clip.length % 4 === 0 &&
    BASE64.test(clip)
  );
}

/**
 * What the room plays after a phone sends its clip, or `null` to delete it.
 *
 * - A fresh recording (`replace`) always wins: the adult just made it.
 * - A phone re-offers its stored clip each time it connects, without `replace`.
 *   That only fills an empty room, so a phone that recorded last week cannot
 *   override the clip someone recorded a minute ago by reconnecting.
 * - Deleting only clears the room when the room is playing that phone's clip.
 *
 * Returns `current` itself when nothing changes, so the caller can skip the
 * broadcast.
 */
export function offerVoice(
  current: RoomVoice | null,
  deviceId: string,
  clip: string | null,
  replace: boolean,
): RoomVoice | null {
  if (clip === null) {
    return current && current.deviceId === deviceId ? null : current;
  }
  if (current && current.deviceId === deviceId && current.clip === clip) return current;
  if (current && !replace) return current;
  return { deviceId, clip };
}

const MU_BIAS = 0x84;
const MU_CLIP = 32_635;

/** Encode samples in [-1, 1] as μ-law bytes. */
export function encodeMuLaw(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    let value = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32_767);
    const sign = value < 0 ? 0x80 : 0;
    if (sign) value = -value;
    value = Math.min(value, MU_CLIP) + MU_BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
    const mantissa = (value >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

/** Decode μ-law bytes back to samples in [-1, 1]. */
export function decodeMuLaw(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = ~bytes[i] & 0xff;
    const exponent = (byte >> 4) & 0x07;
    const magnitude = ((((byte & 0x0f) << 3) + MU_BIAS) << exponent) - MU_BIAS;
    out[i] = (byte & 0x80 ? -magnitude : magnitude) / 32_768;
  }
  return out;
}

/**
 * Change the sample rate by linear interpolation.
 *
 * Good enough for a voice, and it means the phone never has to ask the browser
 * for a 16 kHz buffer, which older Safari refuses.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input.slice();
  const length = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(length);
  const step = fromRate / toRate;
  for (let i = 0; i < length; i += 1) {
    const position = i * step;
    const left = Math.min(Math.floor(position), input.length - 1);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    out[i] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return out;
}

/**
 * Cut the quiet before and after the voice, then scale it so the loudest point
 * is at 90 %. A phone microphone records quietly, and the gap before the adult
 * starts talking would otherwise be dead air in every loop.
 *
 * Returns an empty array when there is nothing louder than background hiss.
 */
export function tidyRecording(samples: Float32Array, sampleRate: number): Float32Array {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak < 0.01) return new Float32Array(0);

  const threshold = peak * 0.1;
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]) < threshold) first += 1;
  let last = samples.length - 1;
  while (last > first && Math.abs(samples[last]) < threshold) last -= 1;

  // Keep a little either side so a soft first consonant is not clipped.
  const margin = Math.round(sampleRate * 0.08);
  const start = Math.max(0, first - margin);
  const end = Math.min(samples.length, last + 1 + margin);

  const gain = 0.9 / peak;
  const out = new Float32Array(end - start);
  for (let i = 0; i < out.length; i += 1) out[i] = samples[start + i] * gain;
  return out;
}

/** How long a clip plays, from its base64 length alone. */
export function clipDurationMs(clip: string): number {
  const padding = clip.endsWith('==') ? 2 : clip.endsWith('=') ? 1 : 0;
  const bytes = (clip.length / 4) * 3 - padding;
  return (bytes / VOICE_SAMPLE_RATE) * 1000;
}
