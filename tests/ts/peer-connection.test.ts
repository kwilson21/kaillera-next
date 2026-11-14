/**
 * The per-peer connection machine, replaying the scenarios of
 * specs/peer_connection.qnt (variant `peer_connection_fixed`) with one
 * machine for each of the model's two pages, `lo` and `hi`.
 *
 * The machine is walked with XState's pure `transition`, and the deadlines
 * it arms are kept here on a clock the test moves: `fire` is the model
 * choosing one timeout action, `advance` is time passing.
 *
 * Run: node --test tests/ts/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Option, Schema } from 'effect';
import { initialTransition, transition } from 'xstate';
import {
  PEER_TIMING,
  PeerCommand,
  peerConnectionMachine,
  peerFacts,
  peerStateName,
  createPeerConnection,
  type OfferMode,
  type PeerEvent,
  type PeerState,
  type PeerTiming,
} from '../../web/src/peer-connection.ts';

type Deadline = 'startupAfter' | 'attemptAfter' | 'giveUpAfter' | 'answerAfter' | 'healAfter';
const After = Schema.Struct({
  type: Schema.Literal('xstate.after'),
  delay: Schema.Literals(['startupAfter', 'attemptAfter', 'giveUpAfter', 'answerAfter', 'healAfter']),
  stateId: Schema.String,
});
type After = typeof After.Type;
/** What a transition asks of its host: issue a command, arm a deadline, disarm one. */
const decodeEffect = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal('issue'), args: Schema.Tuple([Schema.Struct({ command: PeerCommand })]) }),
    Schema.Struct({ type: Schema.Literal('@xstate.raise'), event: After, delay: Schema.Number }),
    Schema.Struct({ type: Schema.Literal('@xstate.cancel'), event: After }),
  ]),
);

// SAFETY: a deadline is an event XState raises for itself and takes like any other; only the
// type of what a host may send leaves it out.
const raised = (event: PeerEvent | After): PeerEvent => event as PeerEvent;

type Timer = { readonly at: number; readonly event: After };

/** One page's machine for the other player, with its commands and its armed deadlines. */
const page = (mySlot: number, theirSlot: number, timing: PeerTiming = PEER_TIMING) => {
  let [snapshot, effects] = initialTransition(peerConnectionMachine, { mySlot, theirSlot, timing });
  let now = 0;
  let timers: Timer[] = [];
  const commands: PeerCommand[] = [];
  const absorb = (produced: readonly unknown[]): void => {
    for (const raw of produced) {
      const effect = Option.getOrNull(decodeEffect(raw));
      assert.ok(effect, `an effect the test does not know: ${JSON.stringify(raw)}`);
      if (effect.type === 'issue') commands.push(effect.args[0].command);
      else if (effect.type === '@xstate.raise') timers.push({ at: now + effect.delay, event: effect.event });
      else
        timers = timers.filter((t) => t.event.delay !== effect.event.delay || t.event.stateId !== effect.event.stateId);
    }
  };
  absorb(effects);
  const step = (event: PeerEvent): void => {
    [snapshot, effects] = transition(peerConnectionMachine, snapshot, event);
    absorb(effects);
  };
  const expire = (timer: Timer): void => {
    timers = timers.filter((t) => t !== timer);
    step(raised(timer.event));
  };
  return {
    send: step,
    state: (): PeerState => peerStateName(snapshot.value),
    context: () => snapshot.context,
    /** The commands issued since the last call. */
    issued: (): PeerCommand[] => commands.splice(0),
    armed: (): Deadline[] => timers.map((t) => t.event.delay).sort(),
    /** The model takes this timeout action now, whatever else is armed. */
    fire: (deadline: Deadline): void => {
      const timer = timers.find((t) => t.event.delay === deadline);
      assert.ok(timer, `${deadline} is not armed in ${peerStateName(snapshot.value)}`);
      expire(timer);
    },
    /** Time passes: every deadline that comes due fires, in order. */
    advance: (ms: number): void => {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        expire(due);
      }
      now = until;
    },
  };
};
type Page = ReturnType<typeof page>;

