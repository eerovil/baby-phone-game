/**
 * One Durable Object per room code.
 *
 * This is the whole server side of the game: it owns the authoritative state,
 * holds every phone's WebSocket, and uses its alarm as the five second timer
 * between turns. Because Cloudflare routes one room code to exactly one of
 * these objects, there is no way for two phones to be told they are active.
 */

import {
  acknowledgeTurn,
  applySettings,
  createRoom,
  disconnectDevice,
  isExpired,
  joinDevice,
  nextWakeAt,
  removeDevice,
  startGame,
  stopGame,
  tick,
  TURN_GAP_MS,
  type RoomState,
} from './game';
import { parseClientMessage, type RoomView, type ServerMessage } from './protocol';

interface Connection {
  socket: WebSocket;
  deviceId: string;
}

export class Room implements DurableObject {
  private readonly storage: DurableObjectStorage;
  private room: RoomState | null = null;
  private loaded = false;
  private readonly connections = new Set<Connection>();

  constructor(ctx: DurableObjectState) {
    this.storage = ctx.storage;
    // Everything below runs after the state is back from storage, so a room
    // that was evicted between turns still answers correctly on first touch.
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await this.storage.get<RoomState>('room')) ?? null;
      this.loaded = true;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!this.loaded) this.room = (await this.storage.get<RoomState>('room')) ?? null;

    switch (url.pathname) {
      case '/create':
        return this.handleCreate(url.searchParams.get('code') ?? '');
      case '/exists':
        return new Response(null, { status: this.room ? 204 : 404 });
      case '/connect':
        return this.handleConnect(request, url.searchParams.get('device') ?? '');
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private async handleCreate(code: string): Promise<Response> {
    // A live room owns its code. The Worker treats this as a collision and
    // tries another code rather than dropping a family into someone else's game.
    if (this.room) return new Response('taken', { status: 409 });
    this.room = createRoom(code, Date.now());
    await this.persist();
    return new Response(null, { status: 201 });
  }

  private async handleConnect(request: Request, deviceId: string): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    if (!this.room) return new Response('no such room', { status: 404 });
    if (!deviceId) return new Response('missing device', { status: 400 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const connection: Connection = { socket: server, deviceId };
    this.connections.add(connection);

    this.room = joinDevice(this.room, deviceId, Date.now());
    await this.persist();

    server.addEventListener('message', (event) => {
      void this.onMessage(connection, event.data);
    });
    const close = () => void this.onClose(connection);
    server.addEventListener('close', close);
    server.addEventListener('error', close);

    this.send(connection, this.stateMessage(deviceId));
    this.broadcastExcept(connection);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async onMessage(connection: Connection, data: unknown): Promise<void> {
    if (typeof data !== 'string') return;
    const message = parseClientMessage(data);
    if (!message || !this.room) return;

    const now = Date.now();

    // Any message is also a chance to notice that a turn is overdue. An alarm
    // is normally what starts the next turn, but one can be delayed — a run
    // right after a deployment once left a room dark for twelve seconds. Each
    // phone pings every twenty seconds, so this turns the keepalive into a
    // watchdog and the game cannot sit dark for ever.
    const caughtUp = tick(this.room, now, Math.random);
    if (caughtUp !== this.room) {
      this.room = caughtUp;
      await this.persist();
      this.broadcast();
    }

    switch (message.type) {
      case 'ping':
        this.send(connection, { type: 'pong' });
        return;
      case 'hello':
        this.send(connection, this.stateMessage(connection.deviceId));
        return;
      case 'start':
        this.room = startGame(this.room, now, Math.random);
        break;
      case 'stop':
        this.room = stopGame(this.room, now);
        break;
      case 'leave':
        this.room = removeDevice(this.room, connection.deviceId, now);
        break;
      case 'settings':
        this.room = applySettings(this.room, { turnGapMs: message.turnGapMs }, now);
        break;
      case 'ack':
        // A second touch, or a touch that raced the turn ending, lands here and
        // changes nothing — the state machine checks the turn id.
        this.room = acknowledgeTurn(this.room, connection.deviceId, message.turnId, now);
        break;
    }
    await this.persist();
    this.broadcast();
  }

  private async onClose(connection: Connection): Promise<void> {
    if (!this.connections.delete(connection)) return;
    if (!this.room) return;

    // Only drop the seat when this device has no other live socket. A phone
    // that reconnected before the old socket's close event arrived keeps
    // playing instead of falling out of the room.
    const stillHere = [...this.connections].some((other) => other.deviceId === connection.deviceId);
    if (stillHere) return;

    this.room = disconnectDevice(this.room, connection.deviceId, Date.now());
    await this.persist();
    this.broadcast();
  }

  async alarm(): Promise<void> {
    if (!this.room) return;
    const now = Date.now();

    if (isExpired(this.room, now)) {
      this.room = null;
      await this.storage.deleteAll();
      return;
    }

    const advanced = tick(this.room, now, Math.random);
    const changed = advanced !== this.room;
    this.room = advanced;
    await this.persist();
    if (changed) this.broadcast();
  }

  /** Save the room and line up the next alarm for whatever is due first. */
  private async persist(): Promise<void> {
    if (!this.room) return;
    await this.storage.put('room', this.room);

    const wake = nextWakeAt(this.room);
    const current = await this.storage.getAlarm();
    if (wake === null) {
      if (current !== null) await this.storage.deleteAlarm();
      return;
    }
    if (current === null || current > wake) await this.storage.setAlarm(wake);
  }

  private view(): RoomView {
    const room = this.room!;
    return {
      code: room.code,
      settings: { turnGapMs: room.settings?.turnGapMs ?? TURN_GAP_MS },
      phase: room.phase,
      devices: room.devices.map((device) => ({
        id: device.id,
        name: device.name,
        connected: device.connected,
      })),
      activeDeviceId: room.activeDeviceId,
      turnId: room.turnId,
      variant: room.variant,
      nextTurnInMs: room.nextTurnAt === null ? null : Math.max(0, room.nextTurnAt - Date.now()),
    };
  }

  private stateMessage(deviceId: string): ServerMessage {
    return { type: 'state', you: deviceId, room: this.view() };
  }

  private send(connection: Connection, message: ServerMessage): void {
    try {
      connection.socket.send(JSON.stringify(message));
    } catch {
      this.connections.delete(connection);
    }
  }

  private broadcast(): void {
    if (!this.room) return;
    for (const connection of this.connections) {
      this.send(connection, this.stateMessage(connection.deviceId));
    }
  }

  private broadcastExcept(skip: Connection): void {
    if (!this.room) return;
    for (const connection of this.connections) {
      if (connection === skip) continue;
      this.send(connection, this.stateMessage(connection.deviceId));
    }
  }
}
