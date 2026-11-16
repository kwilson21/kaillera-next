import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerApplies, offerForConnection, reofferDue, signalForConnection } from '../../web/src/streaming/attempt.ts';
import { reofferDelayMs, startReofferDeadlines } from '../../web/src/streaming/reoffer.ts';
import { guardedSignalAction, type AttemptName, type GuardedSignalInput } from '../../web/src/streaming/signal.ts';

const BOOLS = [false, true] as const;
const PAGE = 'a1b2c3';
const OTHER_PAGE = 'ffee00';

// ── offerForConnection ───────────────────────────────────────────────────

test('an offer makes a connection when none is held, whatever it names', () => {
  for (const [page, attempt] of [
    ['', 0],
    [PAGE, 1],
    [PAGE, 7],
  ] as const) {
    assert.equal(offerForConnection(false, '', 0, page, attempt), 'create');
    assert.equal(offerForConnection(false, PAGE, 3, page, attempt), 'create');
  }
});

test("named offers follow the model's receiveOffer: the same connection renegotiates, a newer replaces, an older is dropped", () => {
  for (let held = 1; held <= 4; held++) {
    for (let named = 1; named <= 4; named++) {
      const expected = named === held ? 'renegotiate' : named > held ? 'replace' : 'drop';
      assert.equal(offerForConnection(true, PAGE, held, PAGE, named), expected, `held ${held}, named ${named}`);
    }
  }
});

test("an offer from another of the host's pages replaces the connection held, older count or not", () => {
  for (const named of [1, 2, 9]) assert.equal(offerForConnection(true, PAGE, 5, OTHER_PAGE, named), 'replace');
  // A connection made for an offer that named nothing is replaced by a named one.
  assert.equal(offerForConnection(true, '', 0, PAGE, 1), 'replace');
});

test('an offer that names nothing is a renegotiation of the connection held, as before attempts', () => {
  assert.equal(offerForConnection(true, PAGE, 3, '', 0), 'renegotiate');
  assert.equal(offerForConnection(true, '', 0, '', 0), 'renegotiate');
});

// ── signalForConnection and answerApplies ────────────────────────────────

test('a candidate reaches only the connection it names; one that names nothing reaches the one held', () => {
  assert.equal(signalForConnection(PAGE, 2, PAGE, 2), true);
  assert.equal(signalForConnection(PAGE, 2, PAGE, 1), false);
  assert.equal(signalForConnection(PAGE, 2, PAGE, 3), false);
  assert.equal(signalForConnection(PAGE, 2, OTHER_PAGE, 2), false);
  assert.equal(signalForConnection('', 0, PAGE, 1), false);
  assert.equal(signalForConnection(PAGE, 2, '', 0), true);
  assert.equal(signalForConnection('', 0, '', 0), true);
});

test('the host takes an answer only on a connection that waits for one, and only for its own offer', () => {
  for (const awaiting of BOOLS) {
    assert.equal(answerApplies(awaiting, PAGE, 2, PAGE, 2), awaiting);
    assert.equal(answerApplies(awaiting, PAGE, 2, PAGE, 1), false);
    assert.equal(answerApplies(awaiting, PAGE, 2, OTHER_PAGE, 2), false);
    assert.equal(answerApplies(awaiting, PAGE, 2, '', 0), awaiting);
  }
});

// ── reofferDue ───────────────────────────────────────────────────────────

test('only the host offers again, to a member it lists, and never over an open channel', () => {
  for (const host of BOOLS) {
    for (const listed of BOOLS) {
      for (const open of BOOLS) assert.equal(reofferDue(host, listed, open), host && listed && !open);
    }
  }
});

// ── guardedSignalAction with named signals ───────────────────────────────

const ROOM = {
  players: { host: { slot: 0 }, p2: { slot: 1 } },
  spectators: ['w1'],
} as const;

const name = (attempt: number, page = PAGE): AttemptName => ({ page, attempt });

const signal = (overrides: Partial<GuardedSignalInput>): GuardedSignalInput => ({
  sender: 'host',
  kind: 'offer',
  mySlot: 1,
  roster: ROOM,
  hasEntry: true,
  offerHeld: false,
  held: name(1),
  named: name(1),
  awaitingAnswer: false,
  ...overrides,
});

test("a guest replaces its connection for the host's newer offer, keeps it for the same one and drops an older one", () => {
  assert.deepEqual(guardedSignalAction(signal({ held: name(1), named: name(2) })), {
    create: false,
    replace: true,
    slot: 0,
    act: 'offer',
  });
  assert.deepEqual(guardedSignalAction(signal({ held: name(2), named: name(2) })), {
    create: false,
    replace: false,
    slot: null,
    act: 'offer',
  });
  assert.deepEqual(guardedSignalAction(signal({ held: name(3), named: name(2) })), {
    create: false,
    replace: false,
    slot: null,
    act: 'stale',
  });
  // A spectator's page follows the same rules.
  assert.equal(guardedSignalAction(signal({ mySlot: null, held: name(1), named: name(2) })).replace, true);
  // The offer gate still comes first: another member's newer offer is refused.
  assert.equal(guardedSignalAction(signal({ sender: 'p2', named: name(9) })).act, 'refused');
});

