# Vauvapeli — baby phone game

A chase game for a baby, played on two or more old phones.

Put the phones around a room. One phone at a time lights up with a bright
animation and plays a short sound; every other phone is completely black. The
child walks to the lit phone and touches it. The sound and the light stop at
once. Five seconds later a different phone lights up, and it starts again.

The app is a PWA, so it installs from the browser on old Android and iOS phones
with no app store and no developer account. The user interface is in Finnish.

## How it plays

1. On the first phone, tap **Luo peli**. It shows a six digit room code.
2. On every other phone, tap **Liity peliin** and type the same code.
3. When at least two phones are in the room, tap **Aloita peli**.
4. Play continues until an adult stops it.

**Settings.** The lobby has a slider for **Tauko vuorojen välissä** — the dark
gap between one phone being touched and the next lighting up. It starts at five
seconds and goes from one to twenty. The setting belongs to the room, so moving
it on any phone changes it for all of them, and the same slider is in the adult
menu, so it can be adjusted mid-game without stopping. Shortening the gap while
the room is already dark shortens the wait that is running.

**Stopping the game, and the mid-game settings:** press and hold the top-left corner of the screen of any
black phone for about 2.5 seconds. A menu appears with the gap slider and
**Lopeta peli**. A touch
on the lit phone is the child's move, so the exit lives on a black screen and
behind a hold long enough that a baby's tap will not find it.

The app remembers the last room code and this phone's own id, so the next time
it opens it offers **Palaa huoneeseen** instead of asking for the code again.
**Unohda** clears that.

## What is deliberately not there

- No accounts, no login, no database.
- No sound or image files downloaded during play: the sounds are synthesised
  with WebAudio and the animations are drawn on a canvas.
- Nothing on the child's screen except the animation. No status text, no
  buttons, not even a connection indicator — a reconnect happens in the dark.
- No attempt to work while the phone is locked or the app is in the background.
  The game is meant to be open and in the foreground.

## Architecture in one paragraph

A single Cloudflare Worker serves the static PWA and routes `/ws` into a
Durable Object, one per room code. That object holds the only copy of the room
state, so two phones can never both be told they are active. The five second
gap between turns is a Durable Object alarm. The rules themselves — who to pick
next, what a touch means, what happens when a phone drops — live in
[`src/game.ts`](src/game.ts) as pure functions with the clock and the random
source passed in, which is what makes them testable. Details are in
[docs/architecture.md](docs/architecture.md).

## Development

There is no node on the usual development host, so every npm and wrangler
command runs in a container:

    ./scripts/node.sh npm install
    ./scripts/node.sh npm run check        # format, lint, typecheck, tests, build
    ./scripts/node.sh --serve npm run dev  # http://127.0.0.1:8787

`npm run check` runs everything CI would. The individual pieces are
`format:check`, `lint`, `typecheck`, `test`, `build` and `check:icons`.

`public/app.js` and `public/icons/*` are build outputs, committed so the Worker
can serve `public/` as-is. `npm run build` and `npm run generate:icons` write
them; `check:client` and `check:icons` fail if they are stale.

### Testing with real phones on the same network

`wrangler dev` listens on all interfaces, so a phone on the same Wi-Fi can open
`http://<computer-ip>:8787`. Two caveats on a plain-HTTP origin: the service
worker will not install, and the screen wake lock is unavailable. Both need
HTTPS. For a realistic test use a tunnel — for example
`tailscale serve --https=8787 http://127.0.0.1:8787` — or deploy.

### End to end against a running server

    ./scripts/node.sh --net-host node dev/two-phones.mjs
    ./scripts/node.sh --net-host node dev/two-phones.mjs https://vauvapeli.vilpponen.fi

This opens two real WebSocket clients and walks several turns, checking that
exactly one phone is ever lit, that a double touch does not advance the game
twice, that the gap really is about five seconds, that the same phone is never
picked twice in a row, and that the game recovers when the lit phone drops off.

## Deployment

The app is one Worker with a Durable Object and static assets. Nothing else.

    ./scripts/node.sh --login npx wrangler login     # once, or use an API token
    ./scripts/node.sh --cloudflare npm run deploy

With an API token instead of an interactive login, put it outside the repo:

    mkdir -p ~/.local/share/vauvapeli
    cat > ~/.local/share/vauvapeli/cloudflare.env <<'EOF'
    CLOUDFLARE_API_TOKEN="…"
    CLOUDFLARE_ACCOUNT_ID="…"
    EOF
    chmod 600 ~/.local/share/vauvapeli/cloudflare.env

`scripts/node.sh --cloudflare` reads that file and forwards the two variables by
name. No secret belongs in the repository, and the app itself needs none — there
are no runtime secrets at all.

The deployment answers on `https://vauvapeli.<account>.workers.dev`. The public
name `https://vauvapeli.vilpponen.fi` is an nginx proxy in front of it; see
[docs/architecture.md](docs/architecture.md#the-public-hostname) for the server
block, which needs the WebSocket upgrade headers that an ordinary proxy config
leaves out.
