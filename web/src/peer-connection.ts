/**
 * The WebRTC connection to one other player, as this page sees it, as a state
 * machine. It is one side of specs/peer_connection.qnt, built to the variant
 * `peer_connection_fixed`: one initiator per pair, a deadline on every wait
 * in a match, signals that carry the id of the attempt they belong to (the
 * page that offered and that page's count), and a live connection that a
 * roster update never replaces. The scenario tests in
 * tests/ts/peer-connection.test.ts replay that model's runs against it.
 *
 * It decides nothing yet. The engine (web/static/netplay-rollback.js) keeps
 * its own flags and timers and runs one of these beside it for each other
 * player, observing (peer-observe.ts). It makes no WebRTC call: what it
 * wants done it issues as a `PeerCommand`, which the observer sets beside
 * what the engine does.
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
 * `made` and `link` are `connection` and `connectionPage` here, the attempt
 * id of the entry's connection, with `awaitingAnswer` (made) and `mine` (this
 * page offered). The id is the model's `Label` with ATTEMPT_NAMES_PAGE: the
 * count alone starts again at 1 on a page that replaces another, so a signal
 * or channel event of the old page's connection would pass for one of the new
 * page's (the model's `reload`, peer_connection_counter_only).
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
import { Context, Duration, Effect, Exit, Fiber, Option, Schema, Scope } from 'effect';
import { setupEffect } from '@xstate/effect';
import { initialTransition, transition, type EventFrom } from 'xstate';
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

/**
 * Which attempt a signal or channel event belongs to: the page that made the
 * offer (`PeerInput.page` there) and that page's count of its offers. Both
 * travel with every `webrtc-signal`: an offer says its own, an answer the
 * offer's it answers, a candidate the offer's of the connection it is from.
 */
const Attempt = Schema.Struct({ page: Schema.String, attempt: Schema.Number });
export type Attempt = typeof Attempt.Type;

/**
 * What the machine wants done. It does none of it.
 *   offer            replace this player's connection with a new one and send
 *                    its offer, as attempt `attempt` of this page (`page`)
 *   answer           answer their page's offer `attempt`, on a new connection
 *                    or on the one the entry has (`kept`)
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
  Schema.Struct({ type: Schema.Literal('offer'), ...Attempt.fields, mode: OfferMode }),
  Schema.Struct({
    type: Schema.Literal('answer'),
    ...Attempt.fields,
    connection: Schema.Literals(['new', 'kept']),
  }),
  Schema.Struct({ type: Schema.Literal('applyAnswer'), ...Attempt.fields }),
  Schema.Struct({ type: Schema.Literal('applyCandidate'), ...Attempt.fields }),
  Schema.Struct({
    type: Schema.Literal('ignore'),
    signal: Schema.Literals(['answer', 'candidate', 'opened', 'lost']),
    ...Attempt.fields,
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

const PeerInput = Schema.Struct({
  mySlot: Schema.Number,
  theirSlot: Schema.Number,
  timing: PeerTiming,
  /**
   * An id for this page that no other page has: random, made once when the
   * page loads. It names this machine's offers beside their count. The count
   * starts at 1 in every machine, so a second machine made for the same
   * player on the same page needs an id of its own.
   */
  page: Schema.String,
});
export type PeerInput = typeof PeerInput.Type;

