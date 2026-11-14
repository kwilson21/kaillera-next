/**
 * The WebRTC connection to one other player, as this page sees it, as a state
 * machine. It is one side of specs/peer_connection.qnt, built to the variant
 * `peer_connection_fixed`: one initiator per pair, a deadline on every wait
 * in a match, signals that carry the id of the attempt they belong to, and a
 * live connection that a roster update never replaces. The scenario tests in
 * tests/ts/peer-connection.test.ts replay that model's runs against it.
 *
 * Nothing uses it yet. The engine (web/static/netplay-rollback.js) keeps its
 * own flags and timers; this machine is to run beside it, observing, before
 * it decides anything. It makes no WebRTC call: what it wants done it issues
 * as a `PeerCommand`, to be compared with what the engine does.
 *
 * The states, and the model's `Side` each one stands for:
 *
 *   absent                       has = false
 *   awaitingOffer                has, no connection offered or answered
 *   offering                     made != 0 (or, once answered, link = that
 *                                offer), attempt = `tries` >= 1, not recon:
 *                                the roster's offer or a startup retry
 *   stalled                      the same after the last startup retry ran
 *                                out: attempt = 0, the model's `stalled`
 *   answering                    link != 0 from their offer, not open, not
 *                                recon; ansTimer = `answerDeadline`
 *   healing                      made != 0 (or link), attempt = 0, not recon:
 *                                the offer the mesh health check made
 *   open                         open
 *   reconnecting                 recon and giveUp, which the fixed rules
 *                                always arm together
 *     reconnecting.awaitingOffer   no connection (the higher slot after a drop)
 *     reconnecting.offering        made != 0 (or link), attempt = `tries` >= 1
 *     reconnecting.answering       link != 0 from their offer, ansTimer
 *
 * `made` and `link` are `connection` here, the attempt id of the entry's
 * connection, with `awaitingAnswer` (made) and `mine` (this page offered).
 * `chan`, `closePending` and `dirty` are not kept: the engine reports the
 * attempt a channel event belongs to, so the close of a replaced channel is
 * seen to be stale and ignored (the model's `closeNeverComes`), and `dirty`
 * is the `reset` command, issued where the model clears it.
 *
 * The model's deadlines are delayed transitions, their durations given as
 * input (`PeerTiming`):
 *   startupTimeout   `startupAfterMs` in `offering`, before the match
 *   attemptTimeout   `attemptAfterMs` in `reconnecting.offering`
 *   giveUpTimeout    `giveUpAfterMs` in `reconnecting`, across its states
 *   answerTimeout    `answerAfterMs` in the two `answering` states
 *   heal             `healAfterMs` in every state with no open channel that
 *                    is not `reconnecting`, in a match. The lower slot
 *                    offers from it; the higher slot treats it as a drop
 *                    (HEAL_ONE_SIDE)
 * The model's `notice` and `silentClose` are one event, `lost`: however the
 * page finds out, it has noticed.
 *
 * The decisions are the proved ones in peer-signaling.ts: who offers
 * (`shouldInitiate`), what a signal does to the entry (`signalDisposition`),
 * what a lost connection leads to (`disconnectDisposition`) and whether to
 * try again (`hasAttemptLeft`).
 *
 * Not covered, as in the model: spectators, late joiners and players held as
 * late joiners (the machine asks `shouldInitiate` as a player of the starting
 * cohort), more than one other player (there is one machine per player), the
 * pause between reconnect attempts, and PEER-PHANTOM.
 */
import { Context, Effect, Exit, Schema, Scope } from 'effect';
import { createEffectActor, setupEffect } from '@xstate/effect';
import { disconnectDisposition, hasAttemptLeft, shouldInitiate, signalDisposition } from './peer-signaling.ts';

export type PeerState =
  | 'absent'
  | 'awaitingOffer'
  | 'offering'
  | 'stalled'
  | 'answering'
  | 'healing'
  | 'open'
  | 'reconnecting.awaitingOffer'
  | 'reconnecting.offering'
  | 'reconnecting.answering';

/** The machine's state value: `reconnecting` has states of its own. */
export type PeerStateValue =
  | Exclude<PeerState, `reconnecting.${string}`>
  | { readonly reconnecting: 'awaitingOffer' | 'offering' | 'answering' };

