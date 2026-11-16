// -*- mode: Bluespec; -*-
//
// Which ROM a guest's page judges and announces while a ROM it was given is
// still being hashed (web/static/play.js: loadRomData, loadRomFromLibrary,
// clearLoadedRom, handleHostRomChanged, notifyRomReady; the server's
// rom-ready check in server/src/api/signaling.py).
//
// A dropped file is the page's at once (its name and size), but its hash
// comes from a FileReader a moment later. Until then `_romHash` is the
// previous ROM's. Every check against the host's ROM and every `rom-ready`
// read it, so in that window the page:
//   - judged the new file by the old hash: a ROM that is the host's, dropped
//     over one that is not, was cleared when the host's ROM arrived;
//   - announced the old hash with the new file's name and size: the server
//     takes the old hash and the new size, so a wrong ROM the size of the
//     host's was counted as ready;
//   - and when that file's hash landed after it was cleared, said it was
//     ready with no ROM at all.
// A hash that lands after the player has dropped or picked another ROM is
// the same: it was taken as the new one's.
//
// "right" is the host's ROM, "wrong" is not. A wrong ROM may be the same
// size as the host's (two releases of one game often are), and the server
// and the page check the size first. A load is each change of the page's
// ROM: a drop, a pick from the ROM library (whose hash is known at once), a
// clear.
//
// What is modelled: one guest, the host's ROM becoming known once, drops,
// library picks and clears in any order, and their hashes landing in any
// order. The server's view is what the page last told it, heard at once
// (rom_at_start.qnt has the socket's ordering).
//
// Not modelled: the host's own page (it is never judged against itself; it
// announces its ROM as a guest does, so the same rule keeps its hash its
// own), the host changing its ROM, a hash that fails (the page says so and
// asks for the file again), the ROM transfer (its hash is the host's, known
// at once), and a start taken while a drop is being hashed: the server still
// holds the previous ROM's word until the new one is hashed.
//
// JUDGE_OWN_HASH: the page judges and announces its ROM only by that ROM's
//   own hash. While a load is being hashed it is pending: only a size that is
//   not the host's refuses it, and nothing is announced.
// HASH_KEEPS_ITS_LOAD: a hash that lands for a load that is no longer the
//   page's changes nothing.
module rom_identity {
  const JUDGE_OWN_HASH: bool
  const HASH_KEEPS_ITS_LOAD: bool

  pure val ROMS = Set("right", "wrong")

  var sameSize: bool // the wrong ROM is the size of the host's
  var loaded: str // the ROM the page holds: "none" | "right" | "wrong"
  var load: int // which load that is
  var loadedIsDrop: bool // the player dropped it (its refusal shows a banner)
  var hash: str // `_romHash`: "none" | "right" | "wrong"
  var hashLoad: int // the load `hash` was computed for
  var hashing: Set[(int, str)] // drops being hashed: (load, ROM)
  var hostKnown: bool // the host's ROM has reached the page
  var told: str // the server's word for this page: "none" (not ready) | "nohash" | a ROM
  var banner: bool // "Your ROM doesn't match" is shown
  // Ghosts, for the properties.
  var toldStale: bool // the page announced a hash that is not the ROM it holds, or a ROM with none
  var clearedRight: bool // the page cleared the host's ROM as not the host's

  // What the page makes of its ROM against the host's.
  pure def verdictOf(
    judgeOwn: bool,
    hasRom: bool,
    hashIsLoaded: bool,
    hostKnown: bool,
    hash: str,
    sizeDiffers: bool,
  ): str =
    if (not(hasRom)) "none"
    else if (judgeOwn)
      if (hostKnown and sizeDiffers) "mismatch"
      else if (not(hashIsLoaded)) "pending"
      else if (hostKnown and hash == "wrong") "mismatch"
      else "match"
    else if (hostKnown and (hash == "wrong" or sizeDiffers)) "mismatch"
    else "match"

  def sizeDiffers = loaded == "wrong" and not(sameSize)

  def verdict = verdictOf(JUDGE_OWN_HASH, loaded != "none", hashLoad == load, hostKnown, hash, sizeDiffers)

  // `rom-ready` with the page's ROM. With JUDGE_OWN_HASH, never while the
  // load is being hashed.
  def announces = loaded != "none" and (not(JUDGE_OWN_HASH) or hashLoad == load)

  def staleWord(h: str): bool = loaded == "none" or (h != "none" and h != loaded)

  action initWith(same: bool): bool = all {
    sameSize' = same,
    loaded' = "none",
    load' = 0,
    loadedIsDrop' = false,
    hash' = "none",
    hashLoad' = 0,
    hashing' = Set(),
    hostKnown' = false,
    told' = "none",
    banner' = false,
    toldStale' = false,
    clearedRight' = false,
  }

  action init = { nondet same = oneOf(Set(true, false)) initWith(same) }

  // The page says it is ready with the ROM it holds (notifyRomReady).
  action announce = all {
    told' = if (announces) (if (hash == "none") "nohash" else hash) else told,
    toldStale' = (toldStale or (announces and staleWord(hash))),
  }

