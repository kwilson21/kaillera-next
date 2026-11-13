/**
 * Did a two-player run's hash mismatches come from a page that stopped?
 *
 * When one page's main thread stops for PEER_DEAD_MS (5 s), the other drops
 * it as a phantom and plays on with predicted input (`PEER-PHANTOM`,
 * docs/netplay-invariants.md I1). The two timelines split by design, and the
 * guest is brought back to the host's state by a full resync a moment later
 * (`peer-recovery resync`, then `sync #n applied`). Frames between the two
 * differ on the two pages, and tests/rb-two-player.mjs counts them.
 *
 * On a real machine a page does not stop for five seconds. In the cloud
 * container it does: two emulators on software GL freeze for 3 to 7 s at
 * scene changes. So a run there can fail on hashes with nothing wrong in the
 * netcode. This reads the two sync logs and says, for a run that failed,
 * whether every mismatch is inside such a recovery, and only when the log
 * also shows the dropped page's main thread stopped. It never changes
 * whether the run passed; it only tells the reader which kind of failure
 * they are looking at.
 */

// The hashes the test compares trail the head by this many frames, which is
// past the rollback window, so a split can show this far before the frame
// at which the phantom was declared.
const BEFORE_PHANTOM_FRAMES = 12;
// The resync that ends a recovery follows the phantom within this many
// frames; a later one is some other resync and explains nothing here.
const RECOVERY_WITHIN_FRAMES = 60;

// A phantom is declared after 5 s without progress (PEER_DEAD_MS). Only a
// stop of about that length on the dropped page shows the page itself was
// frozen; without one the cause may be the network or a data channel, which
// is exactly the kind of failure this must not explain away.
const FROZEN_AT_LEAST_MS = 4000;

const framesOf = (log, pattern) => [...log.matchAll(pattern)].map((match) => Number(match[1]));

/**
 * @param {{host: string, guest: string}} syncLogs  each page's sync log
 * @param {number[]} mismatchFrames  frames whose compared hashes differ
 */
export const phantomRecovery = (syncLogs, mismatchFrames) => {
  const freezes = [];
  for (const [page, log] of Object.entries(syncLogs)) {
    for (const match of log.matchAll(/\tf=(\d+)\tLOCAL-FREEZE f=\d+ gap=(\d+)ms/g)) {
      freezes.push({ page, frame: Number(match[1]), ms: Number(match[2]) });
    }
  }
  // Only the guest is resynced; the frame it lands on is the second number.
  const resyncedAt = framesOf(syncLogs.guest, /sync #\d+ applied \(frame \d+ -> (\d+)/g);
  const windows = [];
  for (const [page, log] of Object.entries(syncLogs)) {
    for (const frame of framesOf(log, /\tf=(\d+)\tPEER-PHANTOM /g)) {
      const later = resyncedAt.filter((at) => at >= frame).sort((a, b) => a - b);
      let to = later[0] !== undefined && later[0] <= frame + RECOVERY_WITHIN_FRAMES ? later[0] : null;
      // Recovery can take a second resync right after the first; the split
      // ends at the last of them.
      for (const at of later) if (to !== null && at > to && at <= to + BEFORE_PHANTOM_FRAMES) to = at;
      // The longest stop on the other page shortly before, which is what the
      // phantom was declared for.
      const stopped = freezes
        .filter((freeze) => freeze.page !== page && freeze.frame <= frame && freeze.frame >= frame - 60)
        .sort((a, b) => b.ms - a.ms)[0];
      windows.push({
        declaredBy: page,
        from: frame - BEFORE_PHANTOM_FRAMES,
        to,
        stoppedPage: stopped?.page ?? null,
        stoppedMs: stopped?.ms ?? null,
      });
    }
  }
  const inside = (frame) =>
    windows.some(
      (window) =>
        window.to !== null &&
        window.stoppedMs !== null &&
        window.stoppedMs >= FROZEN_AT_LEAST_MS &&
        frame >= window.from &&
        frame < window.to,
    );
  const mismatchesInside = mismatchFrames.filter(inside).length;
  return {
    windows,
    mismatchesInside,
    mismatchesOutside: mismatchFrames.length - mismatchesInside,
  };
};

/** One line for a failed run whose every mismatch is explained, or null. */
export const phantomRecoveryVerdict = (recovery) => {
  if (recovery.mismatchesInside === 0 || recovery.mismatchesOutside > 0) return null;
  const stops = recovery.windows
    .filter((window) => window.to !== null && window.stoppedMs !== null && window.stoppedMs >= FROZEN_AT_LEAST_MS)
    .map((window) => `the ${window.stoppedPage} stopped for ${window.stoppedMs} ms`);
  return (
    `All ${recovery.mismatchesInside} hash mismatches are inside a peer-phantom recovery: ${stops.join('; ')}, ` +
    'the other page dropped it as a phantom and the guest was resynced. On the cloud container this is a ' +
    'main-thread freeze, not a netcode divergence: run it again. The run still fails.'
  );
};
