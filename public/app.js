var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// client/audio.ts
var PATTERNS = [
  [0, 4, 7, 12],
  [0, 5, 9, 5],
  [12, 7, 4, 7],
  [0, 7, 12, 7]
];
var BASE_HZ = 440;
var NOTE_MS = 300;
var Sound = class {
  constructor() {
    __publicField(this, "context", null);
    __publicField(this, "gain", null);
    __publicField(this, "timer", null);
    __publicField(this, "step", 0);
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
    if (!this.context) {
      const Ctor = window.AudioContext ?? window.webkitAudioContext;
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
  stop() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
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
    this.closedByUs = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.handlers.onStatus("closed");
  }
  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) {
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
    const url = `${scheme}://${location.host}/ws?room=${encodeURIComponent(this.code)}&device=${encodeURIComponent(this.deviceId)}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.retryMs = RETRY_MIN_MS;
      this.handlers.onStatus("open");
      this.send({ type: "hello" });
      this.pingTimer = window.setInterval(() => this.send({ type: "ping" }), PING_MS);
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "state") this.handlers.onState(message.room, message.you);
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
  draw(seconds) {
    const context = this.canvas.getContext("2d");
    if (!context) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const colors = PALETTES[this.variant];
    context.fillStyle = "#000";
    context.fillRect(0, 0, width, height);
    switch (this.variant) {
      case 0:
        this.pulsingRings(context, seconds, width, height, colors);
        break;
      case 1:
        this.spinningRays(context, seconds, width, height, colors);
        break;
      case 2:
        this.bouncingBlobs(context, seconds, width, height, colors);
        break;
      default:
        this.colorBands(context, seconds, width, height, colors);
        break;
    }
  }
  pulsingRings(context, seconds, width, height, colors) {
    const centerX = width / 2;
    const centerY = height / 2;
    const max = Math.hypot(width, height) / 2;
    for (let ring = 4; ring >= 0; ring -= 1) {
      const phase = (seconds * 0.8 + ring * 0.2) % 1;
      context.fillStyle = colors[ring % colors.length];
      context.beginPath();
      context.arc(centerX, centerY, max * phase, 0, Math.PI * 2);
      context.fill();
    }
  }
  spinningRays(context, seconds, width, height, colors) {
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.hypot(width, height);
    const rays = 12;
    for (let ray = 0; ray < rays; ray += 1) {
      const start = ray / rays * Math.PI * 2 + seconds * 0.9;
      context.fillStyle = colors[ray % colors.length];
      context.beginPath();
      context.moveTo(centerX, centerY);
      context.arc(centerX, centerY, radius, start, start + Math.PI / rays);
      context.closePath();
      context.fill();
    }
  }
  bouncingBlobs(context, seconds, width, height, colors) {
    const radius = Math.min(width, height) / 5;
    for (let blob = 0; blob < 3; blob += 1) {
      const speedX = 0.6 + blob * 0.17;
      const speedY = 0.45 + blob * 0.23;
      const x = triangleWave(seconds * speedX + blob * 0.3) * (width - radius * 2) + radius;
      const y = triangleWave(seconds * speedY + blob * 0.7) * (height - radius * 2) + radius;
      context.fillStyle = colors[blob % colors.length];
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }
  }
  colorBands(context, seconds, width, height, colors) {
    const bands = 6;
    const bandHeight = height / bands;
    for (let band = 0; band < bands; band += 1) {
      const shift = triangleWave(seconds * 0.7 + band * 0.25);
      context.fillStyle = colors[(band + Math.floor(seconds * 2)) % colors.length];
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
var ADULT_HOLD_MS = 2500;
function element(id) {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element: ${id}`);
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
  constructor() {
    __publicField(this, "sentinel", null);
  }
  async acquire() {
    if (!("wakeLock" in navigator)) return;
    if (this.sentinel) return;
    try {
      this.sentinel = await navigator.wakeLock.request("screen");
      this.sentinel.addEventListener("release", () => {
        this.sentinel = null;
      });
    } catch {
      this.sentinel = null;
    }
  }
  async release() {
    const sentinel = this.sentinel;
    this.sentinel = null;
    try {
      await sentinel?.release();
    } catch {
    }
  }
};
var App = class {
  constructor() {
    __publicField(this, "sound", new Sound());
    __publicField(this, "visuals", new Visuals(element("canvas")));
    __publicField(this, "wakeLock", new WakeLock());
    __publicField(this, "me", deviceId());
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
    this.bindGame();
    this.bindLifecycle();
    const remembered = localStorage.getItem(ROOM_KEY);
    if (remembered) {
      element("resume").hidden = false;
      element("resume-code").textContent = remembered;
    }
    this.showScreen("setup");
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
    } catch {
      this.setNotice("Huoneen luonti ep\xE4onnistui. Tarkista verkkoyhteys.");
    }
  }
  async joinRoom(code) {
    await this.sound.unlock();
    this.setNotice("");
    if (!/^[0-9]{6}$/.test(code)) {
      this.setNotice("Koodi on kuusi numeroa.");
      return;
    }
    try {
      const response = await fetch(`/api/rooms/${code}`);
      if (response.status === 404) {
        this.setNotice("Huonetta ei l\xF6ytynyt. Tarkista koodi.");
        return;
      }
      if (!response.ok) throw new Error("lookup failed");
      this.enterRoom(code);
    } catch {
      this.setNotice("Yhteysvirhe. Yrit\xE4 uudelleen.");
    }
  }
  enterRoom(code) {
    localStorage.setItem(ROOM_KEY, code);
    element("lobby-code").textContent = code;
    this.connection = new RoomConnection(code, this.me, {
      onState: (room) => this.onState(room),
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
        this.draggingGap = false;
        this.connection?.send({ type: "settings", turnGapMs: Number(slider.value) * 1e3 });
      });
    }
  }
  /** Both labels, in Finnish decimal notation. */
  renderGapLabels(turnGapMs) {
    const text = `${(turnGapMs / 1e3).toFixed(1).replace(".", ",")} s`;
    element("gap-value").textContent = text;
    element("adult-gap-value").textContent = text;
  }
  bindLobby() {
    element("start").addEventListener("click", () => {
      void this.sound.unlock();
      void this.wakeLock.acquire();
      this.connection?.send({ type: "start" });
    });
    element("leave").addEventListener("click", () => this.leaveRoom());
  }
  leaveRoom() {
    this.connection?.send({ type: "leave" });
    this.connection?.close();
    this.connection = null;
    this.room = null;
    this.goBlack();
    void this.wakeLock.release();
    localStorage.removeItem(ROOM_KEY);
    element("resume").hidden = true;
    this.showScreen("setup");
  }
  // --- game --------------------------------------------------------------
  bindGame() {
    const surface = element("game");
    surface.addEventListener("pointerdown", (event) => {
      if (this.litTurn !== null) {
        const turnId = this.litTurn;
        this.goBlack();
        this.connection?.send({ type: "ack", turnId });
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
      element("adult").hidden = true;
      this.connection?.send({ type: "stop" });
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
      const seconds = String(room.settings.turnGapMs / 1e3);
      element("gap").value = seconds;
      element("adult-gap").value = seconds;
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
      if (document.visibilityState !== "visible") return;
      this.connection?.ensureOpen();
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
new App().start();
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
