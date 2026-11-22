/** Per-recipient recovery lifecycle. The machine decides; the engine only
 * reports events and performs commands. specs/recovery_delivery.qnt.
 * Deadlines use the engine's freeze-credited clock, not independent wall
 * timers that could drop a guest immediately after the host tab freezes. */
import { Context, Effect, Option, Schema } from 'effect';
import { setupEffect } from '@xstate/effect';
import { createCapturePublication } from './capture-publication.ts';
import type { IncidentPlan } from './capture-incident.ts';
import type { CaptureToken } from './capture-reservation.ts';
import { initialTransition, transition, type EventFrom } from 'xstate';
import {
  acknowledgesDeliveredPush,
  missedDeliveryStep,
  pushDeadlineStep,
  sourceCaptureAllowed,
} from './resync-request.ts';

const Input = Schema.Struct({
  sid: Schema.String,
  slot: Schema.Number,
  hole: Schema.Number,
  firstFrame: Schema.Number,
  now: Schema.Number,
  pushes: Schema.Number,
  maxPushes: Schema.Number,
  timeoutMs: Schema.Number,
  quietMs: Schema.Number,
});
const RecoveryContext = Schema.Struct({
  ...Input.fields,
  attempt: Schema.Number,
  armedAt: Schema.Number,
  enqueuedAt: Schema.Number,
  handedAt: Schema.Number,
  failedAt: Schema.Number,
  deliveredBefore: Schema.Number,
});
const Command = Schema.Struct({ type: Schema.Literals(['retry', 'settled', 'ended', 'drop']) });
type Command = typeof Command.Type;
export class RecoveryCommands extends Context.Service<
  RecoveryCommands,
  { readonly issue: (command: Command) => Effect.Effect<void> }
>()('kn/RecoveryCommands') {}

