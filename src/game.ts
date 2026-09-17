/**
 * The room state machine.
 *
 * Everything here is pure: no timers, no randomness, no sockets. The caller
 * passes the current time and a random source in, and gets a new state back.
 * That is what makes the interesting rules — the five second gap, "never the
 * same phone twice in a row", disconnect recovery, and refusing a second
 * acknowledgement of the same turn — testable without a browser or a clock.
 *
 * The Durable Object in `room.ts` owns the only mutable copy of this state and
 * is the single authority, so two phones can never both believe they are the
 * active one.
 */

/**
 * How long the room stays dark between one turn ending and the next starting.
 * This is the starting value; an adult can change it per room, which is what
 * `RoomSettings.turnGapMs` holds.
 */
export const TURN_GAP_MS = 5_000;

/** The range an adult may set the gap to, in milliseconds. */
export const TURN_GAP_MIN_MS = 1_000;
export const TURN_GAP_MAX_MS = 20_000;

/** A room with no connected device for this long is thrown away. */
export const ROOM_IDLE_TTL_MS = 30 * 60 * 1000;

/** How many different visual/sound variants the client knows about. */
export const VARIANT_COUNT = 4;

export type Phase =
  /** Devices are gathering. Nothing is lit up. */
  | 'lobby'
  /** The game runs, but right now every phone is black and one is due next. */
  | 'waiting'
  /** One phone is lit up and playing a sound. */
  | 'active';

export interface Device {
  id: string;
  /** Human label for the lobby, e.g. "Puhelin 2". Never shown during play. */
  name: string;
  connected: boolean;
  joinedAt: number;
}

/** What an adult can change about a room. */
export interface RoomSettings {
  /** The dark gap between turns. */
  turnGapMs: number;
}

export interface RoomState {
  code: string;
  settings: RoomSettings;
  createdAt: number;
  /** Last moment a device was connected; drives idle expiry. */
  lastActivityAt: number;
  phase: Phase;
  devices: Device[];
  /** The lit-up device, only meaningful while `phase === 'active'`. */
  activeDeviceId: string | null;
  /**
   * Which device was lit up most recently, kept across the dark gap so the next
   * pick can avoid repeating it.
   */
  previousDeviceId: string | null;
  /**
   * Increments on every turn. A phone acknowledges a specific turn id, so a
   * duplicate touch — or a touch that raced with the turn ending — is ignored
   * instead of advancing the game twice.
   */
  turnId: number;
  /** When the next turn starts, while `phase === 'waiting'`. */
  nextTurnAt: number | null;
  /** Which animation/sound the active phone should use this turn. */
  variant: number;
}

/** `() => number` in `[0, 1)`, same contract as `Math.random`. */
export type Random = () => number;

export function createRoom(code: string, now: number): RoomState {
  return {
    code,
    settings: { turnGapMs: TURN_GAP_MS },
    createdAt: now,
    lastActivityAt: now,
    phase: 'lobby',
    devices: [],
    activeDeviceId: null,
    previousDeviceId: null,
    turnId: 0,
    nextTurnAt: null,
    variant: 0,
  };
}

/**
 * The room's gap, tolerating a room that was stored before settings existed:
 * a live room outlives a deployment, and `undefined` here would turn every
 * `nextTurnAt` into `NaN` and stop the game dead.
 */
function turnGap(state: RoomState): number {
  return clampTurnGap(state.settings?.turnGapMs ?? TURN_GAP_MS);
}

/** Keep a value a phone sent inside the range the adult controls offer. */
export function clampTurnGap(value: number): number {
  if (!Number.isFinite(value)) return TURN_GAP_MS;
  return Math.min(TURN_GAP_MAX_MS, Math.max(TURN_GAP_MIN_MS, Math.round(value)));
}

/**
 * An adult changed a setting.
 *
 * A change made while the room is dark shortens or lengthens the wait that is
 * already running, counted from now — so moving the slider has a visible effect
 * instead of appearing to do nothing until the turn after next.
 */
export function applySettings(
  state: RoomState,
  settings: Partial<RoomSettings>,
  now: number,
): RoomState {
  const turnGapMs = clampTurnGap(settings.turnGapMs ?? turnGap(state));
  if (turnGapMs === turnGap(state)) return state;

  const next: RoomState = { ...state, settings: { ...state.settings, turnGapMs } };
  if (next.phase === 'waiting' && next.nextTurnAt !== null) {
    next.nextTurnAt = now + turnGapMs;
  }
  return next;
}

export function connectedDevices(state: RoomState): Device[] {
  return state.devices.filter((device) => device.connected);
}

function withDevices(state: RoomState, devices: Device[]): RoomState {
  return { ...state, devices };
}

/**
 * Add a device, or mark a known one connected again.
 *
 * Identity is the caller's stable device id from `localStorage`, never the
 * socket, so a reconnect rejoins the same seat rather than creating a new one.
 */
export function joinDevice(state: RoomState, deviceId: string, now: number): RoomState {
  const existing = state.devices.find((device) => device.id === deviceId);
  let next: RoomState;
  if (existing) {
    next = withDevices(
      state,
      state.devices.map((device) =>
        device.id === deviceId ? { ...device, connected: true } : device,
      ),
    );
  } else {
    const device: Device = {
      id: deviceId,
      name: `Puhelin ${state.devices.length + 1}`,
      connected: true,
      joinedAt: now,
    };
    next = withDevices(state, [...state.devices, device]);
  }
  next = { ...next, lastActivityAt: now };

  // A game that ran out of phones parks in `waiting` with no scheduled turn.
  // The device that just arrived is the one that can restart it.
  if (next.phase === 'waiting' && next.nextTurnAt === null) {
    next = { ...next, nextTurnAt: now + turnGap(next) };
  }
  return next;
}

