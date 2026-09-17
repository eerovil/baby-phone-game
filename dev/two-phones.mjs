/**
 * An end-to-end smoke test against a running dev server.
 *
 * It plays the acceptance criteria out over real WebSockets: create a room,
 * join with two devices, start, and then walk several turns — checking that
 * exactly one phone is ever lit, that a touch blacks it out at once, that the
 * next phone lights up about five seconds later, and that it is never the same
 * phone twice in a row.
 *
 *   ./scripts/node.sh node dev/two-phones.mjs            # against 127.0.0.1:8787
 *   ./scripts/node.sh node dev/two-phones.mjs https://…  # against a deployment
 */

const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const wsBase = base.replace(/^http/, 'ws');
const TURNS = 6;

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function ok(message) {
  console.log(`ok   ${message}`);
}

class Phone {
  constructor(name, code) {
    this.name = name;
    this.code = code;
    this.id = crypto.randomUUID();
    this.room = null;
    this.waiters = [];
  }

  async connect() {
    this.socket = new WebSocket(`${wsBase}/ws?room=${this.code}&device=${this.id}`);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.type !== 'state') return;
      this.room = message.room;
      for (const waiter of this.waiters.splice(0)) waiter(message.room);
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    await this.next();
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  /** Resolve on the next state broadcast, or reject if none arrives. */
  next(timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.name}: no state in ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.waiters.push((room) => {
        clearTimeout(timer);
        resolve(room);
      });
    });
  }

  /** Resolve once the room satisfies `predicate`. */
  async until(predicate, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs;
    if (this.room && predicate(this.room)) return this.room;
    while (Date.now() < deadline) {
      const room = await this.next(deadline - Date.now());
      if (predicate(room)) return room;
    }
    throw new Error(`${this.name}: condition not met in ${timeoutMs}ms`);
  }

  get lit() {
    return this.room?.phase === 'active' && this.room.activeDeviceId === this.id;
  }
}

const created = await fetch(`${base}/api/rooms`, { method: 'POST' });
if (created.status !== 201) fail(`room creation returned ${created.status}`);
const { code } = await created.json();
if (!/^[0-9]{6}$/.test(code)) fail(`room code is not six digits: ${code}`);
ok(`created room ${code}`);

const lookup = await fetch(`${base}/api/rooms/${code}`);
if (!lookup.ok) fail('joining device could not look the room up');
const missing = await fetch(`${base}/api/rooms/000001`);
if (missing.status !== 404) fail('an unknown room code did not 404');
ok('room lookup answers for a real code and 404s for an unknown one');

const a = new Phone('A', code);
const b = new Phone('B', code);
await a.connect();
await b.connect();
await a.until((room) => room.devices.filter((device) => device.connected).length === 2);
ok('both phones are in the lobby');

a.send({ type: 'start' });
await a.until((room) => room.phase === 'active');
await b.until((room) => room.phase === 'active');
ok('game started');

let previous = null;
for (let turn = 1; turn <= TURNS; turn += 1) {
  const phones = [a, b];
  // Each phone learns about a turn in its own message, so wait for both to have
  // seen this one before judging who is lit.
  await Promise.all(phones.map((phone) => phone.until((room) => room.phase === 'active')));
  const activeId = a.room.activeDeviceId;
  const lit = phones.filter((phone) => phone.lit);
  if (lit.length !== 1) fail(`turn ${turn}: ${lit.length} phones lit, expected exactly 1`);
  if (a.room.activeDeviceId !== b.room.activeDeviceId) {
    fail(`turn ${turn}: the two phones disagree about who is active`);
  }
  if (previous && activeId === previous)
    fail(`turn ${turn}: the same phone was picked twice in a row`);
  previous = activeId;

  const active = lit[0];
  const turnId = active.room.turnId;

  // The child touches it — twice, quickly, the way a baby actually would.
  const touchedAt = Date.now();
  active.send({ type: 'ack', turnId });
  active.send({ type: 'ack', turnId });

  await active.until((room) => room.phase === 'waiting');
  ok(`turn ${turn}: ${active.name} was lit and went black on touch`);

  await a.until((room) => room.phase === 'active' && room.turnId === turnId + 1, 12_000);
  const gap = Date.now() - touchedAt;
  if (gap < 4_500 || gap > 7_000)
    fail(`turn ${turn}: next turn came after ${gap}ms, expected about 5000`);
  if (a.room.turnId !== turnId + 1) {
    fail(`turn ${turn}: turn id jumped to ${a.room.turnId} — a duplicate touch was counted`);
  }
  ok(`turn ${turn}: next phone lit after ${gap}ms, turn id advanced by exactly 1`);
}

// The adult moves the gap slider: the change reaches both phones, and the next
// turn really does arrive on the new timing.
{
  await Promise.all([a, b].map((phone) => phone.until((room) => room.phase === 'active')));
  a.send({ type: 'settings', turnGapMs: 2000 });
  await Promise.all([a, b].map((phone) => phone.until((room) => room.settings.turnGapMs === 2000)));
  ok('the new gap reached both phones');

  const active = [a, b].find((phone) => phone.lit);
  const turnId = active.room.turnId;
  const touchedAt = Date.now();
  active.send({ type: 'ack', turnId });
  await a.until((room) => room.phase === 'active' && room.turnId === turnId + 1, 12_000);
  const gap = Date.now() - touchedAt;
  if (gap < 1_600 || gap > 3_500) fail(`the two second gap measured ${gap}ms`);
  ok(`next turn came after ${gap}ms with the gap set to 2000ms`);

  // An out of range value is clamped rather than refused.
  a.send({ type: 'settings', turnGapMs: 999_999 });
  await Promise.all(
    [a, b].map((phone) => phone.until((room) => room.settings.turnGapMs === 20_000)),
  );
  ok('an out of range gap was clamped to the maximum');
  a.send({ type: 'settings', turnGapMs: 5000 });
  await a.until((room) => room.settings.turnGapMs === 5000);
}

// Disconnect recovery: pull the plug on whichever phone is lit.
const lit = [a, b].find((phone) => phone.lit);
const other = lit === a ? b : a;
lit.socket.close();
await other.until((room) => room.phase === 'active' && room.activeDeviceId === other.id, 12_000);
ok('the lit phone dropping off recovered into a new turn on the remaining phone');

other.send({ type: 'stop' });
await other.until((room) => room.phase === 'lobby');
ok('the adult stop returned the room to the lobby');

other.socket.close();
console.log('\nall checks passed');
// An open WebSocket keeps node's event loop alive well past the last check.
process.exit(0);