export const peerStateName = (value: PeerStateValue): PeerState =>
  typeof value === 'string' ? value : `reconnecting.${value.reconnecting}`;

/**
 * What the engine keeps as flags today, read from a state: `_peers[sid]`
 * exists, its lockstep channel is open, `peer.reconnecting`.
 */
export const peerFacts = (state: PeerState) => ({
  entry: state !== 'absent',
  open: state === 'open',
  reconnecting: state.startsWith('reconnecting.'),
});

/** What an offer says about itself (`mode` in the model). */
const OfferMode = Schema.Literals(['first', 'startup', 'reconnect']);
export type OfferMode = typeof OfferMode.Type;

const Attempt = Schema.Struct({ attempt: Schema.Number });

/**
 * What the machine wants done. It does none of it.
 *   offer            replace this player's connection with a new one and send
 *                    its offer, numbered `attempt`
 *   answer           answer their offer `attempt`, on a new connection or on
 *                    the one the entry has (`kept`)
 *   applyAnswer      hand their answer to the connection that made the offer
 *   applyCandidate   hand an ICE candidate to the connection it is for
 *   ignore           a signal or channel event that is not for the entry's
 *                    connection: do not apply it
 *   close            the answer deadline passed: close the connection
 *   reset            resetPeerState: clear per-peer state from before a drop
 *   drop             hardDisconnectPeer: the entry is gone
 *   stalled          the startup retries ran out: tell the player
 */
export const PeerCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal('offer'), attempt: Schema.Number, mode: OfferMode }),
  Schema.Struct({
    type: Schema.Literal('answer'),
    attempt: Schema.Number,
    connection: Schema.Literals(['new', 'kept']),
  }),
  Schema.Struct({ type: Schema.Literal('applyAnswer'), attempt: Schema.Number }),
  Schema.Struct({ type: Schema.Literal('applyCandidate'), attempt: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal('ignore'),
    signal: Schema.Literals(['answer', 'candidate', 'opened', 'lost']),
    attempt: Schema.Number,
    reason: Schema.Literals(['stale', 'noEntry']),
  }),
  Schema.Struct({ type: Schema.Literal('close') }),
  Schema.Struct({ type: Schema.Literal('reset'), reason: Schema.Literals(['reconnect', 'heal']) }),
  Schema.Struct({
    type: Schema.Literal('drop'),
    reason: Schema.Literals(['gaveUp', 'attemptsExhausted', 'left', 'matchEnded', 'replaced', 'lostBeforeStart']),
  }),
  Schema.Struct({ type: Schema.Literal('stalled') }),
]);
export type PeerCommand = typeof PeerCommand.Type;

/** Where commands go. Provided by whoever runs the machine. */
export class PeerCommands extends Context.Service<
  PeerCommands,
  { readonly issue: (command: PeerCommand) => Effect.Effect<void> }
>()('kn/PeerCommands') {}

const PeerTiming = Schema.Struct({
  /** No open channel this long after an offer made before the match: offer again. */
  startupAfterMs: Schema.Number,
  /** The same for one reconnect attempt. */
  attemptAfterMs: Schema.Number,
  /** Reconnecting this long: give the player up. */
  giveUpAfterMs: Schema.Number,
  /** No open channel this long after answering a replacement offer: close the connection. */
  answerAfterMs: Schema.Number,
  /** In a match, how long an entry with no open channel that is not reconnecting is left alone. */
  healAfterMs: Schema.Number,
  /** Offers per startup, and per reconnect. */
  maxAttempts: Schema.Number,
});
export type PeerTiming = typeof PeerTiming.Type;

/** The engine's numbers today (the mesh health check runs every 300 frames). */
export const PEER_TIMING: PeerTiming = {
  startupAfterMs: 8000,
  attemptAfterMs: 10_000,
  giveUpAfterMs: 45_000,
  answerAfterMs: 10_000,
  healAfterMs: 5000,
  maxAttempts: 3,
};

const PeerInput = Schema.Struct({ mySlot: Schema.Number, theirSlot: Schema.Number, timing: PeerTiming });
export type PeerInput = typeof PeerInput.Type;

