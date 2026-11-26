import type { GameMode } from '../protocol.gen.ts';

export type PlayMode = Exclude<GameMode, 'lockstep'>;

export const canonicalMode = (mode: GameMode): PlayMode => (mode === 'lockstep' ? 'classic' : mode);

export const normalizeMode = (raw: string | null | undefined): PlayMode =>
  raw === 'classic' || raw === 'lockstep' || raw === 'streaming' ? canonicalMode(raw) : 'rollback';

export const modeLabel = (mode: PlayMode): string =>
  mode === 'classic' ? 'Classic' : mode === 'streaming' ? 'Streaming' : 'Rollback';

/** Every player runs the emulator (and needs the ROM) in Rollback and Classic. */
export const everyoneRunsTheGame = (mode: GameMode): boolean => mode !== 'streaming';
