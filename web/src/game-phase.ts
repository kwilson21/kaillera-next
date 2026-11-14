/**
 * What a game is doing, read from its scene and status bytes: the question
 * the engine asks every tick to decide whether a frame may be predicted.
 * The scene numbers are the game's own (web/src/address-maps.ts); this says
 * what they mean to the netcode.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * Where a match stands. `elsewhere`: not in the game's match scene, or the game
 * has no scene table (`battleScene` below zero). `starting`: in the match
 * scene before play begins. `playing`: play is on. `paused`: a player
 * paused it. `other`: any other status, such as the match being over.
 */
export type MatchState = 'elsewhere' | 'starting' | 'playing' | 'paused' | 'other';

/**
 * `status` is the game's match status byte: 0 waiting to start, 1 under
 * way, 2 paused. `battleScene` is the game's scene number for a match, or a
 * negative number when the game has none described.
 */
//@ ensures (battleScene < 0 || scene !== battleScene) ==> \result === "elsewhere"
//@ ensures battleScene >= 0 && scene === battleScene && status === 0 ==> \result === "starting"
//@ ensures battleScene >= 0 && scene === battleScene && status === 1 ==> \result === "playing"
//@ ensures battleScene >= 0 && scene === battleScene && status === 2 ==> \result === "paused"
//@ ensures \result === "other" ==> battleScene >= 0 && scene === battleScene && status !== 0 && status !== 1 && status !== 2
export function matchState(scene: number, status: number, battleScene: number): MatchState {
  if (battleScene < 0 || scene !== battleScene) return 'elsewhere';
  if (status === 0) return 'starting';
  if (status === 1) return 'playing';
  if (status === 2) return 'paused';
  return 'other';
}

/**
 * Whether `scene` is one of the game's menus steered by single presses: its
 * title screen, or anything from `menuFirst` to `menuLast`. Never, for a
 * game with no scene table (the three are negative).
 */
//@ ensures (title < 0 || menuFirst < 0 || menuLast < 0) ==> !\result
//@ ensures title >= 0 && menuFirst >= 0 && menuLast >= 0 && scene === title ==> \result
//@ ensures title >= 0 && menuFirst >= 0 && menuLast >= 0 && menuFirst <= scene && scene <= menuLast ==> \result
//@ ensures \result ==> scene === title || (menuFirst <= scene && scene <= menuLast)
export function isSteeredMenu(scene: number, title: number, menuFirst: number, menuLast: number): boolean {
  if (title < 0 || menuFirst < 0 || menuLast < 0) return false;
  return scene === title || (menuFirst <= scene && scene <= menuLast);
}
