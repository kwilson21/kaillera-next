/**
 * Where the desync detector's fields live in each ROM's RAM.
 *
 * The core's hash registry (build/kn_rollback/kn_hash_registry.c) hashes a
 * few pieces of game state every frame: stock counts, the scene, the RNG
 * seed and so on. Where those are is different in every game, so the
 * addresses are data: the page looks its ROM up here and installs the map
 * (`kn_field_map_set`) before the match starts. A ROM that is not here gets
 * no detector, because under the wrong map the fields would be hashes of
 * unrelated memory with SSB64's names on them.
 *
 * Adding a ROM, and what its map has to pass before it goes in, is
 * docs/address-maps.md.
 */

/** One entry per value the registry reads. Offsets are N64 RDRAM offsets (address & 0x00ffffff). */
export interface AddressMap {
  /** P1's stock count, one byte; the next player's is `playerStride` on. */
  readonly stocksBase: number;
  readonly playerStride: number;
  /** The current scene, one byte. */
  readonly sceneCurr: number;
  readonly vsBattleHeader: number;
  readonly vsBattleHeaderSize: number;
  /** The game's RNG seed, four bytes. */
  readonly rngSeed: number;
  /** P1's character-select struct; the next player's is `cssStride` on. */
  readonly cssBase: number;
  readonly cssStride: number;
  /** Offsets of three four-byte fields within that struct. */
  readonly cssCharId: number;
  readonly cssCursorState: number;
  readonly cssSelectedFlag: number;
  readonly ftMotionCount: number;
  /** Holds an N64 pointer to the fighter structs; `ftBufferSize` bytes are hashed from there. */
  readonly ftBufferPtr: number;
  readonly ftBufferSize: number;
}

/**
 * The order the registry takes the values in: the `KN_MAP_*` enum in
 * build/kn_rollback/kn_hash_registry.h. tests/ts/address-maps.test.ts reads
 * that header and fails if the two drift.
 */
export const ADDRESS_MAP_ORDER = [
  'stocksBase',
  'playerStride',
  'sceneCurr',
  'vsBattleHeader',
  'vsBattleHeaderSize',
  'rngSeed',
  'cssBase',
  'cssStride',
  'cssCharId',
  'cssCursorState',
  'cssSelectedFlag',
  'ftMotionCount',
  'ftBufferPtr',
  'ftBufferSize',
] as const satisfies readonly (keyof AddressMap)[];

/** The scene numbers the detector gates fields on. */
export interface SceneIds {
  readonly characterSelect: number;
  readonly stageSelect: number;
  readonly battle: number;
}

export interface RomAddresses {
  /** A short name for logs. */
  readonly name: string;
  readonly map: AddressMap;
  readonly scenes: SceneIds;
}

/** What the page hands the detector: the map packed in registry order. */
export interface PackedRomAddresses {
  readonly name: string;
  readonly values: readonly number[];
  readonly scenes: SceneIds;
}

/**
 * SSB64 US. Each address is cited to the decomp in
 * build/kn_rollback/kn_gameplay_addrs.h and kn_hash_registry.h, which hold
 * the same numbers as the registry's built-in map; tests/hash-golden checks
 * them against a RAM dump of a match.
 */
const SSB64_US: RomAddresses = {
  name: 'ssb64-us',
  map: {
    stocksBase: 0xa4f23,
    playerStride: 0x74,
    sceneCurr: 0xa4ad0,
    vsBattleHeader: 0xa4ef8,
    vsBattleHeaderSize: 32,
    rngSeed: 0x03b940,
    cssBase: 0x13ba88,
    cssStride: 0xbc,
    cssCharId: 0x48,
    cssCursorState: 0x54,
    cssSelectedFlag: 0x58,
    ftMotionCount: 0x130d94,
    ftBufferPtr: 0x130d84,
    ftBufferSize: 4096,
  },
  scenes: { characterSelect: 16, stageSelect: 21, battle: 22 },
};

/** ROM hash (as the page computes it: `S` + SHA-256) to its addresses. */
export const ROM_ADDRESSES = {
  S15592e79d3c5295cef4371d4992f0bd25bec2102fc29644c93e682f7ea99ef3d: SSB64_US,
} satisfies Record<string, RomAddresses>;

const hasMap = (romHash: string): romHash is keyof typeof ROM_ADDRESSES => Object.hasOwn(ROM_ADDRESSES, romHash);

const RDRAM_SIZE = 0x800000;
const SPAN_MAX = 0x10000;
const SPANS: ReadonlySet<keyof AddressMap> = new Set([
  'playerStride',
  'vsBattleHeaderSize',
  'cssStride',
  'cssCharId',
  'cssCursorState',
  'cssSelectedFlag',
  'ftBufferSize',
]);

/** Why the registry would refuse this map, or null if it would take it (`kn_field_map_set`'s rules). */
export const addressMapProblem = (map: AddressMap): string | null => {
  for (const key of ADDRESS_MAP_ORDER) {
    const value = map[key];
    const limit = SPANS.has(key) ? SPAN_MAX : RDRAM_SIZE;
    if (!Number.isInteger(value) || value < 0 || value >= limit) return `${key}=${value} is not in [0, ${limit})`;
  }
  if (map.vsBattleHeaderSize === 0) return 'vsBattleHeaderSize is 0';
  if (map.ftBufferSize === 0) return 'ftBufferSize is 0';
  return null;
};

export const packAddressMap = (map: AddressMap): number[] => ADDRESS_MAP_ORDER.map((key) => map[key]);

/** The addresses for a ROM, packed for the registry; null if the ROM has no map. */
export const addressMapFor = (romHash: string | null | undefined): PackedRomAddresses | null => {
  if (!romHash || !hasMap(romHash)) return null;
  const rom = ROM_ADDRESSES[romHash];
  return { name: rom.name, values: packAddressMap(rom.map), scenes: rom.scenes };
};