export const recoveryMachine = setupEffect({
  schemas: {
    input: Input,
    context: RecoveryContext,
    events: {
      tick: Schema.Struct({ now: Schema.Number, away: Schema.Boolean, chainProgress: Schema.Number }),
      enqueued: Schema.Struct({ attempt: Schema.Number, now: Schema.Number }),
      delivered: Schema.Struct({ attempt: Schema.Number, now: Schema.Number, before: Schema.Number }),
      failed: Schema.Struct({ attempt: Schema.Number, now: Schema.Number }),
      acknowledged: Schema.Struct({ before: Schema.Number }),
      freeze: Schema.Struct({ gap: Schema.Number, now: Schema.Number }),
      stop: Schema.Struct({}),
    },
    actions: { issue: { params: Schema.Struct({ command: Command }) } },
  },
  actions: { issue: ({ command }) => RecoveryCommands.use((service) => service.issue(command)) },
}).createMachine({
  id: 'recovery',
  context: ({ input }) => ({
    ...input,
    attempt: 1,
    armedAt: input.now,
    enqueuedAt: -1,
    handedAt: -1,
    failedAt: -1,
    deliveredBefore: -1,
  }),
  initial: 'sending',
  on: {
    stop: { target: '.ended' },
    freeze: ({ context, event }) => ({
      context: {
        ...context,
        armedAt: Math.min(event.now, context.armedAt + event.gap),
        handedAt: context.handedAt < 0 ? -1 : Math.min(event.now, context.handedAt + event.gap),
        failedAt: context.failedAt < 0 ? -1 : Math.min(event.now, context.failedAt + event.gap),
      },
    }),
  },
  states: {
    sending: {
      on: {
        enqueued: ({ context, event }) =>
          event.attempt === context.attempt ? { context: { ...context, enqueuedAt: event.now } } : undefined,
        delivered: ({ context, event }) =>
          event.attempt === context.attempt
            ? { target: 'awaitingAck', context: { ...context, handedAt: event.now, deliveredBefore: event.before } }
            : undefined,
        failed: ({ context, event }) =>
          event.attempt === context.attempt
            ? { target: 'backoff', context: { ...context, failedAt: event.now } }
            : undefined,
        tick: ({ context, event, actions, self }, enq) => {
          const lastProgress = Math.max(context.armedAt, context.enqueuedAt < 0 ? 0 : event.chainProgress);
          const step = pushDeadlineStep(
            true,
            event.away,
            false,
            false,
            false,
            event.now - lastProgress,
            context.quietMs,
            0,
            context.timeoutMs,
            context.pushes,
            context.maxPushes,
          );
          if (step === 'ended') {
            enq(actions.issue, { command: { type: 'ended' }, self });
            return { target: 'ended' };
          }
          if (step !== 'letGo') return;
          if (context.pushes >= context.maxPushes) {
            enq(actions.issue, { command: { type: 'drop' }, self });
            return { target: 'exhausted' };
          }
          enq(actions.issue, { command: { type: 'retry' }, self });
          return {
            target: 'sending',
            context: {
              ...context,
              attempt: context.attempt + 1,
              pushes: context.pushes + 1,
              armedAt: event.now,
              enqueuedAt: -1,
              handedAt: -1,
              failedAt: -1,
              deliveredBefore: -1,
            },
          };
        },
      },
    },
    awaitingAck: {
      on: {
        acknowledged: ({ context, event, actions, self }, enq) => {
          if (!acknowledgesDeliveredPush(true, context.deliveredBefore, event.before)) return;
          enq(actions.issue, { command: { type: 'settled' }, self });
          return { target: 'settled' };
        },
        tick: ({ context, event, actions, self }, enq) => {
          const step = pushDeadlineStep(
            true,
            event.away,
            false,
            true,
            false,
            0,
            context.quietMs,
            event.now - context.handedAt,
            context.timeoutMs,
            context.pushes,
            context.maxPushes,
          );
          if (step === 'ended') {
            enq(actions.issue, { command: { type: 'ended' }, self });
            return { target: 'ended' };
          }
          if (step === 'giveUp') {
            enq(actions.issue, { command: { type: 'drop' }, self });
            return { target: 'exhausted' };
          }
          if (step !== 'pushAgain') return;
          enq(actions.issue, { command: { type: 'retry' }, self });
          return {
            target: 'sending',
            context: {
              ...context,
              attempt: context.attempt + 1,
              pushes: context.pushes + 1,
              armedAt: event.now,
              enqueuedAt: -1,
              handedAt: -1,
              failedAt: -1,
              deliveredBefore: -1,
            },
          };
        },
      },
    },
    backoff: {
      on: {
        tick: ({ context, event, actions, self }, enq) => {
          if (event.away) {
            enq(actions.issue, { command: { type: 'ended' }, self });
            return { target: 'ended' };
          }
          const step = missedDeliveryStep(
            true,
            event.now - context.failedAt,
            context.timeoutMs,
            context.pushes,
            context.maxPushes,
          );
          if (step === 'wait') return;
          if (step === 'giveUp') {
            enq(actions.issue, { command: { type: 'drop' }, self });
            return { target: 'exhausted' };
          }
          enq(actions.issue, { command: { type: 'retry' }, self });
          return {
            target: 'sending',
            context: {
              ...context,
              attempt: context.attempt + 1,
              pushes: context.pushes + 1,
              armedAt: event.now,
              enqueuedAt: -1,
              handedAt: -1,
              failedAt: -1,
              deliveredBefore: -1,
            },
          };
        },
      },
    },
    settled: { type: 'final' },
    ended: { type: 'final' },
    exhausted: { type: 'final' },
  },
});

export type RecoveryEvent = EventFrom<typeof recoveryMachine>;
export interface RecoveryAttempt {
  readonly slot: number;
  readonly sid: string;
  readonly sequence: number;
  readonly wireId: number;
}
const decodeIssue = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal('issue'), args: Schema.Tuple([Schema.Struct({ command: Command })]) }),
);
export interface RecoveryNotice {
  readonly type: Command['type'] | 'budget-exhausted';
  readonly attempt: RecoveryAttempt;
  readonly pushes: number;
  readonly hole: number;
  readonly firstFrame: number;
  readonly budget?: { readonly scope: 'source' | 'room'; readonly used: number; readonly limit: number };
}
export interface RecoveryTiming {
  readonly timeoutMs: number;
  readonly quietMs: number;
  readonly maxPushes: number;
}

