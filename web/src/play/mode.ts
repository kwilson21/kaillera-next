/**
 * How a match is played, as the play page reads it (the server's GameMode).
 *
 * - rollback: every player runs the game; a late input is guessed and the
 *   frames after it replayed when the guess was wrong.
 * - lockstep: every player runs the game; a frame runs only once every
 *   player's input for it is here. Nothing is guessed, so nothing is
 *   replayed, at the cost of waiting for the slowest connection.
 * - streaming: the host runs the game and the others watch a video of it.
 */
import type { GameMode } from '../protocol.gen.ts';

export type { GameMode };

/** A mode from a URL, a message or the picker; anything else is rollback. */
export const normalizeMode = (raw: string | null | undefined): GameMode =>
  raw === 'lockstep' || raw === 'streaming' || raw === 'rollback' ? raw : 'rollback';

/** Every player runs the emulator (and needs the ROM): rollback and lockstep. */
export const everyoneRunsTheGame = (mode: GameMode): boolean => mode !== 'streaming';