const PeerContext = Schema.Struct({
  mySlot: Schema.Number,
  theirSlot: Schema.Number,
  timing: PeerTiming,
  /** This page is running the match. */
  running: Schema.Boolean,
  /** The roster lists the other player, or they have offered. */
  listed: Schema.Boolean,
  /** The attempt id of the entry's connection: the last offer made or taken. 0 = none. */
  connection: Schema.Number,
  /** That offer is this page's and has no answer yet (`made` in the model). */
  awaitingAnswer: Schema.Boolean,
  /** This page made the offer for the connection. */
  mine: Schema.Boolean,
  /** Which try the armed startup or reconnect deadline belongs to (`attempt` in the model). */
  tries: Schema.Number,
  /** Offers this page has made; the next one's attempt id is one more. */
  offers: Schema.Number,
  /** The answer deadline is armed (`ansTimer` in the model). */
  answerDeadline: Schema.Boolean,
});
type PeerContext = typeof PeerContext.Type;

type Target =
  | '#peer.absent'
  | '#peer.awaitingOffer'
  | '#peer.offering'
  | '#peer.stalled'
  | '#peer.answering'
  | '#peer.healing'
  | '#peer.open'
  | '#peer.reconnecting.awaitingOffer'
  | '#peer.reconnecting.offering'
  | '#peer.reconnecting.answering';

/** One transition: what to issue and where to go. No `target` stays put; `reenter` restarts the state's deadlines. */
interface Step {
  readonly commands: readonly PeerCommand[];
  readonly context: PeerContext;
  readonly target?: Target;
  readonly reenter?: boolean;
}

/** Which kind of state an event found the machine in. */
type Place = 'absent' | 'waiting' | 'answering' | 'open' | 'reconnecting' | 'reconnectingAnswering';

const stay = (context: PeerContext, ...commands: PeerCommand[]): Step => ({ commands, context });

/** The pair's one initiator in a match: the lower slot, `lo` in the model. */
const lowerSlot = (context: PeerContext): boolean =>
  shouldInitiate(false, false, false, false, context.mySlot, context.theirSlot);

/** The signal or channel event of attempt `attempt` is for the connection the entry has. */
const isFor = (context: PeerContext, attempt: number): boolean =>
  context.connection !== 0 && context.connection === attempt;

const withoutConnection = (context: PeerContext): PeerContext => ({
  ...context,
  connection: 0,
  awaitingAnswer: false,
  mine: false,
  tries: 0,
  answerDeadline: false,
});

/** A new connection and its offer. */
const offerStep = (
  context: PeerContext,
  mode: OfferMode,
  tries: number,
  target: Target,
  before: PeerCommand[],
): Step => {
  const attempt = context.offers + 1;
  return {
    commands: [...before, { type: 'offer', attempt, mode }],
    context: {
      ...context,
      offers: attempt,
      connection: attempt,
      awaitingAnswer: true,
      mine: true,
      tries,
      answerDeadline: false,
    },
    target,
    reenter: true,
  };
};

const dropStep = (context: PeerContext, reason: Extract<PeerCommand, { type: 'drop' }>['reason']): Step => ({
  commands: [{ type: 'drop', reason }],
  context: withoutConnection(context),
  target: '#peer.absent',
  reenter: true,
});

/** `roster` in the model: the roster lists the other player and this page has no entry. */
const onRoster = (context: PeerContext): Step => {
  const listed = { ...context, listed: true };
  if (shouldInitiate(false, false, context.running, false, context.mySlot, context.theirSlot)) {
    return offerStep(listed, 'first', 1, '#peer.offering', []);
  }
  // In a match nobody offers from the roster: the lower slot's health check does.
  return {
    commands: [],
    context: listed,
    target: context.running ? '#peer.absent' : '#peer.awaitingOffer',
    reenter: true,
  };
};

