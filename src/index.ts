/**
 * The Worker: a tiny router in front of the room objects.
 *
 * Everything that is not an API call or a WebSocket upgrade is a static file
 * from `public/`, served by the assets binding.
 */

import { Room } from './room';

export { Room };

export interface Env {
  ASSETS: Fetcher;
  ROOM: DurableObjectNamespace;
}

const ROOM_CODE = /^[0-9]{6}$/;

/** How many fresh codes to try before admitting the room could not be made. */
const CODE_ATTEMPTS = 8;

function randomCode(): string {
  // Six digits, leading zeros allowed, from the platform's own CSPRNG.
  const digits = new Uint8Array(6);
  crypto.getRandomValues(digits);
  return [...digits].map((byte) => byte % 10).join('');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function roomStub(env: Env, code: string): DurableObjectStub {
  return env.ROOM.get(env.ROOM.idFromName(code));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
        const code = randomCode();
        const created = await roomStub(env, code).fetch(`https://room/create?code=${code}`, {
          method: 'POST',
        });
        // 409 means that code is already a live room — try another one.
        if (created.status === 201) return json({ code }, 201);
      }
      return json({ error: 'code_collision' }, 503);
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([0-9]{6})$/);
    if (roomMatch && request.method === 'GET') {
      const exists = await roomStub(env, roomMatch[1]).fetch('https://room/exists');
      return exists.status === 204
        ? json({ code: roomMatch[1] })
        : json({ error: 'not_found' }, 404);
    }

    if (url.pathname === '/ws') {
      const code = url.searchParams.get('room') ?? '';
      const device = url.searchParams.get('device') ?? '';
      if (!ROOM_CODE.test(code)) return new Response('bad room code', { status: 400 });
      if (device.length < 8 || device.length > 64)
        return new Response('bad device id', { status: 400 });
      // Rebuilt from the original request so the Upgrade header survives the
      // hop into the Durable Object.
      const forwarded = new Request(
        `https://room/connect?device=${encodeURIComponent(device)}`,
        request,
      );
      return roomStub(env, code).fetch(forwarded);
    }

    return env.ASSETS.fetch(request);
  },
};
