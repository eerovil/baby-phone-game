# Architecture

Three pieces: a state machine that knows the rules, a Durable Object that owns
one room's copy of that state, and a phone that renders whatever the object
last told it.

## The state machine — `src/game.ts`

Pure functions over a plain `RoomState` object. No timers, no randomness, no
sockets: the caller passes `now` and a `Random` in. Every rule the product asks
for lives here, which is why `tests/game.test.ts` can check all of them in
milliseconds and without a browser:

- **One active phone.** `RoomState.activeDeviceId` is a single field. There is
  no representation of two active phones, so there is no state to get wrong.
- **The gap.** `acknowledgeTurn` sets `nextTurnAt = now + settings.turnGapMs`,
  and `tick` refuses to start the next turn before that moment. The gap starts
  at `TURN_GAP_MS` (five seconds) and an adult can move it between
  `TURN_GAP_MIN_MS` and `TURN_GAP_MAX_MS`. `applySettings` clamps whatever
  arrives rather than refusing it, so an older client cannot get stuck sending
  a number the room will not take, and it re-times a wait that is already
  running so moving the slider mid-game has a visible effect. A room stored
  before settings existed falls back to the default — a live room outlives a
  deployment, and `undefined` here would make every `nextTurnAt` `NaN`.
- **Never the same phone twice.** `beginTurn` filters the previously lit device
  out of the candidates — unless it is the only one connected, where repeating
  beats stopping.
- **Only connected phones.** The candidate list is `connectedDevices`.
- **Duplicate touches.** `acknowledgeTurn` takes a turn id and ignores anything
  that is not the current turn from the currently active device. A second touch,
  a touch that raced the turn ending, and a touch on a black phone all return
  the state object unchanged.
- **Disconnect recovery.** `disconnectDevice` on the lit phone ends the turn and
  schedules the next one. If the room empties completely the game parks with
  `nextTurnAt === null`, and the next `joinDevice` restarts it.
- **Expiry.** `nextWakeAt` and `isExpired` say when an abandoned room may go.

## The room — `src/room.ts`

One Durable Object per room code (`idFromName(code)`), which is what makes the
state authoritative: Cloudflare guarantees one instance per name, so every
phone in a room talks to the same object and every decision is made in one
place.

It holds each phone's WebSocket, applies client messages through the state
machine, and broadcasts the whole room view afterwards. There are no
incremental updates — a phone that reconnects is correct as soon as it reads
the next message.

Its alarm does double duty. `persist()` computes the earliest thing that needs
attention (`nextWakeAt`) and sets the alarm for it, so the same mechanism runs
the five second gap between turns and the thirty minute expiry of an abandoned
room.

Identity is the device id the phone generates once and keeps in
`localStorage`, never the socket. A phone that reconnects returns to its seat
rather than appearing as a new player, and a socket closing is ignored if that
device already has a newer one open.

## The phone — `client/`

- `main.ts` — screens, storage, the touch handler, the adult exit, wake lock,
  and reacting to each `state` message.
- `connection.ts` — the WebSocket, with exponential backoff and a keepalive
  ping. Reconnection carries the same device id, so it rejoins the same seat.
- `audio.ts` — WebAudio synthesis. `unlock()` runs inside the tap that creates
  or joins a room, which is what lets a sound triggered by the server minutes
  later actually play on iOS and Android.
- `visuals.ts` — four canvas animations. `stop()` cancels the animation frame
  and clears the canvas, so a black phone is genuinely idle.

`document.body.dataset.lit` is set to `true`/`false` as the phone lights up and
goes black. Nothing in the page reads it; it exists so a test or a person with
the inspector open can tell the two states apart on an otherwise identical
black screen.

## Protocol — `src/protocol.ts`

JSON objects over one WebSocket at `/ws?room=<code>&device=<uuid>`.

Phone to room: `hello`, `start`, `stop`, `leave`, `settings {turnGapMs}`,
`ack {turnId}`, `ping`.
Room to phone: `state {you, room}`, `error {code, message}`, `pong`.

`state` carries the whole room: code, `settings`, phase, devices,
`activeDeviceId`, `turnId`, `variant` and `nextTurnInMs`. The settings ride in
the same message as everything else, so a phone that joins late shows the gap
the room is actually using rather than the default. The sliders are only
written back from a broadcast when no finger is on them. A phone decides it is the lit one by
comparing `activeDeviceId` with its own id — it is never told "you are active"
separately, so there is one fact rather than two that could disagree.

HTTP, all on the same Worker:

- `POST /api/rooms` → `{code}`. Six digits from `crypto.getRandomValues`. A code
  that already belongs to a live room answers 409 inside the object and the
  Worker tries another, up to eight times.
- `GET /api/rooms/<code>` → 200 or 404, so joining can report a wrong code
  before opening a socket.

## The public hostname

The Worker answers on `vauvapeli.<account>.workers.dev`. The public name
`vauvapeli.vilpponen.fi` is an nginx server block on the VPS that proxies to it,
matching how `ruokalista.vilpponen.fi` is served.

Two things that config must get right, and one of them is not in the ruokalista
block:

- `Host` is rewritten to the workers.dev name (and `proxy_ssl_name` with it), or
  Cloudflare rejects the request as a mismatched origin. Do not include
  `proxy_params` here — it sets `Host $http_host` and would add a second one.
- The WebSocket upgrade must be forwarded: `proxy_http_version 1.1`,
  `Upgrade $http_upgrade`, `Connection "upgrade"`, and a `proxy_read_timeout`
  long enough that an idle-looking game socket is not cut. Without these the
  page loads and the game never starts, which looks like an app bug rather than
  a proxy one.