const PeerContext = Schema.Struct({
  mySlot: Schema.Number,
  theirSlot: Schema.Number,
  timing: PeerTiming,
  /** This page's id (`PeerInput.page`). */
  page: Schema.String,
  /** This page is running the match. */
  running: Schema.Boolean,
  /** The roster lists the other player, or they have offered. */
  listed: Schema.Boolean,
  /** The attempt of the entry's connection: the last offer made or taken, as its page counted it. 0 = none. */
  connection: Schema.Number,
  /** The page that made that offer: this one or theirs. Empty with no connection. */
  connectionPage: Schema.String,
  /** That offer is this page's and has no answer yet (`made` in the model). */
  awaitingAnswer: Schema.Boolean,
  /** This page made the offer for the connection. */
  mine: Schema.Boolean,
  /** Which try the armed startup or reconnect deadline belongs to (`attempt` in the model). */
  tries: Schema.Number,
  /** Offers this machine has made; the next one's attempt is one more. */
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

/**
 * The signal or channel event of attempt `id` is for the connection the entry
 * has: the same count from the same page. The count alone is not enough: a
 * page that replaced another counts from 1 again.
 */
const isFor = (context: PeerContext, id: Attempt): boolean =>
  context.connection !== 0 && context.connection === id.attempt && context.connectionPage === id.page;

const withoutConnection = (context: PeerContext): PeerContext => ({
  ...context,
  connection: 0,
  connectionPage: '',
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
    commands: [...before, { type: 'offer', page: context.page, attempt, mode }],
    context: {
      ...context,
      offers: attempt,
      connection: attempt,
      connectionPage: context.page,
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
  event: Attempt & { readonly mode: OfferMode; readonly underEarlierId: boolean },
): Step => {
  const disposition = signalDisposition(true, event.mode !== 'first', event.underEarlierId, place !== 'absent');
  // `apply`: the offer goes to the connection the entry already has.
  const kept = disposition === 'apply';
  const commands: PeerCommand[] = [
    ...(disposition === 'replaceKept' ? [{ type: 'drop', reason: 'replaced' } as const] : []),
    { type: 'answer', page: event.page, attempt: event.attempt, connection: kept ? 'kept' : 'new' },
  ];
  const taken = {
    ...context,
    listed: true,
    connection: event.attempt,
    connectionPage: event.page,
    awaitingAnswer: false,
    mine: false,
  };
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
const onAnswer = (place: Place, context: PeerContext, { page, attempt }: Attempt): Step => {
  if (signalDisposition(false, false, false, place !== 'absent') === 'drop') {
    return stay(context, { type: 'ignore', signal: 'answer', page, attempt, reason: 'noEntry' });
  }
  if (!context.awaitingAnswer || !isFor(context, { page, attempt })) {
    return stay(context, { type: 'ignore', signal: 'answer', page, attempt, reason: 'stale' });
  }
  return stay({ ...context, awaitingAnswer: false }, { type: 'applyAnswer', page, attempt });
};

const onCandidate = (place: Place, context: PeerContext, { page, attempt }: Attempt): Step => {
  if (signalDisposition(false, false, false, place !== 'absent') === 'drop') {
    return stay(context, { type: 'ignore', signal: 'candidate', page, attempt, reason: 'noEntry' });
  }
  if (!isFor(context, { page, attempt }))
    return stay(context, { type: 'ignore', signal: 'candidate', page, attempt, reason: 'stale' });
  return stay(context, { type: 'applyCandidate', page, attempt });
};

/** `channelOpens` in the model: the channel of the entry's connection, once offer and answer are done. */
const onOpened = (place: Place, context: PeerContext, { page, attempt }: Attempt): Step => {
  if (place === 'absent') return stay(context, { type: 'ignore', signal: 'opened', page, attempt, reason: 'noEntry' });
  if (!isFor(context, { page, attempt }) || context.awaitingAnswer) {
    return stay(context, { type: 'ignore', signal: 'opened', page, attempt, reason: 'stale' });
  }
  if (place === 'open') return stay(context);
  const reconnected = place === 'reconnecting' || place === 'reconnectingAnswering';
  return {
    // Every page but the host clears its per-peer input state; the host keeps
    // its own (I2). This goes by the page's slot, not by which of the pair
    // offers: between two guests the lower slot offers and still resets, as
    // the engine does (`_playerSlot !== 0`). In the model's pair the lower
    // slot is the host, so the two rules agree there.
    commands: reconnected && context.mySlot !== 0 ? [{ type: 'reset', reason: 'reconnect' }] : [],
    context: { ...context, tries: 0, answerDeadline: false },
    target: '#peer.open',
  };
};

/**
 * `notice` in the model, and what the engine does with a connection lost
 * before the match (which the model leaves out). Outside `open` in a match
 * the state's own deadline is already armed, and it is left to that.
 */
const onLost = (place: Place, context: PeerContext, { page, attempt }: Attempt): Step => {
  if (place === 'absent') return stay(context, { type: 'ignore', signal: 'lost', page, attempt, reason: 'noEntry' });
  if (!isFor(context, { page, attempt }))
    return stay(context, { type: 'ignore', signal: 'lost', page, attempt, reason: 'stale' });
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
        /** Their page's id and its count for this offer. */
        ...Attempt.fields,
        mode: OfferMode,
        /** The sender's connection is filed under an earlier socket id of theirs (`signalDisposition`). */
        underEarlierId: Schema.Boolean,
      }),
      /** Their answer arrived; `page` and `attempt` are the offer it answers: this page's. */
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
    page: input.page,
    running: false,
    listed: false,
    connection: 0,
    connectionPage: '',
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
          run(onAnswer('absent', context, event), actions.issue, self, enq),
        candidate: ({ context, event, actions, self }, enq) =>
          run(onCandidate('absent', context, event), actions.issue, self, enq),
        opened: ({ context, event, actions, self }, enq) =>
          run(onOpened('absent', context, event), actions.issue, self, enq),
        lost: ({ context, event, actions, self }, enq) =>
          run(onLost('absent', context, event), actions.issue, self, enq),
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
          run(onAnswer('waiting', context, event), actions.issue, self, enq),
        candidate: ({ context, event, actions, self }, enq) =>
          run(onCandidate('waiting', context, event), actions.issue, self, enq),
        opened: ({ context, event, actions, self }, enq) =>
          run(onOpened('waiting', context, event), actions.issue, self, enq),
        lost: ({ context, event, actions, self }, enq) =>
          run(onLost('waiting', context, event), actions.issue, self, enq),
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
          run(onAnswer('waiting', context, event), actions.issue, self, enq),
        candidate: ({ context, event, actions, self }, enq) =>
          run(onCandidate('waiting', context, event), actions.issue, self, enq),
        opened: ({ context, event, actions, self }, enq) =>
          run(onOpened('waiting', context, event), actions.issue, self, enq),
        lost: ({ context, event, actions, self }, enq) =>
          run(onLost('waiting', context, event), actions.issue, self, enq),
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
          run(onAnswer('waiting', context, event), actions.issue, self, enq),
        candidate: ({ context, event, actions, self }, enq) =>
          run(onCandidate('waiting', context, event), actions.issue, self, enq),
        opened: ({ context, event, actions, self }, enq) =>
          run(onOpened('waiting', context, event), actions.issue, self, enq),
        lost: ({ context, event, actions, self }, enq) =>
          run(onLost('waiting', context, event), actions.issue, self, enq),
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
          run(onAnswer('answering', context, event), actions.issue, self, enq),
        candidate: ({ context, event, actions, self }, enq) =>
          run(onCandidate('answering', context, event), actions.issue, self, enq),
        opened: ({ context, event, actions, self }, enq) =>
          run(onOpened('answering', context, event), actions.issue, self, enq),
        lost: ({ context, event, actions, self }, enq) =>
          run(onLost('answering', context, event), actions.issue, self, enq),
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
          run(onAnswer('waiting', context, event), actions.issue, self, enq),
        candidate: ({ context, event, actions, self }, enq) =>
          run(onCandidate('waiting', context, event), actions.issue, self, enq),
        opened: ({ context, event, actions, self }, enq) =>
          run(onOpened('waiting', context, event), actions.issue, self, enq),
        lost: ({ context, event, actions, self }, enq) =>
          run(onLost('waiting', context, event), actions.issue, self, enq),
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
          run(onAnswer('open', context, event), actions.issue, self, enq),
        candidate: ({ context, event, actions, self }, enq) =>
          run(onCandidate('open', context, event), actions.issue, self, enq),
        opened: ({ context, event, actions, self }, enq) =>
          run(onOpened('open', context, event), actions.issue, self, enq),
        lost: ({ context, event, actions, self }, enq) => run(onLost('open', context, event), actions.issue, self, enq),
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
              run(onAnswer('reconnecting', context, event), actions.issue, self, enq),
            candidate: ({ context, event, actions, self }, enq) =>
              run(onCandidate('reconnecting', context, event), actions.issue, self, enq),
            opened: ({ context, event, actions, self }, enq) =>
              run(onOpened('reconnecting', context, event), actions.issue, self, enq),
            lost: ({ context, event, actions, self }, enq) =>
              run(onLost('reconnecting', context, event), actions.issue, self, enq),
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
              run(onAnswer('reconnecting', context, event), actions.issue, self, enq),
            candidate: ({ context, event, actions, self }, enq) =>
              run(onCandidate('reconnecting', context, event), actions.issue, self, enq),
            opened: ({ context, event, actions, self }, enq) =>
              run(onOpened('reconnecting', context, event), actions.issue, self, enq),
            lost: ({ context, event, actions, self }, enq) =>
              run(onLost('reconnecting', context, event), actions.issue, self, enq),
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
              run(onAnswer('reconnectingAnswering', context, event), actions.issue, self, enq),
            candidate: ({ context, event, actions, self }, enq) =>
              run(onCandidate('reconnectingAnswering', context, event), actions.issue, self, enq),
            opened: ({ context, event, actions, self }, enq) =>
              run(onOpened('reconnectingAnswering', context, event), actions.issue, self, enq),
            lost: ({ context, event, actions, self }, enq) =>
              run(onLost('reconnectingAnswering', context, event), actions.issue, self, enq),
          },
        },
      },
    },
  },
});