  action keepAnnounce = all { told' = told, toldStale' = toldStale }

  // The page clears its ROM as not the host's and says it has none
  // (clearLoadedRom); a ROM the player dropped is refused with the banner.
  action refuse(showBanner: bool): bool = all {
    loaded' = "none",
    load' = load + 1,
    loadedIsDrop' = false,
    hash' = "none",
    hashLoad' = load + 1,
    told' = "none",
    banner' = showBanner,
    toldStale' = toldStale,
    clearedRight' = (clearedRight or loaded == "right"),
  }

  action unchangedRom = all {
    loaded' = loaded,
    load' = load,
    loadedIsDrop' = loadedIsDrop,
    hash' = hash,
    hashLoad' = hashLoad,
  }

  // The player drops a file: the page holds it now, and hashes it.
  action drop(r: str): bool = all {
    loaded' = r,
    load' = load + 1,
    loadedIsDrop' = true,
    hash' = hash,
    hashLoad' = hashLoad,
    hashing' = hashing.union(Set((load + 1, r))),
    banner' = false,
    sameSize' = sameSize,
    hostKnown' = hostKnown,
    keepAnnounce,
    clearedRight' = clearedRight,
  }

  // The player (or the page, matching the host's hash) picks a ROM from the
  // library: its hash is known at once (loadRomFromLibrary).
  action pick(r: str): bool = {
    val v = verdictOf(JUDGE_OWN_HASH, true, true, hostKnown, r, r == "wrong" and not(sameSize))
    all {
      if (v == "mismatch") all {
        // The library path says not ready and shows the banner.
        loaded' = "none",
        load' = load + 1,
        loadedIsDrop' = false,
        hash' = "none",
        hashLoad' = load + 1,
        told' = "none",
        banner' = true,
        toldStale' = toldStale,
        clearedRight' = (clearedRight or r == "right"),
      } else all {
        loaded' = r,
        load' = load + 1,
        loadedIsDrop' = false,
        hash' = r,
        hashLoad' = load + 1,
        told' = r,
        banner' = false,
        toldStale' = toldStale,
        clearedRight' = clearedRight,
      },
      hashing' = hashing,
      sameSize' = sameSize,
      hostKnown' = hostKnown,
    }
  }

  // The player deletes the loaded ROM from the library.
  action clear = all {
    loaded != "none",
    loaded' = "none",
    load' = load + 1,
    loadedIsDrop' = false,
    hash' = "none",
    hashLoad' = load + 1,
    told' = "none",
    banner' = banner,
    toldStale' = toldStale,
    clearedRight' = clearedRight,
    hashing' = hashing,
    sameSize' = sameSize,
    hostKnown' = hostKnown,
  }

  // The host's ROM reaches the page (handleHostRomChanged): a ROM that is not
  // the host's is refused; one that is, is announced.
  action hostArrives = {
    val v = verdictOf(JUDGE_OWN_HASH, loaded != "none", hashLoad == load, true, hash, sizeDiffers)
    all {
      not(hostKnown),
      hostKnown' = true,
      hashing' = hashing,
      sameSize' = sameSize,
      if (v == "mismatch") refuse(loadedIsDrop)
      else all {
        unchangedRom,
        banner' = banner,
        clearedRight' = clearedRight,
        if (v == "match") announce else keepAnnounce,
      },
    }
  }

  // The room changes (users-updated, a rejoin): the page says it is ready
  // with its ROM unless that is known not to be the host's.
  action roomUpdate = all {
    if (verdict == "match") announce else keepAnnounce,
    unchangedRom,
    banner' = banner,
    clearedRight' = clearedRight,
    hashing' = hashing,
    sameSize' = sameSize,
    hostKnown' = hostKnown,
  }