/** The model's two pages. Signals travel only when the scenario delivers them. */
const pair = (timing: PeerTiming = PEER_TIMING) => {
  const lo = page(0, 1, timing);
  const hi = page(1, 0, timing);
  const other = (to: Page): Page => (to === lo ? hi : lo);
  return {
    lo,
    hi,
    /** `deliver` of an offer in the model. */
    offer: (to: Page, attempt: number, mode: OfferMode): void =>
      to.send({ type: 'offer', attempt, mode, underEarlierId: false }),
    /** `deliver` of an answer. */
    answer: (to: Page, attempt: number): void => to.send({ type: 'answer', attempt }),
    /** `channelOpens`: the channel of the page's connection opens. */
    opens: (on: Page): void => on.send({ type: 'opened', attempt: on.context().connection }),
    /** `notice`: the page finds out its connection is gone. */
    notice: (on: Page): void => on.send({ type: 'lost', attempt: on.context().connection }),
    /** `start`. */
    start: (): void => {
      lo.send({ type: 'matchStarted' });
      hi.send({ type: 'matchStarted' });
    },
    /** `bothOpenOn(id)`. */
    bothOpenOn: (attempt: number): boolean =>
      [lo, hi].every((p) => p.state() === 'open' && p.context().connection === attempt),
    /** `oneInitiatorPerPair`: the two pages never both hold an unanswered offer. */
    oneInitiator: (): boolean => !(lo.context().awaitingAnswer && hi.context().awaitingAnswer),
    other,
  };
};

/** The model's `init`: the match is under way on connection 1. */
const inMatch = (timing: PeerTiming = PEER_TIMING) => {
  const p = pair(timing);
  p.lo.send({ type: 'roster' });
  p.hi.send({ type: 'roster' });
  p.offer(p.hi, 1, 'first');
  p.answer(p.lo, 1);
  p.opens(p.lo);
  p.opens(p.hi);
  p.start();
  p.lo.issued();
  p.hi.issued();
  assert.ok(p.bothOpenOn(1));
  return p;
};

// ── the model's scenarios ────────────────────────────────────────────────

test('the roster reaches both pages, then the offer (rosterThenOfferTest)', () => {
  const { lo, hi, offer, answer, opens, start, bothOpenOn, oneInitiator } = pair();
  lo.send({ type: 'roster' });
  assert.equal(lo.state(), 'offering');
  assert.deepEqual(lo.issued(), [{ type: 'offer', attempt: 1, mode: 'first' }]);
  hi.send({ type: 'roster' });
  assert.equal(hi.state(), 'awaitingOffer');
  assert.deepEqual(hi.issued(), []);
  offer(hi, 1, 'first');
  assert.equal(hi.state(), 'answering');
  assert.deepEqual(hi.issued(), [{ type: 'answer', attempt: 1, connection: 'kept' }]);
  answer(lo, 1);
  assert.deepEqual(lo.issued(), [{ type: 'applyAnswer', attempt: 1 }]);
  opens(lo);
  opens(hi);
  start();
  assert.ok(bothOpenOn(1));
  assert.ok(oneInitiator());
  assert.deepEqual([...lo.issued(), ...hi.issued()], []);
});

test('the offer reaches the higher slot before its roster does (offerBeforeRosterTest)', () => {
  const { lo, hi, offer, answer, opens, bothOpenOn } = pair();
  lo.send({ type: 'roster' });
  offer(hi, 1, 'first');
  // The entry is made on demand.
  assert.equal(hi.state(), 'answering');
  assert.deepEqual(hi.issued(), [{ type: 'answer', attempt: 1, connection: 'new' }]);
  hi.send({ type: 'roster' });
  assert.equal(hi.state(), 'answering');
  assert.deepEqual(hi.issued(), []);
  answer(lo, 1);
  opens(hi);
  opens(lo);
  assert.ok(bothOpenOn(1));
});