/** The events the engine tells the machine. */
export type PeerEvent = Exclude<EventFrom<typeof peerConnectionMachine>, { type: `xstate.${string}` }>;

/** The machine's deadlines, by the name of their delay. */
const PeerDeadline = Schema.Literals(['startupAfter', 'attemptAfter', 'giveUpAfter', 'answerAfter', 'healAfter']);
export type PeerDeadline = typeof PeerDeadline.Type;

/** A deadline as XState raises it for itself once its delay has passed. */
const After = Schema.Struct({ type: Schema.Literal('xstate.after'), delay: PeerDeadline, stateId: Schema.String });
type After = typeof After.Type;

/** What a transition asks of its host: issue a command, arm a deadline, disarm one. */
const decodeHostEffect = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal('issue'), args: Schema.Tuple([Schema.Struct({ command: PeerCommand })]) }),
    Schema.Struct({ type: Schema.Literal('@xstate.raise'), event: After, delay: Schema.Number }),
    Schema.Struct({ type: Schema.Literal('@xstate.cancel'), event: After }),
  ]),
);

// SAFETY: a deadline is an event XState raises for itself and takes like any other; only the
// type of what a host may send leaves it out.
const asEvent = (event: PeerEvent | After): PeerEvent => event as PeerEvent;

/**
 * Runs the machine for one other player. Each event is taken at once, with
 * XState's pure `transition`, and `send` returns the commands it issued, so a
 * caller can set them beside what it did itself with the same event. The
 * deadlines the machine arms run as Effect sleeps in this runner's scope;
 * when one passes, its commands go to `onDeadline`. `fire` takes an armed
 * deadline now, as if it had passed: an observer whose engine has its own
 * timer for the same wait keeps the two in step with it.
 */
