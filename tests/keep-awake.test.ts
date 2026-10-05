import { describe, expect, it } from 'vitest';

import { isIos, WakeLock, type KeepAwakeVideo, type WakeLockApi } from '../client/keep-awake';

/** A `<video>` that starts only when `allowPlay` says so, like iOS does. */
class FakeVideo {
  muted = true;
  src = '';
  paused = true;
  currentTime = 0;
  allowPlay = true;
  plays = 0;
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, () => void>();

  canPlayType(): string {
    return 'probably';
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }
  emit(type: string): void {
    this.listeners.get(type)?.();
  }
  play(): Promise<void> {
    this.plays += 1;
    if (!this.allowPlay) return Promise.reject(new Error('NotAllowedError'));
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

function sentinel(): WakeLockSentinel {
  return {
    release: () => Promise.resolve(),
    addEventListener: () => undefined,
  } as unknown as WakeLockSentinel;
}

const workingApi = { request: () => Promise.resolve(sentinel()) } as unknown as WakeLockApi;
const refusingApi = {
  request: () => Promise.reject(new Error('NotAllowedError')),
} as unknown as WakeLockApi;

function make(api: WakeLockApi | undefined, ios: boolean) {
  const video = new FakeVideo();
  const lock = new WakeLock(video as unknown as KeepAwakeVideo, api, ios);
  return { video, lock };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('WakeLock on an iPhone', () => {
  it('plays an unmuted video, because WebKit ignores a muted one', () => {
    const { video } = make(workingApi, true);
    expect(video.muted).toBe(false);
    expect(video.attributes.has('playsinline')).toBe(true);
  });

  it('plays the video even when the Wake Lock API says yes', async () => {
    const { video, lock } = make(workingApi, true);
    await lock.acquire();
    expect(video.paused).toBe(false);
    expect(video.src).not.toBe('');
  });

  it('jumps back to the start instead of looping, which WebKit ignores', () => {
    const { video } = make(undefined, true);
    expect('loop' in video).toBe(false);
    video.currentTime = 0.75;
    video.emit('timeupdate');
    expect(video.currentTime).toBe(0);
    video.currentTime = 0.25;
    video.emit('timeupdate');
    expect(video.currentTime).toBe(0.25);
  });

  it('unlocks the video on a touch before the game, then leaves it paused', async () => {
    const { video, lock } = make(undefined, true);
    lock.touched();
    await flush();
    expect(video.plays).toBe(1);
    expect(video.paused).toBe(true);
    // A second lobby touch does nothing more.
    lock.touched();
    await flush();
    expect(video.plays).toBe(1);
  });

  it('retries on the next touch when the game started without one', async () => {
    const { video, lock } = make(undefined, true);
    video.allowPlay = false;
    await lock.acquire();
    await flush();
    expect(video.paused).toBe(true);
    video.allowPlay = true;
    lock.touched();
    await flush();
    expect(video.paused).toBe(false);
  });

  it('stops the video when the game ends', async () => {
    const { video, lock } = make(workingApi, true);
    await lock.acquire();
    await lock.release();
    expect(video.paused).toBe(true);
    lock.touched();
    await flush();
    expect(video.paused).toBe(true);
  });

  it('starts again after an end it reached anyway', async () => {
    const { video, lock } = make(undefined, true);
    await lock.acquire();
    video.paused = true;
    video.currentTime = 2;
    video.emit('ended');
    expect(video.currentTime).toBe(0);
    expect(video.paused).toBe(false);
  });
});

describe('WakeLock elsewhere', () => {
  it('keeps the video muted and unused while the Wake Lock API works', async () => {
    const { video, lock } = make(workingApi, false);
    expect(video.muted).toBe(true);
    await lock.acquire();
    lock.touched();
    await flush();
    expect(video.plays).toBe(0);
    expect(video.src).toBe('');
  });

  it('falls back to the video when the Wake Lock API refuses', async () => {
    const { video, lock } = make(refusingApi, false);
    await lock.acquire();
    expect(video.paused).toBe(false);
  });

  it('falls back to the video when there is no Wake Lock API', async () => {
    const { video, lock } = make(undefined, false);
    await lock.acquire();
    expect(video.paused).toBe(false);
  });

  it('never plays the video before the game', async () => {
    const { video, lock } = make(undefined, false);
    lock.touched();
    await flush();
    expect(video.plays).toBe(0);
  });
});

describe('isIos', () => {
  const nav = (userAgent: string, platform = '', maxTouchPoints = 0) => ({
    userAgent,
    platform,
    maxTouchPoints,
  });

  it('knows an iPhone', () => {
    expect(
      isIos(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15')),
    ).toBe(true);
  });

  it('knows an iPad that says it is a Mac', () => {
    expect(isIos(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5))).toBe(true);
  });

  it('does not mistake a Mac or an Android phone', () => {
    expect(isIos(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0))).toBe(
      false,
    );
    expect(isIos(nav('Mozilla/5.0 (Linux; Android 8.0.0; PRA-LX1)', 'Linux armv8l', 5))).toBe(
      false,
    );
  });
});
