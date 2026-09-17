/**
 * The room WebSocket, with reconnection.
 *
 * The device id lives in `localStorage` and travels in the query string, so a
 * reconnect returns to the same seat in the room. Nothing about the game is
 * kept here — the server's `state` message is the only truth, and every
 * reconnect simply receives the current one.
 */

import type { RoomView, ServerMessage } from '../src/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface ConnectionHandlers {
  onState(room: RoomView, you: string): void;
  onStatus(status: ConnectionStatus): void;
  onError(code: string, message: string): void;
}

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5_000;
const PING_MS = 20_000;

export class RoomConnection {
  private socket: WebSocket | null = null;
  private retryMs = RETRY_MIN_MS;
  private retryTimer: number | null = null;
  private pingTimer: number | null = null;
  private closedByUs = false;

  constructor(
    private readonly code: string,
    private readonly deviceId: string,
    private readonly handlers: ConnectionHandlers,
  ) {}

  open(): void {
    this.closedByUs = false;
    this.connect();
  }

  close(): void {
    this.closedByUs = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.handlers.onStatus('closed');
  }

  send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  /** Called when the app comes back to the foreground. */
  ensureOpen(): void {
    if (this.closedByUs) return;
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.connect();
  }

  private connect(): void {
    this.clearTimers();
    this.handlers.onStatus('connecting');

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${scheme}://${location.host}/ws?room=${encodeURIComponent(this.code)}&device=${encodeURIComponent(this.deviceId)}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.retryMs = RETRY_MIN_MS;
      this.handlers.onStatus('open');
      this.send({ type: 'hello' });
      this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), PING_MS);
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === 'state') this.handlers.onState(message.room, message.you);
      else if (message.type === 'error') this.handlers.onError(message.code, message.message);
    });

    const reconnect = () => {
      if (this.socket !== socket) return;
      this.clearTimers();
      this.socket = null;
      if (this.closedByUs) return;
      this.handlers.onStatus('connecting');
      this.retryTimer = window.setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    };
    socket.addEventListener('close', reconnect);
    socket.addEventListener('error', reconnect);
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
  }
}
