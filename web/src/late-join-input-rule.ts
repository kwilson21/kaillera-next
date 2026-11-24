/**
 * What every page applies around a player's join into a running match: the
 * rules that make all of them apply the same input for every slot on every
 * tag, the joining page too.
 *
 * The joiner loads the host's state of frame H and applies tags from
 * H - delay on; the host admits it at its roster frame R >= H, and every page
 * holds the joiner's tags below R as absent (neutral).
 *
 * Before, on Smash Remix, each page ran a "bootstrap" from the frame it was
 * on when it learned of the join: it held its own input neutral for a window
 * after that frame and fed every other slot a neutral placeholder over the
 * window, as a real input the C engine never rolls back. Pages hear at
 * different frames, so their windows differed, and a real input arriving
 * after its frame ran never replaced the placeholder. The joiner, given none
 * of the host's inputs on Remix, ran the tags below each player's first live
 * packet as placeholders where the host had run real inputs.
 *
 * Now, on the scheduled roster rule (one per match, the host's:
 * controller-mask.ts `matchScheduled`):
 *   - no page seeds a placeholder or holds its own input for a join
 *     (`legacyBootstrap` is false): an input a page does not hold is
 *     predicted, and the real one corrects the prediction;
 *   - the host sends the joiner its confirmed inputs around H on every ROM
 *     (the late-join input bridge, `bridgeOffered`), and the joiner waits for
 *     each original player's real input from H - delay on;
 *   - the joiner holds its own input neutral until it has heard the roster
 *     that admits it, and below R + lead, the frame its controller is present
 *     from on every page (`joinerHoldsOwnInput`);
 *   - a page that hears that roster after it has run a joiner tag the joiner
 *     may have sent for real (`admittedLate`) takes the host's state.
 *
 * specs/late_join_input_agreement.qnt is the model:
 * late_join_input_agreement_before (violated) and late_join_input_agreement_fixed
 * (joinerAppliesTheHostsInputs, pagesAgreeAroundTheJoin,
 * joinerNeutralBelowAdmission; joinerMissesTheTagsBelowFirstLiveTest,
 * pagesHearAtDifferentFramesTest, rosterAfterTheStateTest,
 * aPageThatHearsLateTakesTheHostsStateTest).
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * Whether a page runs the old Remix bootstrap for a join (a neutral window of
 * its own input, neutral placeholders for the others): only on Smash Remix,
 * and only in a match on the immediate rule (a page from before this rule is
 * in it, and runs the bootstrap).
 *
 * @param remix      the match runs Smash Remix
 * @param scheduled  the match is on the scheduled roster rule
 */
//@ ensures \result <==> remix && !scheduled
export function legacyBootstrap(remix: boolean, scheduled: boolean): boolean {
  return remix && !scheduled;
}

/**
 * Whether the host sends a joiner its confirmed inputs around the state's
 * frame (the late-join input bridge): on every ROM but Smash Remix, as
 * before, and on Smash Remix when the match is on the scheduled rule. A
 * joiner takes the bridge whenever the host sent one.
 *
 * @param remix      the match runs Smash Remix
 * @param scheduled  the host's controller-mask schedule is running
 */
//@ ensures \result <==> !remix || scheduled
export function bridgeOffered(remix: boolean, scheduled: boolean): boolean {
  return !remix || scheduled;
}

/**
 * Whether the joining page holds its own input of `tag` neutral: before it
 * has heard the roster that admits it (`rosterFrame` < 0), and below
 * rosterFrame + lead. Every other page holds the joiner's tags below the
 * roster frame as absent, and runs the joiner's tags as absent until it hears
 * the roster: a neutral input there agrees with both.
 *
 * @param tag          the tag the page makes an input for
 * @param rosterFrame  the frame of the host's roster that admits this page, or -1
 * @param lead         the frames from the roster frame to the frame the
 *                     joiner's controller is present from (MASK_LEAD)
 */
//@ requires lead >= 0
//@ ensures rosterFrame < 0 ==> \result
//@ ensures rosterFrame >= 0 ==> (\result <==> tag < rosterFrame + lead)
export function joinerHoldsOwnInput(tag: number, rosterFrame: number, lead: number): boolean {
  if (rosterFrame < 0) return true;
  return tag < rosterFrame + lead;
}

/**
 * Whether a page heard the roster that admits a joiner too late to agree on
 * its inputs: it has run a tag of the joiner at or past the joiner's hold
 * (rosterFrame + lead) as absent, where the joiner may have sent a real
 * input. It takes the host's state. A page that heard earlier ran only tags
 * the joiner holds neutral, and agrees.
 *
 * @param rosterFrame   the frame of the host's roster that admits the joiner
 * @param ranThroughTag the highest tag this page has applied (its frame - delay - 1)
 * @param lead          as for joinerHoldsOwnInput
 */
//@ requires lead >= 0
//@ ensures \result <==> ranThroughTag >= rosterFrame + lead
//@ ensures \result ==> !joinerHoldsOwnInput(ranThroughTag, rosterFrame, lead) || rosterFrame < 0
export function admittedLate(rosterFrame: number, ranThroughTag: number, lead: number): boolean {
  return ranThroughTag >= rosterFrame + lead;
}
