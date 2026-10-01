/**
 * The whole phone-side app: lobby, game surface, and the glue between the
 * server's room state and what this particular phone should be doing.
 */

import { Sound } from './audio';
import { RoomConnection, type ConnectionStatus } from './connection';
import { keepAwakeVideo } from './keep-awake';
import { canRecord, VoiceRecorder } from './recorder';
import { Visuals } from './visuals';
import type { RoomView } from '../src/protocol';
import { clipDurationMs, VOICE_MAX_MS } from '../src/voice';

const DEVICE_KEY = 'bpg.deviceId';
const ROOM_KEY = 'bpg.roomCode';
/** This phone's own recorded voice, as base64. Kept until an adult deletes it. */
const VOICE_KEY = 'bpg.voice';

/** What a room code looks like, everywhere the client checks one. */
const ROOM_CODE = /^[0-9]{6}$/;

/** How long the adult must hold the top-left corner to reach the exit menu. */
const ADULT_HOLD_MS = 2_500;

/** Seconds in Finnish decimal notation, e.g. "2,4 s". */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element: ${id}`);
  return found as T;
}

/** A stable id for this phone, created once and kept in local storage. */
function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2).padEnd(20, '0');
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

/**
 * Keeps the screen on while the game runs.
 *
 * The Wake Lock API where the browser has it. Where it is missing or refused —
 * Chrome before 84, iOS before 16.4 — a silent black video plays on a loop
 * behind the game surface instead, because no browser lets the screen sleep
 * while a video is playing. It sits full size under the canvas rather than
 * hidden: Chrome only counts a video it can see.
 */
class WakeLock {
  private sentinel: WakeLockSentinel | null = null;

  constructor(private readonly video: HTMLVideoElement) {
    video.muted = true;
    // Both spellings: iOS before 10 only reads the prefixed one, and without
    // it the video would open full screen over the game.
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.loop = true;
  }

  async acquire(): Promise<void> {
    if ('wakeLock' in navigator) {
      if (this.sentinel) return;
      try {
        this.sentinel = await navigator.wakeLock.request('screen');
        this.sentinel.addEventListener('release', () => {
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
    if (!this.video.paused) this.video.pause();
    const sentinel = this.sentinel;
    this.sentinel = null;
    try {
      await sentinel?.release();
    } catch {
      // Already gone. Nothing to do.
    }
  }

  private playVideo(): void {
    if (!this.video.paused) return;
    // Set on first use, so a phone with a working wake lock never decodes it.
    if (!this.video.src) this.video.src = keepAwakeVideo(this.video);
    try {
      // A muted inline video may start without a touch on every browser this
      // app supports. Old ones return nothing here rather than a promise.
      const started = this.video.play() as Promise<void> | undefined;
      started?.catch(() => {
        // Refused. The screen dims as it always did; the next touch retries.
      });
    } catch {
      // Same.
    }
  }
}

/**
 * Ask the browser for the whole screen.
 *
 * This matters more than it looks: installing the app is not available on every
 * phone — Chrome's own installed-app shell crashes outright on some older
 * Android builds — so the ordinary browser tab has to be able to give the child
 * a full screen with no address bar. Only ever called from a real touch, which
 * is the browser's condition for allowing it.
 */
async function enterFullscreen(): Promise<void> {
  const root = document.documentElement;
  if (document.fullscreenElement || !root.requestFullscreen) return;
  try {
    await root.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    // Refused, or unsupported (iPhone Safari). The game works either way.
  }
}

async function leaveFullscreen(): Promise<void> {
  if (!document.fullscreenElement || !document.exitFullscreen) return;
  try {
    await document.exitFullscreen();
  } catch {
    // Already gone.
  }
}

class App {
  private readonly sound = new Sound();
  private readonly visuals = new Visuals(element<HTMLCanvasElement>('canvas'));
  private readonly wakeLock = new WakeLock(element<HTMLVideoElement>('keep-awake'));
  private readonly recorder = new VoiceRecorder();
  private readonly me = deviceId();
  /** Which phone recorded the voice the room plays, or null for the tune. */
  private voiceFrom: string | null = null;

  private connection: RoomConnection | null = null;
  private room: RoomView | null = null;
  /** The turn this phone is currently lit up for, or null when it is black. */
  private litTurn: number | null = null;
  private holdTimer: number | null = null;
  /** True while a finger is on a slider, so a broadcast cannot yank it back. */
  private draggingGap = false;

  start(): void {
    this.bindSetup();
    this.bindSettings();
    this.bindLobby();
    this.bindVoice();
    this.bindGame();
    this.bindLifecycle();

    this.showScreen('setup');
    void this.offerRemembered();
  }

  /**
   * Offer the last room — but only when there really is one to go back to.
   *
   * The box stays hidden unless the remembered value is a real six digit code
   * *and* the server still has that room: an empty or junk value from an older
   * version showed a box with no code in it, and an expired room showed a door
   * that led nowhere. Anything that fails either check is forgotten.
   */
  private async offerRemembered(): Promise<void> {
    const code = localStorage.getItem(ROOM_KEY);
    if (!code || !ROOM_CODE.test(code)) {
      localStorage.removeItem(ROOM_KEY);
      return;
    }
    try {
      const response = await fetch(`/api/rooms/${code}`);
      if (response.status === 404) {
        localStorage.removeItem(ROOM_KEY);
        return;
      }
      if (!response.ok) return;
    } catch {
      // Offline. The memory is probably still good, but the room cannot be
      // reached right now, so do not offer a button that cannot work.
      return;
    }
    element('resume-code').textContent = code;
    element('resume').hidden = false;
  }

  // --- setup -------------------------------------------------------------

  private bindSetup(): void {
    element('create').addEventListener('click', () => void this.createRoom());
    element('show-join').addEventListener('click', () => {
      element('join-form').hidden = false;
      element<HTMLInputElement>('join-code').focus();
    });
    element('join-form').addEventListener('submit', (event) => {
      event.preventDefault();
      void this.joinRoom(element<HTMLInputElement>('join-code').value.trim());
    });
    element('resume-join').addEventListener('click', () => {
      const code = localStorage.getItem(ROOM_KEY);
      if (code) void this.joinRoom(code);
    });
    element('resume-forget').addEventListener('click', () => {
      localStorage.removeItem(ROOM_KEY);
      element('resume').hidden = true;
    });
  }

  private async createRoom(): Promise<void> {
    // The tap that creates the room is also the gesture that unlocks audio.
    await this.sound.unlock();
    this.setNotice('');
    try {
      const response = await fetch('/api/rooms', { method: 'POST' });
      if (!response.ok) throw new Error('create failed');
      const body = (await response.json()) as { code: string };
      this.enterRoom(body.code);
    } catch {
      this.setNotice('Huoneen luonti epäonnistui. Tarkista verkkoyhteys.');
    }
  }

  private async joinRoom(code: string): Promise<void> {
    await this.sound.unlock();
    this.setNotice('');
    if (!ROOM_CODE.test(code)) {
      this.setNotice('Koodi on kuusi numeroa.');
      return;
    }
    try {
      const response = await fetch(`/api/rooms/${code}`);
      if (response.status === 404) {
        this.setNotice('Huonetta ei löytynyt. Tarkista koodi.');
        return;
      }
      if (!response.ok) throw new Error('lookup failed');
      this.enterRoom(code);
    } catch {
      this.setNotice('Yhteysvirhe. Yritä uudelleen.');
    }
  }

  private enterRoom(code: string): void {
    localStorage.setItem(ROOM_KEY, code);
    element('lobby-code').textContent = code;
    this.connection = new RoomConnection(code, this.me, {
      onState: (room) => this.onState(room),
      onVoice: (from, clip) => this.onVoice(from, clip),
      onOpen: () => {
        // Offer the stored clip every time. The room only takes it when it has
        // none, so this never overrides a newer recording from another phone.
        const clip = localStorage.getItem(VOICE_KEY);
        if (clip) this.connection?.send({ type: 'voice', clip, replace: false });
      },
      onStatus: (status) => this.onStatus(status),
      onError: (_code, message) => this.setNotice(message),
    });
    this.connection.open();
    this.showScreen('lobby');
  }

  // --- lobby -------------------------------------------------------------

  /**
   * The two gap sliders — one in the lobby, one in the adult menu. The label
   * follows the thumb, but the room is only told on release: a drag fires an
   * `input` event per pixel, and each one would be a message to every phone.
   */
  private bindSettings(): void {
    for (const id of ['gap', 'adult-gap']) {
      const slider = element<HTMLInputElement>(id);
      slider.addEventListener('input', () => {
        this.draggingGap = true;
        this.renderGapLabels(Number(slider.value) * 1000);
      });
      slider.addEventListener('change', () => {
        this.draggingGap = false;
        this.connection?.send({ type: 'settings', turnGapMs: Number(slider.value) * 1000 });
      });
    }
  }

  /** Both labels, in Finnish decimal notation. Zero reads as a word. */
  private renderGapLabels(turnGapMs: number): void {
    const text = turnGapMs === 0 ? 'ei taukoa' : seconds(turnGapMs);
    element('gap-value').textContent = text;
    element('adult-gap-value').textContent = text;
  }

  private bindLobby(): void {
    element('start').addEventListener('click', () => {
      void this.sound.unlock();
      void this.wakeLock.acquire();
      void enterFullscreen();
      this.connection?.send({ type: 'start' });
    });
    element('leave').addEventListener('click', () => this.leaveRoom());
  }

  // --- recorded voice ------------------------------------------------------

  private bindVoice(): void {
    if (!canRecord()) element('voice-record').hidden = true;
    element('voice-record').addEventListener('click', () => void this.toggleRecording());
    element('voice-play').addEventListener('click', () => {
      void this.sound.unlock().then(() => this.sound.preview());
    });
    element('voice-delete').addEventListener('click', () => {
      localStorage.removeItem(VOICE_KEY);
      this.connection?.send({ type: 'voice', clip: null, replace: true });
      // The room drops only its own copy of this phone's clip; mirror that here
      // rather than wait for the broadcast.
      if (this.voiceFrom === this.me) {
        this.voiceFrom = null;
        this.sound.setVoice(null);
      }
      this.renderVoice('');
    });
    this.renderVoice('');
  }

  private async toggleRecording(): Promise<void> {
    if (this.recorder.recording) {
      this.finishRecording();
      return;
    }
    // The tap is the gesture both the audio context and the microphone need.
    await this.sound.unlock();
    const context = this.sound.audioContext;
    if (!context) {
      this.renderVoice('Tällä selaimella ei voi nauhoittaa.');
      return;
    }
    this.sound.stop();
    try {
      await this.recorder.start(context, () => this.finishRecording());
    } catch {
      this.recorder.discard();
      this.renderVoice('Mikrofonia ei saatu käyttöön. Salli mikrofoni selaimen asetuksista.');
      return;
    }
    this.renderVoice('');
  }

  private finishRecording(): void {
    if (!this.recorder.recording) return;
    const clip = this.recorder.finish();
    if (!clip) {
      this.renderVoice('Nauhoitukseen ei tullut ääntä. Yritä uudelleen ja puhu lähempänä.');
      return;
    }
    localStorage.setItem(VOICE_KEY, clip);
    // Play it here at once; the room's broadcast confirms it for everyone.
    this.voiceFrom = this.me;
    this.sound.setVoice(clip);
    this.connection?.send({ type: 'voice', clip, replace: true });
    this.renderVoice('');
  }

  private onVoice(from: string | null, clip: string | null): void {
    this.voiceFrom = from;
    this.sound.setVoice(clip);
    this.renderVoice('');
  }

  /** The voice box in the lobby: what the room plays and what can be done. */
  private renderVoice(problem: string): void {
    const recording = this.recorder.recording;
    const own = localStorage.getItem(VOICE_KEY);
    let status: string;
    if (recording) {
      status = `Nauhoitetaan… Puhu nyt. Nauhoitus loppuu itsestään ${VOICE_MAX_MS / 1000} sekunnin kohdalla.`;
    } else if (this.voiceFrom === null) {
      status = 'Pelissä soi sävel. Nauhoita oma ääni, niin se kuuluu kaikista puhelimista.';
    } else if (this.voiceFrom === this.me && own) {
      status = `Pelissä soi tämän puhelimen nauhoitus (${seconds(clipDurationMs(own))}).`;
    } else {
      status = 'Pelissä soi toisen puhelimen nauhoitus.';
    }
    element('voice-status').textContent = status;
    element('voice-problem').textContent = problem;

    const record = element<HTMLButtonElement>('voice-record');
    record.textContent = recording
      ? 'Lopeta nauhoitus'
      : own
        ? 'Nauhoita uudelleen'
        : 'Nauhoita oma ääni';
    record.classList.toggle('recording', recording);
    element('voice-play').hidden = recording || !this.sound.hasVoice;
    element('voice-delete').hidden = recording || !own;
  }

  private leaveRoom(): void {
    this.connection?.send({ type: 'leave' });
    this.connection?.close();
    this.connection = null;
    this.room = null;
    this.goBlack();
    void this.wakeLock.release();
    void leaveFullscreen();
    localStorage.removeItem(ROOM_KEY);
    element('resume').hidden = true;
    this.showScreen('setup');
  }

  // --- game --------------------------------------------------------------

  private bindGame(): void {
    const surface = element('game');

    surface.addEventListener('pointerdown', (event) => {
      // A lit phone acknowledges its turn on the very first touch. `litTurn` is
      // cleared immediately, so a second finger — or a touch that races the
      // server — cannot send a second acknowledgement.
      if (this.litTurn !== null) {
        const turnId = this.litTurn;
        this.goBlack();
        this.connection?.send({ type: 'ack', turnId });
        // The phones that only joined had no gesture of their own when the
        // game started. This touch is one, so take the full screen now.
        void enterFullscreen();
        return;
      }
      // Black screen: the adult's way out is a long hold in the top corner.
      if (event.clientX < window.innerWidth * 0.25 && event.clientY < window.innerHeight * 0.2) {
        this.holdTimer = window.setTimeout(() => {
          element('adult').hidden = false;
        }, ADULT_HOLD_MS);
      }
    });

    const cancelHold = () => {
      if (this.holdTimer !== null) window.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    };
    surface.addEventListener('pointerup', cancelHold);
    surface.addEventListener('pointercancel', cancelHold);
    surface.addEventListener('pointerleave', cancelHold);

    element('adult-stop').addEventListener('click', () => {
      element('adult').hidden = true;
      this.connection?.send({ type: 'stop' });
    });
    element('adult-resume').addEventListener('click', () => {
      element('adult').hidden = true;
    });
  }

  private onState(room: RoomView): void {
    this.room = room;
    this.renderLobby(room);

    if (room.phase === 'lobby') {
      this.goBlack();
      void this.wakeLock.release();
      void leaveFullscreen();
      element('adult').hidden = true;
      this.showScreen('lobby');
      return;
    }

    this.showScreen('game');
    void this.wakeLock.acquire();

    const mine = room.phase === 'active' && room.activeDeviceId === this.me;
    if (mine && this.litTurn !== room.turnId) {
      this.litTurn = room.turnId;
      document.body.dataset.lit = 'true';
      this.visuals.start(room.variant);
      void this.sound.resume();
      this.sound.start(room.variant);
    } else if (!mine) {
      this.goBlack();
    }
  }

  /** Back to a plain black screen with no sound and no animation frame. */
  private goBlack(): void {
    this.litTurn = null;
    // Nothing on the page reads this attribute — it is how a test, or a person
    // with the inspector open, can tell a lit phone from a black one.
    document.body.dataset.lit = 'false';
    this.sound.stop();
    this.visuals.stop();
  }

  private renderLobby(room: RoomView): void {
    if (!this.draggingGap) {
      const seconds = String(room.settings.turnGapMs / 1000);
      element<HTMLInputElement>('gap').value = seconds;
      element<HTMLInputElement>('adult-gap').value = seconds;
      this.renderGapLabels(room.settings.turnGapMs);
    }

    const connected = room.devices.filter((device) => device.connected).length;
    element('lobby-code').textContent = room.code;
    element('device-count').textContent = String(connected);
    element<HTMLButtonElement>('start').disabled = connected < 2;
    element('start-hint').hidden = connected >= 2;
  }

  private onStatus(status: ConnectionStatus): void {
    // Connection state belongs to the lobby only. The child's screen never
    // shows it — a reconnect happens in the dark.
    const label = { connecting: 'Yhdistetään…', open: 'Yhdistetty', closed: 'Ei yhteyttä' }[status];
    element('connection').textContent = label;
  }

  // --- lifecycle ---------------------------------------------------------

  private bindLifecycle(): void {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      // Coming back to the foreground: the socket, the audio context and the
      // wake lock have all quite possibly been taken away.
      this.connection?.ensureOpen();
      void this.sound.resume();
      if (this.room && this.room.phase !== 'lobby') void this.wakeLock.acquire();
    });
  }

  private setNotice(message: string): void {
    element('notice').textContent = message;
  }

  private showScreen(name: 'setup' | 'lobby' | 'game'): void {
    for (const screen of ['setup', 'lobby', 'game']) {
      element(screen).hidden = screen !== name;
    }
    document.body.dataset.screen = name;
  }
}

/**
 * Put a failure on the screen instead of leaving a dead page.
 *
 * On an old phone there is no console to open and often no way to attach a
 * debugger, so a crash otherwise looks like "the app just doesn't work". This
 * is the only place the app shows a technical message to a person.
 */
function reportFatal(detail: string): void {
  const box = document.getElementById('fatal');
  const text = document.getElementById('fatal-detail');
  if (!box || !text) return;
  text.textContent = `${detail}\n${navigator.userAgent}`;
  box.hidden = false;
}

window.addEventListener('error', (event) => {
  reportFatal(event.message || String(event.error));
});
window.addEventListener('unhandledrejection', (event) => {
  reportFatal(String(event.reason));
});

try {
  new App().start();
} catch (error) {
  reportFatal(error instanceof Error ? `${error.message}` : String(error));
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // An old browser, or a plain-HTTP origin. The game does not need it.
    });
  });
}
