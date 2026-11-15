/**
 * Which of a peer's inputs a page asks that peer to send again while it
 * waits for them.
 *
 * A page that is far behind drops a peer's inputs for frames too far ahead
 * of its own (INPUT-OOR in web/static/netplay-rollback.js). The peer sends
 * each input once, so when the page catches up to those frames it waits on
 * a hole nothing will fill. After a freeze both pages then waited on each
 * other until the resync's deadline, and when that ran late they gave up on
 * each other and split again (a two-player run, 2026-11).
 * specs/resync_inputs.qnt models it: `aDueResyncIsNotLeftToItsDeadline` is
 * violated without asking (resync_inputs_no_ask) and holds with it
 * (`ask` there is this rule).
 *
 * The page asks only for frames it waits for and knows the peer has made:
 * at or before the newest input of the peer's it received or dropped. A
 * request for an input the peer no longer has is ignored there.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * The frames to ask for, oldest first.
 *
 * @param have     have[i]: this page holds the peer's input for frame from + i
 * @param from     the oldest frame this page may still wait for (the
 *                 rollback window's edge, or the peer's settled point if later)
 * @param through  the newest frame it waits for now (the frame being applied)
 * @param peerHas  the newest frame the peer is known to have made
 * @param max      ask for at most this many at once
 */
//@ requires from >= 0 && max >= 0
//@ requires through - from < have.length
//@ ensures \result.length <= max
//@ ensures forall(j: nat, j < \result.length ==> from <= \result[j] && \result[j] <= through && \result[j] <= peerHas && !have[\result[j] - from])
//@ ensures forall(j: nat, j + 1 < \result.length ==> \result[j] < \result[j + 1])
export function framesToAskFor(have: boolean[], from: number, through: number, peerHas: number, max: number): number[] {
  const asked: number[] = [];
  const last = through < peerHas ? through : peerHas;
  let f = from;
  while (f <= last && asked.length < max) {
    //@ invariant from <= f
    //@ invariant asked.length <= max
    //@ invariant forall(j: nat, j < asked.length ==> from <= asked[j] && asked[j] < f && asked[j] <= last && !have[asked[j] - from])
    //@ invariant forall(j: nat, j + 1 < asked.length ==> asked[j] < asked[j + 1])
    //@ decreases last + 1 - f
    if (!have[f - from]) asked.push(f);
    f = f + 1;
  }
  return asked;
}
