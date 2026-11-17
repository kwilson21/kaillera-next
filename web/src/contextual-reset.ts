/** Read-only capability detection for exact ROMs; unknown state never enables input. */
export const SSB64_US_HASH = 'S15592e79d3c5295cef4371d4992f0bd25bec2102fc29644c93e682f7ea99ef3d';
export const REMIX_201_HASH = 'S7efec9e0983656bb0219a23c511cd1505a5f84d524e50ad4284dc1c7eb4d1403';
export type PauseMode = 'normal' | '12cb';
export interface NativePause {
  readonly owner: number;
  readonly mode: PauseMode;
  readonly requested: boolean;
}
export type ReadWord = (address: number) => number | null;

export { contextualResetIntent } from './contextual-reset-intent.ts';

const inRam = (address: number): boolean => address >= 0x80000000 && address <= 0x807ffffc && address % 4 === 0;
/** Only the known LUI/ORI/LW sequence emitted by Remix 2.0.1's `li` is accepted. */
const loadedAddress = (read: ReadWord, pc: number, register: number, loadedRegister: number): number | null => {
  if (!inRam(pc) || !inRam(pc + 8)) return null;
  const hi = read(pc),
    lo = read(pc + 4),
    load = read(pc + 8);
  if (hi === null || lo === null || load === null) return null;
  if (hi >>> 16 !== (0x3c00 | register) || lo >>> 16 !== (0x3400 | (register << 5) | register)) return null;
  if (load >>> 0 !== (0x8c000000 | (register << 21) | (loadedRegister << 16)) >>> 0) return null;
  const address = (((hi & 0xffff) << 16) | (lo & 0xffff)) >>> 0;
  return inRam(address) ? address : null;
};

/**
 * Exact release source: JSsixtyfour/smashremix@5e04fe7f, TwelveCharBattle.asm,
 * gentlemens_reset_. The hook at 0x801144D0 calls a routine that reads the
 * mode flag, branches to _12cb_continue, then reads reset_requested.
 * Resolve only those fully checked instructions; never scan/guess RAM.
 * This is read-only and fails closed if another build changes the signature.
 */
export const readRemixResetPhase = (read: ReadWord): { mode: PauseMode; requested: boolean } | null => {
  const hook = read(0x801144d0);
  if (hook === null || hook >>> 26 !== 3) return null;
  const entry = (0x80000000 | ((hook & 0x03ffffff) << 2)) >>> 0;
  const modeAddress = loadedAddress(read, entry, 15, 15);
  if (modeAddress === null) return null;
  const branch = read(entry + 12);
  if (branch === null || branch >>> 16 !== 0x15e0 || read(entry + 16) !== 0) return null;
  const offset = (branch << 16) >> 16;
  const requestEntry = entry + 16 + offset * 4;
  const requestAddress = loadedAddress(read, requestEntry, 8, 15);
  if (requestAddress === null || requestAddress === modeAddress) return null;
  const mode = read(modeAddress),
    requested = read(requestAddress);
  if ((mode !== 0 && mode !== 1) || (requested !== 0 && requested !== 1)) return null;
  return { mode: mode === 1 ? '12cb' : 'normal', requested: mode === 1 && requested === 1 };
};

/** Source: ssb-decomp-re symbols_us.txt and ifCommonBattlePauseUpdateInterface. */
export const readNativePause = (romHash: string | null, read: ReadWord): NativePause | null => {
  if (romHash !== SSB64_US_HASH && romHash !== REMIX_201_HASH) return null;
  const scene = read(0x800a4ad0),
    pointer = read(0x800a50e8),
    ownerWord = read(0x801317e4);
  if (scene === null || scene >>> 24 !== 22 || ownerWord === null) return null;
  if (pointer !== 0x800a4d08 && pointer !== 0x800a4ef8) return null;
  const status = read(pointer + 0x10);
  if (status === null || ((status >>> 16) & 255) !== 2) return null;
  const owner = ownerWord >>> 24;
  if (owner > 3) return null;
  if (romHash === SSB64_US_HASH) return { owner, mode: 'normal', requested: false };
  const phase = readRemixResetPhase(read);
  if (phase === null || (phase.mode === '12cb' && owner > 1)) return null;
  return { owner, ...phase };
};