/** `receiveOffer` in the model. */
const onOffer = (
  place: Place,
  context: PeerContext,
  event: { readonly attempt: number; readonly mode: OfferMode; readonly underEarlierId: boolean },
): Step => {
  const disposition = signalDisposition(true, event.mode !== 'first', event.underEarlierId, place !== 'absent');
  // `apply`: the offer goes to the connection the entry already has.
  const kept = disposition === 'apply';
  const commands: PeerCommand[] = [
    ...(disposition === 'replaceKept' ? [{ type: 'drop', reason: 'replaced' } as const] : []),
    { type: 'answer', attempt: event.attempt, connection: kept ? 'kept' : 'new' },
  ];
  const taken = { ...context, listed: true, connection: event.attempt, awaitingAnswer: false, mine: false };
  // A late roster offer leaves an open channel open, on a connection that
  // now matches nothing, until the page notices (lateFirstOfferTest).
  if (kept && place === 'open') return { commands, context: taken };
  const reconnecting = place === 'reconnecting' || place === 'reconnectingAnswering';
  const wasAnswering = place === 'answering' || place === 'reconnectingAnswering';
  if (!context.running) {
    return { commands, context: { ...taken, answerDeadline: false }, target: '#peer.answering', reenter: true };
  }
  if (event.mode === 'first') {
    // Applied to the entry as it is: it arms nothing, and stops nothing armed.
    return {
      commands,
      context: { ...taken, answerDeadline: wasAnswering && context.answerDeadline },
      target: reconnecting ? '#peer.reconnecting.answering' : '#peer.answering',
      reenter: !wasAnswering,
    };
  }
  return {
    commands,
    context: { ...taken, answerDeadline: true },
    target: reconnecting || event.mode === 'reconnect' ? '#peer.reconnecting.answering' : '#peer.answering',
    reenter: true,
  };
};

/** `receiveAnswer` in the model, with SIGNALS_CARRY_ATTEMPT: only the offer it answers takes it. */
const onAnswer = (place: Place, context: PeerContext, attempt: number): Step => {
  if (signalDisposition(false, false, false, place !== 'absent') === 'drop') {
    return stay(context, { type: 'ignore', signal: 'answer', attempt, reason: 'noEntry' });
  }
  if (!context.awaitingAnswer || !isFor(context, attempt)) {
    return stay(context, { type: 'ignore', signal: 'answer', attempt, reason: 'stale' });
  }
  return stay({ ...context, awaitingAnswer: false }, { type: 'applyAnswer', attempt });
};

const onCandidate = (place: Place, context: PeerContext, attempt: number): Step => {
  if (signalDisposition(false, false, false, place !== 'absent') === 'drop') {
    return stay(context, { type: 'ignore', signal: 'candidate', attempt, reason: 'noEntry' });
  }
  if (!isFor(context, attempt)) return stay(context, { type: 'ignore', signal: 'candidate', attempt, reason: 'stale' });
  return stay(context, { type: 'applyCandidate', attempt });
};

/** `channelOpens` in the model: the channel of the entry's connection, once offer and answer are done. */
const onOpened = (place: Place, context: PeerContext, attempt: number): Step => {
  if (place === 'absent') return stay(context, { type: 'ignore', signal: 'opened', attempt, reason: 'noEntry' });
  if (!isFor(context, attempt) || context.awaitingAnswer) {
    return stay(context, { type: 'ignore', signal: 'opened', attempt, reason: 'stale' });
  }
  if (place === 'open') return stay(context);
  const reconnected = place === 'reconnecting' || place === 'reconnectingAnswering';
  return {
    // The guest clears its per-peer input state; the host keeps its own (I2).
    commands: reconnected && !lowerSlot(context) ? [{ type: 'reset', reason: 'reconnect' }] : [],
    context: { ...context, tries: 0, answerDeadline: false },
    target: '#peer.open',
  };
};

/**
 * `notice` in the model, and what the engine does with a connection lost
 * before the match (which the model leaves out). Outside `open` in a match
 * the state's own deadline is already armed, and it is left to that.
 */
const onLost = (place: Place, context: PeerContext, attempt: number): Step => {
  if (place === 'absent') return stay(context, { type: 'ignore', signal: 'lost', attempt, reason: 'noEntry' });
  if (!isFor(context, attempt)) return stay(context, { type: 'ignore', signal: 'lost', attempt, reason: 'stale' });
  if (place !== 'open' && context.running) return stay(context);
  const disposition = disconnectDisposition(!context.running, context.mine, false, false, context.running);
  if (disposition === 'retryStartup') {
    return place === 'open' ? offerStep(context, 'startup', 1, '#peer.offering', []) : onStartupDeadline(context);
  }
  if (disposition !== 'reconnect') return dropStep(context, 'lostBeforeStart');
  if (lowerSlot(context)) return offerStep(context, 'reconnect', 1, '#peer.reconnecting.offering', []);
  return { commands: [], context: withoutConnection(context), target: '#peer.reconnecting.awaitingOffer' };
};