test('the first offer is lost; the startup deadline sends another (startupRetryTest)', () => {
  const { lo, hi, offer, answer, opens, bothOpenOn } = pair();
  lo.send({ type: 'roster' });
  hi.send({ type: 'roster' });
  lo.issued();
  lo.fire('startupAfter');
  assert.deepEqual(lo.issued(), [{ type: 'offer', attempt: 2, mode: 'startup' }]);
  offer(hi, 2, 'startup');
  answer(lo, 2);
  opens(lo);
  opens(hi);
  assert.ok(bothOpenOn(2));
});

test('every offer is lost: after the third the player is told and nothing more is sent (startupGivesUpTest)', () => {
  const { lo, hi } = pair();
  lo.send({ type: 'roster' });
  hi.send({ type: 'roster' });
  lo.fire('startupAfter');
  lo.fire('startupAfter');
  assert.equal(lo.state(), 'offering');
  assert.equal(lo.context().tries, PEER_TIMING.maxAttempts);
  assert.deepEqual(
    lo.issued().map((c) => c.type),
    ['offer', 'offer', 'offer'],
  );
  lo.fire('startupAfter');
  assert.equal(lo.state(), 'stalled');
  assert.equal(lo.context().tries, 0);
  assert.equal(lo.context().offers, 3);
  assert.deepEqual(lo.issued(), [{ type: 'stalled' }]);
  // Nothing armed acts before the match: no fourth offer, however long it lasts.
  lo.advance(10 * 60_000);
  assert.equal(lo.state(), 'stalled');
  assert.deepEqual(lo.issued(), []);
});

test('the startup deadlines run on the clock: three offers 8 s apart, then stalled', () => {
  const { lo } = pair();
  lo.send({ type: 'roster' });
  lo.advance(PEER_TIMING.startupAfterMs - 1);
  assert.equal(lo.context().offers, 1);
  lo.advance(1);
  assert.equal(lo.context().offers, 2);
  lo.advance(PEER_TIMING.startupAfterMs);
  assert.equal(lo.context().offers, 3);
  assert.equal(lo.state(), 'offering');
  lo.advance(PEER_TIMING.startupAfterMs);
  assert.equal(lo.state(), 'stalled');
});

test('a roster offer that arrives after the match began on a retry (lateFirstOfferTest)', () => {
  const { lo, hi, offer, answer, opens, start, notice } = pair();
  lo.send({ type: 'roster' });
  hi.send({ type: 'roster' });
  lo.fire('startupAfter');
  offer(hi, 2, 'startup');
  answer(lo, 2);
  opens(lo);
  opens(hi);
  start();
  hi.issued();
  lo.issued();
  offer(hi, 1, 'first');
  // Not a replacement offer: applied to the connection the guest is playing
  // on. The channel stays open on a connection that now matches nothing.
  assert.equal(hi.state(), 'open');
  assert.deepEqual(hi.issued(), [{ type: 'answer', attempt: 1, connection: 'kept' }]);
  assert.notEqual(hi.context().connection, lo.context().connection);
  // Its answer finds a page that is no longer waiting for one.
  answer(lo, 1);
  assert.deepEqual(lo.issued(), [{ type: 'ignore', signal: 'answer', attempt: 1, reason: 'stale' }]);
  assert.equal(lo.state(), 'open');
  notice(hi);
  assert.equal(hi.state(), 'reconnecting.awaitingOffer');
  assert.deepEqual(hi.armed(), ['giveUpAfter']);
});

test('a channel found dead by the health check: only the lower slot offers (silentCloseTest)', () => {
  // The machine has no silent close: a channel that died with no event is
  // still `open` to it until the engine's check reports it, as `lost`.
  const { lo, hi, notice, oneInitiator } = inMatch();
  notice(hi);
  assert.equal(hi.state(), 'reconnecting.awaitingOffer');
  assert.equal(hi.context().awaitingAnswer, false);
  assert.deepEqual(hi.issued(), []);
  notice(lo);
  assert.deepEqual(lo.issued(), [{ type: 'offer', attempt: 2, mode: 'reconnect' }]);
  assert.ok(oneInitiator());
});

