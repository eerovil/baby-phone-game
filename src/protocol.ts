/**
 * The wire protocol between a phone and its room.
 *
 * One JSON object per WebSocket message. The server never sends a partial
 * update: every change broadcasts the whole room view, so a phone that missed a
 * message while reconnecting is correct again the moment it reads the next one.
 */

import type { Phase } from './game';

export interface DeviceView {
  id: string;
  name: string;
  connected: boolean;
}

export interface RoomView {
  code: string;
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
  /** The child touched this phone while it was lit up. */
  | { type: 'ack'; turnId: number }
  | { type: 'ping' };

/** Room to phone. */
export type ServerMessage =
  | { type: 'state'; you: string; room: RoomView }
  | { type: 'error'; code: string; message: string }
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
    default:
      return null;
  }
}
