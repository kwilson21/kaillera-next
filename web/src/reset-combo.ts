/** Ordinary N64 input: A, B, R, Z. Never resets a local emulator behind peers. */
export const RESET_COMBO_MASK = (1 << 0) | (1 << 1) | (1 << 11) | (1 << 12);

/** Matches specs/reset_combo.qnt: cancel/end never leaves shortcut input active. */
//@ ensures \result === (open && held && playing)
export function resetComboActive(open: boolean, held: boolean, playing: boolean): boolean {
  return open && held && playing;
}