test('a drop both pages notice: the guest comes back with its input state cleared (reconnectTest)', () => {
  const { lo, hi, offer, answer, opens, notice, bothOpenOn } = inMatch();
  notice(hi);
  notice(lo);
  assert.equal(lo.state(), 'reconnecting.offering');
  lo.issued();
  offer(hi, 2, 'reconnect');
  assert.equal(hi.state(), 'reconnecting.answering');
  assert.deepEqual(hi.issued(), [{ type: 'answer', attempt: 2, connection: 'new' }]);
  answer(lo, 2);
  opens(hi);
  // reconnectStartsClean: resetPeerState before the guest plays on.
  assert.deepEqual(hi.issued(), [{ type: 'reset', reason: 'reconnect' }]);
  opens(lo);
  // The host keeps its own state and pushes the match's.
  assert.deepEqual(lo.issued(), [{ type: 'applyAnswer', attempt: 2 }]);
  assert.ok(bothOpenOn(2));
  assert.equal(peerFacts(hi.state()).reconnecting, false);
  assert.deepEqual([...lo.armed(), ...hi.armed()], []);
});

test('the guest gave up, then answers a reconnect offer: the give-up is armed (guestGaveUpThenAnswersTest)', () => {
  const { lo, hi, offer, notice } = inMatch();
  notice(hi);
  hi.fire('giveUpAfter');
  assert.equal(hi.state(), 'absent');
  assert.deepEqual(hi.issued(), [{ type: 'drop', reason: 'gaveUp' }]);
  notice(lo);
  offer(hi, 2, 'reconnect');
  // ANSWERER_HAS_DEADLINE: the entry made on demand is reconnecting with the give-up armed.
  assert.equal(hi.state(), 'reconnecting.answering');
  assert.deepEqual(hi.armed(), ['answerAfter', 'giveUpAfter']);
});

test('only the lower slot notices the drop: the guest that answers has a deadline (dropNoticedByOneSideTest)', () => {
  const { lo, hi, offer, notice } = inMatch();
  notice(lo);
  offer(hi, 2, 'reconnect');
  assert.equal(hi.state(), 'reconnecting.answering');
  assert.deepEqual(hi.issued(), [{ type: 'answer', attempt: 2, connection: 'new' }]);
  // closeNeverComes: no close event for the channel the offer replaced.
  assert.deepEqual(hi.armed(), ['answerAfter', 'giveUpAfter']);
  // And where the browser does fire it, it is the close of connection 1, not of the entry's.
  hi.send({ type: 'lost', attempt: 1 });
  assert.equal(hi.state(), 'reconnecting.answering');
  assert.deepEqual(hi.issued(), [{ type: 'ignore', signal: 'lost', attempt: 1, reason: 'stale' }]);
});

test('the guest gives up while the lower slot reconnects: it never offers (bothOfferAtOnceTest)', () => {
  const { lo, hi, notice, oneInitiator } = inMatch();
  notice(hi);
  hi.fire('giveUpAfter');
  hi.issued();
  // HEAL_ONE_SIDE: the health check is armed on the guest's page too, and offers nothing.
  hi.advance(10 * 60_000);
  assert.equal(hi.state(), 'absent');
  assert.deepEqual(hi.issued(), []);
  notice(lo);
  assert.ok(oneInitiator());
});

test('both pages gave up; the lower slot heals and the pair reconnects (crossedHealOffersTest)', () => {
  const { lo, hi, offer, answer, opens, notice, bothOpenOn } = inMatch();
  notice(hi);
  notice(lo);
  // Offer 2 is lost.
  hi.fire('giveUpAfter');
  lo.fire('giveUpAfter');
  assert.equal(lo.state(), 'absent');
  assert.deepEqual(lo.issued(), [
    { type: 'offer', attempt: 2, mode: 'reconnect' },
    { type: 'drop', reason: 'gaveUp' },
  ]);
  // neverLeftWithNothingPending: the lower slot's health check is still to come.
  assert.deepEqual(lo.armed(), ['healAfter']);
  lo.fire('healAfter');
  assert.equal(lo.state(), 'healing');
  assert.deepEqual(lo.issued(), [{ type: 'offer', attempt: 3, mode: 'reconnect' }]);
  offer(hi, 3, 'reconnect');
  answer(lo, 3);
  opens(lo);
  opens(hi);
  assert.ok(bothOpenOn(3));
});

