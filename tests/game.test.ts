import { describe, expect, it } from 'vitest';

import {
  acknowledgeTurn,
  applySettings,
  canStart,
  clampTurnGap,
  TURN_GAP_MAX_MS,
  TURN_GAP_MIN_MS,
  connectedDevices,
  createRoom,
  disconnectDevice,
  isExpired,
  joinDevice,
  nextWakeAt,
  removeDevice,
  ROOM_IDLE_TTL_MS,
  startGame,
  stopGame,
  tick,
  TURN_GAP_MS,
  type RoomState,
} from '../src/game';

/** A random source that walks a fixed list, so every pick below is deliberate. */
function scripted(values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length];
}

/** Always picks the first eligible candidate, and variant 0. */
const alwaysFirst = () => 0;

function roomWith(deviceIds: string[], now = 1_000): RoomState {
  let state = createRoom('123456', now);
  for (const id of deviceIds) state = joinDevice(state, id, now);
  return state;
}

describe('joining', () => {
  it('keeps one seat per device id across a reconnect', () => {
    let state = roomWith(['a', 'b']);
    state = disconnectDevice(state, 'a', 2_000);
    expect(connectedDevices(state)).toHaveLength(1);

    state = joinDevice(state, 'a', 3_000);
    expect(state.devices).toHaveLength(2);
    expect(connectedDevices(state)).toHaveLength(2);
  });

  it('refuses to start with fewer than two phones', () => {
    const alone = roomWith(['a']);
    expect(canStart(alone)).toBe(false);
    expect(startGame(alone, 2_000, alwaysFirst).phase).toBe('lobby');

    expect(canStart(roomWith(['a', 'b']))).toBe(true);
  });

  it('forgets a device that leaves on purpose', () => {
    let state = roomWith(['a', 'b']);
    state = removeDevice(state, 'b', 2_000);
    expect(state.devices.map((device) => device.id)).toEqual(['a']);
  });
});

describe('turns', () => {
  it('lights up one phone at random when the game starts', () => {
    // 0.9 * 2 candidates = index 1.
    const state = startGame(roomWith(['a', 'b']), 2_000, scripted([0.9, 0]));
    expect(state.phase).toBe('active');
    expect(state.activeDeviceId).toBe('b');
    expect(state.turnId).toBe(1);
  });

  it('goes dark on acknowledgement and waits exactly five seconds', () => {
    let state = startGame(roomWith(['a', 'b']), 2_000, alwaysFirst);
    const active = state.activeDeviceId!;

    state = acknowledgeTurn(state, active, state.turnId, 5_000);
    expect(state.phase).toBe('waiting');
    expect(state.activeDeviceId).toBeNull();
    expect(state.nextTurnAt).toBe(5_000 + TURN_GAP_MS);

    // One millisecond early is still dark.
    expect(tick(state, 5_000 + TURN_GAP_MS - 1, alwaysFirst).phase).toBe('waiting');

    const next = tick(state, 5_000 + TURN_GAP_MS, alwaysFirst);
    expect(next.phase).toBe('active');
    expect(next.turnId).toBe(2);
  });

  it('never picks the same phone twice in a row with two or more connected', () => {
    let state = startGame(roomWith(['a', 'b', 'c']), 0, alwaysFirst);
    let now = 0;

    for (let turn = 0; turn < 20; turn += 1) {
      const active = state.activeDeviceId!;
      now += 100;
      state = acknowledgeTurn(state, active, state.turnId, now);
      now += TURN_GAP_MS;
      // A random source that would happily repeat if the rule did not exist.
      state = tick(state, now, alwaysFirst);
      expect(state.activeDeviceId).not.toBe(active);
    }
  });

  it('may repeat the only phone left rather than stalling', () => {
    let state = startGame(roomWith(['a', 'b']), 0, alwaysFirst);
    const active = state.activeDeviceId!;
    const other = state.devices.find((device) => device.id !== active)!.id;

    state = disconnectDevice(state, other, 100);
    state = acknowledgeTurn(state, active, state.turnId, 200);
    state = tick(state, 200 + TURN_GAP_MS, alwaysFirst);

    expect(state.phase).toBe('active');
    expect(state.activeDeviceId).toBe(active);
  });

  it('returns everyone to the lobby when the adult stops the game', () => {
    const state = stopGame(startGame(roomWith(['a', 'b']), 0, alwaysFirst), 500);
    expect(state.phase).toBe('lobby');
    expect(state.activeDeviceId).toBeNull();
  });
});

