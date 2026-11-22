/** Scratch design only. One logical fault fence; physical transfer queues are independent. */
export type TargetSlot = 1 | 2 | 3;
export type CaptureKey = TargetSlot | 'room' | 'late:1' | 'late:2' | 'late:3';
export interface PeerVersion {
  readonly id: string;
  readonly generation: number;
}
export interface RecipientVersion extends PeerVersion {
  readonly slot: TargetSlot;
}
export interface CaptureIntent {
  readonly epoch: number;
  readonly frame: number;
  readonly deadline: number;
  readonly deliveryDeadline: number;
  readonly maxBytes: number;
  readonly owner: PeerVersion;
  readonly recipients: readonly RecipientVersion[];
}
export interface CaptureEvidence {
  readonly epoch: number;
  readonly frame: number;
  readonly nativeFrame: number;
  readonly owner: PeerVersion;
  readonly replayIdle: boolean;
  readonly inputsConfirmed: boolean;
}
export interface DeferredIntent {
  readonly key: CaptureKey;
  readonly epoch: number;
  readonly sequence: number;
  readonly deadline: number;
}
export interface Release {
  readonly resume: readonly DeferredIntent[];
  readonly expiredOrStale: readonly DeferredIntent[];
}
export interface DeliveryScope {
  readonly epoch: number;
  readonly recipient: RecipientVersion;
}
/** Object identity is checked; matching metadata is not a lease. */
export interface CaptureToken {
  readonly frame: number;
  readonly epoch: number;
}
export interface SealResult {
  readonly token: CaptureToken;
  readonly released: Release;
}
interface Hold {
  readonly token: CaptureToken;
  readonly intent: CaptureIntent;
  readonly pending: Map<CaptureKey, DeferredIntent>;
  sealing: boolean;
}
interface Sealed {
  readonly intent: CaptureIntent;
  readonly bytes: Uint8Array;
}
type OfferResult = 'pass' | 'deferred' | 'rejected';
const isInt = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
const alive = (now: number, until: number): boolean => Number.isFinite(now) && now >= 0 && now < until;
const validSlot = (slot: CaptureKey): boolean => slot === 1 || slot === 2 || slot === 3;
const validKey = (key: CaptureKey): boolean =>
  validSlot(key) || key === 'room' || key === 'late:1' || key === 'late:2' || key === 'late:3';
const validPeer = (peer: PeerVersion): boolean =>
  typeof peer.id === 'string' && peer.id.length > 0 && isInt(peer.generation);
const samePeer = (a: PeerVersion, b: PeerVersion): boolean => a.id === b.id && a.generation === b.generation;
const sameRecipient = (a: RecipientVersion, b: RecipientVersion): boolean => a.slot === b.slot && samePeer(a, b);
const ready = (intent: CaptureIntent, proof: CaptureEvidence, now: number): boolean =>
  alive(now, intent.deadline) &&
  proof.epoch === intent.epoch &&
  proof.frame === intent.frame &&
  proof.nativeFrame === intent.frame &&
  samePeer(proof.owner, intent.owner) &&
  proof.replayIdle &&
  proof.inputsConfirmed;
const snapshotIntent = (intent: CaptureIntent): CaptureIntent => ({
  epoch: intent.epoch,
  frame: intent.frame,
  deadline: intent.deadline,
  deliveryDeadline: intent.deliveryDeadline,
  maxBytes: intent.maxBytes,
  owner: { id: intent.owner.id, generation: intent.owner.generation },
  recipients: intent.recipients.map(({ id, generation, slot }) => ({ id, generation, slot })),
});