/**
 * Mark a device gone. If it was the lit-up one, the turn is over: the room goes
 * dark and schedules the next pick, rather than waiting forever for a touch
 * that can no longer arrive.
 */
export function disconnectDevice(state: RoomState, deviceId: string, now: number): RoomState {
  if (!state.devices.some((device) => device.id === deviceId)) return state;

  // The clock for idle expiry restarts here, so a room that ran all evening is
  // thrown away a full TTL after the last phone left, not immediately.
  let next: RoomState = {
    ...withDevices(
      state,
      state.devices.map((device) =>
        device.id === deviceId ? { ...device, connected: false } : device,
      ),
    ),
    lastActivityAt: now,
  };

  if (next.phase === 'active' && next.activeDeviceId === deviceId) {
    next = {
      ...next,
      phase: 'waiting',
      activeDeviceId: null,
      previousDeviceId: deviceId,
      nextTurnAt: now + turnGap(next),
    };
  }
  return next;
}

/** Forget a device entirely — used when someone leaves the room on purpose. */
export function removeDevice(state: RoomState, deviceId: string, now: number): RoomState {
  const next = disconnectDevice(state, deviceId, now);
  return withDevices(
    next,
    next.devices.filter((device) => device.id !== deviceId),
  );
}

/** A game needs at least two phones — one phone is not a chase. */
export function canStart(state: RoomState): boolean {
  return state.phase === 'lobby' && connectedDevices(state).length >= 2;
}

/**
 * Pick the next phone and light it up immediately.
 *
 * With two or more candidates the previously lit phone is excluded, so the
 * child always has somewhere to walk. With one candidate left it may repeat —
 * the alternative would be a game that stops dead.
 */
function beginTurn(state: RoomState, now: number, random: Random): RoomState {
  const candidates = connectedDevices(state);
  if (candidates.length === 0) {
    // Nothing to light up. Stay dark with no alarm; `joinDevice` restarts it.
    return {
      ...state,
      phase: 'waiting',
      activeDeviceId: null,
      nextTurnAt: null,
    };
  }

  const eligible =
    candidates.length >= 2
      ? candidates.filter((device) => device.id !== state.previousDeviceId)
      : candidates;
  const pool = eligible.length > 0 ? eligible : candidates;
  const chosen = pool[Math.floor(random() * pool.length) % pool.length];

  return {
    ...state,
    phase: 'active',
    activeDeviceId: chosen.id,
    previousDeviceId: chosen.id,
    turnId: state.turnId + 1,
    nextTurnAt: null,
    variant: Math.floor(random() * VARIANT_COUNT) % VARIANT_COUNT,
    lastActivityAt: now,
  };
}

/** Adult pressed "Aloita peli". The first phone lights up straight away. */
export function startGame(state: RoomState, now: number, random: Random): RoomState {
  if (!canStart(state)) return state;
  return beginTurn({ ...state, previousDeviceId: null }, now, random);
}

/** Adult ended the game. Everyone returns to the lobby. */
export function stopGame(state: RoomState, now: number): RoomState {
  if (state.phase === 'lobby') return state;
  return {
    ...state,
    phase: 'lobby',
    activeDeviceId: null,
    previousDeviceId: null,
    nextTurnAt: null,
    lastActivityAt: now,
  };
}

/**
 * The child touched the lit-up phone.
 *
 * Accepted only from the device that is actually active, and only for the turn
 * it was told about. Everything else — a second touch, a stale turn id, a touch
 * on a black phone — is ignored and returns the state unchanged.
 */
export function acknowledgeTurn(
  state: RoomState,
  deviceId: string,
  turnId: number,
  now: number,
): RoomState {
  if (state.phase !== 'active') return state;
  if (state.activeDeviceId !== deviceId) return state;
  if (state.turnId !== turnId) return state;

  return {
    ...state,
    phase: 'waiting',
    activeDeviceId: null,
    nextTurnAt: now + turnGap(state),
    lastActivityAt: now,
  };
}

/**
 * Advance time. The Durable Object calls this from its alarm, but tests call it
 * directly — it is the only place the five second gap turns into a new turn.
 */
export function tick(state: RoomState, now: number, random: Random): RoomState {
  if (state.phase !== 'waiting') return state;
  if (state.nextTurnAt === null || now < state.nextTurnAt) return state;
  return beginTurn(state, now, random);
}

/**
 * When the room next needs waking: the scheduled turn, or the moment it becomes
 * eligible for expiry. `null` means nothing is pending.
 */
export function nextWakeAt(state: RoomState): number | null {
  if (state.nextTurnAt !== null) return state.nextTurnAt;
  if (connectedDevices(state).length === 0) return state.lastActivityAt + ROOM_IDLE_TTL_MS;
  return null;
}

/** An abandoned room: nobody connected, and nothing has happened in a while. */
export function isExpired(state: RoomState, now: number): boolean {
  return connectedDevices(state).length === 0 && now - state.lastActivityAt >= ROOM_IDLE_TTL_MS;
}