/** `startupTimeout` in the model. */
const onStartupDeadline = (context: PeerContext): Step => {
  if (context.tries < 1) return stay(context);
  if (hasAttemptLeft(context.tries, context.timing.maxAttempts)) {
    return offerStep(context, 'startup', context.tries + 1, '#peer.offering', []);
  }
  return { commands: [{ type: 'stalled' }], context: { ...context, tries: 0 }, target: '#peer.stalled' };
};

/** `attemptTimeout` in the model. */
const onAttemptDeadline = (context: PeerContext): Step =>
  hasAttemptLeft(context.tries, context.timing.maxAttempts)
    ? offerStep(context, 'reconnect', context.tries + 1, '#peer.reconnecting.offering', [])
    : dropStep(context, 'attemptsExhausted');

/** `answerTimeout` in the model: close the connection; the entry waits for another offer. */
const onAnswerDeadline = (context: PeerContext, target: Target): Step => ({
  commands: [{ type: 'close' }],
  context: withoutConnection(context),
  target,
});

/**
 * `heal` in the model with HEAL_ONE_SIDE: the lower slot resets whatever
 * entry it has and offers; the higher slot treats its entry as a drop it has
 * just noticed and waits for that offer, with the give-up armed.
 */
const onHealDeadline = (place: Place, context: PeerContext): Step => {
  if (lowerSlot(context)) {
    return offerStep(
      context,
      'reconnect',
      0,
      '#peer.healing',
      place === 'absent' ? [] : [{ type: 'reset', reason: 'heal' }],
    );
  }
  if (place === 'answering') return { commands: [], context, target: '#peer.reconnecting.answering' };
  return {
    // An offer of this page's own goes with its connection: the lower slot's is the one to answer.
    commands: context.connection === 0 ? [] : [{ type: 'close' }],
    context: withoutConnection(context),
    target: '#peer.reconnecting.awaitingOffer',
  };
};

/** Issues a step's commands and gives XState the rest of it. */
const run = <Action, Self>(
  step: Step,
  action: Action,
  self: Self,
  enq: (action: Action, params: { command: PeerCommand; self: Self }) => void,
) => {
  for (const command of step.commands) enq(action, { command, self });
  // XState checks the targets it can read as literals against the states; these are ids, resolved when it runs.
  const target: string | undefined = step.target;
  const move = { context: step.context, reenter: step.reenter === true };
  return target === undefined ? move : { ...move, target };
};

const Empty = Schema.Struct({});