describe('duplicate and stray acknowledgements', () => {
  it('ignores a second touch of the same turn', () => {
    let state = startGame(roomWith(['a', 'b']), 0, alwaysFirst);
    const active = state.activeDeviceId!;
    const turnId = state.turnId;

    state = acknowledgeTurn(state, active, turnId, 1_000);
    const afterFirst = state;
    state = acknowledgeTurn(state, active, turnId, 1_200);

    // The second touch must not push the five second gap out again.
    expect(state).toBe(afterFirst);
    expect(state.nextTurnAt).toBe(1_000 + TURN_GAP_MS);
  });

  it('ignores a touch from a black phone', () => {
    const state = startGame(roomWith(['a', 'b']), 0, alwaysFirst);
    const idle = state.devices.find((device) => device.id !== state.activeDeviceId)!.id;
    expect(acknowledgeTurn(state, idle, state.turnId, 1_000)).toBe(state);
  });

  it('ignores a touch that names an old turn', () => {
    const state = startGame(roomWith(['a', 'b']), 0, alwaysFirst);
    expect(acknowledgeTurn(state, state.activeDeviceId!, state.turnId - 1, 1_000)).toBe(state);
  });
});

describe('disconnect recovery', () => {
  it('schedules the next turn when the lit-up phone drops', () => {
    let state = startGame(roomWith(['a', 'b']), 0, alwaysFirst);
    const active = state.activeDeviceId!;

    state = disconnectDevice(state, active, 1_000);
    expect(state.phase).toBe('waiting');
    expect(state.activeDeviceId).toBeNull();
    expect(state.nextTurnAt).toBe(1_000 + TURN_GAP_MS);

    state = tick(state, 1_000 + TURN_GAP_MS, alwaysFirst);
    expect(state.activeDeviceId).not.toBe(active);
  });

  it('never picks a disconnected phone', () => {
    let state = startGame(roomWith(['a', 'b', 'c']), 0, alwaysFirst);
    const active = state.activeDeviceId!;
    const others = state.devices
      .filter((device) => device.id !== active)
      .map((device) => device.id);

    state = disconnectDevice(state, others[0], 100);
    state = acknowledgeTurn(state, active, state.turnId, 200);

    // Every random draw must still land on the one remaining connected phone.
    for (const draw of [0, 0.34, 0.5, 0.99]) {
      const next = tick(state, 200 + TURN_GAP_MS, scripted([draw, 0]));
      expect(next.activeDeviceId).toBe(others[1]);
    }
  });

  it('parks with nothing scheduled when the room empties, and restarts on rejoin', () => {
    let state = startGame(roomWith(['a', 'b']), 0, alwaysFirst);
    state = disconnectDevice(state, 'a', 100);
    state = disconnectDevice(state, 'b', 200);
    state = tick(state, 200 + TURN_GAP_MS, alwaysFirst);

    expect(state.phase).toBe('waiting');
    expect(state.activeDeviceId).toBeNull();
    expect(state.nextTurnAt).toBeNull();

    state = joinDevice(state, 'a', 10_000);
    expect(state.nextTurnAt).toBe(10_000 + TURN_GAP_MS);
    state = tick(state, 10_000 + TURN_GAP_MS, alwaysFirst);
    expect(state.activeDeviceId).toBe('a');
  });
});

