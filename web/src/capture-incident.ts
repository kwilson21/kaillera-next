import { setupEffect } from '@xstate/effect';
import { Schema } from 'effect';
import { initialTransition, transition, type EventFrom } from 'xstate';
import type {
  CaptureEvidence,
  CaptureIntent,
  CaptureToken,
  PeerVersion,
  RecipientVersion,
  Release,
  SealResult,
  createCaptureReservation,
} from './capture-reservation.ts';

export type IncidentPolicy = 'single-owner' | 'all-owners';
export interface IncidentPlan {
  readonly capture: CaptureIntent;
  readonly owners: readonly RecipientVersion[];
  /** All active non-host owners, even if a recipient's transfer is already busy. */
  readonly topology: readonly RecipientVersion[];
}
export interface OwnerReceipt {
  readonly epoch: number;
  /** This is the caller's proved, complete exact-ID set, not a wire ACK. */
  readonly complete: boolean;
  readonly currentOwner: RecipientVersion;
}
export interface NativeFence {
  readonly epoch: number;
  readonly jsFrame: number;
  readonly nativeFrame: number;
  readonly activeOwners: readonly RecipientVersion[];
  readonly allRequiredInputsConfirmed: boolean;
  readonly pendingRollback: boolean;
  readonly replayDepth: number;
  readonly failedRollbacks: number;
  readonly initialFailedRollbacks: number;
}
const Peer = Schema.Struct({ id: Schema.String, generation: Schema.Number });
const Slot = Schema.Literals([1, 2, 3]);
const Recipient = Schema.Struct({ ...Peer.fields, slot: Slot });
const Token = Schema.Struct({ frame: Schema.Number, epoch: Schema.Number });
const Starting = Schema.Struct({
  token: Token,
  deadline: Schema.Number,
  primary: Peer,
  owners: Schema.Array(Recipient),
  topology: Schema.Array(Recipient),
});
const ContextSchema = Schema.Struct({ ...Starting.fields, proved: Schema.Array(Slot) });
type Context = typeof ContextSchema.Type;
const Owner = Schema.Struct({ epoch: Schema.Number, complete: Schema.Boolean, currentOwner: Recipient });
const Native = Schema.Struct({
  epoch: Schema.Number,
  jsFrame: Schema.Number,
  nativeFrame: Schema.Number,
  activeOwners: Schema.Array(Recipient),
  allRequiredInputsConfirmed: Schema.Boolean,
  pendingRollback: Schema.Boolean,
  replayDepth: Schema.Number,
  failedRollbacks: Schema.Number,
  initialFailedRollbacks: Schema.Number,
});
type Lease = Pick<ReturnType<typeof createCaptureReservation>, 'open' | 'seal' | 'cancel'>;
export type IncidentState = 'idle' | 'collecting' | 'awaitingReplay' | 'sealing' | 'sealed' | 'expired' | 'cancelled';
type Terminal = { readonly state: 'expired' | 'cancelled'; readonly release: Release | undefined };
const live = (now: number, deadline: number) => Number.isFinite(now) && now >= 0 && now < deadline;
const samePeer = (a: PeerVersion, b: PeerVersion) => a.id === b.id && a.generation === b.generation;
const sameOwner = (a: RecipientVersion, b: RecipientVersion) => a.slot === b.slot && samePeer(a, b);
const nativeMatches = (ctx: Context, n: NativeFence, now: number): boolean =>
  live(now, ctx.deadline) &&
  n.epoch === ctx.token.epoch &&
  n.jsFrame === ctx.token.frame &&
  n.nativeFrame === ctx.token.frame &&
  n.activeOwners.length === ctx.topology.length &&
  ctx.topology.every((owner) => {
    const atSlot = n.activeOwners.filter((current) => current.slot === owner.slot);
    return atSlot.length === 1 && atSlot.some((current) => sameOwner(owner, current));
  }) &&
  n.allRequiredInputsConfirmed &&
  !n.pendingRollback &&
  n.replayDepth === 0 &&
  Number.isSafeInteger(n.initialFailedRollbacks) &&
  n.initialFailedRollbacks >= 0 &&
  n.failedRollbacks === n.initialFailedRollbacks;