export const peerConnectionMachine = setupEffect({
  schemas: {
    context: PeerContext,
    input: PeerInput,
    events: {
      /** The roster lists the other player (under whatever socket id: #119). */
      roster: Empty,
      /** The other player left the room, or said they were leaving. */
      left: Empty,
      /** This page started running the match. */
      matchStarted: Empty,
      /** The match is over on this page. */
      matchEnded: Empty,
      /** Their offer arrived. */
      offer: Schema.Struct({
        attempt: Schema.Number,
        mode: OfferMode,
        /** The sender's connection is filed under an earlier socket id of theirs (`signalDisposition`). */
        underEarlierId: Schema.Boolean,
      }),
      /** Their answer arrived; `attempt` is the offer it answers. */
      answer: Attempt,
      /** An ICE candidate arrived for the connection of offer `attempt`. */
      candidate: Attempt,
      /** The lockstep channel of the connection of offer `attempt` opened. */
      opened: Attempt,
      /**
       * That connection is gone and the page has found out: its channel
       * closed, the connection failed or stayed disconnected past its
       * grace, or the health check found the channel no longer open.
       */
      lost: Attempt,
    },
    actions: {
      issue: { params: Schema.Struct({ command: PeerCommand }) },
    },
  },
  actions: {
    issue: ({ command }) => PeerCommands.use((commands) => commands.issue(command)),
  },
  delays: {
    startupAfter: ({ context }) => context.timing.startupAfterMs,
    attemptAfter: ({ context }) => context.timing.attemptAfterMs,
    giveUpAfter: ({ context }) => context.timing.giveUpAfterMs,
    answerAfter: ({ context }) => context.timing.answerAfterMs,
    healAfter: ({ context }) => context.timing.healAfterMs,
  },
}).createMachine({
  id: 'peer',
  context: ({ input }) => ({
    mySlot: input.mySlot,
    theirSlot: input.theirSlot,
    timing: input.timing,
    running: false,
    listed: false,
    connection: 0,
    awaitingAnswer: false,
    mine: false,
    tries: 0,
    offers: 0,
    answerDeadline: false,
  }),
  initial: 'absent',
  on: {
    left: ({ context, actions, self }, enq) => {
      enq(actions.issue, { command: { type: 'drop', reason: 'left' }, self });
      return { target: '.absent', context: { ...withoutConnection(context), listed: false } };
    },
    // An entry with no open channel does not outlive the match (not in the model).
    matchEnded: ({ context, actions, self }, enq) => {
      if (!context.running) return;
      enq(actions.issue, { command: { type: 'drop', reason: 'matchEnded' }, self });
      return { target: '.absent', context: { ...withoutConnection(context), running: false } };
    },
  },
  states: {
    absent: {
      after: {
        healAfter: ({ context, actions, self }, enq) => {
          if (!context.running || !context.listed || !lowerSlot(context)) return;
          return run(onHealDeadline('absent', context), actions.issue, self, enq);
        },
      },
      on: {
        left: ({ context }) => ({ context: { ...context, listed: false } }),
        matchStarted: ({ context }) => ({
          target: 'absent',
          reenter: true,
          context: { ...context, running: true },
        }),
        matchEnded: ({ context }) => ({ context: { ...context, running: false } }),
        roster: ({ context, actions, self }, enq) => run(onRoster(context), actions.issue, self, enq),
        offer: ({ context, event, actions, self }, enq) =>
          run(onOffer('absent', context, event), actions.issue, self, enq),
        answer: ({ context, event, actions, self }, enq) =>
          run(onAnswer('absent', context, event.attempt), actions.issue, self, enq),
        candidate: ({ context, event, actions, self }, enq) =>
          run(onCandidate('absent', context, event.attempt), actions.issue, self, enq),
        opened: ({ context, event, actions, self }, enq) =>
          run(onOpened('absent', context, event.attempt), actions.issue, self, enq),
        lost: ({ context, event, actions, self }, enq) =>
          run(onLost('absent', context, event.attempt), actions.issue, self, enq),
      },
    },
    awaitingOffer: {
      after: {
        healAfter: ({ context, actions, self }, enq) => {
          if (!context.running) return;
          return run(onHealDeadline('waiting', context), actions.issue, self, enq);
        },
      },
      on: {
        matchStarted: ({ context }) => ({
          target: 'awaitingOffer',
          reenter: true,
          context: { ...context, running: true },
        }),
        offer: ({ context, event, actions, self }, enq) =>
          run(onOffer('waiting', context, event), actions.issue, self, enq),
        answer: ({ context, event, actions, self }, enq) =>
          run(onAnswer('waiting', context, event.attempt), actions.issue, self, enq),
        candidate: ({ context, event, actions, self }, enq) =>
          run(onCandidate('waiting', context, event.attempt), actions.issue, self, enq),
        opened: ({ context, event, actions, self }, enq) =>
          run(onOpened('waiting', context, event.attempt), actions.issue, self, enq),
        lost: ({ context, event, actions, self }, enq) =>
          run(onLost('waiting', context, event.attempt), actions.issue, self, enq),
      },
    },
    offering: {
      after: {
        startupAfter: ({ context, actions, self }, enq) => {
          if (context.running) return;
          return run(onStartupDeadline(context), actions.issue, self, enq);
        },
        healAfter: ({ context, actions, self }, enq) => {
          if (!context.running) return;
          return run(onHealDeadline('waiting', context), actions.issue, self, enq);
        },
      },
      on: {
        matchStarted: ({ context }) => ({
          target: 'offering',
          reenter: true,
          context: { ...context, running: true },
        }),
        offer: ({ context, event, actions, self }, enq) =>
          run(onOffer('waiting', context, event), actions.issue, self, enq),
        answer: ({ context, event, actions, self }, enq) =>
          run(onAnswer('waiting', context, event.attempt), actions.issue, self, enq),
        candidate: ({ context, event, actions, self }, enq) =>
          run(onCandidate('waiting', context, event.attempt), actions.issue, self, enq),
        opened: ({ context, event, actions, self }, enq) =>
          run(onOpened('waiting', context, event.attempt), actions.issue, self, enq),
        lost: ({ context, event, actions, self }, enq) =>
          run(onLost('waiting', context, event.attempt), actions.issue, self, enq),
      },
    },
    // The player has been told. An answer to the last offer can still connect the pair.
    stalled: {
      after: {
        healAfter: ({ context, actions, self }, enq) => {
          if (!context.running) return;
          return run(onHealDeadline('waiting', context), actions.issue, self, enq);
        },
      },
      on: {
        matchStarted: ({ context }) => ({
          target: 'stalled',
          reenter: true,
          context: { ...context, running: true },
        }),
        offer: ({ context, event, actions, self }, enq) =>
          run(onOffer('waiting', context, event), actions.issue, self, enq),
        answer: ({ context, event, actions, self }, enq) =>
          run(onAnswer('waiting', context, event.attempt), actions.issue, self, enq),
        candidate: ({ context, event, actions, self }, enq) =>
          run(onCandidate('waiting', context, event.attempt), actions.issue, self, enq),
        opened: ({ context, event, actions, self }, enq) =>
          run(onOpened('waiting', context, event.attempt), actions.issue, self, enq),
        lost: ({ context, event, actions, self }, enq) =>
          run(onLost('waiting', context, event.attempt), actions.issue, self, enq),
      },
    },
    answering: {
      after: {
        answerAfter: ({ context, actions, self }, enq) => {
          if (!context.running || !context.answerDeadline) return;
          return run(onAnswerDeadline(context, '#peer.awaitingOffer'), actions.issue, self, enq);
        },
        healAfter: ({ context, actions, self }, enq) => {
          if (!context.running) return;
          return run(onHealDeadline('answering', context), actions.issue, self, enq);
        },
      },
      on: {
        matchStarted: ({ context }) => ({
          target: 'answering',
          reenter: true,
          context: { ...context, running: true },
        }),
        offer: ({ context, event, actions, self }, enq) =>
          run(onOffer('answering', context, event), actions.issue, self, enq),
        answer: ({ context, event, actions, self }, enq) =>
          run(onAnswer('answering', context, event.attempt), actions.issue, self, enq),
        candidate: ({ context, event, actions, self }, enq) =>
          run(onCandidate('answering', context, event.attempt), actions.issue, self, enq),
        opened: ({ context, event, actions, self }, enq) =>
          run(onOpened('answering', context, event.attempt), actions.issue, self, enq),
        lost: ({ context, event, actions, self }, enq) =>
          run(onLost('answering', context, event.attempt), actions.issue, self, enq),
      },
    },
    // Only in a match, only the lower slot: the health check's offer, made again each time it runs.
    healing: {
      after: {
        healAfter: ({ context, actions, self }, enq) =>
          run(onHealDeadline('waiting', context), actions.issue, self, enq),
      },
      on: {
        offer: ({ context, event, actions, self }, enq) =>
          run(onOffer('waiting', context, event), actions.issue, self, enq),
        answer: ({ context, event, actions, self }, enq) =>
          run(onAnswer('waiting', context, event.attempt), actions.issue, self, enq),
        candidate: ({ context, event, actions, self }, enq) =>
          run(onCandidate('waiting', context, event.attempt), actions.issue, self, enq),
        opened: ({ context, event, actions, self }, enq) =>
          run(onOpened('waiting', context, event.attempt), actions.issue, self, enq),
        lost: ({ context, event, actions, self }, enq) =>
          run(onLost('waiting', context, event.attempt), actions.issue, self, enq),
      },
    },
    // A roster update changes nothing here, whatever id it lists the player under (#119).
    open: {
      on: {
        matchStarted: ({ context }) => ({ context: { ...context, running: true } }),
        matchEnded: ({ context }) => ({ context: { ...context, running: false } }),
        offer: ({ context, event, actions, self }, enq) =>
          run(onOffer('open', context, event), actions.issue, self, enq),
        answer: ({ context, event, actions, self }, enq) =>
          run(onAnswer('open', context, event.attempt), actions.issue, self, enq),
        candidate: ({ context, event, actions, self }, enq) =>
          run(onCandidate('open', context, event.attempt), actions.issue, self, enq),
        opened: ({ context, event, actions, self }, enq) =>
          run(onOpened('open', context, event.attempt), actions.issue, self, enq),
        lost: ({ context, event, actions, self }, enq) =>
          run(onLost('open', context, event.attempt), actions.issue, self, enq),
      },
    },
    reconnecting: {
      initial: 'awaitingOffer',
      // The give-up runs across the states below: moving between them does not restart it.
      after: {
        giveUpAfter: ({ context, actions, self }, enq) => run(dropStep(context, 'gaveUp'), actions.issue, self, enq),
      },
      states: {
        awaitingOffer: {
          on: {
            offer: ({ context, event, actions, self }, enq) =>
              run(onOffer('reconnecting', context, event), actions.issue, self, enq),
            answer: ({ context, event, actions, self }, enq) =>
              run(onAnswer('reconnecting', context, event.attempt), actions.issue, self, enq),
            candidate: ({ context, event, actions, self }, enq) =>
              run(onCandidate('reconnecting', context, event.attempt), actions.issue, self, enq),
            opened: ({ context, event, actions, self }, enq) =>
              run(onOpened('reconnecting', context, event.attempt), actions.issue, self, enq),
            lost: ({ context, event, actions, self }, enq) =>
              run(onLost('reconnecting', context, event.attempt), actions.issue, self, enq),
          },
        },
        offering: {
          after: {
            attemptAfter: ({ context, actions, self }, enq) =>
              run(onAttemptDeadline(context), actions.issue, self, enq),
          },
          on: {
            offer: ({ context, event, actions, self }, enq) =>
              run(onOffer('reconnecting', context, event), actions.issue, self, enq),
            answer: ({ context, event, actions, self }, enq) =>
              run(onAnswer('reconnecting', context, event.attempt), actions.issue, self, enq),
            candidate: ({ context, event, actions, self }, enq) =>
              run(onCandidate('reconnecting', context, event.attempt), actions.issue, self, enq),
            opened: ({ context, event, actions, self }, enq) =>
              run(onOpened('reconnecting', context, event.attempt), actions.issue, self, enq),
            lost: ({ context, event, actions, self }, enq) =>
              run(onLost('reconnecting', context, event.attempt), actions.issue, self, enq),
          },
        },
        answering: {
          after: {
            answerAfter: ({ context, actions, self }, enq) => {
              if (!context.answerDeadline) return;
              return run(onAnswerDeadline(context, '#peer.reconnecting.awaitingOffer'), actions.issue, self, enq);
            },
          },
          on: {
            offer: ({ context, event, actions, self }, enq) =>
              run(onOffer('reconnectingAnswering', context, event), actions.issue, self, enq),
            answer: ({ context, event, actions, self }, enq) =>
              run(onAnswer('reconnectingAnswering', context, event.attempt), actions.issue, self, enq),
            candidate: ({ context, event, actions, self }, enq) =>
              run(onCandidate('reconnectingAnswering', context, event.attempt), actions.issue, self, enq),
            opened: ({ context, event, actions, self }, enq) =>
              run(onOpened('reconnectingAnswering', context, event.attempt), actions.issue, self, enq),
            lost: ({ context, event, actions, self }, enq) =>
              run(onLost('reconnectingAnswering', context, event.attempt), actions.issue, self, enq),
          },
        },
      },
    },
  },
});

