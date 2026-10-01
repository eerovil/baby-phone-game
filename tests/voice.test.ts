import { describe, expect, it } from 'vitest';

import { parseClientMessage } from '../src/protocol';
import {
  clipDurationMs,
  decodeMuLaw,
  encodeMuLaw,
  isValidClip,
  offerVoice,
  resample,
  tidyRecording,
  VOICE_MAX_CLIP_CHARS,
  VOICE_MAX_SAMPLES,
  VOICE_SAMPLE_RATE,
  type RoomVoice,
} from '../src/voice';

const mine: RoomVoice = { deviceId: 'phone-a', clip: 'AAAA' };

describe('offerVoice', () => {
  it('lets a fresh recording fill an empty room', () => {
    expect(offerVoice(null, 'phone-a', 'AAAA', true)).toEqual(mine);
  });

  it('lets a stored clip offered on connect fill an empty room', () => {
    expect(offerVoice(null, 'phone-a', 'AAAA', false)).toEqual(mine);
  });

  it('never lets a stored clip override the one the room already plays', () => {
    expect(offerVoice(mine, 'phone-b', 'BBBB', false)).toBe(mine);
  });

  it('lets a fresh recording from another phone replace it', () => {
    expect(offerVoice(mine, 'phone-b', 'BBBB', true)).toEqual({
      deviceId: 'phone-b',
      clip: 'BBBB',
    });
  });

  it('returns the same object when the owner re-offers the same clip', () => {
    expect(offerVoice(mine, 'phone-a', 'AAAA', true)).toBe(mine);
    expect(offerVoice(mine, 'phone-a', 'AAAA', false)).toBe(mine);
  });

  it('lets only the phone that recorded it delete it', () => {
    expect(offerVoice(mine, 'phone-b', null, true)).toBe(mine);
    expect(offerVoice(mine, 'phone-a', null, true)).toBeNull();
    expect(offerVoice(null, 'phone-a', null, true)).toBeNull();
  });
});

describe('isValidClip', () => {
  it('takes base64 within the five second limit', () => {
    expect(isValidClip('AAECAwQF')).toBe(true);
    expect(isValidClip('A'.repeat(VOICE_MAX_CLIP_CHARS))).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isValidClip('')).toBe(false);
    expect(isValidClip('A'.repeat(VOICE_MAX_CLIP_CHARS + 4))).toBe(false);
    expect(isValidClip('not base64!')).toBe(false);
    expect(isValidClip('AAA')).toBe(false);
    expect(isValidClip(42)).toBe(false);
  });

  it('fits the longest clip the recorder can make', () => {
    const longest = Buffer.from(new Uint8Array(VOICE_MAX_SAMPLES)).toString('base64');
    expect(isValidClip(longest)).toBe(true);
  });
});

describe('parseClientMessage voice', () => {
  it('reads a clip, a delete and the replace flag', () => {
    expect(parseClientMessage('{"type":"voice","clip":"AAAA","replace":true}')).toEqual({
      type: 'voice',
      clip: 'AAAA',
      replace: true,
    });
    expect(parseClientMessage('{"type":"voice","clip":null}')).toEqual({
      type: 'voice',
      clip: null,
      replace: false,
    });
  });

  it('drops a malformed clip', () => {
    expect(parseClientMessage('{"type":"voice","clip":"nope!"}')).toBeNull();
    expect(parseClientMessage('{"type":"voice"}')).toBeNull();
  });
});

describe('μ-law', () => {
  it('round-trips a voice-like signal closely', () => {
    const samples = new Float32Array(1000);
    for (let i = 0; i < samples.length; i += 1) samples[i] = 0.8 * Math.sin(i / 7);
    const decoded = decodeMuLaw(encodeMuLaw(samples));
    for (let i = 0; i < samples.length; i += 1) {
      // μ-law keeps a roughly constant relative error, a few percent at most.
      expect(Math.abs(decoded[i] - samples[i])).toBeLessThan(0.03);
    }
  });

  it('keeps silence silent and the extremes in range', () => {
    const decoded = decodeMuLaw(encodeMuLaw(new Float32Array([0, 1, -1, 2, -2])));
    expect(Math.abs(decoded[0])).toBeLessThan(0.001);
    for (const value of decoded.subarray(1)) expect(Math.abs(value)).toBeLessThanOrEqual(1);
    expect(decoded[1]).toBeGreaterThan(0.95);
    expect(decoded[2]).toBeLessThan(-0.95);
  });
});

describe('resample', () => {
  it('scales the length by the rate ratio', () => {
    expect(resample(new Float32Array(48_000), 48_000, VOICE_SAMPLE_RATE)).toHaveLength(16_000);
    expect(resample(new Float32Array(16_000), VOICE_SAMPLE_RATE, 44_100)).toHaveLength(44_100);
  });

  it('interpolates between neighbours', () => {
    expect([...resample(new Float32Array([0, 1]), 1, 2)]).toEqual([0, 0.5, 1, 1]);
  });
});

describe('tidyRecording', () => {
  const rate = 1000;

  it('cuts the quiet either side, keeping a short margin, and levels the peak', () => {
    const samples = new Float32Array(1000);
    for (let i = 400; i < 600; i += 1) samples[i] = i % 2 ? 0.3 : -0.3;
    const tidy = tidyRecording(samples, rate);
    // 200 samples of voice plus 80 ms either side.
    expect(tidy).toHaveLength(360);
    expect(Math.max(...tidy.map(Math.abs))).toBeCloseTo(0.9, 5);
  });

  it('returns nothing for background hiss', () => {
    expect(tidyRecording(new Float32Array(1000).fill(0.001), rate)).toHaveLength(0);
  });
});

describe('clipDurationMs', () => {
  it('reads the length from the base64 alone', () => {
    const bytes = new Uint8Array(VOICE_SAMPLE_RATE * 2 + 1);
    expect(clipDurationMs(Buffer.from(bytes).toString('base64'))).toBeCloseTo(2000.0625, 3);
  });
});