test('a candidate for another connection than the one held is dropped, on either page', () => {
  for (const mySlot of [0, 1, null] as const) {
    const sender = mySlot === 0 ? 'p2' : 'host';
    const candidate = signal({ sender, mySlot, kind: 'candidate', held: name(2) });
    assert.equal(guardedSignalAction({ ...candidate, named: name(2) }).act, 'candidate');
    assert.equal(guardedSignalAction({ ...candidate, named: name(1) }).act, 'stale');
    assert.equal(guardedSignalAction({ ...candidate, named: null }).act, 'candidate');
  }
});

test('the host drops the answer to an offer it replaced, and a second answer to an offer it sent again', () => {
  const answer = signal({ sender: 'p2', mySlot: 0, kind: 'answer', held: name(2), awaitingAnswer: true });
  assert.equal(guardedSignalAction({ ...answer, named: name(2) }).act, 'answer');
  assert.equal(guardedSignalAction({ ...answer, named: name(1) }).act, 'stale');
  assert.equal(guardedSignalAction({ ...answer, named: name(2), awaitingAnswer: false }).act, 'stale');
});

test('the host applies an offer sent to it as before: attempts are a rule for the pages that receive the stream', () => {
  const offer = signal({ sender: 'p2', mySlot: 0, held: name(5), named: name(1) });
  assert.deepEqual(guardedSignalAction(offer), { create: false, replace: false, slot: null, act: 'offer' });
});

// ── the deadline ─────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('the wait grows from 10 s by 10 s up to 30 s', () => {
  assert.deepEqual([0, 1, 2, 3, 10].map(reofferDelayMs), [10_000, 20_000, 30_000, 30_000, 30_000]);
});

test('a member with no open channel is offered again at each deadline until its channel opens', async () => {
  const offered: [string, number][] = [];
  let open = false;
  const deadlines = startReofferDeadlines({
    due: () => !open,
    reoffer: (sid, tries) => offered.push([sid, tries]),
    delayMs: () => 15,
  });
  deadlines.arm('p2');
  deadlines.arm('p2'); // already running: the deadline is not pushed back or doubled
  await wait(60);
  assert.ok(offered.length >= 2, JSON.stringify(offered));
  assert.deepEqual(
    offered.slice(0, 2).map(([sid, tries]) => `${sid}#${tries}`),
    ['p2#1', 'p2#2'],
  );
  open = true;
  deadlines.opened('p2');
  const after = offered.length;
  await wait(50);
  assert.equal(offered.length, after);
  assert.deepEqual(deadlines.armed(), []);
});

test('the count starts again after the channel opens, and the waits it chooses follow it', async () => {
  const waits: number[] = [];
  const deadlines = startReofferDeadlines({
    due: () => true,
    reoffer: () => undefined,
    delayMs: (tries) => {
      waits.push(tries);
      return 5;
    },
  });
  deadlines.arm('w1');
  await wait(40);
  deadlines.opened('w1');
  deadlines.arm('w1');
  await wait(3);
  deadlines.stop();
  assert.equal(waits[0], 0);
  assert.ok(waits.indexOf(0, 1) > 0, `the count went back to 0: ${JSON.stringify(waits)}`);
});

test('a deadline that finds the member not due ends, and the next arm starts a new one', async () => {
  let due = false;
  const offered: string[] = [];
  const deadlines = startReofferDeadlines({ due: () => due, reoffer: (sid) => offered.push(sid), delayMs: () => 10 });
  deadlines.arm('p2');
  await wait(30);
  assert.deepEqual(offered, []);
  assert.deepEqual(deadlines.armed(), []);
  due = true;
  deadlines.arm('p2');
  await wait(15);
  deadlines.stop();
  assert.deepEqual(offered.slice(0, 1), ['p2']);
});

test('forget and stop end the waits: nothing is offered after them', async () => {
  const offered: string[] = [];
  const deadlines = startReofferDeadlines({ due: () => true, reoffer: (sid) => offered.push(sid), delayMs: () => 15 });
  deadlines.arm('p2');
  deadlines.arm('p3');
  deadlines.arm('w1');
  deadlines.forget('p2');
  assert.deepEqual([...deadlines.armed()].sort(), ['p3', 'w1']);
  deadlines.stop();
  assert.deepEqual(deadlines.armed(), []);
  await wait(40);
  assert.deepEqual(offered, []);
});

test("an offer that throws ends that member's wait without touching the others, and it can be armed again", async () => {
  const offered: string[] = [];
  const deadlines = startReofferDeadlines({
    due: () => true,
    reoffer: (sid) => {
      if (sid === 'bad') throw new Error('no connection');
      offered.push(sid);
    },
    delayMs: () => 10,
  });
  deadlines.arm('bad');
  deadlines.arm('p2');
  await wait(35);
  assert.ok(!deadlines.armed().includes('bad'));
  assert.ok(deadlines.armed().includes('p2'));
  assert.ok(offered.includes('p2'));
  deadlines.arm('bad');
  assert.ok(deadlines.armed().includes('bad'));
  deadlines.stop();
});