test('an answer to the first attempt arrives after the second replaced it (lateAnswerTest)', () => {
  const { lo, hi, offer, answer, notice } = inMatch();
  notice(lo);
  offer(hi, 2, 'reconnect');
  lo.fire('attemptAfter');
  assert.deepEqual(lo.issued(), [
    { type: 'offer', attempt: 2, mode: 'reconnect' },
    { type: 'offer', attempt: 3, mode: 'reconnect' },
  ]);
  answer(lo, 2);
  // staleSignalsAreNotApplied.
  assert.deepEqual(lo.issued(), [{ type: 'ignore', signal: 'answer', attempt: 2, reason: 'stale' }]);
  assert.equal(lo.context().awaitingAnswer, true);
  assert.equal(lo.context().connection, 3);
});

test('a roster that lists the player again under a new id keeps the open connection (hostRejoinsFirstTest)', () => {
  const { lo, hi } = inMatch();
  for (const p of [lo, hi]) {
    p.send({ type: 'roster' });
    // neverEvictsLiveConnection.
    assert.equal(p.state(), 'open');
    assert.equal(p.context().connection, 1);
    assert.deepEqual(p.issued(), []);
  }
});

// ── the orderings behind the properties ──────────────────────────────────

test('oneInitiatorPerPair: when both pages could offer, only the lower slot does', () => {
  // The roster, in either order.
  for (const order of [
    ['lo', 'hi'],
    ['hi', 'lo'],
  ] as const) {
    const p = pair();
    for (const who of order) p[who].send({ type: 'roster' });
    assert.deepEqual(
      p.lo.issued().map((c) => c.type),
      ['offer'],
    );
    assert.deepEqual(p.hi.issued(), []);
  }
  // A drop both notice, and every deadline that follows on both pages.
  const { lo, hi, notice, oneInitiator } = inMatch();
  notice(lo);
  notice(hi);
  for (let i = 0; i < 40; i += 1) {
    lo.advance(5000);
    hi.advance(5000);
    assert.ok(oneInitiator());
    assert.deepEqual(
      hi.issued().filter((c) => c.type === 'offer'),
      [],
    );
  }
  // The lower slot went on: three reconnect attempts, then the health check's offers.
  assert.equal(lo.state(), 'healing');
  assert.ok(lo.context().offers > 4);
});

test('everyWaitHasADeadline: an answerer whose offer never completes is closed, then given up on', () => {
  const { hi, lo, offer, notice } = inMatch();
  notice(lo);
  offer(hi, 2, 'reconnect');
  hi.issued();
  hi.advance(PEER_TIMING.answerAfterMs);
  // The answer deadline only closes the connection; the entry waits for another offer.
  assert.equal(hi.state(), 'reconnecting.awaitingOffer');
  assert.deepEqual(hi.issued(), [{ type: 'close' }]);
  assert.deepEqual(hi.armed(), ['giveUpAfter']);
  // The give-up was armed when the offer was answered and has kept running.
  hi.advance(PEER_TIMING.giveUpAfterMs - PEER_TIMING.answerAfterMs - 1);
  assert.equal(hi.state(), 'reconnecting.awaitingOffer');
  hi.advance(1);
  assert.equal(hi.state(), 'absent');
  assert.deepEqual(hi.issued(), [{ type: 'drop', reason: 'gaveUp' }]);
});

test('everyWaitHasADeadline: the give-up is not restarted by a later offer', () => {
  const { hi, offer, notice } = inMatch();
  notice(hi);
  hi.advance(40_000);
  offer(hi, 2, 'reconnect');
  assert.equal(hi.state(), 'reconnecting.answering');
  hi.advance(4999);
  assert.equal(hi.state(), 'reconnecting.answering');
  hi.advance(1);
  assert.equal(hi.state(), 'absent');
});

