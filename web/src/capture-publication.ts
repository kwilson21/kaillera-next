/** Isolated fault-only publication adapter. No wire or engine-step policy. */
import { createCaptureIncident, type IncidentPlan, type NativeFence, type OwnerReceipt } from './capture-incident.ts';
import {
  createCaptureReservation,
  type CaptureKey,
  type CaptureToken,
  type DeliveryScope,
  type Release,
} from './capture-reservation.ts';

type Outcome = readonly string[] | null | undefined;
type Work = {
  readonly run: () => Promise<Outcome>;
  readonly key: CaptureKey;
  readonly epoch: number;
  readonly deadline: number;
};
type Pending = { work: Work; readonly resolve: (outcome: Outcome) => void; readonly promise: Promise<Outcome> };

/** One logical XState snapshot per existing recovery supervisor. */
export const createCapturePublication = () => {
  let lease = createCaptureReservation();
  let incident = createCaptureIncident(lease);
  let active: CaptureToken | undefined;
  let sequence = 0;
  let revision = 0;
  let bootReads = 0;
  const deferred = new Map<CaptureKey, Pending>();

  const take = (key: CaptureKey): Pending | undefined => {
    const work = deferred.get(key);
    deferred.delete(key);
    return work;
  };
  const dispatch = (released: Release | undefined): void => {
    if (!released) return;
    const at = revision;
    for (const item of released.expiredOrStale) take(item.key)?.resolve(null);
    for (const item of released.resume) {
      const pending = take(item.key);
      if (pending)
        queueMicrotask(() =>
          Promise.resolve()
            .then(() => (at === revision ? pending.work.run() : null))
            .then(pending.resolve, () => pending.resolve(null)),
        );
    }
  };
  return {
    enterBootRead(): (() => void) | undefined {
      if (active) return undefined;
      const at = revision;
      bootReads++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (at === revision) bootReads--;
      };
    },
    holding: (): boolean => active !== undefined,
    open(plan: IncidentPlan, now: number): CaptureToken | undefined {
      if (active || bootReads) return undefined;
      active = incident.open(plan, now);
      return active;
    },
    owner(token: CaptureToken, receipt: OwnerReceipt, now: number): void {
      if (active === token) incident.reportOwner(token, receipt, now);
    },
    defer(work: Work, now: number): Promise<Outcome> | null {
      if (
        lease.offer({ key: work.key, epoch: work.epoch, deadline: work.deadline, sequence: ++sequence }, now) !==
        'deferred'
      )
        return null;
      const pending = deferred.get(work.key);
      if (pending) {
        pending.work = work;
        return pending.promise;
      }
      let resolve: (outcome: Outcome) => void = () => {};
      const promise = new Promise<Outcome>((release) => {
        resolve = release;
      });
      deferred.set(work.key, { work, promise, resolve });
      return promise;
    },
    seal(token: CaptureToken, now: () => number, observe: () => NativeFence, read: () => Uint8Array): boolean {
      if (active !== token) return false;
      const sealed = incident.trySeal(token, now, observe, read);
      if (!sealed) return false;
      active = undefined;
      dispatch(sealed.released);
      return true;
    },
    tick(epoch: number, now: number): void {
      if (!active) return;
      const terminal = incident.tick(epoch, now);
      if (!terminal) return;
      active = undefined;
      dispatch(terminal.release);
    },
    cancelActive(epoch: number, now: number): void {
      const token = active;
      if (!token) return;
      active = undefined;
      dispatch(incident.cancel(token, epoch, now));
    },
    discard(): void {
      revision++;
      bootReads = 0;
      active = undefined;
      for (const pending of deferred.values()) pending.resolve(null);
      deferred.clear();
      lease = createCaptureReservation();
      incident = createCaptureIncident(lease);
    },
    hasFor: (token: CaptureToken, live: DeliveryScope, now: number): boolean => lease.hasFor(token, live, now),
    bytesFor: (token: CaptureToken, live: DeliveryScope, now: number): Uint8Array | undefined =>
      lease.bytesFor(token, live, now),
  };
};