describe('adult settings', () => {
  it('starts at five seconds', () => {
    expect(roomWith([]).settings.turnGapMs).toBe(TURN_GAP_MS);
  });

  it('uses the chosen gap for the next turn', () => {
    let state = applySettings(roomWith(['a', 'b']), { turnGapMs: 9_000 }, 0);
    state = startGame(state, 0, alwaysFirst);
    state = acknowledgeTurn(state, state.activeDeviceId!, state.turnId, 1_000);

    expect(state.nextTurnAt).toBe(10_000);
    expect(tick(state, 9_999, alwaysFirst).phase).toBe('waiting');
    expect(tick(state, 10_000, alwaysFirst).phase).toBe('active');
  });

  it('re-times a wait that is already running, counted from the change', () => {
    let state = startGame(roomWith(['a', 'b']), 0, alwaysFirst);
    state = acknowledgeTurn(state, state.activeDeviceId!, state.turnId, 1_000);
    expect(state.nextTurnAt).toBe(6_000);

    // Two seconds into a five second wait, the adult asks for ten.
    state = applySettings(state, { turnGapMs: 10_000 }, 3_000);
    expect(state.nextTurnAt).toBe(13_000);
  });

  it('leaves a lit turn alone', () => {
    const state = startGame(roomWith(['a', 'b']), 0, alwaysFirst);
    const changed = applySettings(state, { turnGapMs: 2_000 }, 500);
    expect(changed.phase).toBe('active');
    expect(changed.activeDeviceId).toBe(state.activeDeviceId);
    expect(changed.nextTurnAt).toBeNull();
  });

  it('allows no gap at all: the next phone lights up straight away', () => {
    let state = applySettings(roomWith(['a', 'b']), { turnGapMs: 0 }, 0);
    state = startGame(state, 0, alwaysFirst);
    const lit = state.activeDeviceId!;

    state = acknowledgeTurn(state, lit, state.turnId, 1_000);
    expect(state.phase).toBe('waiting');
    expect(state.nextTurnAt).toBe(1_000);

    // The very same moment is already due — no wait at all.
    state = tick(state, 1_000, alwaysFirst);
    expect(state.phase).toBe('active');
    expect(state.activeDeviceId).not.toBe(lit);
  });

  it('clamps what a phone sends into the range the controls offer', () => {
    expect(clampTurnGap(0)).toBe(0);
    expect(clampTurnGap(-5_000)).toBe(TURN_GAP_MIN_MS);
    expect(clampTurnGap(60_000)).toBe(TURN_GAP_MAX_MS);
    expect(clampTurnGap(Number.NaN)).toBe(TURN_GAP_MS);
    expect(clampTurnGap(7_500)).toBe(7_500);

    expect(applySettings(roomWith([]), { turnGapMs: 999_999 }, 0).settings.turnGapMs).toBe(
      TURN_GAP_MAX_MS,
    );
  });

  it('is unchanged when the value does not move', () => {
    const state = roomWith(['a']);
    expect(applySettings(state, { turnGapMs: TURN_GAP_MS }, 5_000)).toBe(state);
  });

  it('keeps working for a room stored before settings existed', () => {
    // A live room outlives a deployment. Without the fallback every nextTurnAt
    // computed from it would be NaN and the game would stop dead.
    const legacy = { ...roomWith(['a', 'b']) } as Record<string, unknown>;
    delete legacy.settings;
    const state = startGame(legacy as never, 0, alwaysFirst);
    const acked = acknowledgeTurn(state, state.activeDeviceId!, state.turnId, 1_000);
    expect(acked.nextTurnAt).toBe(1_000 + TURN_GAP_MS);
  });
});

describe('waking and expiry', () => {
  it('asks to be woken for the next turn', () => {
    let state = startGame(roomWith(['a', 'b']), 0, alwaysFirst);
    state = acknowledgeTurn(state, state.activeDeviceId!, state.turnId, 1_000);
    expect(nextWakeAt(state)).toBe(1_000 + TURN_GAP_MS);
  });

  it('asks to be woken for expiry once the room is empty', () => {
    let state = roomWith(['a'], 0);
    state = disconnectDevice(state, 'a', 500);
    expect(nextWakeAt(state)).toBe(state.lastActivityAt + ROOM_IDLE_TTL_MS);

    expect(isExpired(state, state.lastActivityAt + ROOM_IDLE_TTL_MS - 1)).toBe(false);
    expect(isExpired(state, state.lastActivityAt + ROOM_IDLE_TTL_MS)).toBe(true);
  });

  it('is never expired while a phone is connected', () => {
    const state = roomWith(['a'], 0);
    expect(isExpired(state, ROOM_IDLE_TTL_MS * 10)).toBe(false);
    expect(nextWakeAt(state)).toBeNull();
  });
});
