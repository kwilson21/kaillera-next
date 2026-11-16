/** Per-recipient recovery lifecycle. The machine decides; the engine only
 * reports events and performs commands. specs/recovery_delivery.qnt.
 * Deadlines use the engine's freeze-credited clock, not independent wall
 * timers that could drop a guest immediately after the host tab freezes. */
import { Context, Effect, Option, Schema } from 'effect';
import { setupEffect } from '@xstate/effect';
import { initialTransition, transition, type EventFrom } from 'xstate';
import { acknowledgesDeliveredPush, missedDeliveryStep, pushDeadlineStep } from './resync-request.ts';

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
}
const decodeIssue = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal('issue'), args: Schema.Tuple([Schema.Struct({ command: Command })]) }),
);
export interface RecoveryNotice {
  readonly type: Command['type'];
  readonly attempt: RecoveryAttempt;
  readonly pushes: number;
  readonly hole: number;
  readonly firstFrame: number;
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
  const records = new Map<number, { snapshot: Snapshot; token: RecoveryAttempt }>();
  const counts = new Map<number, Map<number, number>>();
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
      record.token = Object.freeze({ slot, sid: next.context.sid, sequence: next.context.attempt });
    const notices: RecoveryNotice[] = [];
    for (const raw of effects) {
      const effect = Option.getOrUndefined(decodeIssue(raw));
      if (!effect) continue;
      const type = effect.args[0].command.type;
      const { pushes, hole, firstFrame } = next.context;
      if (type === 'retry') remember(slot, hole, pushes);
      if (type === 'settled' || type === 'ended') counts.delete(slot);
      notices.push({ type, attempt: record.token, pushes, hole, firstFrame });
    }
    if (next.status === 'done') records.delete(slot);
    for (const notice of notices) Effect.runSync(Effect.sync(() => issue(notice)));
  };
  return {
    held: (slot: number, hole: number, enabled = true): boolean =>
      !enabled || records.has(slot) || count(slot, hole) >= timing.maxPushes,
    begin: (
      sourceSlot: number,
      hole: number,
      recipients: readonly { sid: string; slot: number }[],
      frame: number,
      now: number,
      enabled: boolean,
    ): readonly RecoveryAttempt[] => {
      if (!enabled || records.has(sourceSlot) || count(sourceSlot, hole) >= timing.maxPushes) return [];
      const pushes = count(sourceSlot, hole) + 1;
      remember(sourceSlot, hole, pushes);
      // Another recipient may still be delivering an earlier broadcast. Do not
      // overwrite its token or reset its retry budget; recover only free slots.
      // A settled source's trailing hole must not wait on that unrelated link.
      return recipients.flatMap(({ sid, slot }) => {
        if (records.has(slot)) return [];
        const [snapshot] = initialTransition(recoveryMachine, {
          sid,
          slot,
          hole,
          firstFrame: frame,
          now,
          pushes,
          ...timing,
        });
        const token = Object.freeze({ sid, slot, sequence: 1 });
        records.set(slot, { snapshot, token });
        return [token];
      });
    },
    current: (attempt: RecoveryAttempt): boolean => records.get(attempt.slot)?.token === attempt,
    entries: (): readonly RecoveryAttempt[] => [...records.values()].map((record) => record.token),
    event: (attempt: RecoveryAttempt, event: RecoveryEvent): void => {
      if (records.get(attempt.slot)?.token === attempt) send(attempt.slot, event);
    },
    acknowledge: (slot: number, before: number): void => send(slot, { type: 'acknowledged', before }),
    freeze: (gap: number, now: number): void => {
      for (const slot of records.keys()) send(slot, { type: 'freeze', gap, now });
    },
    reset: (slot: number): void => {
      send(slot, { type: 'stop' });
      records.delete(slot);
      counts.delete(slot);
    },
    resetAll: (): void => {
      for (const slot of records.keys()) send(slot, { type: 'stop' });
      records.clear();
      counts.clear();
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