export const captureIncidentMachine = setupEffect({
  schemas: {
    input: Starting,
    context: ContextSchema,
    events: {
      owner: Schema.Struct({ receipt: Owner, now: Schema.Number }),
      trySeal: Schema.Struct({ native: Native, now: Schema.Number }),
      sealFailed: Schema.Struct({}),
      sealed: Schema.Struct({}),
      clock: Schema.Struct({ epoch: Schema.Number, now: Schema.Number }),
      cancel: Schema.Struct({}),
    },
  },
}).createMachine({
  id: 'captureIncident',
  context: ({ input }) => ({ ...input, proved: [] }),
  initial: 'collecting',
  on: {
    clock: ({ context, event }) => {
      if (event.epoch !== context.token.epoch) return { target: '.cancelled' };
      if (!live(event.now, context.deadline)) return { target: '.expired' };
    },
    cancel: { target: '.cancelled' },
  },
  states: {
    collecting: {
      on: {
        owner: ({ context, event }) => {
          const owner = event.receipt.currentOwner;
          if (
            !live(event.now, context.deadline) ||
            context.token.epoch !== event.receipt.epoch ||
            !event.receipt.complete ||
            !context.owners.some((p) => sameOwner(p, owner)) ||
            context.proved.includes(owner.slot)
          )
            return;
          const proved = [...context.proved, owner.slot];
          const next = { ...context, proved };
          return proved.length === context.owners.length
            ? { context: next, target: 'awaitingReplay' }
            : { context: next };
        },
      },
    },
    awaitingReplay: {
      on: {
        trySeal: ({ context, event }) =>
          nativeMatches(context, event.native, event.now) ? { target: 'sealing' } : undefined,
      },
    },
    sealing: { on: { sealFailed: { target: 'awaitingReplay' }, sealed: { target: 'sealed' } } },
    sealed: { type: 'final' },
    expired: { type: 'final' },
    cancelled: { type: 'final' },
  },
});
type Event = EventFrom<typeof captureIncidentMachine>;

/** Scratch supervisor adapter; eventual owner is the existing recovery manager. */
export const createCaptureIncident = (lease: Lease, policy: IncidentPolicy = 'single-owner') => {
  let snapshot: ReturnType<typeof initialTransition<typeof captureIncidentMachine>>[0] | undefined;
  const push = (event: Event) => {
    if (snapshot) [snapshot] = transition(captureIncidentMachine, snapshot, event);
  };
  const matchesActive = (token: CaptureToken) => snapshot?.status === 'active' && snapshot.context.token === token;
  const state = (): IncidentState => {
    const phase = snapshot?.value;
    switch (phase) {
      case 'collecting':
      case 'awaitingReplay':
      case 'sealing':
      case 'sealed':
      case 'expired':
      case 'cancelled':
        return phase;
      default:
        return 'idle';
    }
  };

  return {
    state,
    open(plan: IncidentPlan, now: number): CaptureToken | undefined {
      if (
        snapshot?.status === 'active' ||
        plan.owners.length < 1 ||
        plan.owners.length > (policy === 'single-owner' ? 1 : 3) ||
        new Set(plan.owners.map((owner) => owner.slot)).size !== plan.owners.length ||
        new Set(plan.owners.map((owner) => owner.id)).size !== plan.owners.length ||
        !plan.owners.some((owner) => samePeer(owner, plan.capture.owner)) ||
        !plan.owners.every((owner) => plan.capture.recipients.some((peer) => sameOwner(owner, peer))) ||
        plan.topology.length < 2 ||
        plan.topology.length > 3 ||
        new Set(plan.topology.map((owner) => owner.slot)).size !== plan.topology.length ||
        new Set(plan.topology.map((owner) => owner.id)).size !== plan.topology.length ||
        !plan.capture.recipients.every((recip) => plan.topology.some((owner) => sameOwner(owner, recip)))
      )
        return undefined;
      const token = lease.open(plan.capture, now);
      if (!token) return undefined;
      [snapshot] = initialTransition(captureIncidentMachine, {
        token,
        deadline: plan.capture.deadline,
        primary: { ...plan.capture.owner },
        owners: plan.owners.map((owner) => ({ ...owner })),
        topology: plan.topology.map((owner) => ({ ...owner })),
      });
      return token;
    },
    reportOwner(token: CaptureToken, receipt: OwnerReceipt, now: number): void {
      if (matchesActive(token)) push({ type: 'owner', receipt, now });
    },
    tick(epoch: number, now: number): Terminal | undefined {
      if (snapshot?.status !== 'active') return undefined;
      const { token } = snapshot.context;
      push({ type: 'clock', epoch, now });
      const terminal = state();
      if (terminal === 'cancelled' || terminal === 'expired')
        return { state: terminal, release: lease.cancel(token, epoch, now) };
      return undefined;
    },
    cancel(token: CaptureToken, epoch: number, now: number): Release | undefined {
      if (matchesActive(token)) push({ type: 'cancel' });
      return lease.cancel(token, epoch, now);
    },
    trySeal(
      token: CaptureToken,
      now: () => number,
      observe: () => NativeFence,
      read: () => Uint8Array,
    ): SealResult | undefined {
      if (!matchesActive(token) || snapshot?.value !== 'awaitingReplay') return undefined;
      const ctx = snapshot.context;
      const initial = observe();
      if (!matchesActive(token)) return undefined;
      push({ type: 'trySeal', native: initial, now: now() });
      if (state() !== 'sealing') return undefined;
      const proof = (): CaptureEvidence => {
        const n = observe();
        return {
          epoch: n.epoch,
          frame: n.jsFrame,
          nativeFrame: n.nativeFrame,
          owner: ctx.primary,
          inputsConfirmed: nativeMatches(ctx, n, now()),
          replayIdle: n.replayDepth === 0 && !n.pendingRollback,
        };
      };
      let result: SealResult | undefined;
      try {
        result = lease.seal(token, now, proof, read);
      } finally {
        if (matchesActive(token)) push({ type: result ? 'sealed' : 'sealFailed' });
      }
      return result;
    },
  };
};
