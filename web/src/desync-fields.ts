/**
 * Which game-state fields the desync detector flags when two peers' digests
 * for the same frame differ.
 *
 * A digest is one hash per field for one frame; the field ids mirror
 * `KN_FIELD_*` in build/kn_rollback/kn_hash_registry.h. The detector
 * (web/static/kn-desync-detector.js) builds and exchanges the digests and
 * emits the `desync-suspect` events; the decision of what to flag is here:
 *
 *   - If the peers disagree on the match phase, that alone is flagged and
 *     nothing else is compared for the frame: every other field would differ
 *     for the same reason.
 *   - Otherwise each differing field is flagged if it means something in the
 *     scene of that frame (stocks only in a battle, cursors only on the character
 *     select screen) and it was not flagged in the last `dedupWindow` frames.
 *
 * Verified with LemmaScript (Dafny backend; see LemmaScript-files.txt): a
 * field is never flagged while its two hashes are equal.
 */

/** The number of fields in a digest (`KN_FIELD_COUNT`). */
export const FIELD_COUNT = 21;
/** The id of the match-phase field (`KN_FIELD_MATCH_PHASE`). */
export const MATCH_PHASE_FIELD = 17;

/** Scene ids the game reports (`kn_get_scene_curr`). */
export const SCENE_IN_GAME_VS = 22;
export const SCENE_CSS_VS = 16;

/**
 * The player slot a per-player field belongs to, or null for a field of the
 * whole game. Fields 0-15 are four groups of four: stocks, character id,
 * character-select cursor and character-select choice, one per slot.
 */
//@ requires 0 <= fid
//@ ensures fid <= 15 ==> \result !== null
//@ ensures fid > 15 ==> \result === null
export function slotForField(fid: number): number | null {
  if (fid <= 3) return fid;
  if (fid <= 7) return fid - 4;
  if (fid <= 11) return fid - 8;
  if (fid <= 15) return fid - 12;
  return null;
}

/** The name a field is reported under; per-player fields share one name. */
export function fieldName(fid: number): string {
  if (fid <= 3) return 'stocks';
  if (fid <= 7) return 'character_id';
  if (fid <= 11) return 'css_cursor';
  if (fid <= 15) return 'css_selected';
  if (fid === 16) return 'rng';
  if (fid === 17) return 'match_phase';
  if (fid === 18) return 'vs_battle_hdr';
  if (fid === 19) return 'physics_motion';
  return 'ft_buffer';
}

/**
 * Whether a difference in this field means anything in the current scene.
 * Stocks and the battle-only fields (18-20) hold leftovers outside a battle,
 * and the character-select fields (8-15) outside that screen.
 */
export function fieldEligibleInPhase(fid: number, phase: number): boolean {
  if (fid <= 3 || fid === 18 || fid === 19 || fid === 20) return phase === SCENE_IN_GAME_VS;
  if (8 <= fid && fid <= 15) return phase === SCENE_CSS_VS;
  return true;
}

/**
 * The fields to flag for one pair of digests of frame `frame`.
 *
 * @param ha, hb        the two peers' hashes, indexed by field id
 * @param phase         the scene the digests' frame was in (read from the
 *                      digest, which is a rollback window old; unused when
 *                      the peers disagree on the match phase)
 * @param lastFlagged   the frame each field was last flagged on, -1 if never
 * @param dedupWindow   frames a flagged field stays quiet for
 */
//@ requires ha.length >= 21 && hb.length >= 21 && lastFlagged.length >= 21
//@ ensures \result.length <= 21
//@ ensures forall(j: nat, j < \result.length ==> 0 <= \result[j] && \result[j] < 21 && ha[\result[j]] !== hb[\result[j]])
//@ ensures ha[17] !== hb[17] ==> \result.length === 1 && \result[0] === 17
//@ ensures ha[17] === hb[17] ==> forall(j: nat, j < \result.length ==> 0 <= \result[j] && \result[j] < 21 && \result[j] !== 17 && fieldEligibleInPhase(\result[j], phase) && frame - lastFlagged[\result[j]] >= dedupWindow)
export function fieldsToFlag(
  ha: number[],
  hb: number[],
  phase: number,
  frame: number,
  lastFlagged: number[],
  dedupWindow: number,
): number[] {
  if (ha[17] !== hb[17]) return [17];
  const flagged: number[] = [];
  let fid = 0;
  while (fid < 21) {
    //@ invariant 0 <= fid && fid <= 21
    //@ invariant flagged.length <= fid
    //@ invariant forall(j: nat, j < flagged.length ==> 0 <= flagged[j] && flagged[j] < 21 && ha[flagged[j]] !== hb[flagged[j]] && flagged[j] !== 17 && fieldEligibleInPhase(flagged[j], phase) && frame - lastFlagged[flagged[j]] >= dedupWindow)
    //@ decreases 21 - fid
    if (
      fid !== 17 &&
      ha[fid] !== hb[fid] &&
      fieldEligibleInPhase(fid, phase) &&
      frame - lastFlagged[fid]! >= dedupWindow
    ) {
      flagged.push(fid);
    }
    fid = fid + 1;
  }
  return flagged;
}