test('everyWaitHasADeadline: a startup retry answered in a match is closed, then treated as a drop', () => {
  const { hi, offer } = inMatch();
  // A startup retry delivered late: the connection is replaced, the entry is not reconnecting.
  offer(hi, 2, 'startup');
  assert.equal(hi.state(), 'answering');
  assert.deepEqual(hi.armed(), ['answerAfter', 'healAfter']);
  // The health check comes first (5 s): the higher slot treats it as a drop.
  hi.advance(PEER_TIMING.healAfterMs);
  assert.equal(hi.state(), 'reconnecting.answering');
  assert.deepEqual(hi.armed(), ['answerAfter', 'giveUpAfter']);
});

test('everyWaitHasADeadline: the lower slot gives a reconnect three attempts, then drops the player', () => {
  const { lo, notice } = inMatch();
  notice(lo);
  lo.advance(PEER_TIMING.attemptAfterMs * 2);
  assert.equal(lo.state(), 'reconnecting.offering');
  assert.equal(lo.context().tries, 3);
  lo.advance(PEER_TIMING.attemptAfterMs);
  assert.equal(lo.state(), 'absent');
  assert.deepEqual(lo.issued().at(-1), { type: 'drop', reason: 'attemptsExhausted' });
});

/**
 * Every state either page can get into, by any order of the events and
 * deadlines below. Attempt ids and counters are left out of what makes two
 * states the same, so the walk ends.
 */
const reachable = (mySlot: number, theirSlot: number) => {
  const input = { mySlot, theirSlot, timing: PEER_TIMING };
  type Snapshot = ReturnType<typeof initialTransition<typeof peerConnectionMachine>>[0];
  const key = (s: Snapshot): string => {
    const { running, listed, connection, awaitingAnswer, mine, tries, answerDeadline } = s.context;
    return JSON.stringify([s.value, running, listed, connection !== 0, awaitingAnswer, mine, tries, answerDeadline]);
  };
  const afters = (s: Snapshot): After[] => {
    const name = peerStateName(s.value);
    const delays: Record<PeerState, Deadline[]> = {
      absent: ['healAfter'],
      awaitingOffer: ['healAfter'],
      offering: ['startupAfter', 'healAfter'],
      stalled: ['healAfter'],
      answering: ['answerAfter', 'healAfter'],
      healing: ['healAfter'],
      open: [],
      'reconnecting.awaitingOffer': [],
      'reconnecting.offering': ['attemptAfter'],
      'reconnecting.answering': ['answerAfter'],
    };
    const own = delays[name].map((delay) => ({ type: 'xstate.after' as const, delay, stateId: `peer.${name}` }));
    return name.startsWith('reconnecting.')
      ? [...own, { type: 'xstate.after', delay: 'giveUpAfter', stateId: 'peer.reconnecting' }]
      : own;
  };
  const events = (s: Snapshot): PeerEvent[] => {
    const attempt = s.context.connection;
    const offers = (['first', 'startup', 'reconnect'] as const).flatMap((mode) =>
      [false, true].map((underEarlierId) => ({ type: 'offer' as const, attempt: 90, mode, underEarlierId })),
    );
    return [
      { type: 'roster' },
      { type: 'left' },
      { type: 'matchStarted' },
      { type: 'matchEnded' },
      ...offers,
      ...[attempt, 77].flatMap((id): PeerEvent[] => [
        { type: 'answer', attempt: id },
        { type: 'candidate', attempt: id },
        { type: 'opened', attempt: id },
        { type: 'lost', attempt: id },
      ]),
    ];
  };
  const [first] = initialTransition(peerConnectionMachine, input);
  const seen = new Map([[key(first), first]]);
  const queue = [first];
  for (let from = queue.shift(); from; from = queue.shift()) {
    const all = [...events(from), ...afters(from).map(raised)];
    for (const event of all) {
      const [to] = transition(peerConnectionMachine, from, event);
      if (seen.has(key(to))) continue;
      seen.set(key(to), to);
      queue.push(to);
    }
  }
  return { snapshots: [...seen.values()], afters };
};

