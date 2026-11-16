/**
 * ROM identity: how a ROM is named, sized, hashed and compared. Moved from
 * web/static/play.js unchanged in behaviour; play.js reads these from
 * `window.KNCore.play`.
 */

/** The host's ROM as the room knows it. Any part may be unknown. */
export type HostRom = {
  readonly hash: string | null;
  readonly name: string | null;
  readonly size: number | null;
  readonly gameId: string | null;
};

type NestedHostRom = {
  readonly hash?: string | null;
  readonly name?: string | null;
  readonly size?: number | string | null;
  readonly gameId?: string | null;
  readonly game_id?: string | null;
};

/**
 * Where the host's ROM can be read from: `users-updated`, `game-started`, the
 * `join-room` ack and the REST `/room/<code>` body spell the same facts in
 * camelCase, in snake_case, and nested under `hostRom`.
 */
export type HostRomSource = {
  readonly romHash?: string | null;
  readonly rom_hash?: string | null;
  readonly romName?: string | null;
  readonly rom_name?: string | null;
  readonly romSize?: number | string | null;
  readonly rom_size?: number | string | null;
  readonly gameId?: string | null;
  readonly game_id?: string | null;
  readonly hostRom?: NestedHostRom | null;
};

/** The host's ROM out of any of those payloads; the flat camelCase key wins. */
export const hostRomFromData = (data: HostRomSource | null | undefined): HostRom => {
  const hostRom: NestedHostRom = data?.hostRom ?? {};
  const size = data?.romSize ?? data?.rom_size ?? hostRom.size ?? null;
  return {
    hash: data?.romHash ?? data?.rom_hash ?? hostRom.hash ?? null,
    name: data?.romName ?? data?.rom_name ?? hostRom.name ?? null,
    size: size === null ? null : Number(size),
    gameId: data?.gameId ?? data?.game_id ?? hostRom.gameId ?? hostRom.game_id ?? null,
  };
};

/**
 * One string that changes when the host's ROM does: by hash when there is
 * one, by name and size before the hash is known, empty for no ROM at all.
 */
export const hostRomIdentityKey = (hash: string | null, name: string | null, size: number | null): string => {
  if (hash) return `h:${hash}:${size ?? ''}`;
  if (name || size !== null) return `n:${name || ''}:${size ?? ''}`;
  return '';
};

/** `16 MB`, `1.5 MB`, `512 KB`, `12 B`; empty for an unknown or zero size. */
export const formatRomSize = (bytes: number | string | null | undefined): string => {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
};

/**
 * True when two ROM hashes definitely differ. A hash starts with its
 * algorithm (`S` SHA-256, `F` FNV-1a); two pages that could not use the same
 * one (a host on localhost, a guest on plain-HTTP LAN) cannot be compared, and
 * that is not a mismatch. Neither is a missing hash.
 */
export const romHashMismatch = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) return false;
  if (a[0] !== b[0]) return false;
  return a !== b;
};

const hex8 = (n: number): string => '00000000'.concat(n.toString(16)).slice(-8);

/** FNV-1a over the odd and the even bytes, as `F` + 16 hex digits. */
export const fnvRomHash = (bytes: Uint8Array): string => {
  let odd = 0x811c9dc5 >>> 0;
  let even = 0x811c9dc5 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    if (i & 1) {
      odd = Math.imul((odd ^ byte) >>> 0, 0x01000193) >>> 0;
    } else {
      even = Math.imul((even ^ byte) >>> 0, 0x01000193) >>> 0;
    }
  }
  return `F${hex8(odd)}${hex8(even)}`;
};

/**
 * A ROM's hash, tagged with its algorithm. `crypto.subtle` needs a secure
 * context (HTTPS or localhost); on a LAN address over HTTP this falls back to
 * FNV-1a, which is enough to notice two different ROMs.
 */
export const hashRom = async (buffer: ArrayBuffer): Promise<string> => {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return fnvRomHash(new Uint8Array(buffer));
  const digest = new Uint8Array(await subtle.digest('SHA-256', buffer));
  let hex = '';
  for (const byte of digest) hex += `0${byte.toString(16)}`.slice(-2);
  return `S${hex}`;
};

const ROM_EXTENSIONS = ['.z64', '.n64', '.v64', '.ndd'];

/** A ROM found inside an archive: its file name without folders, and its bytes. */
export type ArchivedRom = { readonly name: string; readonly data: Uint8Array };

/**
 * The first non-empty ROM file among an archive's entries (as fflate's
 * `unzipSync` returns them), or null when it holds none.
 */
export const romFromArchive = (entries: Readonly<Record<string, Uint8Array>>): ArchivedRom | null => {
  for (const [fileName, data] of Object.entries(entries)) {
    const lower = fileName.toLowerCase();
    if (ROM_EXTENSIONS.some((ext) => lower.endsWith(ext)) && data.length > 0) {
      return { name: fileName.split('/').pop() ?? fileName, data };
    }
  }
  return null;
};
