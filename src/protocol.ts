/**
 * The wire protocol between a phone and its room.
 *
 * One JSON object per WebSocket message. The server never sends a partial
 * update: every change broadcasts the whole room view, so a phone that missed a
 * message while reconnecting is correct again the moment it reads the next one.
 */

import type { Phase, RoomSettings } from './game';
import { isValidClip } from './voice';

export interface DeviceView {
  id: string;
  name: string;
  connected: boolean;
}

export interface RoomView {
  code: string;
  settings: RoomSettings;
  phase: Phase;
  devices: DeviceView[];
  activeDeviceId: string | null;
  turnId: number;
  variant: number;
  /** Milliseconds until the next phone lights up, or null when nothing is due. */
  nextTurnInMs: number | null;
}

/** Phone to room. */
export type ClientMessage =
  /** Sent once per connection. The device id comes from the query string. */
  | { type: 'hello' }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'leave' }
  /** An adult moved a setting. Applies to the whole room. */
  | { type: 'settings'; turnGapMs: number }
  /** The child touched this phone while it was lit up. */
  | { type: 'ack'; turnId: number }
  /**
   * This phone's recorded voice, or `null` to delete it. `replace` is true for
   * a recording just made, false when re-offering a stored one on connect.
   */
  | { type: 'voice'; clip: string | null; replace: boolean }
  | { type: 'ping' };

/** Room to phone. */
export type ServerMessage =
  | { type: 'state'; you: string; room: RoomView }
  | { type: 'error'; code: string; message: string }
  /**
   * The clip the room plays instead of the tune, and which phone recorded it.
   * Sent apart from `state` because it is large and rarely changes: once when a
   * phone connects, and to everyone when the clip changes.
   */
  | { type: 'voice'; from: string | null; clip: string | null }
  | { type: 'pong' };

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const type = (value as { type?: unknown }).type;
  switch (type) {
    case 'hello':
    case 'start':
    case 'stop':
    case 'leave':
    case 'ping':
      return { type };
    case 'ack': {
      const turnId = (value as { turnId?: unknown }).turnId;
      if (typeof turnId !== 'number' || !Number.isFinite(turnId)) return null;
      return { type: 'ack', turnId };
    }
    case 'settings': {
      const turnGapMs = (value as { turnGapMs?: unknown }).turnGapMs;
      // Out-of-range values are clamped by the state machine rather than
      // refused here, so an older client cannot get stuck sending a rejected
      // number. A non-number is a broken message and is dropped.
      if (typeof turnGapMs !== 'number' || !Number.isFinite(turnGapMs)) return null;
      return { type: 'settings', turnGapMs };
    }
    case 'voice': {
      const { clip, replace } = value as { clip?: unknown; replace?: unknown };
      if (clip !== null && !isValidClip(clip)) return null;
      return { type: 'voice', clip, replace: replace === true };
    }
    default:
      return null;
  }
}
