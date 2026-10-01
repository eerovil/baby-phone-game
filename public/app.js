"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/voice.ts
  var VOICE_SAMPLE_RATE = 16e3;
  var VOICE_MAX_MS = 5e3;
  var VOICE_MAX_SAMPLES = VOICE_SAMPLE_RATE * VOICE_MAX_MS / 1e3;
  var VOICE_MAX_CLIP_CHARS = Math.ceil(VOICE_MAX_SAMPLES / 3) * 4;
  var MU_BIAS = 132;
  var MU_CLIP = 32635;
  function encodeMuLaw(samples) {
    const out = new Uint8Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      let value = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
      const sign = value < 0 ? 128 : 0;
      if (sign) value = -value;
      value = Math.min(value, MU_CLIP) + MU_BIAS;
      let exponent = 7;
      for (let mask = 16384; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
      const mantissa = value >> exponent + 3 & 15;
      out[i] = ~(sign | exponent << 4 | mantissa) & 255;
    }
    return out;
  }
  function decodeMuLaw(bytes) {
    const out = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) {
      const byte = ~bytes[i] & 255;
      const exponent = byte >> 4 & 7;
      const magnitude = (((byte & 15) << 3) + MU_BIAS << exponent) - MU_BIAS;
      out[i] = (byte & 128 ? -magnitude : magnitude) / 32768;
    }
    return out;
  }
  function resample(input, fromRate, toRate) {
    if (fromRate === toRate || input.length === 0) return input.slice();
    const length = Math.max(1, Math.round(input.length * toRate / fromRate));
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
  function tidyRecording(samples, sampleRate) {
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    if (peak < 0.01) return new Float32Array(0);
    const threshold = peak * 0.1;
    let first = 0;
    while (first < samples.length && Math.abs(samples[first]) < threshold) first += 1;
    let last = samples.length - 1;
    while (last > first && Math.abs(samples[last]) < threshold) last -= 1;
    const margin = Math.round(sampleRate * 0.08);
    const start = Math.max(0, first - margin);
    const end = Math.min(samples.length, last + 1 + margin);
    const gain = 0.9 / peak;
    const out = new Float32Array(end - start);
    for (let i = 0; i < out.length; i += 1) out[i] = samples[start + i] * gain;
    return out;
  }
  function clipDurationMs(clip) {
    const padding = clip.endsWith("==") ? 2 : clip.endsWith("=") ? 1 : 0;
    const bytes = clip.length / 4 * 3 - padding;
    return bytes / VOICE_SAMPLE_RATE * 1e3;
  }

  // client/audio.ts
  var PATTERNS = [
    [0, 4, 7, 12],
    [0, 5, 9, 5],
    [12, 7, 4, 7],
    [0, 7, 12, 7]
  ];
  var BASE_HZ = 440;
  var NOTE_MS = 300;
  var VOICE_PAUSE_MS = 700;
  var Sound = class {
    constructor() {
      __publicField(this, "context", null);
      __publicField(this, "gain", null);
      __publicField(this, "timer", null);
      __publicField(this, "step", 0);
      /** The room's recorded voice at 16 kHz, or null to play the tune. */
      __publicField(this, "voice", null);
      /** `voice` at the context's own rate, built the first time it plays. */
      __publicField(this, "voiceBuffer", null);
      __publicField(this, "voiceSource", null);
    }
    /** The running context, for the recorder to listen through. */
    get audioContext() {
      return this.context;
    }
    /** True when a turn will play the recorded voice rather than the tune. */
    get hasVoice() {
      return this.voice !== null;
    }
    /** Use this clip, or go back to the tune with `null`. */
    setVoice(clip) {
      this.voice = clip === null ? null : decodeMuLaw(fromBase64(clip));
      this.voiceBuffer = null;
    }
    /** True once a real user gesture has started the audio context. */
    get ready() {
      return this.context !== null && this.context.state === "running";
    }
    /**
     * Must be called synchronously from a tap. Creating the context and playing a
     * silent blip is what Safari and Chrome accept as consent.
     */
    async unlock() {
      var _a;
      if (!this.context) {
        const Ctor = (_a = window.AudioContext) != null ? _a : window.webkitAudioContext;
        if (!Ctor) return;
        this.context = new Ctor();
        this.gain = this.context.createGain();
        this.gain.gain.value = 0.25;
        this.gain.connect(this.context.destination);
      }
      if (this.context.state === "suspended") await this.context.resume();
      const silent = this.context.createBufferSource();
      silent.buffer = this.context.createBuffer(1, 1, this.context.sampleRate);
      silent.connect(this.context.destination);
      silent.start(0);
    }
    /** The context can fall asleep when the app is backgrounded; wake it again. */
    async resume() {
      if (this.context && this.context.state === "suspended") await this.context.resume();
    }
    /** Start the looping attention sound for one turn. */
    start(variant) {
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
    preview() {
      this.stop();
      this.playVoice();
    }
    /** Silence, immediately — this runs on the child's touch. */
    stop() {
      if (this.timer !== null) {
        window.clearInterval(this.timer);
        this.timer = null;
      }
      if (this.voiceSource) {
        try {
          this.voiceSource.stop();
        } catch (e) {
        }
        this.voiceSource = null;
      }
    }
    /** Start one play of the voice and return how long it lasts, in ms. */
    playVoice() {
      const context = this.context;
      if (!context || !this.voice) return 0;
      if (!this.voiceBuffer) {
        const samples = resample(this.voice, VOICE_SAMPLE_RATE, context.sampleRate);
        this.voiceBuffer = context.createBuffer(1, samples.length, context.sampleRate);
        this.voiceBuffer.getChannelData(0).set(samples);
      }
      const source = context.createBufferSource();
      source.buffer = this.voiceBuffer;
      source.connect(context.destination);
      source.start(0);
      this.voiceSource = source;
      return this.voiceBuffer.duration * 1e3;
    }
    playNote(semitones) {
      const context = this.context;
      const gain = this.gain;
      if (!context || !gain) return;
      const now = context.currentTime;
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.value = BASE_HZ * Math.pow(2, semitones / 12);
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime(1, now + 0.02);
      envelope.gain.linearRampToValueAtTime(0, now + NOTE_MS / 1e3);
      oscillator.connect(envelope);
      envelope.connect(gain);
      oscillator.start(now);
      oscillator.stop(now + NOTE_MS / 1e3 + 0.05);
    }
  };
  function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function toBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)));
    }
    return btoa(binary);
  }

  // client/connection.ts
  var RETRY_MIN_MS = 500;
  var RETRY_MAX_MS = 5e3;
  var PING_MS = 2e4;
  var RoomConnection = class {
    constructor(code, deviceId2, handlers) {
      __publicField(this, "code", code);
      __publicField(this, "deviceId", deviceId2);
      __publicField(this, "handlers", handlers);
      __publicField(this, "socket", null);
      __publicField(this, "retryMs", RETRY_MIN_MS);
      __publicField(this, "retryTimer", null);
      __publicField(this, "pingTimer", null);
      __publicField(this, "closedByUs", false);
    }
    open() {
      this.closedByUs = false;
      this.connect();
    }
    close() {
      var _a;
      this.closedByUs = true;
      this.clearTimers();
      (_a = this.socket) == null ? void 0 : _a.close();
      this.socket = null;
      this.handlers.onStatus("closed");
    }
    send(message) {
      var _a;
      if (((_a = this.socket) == null ? void 0 : _a.readyState) === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(message));
      }
    }
    /** Called when the app comes back to the foreground. */
    ensureOpen() {
      if (this.closedByUs) return;
      if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
      this.connect();
    }
    connect() {
      this.clearTimers();
      this.handlers.onStatus("connecting");
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const url = "".concat(scheme, "://").concat(location.host, "/ws?room=").concat(encodeURIComponent(this.code), "&device=").concat(encodeURIComponent(this.deviceId));
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.retryMs = RETRY_MIN_MS;
        this.handlers.onStatus("open");
        this.send({ type: "hello" });
        this.handlers.onOpen();
        this.pingTimer = window.setInterval(() => this.send({ type: "ping" }), PING_MS);
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (e) {
          return;
        }
        if (message.type === "state") this.handlers.onState(message.room, message.you);
        else if (message.type === "voice") this.handlers.onVoice(message.from, message.clip);
        else if (message.type === "error") this.handlers.onError(message.code, message.message);
      });
      const reconnect = () => {
        if (this.socket !== socket) return;
        this.clearTimers();
        this.socket = null;
        if (this.closedByUs) return;
        this.handlers.onStatus("connecting");
        this.retryTimer = window.setTimeout(() => this.connect(), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
      };
      socket.addEventListener("close", reconnect);
      socket.addEventListener("error", reconnect);
    }
    clearTimers() {
      if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
      if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
      this.retryTimer = null;
      this.pingTimer = null;
    }
  };

  // client/keep-awake.ts
  var KEEP_AWAKE_VIDEO = "data:video/mp4;base64,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";

  // client/recorder.ts
  function legacyGetUserMedia() {
    return navigator.webkitGetUserMedia;
  }
  function canRecord() {
    var _a;
    if (window.isSecureContext === false) return false;
    return Boolean(((_a = navigator.mediaDevices) == null ? void 0 : _a.getUserMedia) || legacyGetUserMedia());
  }
  function microphone() {
    var _a;
    const constraints = { audio: true, video: false };
    if ((_a = navigator.mediaDevices) == null ? void 0 : _a.getUserMedia) {
      return navigator.mediaDevices.getUserMedia(constraints);
    }
    const legacy = legacyGetUserMedia();
    if (!legacy) return Promise.reject(new Error("no microphone"));
    return new Promise((resolve, reject) => legacy.call(navigator, constraints, resolve, reject));
  }
  var VoiceRecorder = class {
    constructor() {
      __publicField(this, "stream", null);
      __publicField(this, "source", null);
      __publicField(this, "processor", null);
      __publicField(this, "sink", null);
      __publicField(this, "chunks", []);
      __publicField(this, "length", 0);
      __publicField(this, "rate", 0);
    }
    get recording() {
      return this.processor !== null;
    }
    /**
     * Start listening. `onFull` runs once the length limit is reached, so the
     * caller can stop and keep the clip. Rejects when the microphone is refused.
     */
    async start(context, onFull) {
      this.discard();
      const stream = await microphone();
      this.stream = stream;
      this.rate = context.sampleRate;
      this.source = context.createMediaStreamSource(stream);
      this.processor = context.createScriptProcessor(4096, 1, 1);
      const limit = this.rate * VOICE_MAX_MS / 1e3;
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
    finish() {
      const raw = new Float32Array(this.length);
      let offset = 0;
      for (const chunk of this.chunks) {
        raw.set(chunk.subarray(0, Math.min(chunk.length, raw.length - offset)), offset);
        offset += chunk.length;
      }
      const rate = this.rate;
      this.discard();
      const clipped = raw.subarray(0, Math.min(raw.length, rate * VOICE_MAX_MS / 1e3));
      const samples = tidyRecording(resample(clipped, rate, VOICE_SAMPLE_RATE), VOICE_SAMPLE_RATE);
      if (samples.length < VOICE_SAMPLE_RATE / 10) return null;
      return toBase64(encodeMuLaw(samples));
    }
    /** Let go of the microphone without keeping anything. */
    discard() {
      var _a, _b, _c, _d;
      if (this.processor) this.processor.onaudioprocess = null;
      (_a = this.source) == null ? void 0 : _a.disconnect();
      (_b = this.processor) == null ? void 0 : _b.disconnect();
      (_c = this.sink) == null ? void 0 : _c.disconnect();
      (_d = this.stream) == null ? void 0 : _d.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.source = null;
      this.processor = null;
      this.sink = null;
      this.chunks = [];
      this.length = 0;
    }
  };

  // client/visuals.ts
  var PALETTES = [
    ["#ff2e63", "#ffd700", "#08d9d6"],
    ["#00e676", "#ffffff", "#2979ff"],
    ["#ff6d00", "#ffea00", "#d500f9"],
    ["#18ffff", "#f50057", "#ffffff"]
  ];
  var Visuals = class {
    constructor(canvas) {
      __publicField(this, "canvas", canvas);
      __publicField(this, "frame", null);
      __publicField(this, "startedAt", 0);
      __publicField(this, "variant", 0);
      window.addEventListener("resize", () => this.resize());
    }
    start(variant) {
      this.stop();
      this.variant = variant % PALETTES.length;
      this.startedAt = performance.now();
      this.resize();
      const loop = (time) => {
        this.draw((time - this.startedAt) / 1e3);
        this.frame = window.requestAnimationFrame(loop);
      };
      this.frame = window.requestAnimationFrame(loop);
    }
    /** Stop and wipe to black. */
    stop() {
      if (this.frame !== null) {
        window.cancelAnimationFrame(this.frame);
        this.frame = null;
      }
      const context = this.canvas.getContext("2d");
      if (context) context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.floor(this.canvas.clientWidth * ratio);
      this.canvas.height = Math.floor(this.canvas.clientHeight * ratio);
    }
    draw(seconds2) {
      const context = this.canvas.getContext("2d");
      if (!context) return;
      const width = this.canvas.width;
      const height = this.canvas.height;
      const colors = PALETTES[this.variant];
      context.fillStyle = "#000";
      context.fillRect(0, 0, width, height);
      switch (this.variant) {
        case 0:
          this.pulsingRings(context, seconds2, width, height, colors);
          break;
        case 1:
          this.spinningRays(context, seconds2, width, height, colors);
          break;
        case 2:
          this.bouncingBlobs(context, seconds2, width, height, colors);
          break;
        default:
          this.colorBands(context, seconds2, width, height, colors);
          break;
      }
    }
    pulsingRings(context, seconds2, width, height, colors) {
      const centerX = width / 2;
      const centerY = height / 2;
      const max = Math.hypot(width, height) / 2;
      for (let ring = 4; ring >= 0; ring -= 1) {
        const phase = (seconds2 * 0.8 + ring * 0.2) % 1;
        context.fillStyle = colors[ring % colors.length];
        context.beginPath();
        context.arc(centerX, centerY, max * phase, 0, Math.PI * 2);
        context.fill();
      }
    }
    spinningRays(context, seconds2, width, height, colors) {
      const centerX = width / 2;
      const centerY = height / 2;
      const radius = Math.hypot(width, height);
      const rays = 12;
      for (let ray = 0; ray < rays; ray += 1) {
        const start = ray / rays * Math.PI * 2 + seconds2 * 0.9;
        context.fillStyle = colors[ray % colors.length];
        context.beginPath();
        context.moveTo(centerX, centerY);
        context.arc(centerX, centerY, radius, start, start + Math.PI / rays);
        context.closePath();
        context.fill();
      }
    }
    bouncingBlobs(context, seconds2, width, height, colors) {
      const radius = Math.min(width, height) / 5;
      for (let blob = 0; blob < 3; blob += 1) {
        const speedX = 0.6 + blob * 0.17;
        const speedY = 0.45 + blob * 0.23;
        const x = triangleWave(seconds2 * speedX + blob * 0.3) * (width - radius * 2) + radius;
        const y = triangleWave(seconds2 * speedY + blob * 0.7) * (height - radius * 2) + radius;
        context.fillStyle = colors[blob % colors.length];
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }
    }
    colorBands(context, seconds2, width, height, colors) {
      const bands = 6;
      const bandHeight = height / bands;
      for (let band = 0; band < bands; band += 1) {
        const shift = triangleWave(seconds2 * 0.7 + band * 0.25);
        context.fillStyle = colors[(band + Math.floor(seconds2 * 2)) % colors.length];
        context.fillRect(
          -width * 0.2 + shift * width * 0.4,
          band * bandHeight,
          width * 1.4,
          bandHeight
        );
      }
    }
  };
  function triangleWave(value) {
    const wrapped = value % 2;
    const positive = wrapped < 0 ? wrapped + 2 : wrapped;
    return positive <= 1 ? positive : 2 - positive;
  }

  // client/main.ts
  var DEVICE_KEY = "bpg.deviceId";
  var ROOM_KEY = "bpg.roomCode";
  var VOICE_KEY = "bpg.voice";
  var ROOM_CODE = /^[0-9]{6}$/;
  var ADULT_HOLD_MS = 2500;
  function seconds(ms) {
    return "".concat((ms / 1e3).toFixed(1).replace(".", ","), " s");
  }
  function element(id) {
    const found = document.getElementById(id);
    if (!found) throw new Error("missing element: ".concat(id));
    return found;
  }
  function deviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2).padEnd(20, "0");
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }
  var WakeLock = class {
    constructor(video) {
      __publicField(this, "video", video);
      __publicField(this, "sentinel", null);
      video.muted = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      video.loop = true;
    }
    async acquire() {
      if ("wakeLock" in navigator) {
        if (this.sentinel) return;
        try {
          this.sentinel = await navigator.wakeLock.request("screen");
          this.sentinel.addEventListener("release", () => {
            this.sentinel = null;
          });
          return;
        } catch (e) {
          this.sentinel = null;
        }
      }
      this.playVideo();
    }
    async release() {
      if (!this.video.paused) this.video.pause();
      const sentinel = this.sentinel;
      this.sentinel = null;
      try {
        await (sentinel == null ? void 0 : sentinel.release());
      } catch (e) {
      }
    }
    playVideo() {
      if (!this.video.paused) return;
      if (!this.video.src) this.video.src = KEEP_AWAKE_VIDEO;
      try {
        const started = this.video.play();
        started == null ? void 0 : started.catch(() => {
        });
      } catch (e) {
      }
    }
  };
  async function enterFullscreen() {
    const root = document.documentElement;
    if (document.fullscreenElement || !root.requestFullscreen) return;
    try {
      await root.requestFullscreen({ navigationUI: "hide" });
    } catch (e) {
    }
  }
  async function leaveFullscreen() {
    if (!document.fullscreenElement || !document.exitFullscreen) return;
    try {
      await document.exitFullscreen();
    } catch (e) {
    }
  }
  var App = class {
    constructor() {
      __publicField(this, "sound", new Sound());
      __publicField(this, "visuals", new Visuals(element("canvas")));
      __publicField(this, "wakeLock", new WakeLock(element("keep-awake")));
      __publicField(this, "recorder", new VoiceRecorder());
      __publicField(this, "me", deviceId());
      /** Which phone recorded the voice the room plays, or null for the tune. */
      __publicField(this, "voiceFrom", null);
      __publicField(this, "connection", null);
      __publicField(this, "room", null);
      /** The turn this phone is currently lit up for, or null when it is black. */
      __publicField(this, "litTurn", null);
      __publicField(this, "holdTimer", null);
      /** True while a finger is on a slider, so a broadcast cannot yank it back. */
      __publicField(this, "draggingGap", false);
    }
    start() {
      this.bindSetup();
      this.bindSettings();
      this.bindLobby();
      this.bindVoice();
      this.bindGame();
      this.bindLifecycle();
      this.showScreen("setup");
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
    async offerRemembered() {
      const code = localStorage.getItem(ROOM_KEY);
      if (!code || !ROOM_CODE.test(code)) {
        localStorage.removeItem(ROOM_KEY);
        return;
      }
      try {
        const response = await fetch("/api/rooms/".concat(code));
        if (response.status === 404) {
          localStorage.removeItem(ROOM_KEY);
          return;
        }
        if (!response.ok) return;
      } catch (e) {
        return;
      }
      element("resume-code").textContent = code;
      element("resume").hidden = false;
    }
    // --- setup -------------------------------------------------------------
    bindSetup() {
      element("create").addEventListener("click", () => void this.createRoom());
      element("show-join").addEventListener("click", () => {
        element("join-form").hidden = false;
        element("join-code").focus();
      });
      element("join-form").addEventListener("submit", (event) => {
        event.preventDefault();
        void this.joinRoom(element("join-code").value.trim());
      });
      element("resume-join").addEventListener("click", () => {
        const code = localStorage.getItem(ROOM_KEY);
        if (code) void this.joinRoom(code);
      });
      element("resume-forget").addEventListener("click", () => {
        localStorage.removeItem(ROOM_KEY);
        element("resume").hidden = true;
      });
    }
    async createRoom() {
      await this.sound.unlock();
      this.setNotice("");
      try {
        const response = await fetch("/api/rooms", { method: "POST" });
        if (!response.ok) throw new Error("create failed");
        const body = await response.json();
        this.enterRoom(body.code);
      } catch (e) {
        this.setNotice("Huoneen luonti ep\xE4onnistui. Tarkista verkkoyhteys.");
      }
    }
    async joinRoom(code) {
      await this.sound.unlock();
      this.setNotice("");
      if (!ROOM_CODE.test(code)) {
        this.setNotice("Koodi on kuusi numeroa.");
        return;
      }
      try {
        const response = await fetch("/api/rooms/".concat(code));
        if (response.status === 404) {
          this.setNotice("Huonetta ei l\xF6ytynyt. Tarkista koodi.");
          return;
        }
        if (!response.ok) throw new Error("lookup failed");
        this.enterRoom(code);
      } catch (e) {
        this.setNotice("Yhteysvirhe. Yrit\xE4 uudelleen.");
      }
    }
    enterRoom(code) {
      localStorage.setItem(ROOM_KEY, code);
      element("lobby-code").textContent = code;
      this.connection = new RoomConnection(code, this.me, {
        onState: (room) => this.onState(room),
        onVoice: (from, clip) => this.onVoice(from, clip),
        onOpen: () => {
          var _a;
          const clip = localStorage.getItem(VOICE_KEY);
          if (clip) (_a = this.connection) == null ? void 0 : _a.send({ type: "voice", clip, replace: false });
        },
        onStatus: (status) => this.onStatus(status),
        onError: (_code, message) => this.setNotice(message)
      });
      this.connection.open();
      this.showScreen("lobby");
    }
    // --- lobby -------------------------------------------------------------
    /**
     * The two gap sliders — one in the lobby, one in the adult menu. The label
     * follows the thumb, but the room is only told on release: a drag fires an
     * `input` event per pixel, and each one would be a message to every phone.
     */
    bindSettings() {
      for (const id of ["gap", "adult-gap"]) {
        const slider = element(id);
        slider.addEventListener("input", () => {
          this.draggingGap = true;
          this.renderGapLabels(Number(slider.value) * 1e3);
        });
        slider.addEventListener("change", () => {
          var _a;
          this.draggingGap = false;
          (_a = this.connection) == null ? void 0 : _a.send({ type: "settings", turnGapMs: Number(slider.value) * 1e3 });
        });
      }
    }
    /** Both labels, in Finnish decimal notation. Zero reads as a word. */
    renderGapLabels(turnGapMs) {
      const text = turnGapMs === 0 ? "ei taukoa" : seconds(turnGapMs);
      element("gap-value").textContent = text;
      element("adult-gap-value").textContent = text;
    }
    bindLobby() {
      element("start").addEventListener("click", () => {
        var _a;
        void this.sound.unlock();
        void this.wakeLock.acquire();
        void enterFullscreen();
        (_a = this.connection) == null ? void 0 : _a.send({ type: "start" });
      });
      element("leave").addEventListener("click", () => this.leaveRoom());
    }
    // --- recorded voice ------------------------------------------------------
    bindVoice() {
      if (!canRecord()) element("voice-record").hidden = true;
      element("voice-record").addEventListener("click", () => void this.toggleRecording());
      element("voice-play").addEventListener("click", () => {
        void this.sound.unlock().then(() => this.sound.preview());
      });
      element("voice-delete").addEventListener("click", () => {
        var _a;
        localStorage.removeItem(VOICE_KEY);
        (_a = this.connection) == null ? void 0 : _a.send({ type: "voice", clip: null, replace: true });
        if (this.voiceFrom === this.me) {
          this.voiceFrom = null;
          this.sound.setVoice(null);
        }
        this.renderVoice("");
      });
      this.renderVoice("");
    }
    async toggleRecording() {
      if (this.recorder.recording) {
        this.finishRecording();
        return;
      }
      await this.sound.unlock();
      const context = this.sound.audioContext;
      if (!context) {
        this.renderVoice("T\xE4ll\xE4 selaimella ei voi nauhoittaa.");
        return;
      }
      this.sound.stop();
      try {
        await this.recorder.start(context, () => this.finishRecording());
      } catch (e) {
        this.recorder.discard();
        this.renderVoice("Mikrofonia ei saatu k\xE4ytt\xF6\xF6n. Salli mikrofoni selaimen asetuksista.");
        return;
      }
      this.renderVoice("");
    }
    finishRecording() {
      var _a;
      if (!this.recorder.recording) return;
      const clip = this.recorder.finish();
      if (!clip) {
        this.renderVoice("Nauhoitukseen ei tullut \xE4\xE4nt\xE4. Yrit\xE4 uudelleen ja puhu l\xE4hemp\xE4n\xE4.");
        return;
      }
      localStorage.setItem(VOICE_KEY, clip);
      this.voiceFrom = this.me;
      this.sound.setVoice(clip);
      (_a = this.connection) == null ? void 0 : _a.send({ type: "voice", clip, replace: true });
      this.renderVoice("");
    }
    onVoice(from, clip) {
      this.voiceFrom = from;
      this.sound.setVoice(clip);
      this.renderVoice("");
    }
    /** The voice box in the lobby: what the room plays and what can be done. */
    renderVoice(problem) {
      const recording = this.recorder.recording;
      const own = localStorage.getItem(VOICE_KEY);
      let status;
      if (recording) {
        status = "Nauhoitetaan\u2026 Puhu nyt. Nauhoitus loppuu itsest\xE4\xE4n ".concat(VOICE_MAX_MS / 1e3, " sekunnin kohdalla.");
      } else if (this.voiceFrom === null) {
        status = "Peliss\xE4 soi s\xE4vel. Nauhoita oma \xE4\xE4ni, niin se kuuluu kaikista puhelimista.";
      } else if (this.voiceFrom === this.me && own) {
        status = "Peliss\xE4 soi t\xE4m\xE4n puhelimen nauhoitus (".concat(seconds(clipDurationMs(own)), ").");
      } else {
        status = "Peliss\xE4 soi toisen puhelimen nauhoitus.";
      }
      element("voice-status").textContent = status;
      element("voice-problem").textContent = problem;
      const record = element("voice-record");
      record.textContent = recording ? "Lopeta nauhoitus" : own ? "Nauhoita uudelleen" : "Nauhoita oma \xE4\xE4ni";
      record.classList.toggle("recording", recording);
      element("voice-play").hidden = recording || !this.sound.hasVoice;
      element("voice-delete").hidden = recording || !own;
    }
    leaveRoom() {
      var _a, _b;
      (_a = this.connection) == null ? void 0 : _a.send({ type: "leave" });
      (_b = this.connection) == null ? void 0 : _b.close();
      this.connection = null;
      this.room = null;
      this.goBlack();
      void this.wakeLock.release();
      void leaveFullscreen();
      localStorage.removeItem(ROOM_KEY);
      element("resume").hidden = true;
      this.showScreen("setup");
    }
    // --- game --------------------------------------------------------------
    bindGame() {
      const surface = element("game");
      surface.addEventListener("pointerdown", (event) => {
        var _a;
        if (this.litTurn !== null) {
          const turnId = this.litTurn;
          this.goBlack();
          (_a = this.connection) == null ? void 0 : _a.send({ type: "ack", turnId });
          void enterFullscreen();
          return;
        }
        if (event.clientX < window.innerWidth * 0.25 && event.clientY < window.innerHeight * 0.2) {
          this.holdTimer = window.setTimeout(() => {
            element("adult").hidden = false;
          }, ADULT_HOLD_MS);
        }
      });
      const cancelHold = () => {
        if (this.holdTimer !== null) window.clearTimeout(this.holdTimer);
        this.holdTimer = null;
      };
      surface.addEventListener("pointerup", cancelHold);
      surface.addEventListener("pointercancel", cancelHold);
      surface.addEventListener("pointerleave", cancelHold);
      element("adult-stop").addEventListener("click", () => {
        var _a;
        element("adult").hidden = true;
        (_a = this.connection) == null ? void 0 : _a.send({ type: "stop" });
      });
      element("adult-resume").addEventListener("click", () => {
        element("adult").hidden = true;
      });
    }
    onState(room) {
      this.room = room;
      this.renderLobby(room);
      if (room.phase === "lobby") {
        this.goBlack();
        void this.wakeLock.release();
        void leaveFullscreen();
        element("adult").hidden = true;
        this.showScreen("lobby");
        return;
      }
      this.showScreen("game");
      void this.wakeLock.acquire();
      const mine = room.phase === "active" && room.activeDeviceId === this.me;
      if (mine && this.litTurn !== room.turnId) {
        this.litTurn = room.turnId;
        document.body.dataset.lit = "true";
        this.visuals.start(room.variant);
        void this.sound.resume();
        this.sound.start(room.variant);
      } else if (!mine) {
        this.goBlack();
      }
    }
    /** Back to a plain black screen with no sound and no animation frame. */
    goBlack() {
      this.litTurn = null;
      document.body.dataset.lit = "false";
      this.sound.stop();
      this.visuals.stop();
    }
    renderLobby(room) {
      if (!this.draggingGap) {
        const seconds2 = String(room.settings.turnGapMs / 1e3);
        element("gap").value = seconds2;
        element("adult-gap").value = seconds2;
        this.renderGapLabels(room.settings.turnGapMs);
      }
      const connected = room.devices.filter((device) => device.connected).length;
      element("lobby-code").textContent = room.code;
      element("device-count").textContent = String(connected);
      element("start").disabled = connected < 2;
      element("start-hint").hidden = connected >= 2;
    }
    onStatus(status) {
      const label = { connecting: "Yhdistet\xE4\xE4n\u2026", open: "Yhdistetty", closed: "Ei yhteytt\xE4" }[status];
      element("connection").textContent = label;
    }
    // --- lifecycle ---------------------------------------------------------
    bindLifecycle() {
      document.addEventListener("visibilitychange", () => {
        var _a;
        if (document.visibilityState !== "visible") return;
        (_a = this.connection) == null ? void 0 : _a.ensureOpen();
        void this.sound.resume();
        if (this.room && this.room.phase !== "lobby") void this.wakeLock.acquire();
      });
    }
    setNotice(message) {
      element("notice").textContent = message;
    }
    showScreen(name) {
      for (const screen of ["setup", "lobby", "game"]) {
        element(screen).hidden = screen !== name;
      }
      document.body.dataset.screen = name;
    }
  };
  function reportFatal(detail) {
    const box = document.getElementById("fatal");
    const text = document.getElementById("fatal-detail");
    if (!box || !text) return;
    text.textContent = "".concat(detail, "\n").concat(navigator.userAgent);
    box.hidden = false;
  }
  window.addEventListener("error", (event) => {
    reportFatal(event.message || String(event.error));
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportFatal(String(event.reason));
  });
  try {
    new App().start();
  } catch (error) {
    reportFatal(error instanceof Error ? "".concat(error.message) : String(error));
  }
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      void navigator.serviceWorker.register("/sw.js").catch(() => {
      });
    });
  }
})();
