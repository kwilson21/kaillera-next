/**
 * The host's resyncs when a phantom is heard from again
 * (specs/phantom_settle.qnt, RESYNC_ALL).
 *
 * The host settles the recovered guest's inputs before the recovery frame:
 * its predictions for them are final. Another guest may have rolled back to
 * that guest's real inputs, within its own window, and would keep them where
 * the host keeps its predictions. So every player guest takes the host's
 * state, the recovered one and the others alike; a guest that applies it
 * settles every remote input before its frame (the page's
 * _settleInputsAtResync, _drainPendingCInputs' settled skip).
 *
 * Each guest has at most one scheduled state queued: a recovery replaces any
 * request already queued for a guest it resyncs, so two phantoms recovering
 * one after the other leave one request per guest, at the later frame.
 */

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
}

/** Whether a peer at `slot` takes the host's state on a recovery: a player guest (slots 1 to 3). */
export function resyncedOnRecovery(slot: number | null | undefined): slot is number {
  return typeof slot === 'number' && Number.isInteger(slot) && slot >= 1 && slot <= 3;
}

/**
 * The scheduled syncs after `recoveredSid` is heard from again at `frame`:
 * every request queued for a guest it resyncs is replaced by one at `frame`;
 * requests for anyone else are kept as they were. The recovered guest comes
 * first among the new ones. Returns the queue and the slots of the other
 * guests resynced (for the log).
 */
export function scheduleRecoveryResyncs<T extends ScheduledSync>(
  queued: readonly T[],
  peers: readonly RecoveryPeer[],
  recoveredSid: string,
  frame: number,
  deadlineAt: number,
): RecoveryResyncs<T> {
  const targets: string[] = [];
  const others: number[] = [];
  for (const p of peers) {
    if (!resyncedOnRecovery(p.slot)) continue;
    if (p.sid === recoveredSid) targets.unshift(p.sid);
    else {
      targets.push(p.sid);
      others.push(p.slot);
    }
  }
  const targetSids = new Set(targets);
  return {
    queue: [
      ...queued.filter((r) => !targetSids.has(r.targetSid)),
      ...targets.map((sid) => ({ targetFrame: frame, targetSid: sid, deadlineAt })),
    ],
    others,
  };
}