export const createPeerConnection = (
  input: PeerInput,
  onDeadline: (deadline: PeerDeadline, commands: readonly PeerCommand[]) => void,
) => {
  const scope = Effect.runSync(Scope.make());
  const armed = new Map<string, { readonly event: After; readonly fiber: Fiber.Fiber<void> }>();
  const keyOf = (event: After): string => `${event.delay} ${event.stateId}`;
  let stopped = false;
  const disarm = (key: string): void => {
    const timer = armed.get(key);
    if (!timer) return;
    armed.delete(key);
    Effect.runFork(Fiber.interrupt(timer.fiber));
  };
  const absorb = (effects: readonly unknown[]): PeerCommand[] => {
    const commands: PeerCommand[] = [];
    for (const raw of effects) {
      const effect = Option.getOrUndefined(decodeHostEffect(raw));
      if (!effect) continue;
      if (effect.type === 'issue') {
        commands.push(effect.args[0].command);
      } else if (effect.type === '@xstate.raise') {
        const key = keyOf(effect.event);
        disarm(key);
        if (stopped) continue;
        const fiber = Effect.runSync(
          Effect.forkIn(
            Effect.sleep(Duration.millis(effect.delay)).pipe(Effect.andThen(Effect.sync(() => expire(key)))),
            scope,
          ),
        );
        armed.set(key, { event: effect.event, fiber });
      } else {
        disarm(keyOf(effect.event));
      }
    }
    return commands;
  };
  const [first, initial] = initialTransition(peerConnectionMachine, input);
  let snapshot = first;
  const step = (event: PeerEvent): PeerCommand[] => {
    if (stopped) return [];
    const [next, effects] = transition(peerConnectionMachine, snapshot, event);
    snapshot = next;
    return absorb(effects);
  };
  const take = (key: string): PeerCommand[] | null => {
    const timer = armed.get(key);
    if (!timer) return null;
    armed.delete(key);
    return step(asEvent(timer.event));
  };
  const expire = (key: string): void => {
    const event = armed.get(key)?.event;
    const commands = take(key);
    if (event && commands) onDeadline(event.delay, commands);
  };
  absorb(initial);
  return {
    send: (event: PeerEvent): readonly PeerCommand[] => step(event),
    /** Take the armed deadline `deadline` now. Null when it is not armed. */
    fire: (deadline: PeerDeadline): readonly PeerCommand[] | null => {
      const key = [...armed.keys()].find((k) => armed.get(k)?.event.delay === deadline);
      if (key === undefined) return null;
      const timer = armed.get(key);
      if (timer) Effect.runFork(Fiber.interrupt(timer.fiber));
      return take(key);
    },
    /** The deadlines armed now. */
    armed: (): PeerDeadline[] => [...armed.values()].map((timer) => timer.event.delay),
    state: (): PeerState => peerStateName(snapshot.value),
    stop: (): Promise<void> => {
      stopped = true;
      armed.clear();
      return Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
};
export type PeerConnection = ReturnType<typeof createPeerConnection>;
