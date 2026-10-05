/**
 * A tiny silent video that keeps the screen on where the Wake Lock API is
 * missing — Chrome before 84 and iOS before 16.4 — or cannot be trusted.
 *
 * A browser does not let the screen sleep while a video plays, so the game
 * plays one over and over behind the black surface. It is two seconds of a black
 * 16×16 frame with a silent sound track, inlined so nothing is fetched during
 * play, in two formats: H.264 and AAC for iPhones and Chrome, and VP8 and
 * Vorbis for the Chromium builds that leave H.264 out. Made with:
 *
 *   ffmpeg -f lavfi -i color=c=black:s=16x16:r=1 -f lavfi -i anullsrc=r=8000:cl=mono -t 2 \
 *     -c:v libx264 -profile:v baseline -level 3.0 -pix_fmt yuv420p -tune stillimage \
 *     -c:a aac -b:a 8k -movflags +faststart -shortest -map_metadata -1 -fflags +bitexact \
 *     -flags:v +bitexact -flags:a +bitexact keep-awake.mp4
 *
 *   ffmpeg -f lavfi -i color=c=black:s=16x16:r=1 -f lavfi -i anullsrc=r=8000:cl=mono -t 2 \
 *     -c:v libvpx -b:v 1k -c:a libvorbis -ac 1 -q:a 0 -shortest -map_metadata -1 \
 *     -fflags +bitexact -flags:v +bitexact -flags:a +bitexact keep-awake.webm
 */
const MP4 =
  'data:video/mp4;base64,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';

