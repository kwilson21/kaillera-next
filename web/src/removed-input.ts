/**
 * What a player the host removes from the match is fed with, frame by frame:
 * the rules of the cut.
 *
 * Every page applies each slot's input of tag `frame - delay` on `frame`.
 * When the host removed a player, each page used to stop applying that
 * player's inputs at whatever frame it was on when it learned of the
 * removal: the host when it dropped it (kn_rollback_slot_reset empties the
 * slot's input ring, and an empty slot reads neutral), a guest when the
 * `roster:` message arrived. The frames in between ran with different inputs
 * for that player on different pages, and nothing ran them again; a replay
 * after the reset even ran frames from before the switch with neutral input.
 *
 * Now the cut is at the host's roster frame R on every page, by frame:
 *   - tags from `cutTag` (R - delay) on are neutral until the player is
 *     admitted again (`admissionFloor`);
 *   - tags below it are what the host applied: at the cut the host freezes
 *     the slot (it takes no more of the player's input, so its ring below the
 *     cut is final, predictions included) and sends those inputs, the last
 *     `wordSpan` tags, before the roster (`roster-cut:`); every page writes
 *     them into its ring as real inputs, so a replay runs them again
 *     unchanged;
 *   - a page that has run a frame with another input than that
 *     (`firstDiffering`) runs again from it: from its own ring when the ring
 *     still holds that frame, else from the host's state (`rerunStep`).
 *
 * specs/removed_input.qnt is the model: removed_input_before (violated) and
 * removed_input_fixed (removedInputAgrees, aReplayKeepsTheCut,
 * hostRunsItsWord; guestAheadTest, guestBehindTest, hostPredictedTest,
 * replayAfterTheCutTest, quickRejoinTest).
 *
 * The message's wire form is removed-input-wire.ts, which is not verified;
 * the rules here are.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * The floor `admissionFloor` returns for a slot the cut governs: no input of
 * it is taken in until it is admitted again.
 */
export const NO_INPUT_TAKEN = 9007199254740991;

/**
 * The first input tag a removal at the host's roster frame `rosterFrame`
 * makes neutral: the one the host's frame `rosterFrame` applies.
 */
//@ ensures \result === rosterFrame - delay
export function cutTag(rosterFrame: number, delay: number): number {
  return rosterFrame - delay;
}

/**
 * How many tags below the cut the host sends its inputs for: the ones a page
 * can still run again from its own ring. A page is at most `pacing` frames
 * behind the host (kn_pre_tick's pacing gate) and its ring holds its last
 * `ringFrames` frames, each applying the tag `delay` below it.
 */
//@ requires ringFrames >= 0 && delay >= 0 && pacing >= 0
//@ ensures \result === ringFrames + delay + pacing
//@ ensures \result >= 0
export function wordSpan(ringFrames: number, delay: number, pacing: number): number {
  return ringFrames + delay + pacing;
}

/**
 * The oldest input tag a slot takes in: `first` once it is admitted again
 * (the host's roster frame that admits it, the late joiner's floor), none
 * while the cut governs it (`cut` set, not admitted), and any (0) when the
 * slot was never removed under this rule.
 *
 * @param first  the admission's floor, or -1 while the slot is not admitted again
 * @param cut    the cut's tag, or -1 when no cut governs the slot
 */
//@ ensures first >= 0 ==> \result === first
//@ ensures first < 0 && cut >= 0 ==> \result === NO_INPUT_TAKEN
//@ ensures first < 0 && cut < 0 ==> \result === 0
export function admissionFloor(first: number, cut: number): number {
  if (first >= 0) return first;
  if (cut >= 0) return NO_INPUT_TAKEN;
  return 0;
}

/**
 * The first place two runs of inputs differ, or -1 when they agree: `ran` is
 * what this page applied for the removed player on consecutive tags, `rule`
 * what the cut says it applies there (each input packed into one number, the
 * same way on both sides).
 */
//@ requires ran.length === rule.length
//@ ensures -1 <= \result && \result < ran.length
//@ ensures \result >= 0 ==> ran[\result] !== rule[\result]
//@ ensures \result >= 0 ==> forall(k: nat, k < \result ==> ran[k] === rule[k])
//@ ensures \result < 0 ==> forall(k: nat, k < ran.length ==> ran[k] === rule[k])
export function firstDiffering(ran: number[], rule: number[]): number {
  let i = 0;
  while (i < ran.length) {
    //@ invariant 0 <= i && i <= ran.length
    //@ invariant forall(k: nat, k < i ==> ran[k] === rule[k])
    //@ decreases ran.length - i
    if (ran[i] !== rule[i]) return i;
    i = i + 1;
  }
  return -1;
}

/** What a page does about frames it ran with other inputs than a cut gives. */
export type RerunStep = 'nothing' | 'local' | 'host';

/**
 * What a page does once it has written the cut into its ring: nothing when
 * it ran no frame with another input (`lateFrame` -1), else it runs again
 * from `lateFrame`: from its own ring (`local`) when the ring still holds
 * that frame (the newest `ringFrames` frames below `frame`, the frame it is
 * on) and nothing else is under way, or from the host's state (`host`).
 *
 * @param lateFrame   the first frame it ran with another input, or -1
 * @param frame       the frame it is on
 * @param ringFrames  how many frames before `frame` its ring holds
 * @param canRerun    no replay, catch-up or state load is under way, and the core can run frames again
 */
//@ requires ringFrames >= 0
//@ ensures \result === "nothing" <==> lateFrame < 0
//@ ensures \result === "local" <==> lateFrame >= 0 && canRerun && lateFrame < frame && frame - lateFrame <= ringFrames
//@ ensures \result === "host" <==> lateFrame >= 0 && !(canRerun && lateFrame < frame && frame - lateFrame <= ringFrames)
export function rerunStep(lateFrame: number, frame: number, ringFrames: number, canRerun: boolean): RerunStep {
  if (lateFrame < 0) return 'nothing';
  if (canRerun && lateFrame < frame && frame - lateFrame <= ringFrames) return 'local';
  return 'host';
}
