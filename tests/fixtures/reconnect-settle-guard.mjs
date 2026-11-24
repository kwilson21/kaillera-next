// PROOF FIXTURE ONLY. Do not load this as netplay runtime code.
//
// The host retains authored receipts from the same slot/owner while the
// native history is kept. Control completion is separate from capture:
// apply this decision again at the _kn_sync_read boundary after asynchronous
// admission. Frame numbers here are input tags, not simulation frames.
export function makeReconnectSettleGuard({ scope, firstTag, drainedBeforeReset, deadlineAt, failures }) {
  const drained = new Set(drainedBeforeReset);
  let newest = null;
  let lastCaptured = 0;
  let debtThrough = firstTag - 1;
  let scanFrom = firstTag;
  let unresolved = null;
  const sameScope = (candidate) =>
    candidate.epoch === scope.epoch && candidate.sid === scope.sid && candidate.generation === scope.generation;

  return {
    request(message, current) {
      if (!sameScope(current) || unresolved || message.id <= lastCaptured) return false;
      // A retry cannot renew the first request's deadline or enqueue more
      // work. The newest request owns the eventual answer and transport.
      if (!newest || message.id > newest.id) newest = message;
      return true;
    },
    authoredDrained(tag, current) {
      if (!sameScope(current)) return false;
      drained.add(tag);
      return true;
    },
    atCapture(current) {
      if (!sameScope(current)) return { kind: 'cancel' };
      if (!newest) return { kind: 'none' };
      if (unresolved) return { kind: 'unresolved', reason: unresolved };
      const fail = (reason) => {
        unresolved = reason;
        return { kind: 'unresolved', reason };
      };
      if (current.failedRollbacks !== failures) return fail('native rollback failed');
      // Do not forget debt merely because the current window moved. Once
      // an input is drained, oldest debt can advance. Negative/control
      // tags are outside the candidate's initial range.
      debtThrough = Math.max(debtThrough, current.frame - 1 - current.delay);
      while (scanFrom <= debtThrough && drained.has(scanFrom)) scanFrom++;
      if (scanFrom <= debtThrough && scanFrom < current.nativeEdge) return fail('past native window');
      if (current.now >= deadlineAt) return fail('reconnect input proof expired');
      if (scanFrom <= debtThrough || current.pendingRollback || current.replayDepth > 0) return { kind: 'wait' };
      if (current.nativeFrame !== current.frame || current.coprocPending) return { kind: 'wait' };
      const request = newest;
      newest = null;
      lastCaptured = request.id;
      return { kind: 'capture', request };
    },
  };
}
