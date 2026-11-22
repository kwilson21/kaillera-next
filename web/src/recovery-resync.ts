/**
 * The host's resyncs when a phantom is heard from again
 * (specs/phantom_settle.qnt, RESYNC_ALL).
 *
 * The host settles the recovered guest's inputs before the recovery frame:
 * its predictions for them are final. Another guest may have rolled back to
 * that guest's real inputs, within its own window, and would keep them where
 * the host keeps its predictions. So every player guest takes the host's
 * state, the recovered one and the others alike (recovery-resync-slots.ts,
 * proved); a guest that applies it
 * settles every remote input before its frame (the page's
 * _settleInputsAtResync, _drainPendingCInputs' settled skip).
 *
 * Each guest has at most one scheduled state queued: a recovery replaces any
 * request already queued for a guest it resyncs, so two phantoms recovering
 * one after the other leave one request per guest, at the later frame.
 */

import { recoveryResyncSlots } from './recovery-resync-slots.ts';

export interface ScheduledSync {
  targetFrame: number;
  targetSid: string;
  deadlineAt: number;
}

/** The queue after a recovery, and the slots of the other guests it resyncs. */
export interface RecoveryResyncs<T extends ScheduledSync> {
  queue: (T | ScheduledSync)[];
  others: number[];
}

export interface RecoveryPeer {
  sid: string;
  slot: number | null | undefined;
  /** Still being admitted late: its late-join state is on its way instead. */
  pendingLateJoin: boolean;
}

const isSlot = (slot: number | null | undefined): slot is number => typeof slot === 'number' && Number.isInteger(slot);

/**
 * The scheduled syncs after `recoveredSid` is heard from again at `frame`.
 * Which guests take the host's state is recoveryResyncSlots' (proved). Every
 * request queued for one of them is replaced by one at `frame`; requests for
 * anyone else are kept as they were. The recovered guest comes first among
 * the new ones. Returns the queue and the slots of the other guests resynced
 * (for the log).
 */
export function scheduleRecoveryResyncs<T extends ScheduledSync>(
  queued: readonly T[],
  peers: readonly RecoveryPeer[],
  recoveredSid: string,
  frame: number,
  deadlineAt: number,
): RecoveryResyncs<T> {
  const recoveredSlot = peers.find((p) => p.sid === recoveredSid)?.slot;
  const recovered = isSlot(recoveredSlot) ? recoveredSlot : -1;
  const slots = recoveryResyncSlots(
    peers.flatMap((p) => (isSlot(p.slot) ? [p.slot] : [])),
    recovered,
    peers.flatMap((p) => (p.pendingLateJoin && isSlot(p.slot) ? [p.slot] : [])),
  );
  const resynced = peers.filter((p) => isSlot(p.slot) && slots.includes(p.slot));
  const targets = [
    ...resynced.filter((p) => p.sid === recoveredSid),
    ...resynced.filter((p) => p.sid !== recoveredSid),
  ];
  const targetSids = new Set(targets.map((p) => p.sid));
  return {
    queue: [
      ...queued.filter((r) => !targetSids.has(r.targetSid)),
      ...targets.map((p) => ({ targetFrame: frame, targetSid: p.sid, deadlineAt })),
    ],
    others: slots.filter((slot) => slot !== recovered),
  };
}