export const createCaptureReservation = () => {
  let active: Hold | undefined;
  // A sealed artifact can outlive its logical hold, and remains collectible.
  const sealed = new WeakMap<CaptureToken, Sealed>();

  const release = (hold: Hold, currentEpoch: number, now: number): Release => {
    const resume: DeferredIntent[] = [];
    const expiredOrStale: DeferredIntent[] = [];
    for (const pending of hold.pending.values()) {
      (pending.epoch === currentEpoch && alive(now, pending.deadline) ? resume : expiredOrStale).push(pending);
    }
    active = undefined;
    return { resume, expiredOrStale };
  };

  const forDelivery = (token: CaptureToken, live: DeliveryScope, now: number): Sealed | undefined => {
    const snapshot = sealed.get(token);
    return snapshot &&
      snapshot.intent.epoch === live.epoch &&
      alive(now, snapshot.intent.deliveryDeadline) &&
      snapshot.intent.recipients.some((p) => sameRecipient(p, live.recipient))
      ? snapshot
      : undefined;
  };

  return {
    open(intent: CaptureIntent, now: number): CaptureToken | undefined {
      if (
        active ||
        !isInt(intent.frame) ||
        !isInt(intent.epoch) ||
        !isInt(intent.maxBytes) ||
        intent.maxBytes === 0 ||
        !Number.isFinite(intent.deadline) ||
        !alive(now, intent.deadline) ||
        !Number.isFinite(intent.deliveryDeadline) ||
        intent.deliveryDeadline < intent.deadline ||
        !validPeer(intent.owner) ||
        intent.recipients.length < 1 ||
        intent.recipients.length > 3 ||
        intent.recipients.some((p) => !validSlot(p.slot) || !validPeer(p)) ||
        new Set(intent.recipients.map((p) => p.slot)).size !== intent.recipients.length
      )
        return undefined;
      const token = Object.freeze({ frame: intent.frame, epoch: intent.epoch });
      active = { token, intent: snapshotIntent(intent), pending: new Map(), sealing: false };
      return token;
    },

    /** No clock read, allocations, or queue work outside a fault hold. */
    holding(): boolean {
      return active !== undefined;
    },

    /** Latest sequence per key; a room request never swallows an exact reply. */
    offer(request: DeferredIntent, now: number): OfferResult {
      if (!active) return 'pass';
      if (
        !validKey(request.key) ||
        request.epoch !== active.intent.epoch ||
        !isInt(request.sequence) ||
        !Number.isFinite(request.deadline) ||
        !alive(now, request.deadline)
      )
        return 'rejected';
      const prior = active.pending.get(request.key);
      if (!prior || request.sequence > prior.sequence) active.pending.set(request.key, Object.freeze({ ...request }));
      return 'deferred';
    },

    /**
     * Capture reads native memory synchronously. Copy while on this turn and
     * recheck: async callers get only leased bytes, never latest native state.
     * Failed proof does not silently discard queued logical requests.
     */
    seal(
      token: CaptureToken,
      now: () => number,
      observe: () => CaptureEvidence,
      capture: () => Uint8Array,
    ): SealResult | undefined {
      const hold = active;
      if (hold?.token !== token || hold.sealing) return undefined;
      hold.sealing = true;
      try {
        if (!ready(hold.intent, observe(), now()) || active !== hold) return undefined;
        const view = capture();
        if (!(view instanceof Uint8Array) || view.length === 0 || view.length > hold.intent.maxBytes) return undefined;
        const bytes = new Uint8Array(view);
        const afterProof = observe();
        const after = now();
        if (active !== hold || !ready(hold.intent, afterProof, after)) return undefined;
        sealed.set(token, { intent: hold.intent, bytes });
        return { token, released: release(hold, hold.intent.epoch, after) };
      } finally {
        hold.sealing = false;
      }
    },

    /** Expiration or epoch replacement unblocks producers without publication. */
    reap(currentEpoch: number, now: number): Release | undefined {
      if (!active || (active.intent.epoch === currentEpoch && alive(now, active.intent.deadline))) return undefined;
      return release(active, currentEpoch, now);
    },

    /** Cancel future claims too, even after an immutable snapshot sealed. */
    cancel(token: CaptureToken, currentEpoch: number, now: number): Release | undefined {
      sealed.delete(token);
      return active?.token === token ? release(active, currentEpoch, now) : undefined;
    },

    hasFor(token: CaptureToken, live: DeliveryScope, now: number): boolean {
      return forDelivery(token, live, now) !== undefined;
    },

    /** Existing physical per-target reservations still own ordering/retries. */
    bytesFor(token: CaptureToken, live: DeliveryScope, now: number): Uint8Array | undefined {
      const snapshot = forDelivery(token, live, now);
      // A recipient-local packer can't mutate authoritative bytes.
      return snapshot ? new Uint8Array(snapshot.bytes) : undefined;
    },
  };
};