  // A dropped file's hash lands (the FileReader's onload): the page takes it
  // as its ROM's hash, then refuses the ROM if the host's is known and it is
  // not that, or else announces it.
  action hashLands(l: int, r: str): bool = all {
    hashing.contains((l, r)),
    hashing' = hashing.exclude(Set((l, r))),
    sameSize' = sameSize,
    hostKnown' = hostKnown,
    if (HASH_KEEPS_ITS_LOAD and l != load) all {
      unchangedRom,
      banner' = banner,
      clearedRight' = clearedRight,
      keepAnnounce,
    } else {
      // The verdict with this hash, as the page reads it once it is set.
      val v = verdictOf(JUDGE_OWN_HASH, loaded != "none", l == load, hostKnown, r, sizeDiffers)
      if (v == "mismatch") refuse(true)
      else all {
        loaded' = loaded,
        load' = load,
        loadedIsDrop' = loadedIsDrop,
        hash' = r,
        hashLoad' = l,
        clearedRight' = clearedRight,
        if (v == "pending") all { banner' = banner, keepAnnounce }
        else all {
          banner' = false,
          // The onload announces with the hash it just set, whatever the page holds.
          told' = if (JUDGE_OWN_HASH and l != load) told else r,
          toldStale' = (toldStale or (not(JUDGE_OWN_HASH and l != load) and staleWord(r))),
        },
      }
    },
  }

  action hashLandsAny = { nondet x = oneOf(hashing) hashLands(x._1, x._2) }

  action step = any {
    nondet r = oneOf(ROMS) drop(r),
    nondet r = oneOf(ROMS) pick(r),
    clear,
    hostArrives,
    roomUpdate,
    hashLandsAny,
  }

  // The page never tells the server a hash that is not the ROM it holds, and
  // never says it is ready with no ROM.
  val neverAnnouncesAStaleRom = not(toldStale)

  // The page never clears the host's ROM as not the host's.
  val aRightRomStays = not(clearedRight)

  // Once nothing is being hashed and the host's ROM is known, the page holds
  // the host's ROM and has said so, or holds none.
  val aSettledRomIsTheHosts =
    (hashing == Set() and hostKnown and loaded != "none") implies (loaded == "right" and told == "right")

  // Once nothing is being hashed, the hash the page holds is its ROM's own.
  val aSettledRomKeepsItsHash = (hashing == Set() and loaded != "none") implies (hashLoad == load and hash == loaded)

  val allHold = neverAnnouncesAStaleRom and aRightRomStays and aSettledRomIsTheHosts and aSettledRomKeepsItsHash

  // The guest has a wrong ROM, drops the host's over it, and the host's ROM
  // arrives before the new file is hashed. Today the old hash refuses the
  // right ROM, and its hash, landing after, says ready with no ROM.
  run rightOverWrongTest =
    initWith(false)
      .then(drop("wrong"))
      .then(hashLands(1, "wrong"))
      .then(drop("right"))
      .then(hostArrives)
      .expect(aRightRomStays == JUDGE_OWN_HASH)
      .then(hashLands(2, "right"))
      .expect(loaded == (if (JUDGE_OWN_HASH) "right" else "none"))
      .expect(neverAnnouncesAStaleRom == JUDGE_OWN_HASH)
      .expect(allHold == JUDGE_OWN_HASH)

  // The guest has the host's ROM and drops a wrong one the same size; the
  // room changes before the new file is hashed. Today the page announces the
  // old hash, which the server takes as the host's, with the new size. Once
  // hashed, the wrong ROM is refused either way.
  run wrongOverRightTest =
    initWith(true)
      .then(drop("right"))
      .then(hashLands(1, "right"))
      .then(hostArrives)
      .then(drop("wrong"))
      .then(roomUpdate)
      .expect(neverAnnouncesAStaleRom == JUDGE_OWN_HASH)
      .expect(told == "right")
      .then(hashLands(2, "wrong"))
      .expect(loaded == "none")
      .expect(banner)

  // Two drops, the second (the host's ROM) hashed first: the first's hash,
  // landing late, is taken as the loaded ROM's. Today it refuses the host's
  // ROM; judging by own hash alone, the page keeps the ROM but its own hash
  // is gone, so it can never be announced again.
  run twoDropsTest =
    initWith(true)
      .then(hostArrives)
      .then(drop("wrong"))
      .then(drop("right"))
      .then(hashLands(2, "right"))
      .expect(told == "right")
      .then(hashLands(1, "wrong"))
      .expect(aRightRomStays == JUDGE_OWN_HASH)
      .expect(loaded == (if (JUDGE_OWN_HASH) "right" else "none"))
      .expect(allHold == (JUDGE_OWN_HASH and HASH_KEEPS_ITS_LOAD))

  // A drop being hashed, then the host's ROM picked from the library: the
  // drop's hash lands after.
  run pickWhileHashingTest =
    initWith(true)
      .then(hostArrives)
      .then(drop("wrong"))
      .then(pick("right"))
      .expect(told == "right")
      .then(hashLands(1, "wrong"))
      .expect(aRightRomStays == JUDGE_OWN_HASH)
      .expect(allHold == (JUDGE_OWN_HASH and HASH_KEEPS_ITS_LOAD))

  // A wrong ROM of another size is refused while it is still being hashed:
  // the size is enough.
  run wrongSizeWhileHashingTest =
    initWith(false)
      .then(drop("wrong"))
      .then(hostArrives)
      .expect(loaded == "none")
      .expect(banner)
      .then(hashLands(1, "wrong"))
      .expect(loaded == "none")
      .expect(neverAnnouncesAStaleRom == JUDGE_OWN_HASH)
      // A late hash taken as the page's hides the banner it just showed.
      .expect(banner == HASH_KEEPS_ITS_LOAD)
}

// Before: every check and every rom-ready read `_romHash`, whatever load it
// was computed for.
module rom_identity_before {
  import rom_identity(JUDGE_OWN_HASH = false, HASH_KEEPS_ITS_LOAD = false).*
}

// Judging by the ROM's own hash, but a late hash still taken as the
// loaded ROM's.
module rom_identity_judge_only {
  import rom_identity(JUDGE_OWN_HASH = true, HASH_KEEPS_ITS_LOAD = false).*
}

// Today: both.
module rom_identity_current {
  import rom_identity(JUDGE_OWN_HASH = true, HASH_KEEPS_ITS_LOAD = true).*
}
