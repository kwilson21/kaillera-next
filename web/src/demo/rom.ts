/**
 * The ROM a visitor drops on the demo page: which files it takes, and the
 * hash it gives the engine. Moved from web/static/demo.js unchanged in
 * behaviour.
 */
import { hashRom } from '../play/rom.ts';

/** The demo takes a raw ROM only (`.z64`, `.n64`, `.v64`), never an archive. */
export const isRawRomName = (name: string): boolean => /\.(z64|n64|v64)$/i.test(name);

/**
 * The ROM's SHA-256 as the engine's ROM tables hold it (`S` and 64 hex
 * digits), or null when the browser cannot compute it. The engine picks its
 * RDRAM addresses by this hash, so the demo gives it a real SHA-256 or
 * nothing: unlike the play page (`hashRom`), it does not fall back to a
 * weaker hash where `crypto.subtle` is missing.
 */
export const demoRomHash = async (bytes: ArrayBuffer): Promise<string | null> => {
  if (globalThis.crypto?.subtle === undefined) return null;
  try {
    return await hashRom(bytes);
  } catch {
    return null;
  }
};
