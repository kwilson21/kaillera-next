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

/**
 * A game's scene numbers: what its "current scene" byte reads on each
 * screen the netcode cares about. They mean nothing across games, so nothing
 * outside this table may compare a scene with a literal number.
 */
export interface SceneIds {
  readonly characterSelect: number;
  readonly stageSelect: number;
  /** A match in play (the game's status byte says whether it has begun, is paused, or is over). */
  readonly battle: number;
  /** The title screen. */
  readonly title: number;
  /**
   * The menus a player steers with single presses, as an inclusive range:
   * mode select through stage select. One predicted or invented press there
   * puts peers on different paths.
   */
  readonly menuFirst: number;
  readonly menuLast: number;
}

export interface RomAddresses {
  /** A short name for logs. */
  readonly name: string;
  readonly map: AddressMap;
  readonly scenes: SceneIds;
  /**
   * Where the battle header says a match is under way: a byte at `offset`
   * within it reads `ongoing`. Not hashed; the verifier in
   * tests/rb-two-player.mjs uses it to tell the live battle state from a
   * dormant copy of it.
   */
  readonly battleStatus: BattleStatus;
}

export interface BattleStatus {
  readonly offset: number;
  readonly ongoing: number;
}

/** What the page hands the detector: the map packed in registry order. */
export interface PackedRomAddresses {
  readonly name: string;
  readonly values: readonly number[];
  readonly scenes: SceneIds;
  readonly battleStatus: BattleStatus;
}

/**
 * SSB64 US. Each address is cited to the decomp in
 * build/kn_rollback/kn_gameplay_addrs.h and kn_hash_registry.h.
 *
 * The battle state is the struct the game is running the match from:
 * gSCManagerTransferBattleState at 0x800A4D08, which gSCManagerBattleState
 * (0x800A50E8) points at for a normal VS match. gSCManagerVSBattleState at
 * 0x800A4EF8, which this map used to name, is only used for sudden death;
 * during a match its status stays 0 and its stock counts stay 0, so hashes
 * of it never differed whatever the peers did. tests/hash-golden reads both
 * from a RAM dump of a match.
 */
