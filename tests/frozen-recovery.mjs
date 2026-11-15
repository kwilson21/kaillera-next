/**
 * The frames of a two-player run that differ because a page froze.
 *
 * When one page's main thread stops for PEER_DEAD_MS (5 s), the other drops
 * it as a phantom and plays on with predicted input (`PEER-PHANTOM`,
 * docs/netplay-invariants.md I1). The two timelines split by design, and the
 * guest is brought back to the host's state by a full resync a moment later
 * (`peer-recovery resync`, then `sync #n applied`). Frames between the two
 * differ on the two pages.
 *
 * On a real machine a page does not stop for five seconds. In the cloud
 * container it does: two emulators on software GL stop for 1 to 6 s some
 * twenty times a match, and about one match in three has a stop long enough
 * to trip the phantom. tests/rb-two-player.mjs leaves those frames out of
 * its hash compare, the way its FREEZE_HOST_MS mode leaves out the frames
 * before its own deliberate freeze, and says that it did.
 *
 * Only a recovery the logs prove is left out: the dropped page must have
 * logged a stop of its own main thread (`LOCAL-FREEZE`) of about the length
 * that trips the phantom, just before it, and the guest must have been
 * resynced soon after. A phantom with no such stop may be the network or a
 * data channel, which is a real failure; its frames are compared as usual.
 */

// The hashes the test compares trail the head by this many frames, which is
// past the rollback window, so a split can show this far before the frame
// at which the phantom was declared.
const BEFORE_PHANTOM_FRAMES = 12;
// The resync that ends a recovery follows it within this many frames; a
// later one is some other resync. Counted from the frame the dropped page
// was seen again (`PEER-RECOVERED`) when the log has one, because the page
// that plays on has no limit on how far it gets while the other is stopped:
// a page that stops twice in a row comes back 80 or more frames later.
// Without that line it is counted from the phantom.
const RECOVERY_WITHIN_FRAMES = 60;
// A phantom is declared after 5 s without progress. Only a stop of about
// that length on the dropped page shows the page itself was frozen.
const FROZEN_AT_LEAST_MS = 4000;

// Each match with its frame and its place in the log.
const entriesOf = (log, pattern) =>
  [...log.matchAll(pattern)].map((match) => ({ at: match.index, frame: Number(match[1]) }));

/**
 * Every phantom in the two sync logs, with the frames it covers and whether
 * the logs prove it was a frozen page that was then resynced.
 *
 * @param {{host: string, guest: string}} syncLogs
 */
export const frozenRecoveries = (syncLogs) => {
  const freezes = [];
  for (const [page, log] of Object.entries(syncLogs)) {
    for (const match of log.matchAll(/\tf=(\d+)\tLOCAL-FREEZE f=\d+ gap=(\d+)ms/g)) {
      freezes.push({ page, frame: Number(match[1]), ms: Number(match[2]) });
    }
  }
  // Only the guest is resynced; the frame it lands on is the second number.
  const resyncs = entriesOf(syncLogs.guest, /sync #\d+ applied \(frame \d+ -> (\d+)/g);
  const recoveries = [];
  for (const [page, log] of Object.entries(syncLogs)) {
    const seenAgainAll = entriesOf(log, /\tf=(\d+)\tPEER-RECOVERED /g);
    for (const phantom of entriesOf(log, /\tf=(\d+)\tPEER-PHANTOM /g)) {
      const frame = phantom.frame;
      const seen = seenAgainAll.find((s) => s.at > phantom.at) ?? phantom;
      // The resync that ends this recovery comes once the page is seen
      // again; one before that ended an earlier recovery. When the guest
      // declared the phantom, its own log says which came first: a resync
      // may take it back below the frame it had reached, so the frame
      // cannot. When the host did, the resync lands on the host's frames,
      // and one from before it saw the guest again lands on an earlier one.
      const later =
        page === 'guest'
          ? resyncs.filter((r) => r.at > seen.at).sort((a, b) => a.at - b.at)
          : resyncs.filter((r) => r.frame >= seen.frame).sort((a, b) => a.frame - b.frame);
      const first = later[0];
      let to = first !== undefined && first.frame <= seen.frame + RECOVERY_WITHIN_FRAMES ? first.frame : null;
      // Recovery can take a second resync right after the first; the split
      // ends at the last of them.
      for (const r of later) if (to !== null && r.frame > to && r.frame <= to + BEFORE_PHANTOM_FRAMES) to = r.frame;
      // The longest stop on the other page shortly before, which is what the
      // phantom was declared for.
      const stopped = freezes
        .filter((freeze) => freeze.page !== page && freeze.frame <= frame && freeze.frame >= frame - 60)
        .sort((a, b) => b.ms - a.ms)[0];
      const stoppedMs = stopped?.ms ?? null;
      recoveries.push({
        declaredBy: page,
        from: frame - BEFORE_PHANTOM_FRAMES,
        to,
        stoppedPage: stopped?.page ?? null,
        stoppedMs,
        proven: to !== null && stoppedMs !== null && stoppedMs >= FROZEN_AT_LEAST_MS,
      });
    }
  }
  return recoveries;
};

/** Is this frame inside a recovery the logs prove was a frozen page? */
export const inFrozenRecovery = (recoveries, frame) =>
  recoveries.some((recovery) => recovery.proven && frame >= recovery.from && frame < recovery.to);

// While the two timelines are split, the dropped page's real inputs reach
// the other past its rollback window, and its engine reports rollbacks it
// could not make (`FAILED-ROLLBACK`, `DEEP-MISPREDICT-SKIP`). Those belong
// to the split, up to this many frames after the resync that ends it: the
// same margin the test's freeze mode gives its own recovery.
const SETTLED_AFTER_FRAMES = 30;

/** Is a rollback-integrity event at this frame part of a proven recovery? */
export const inFrozenRecoveryAftermath = (recoveries, frame) =>
  recoveries.some(
    (recovery) => recovery.proven && frame >= recovery.from && frame < recovery.to + SETTLED_AFTER_FRAMES,
  );

/** What to tell the reader when anything was left out, or null when nothing was. */
export const frozenRecoveryNote = (recoveries, framesExcluded, mismatchesExcluded, integrityExcluded = 0) => {
  if (framesExcluded === 0 && integrityExcluded === 0) return null;
  const stops = recoveries
    .filter((recovery) => recovery.proven)
    .map(
      (recovery) =>
        `the ${recovery.stoppedPage} stopped for ${recovery.stoppedMs} ms and was dropped as a phantom ` +
        `(frames ${recovery.from} to ${recovery.to - 1})`,
    );
  return (
    `Left out of the hash compare: ${framesExcluded} frames, ${mismatchesExcluded} of them differing, because ` +
    `${stops.join('; ')}; the guest was resynced afterwards. ` +
    (integrityExcluded > 0
      ? `${integrityExcluded} failed-rollback reports from the same frames are left out too. `
      : '') +
    'A page stopping that long is the cloud container, not the netcode.'
  );
};