test('everyWaitHasADeadline: in a match, every reachable state with no open channel has a deadline that acts', () => {
  for (const [mySlot, theirSlot] of [
    [0, 1],
    [1, 0],
  ] as const) {
    const { snapshots, afters } = reachable(mySlot, theirSlot);
    const names = new Set(snapshots.map((s) => peerStateName(s.value)));
    // The walk got everywhere this page can be. Only a page that offers can be
    // `offering`, `stalled` or `healing`, and in a pair that is the lower slot.
    const answerer = [
      'absent',
      'answering',
      'awaitingOffer',
      'open',
      'reconnecting.answering',
      'reconnecting.awaitingOffer',
    ];
    const offerer = ['healing', 'offering', 'reconnecting.offering', 'stalled'];
    assert.deepEqual([...names].sort(), mySlot < theirSlot ? [...answerer, ...offerer].sort() : answerer);
    for (const snapshot of snapshots) {
      const name = peerStateName(snapshot.value);
      const facts = peerFacts(name);
      if (!snapshot.context.running || !facts.entry || facts.open) continue;
      const acting = afters(snapshot).filter((after) => {
        const [to, effects] = transition(peerConnectionMachine, snapshot, raised(after));
        return peerStateName(to.value) !== name || effects.some((e) => e.type === 'issue');
      });
      assert.ok(acting.length > 0, `${name} has no deadline: ${JSON.stringify(snapshot.context)}`);
      // The answer deadline alone does not count: it only closes the connection.
      assert.ok(
        acting.some((after) => after.delay !== 'answerAfter'),
        `${name} has only the answer deadline`,
      );
    }
  }
});

test('oneInitiatorPerPair: no reachable state has the higher slot offering in a match', () => {
  const { snapshots } = reachable(1, 0);
  for (const snapshot of snapshots) {
    if (!snapshot.context.running) continue;
    assert.equal(snapshot.context.awaitingAnswer, false, peerStateName(snapshot.value));
  }
});

test('staleSignalsAreNotApplied: an answer, candidate or channel event for another attempt changes nothing', () => {
  const { lo, hi, offer, notice } = inMatch();
  notice(lo);
  lo.fire('attemptAfter');
  lo.issued();
  const before = lo.context();
  for (const signal of ['answer', 'candidate', 'opened', 'lost'] as const) {
    lo.send({ type: signal, attempt: 2 });
    assert.deepEqual(lo.issued(), [{ type: 'ignore', signal, attempt: 2, reason: 'stale' }]);
  }
  assert.equal(lo.state(), 'reconnecting.offering');
  assert.deepEqual(lo.context(), before);
  // A channel cannot be open on an offer that has no answer yet.
  lo.send({ type: 'opened', attempt: 3 });
  assert.equal(lo.state(), 'reconnecting.offering');
  assert.deepEqual(lo.issued(), [{ type: 'ignore', signal: 'opened', attempt: 3, reason: 'stale' }]);
  // The ones for the entry's connection are applied.
  lo.send({ type: 'candidate', attempt: 3 });
  lo.send({ type: 'answer', attempt: 3 });
  assert.deepEqual(lo.issued(), [
    { type: 'applyCandidate', attempt: 3 },
    { type: 'applyAnswer', attempt: 3 },
  ]);
  // With no entry there is nothing to apply a signal to.
  notice(hi);
  hi.fire('giveUpAfter');
  hi.issued();
  hi.send({ type: 'answer', attempt: 1 });
  assert.deepEqual(hi.issued(), [{ type: 'ignore', signal: 'answer', attempt: 1, reason: 'noEntry' }]);
  offer(hi, 3, 'reconnect');
  assert.equal(hi.state(), 'reconnecting.answering');
});

test('neverEvictsLiveConnection: no roster update, in the lobby or in a match, issues anything while the channel is open', () => {
  const { lo, hi, offer, answer, opens } = pair();
  lo.send({ type: 'roster' });
  hi.send({ type: 'roster' });
  offer(hi, 1, 'first');
  answer(lo, 1);
  opens(lo);
  opens(hi);
  lo.issued();
  hi.issued();
  for (const started of [false, true]) {
    if (started) for (const p of [lo, hi]) p.send({ type: 'matchStarted' });
    for (const p of [lo, hi]) {
      p.send({ type: 'roster' });
      assert.equal(p.state(), 'open');
      assert.deepEqual(p.issued(), []);
      assert.deepEqual(p.armed(), []);
    }
  }
});