/** Runs pure XState transitions synchronously, like createPeerConnection.
 * Commands run through Effect; no second JS state machine observes it. */
export const createRecoveryManager = (timing: RecoveryTiming, issue: (notice: RecoveryNotice) => void) => {
  type Snapshot = ReturnType<typeof initialTransition<typeof recoveryMachine>>[0];
  // Never reset across matches/reconnects: an old ACK cannot name a new attempt.
  let nextWireId = 0;
  const publication = createCapturePublication();
  const publicationAttempts = new WeakMap<CaptureToken, ReadonlySet<RecoveryAttempt>>();
  // Only the original opened attempt belongs to a new publication fence.
  const originalSource = new WeakMap<RecoveryAttempt, number>();
  const records = new Map<number, { snapshot: Snapshot; token: RecoveryAttempt }>();
  // Recipients a later broadcast skipped because they were still owed an
  // earlier one. Settling that earlier state would leave them before the newer
  // hole: they are owed one fresh push (followUp). specs/recovery_delivery.qnt
  // recovery_skipped.
  const owedFollowUp = new Map<number, { hole: number; firstFrame: number; pushes: number }>();
  const counts = new Map<number, Map<number, number>>();
  // Resource budget is persistent-player-scoped and deliberately survives ACKs and peer
  // resets: a new hole is not permission for unlimited room-wide captures.
  // This conservative policy intentionally evicts a source on a fourth new
  // capture within 30s, even for unrelated holes; it is not a measured latency
  // threshold. A match reset clears it. Three admissions allow a trailing-hole follow-up
  // without allowing a fresh 8 MiB capture every 1.5 seconds indefinitely.
  const sourceCaptures = new Map<string, number[]>();
  // Roster snapshots may omit a live RTC connection during signaling reconnect.
  // Only the adapter's server-roster identity is cached, never a peer claim.
  let connectionIdentities = new WeakMap<object, string>();
  let roomCaptures: number[] = [];
  const budgetNotified = new Set<string>();
  const sourceBySlot = new Map<number, string>();
  const SOURCE_CAPTURE_WINDOW_MS = 30000;
  const SOURCE_CAPTURE_LIMIT = 3;
  // Three possible guests, each with three admissions. This shared rolling
  // ceiling survives leave/rejoin and client-selected persistentId rotation.
  const ROOM_CAPTURE_LIMIT = 9;
  const count = (slot: number, hole: number) => counts.get(slot)?.get(hole) ?? 0;
  const remember = (slot: number, hole: number, pushes: number) => {
    let history = counts.get(slot);
    if (!history) {
      history = new Map();
      counts.set(slot, history);
    }
    history.set(hole, pushes);
  };
  const send = (slot: number, event: RecoveryEvent): void => {
    const record = records.get(slot);
    if (!record) return;
    const [next, effects] = transition(recoveryMachine, record.snapshot, event);
    record.snapshot = next;
    if (next.context.attempt !== record.token.sequence)
      record.token = Object.freeze({
        slot,
        sid: next.context.sid,
        sequence: next.context.attempt,
        wireId: ++nextWireId,
      });
    const notices: RecoveryNotice[] = [];
    for (const raw of effects) {
      const effect = Option.getOrUndefined(decodeIssue(raw));
      if (!effect) continue;
      const type = effect.args[0].command.type;
      const { pushes, hole, firstFrame } = next.context;
      if (type === 'retry') remember(slot, hole, pushes);
      if (type === 'settled' || type === 'ended') counts.delete(slot);
      // A retry captures the current state, which already covers any later
      // hole; an ended or dropped recipient is owed nothing more.
      if (type !== 'settled') owedFollowUp.delete(slot);
      notices.push({ type, attempt: record.token, pushes, hole, firstFrame });
    }
    if (next.status === 'done') records.delete(slot);
    for (const notice of notices) Effect.runSync(Effect.sync(() => issue(notice)));
  };
  return {
    publication,
    openPublication(plan: IncidentPlan, attempts: readonly RecoveryAttempt[], now: number): CaptureToken | undefined {
      const initiating = plan.capture.recipients.find((p) => p.id === plan.capture.owner.id);
      if (
        !initiating ||
        plan.capture.deadline - now > 1500 ||
        attempts.length < 1 ||
        attempts.length !== plan.capture.recipients.length ||
        new Set(attempts).size !== attempts.length ||
        !attempts.every(
          (a) =>
            records.get(a.slot)?.token === a &&
            records.get(a.slot)?.snapshot.context.firstFrame === plan.capture.frame &&
            originalSource.get(a) === initiating.slot &&
            plan.capture.recipients.some(({ slot, id }) => slot === a.slot && id === a.sid),
        )
      )
        return undefined;
      const token = publication.open(plan, now);
      if (token) publicationAttempts.set(token, new Set(attempts));
      return token;
    },
    ownsPublication(token: CaptureToken, attempts: readonly RecoveryAttempt[]): boolean {
      const opened = publicationAttempts.get(token);
      return (
        !!opened &&
        attempts.length === opened.size &&
        new Set(attempts).size === attempts.length &&
        attempts.every((a) => opened.has(a) && records.get(a.slot)?.token === a)
      );
    },
    held: (slot: number, hole: number, enabled = true): boolean =>
      !enabled || records.has(slot) || count(slot, hole) >= timing.maxPushes,
    begin: (
      sourceSlot: number,
      hole: number,
      recipients: readonly { sid: string; slot: number; playerId?: string; connection?: object }[],
      frame: number,
      now: number,
      enabled: boolean,
    ): readonly RecoveryAttempt[] => {
      if (!enabled || records.has(sourceSlot) || count(sourceSlot, hole) >= timing.maxPushes) return [];
      const source = recipients.find(({ slot }) => slot === sourceSlot);
      if (!source) return [];
      // playerId comes only from the server roster adapter, not peer messages.
      // A missing roster identity conservatively shares a slot budget: changing
      // an unrecognized connection key must not buy more captures.
      if (source.connection && source.playerId) connectionIdentities.set(source.connection, source.playerId);
      const playerId = source.playerId ?? (source.connection && connectionIdentities.get(source.connection));
      const sourceKey = playerId ? `player:${playerId}` : `unidentified-slot:${sourceSlot}`;
      // Expire inactive identities too, so connection churn cannot grow this map forever.
      for (const [identity, times] of sourceCaptures) {
        if (times.every((at) => now - at >= SOURCE_CAPTURE_WINDOW_MS)) {
          sourceCaptures.delete(identity);
          budgetNotified.delete(identity);
        }
      }
      sourceBySlot.set(sourceSlot, sourceKey);
      const recent = (sourceCaptures.get(sourceKey) ?? []).filter((at) => now - at < SOURCE_CAPTURE_WINDOW_MS);
      sourceCaptures.set(sourceKey, recent);
      roomCaptures = roomCaptures.filter((at) => now - at < SOURCE_CAPTURE_WINDOW_MS);
      if (
        !sourceCaptureAllowed(recent.length, SOURCE_CAPTURE_LIMIT) ||
        !sourceCaptureAllowed(roomCaptures.length, ROOM_CAPTURE_LIMIT)
      ) {
        if (!budgetNotified.has(sourceKey)) {
          budgetNotified.add(sourceKey);
          Effect.runSync(
            Effect.sync(() =>
              issue({
                type: 'budget-exhausted',
                budget: !sourceCaptureAllowed(recent.length, SOURCE_CAPTURE_LIMIT)
                  ? { scope: 'source', used: recent.length, limit: SOURCE_CAPTURE_LIMIT }
                  : { scope: 'room', used: roomCaptures.length, limit: ROOM_CAPTURE_LIMIT },
                attempt: Object.freeze({ sid: source.sid, slot: source.slot, sequence: 0, wireId: 0 }),
                pushes: recent.length,
                hole,
                firstFrame: frame,
              }),
            ),
          );
        }
        return [];
      }
      budgetNotified.delete(sourceKey);
      recent.push(now);
      roomCaptures.push(now);
      const pushes = count(sourceSlot, hole) + 1;
      remember(sourceSlot, hole, pushes);
      // Another recipient may still be delivering an earlier broadcast. Do not
      // overwrite its token or reset its retry budget; recover only free slots.
      // A settled source's trailing hole must not wait on that unrelated link.
      return recipients.flatMap(({ sid, slot }) => {
        if (records.has(slot)) {
          owedFollowUp.set(slot, { hole, firstFrame: frame, pushes });
          return [];
        }
        owedFollowUp.delete(slot);
        const [snapshot] = initialTransition(recoveryMachine, {
          sid,
          slot,
          hole,
          firstFrame: frame,
          now,
          pushes,
          ...timing,
        });
        const token = Object.freeze({ sid, slot, sequence: 1, wireId: ++nextWireId });
        originalSource.set(token, sourceSlot);
        records.set(slot, { snapshot, token });
        return [token];
      });
    },
    /** After `attempt` settles: a fresh attempt for the same recipient when a
     * later broadcast skipped it, else undefined. The caller pushes it a newly
     * captured state, so the recipient does not stay on the earlier one. */
    followUp: (attempt: RecoveryAttempt, now: number): RecoveryAttempt | undefined => {
      const owed = owedFollowUp.get(attempt.slot);
      owedFollowUp.delete(attempt.slot);
      if (!owed || records.has(attempt.slot)) return undefined;
      const [snapshot] = initialTransition(recoveryMachine, {
        sid: attempt.sid,
        slot: attempt.slot,
        hole: owed.hole,
        firstFrame: owed.firstFrame,
        now,
        pushes: owed.pushes,
        ...timing,
      });
      const token = Object.freeze({ sid: attempt.sid, slot: attempt.slot, sequence: 1, wireId: ++nextWireId });
      records.set(attempt.slot, { snapshot, token });
      return token;
    },
    current: (attempt: RecoveryAttempt): boolean => records.get(attempt.slot)?.token === attempt,
    entries: (): readonly RecoveryAttempt[] => [...records.values()].map((record) => record.token),
    event: (attempt: RecoveryAttempt, event: RecoveryEvent): void => {
      if (records.get(attempt.slot)?.token === attempt) send(attempt.slot, event);
    },
    // Legacy inputs-settled updates input history only. It cannot prove which
    // of two same-frame snapshots was applied. Old guests can still recover
    // through input progress, but never settle a token-bearing attempt by frame.
    acknowledge: (slot: number, before: number, wireId: number): void => {
      if (!Number.isSafeInteger(wireId) || wireId <= 0 || records.get(slot)?.token.wireId !== wireId) return;
      send(slot, { type: 'acknowledged', before });
    },
    freeze: (gap: number, now: number): void => {
      for (const slot of records.keys()) send(slot, { type: 'freeze', gap, now });
    },
    reset: (slot: number): void => {
      const identity = sourceBySlot.get(slot);
      if (identity) budgetNotified.delete(identity);
      sourceBySlot.delete(slot);
      send(slot, { type: 'stop' });
      records.delete(slot);
      counts.delete(slot);
      owedFollowUp.delete(slot);
    },
    resetAll: (): void => {
      publication.discard();
      for (const slot of records.keys()) send(slot, { type: 'stop' });
      records.clear();
      counts.clear();
      owedFollowUp.clear();
      sourceCaptures.clear();
      connectionIdentities = new WeakMap();
      roomCaptures = [];
      sourceBySlot.clear();
      budgetNotified.clear();
    },
    forgetHistory: (slot: number): void => {
      counts.delete(slot);
    },
    state: (slot: number): string | null => {
      const value = records.get(slot)?.snapshot.value;
      return typeof value === 'string' ? value : null;
    },
  };
};