const WEBM =
  'data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAA5FEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHGTbuMU6uEElTDZ1Osggt0TbuMU6uEHFO7a1Osgg4v7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmoCrXsYMPQkBNgIRMYXZmV0GETGF2ZkSJiECfwAAAAAAAFlSua0qorgEAAAAAAAA/14EBc8WIAAAAAAAAAAGcgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4Q7msoA4JCwgRC6gRCagQJVsIRVuYEBrgEAAAAAAApX14ECc8WIAAAAAAAAAAKcgQAitZyDdW5kiIEAhohBX1ZPUkJJU1aqhAHoSACDgQLhkZ+BAbWIQL9AAAAAAABiZIEgY6JKEQIeRAF2b3JiaXMAAAAAAUAfAAAAAAAAsDYAAAAAAACZAQN2b3JiaXM0AAAAWGlwaC5PcmcgbGliVm9yYmlzIEkgMjAyMDA3MDQgKFJlZHVjaW5nIEVudmlyb25tZW50KQAAAAABBXZvcmJpcxJCQ1YBAAABAAxSFCElGVNKYwiVUlIpBR1jUFtHHWPUOUYhZBBTiEkZpXtPKpVYSsgRUlgpRR1TTFNJlVKWKUUdYxRTSCFT1jFloXMUS4ZJCSVsTa50FkvomWOWMUYdY85aSp1j1jFFHWNSUkmhcxg6ZiVkFDpGxehifDA6laJCKL7H3lLpLYWKW4q91xpT6y2EGEtpwQhhc+211dxKasUYY4wxxsXiUyiC0JBVAAABAABABAFCQ1YBAAoAAMJQDEVRgNCQVQBABgCAABRFcRTHcRxHkiTLAkJDVgEAQAAAAgAAKI7hKJIjSZJkWZZlWZameZaouaov+64u667t6roOhIasBADIAAAYhiGH3knMkFOQSSYpVcw5CKH1DjnlFGTSUsaYYoxRzpBTDDEFMYbQKYUQ1E45pQwiCENInWTOIEs96OBi5zgQGrIiAIgCAACMQYwhxpBzDEoGIXKOScggRM45KZ2UTEoorbSWSQktldYi55yUTkompbQWUsuklNZCKwUAAAQ4AAAEWAiFhqwIAKIAABCDkFJIKcSUYk4xh5RSjinHkFLMOcWYcowx6CBUzDHIHIRIKcUYc0455iBkDCrmHIQMMgEAAAEOAAABFkKhISsCgDgBAIMkaZqlaaJoaZooeqaoqqIoqqrleabpmaaqeqKpqqaquq6pqq5seZ5peqaoqp4pqqqpqq5rqqrriqpqy6ar2rbpqrbsyrJuu7Ks256qyrapurJuqq5tu7Js664s27rkearqmabreqbpuqrr2rLqurLtmabriqor26bryrLryratyrKua6bpuqKr2q6purLtyq5tu7Ks+6br6rbqyrquyrLu27au+7KtC7vourauyq6uq7Ks67It67Zs20LJ81TVM03X9UzTdVXXtW3VdW1bM03XNV1XlkXVdWXVlXVddWVb90zTdU1XlWXTVWVZlWXddmVXl0XXtW1Vln1ddWVfl23d92VZ133TdXVblWXbV2VZ92Vd94VZt33dU1VbN11X103X1X1b131htm3fF11X11XZ1oVVlnXf1n1lmHWdMLqurqu27OuqLOu+ruvGMOu6MKy6bfyurQvDq+vGseu+rty+j2rbvvDqtjG8um4cu7Abv+37xrGpqm2brqvrpivrumzrvm/runGMrqvrqiz7uurKvm/ruvDrvi8Mo+vquirLurDasq/Lui4Mu64bw2rbwu7aunDMsi4Mt+8rx68LQ9W2heHVdaOr28ZvC8PSN3a+AACAAQcAgAATykChISsCgDgBAAYhCBVjECrGIIQQUgohpFQxBiFjDkrGHJQQSkkhlNIqxiBkjknIHJMQSmiplNBKKKWlUEpLoZTWUmotptRaDKG0FEpprZTSWmopttRSbBVjEDLnpGSOSSiltFZKaSlzTErGoKQOQiqlpNJKSa1lzknJoKPSOUippNJSSam1UEproZTWSkqxpdJKba3FGkppLaTSWkmptdRSba21WiPGIGSMQcmck1JKSamU0lrmnJQOOiqZg5JKKamVklKsmJPSQSglg4xKSaW1kkoroZTWSkqxhVJaa63VmFJLNZSSWkmpxVBKa621GlMrNYVQUgultBZKaa21VmtqLbZQQmuhpBZLKjG1FmNtrcUYSmmtpBJbKanFFluNrbVYU0s1lpJibK3V2EotOdZaa0ot1tJSjK21mFtMucVYaw0ltBZKaa2U0lpKrcXWWq2hlNZKKrGVklpsrdXYWow1lNJiKSm1kEpsrbVYW2w1ppZibLHVWFKLMcZYc0u11ZRai621WEsrNcYYa2415VIAAMCAAwBAgAlloNCQlQBAFAAAYAxjjEFoFHLMOSmNUs45JyVzDkIIKWXOQQghpc45CKW01DkHoZSUQikppRRbKCWl1losAACgwAEAIMAGTYnFAQoNWQkARAEAIMYoxRiExiClGIPQGKMUYxAqpRhzDkKlFGPOQcgYc85BKRljzkEnJYQQQimlhBBCKKWUAgAAChwAAAJs0JRYHKDQkBUBQBQAAGAMYgwxhiB0UjopEYRMSielkRJaCylllkqKJcbMWomtxNhICa2F1jJrJcbSYkatxFhiKgAA7MABAOzAQig0ZCUAkAcAQBijFGPOOWcQYsw5CCE0CDHmHIQQKsaccw5CCBVjzjkHIYTOOecghBBC55xzEEIIoYMQQgillNJBCCGEUkrpIIQQQimldBBCCKGUUgoAACpwAAAIsFFkc4KRoEJDVgIAeQAAgDFKOSclpUYpxiCkFFujFGMQUmqtYgxCSq3FWDEGIaXWYuwgpNRajLV2EFJqLcZaQ0qtxVhrziGl1mKsNdfUWoy15tx7ai3GWnPOuQAA3AUHALADG0U2JxgJKjRkJQCQBwBAIKQUY4w5h5RijDHnnENKMcaYc84pxhhzzjnnFGOMOeecc4wx55xzzjnGmHPOOeecc84556CDkDnnnHPQQeicc845CCF0zjnnHIQQCgAAKnAAAAiwUWRzgpGgQkNWAgDhAACAMZRSSimllFJKqKOUUkoppZRSAiGllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimVUkoppZRSSimllFJKKaUAIN8KBwD/BxtnWEk6KxwNLjRkJQAQDgAAGMMYhIw5JyWlhjEIpXROSkklNYxBKKVzElJKKYPQWmqlpNJSShmElGILIZWUWgqltFZrKam1lFIoKcUaS0qppdYy5ySkklpLrbaYOQelpNZaaq3FEEJKsbXWUmuxdVJSSa211lptLaSUWmstxtZibCWlllprqcXWWkyptRZbSy3G1mJLrcXYYosxxhoLAOBucACASLBxhpWks8LR4EJDVgIAIQEABDJKOeecgxBCCCFSijHnoIMQQgghREox5pyDEEIIIYSMMecghBBCCKGUkDHmHIQQQgghhFI65yCEUEoJpZRSSucchBBCCKWUUkoJIYQQQiillFJKKSGEEEoppZRSSiklhBBCKKWUUkoppYQQQiillFJKKaWUEEIopZRSSimllBJCCKGUUkoppZRSQgillFJKKaWUUkooIYRSSimllFJKCSWUUkoppZRSSikhlFJKKaWUUkoppQAAgAMHAIAAI+gko8oibDThwgMQAAAAAgACTACBAYKCUQgChBEIAAAAAAAIAPgAAEgKgIiIaOYMDhASFBYYGhweICIkAAAAAAAAAAAAAAAABBJUw2dAo3NzzWPAi2PFiAAAAAAAAAABZ8iYRaOHRU5DT0RFUkSHi0xhdmMgbGlidnB4Z8ihRaOIRFVSQVRJT05Eh5MwMDowMDowMi4wMDAwMDAwMDAAc3PQY8CLY8WIAAAAAAAAAAJnyJtFo4dFTkNPREVSRIeOTGF2YyBsaWJ2b3JiaXNnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAyLjAzMjAwMDAwMAAfQ7Z1QgzngQCjhYIAAIAAo6OBAACAEAIAnQEqEAAQAABHCIWFiJmEiAICAAwNYAD+/6tQgKOFggAggACjhYIAQIAAo4WCAGCAAKOFggCAgACjhYIAoIAAo4WCAMCAAKOFggDggACjhYIBAIAAo4WCASCAAKOFggFAgACjhYIBYIAAo4WCAYCAAKOFggGggACjhYIBwIAAo4WCAeCAAKOFggIAgACjhYICIIAAo4WCAkCAAKOFggJggACjhYICgIAAo4WCAqCAAKOFggLAgACjhYIC4IAAo4WCAwCAAKOFggMggACjhYIDQIAAo4WCA2CAAKOFggOAgACjhYIDoIAAo4WCA8CAAKOFggPggACjhYIEAIAAo5mBA+gAsQEAARAQABgAMD/0DAAAAP7/q1CAo4WCBCCAAKOFggRAgACjhYIEYIAAo4WCBICAAKOFggSggACjhYIEwIAAo4WCBOCAAKOFggUAgACjhYIFIIAAo4WCBUCAAKOFggVggACjhYIFgIAAo4WCBaCAAKOFggXAgACjhYIF4IAAo4WCBgCAAKOFggYggACjhYIGQIAAo4WCBmCAAKOFggaAgACjhYIGoIAAo4WCBsCAAKOFggbggACjhYIHAIAAo4WCByCAAKOFggdAgACjhYIHYIAAo4WCB4CAAKOFggeggACjhYIHwIAAoI6hhYIH4AAAdaKEAPQkABxTu2uRu4+zgQC3iveBAfGCDB3wgQo=';