// ── outside the model ────────────────────────────────────────────────────

test('a player who leaves is dropped from any state, and a roster starts over', () => {
  const { lo, notice } = inMatch();
  notice(lo);
  lo.issued();
  lo.send({ type: 'left' });
  assert.equal(lo.state(), 'absent');
  assert.deepEqual(lo.issued(), [{ type: 'drop', reason: 'left' }]);
  // Nobody is listed, so the health check has nobody to offer to.
  lo.advance(60_000);
  assert.deepEqual(lo.issued(), []);
  // Listed again in a match: no roster offer; the lower slot's health check makes it.
  lo.send({ type: 'roster' });
  assert.equal(lo.state(), 'absent');
  lo.advance(PEER_TIMING.healAfterMs);
  assert.equal(lo.state(), 'healing');
  assert.deepEqual(lo.issued(), [{ type: 'offer', attempt: 3, mode: 'reconnect' }]);
});

test('a connection lost before the match: the page that offered offers again, the other drops its entry', () => {
  const { lo, hi, offer, answer, opens, notice } = pair();
  lo.send({ type: 'roster' });
  hi.send({ type: 'roster' });
  offer(hi, 1, 'first');
  answer(lo, 1);
  opens(lo);
  opens(hi);
  lo.issued();
  hi.issued();
  notice(lo);
  assert.equal(lo.state(), 'offering');
  assert.deepEqual(lo.issued(), [{ type: 'offer', attempt: 2, mode: 'startup' }]);
  notice(hi);
  assert.equal(hi.state(), 'absent');
  assert.deepEqual(hi.issued(), [{ type: 'drop', reason: 'lostBeforeStart' }]);
  // The retry makes the entry again, on demand.
  offer(hi, 2, 'startup');
  assert.equal(hi.state(), 'answering');
});

test('an offer from a new page of a player whose connection was kept replaces the leftover', () => {
  const { hi } = inMatch();
  hi.send({ type: 'offer', attempt: 1, mode: 'first', underEarlierId: true });
  assert.equal(hi.state(), 'answering');
  assert.deepEqual(hi.issued(), [
    { type: 'drop', reason: 'replaced' },
    { type: 'answer', attempt: 1, connection: 'new' },
  ]);
});

test('the end of the match drops an entry with no open channel and keeps an open one', () => {
  const { lo, hi, notice } = inMatch();
  hi.send({ type: 'matchEnded' });
  assert.equal(hi.state(), 'open');
  assert.deepEqual(hi.issued(), []);
  notice(lo);
  lo.issued();
  lo.send({ type: 'matchEnded' });
  assert.equal(lo.state(), 'absent');
  assert.deepEqual(lo.issued(), [{ type: 'drop', reason: 'matchEnded' }]);
  assert.equal(lo.context().running, false);
});

test('what the engine keeps as flags can be read from each state', () => {
  assert.deepEqual(peerFacts('absent'), { entry: false, open: false, reconnecting: false });
  assert.deepEqual(peerFacts('offering'), { entry: true, open: false, reconnecting: false });
  assert.deepEqual(peerFacts('open'), { entry: true, open: true, reconnecting: false });
  assert.deepEqual(peerFacts('reconnecting.answering'), { entry: true, open: false, reconnecting: true });
});

test('run as an actor, the deadlines fire on the real clock and the commands reach the host', async () => {
  const commands: PeerCommand[] = [];
  const timing = { ...PEER_TIMING, startupAfterMs: 15 };
  const peer = createPeerConnection({ mySlot: 0, theirSlot: 1, timing }, (command) => commands.push(command));
  assert.equal(peer.state(), 'absent');
  peer.send({ type: 'roster' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(peer.state(), 'stalled');
  assert.deepEqual(commands, [
    { type: 'offer', attempt: 1, mode: 'first' },
    { type: 'offer', attempt: 2, mode: 'startup' },
    { type: 'offer', attempt: 3, mode: 'startup' },
    { type: 'stalled' },
  ]);
  await peer.stop();
});
