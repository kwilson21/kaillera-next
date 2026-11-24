/** An install receipt is counted only once per authenticated roster slot. */
//@ ensures \result === (slot === 0 && current && (players === 3 || players === 4) && receipts === players && matching)
export function canCommitCheckpoint(
  slot: number,
  current: boolean,
  players: number,
  receipts: number,
  matching: boolean,
): boolean {
  return slot === 0 && current && (players === 3 || players === 4) && receipts === players && matching;
}