const SSB64_US: RomAddresses = {
  name: 'ssb64-us',
  map: {
    stocksBase: 0xa4d33,
    playerStride: 0x74,
    sceneCurr: 0xa4ad0,
    vsBattleHeader: 0xa4d08,
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
  // nSCKindTitle, nSCKindModeSelect .. nSCKindMaps, nSCKindVSBattle (ssb-decomp scdef.h).
  scenes: { characterSelect: 16, stageSelect: 21, battle: 22, title: 1, menuFirst: 7, menuLast: 21 },
  battleStatus: { offset: 0x11, ongoing: 1 },
};

/**
 * Smash Remix 2.0.1. Remix is built on SSB64 US and leaves these globals
 * where they are. One address has a source: smashremix/src/Global.asm:165
 * gives `game_status` as 0x800A4D19, the status byte of the battle state at
 * 0x800A4D08. The rest are SSB64's, taken on the evidence of
 * docs/address-maps.md steps 3 to 5 run on this ROM: the verifier's checks
 * pass, healthy matches raise no flag, and a changed stock count is flagged.
 * Other Remix releases are other ROM hashes and have no map until those
 * steps are run on them.
 */
const SMASH_REMIX_2_0_1: RomAddresses = { ...SSB64_US, name: 'smash-remix-2.0.1' };

/** ROM hash (as the page computes it: `S` + SHA-256) to its addresses. */
export const ROM_ADDRESSES = {
  S15592e79d3c5295cef4371d4992f0bd25bec2102fc29644c93e682f7ea99ef3d: SSB64_US,
  S7efec9e0983656bb0219a23c511cd1505a5f84d524e50ad4284dc1c7eb4d1403: SMASH_REMIX_2_0_1,
} satisfies Record<string, RomAddresses>;

const hasMap = (romHash: string): romHash is keyof typeof ROM_ADDRESSES => Object.hasOwn(ROM_ADDRESSES, romHash);

const RDRAM_SIZE = 0x800000;
const PLAYERS = 4;
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

/**
 * Why this map must not be installed, or null if it is sound. It covers
 * `kn_field_map_set`'s own rules (every entry in range) and one the registry
 * does not check: that every read the map leads to stays inside RDRAM. A
 * read that runs off the end hashes to 0 in the registry, which the
 * detector takes for "no data", so the field would silently go unchecked.
 */
export const addressMapProblem = (map: AddressMap): string | null => {
  for (const key of ADDRESS_MAP_ORDER) {
    const value = map[key];
    const limit = SPANS.has(key) ? SPAN_MAX : RDRAM_SIZE;
    if (!Number.isInteger(value) || value < 0 || value >= limit) return `${key}=${value} is not in [0, ${limit})`;
  }
  if (map.vsBattleHeaderSize === 0) return 'vsBattleHeaderSize is 0';
  if (map.ftBufferSize === 0) return 'ftBufferSize is 0';
  const lastPlayer = PLAYERS - 1;
  const reads: readonly (readonly [string, number])[] = [
    ["the last player's stock count", map.stocksBase + lastPlayer * map.playerStride + 1],
    ['sceneCurr', map.sceneCurr + 1],
    ['the battle header', map.vsBattleHeader + map.vsBattleHeaderSize],
    ['rngSeed', map.rngSeed + 4],
    ["the last player's cssCharId", map.cssBase + lastPlayer * map.cssStride + map.cssCharId + 4],
    ["the last player's cssCursorState", map.cssBase + lastPlayer * map.cssStride + map.cssCursorState + 4],
    ["the last player's cssSelectedFlag", map.cssBase + lastPlayer * map.cssStride + map.cssSelectedFlag + 4],
    ['ftMotionCount', map.ftMotionCount + 4],
    ['ftBufferPtr', map.ftBufferPtr + 4],
  ];
  for (const [what, end] of reads) {
    if (end > RDRAM_SIZE) return `${what} would be read past the end of RDRAM`;
  }
  return null;
};

export const packAddressMap = (map: AddressMap): number[] => ADDRESS_MAP_ORDER.map((key) => map[key]);

/** The addresses for a ROM, packed for the registry; null if the ROM has no map. */
/**
 * Scene numbers by game, for a ROM of a known game whose build is not in
 * `ROM_ADDRESSES` (its addresses are unverified, but a romhack keeps the
 * base game's scene numbering).
 */
const SCENES_BY_GAME = {
  ssb64: SSB64_US.scenes,
  'smash-remix': SSB64_US.scenes,
} satisfies Record<string, SceneIds>;

const isDescribedGame = (gameId: string): gameId is keyof typeof SCENES_BY_GAME =>
  Object.hasOwn(SCENES_BY_GAME, gameId);

/**
 * The scene numbers of the game a page is running: the ROM's own entry, or
 * its game's, or null for a game nobody has described. With null the
 * netcode treats every scene alike.
 */
export const scenesFor = (romHash: string | null | undefined, gameId: string | null | undefined): SceneIds | null => {
  if (romHash && hasMap(romHash)) return ROM_ADDRESSES[romHash].scenes;
  if (gameId && isDescribedGame(gameId)) return SCENES_BY_GAME[gameId];
  return null;
};

export const addressMapFor = (romHash: string | null | undefined): PackedRomAddresses | null => {
  if (!romHash || !hasMap(romHash)) return null;
  const rom = ROM_ADDRESSES[romHash];
  // The table is checked by its tests; this keeps an unsound entry from
  // reaching the core if one ever slips in.
  if (addressMapProblem(rom.map) !== null) return null;
  return { name: rom.name, values: packAddressMap(rom.map), scenes: rom.scenes, battleStatus: rom.battleStatus };
};