/** The copy this browser can play: H.264 where it can, VP8 otherwise. */
function keepAwakeVideo(video: Pick<HTMLVideoElement, 'canPlayType'>): string {
  return video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') ? MP4 : WEBM;
}

/** The parts of a `<video>` the wake lock uses, so a test can stand one in. */
export type KeepAwakeVideo = Pick<
  HTMLVideoElement,
  | 'muted'
  | 'src'
  | 'paused'
  | 'currentTime'
  | 'canPlayType'
  | 'setAttribute'
  | 'addEventListener'
  | 'play'
  | 'pause'
>;

/** `navigator.wakeLock`. The DOM library names its type `WakeLock` too. */
export type WakeLockApi = Navigator['wakeLock'];

/**
 * The silent video only counts this far in. Past it the wake lock jumps back
 * to the start, so the video never ends and never needs `loop`.
 */
const REWIND_AFTER_S = 0.5;

/**
 * iPhone and iPad, including the iPads that call themselves a Mac.
 */
export function isIos(nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  return (
    /iPad|iPhone|iPod/.test(nav.userAgent) ||
    (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  );
}

/**
 * Keeps the screen on while the game runs.
 *
 * The Wake Lock API where the browser has it. Where it is missing or refused —
 * Chrome before 84, iOS before 16.4 — a silent black video plays behind the
 * game surface instead, because a browser does not let the screen sleep while a
 * video is playing. It sits full size under the canvas rather than hidden:
 * Chrome only counts a video it can see.
 *
 * iPhones need three things more, all from WebKit's own rule for when a video
 * may keep the display on (`HTMLMediaElement::shouldDisableSleep`):
 *
 * - The video must be able to make a sound, so it is not muted. Its sound
 *   track is silence. A muted video counts as a moving picture, like a GIF.
 * - It must not have `loop` set: a looping video never counts. It jumps back
 *   to the start every half second instead.
 * - It plays even when the Wake Lock API said yes. On a home-screen app the
 *   API reported success but did nothing until iOS 18.4, and the page cannot
 *   tell which it got.
 *
 * An unmuted video may only start from a touch, so `touched()` runs on every
 * touch: the first one starts the video and pauses it at once, and from then on
 * iOS lets the page start it whenever a turn needs it, touch or not.
 */
export class WakeLock {
  private sentinel: WakeLockSentinel | null = null;
  /** True between `acquire()` and `release()`. */
  private wanted = false;
  /** True once a touch has started the video, which is what iOS asks for. */
  private primed = false;

  constructor(
    private readonly video: KeepAwakeVideo,
    /** `navigator.wakeLock`, or undefined where the browser has none. */
    private readonly api: WakeLockApi | undefined,
    private readonly ios: boolean,
  ) {
    video.muted = !ios;
    // Both spellings: iOS before 10 only reads the prefixed one, and without
    // it the video would open full screen over the game.
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.addEventListener('timeupdate', () => {
      if (this.video.currentTime > REWIND_AFTER_S) this.video.currentTime = 0;
    });
    // Belt and braces for a browser that let the video reach its end anyway.
    video.addEventListener('ended', () => {
      if (!this.wanted) return;
      this.video.currentTime = 0;
      this.playVideo();
    });
  }

  async acquire(): Promise<void> {
    this.wanted = true;
    if (this.ios) this.playVideo();
    if (this.api) {
      if (this.sentinel) return;
      try {
        const sentinel = await this.api.request('screen');
        this.sentinel = sentinel;
        sentinel.addEventListener('release', () => {
          this.sentinel = null;
        });
        return;
      } catch {
        this.sentinel = null;
      }
    }
    this.playVideo();
  }

  async release(): Promise<void> {
    this.wanted = false;
    if (!this.video.paused) this.video.pause();
    const sentinel = this.sentinel;
    this.sentinel = null;
    try {
      await sentinel?.release();
    } catch {
      // Already gone. Nothing to do.
    }
  }

  /**
   * Call from every touch on the page. Starts the video if it should be
   * playing and is not, and otherwise unlocks it for later on iOS.
   */
  touched(): void {
    if (this.wanted) {
      if (this.ios || !this.sentinel) this.playVideo();
      return;
    }
    if (!this.ios || this.primed) return;
    this.start()?.then(
      () => {
        if (!this.wanted) this.video.pause();
      },
      () => undefined,
    );
  }

  private playVideo(): void {
    if (!this.video.paused) return;
    this.start()?.catch(() => {
      // Refused. The screen dims as it always did; the next touch retries.
    });
  }

  /** Start the video, setting its source on first use. */
  private start(): Promise<void> | undefined {
    // Set on first use, so a phone with a working wake lock never decodes it.
    if (!this.video.src) this.video.src = keepAwakeVideo(this.video);
    try {
      // Old browsers return nothing here rather than a promise.
      const started = this.video.play() as Promise<void> | undefined;
      return started?.then(() => {
        this.primed = true;
      });
    } catch {
      return undefined;
    }
  }
}
