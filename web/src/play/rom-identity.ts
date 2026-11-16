/**
 * Which ROM a page judges against the host's and announces to the server,
 * while a ROM it was given may still be being hashed (specs/rom_identity.qnt).
 * The decisions of `hostRomMismatch` and `notifyRomReady` in
 * web/static/play.js.
 *
 * A load is each change of the page's ROM: a drop, a pick from the ROM
 * library, a ROM from the host, a clear. A dropped file is the page's at once
 * (its name and size), but its hash lands from a FileReader a moment later,
 * so the page keeps each hash with the load it was computed for. Until the
 * loaded ROM's own hash is in, the previous ROM's hash says nothing about it.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * `noRom`: the page holds no ROM. `pending`: its hash is still being computed
 * and nothing yet says it is not the host's. `match`: nothing says it is not
 * the host's (or the host's is not known). `mismatch`: it is not the host's.
 */
export type RomVerdict = 'noRom' | 'pending' | 'match' | 'mismatch';

/**
 * The hash the page holds is its loaded ROM's own: it was computed for the
 * load the page holds. A hash that lands for an earlier load (the player
 * dropped or picked another ROM meanwhile) is not.
 */
//@ ensures \result <==> hashLoad === load
export function hashIsTheLoadedRoms(hashLoad: number, load: number): boolean {
  return hashLoad === load;
}

/**
 * The page's ROM against the host's. `hashDiffers` and `sizeDiffers` compare
 * the hash and the size the page holds with the host's, false while the
 * host's is not known. A size that is not the host's refuses a ROM at once;
 * a hash refuses it only once it is the loaded ROM's own.
 */
//@ ensures !hasRom ==> \result === "noRom"
//@ ensures \result === "mismatch" <==> hasRom && (sizeDiffers || (hashIsLoaded && hashDiffers))
//@ ensures \result === "pending" <==> hasRom && !sizeDiffers && !hashIsLoaded
//@ ensures \result === "match" <==> hasRom && !sizeDiffers && hashIsLoaded && !hashDiffers
export function romVerdict(
  hasRom: boolean,
  hashIsLoaded: boolean,
  hashDiffers: boolean,
  sizeDiffers: boolean,
): RomVerdict {
  if (!hasRom) return 'noRom';
  if (sizeDiffers) return 'mismatch';
  if (!hashIsLoaded) return 'pending';
  if (hashDiffers) return 'mismatch';
  return 'match';
}

/**
 * Whether the start and late-join plans (`gameStartPlan`, `lateJoinPlan`)
 * count the page's ROM: only once its own hash, or its size, has decided it.
 * A ROM still being hashed is none yet: the page waits in the started game
 * and joins it late once the hash lands and says it is the host's, so it
 * never boots a file before its hash says whose it is.
 */
//@ ensures \result <==> v === "match" || v === "mismatch"
export function romDecided(v: RomVerdict): boolean {
  return v === 'match' || v === 'mismatch';
}

/**
 * Whether the plans offer the host's ROM. Not while the page's own ROM is
 * being hashed: the plan's no-ROM answer then waits for a ROM in the started
 * game, and the hash landing either joins the game with this ROM or refuses
 * it, which brings the offer back.
 */
//@ ensures \result <==> hostShares && v !== "pending"
export function offersHostsRom(v: RomVerdict, hostShares: boolean): boolean {
  return hostShares && v !== 'pending';
}

/**
 * The page tells the server it is ready with its ROM (`rom-ready`) only with
 * a ROM, and only once that ROM's own hash is in: the server takes the hash
 * it is sent with the size, and the previous ROM's hash with a new file's size
 * would count a wrong ROM the size of the host's as ready. The drop's own
 * hash, once it lands, announces it.
 */
//@ ensures \result <==> hasRom && hashIsLoaded
export function announcesRom(hasRom: boolean, hashIsLoaded: boolean): boolean {
  return hasRom && hashIsLoaded;
}
