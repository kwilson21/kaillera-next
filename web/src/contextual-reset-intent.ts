/** 0=disabled, 1=normal reset, 2=12CB request, 3=12CB approval. */
//@ ensures (!supported || !paused || !active || owner !== localSlot || localSlot < 0 || localSlot > 3) ==> \result === 0
//@ ensures \result > 0 ==> supported && paused && active && owner === localSlot && localSlot >= 0 && localSlot <= 3
//@ ensures twelve && (owner < 0 || owner > 1) ==> \result === 0
export function contextualResetIntent(
  supported: boolean,
  paused: boolean,
  active: boolean,
  owner: number,
  localSlot: number,
  twelve: boolean,
  requested: boolean,
): number {
  if (!supported || !paused || !active || owner !== localSlot || localSlot < 0 || localSlot > 3) return 0;
  if (twelve && (owner < 0 || owner > 1)) return 0;
  return twelve ? (requested ? 3 : 2) : 1;
}
