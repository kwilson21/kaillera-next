/**
 * Which controllers the game sees as plugged in at a frame: the rules for the
 * controller-present mask's schedule.
 *
 * The patched core keeps one mask (kn_controller_present_mask) and sets every
 * pad's "present" bit from it on each controller write; the game reads the
 * bits while the frame runs. The mask is not part of the rollback state. The
 * engine used to set it when a roster reached the page, at whatever frame the
 * page was on, so two pages with the same inputs ran the frames between their
 * arrival points with different masks, and a rollback across the change ran
 * earlier frames again with the new one.
 *
 * Now a roster's mask takes effect at the host's roster frame plus
 * `MASK_LEAD` on every page (the roster frame is the one the late joiner's
 * input floor is filed at, _recordHostInputRoster), the engine files each
 * change at that frame, and before it steps any frame (forward, replay,
 * catch-up) it sets the core to the mask in effect there. A change filed below
 * a frame the page has already run would break both rules; the host never
 * files one (its frame is at most a rollback window behind the furthest frame
 * it ran, and the lead is longer), and a guest that hears a roster that late
 * files it at the same frame and asks the host for its state (`lateChange`).
 *
 * specs/controller_mask.qnt is the model: controller_mask_before (violated)
 * and controller_mask_fixed (pagesAgree, aFrameRunAgainKeepsItsMask,
 * hostIsNeverLate; arrivalOrderTest, rollbackAcrossTheChangeTest,
 * lateArrivalTest).
 *
 * The schedule itself (its arrays and the mask arithmetic) is in
 * controller-mask-schedule.ts, which is not verified; the three rules here are.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * Frames between the host's roster frame and the frame its mask takes effect
 * at. Longer than the rollback ring (the host's frame can be that far behind
 * the furthest one it has run, mid-replay) and than a guest's lead over the
 * host under the pacing gate (delay + 8), with the rest for the roster
 * message's trip: one second at 60 fps.
 */
export const MASK_LEAD = 60;

/**
 * The change in effect at `frame`: the index of the last change filed at or
 * before it, or -1 when none is (the schedule's starting mask applies).
 * `froms` are the frames the changes take effect at, in increasing order, as
 * `fileIndex` keeps them.
 */
//@ ensures -1 <= \result && \result < froms.length
//@ ensures \result >= 0 ==> froms[\result] <= frame
//@ ensures forall(k: nat, \result < k && k < froms.length ==> froms[k] > frame)
export function changeInEffect(froms: number[], frame: number): number {
  let i = froms.length;
  while (i > 0) {
    //@ invariant 0 <= i && i <= froms.length
    //@ invariant forall(k: nat, i <= k && k < froms.length ==> froms[k] > frame)
    //@ decreases i
    if (froms[i - 1]! <= frame) return i - 1;
    i = i - 1;
  }
  return -1;
}

/**
 * Where a change taking effect at `from` is filed: the index of the first
 * change at or after it. A change already at `from` is replaced (the host
 * broadcast twice at one frame, paused for a late joiner: the later roster
 * wins, on every page alike, since each channel is ordered); one after it
 * stays after it.
 */
//@ ensures 0 <= \result && \result <= froms.length
//@ ensures forall(k: nat, k < \result ==> froms[k] < from)
//@ ensures \result < froms.length ==> froms[\result] >= from
export function fileIndex(froms: number[], from: number): number {
  let i = 0;
  while (i < froms.length) {
    //@ invariant 0 <= i && i <= froms.length
    //@ invariant forall(k: nat, k < i ==> froms[k] < from)
    //@ decreases froms.length - i
    if (froms[i]! >= from) return i;
    i = i + 1;
  }
  return froms.length;
}

/**
 * A change heard after the page has run frames it covers, with a mask other
 * than the one those frames ran with: they ran differently from the other
 * pages', and nothing local can run them again (today's core has no export
 * that starts a rollback from JS). The page files the change at its frame all
 * the same (the host's state will put the page there) and asks the host for
 * its state.
 *
 * @param from        the frame the change takes effect at
 * @param frontier    the lowest frame this page has not run yet
 * @param maskBefore  the mask in effect at `from` before the change was filed
 * @param mask        the change's mask
 */
//@ ensures \result <==> from < frontier && maskBefore !== mask
export function lateChange(from: number, frontier: number, maskBefore: number, mask: number): boolean {
  return from < frontier && maskBefore !== mask;
}

/**
 * Whether the host schedules the next roster of its match: only while it has
 * scheduled every roster so far and every player page in the match can
 * (said so in `lockstep-ready`'s or `request-late-join`'s caps; a page that
 * said nothing is from before the scheduled rule). A page on the immediate
 * rule beside one on the scheduled rule would run up to MASK_LEAD frames with
 * other present bits, so once a page that cannot is in, the match stays
 * immediate (switching back would need a frame every page agrees on, and
 * the old page cannot agree). specs/controller_mask.qnt, oneRulePerMatch.
 *
 * @param wasScheduled  the match has been scheduled so far (true at its start)
 * @param capable       for each other player page in the match: it can schedule
 */
//@ ensures \result <==> wasScheduled && forall(k: nat, k < capable.length ==> capable[k])
export function matchScheduled(wasScheduled: boolean, capable: boolean[]): boolean {
  if (!wasScheduled) return false;
  let i = 0;
  while (i < capable.length) {
    //@ invariant 0 <= i && i <= capable.length
    //@ invariant forall(k: nat, k < i ==> capable[k])
    //@ decreases capable.length - i
    if (!capable[i]) return false;
    i = i + 1;
  }
  return true;
}

/**
 * Whether a guest schedules a roster from the host: only one the host
 * announced as scheduled (`roster-mask:<frame>` just before it on the same
 * channel, naming its frame), and only while the guest has not fallen back:
 * a host from before the scheduled rule never announces one, and one that
 * has fallen back to the immediate rule does not again.
 *
 * @param scheduling     this page has not fallen back to the immediate rule
 * @param announcedFrame the roster frame the host's last announcement named, or -1
 * @param rosterFrame    the frame of the roster heard
 */
//@ ensures \result <==> scheduling && announcedFrame >= 0 && announcedFrame === rosterFrame
export function rosterScheduled(scheduling: boolean, announcedFrame: number, rosterFrame: number): boolean {
  return scheduling && announcedFrame >= 0 && announcedFrame === rosterFrame;
}
