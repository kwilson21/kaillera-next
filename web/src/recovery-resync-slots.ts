/**
 * Which guests the host resyncs when a phantom is heard from again
 * (specs/phantom_settle.qnt, RESYNC_ALL).
 *
 * The host settles the recovered guest's inputs before the recovery frame:
 * its predictions for them are final. Another guest may hold that guest's
 * real inputs instead, so every player guest takes the host's state: the
 * recovered one and every other, except one still being admitted late (its
 * late-join state is on its way). Never the host's own slot (0), and each
 * slot once.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

//@ ensures forall(j: nat, j < \result.length ==> 1 <= \result[j] && \result[j] <= 3)
//@ ensures forall(j: nat, j < \result.length ==> playerSlots.includes(\result[j]))
//@ ensures forall(j: nat, j < \result.length ==> \result[j] === recovered || !pendingLateJoin.includes(\result[j]))
//@ ensures forall(k: nat, k < playerSlots.length && 1 <= playerSlots[k] && playerSlots[k] <= 3 && (playerSlots[k] === recovered || !pendingLateJoin.includes(playerSlots[k])) ==> \result.includes(playerSlots[k]))
//@ ensures forall(a: nat, forall(b: nat, a < b && b < \result.length ==> \result[a] !== \result[b]))
export function recoveryResyncSlots(playerSlots: number[], recovered: number, pendingLateJoin: number[]): number[] {
  const slots: number[] = [];
  let i = 0;
  while (i < playerSlots.length) {
    //@ invariant 0 <= i && i <= playerSlots.length
    //@ invariant forall(j: nat, j < slots.length ==> 1 <= slots[j] && slots[j] <= 3)
    //@ invariant forall(j: nat, j < slots.length ==> playerSlots.includes(slots[j]))
    //@ invariant forall(j: nat, j < slots.length ==> slots[j] === recovered || !pendingLateJoin.includes(slots[j]))
    //@ invariant forall(k: nat, k < i && 1 <= playerSlots[k] && playerSlots[k] <= 3 && (playerSlots[k] === recovered || !pendingLateJoin.includes(playerSlots[k])) ==> slots.includes(playerSlots[k]))
    //@ invariant forall(a: nat, forall(b: nat, a < b && b < slots.length ==> slots[a] !== slots[b]))
    //@ decreases playerSlots.length - i
    const slot = playerSlots[i]!;
    if (slot >= 1 && slot <= 3 && (slot === recovered || !pendingLateJoin.includes(slot)) && !slots.includes(slot)) {
      slots.push(slot);
    }
    i = i + 1;
  }
  return slots;
}