/** The events the engine tells the machine. */
export type PeerEvent = Parameters<Awaited<ReturnType<typeof startActor>>['send']>[0];

const startActor = (input: PeerInput, onCommand: (command: PeerCommand) => void, scope: Scope.Scope) =>
  Effect.runPromise(
    createEffectActor(peerConnectionMachine, { input }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provideService(PeerCommands, { issue: (command) => Effect.sync(() => onCommand(command)) }),
    ),
  );

/**
 * Runs the machine for one other player. Its deadlines run on the actor's
 * clock and change the state, so the state is the actor's: an event sent now
 * shows in `state()` on a later tick. Events sent before the actor is up are
 * held for it and delivered in order.
 */
export const createPeerConnection = (input: PeerInput, onCommand: (command: PeerCommand) => void) => {
  const scope = Effect.runSync(Scope.make());
  const ready = startActor(input, onCommand, scope);
  let actor: Awaited<typeof ready> | undefined;
  const held: PeerEvent[] = [];
  void ready.then((started) => {
    actor = started;
    for (const event of held.splice(0)) started.send(event);
  });
  return {
    send: (event: PeerEvent): void => {
      if (actor) actor.send(event);
      else held.push(event);
    },
    state: (): PeerState => (actor ? peerStateName(actor.getSnapshot().value) : 'absent'),
    stop: (): Promise<void> => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};
