// -*- mode: Bluespec; -*-
//
// Which ROM a guest's page judges, announces and boots while a ROM it was
// given is still being hashed, its own or the host's (web/static/play.js:
// loadRomData, loadRomFromLibrary, clearLoadedRom, applyHostRomFromData,
// handleHostRomChanged, notifyRomReady, tellRomAfterRejoin, onGameStarted,
// the join-room and rejoin paths, startGame; the server's rom-ready and
// start-game checks in server/src/api/signaling.py).
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
// the same: it was taken as the new one's. And while the new file was being
// hashed the server still held the previous ROM's word, a start reaching
// the page booted the file before its hash said whose it was, and the host
// could start on the hash of the ROM it had before.
//
// The host's drop has the same window, seen from the guests. Until the
// host's new ROM is hashed and its `rom-ready` reaches the server, the room
// names the host's previous ROM, and every guest judges against it:
//   - a guest's ROM that is the host's new one is refused as not the host's;
//   - a guest's ROM that is the previous one is kept, announced again at
//     every room change, and counted ready by the server.
// No start can take that word: the host's Start waits for its own hash, and
// the server drops every guest's word when the host's new hash reaches it.
//
// A guest may also hold none when the host's new ROM is named: it dropped
// that ROM a moment before the host did and it was refused, correctly,
// against the host's previous one; or its hash landed before the host's
// drop reached it. The dropped file is in its ROM library by then
// (cacheRom), but the page looked there only after a refusal (refuseRom),
// not when the room named a new ROM, so the player had to drop it again.
//
// "right" is the ROM the host holds, "wrong" is not. The names follow the
// host: when the host drops a ROM of its own, the one it held becomes
// "wrong", and the one it dropped "right" (the guest's "wrong", or a ROM the
// guest has never held). A wrong ROM may be the same size as the host's (two
// releases of one game often are), and the server and the page check the
// size first. A load is each change of the page's ROM: a drop, a pick from
// the ROM library (whose hash is known at once), a clear.
//
// What is modelled: one guest; the host's ROM becoming known; the host
// dropping another ROM of its own, its hash landing, and what the server and
// the guest's page make of each; the guest's drops, library picks and clears
// in any order, their hashes landing or failing in any order; the guest's ROM
// library (a dropped file's copy lands in it a moment after the drop); the
// guest's socket dropping and the page rejoining; the host sharing its ROM or not;
// and a start: the host's Start, the server taking it, and the guest's page
// deciding what to do with it. The server's view of the guest is what the
// page last told it while its socket was up, heard at once (rom_at_start.qnt
// has the socket's ordering), and the server keeps it across a rejoin. What
// the host's page tells the server about its own ROM reaches the server, and
// the room's ROM the guest's page, at once.
//
// Not modelled: the flight of the host's word to the guest's page (a guest's
// hash landing in it is judged against what the page last heard, and the
// server takes no `rom-ready` from a guest while the room's ROM is
// changing); the host's ROM changing while the guest's socket is down (the
// page hears the room's ROM again in the rejoin's ack); the host's socket;
// a second drop by the host while its first is being hashed; spectators (a
// spectator's refused ROM is looked for as a player's is, and one claiming a
// slot with none looks too: the same decision); ROMs in the
// library from earlier visits (the library holds what the run has given it:
// drops once cached, and picks), and the join's autoload from it; a library
// read's own delay (a lookup is atomic here); the ROM
// transfer (its hash is the host's, known at once); the host's ROM arriving
// with the start message (the guest has it from the room by then: a start
// here needs it known).
//
// JUDGE_OWN_HASH: the page judges and announces its ROM only by that ROM's
//   own hash. While a load is being hashed it is pending: only a size that is
//   not the host's refuses it, and nothing is announced.
// HASH_KEEPS_ITS_LOAD: a hash that lands for a load that is no longer the
//   page's changes nothing.
// DROP_SAYS_NOT_READY: a guest's drop tells the server at once that the page
//   is not ready, so the server never holds the previous ROM's word while
//   the new file is hashed; the drop's own hash says ready when it lands.
// BOOT_WAITS_FOR_HASH: the start and late-join plans count a ROM only once
//   its own hash (or its size) has decided it; a ROM still being hashed is
//   none yet, and the page joins late once it is decided.
// HOST_START_WAITS_FOR_HASH: the host cannot start while its own dropped ROM
//   is being hashed: it would send the server the previous ROM's hash.
// FAILED_HASH_REFUSES: a hash that times out or fails refuses the ROM (the
//   page says it could not read it). false: the load stayed pending for good,
//   never announced and never judged.
// REJOIN_SAYS_PENDING: a page that rejoins with a ROM still being hashed
//   says it is not ready. The server carries the old socket's word over to
//   the new one, and a drop made while the socket was down said nothing.
// HOST_DROP_SAYS_CHANGING: the host's drop tells the server at once that its
//   ROM is being hashed (`rom-ready {ready: false, pending: true}`). The
//   server drops every guest's word and names no ROM, only that it is
//   changing, and refuses a start; a guest's page judges nothing against it
//   (its verdict is pending) and announces nothing until the host's new hash
//   is the room's. false: the host said nothing until its hash landed, and
//   the room named its previous ROM.
// HOST_ROM_FROM_LIBRARY: when the room names the host's ROM and the page
//   holds none, it loads that ROM from its library if it is there
//   (handleHostRomChanged, looksInLibraryForHostsRom). false: only a refusal
//   looked there.
// LOOKS_WHEN_CACHED: a dropped file's copy landing in the library is looked
//   for too, when the room already names it as the host's and the page holds
//   none (cacheRom). false: the lookup when the room named it found nothing,
//   the copy landing a moment later, and nothing looked again.
module rom_identity {
  const JUDGE_OWN_HASH: bool
  const HASH_KEEPS_ITS_LOAD: bool
  const DROP_SAYS_NOT_READY: bool
  const BOOT_WAITS_FOR_HASH: bool
  const HOST_START_WAITS_FOR_HASH: bool
  const FAILED_HASH_REFUSES: bool
  const REJOIN_SAYS_PENDING: bool
  const HOST_DROP_SAYS_CHANGING: bool
  const HOST_ROM_FROM_LIBRARY: bool
  const LOOKS_WHEN_CACHED: bool

  pure val ROMS = Set("right", "wrong")

  var sameSize: bool // a ROM that is not the host's is the size of the host's
  var sharing: bool // the host shares its ROM: the server starts without the guest's word
  var up: bool // the guest's socket is connected
  var loaded: str // the ROM the page holds: "none" | "right" | "wrong"
  var load: int // which load that is
  var loadedIsDrop: bool // the player dropped it (its refusal shows a banner)
  var hash: str // `_romHash`: "none" | "right" | "wrong"
  var hashLoad: int // the load `hash` was computed for
  var hashing: Set[(int, str)] // drops being hashed: (load, ROM)
  // The host's ROM as the room names it, which the page has heard:
  // "none" (not known yet) | "changing" (the host's new ROM is being hashed) |
  // "right" | "wrong" (the host's previous ROM).
  var roomRom: str
  var told: str // the server's word for this page: "none" (not ready) | "nohash" | a ROM
  var library: Set[str] // the ROMs in the page's ROM library (IndexedDB)
  var caching: Set[str] // dropped ROMs whose library copy has not landed yet (cacheRom)
  var toldFor: int // the load that word was said for
  var banner: bool // "Your ROM doesn't match" is shown
  var hostHashing: bool // the host's own dropped ROM is being hashed
  var started: bool // the server took the host's start
  var plan: str // the guest's page in the match: "lobby" | "awaiting" (joins late once it has a ROM) | "booted"
  // Ghosts, for the properties.
  var toldStale: bool // the page announced a hash that is not the ROM it holds, or a ROM with none
  var clearedRight: bool // the page cleared the host's ROM as not the host's
  var startedStale: bool // a start counted the page ready on a word not about the ROM it holds
  var bootedWrong: bool // the page booted a ROM that is not the host's
  var hostStartedStale: bool // the host started while its own ROM was being hashed
  var startedOnAnotherRom: bool // a start counted the guest ready on a ROM the host no longer holds
  var missedLibraryRom: bool // the room named the host's ROM, the page held none, and it stayed so with the ROM in its library

  // The room names a ROM: "right" or "wrong".
  pure def names(room: str): bool = room == "right" or room == "wrong"

  // A ROM `r` the page holds is not the size of the room's.
  pure def sizeDiffersFrom(room: str, r: str, same: bool): bool =
    names(room) and r != "none" and r != room and not(same)

  // What the page makes of its ROM against the room's.
  pure def verdictOf(
    judgeOwn: bool,
    hasRom: bool,
    hashIsLoaded: bool,
    room: str,
    hash: str,
    sizeDiffers: bool,
  ): str = {
    val hashDiffers = names(room) and hash != "none" and hash != room
    if (not(hasRom)) "none"
    else if (room == "changing") "pending"
    else if (judgeOwn)
      if (sizeDiffers) "mismatch"
      else if (not(hashIsLoaded)) "pending"
      else if (hashDiffers) "mismatch"
      else "match"
    else if (hashDiffers or sizeDiffers) "mismatch"
    else "match"
  }

  def sizeDiffers = sizeDiffersFrom(roomRom, loaded, sameSize)

  def verdict = verdictOf(JUDGE_OWN_HASH, loaded != "none", hashLoad == load, roomRom, hash, sizeDiffers)

  // `rom-ready` with the page's ROM. With JUDGE_OWN_HASH, never while the
  // load is being hashed; never while the room's ROM is changing.
  def announces = loaded != "none" and (not(JUDGE_OWN_HASH) or hashLoad == load) and roomRom != "changing"

  def wordFor(h: str): str = if (h == "none") "nohash" else h

  def staleWord(h: str): bool = loaded == "none" or (h != "none" and h != loaded)

  // The server counts the page ready on a word that is not about the ROM it
  // holds: a hash that is not its ROM's, or no hash for an earlier load.
  def serverWordIsStale = told != "none" and (if (told == "nohash") toldFor != load else told != loaded)

  // The start and late-join plans: whether they count a ROM the page holds.
  def planHasRom(v: str): bool = if (BOOT_WAITS_FOR_HASH) (v == "match" or v == "mismatch") else loaded != "none"

  // The names after the host drops a ROM: the one it held is "wrong" now,
  // and the one it dropped "right": the guest's "wrong" (`toGuests`), or one
  // the guest has never held.
  pure def renamed(r: str, toGuests: bool): str =
    if (r == "right") "wrong" else if (r == "wrong" and toGuests) "right" else r

  action initWith(same: bool, shares: bool): bool = all {
    sameSize' = same,
    sharing' = shares,
    up' = true,
    loaded' = "none",
    load' = 0,
    loadedIsDrop' = false,
    hash' = "none",
    hashLoad' = 0,
    hashing' = Set(),
    roomRom' = "none",
    told' = "none",
    library' = Set(),
    caching' = Set(),
    toldFor' = 0,
    banner' = false,
    hostHashing' = false,
    started' = false,
    plan' = "lobby",
    toldStale' = false,
    clearedRight' = false,
    startedStale' = false,
    bootedWrong' = false,
    hostStartedStale' = false,
    startedOnAnotherRom' = false,
    missedLibraryRom' = false,
  }

  action init = { nondet same = oneOf(Set(true, false)) nondet shares = oneOf(Set(true, false)) initWith(same, shares) }

  // A word to the server; it goes only while the socket is up.
  action tell(t: str, forLoad: int, stale: bool): bool = all {
    told' = if (up) t else told,
    toldFor' = if (up) forLoad else toldFor,
    toldStale' = (toldStale or (up and stale)),
  }

  action keepTold = all { told' = told, toldFor' = toldFor, toldStale' = toldStale }

  action unchangedLibrary = all { library' = library, caching' = caching, missedLibraryRom' = missedLibraryRom }

  // The page says it is ready with the ROM it holds (notifyRomReady).
  action announce = if (announces) tell(wordFor(hash), load, staleWord(hash)) else keepTold

  action unchangedRom = all {
    loaded' = loaded,
    load' = load,
    loadedIsDrop' = loadedIsDrop,
    hash' = hash,
    hashLoad' = hashLoad,
  }

  action unchangedWorld = all {
    sameSize' = sameSize,
    sharing' = sharing,
    up' = up,
    roomRom' = roomRom,
    hostHashing' = hostHashing,
    started' = started,
  }

  action unchangedStart = all {
    plan' = plan,
    bootedWrong' = bootedWrong,
    startedStale' = startedStale,
    hostStartedStale' = hostStartedStale,
    startedOnAnotherRom' = startedOnAnotherRom,
  }

  // The page clears its ROM (clearLoadedRom): as not the host's (a dropped
  // one with the banner), or as unreadable.
  action clearRom(notTheHosts: bool, showBanner: bool): bool = all {
    loaded' = "none",
    load' = load + 1,
    loadedIsDrop' = false,
    hash' = "none",
    hashLoad' = load + 1,
    banner' = showBanner,
    clearedRight' = (clearedRight or (notTheHosts and loaded == "right")),
  }

  // ... and says it has none.
  action refuse(notTheHosts: bool, showBanner: bool): bool = all {
    clearRom(notTheHosts, showBanner),
    tell("none", load + 1, false),
  }

  // refuseRom: the page refuses a ROM that is not the host's, then looks in
  // its library for the ROM the room names (autoMatchRom) and, if it is
  // there, loads it (its hash is known at once) and says it is ready with it.
  action refuseRom(showBanner: bool): bool =
    if (names(roomRom) and library.contains(roomRom)) all {
      loaded' = roomRom,
      load' = load + 1,
      loadedIsDrop' = false,
      hash' = roomRom,
      hashLoad' = load + 1,
      banner' = false,
      clearedRight' = (clearedRight or loaded == "right"),
      tell(roomRom, load + 1, false),
    } else refuse(true, showBanner)

  // The player drops a file: the page holds it now, and hashes it.
  action drop(r: str): bool = all {
    plan != "booted",
    loaded' = r,
    load' = load + 1,
    loadedIsDrop' = true,
    hash' = hash,
    hashLoad' = hashLoad,
    hashing' = hashing.union(Set((load + 1, r))),
    banner' = false,
    if (DROP_SAYS_NOT_READY) tell("none", load + 1, false) else keepTold,
    clearedRight' = clearedRight,
    library' = library,
    caching' = caching.union(Set(r)),
    missedLibraryRom' = missedLibraryRom,
    unchangedWorld,
    unchangedStart,
  }

  // A dropped file's copy lands in the ROM library (cacheRom hashes it again
  // and stores it, a moment after the drop). With LOOKS_WHEN_CACHED, a page
  // holding none loads it at once when the room names it as the host's (and
  // a page waiting in a started game joins it late).
  action cacheLands(r: str): bool = {
    val theHosts = r == "right" and roomRom == "right" and loaded == "none"
    val looks = theHosts and HOST_ROM_FROM_LIBRARY and LOOKS_WHEN_CACHED
    val joins = looks and plan == "awaiting"
    all {
      caching.contains(r),
      caching' = caching.exclude(Set(r)),
      library' = library.union(Set(r)),
      missedLibraryRom' = (missedLibraryRom or (theHosts and not(looks))),
      hashing' = hashing,
      unchangedWorld,
      startedStale' = startedStale,
      hostStartedStale' = hostStartedStale,
      startedOnAnotherRom' = startedOnAnotherRom,
      clearedRight' = clearedRight,
      if (looks) all {
        loaded' = r,
        load' = load + 1,
        loadedIsDrop' = false,
        hash' = r,
        hashLoad' = load + 1,
        banner' = false,
        tell(r, load + 1, false),
        plan' = if (joins) "booted" else plan,
        bootedWrong' = bootedWrong,
      } else all {
        unchangedRom,
        keepTold,
        banner' = banner,
        plan' = plan,
        bootedWrong' = bootedWrong,
      },
    }
  }

  action cacheLandsAny = { nondet r = oneOf(caching) cacheLands(r) }

  // The player (or the page, matching the host's hash) picks a ROM from the
  // library: its hash is known at once (loadRomFromLibrary). A page waiting
  // in a started game joins it late with a ROM that is the host's.
  action pick(r: str): bool = {
    val v = verdictOf(JUDGE_OWN_HASH, true, true, roomRom, r, sizeDiffersFrom(roomRom, r, sameSize))
    val joins = plan == "awaiting" and v == "match"
    all {
      plan != "booted",
      if (v == "mismatch") all {
        // The library path says not ready and shows the banner.
        loaded' = "none",
        load' = load + 1,
        loadedIsDrop' = false,
        hash' = "none",
        hashLoad' = load + 1,
        tell("none", load + 1, false),
        banner' = true,
        clearedRight' = (clearedRight or r == "right"),
      } else all {
        loaded' = r,
        load' = load + 1,
        loadedIsDrop' = false,
        hash' = r,
        hashLoad' = load + 1,
        // Nothing while the room's ROM is changing.
        if (v == "match") tell(r, load + 1, false) else keepTold,
        banner' = false,
        clearedRight' = clearedRight,
      },
      plan' = if (joins) "booted" else plan,
      bootedWrong' = (bootedWrong or (joins and r == "wrong")),
      startedStale' = startedStale,
      hostStartedStale' = hostStartedStale,
      startedOnAnotherRom' = startedOnAnotherRom,
      hashing' = hashing,
      // A pick is from the library: it holds that ROM.
      library' = library.union(Set(r)),
      caching' = caching,
      missedLibraryRom' = missedLibraryRom,
      unchangedWorld,
    }
  }

  // The player deletes the loaded ROM from the library.
  action clear = all {
    loaded != "none",
    plan != "booted",
    loaded' = "none",
    load' = load + 1,
    loadedIsDrop' = false,
    hash' = "none",
    hashLoad' = load + 1,
    tell("none", load + 1, false),
    banner' = banner,
    clearedRight' = clearedRight,
    hashing' = hashing,
    library' = library.exclude(Set(loaded)),
    caching' = caching,
    missedLibraryRom' = missedLibraryRom,
    unchangedWorld,
    unchangedStart,
  }

  // The room takes the host's ROM: the host's page said ready with it. A ROM
  // that is not the room's previous one drops every guest's word
  // (_invalidate_non_host_rom_state), and the guest's page, hearing it
  // (applyHostRomFromData, handleHostRomChanged), refuses a ROM that is not
  // the host's and announces one that is. A refusal then looks in the library
  // for the host's ROM (refuseRom); with HOST_ROM_FROM_LIBRARY, so does a page
  // that holds none.
  action roomTakesHostsRom = {
    val v = verdictOf(JUDGE_OWN_HASH, loaded != "none", hashLoad == load, "right", hash, sizeDiffersFrom("right", loaded, sameSize))
    val refused = v == "mismatch"
    val inLibrary = library.contains("right")
    val looks = inLibrary and (refused or (HOST_ROM_FROM_LIBRARY and loaded == "none"))
    all {
      roomRom' = "right",
      library' = library,
      caching' = caching,
      missedLibraryRom' = (missedLibraryRom or (inLibrary and not(looks) and loaded == "none")),
      if (looks) all {
        loaded' = "right",
        load' = load + 1,
        loadedIsDrop' = false,
        hash' = "right",
        hashLoad' = load + 1,
        banner' = false,
        clearedRight' = clearedRight,
        // The server dropped the word; the page says ready with the ROM it loaded.
        told' = if (up) "right" else "none",
        toldFor' = load + 1,
        toldStale' = toldStale,
      } else if (refused) all {
        clearRom(true, loadedIsDrop),
        told' = "none",
        toldFor' = load + 1,
        toldStale' = toldStale,
      } else all {
        unchangedRom,
        banner' = banner,
        clearedRight' = clearedRight,
        if (v == "match" and up and loaded != "none" and (not(JUDGE_OWN_HASH) or hashLoad == load))
          tell(wordFor(hash), load, staleWord(hash))
        else all { told' = "none", toldFor' = toldFor, toldStale' = toldStale },
      },
    }
  }

  // The host's ROM reaches the room, and the page.
  action hostArrives = all {
    roomRom == "none",
    not(hostHashing),
    roomTakesHostsRom,
    hashing' = hashing,
    sameSize' = sameSize,
    sharing' = sharing,
    up' = up,
    hostHashing' = hostHashing,
    started' = started,
    unchangedStart,
  }

  // The room changes (users-updated): the page says it is ready with its ROM
  // unless that is known not to be the host's.
  action roomUpdate = all {
    if (verdict == "match") announce else keepTold,
    unchangedRom,
    banner' = banner,
    clearedRight' = clearedRight,
    hashing' = hashing,
    unchangedLibrary,
    unchangedWorld,
    unchangedStart,
  }

  // A dropped file's hash lands (the FileReader's onload): the page takes it
  // as its ROM's hash, then refuses the ROM if the host's is known and it is
  // not that, or else announces it, and a page waiting in a started game
  // joins it late (dismissLateJoinPrompt).
  action hashLands(l: int, r: str): bool = {
    val v = verdictOf(JUDGE_OWN_HASH, loaded != "none", l == load, roomRom, r, sizeDiffers)
    // The onload announces with the hash it just set, whatever the page holds.
    val sends = not(JUDGE_OWN_HASH and l != load)
    val joins = plan == "awaiting" and v == "match" and loaded != "none"
    all {
      hashing.contains((l, r)),
      hashing' = hashing.exclude(Set((l, r))),
      unchangedWorld,
      unchangedLibrary,
      startedStale' = startedStale,
      hostStartedStale' = hostStartedStale,
      startedOnAnotherRom' = startedOnAnotherRom,
      if (HASH_KEEPS_ITS_LOAD and l != load) all {
        unchangedRom,
        banner' = banner,
        clearedRight' = clearedRight,
        keepTold,
        plan' = plan,
        bootedWrong' = bootedWrong,
      } else if (v == "mismatch") all {
        refuseRom(true),
        plan' = plan,
        bootedWrong' = bootedWrong,
      } else all {
        loaded' = loaded,
        load' = load,
        loadedIsDrop' = loadedIsDrop,
        hash' = r,
        hashLoad' = l,
        clearedRight' = clearedRight,
        if (v == "pending") all { banner' = banner, keepTold, plan' = plan, bootedWrong' = bootedWrong }
        else all {
          banner' = false,
          if (sends) tell(r, l, staleWord(r)) else keepTold,
          plan' = if (joins) "booted" else plan,
          bootedWrong' = (bootedWrong or (joins and loaded == "wrong")),
        },
      },
    }
  }

  // A dropped file's hash times out or fails (the FileReader's onerror, its
  // 15 s timer, a digest that throws).
  action hashFails(l: int, r: str): bool = all {
    hashing.contains((l, r)),
    hashing' = hashing.exclude(Set((l, r))),
    unchangedWorld,
    unchangedLibrary,
    startedStale' = startedStale,
    hostStartedStale' = hostStartedStale,
    startedOnAnotherRom' = startedOnAnotherRom,
    plan' = plan,
    bootedWrong' = bootedWrong,
    if (FAILED_HASH_REFUSES and l == load) refuse(false, false)
    else all { unchangedRom, banner' = banner, clearedRight' = clearedRight, keepTold },
  }

  action hashLandsAny = { nondet x = oneOf(hashing) hashLands(x._1, x._2) }

  action hashFailsAny = { nondet x = oneOf(hashing) hashFails(x._1, x._2) }

  // The guest's socket drops: nothing it says reaches the server until it
  // rejoins, and the server keeps its word.
  action dropSocket = all {
    up,
    up' = false,
    unchangedRom,
    unchangedLibrary,
    keepTold,
    banner' = banner,
    clearedRight' = clearedRight,
    hashing' = hashing,
    sameSize' = sameSize,
    sharing' = sharing,
    roomRom' = roomRom,
    hostHashing' = hostHashing,
    started' = started,
    unchangedStart,
  }

  // The page rejoins: the server carries the old socket's word over, and the
  // page says what it has (a ROM it can announce, none, or one being hashed).
  action rejoin = all {
    not(up),
    up' = true,
    unchangedLibrary,
    if (announces) all {
      told' = wordFor(hash),
      toldFor' = load,
      toldStale' = (toldStale or staleWord(hash)),
    } else if (loaded == "none" or REJOIN_SAYS_PENDING) all {
      told' = "none",
      toldFor' = load,
      toldStale' = toldStale,
    } else keepTold,
    unchangedRom,
    banner' = banner,
    clearedRight' = clearedRight,
    hashing' = hashing,
    sameSize' = sameSize,
    sharing' = sharing,
    roomRom' = roomRom,
    hostHashing' = hostHashing,
    started' = started,
    unchangedStart,
  }

  // The host drops a new ROM of its own (loadRomData on the host's page): the
  // guest's ROM's name follows the host's (`renamed`). With
  // HOST_DROP_SAYS_CHANGING the server hears at once that the host's ROM is
  // changing, drops every guest's word (_clear_host_rom) and tells the room;
  // without, nothing changes for the server or the guest until the hash lands.
  action hostDrops(toGuests: bool): bool = all {
    up,
    not(started),
    not(hostHashing),
    hostHashing' = true,
    loaded' = renamed(loaded, toGuests),
    load' = load,
    loadedIsDrop' = loadedIsDrop,
    hash' = renamed(hash, toGuests),
    hashLoad' = hashLoad,
    hashing' = hashing.map(x => (x._1, renamed(x._2, toGuests))),
    library' = library.map(x => renamed(x, toGuests)),
    caching' = caching.map(x => renamed(x, toGuests)),
    missedLibraryRom' = missedLibraryRom,
    if (HOST_DROP_SAYS_CHANGING) all {
      roomRom' = "changing",
      told' = "none",
      toldFor' = toldFor,
      toldStale' = toldStale,
    } else all {
      roomRom' = renamed(roomRom, toGuests),
      told' = renamed(told, toGuests),
      toldFor' = toldFor,
      toldStale' = toldStale,
    },
    banner' = banner,
    clearedRight' = clearedRight,
    sameSize' = sameSize,
    sharing' = sharing,
    up' = up,
    started' = started,
    unchangedStart,
  }

  // The host's dropped ROM is hashed: its page says ready with it, and the
  // room takes it.
  action hostHashLands = all {
    up,
    not(started),
    hostHashing,
    hostHashing' = false,
    roomTakesHostsRom,
    hashing' = hashing,
    sameSize' = sameSize,
    sharing' = sharing,
    up' = up,
    started' = started,
    unchangedStart,
  }

  // The host presses Start. The host's page refuses while its own ROM is
  // being hashed (HOST_START_WAITS_FOR_HASH), the server while the room's ROM
  // is changing; it takes it when the host shares its ROM or the guest's word
  // says ready.
  action start = {
    val hostRefuses = HOST_START_WAITS_FOR_HASH and hostHashing
    val takes = not(hostRefuses) and roomRom != "changing" and (sharing or told != "none")
    all {
      not(started),
      roomRom != "none",
      started' = takes,
      // While the guest's socket is down the server holds its last word,
      // whatever the page does (rom_at_start.qnt, clearedWhileDownTest).
      startedStale' = (startedStale or (takes and up and not(sharing) and serverWordIsStale)),
      hostStartedStale' = (hostStartedStale or (takes and hostHashing)),
      startedOnAnotherRom' = (startedOnAnotherRom or (takes and not(sharing) and told == "wrong")),
      plan' = plan,
      bootedWrong' = bootedWrong,
      unchangedRom,
      unchangedLibrary,
      keepTold,
      banner' = banner,
      clearedRight' = clearedRight,
      hashing' = hashing,
      sameSize' = sameSize,
      sharing' = sharing,
      up' = up,
      roomRom' = roomRom,
      hostHashing' = hostHashing,
    }
  }

  // The start reaches the guest's page (onGameStarted, gameStartPlan): it
  // boots a ROM the plan counts and does not know to differ; otherwise it
  // waits in the started game for a ROM, says it is not ready (at the ROM
  // prompt), and joins late once it has one.
  action gameStarted = {
    val v = verdict
    val boots = planHasRom(v) and v != "mismatch"
    all {
      started,
      up,
      plan == "lobby",
      plan' = if (boots) "booted" else "awaiting",
      bootedWrong' = (bootedWrong or (boots and loaded == "wrong")),
      if (boots) keepTold else tell("none", load, false),
      startedStale' = startedStale,
      hostStartedStale' = hostStartedStale,
      startedOnAnotherRom' = startedOnAnotherRom,
      unchangedRom,
      unchangedLibrary,
      banner' = banner,
      clearedRight' = clearedRight,
      hashing' = hashing,
      unchangedWorld,
    }
  }

  action step = any {
    nondet r = oneOf(ROMS) drop(r),
    nondet r = oneOf(ROMS) pick(r),
    clear,
    hostArrives,
    roomUpdate,
    hashLandsAny,
    hashFailsAny,
    cacheLandsAny,
    dropSocket,
    rejoin,
    nondet toGuests = oneOf(Set(true, false)) hostDrops(toGuests),
    hostHashLands,
    start,
    gameStarted,
  }

  // The page never tells the server a hash that is not the ROM it holds, and
  // never says it is ready with no ROM.
  val neverAnnouncesAStaleRom = not(toldStale)

  // The page never clears the host's ROM as not the host's: neither the ROM
  // the host has nor the one it has just dropped.
  val aRightRomStays = not(clearedRight)

  // With the socket up, nothing being hashed and the room naming the host's
  // ROM, the page holds the host's ROM and has said so, or holds none.
  val aSettledRomIsTheHosts =
    (up and hashing == Set() and roomRom == "right" and loaded != "none") implies (loaded == "right" and told == "right")

  // Once nothing is being hashed, the hash the page holds is its ROM's own.
  val aSettledRomKeepsItsHash = (hashing == Set() and loaded != "none") implies (hashLoad == load and hash == loaded)

  // A start never counts the page ready, with its socket up, on a word that
  // is not about the ROM it holds.
  val aStartCountsOnlyTheLoadedRom = not(startedStale)

  // The page never boots a ROM that is not the host's.
  val neverBootsAWrongRom = not(bootedWrong)

  // The host never starts on a hash that is not its loaded ROM's.
  val theHostStartsOnItsOwnHash = not(hostStartedStale)

  // While the room names a ROM, the server never counts the guest ready on a
  // ROM the host no longer holds. (While the room names none, the server
  // has nothing to hold a guest's word against.)
  val theServerCountsOnlyTheHostsRom = names(roomRom) implies told != "wrong"

  // No start counts the guest ready on a ROM the host no longer holds.
  val aStartCountsOnlyTheHostsRom = not(startedOnAnotherRom)

  // When the room names the host's ROM and the page holds none, the page
  // never stays without it while its library holds it.
  val theHostsRomComesFromTheLibrary = not(missedLibraryRom)

  val allHold = and {
    neverAnnouncesAStaleRom,
    aRightRomStays,
    aSettledRomIsTheHosts,
    aSettledRomKeepsItsHash,
    aStartCountsOnlyTheLoadedRom,
    neverBootsAWrongRom,
    theHostStartsOnItsOwnHash,
    theServerCountsOnlyTheHostsRom,
    aStartCountsOnlyTheHostsRom,
    theHostsRomComesFromTheLibrary,
  }

  // The guest has a wrong ROM, drops the host's over it, and the host's ROM
  // arrives before the new file is hashed. Before, the old hash refused the
  // right ROM, and its hash, landing after, said ready with no ROM. Today the
  // page waits for the new file's hash, which keeps it and says ready.
  run rightOverWrongTest =
    initWith(false, false)
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
  // room changes before the new file is hashed. Before, the page announced
  // the old hash, which the server took as the host's, with the new size.
  // Once hashed, the wrong ROM is refused either way.
  run wrongOverRightTest =
    initWith(true, false)
      .then(drop("right"))
      .then(hashLands(1, "right"))
      .then(hostArrives)
      .then(drop("wrong"))
      .then(roomUpdate)
      .expect(neverAnnouncesAStaleRom == JUDGE_OWN_HASH)
      .expect(told == (if (DROP_SAYS_NOT_READY) "none" else "right"))
      .then(hashLands(2, "wrong"))
      .expect(loaded == "none")
      .expect(banner)

  // Two drops, the second (the host's ROM) hashed first; the first's hash
  // lands late. Before, that late hash was taken as the loaded ROM's and
  // refused the host's ROM; judging by own hash alone, the page kept the ROM
  // but lost its own hash, so it could never be announced again. Today the
  // late hash changes nothing.
  run twoDropsTest =
    initWith(true, false)
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
    initWith(true, false)
      .then(hostArrives)
      .then(drop("wrong"))
      .then(pick("right"))
      .expect(told == "right")
      .then(hashLands(1, "wrong"))
      .expect(aRightRomStays == JUDGE_OWN_HASH)
      .expect(allHold == (JUDGE_OWN_HASH and HASH_KEEPS_ITS_LOAD))

  // The guest has the host's ROM, the server has heard so, and the guest
  // drops a wrong one; the host presses Start before it is hashed. Unless the
  // drop said "not ready", the server counts the guest in on the previous
  // ROM's word.
  run startWhileHashingTest =
    initWith(true, false)
      .then(drop("right"))
      .then(hashLands(1, "right"))
      .then(hostArrives)
      .then(drop("wrong"))
      .then(start)
      .expect(aStartCountsOnlyTheLoadedRom == DROP_SAYS_NOT_READY)
      .expect(started == not(DROP_SAYS_NOT_READY))

  // A wrong ROM of another size is refused while it is still being hashed:
  // the size is enough.
  run wrongSizeWhileHashingTest =
    initWith(false, false)
      .then(drop("wrong"))
      .then(hostArrives)
      .expect(loaded == "none")
      .expect(banner)
      .then(hashLands(1, "wrong"))
      .expect(loaded == "none")
      .expect(neverAnnouncesAStaleRom == JUDGE_OWN_HASH)
      // A late hash taken as the page's hides the banner it just showed.
      .expect(banner == HASH_KEEPS_ITS_LOAD)

  // The host shares its ROM, so the server starts without the guest's word.
  // The guest has just dropped a wrong ROM the host's size when the start
  // reaches it. Unless the plan waits for the hash, it boots that ROM.
  run bootWhileHashingTest =
    initWith(true, true)
      .then(hostArrives)
      .then(drop("wrong"))
      .then(start)
      .then(gameStarted)
      .expect(neverBootsAWrongRom == BOOT_WAITS_FOR_HASH)
      .expect(plan == (if (BOOT_WAITS_FOR_HASH) "awaiting" else "booted"))
      .then(hashLands(1, "wrong"))
      .expect(loaded == "none")
      .expect(plan == (if (BOOT_WAITS_FOR_HASH) "awaiting" else "booted"))

  // The same with the host's ROM: waiting for the hash, the page joins late
  // once it lands.
  run bootWaitsThenJoinsTest =
    initWith(true, true)
      .then(hostArrives)
      .then(drop("right"))
      .then(start)
      .then(gameStarted)
      .expect(plan == (if (BOOT_WAITS_FOR_HASH) "awaiting" else "booted"))
      .then(hashLands(1, "right"))
      .expect(plan == "booted")
      .expect(allHold)

  // The host drops a new ROM and presses Start before it is hashed.
  run hostStartsWhileHashingTest =
    initWith(true, true)
      .then(hostArrives)
      .then(hostDrops(false))
      .then(start)
      .expect(theHostStartsOnItsOwnHash == HOST_START_WAITS_FOR_HASH)
      .expect(started == not(HOST_START_WAITS_FOR_HASH))

  // A dropped file's hash fails. Unless that refuses the ROM, it stays
  // pending for good: never announced, never judged.
  run hashFailsTest =
    initWith(true, false)
      .then(drop("right"))
      .then(hashFails(1, "right"))
      .expect(aSettledRomKeepsItsHash == FAILED_HASH_REFUSES)
      .expect(loaded == (if (FAILED_HASH_REFUSES) "none" else "right"))

  // The guest has the host's ROM and the server has heard so; its socket
  // drops, it drops a wrong ROM (its "not ready" never leaves), and it
  // rejoins before the file is hashed. Unless the rejoin says "not ready",
  // the server still holds the previous ROM's word and a start counts it.
  // Seven steps: past the exhaustive bound, so this scenario checks it.
  run rejoinWhileHashingTest =
    initWith(true, false)
      .then(drop("right"))
      .then(hashLands(1, "right"))
      .then(hostArrives)
      .then(dropSocket)
      .then(drop("wrong"))
      .then(rejoin)
      .then(start)
      .expect(aStartCountsOnlyTheLoadedRom == (DROP_SAYS_NOT_READY and REJOIN_SAYS_PENDING))

  // The host's ROM is known, and the host drops another: the one the guest
  // is about to drop (the guest's "wrong" is "right" from here on). The
  // guest drops it, and its hash lands before the host's. With the host's
  // drop unsaid, the room still names the host's previous ROM, and the
  // guest's ROM, the host's new one, is refused against it. Today the room's
  // ROM is changing: the guest's page waits, and the host's hash, landing,
  // finds the guest's ROM is the host's and it is announced.
  run hostChangesToTheGuestsRomTest =
    initWith(true, false)
      .then(hostArrives)
      .then(hostDrops(true))
      .then(drop("right"))
      .then(hashLands(1, "right"))
      .expect(aRightRomStays == HOST_DROP_SAYS_CHANGING)
      .expect(loaded == (if (HOST_DROP_SAYS_CHANGING) "right" else "none"))
      .then(hostHashLands)
      .expect(told == (if (HOST_DROP_SAYS_CHANGING) "right" else "none"))
      .expect(allHold == HOST_DROP_SAYS_CHANGING)

  // The guest holds the host's ROM, and the server has heard so; the host
  // drops another, one the guest has never held. With the host's drop
  // unsaid, the room names the host's previous ROM while the new one is
  // hashed: the server still counts the guest ready on it, and the page says
  // so again at the next room change. Today the server drops the guest's
  // word at once and the page waits. Either way the host's hash, landing,
  // drops the guest's word and refuses its ROM.
  run hostChangesAwayFromTheGuestsRomTest =
    initWith(true, false)
      .then(hostArrives)
      .then(drop("right"))
      .then(hashLands(1, "right"))
      .expect(told == "right")
      .then(hostDrops(false))
      .then(roomUpdate)
      .expect(theServerCountsOnlyTheHostsRom == HOST_DROP_SAYS_CHANGING)
      .expect(told == (if (HOST_DROP_SAYS_CHANGING) "none" else "wrong"))
      .then(hostHashLands)
      .expect(told == "none")
      .expect(loaded == "none")
      .expect(banner)

  // The same, and the host presses Start while its new ROM is hashed. No
  // start takes the guest's word for the host's previous ROM while the
  // host's Start waits for its own hash (or the server refuses while the
  // room's ROM is changing); without either (#289 as first pushed), the
  // start was taken on it.
  run hostChangesThenStartsTest =
    initWith(true, false)
      .then(hostArrives)
      .then(drop("right"))
      .then(hashLands(1, "right"))
      .then(hostDrops(false))
      .then(start)
      .expect(aStartCountsOnlyTheHostsRom == (HOST_START_WAITS_FOR_HASH or HOST_DROP_SAYS_CHANGING))
      .expect(started == not(HOST_START_WAITS_FOR_HASH or HOST_DROP_SAYS_CHANGING))

  // The players agree to switch games and the guest drops the new ROM a
  // moment before the host does: its copy lands in the library, and it is
  // refused, correctly, against the ROM the host still holds. The host then
  // drops the same ROM (the guest's "wrong" is "right" from here on), and its
  // hash lands. Until now the guest stayed without a ROM and had to drop it
  // again; today the page loads it from the library and says ready.
  run guestDroppedFirstTest =
    initWith(true, false)
      .then(hostArrives)
      .then(drop("wrong"))
      .then(cacheLands("wrong"))
      .then(hashLands(1, "wrong"))
      .expect(loaded == "none")
      .expect(banner)
      .then(hostDrops(true))
      .then(hostHashLands)
      .expect(theHostsRomComesFromTheLibrary == HOST_ROM_FROM_LIBRARY)
      .expect(loaded == (if (HOST_ROM_FROM_LIBRARY) "right" else "none"))
      .expect(told == (if (HOST_ROM_FROM_LIBRARY) "right" else "none"))

  // The same, but the dropped file's copy lands in the library only after the
  // room names the host's ROM: the lookup then found nothing. #316 as first
  // pushed left the guest without it; today the copy, landing, is loaded.
  run cacheLandsLateTest =
    initWith(true, false)
      .then(hostArrives)
      .then(drop("wrong"))
      .then(hashLands(1, "wrong"))
      .expect(loaded == "none")
      .then(hostDrops(true))
      .then(hostHashLands)
      .expect(loaded == "none")
      .expect(theHostsRomComesFromTheLibrary)
      .then(cacheLands("right"))
      .expect(theHostsRomComesFromTheLibrary == (HOST_ROM_FROM_LIBRARY and LOOKS_WHEN_CACHED))
      .expect(loaded == (if (HOST_ROM_FROM_LIBRARY and LOOKS_WHEN_CACHED) "right" else "none"))
      .expect(told == (if (HOST_ROM_FROM_LIBRARY and LOOKS_WHEN_CACHED) "right" else "none"))

  // A guest refused against the host's ROM looks in its library for it, as
  // it always has (refuseRom): the host's ROM, picked earlier, comes back.
  run refusalLooksInTheLibraryTest =
    initWith(true, false)
      .then(hostArrives)
      .then(pick("right"))
      .then(drop("wrong"))
      .then(hashLands(2, "wrong"))
      .expect(loaded == "right")
      .expect(told == "right")
      .expect(not(banner))
}

// Before: every check and every rom-ready read `_romHash`, whatever load it
// was computed for.
module rom_identity_before {
  import rom_identity(
    JUDGE_OWN_HASH = false,
    HASH_KEEPS_ITS_LOAD = false,
    DROP_SAYS_NOT_READY = false,
    BOOT_WAITS_FOR_HASH = false,
    HOST_START_WAITS_FOR_HASH = false,
    FAILED_HASH_REFUSES = false,
    REJOIN_SAYS_PENDING = false,
    HOST_DROP_SAYS_CHANGING = false,
    HOST_ROM_FROM_LIBRARY = false,
    LOOKS_WHEN_CACHED = false,
  ).*
}

// Judging by the ROM's own hash, but a late hash still taken as the
// loaded ROM's.
module rom_identity_judge_only {
  import rom_identity(
    JUDGE_OWN_HASH = true,
    HASH_KEEPS_ITS_LOAD = false,
    DROP_SAYS_NOT_READY = false,
    BOOT_WAITS_FOR_HASH = false,
    HOST_START_WAITS_FOR_HASH = false,
    FAILED_HASH_REFUSES = false,
    REJOIN_SAYS_PENDING = false,
    HOST_DROP_SAYS_CHANGING = false,
    HOST_ROM_FROM_LIBRARY = false,
    LOOKS_WHEN_CACHED = false,
  ).*
}

// Each hash kept with its load, but a drop leaving the server with the
// previous ROM's word while the new file is hashed.
module rom_identity_no_retract {
  import rom_identity(
    JUDGE_OWN_HASH = true,
    HASH_KEEPS_ITS_LOAD = true,
    DROP_SAYS_NOT_READY = false,
    BOOT_WAITS_FOR_HASH = false,
    HOST_START_WAITS_FOR_HASH = false,
    FAILED_HASH_REFUSES = false,
    REJOIN_SAYS_PENDING = false,
    HOST_DROP_SAYS_CHANGING = false,
    HOST_ROM_FROM_LIBRARY = false,
    LOOKS_WHEN_CACHED = false,
  ).*
}

// #289 as first pushed: the plans boot a ROM still being hashed, the host
// starts on its previous hash, a failed hash leaves the ROM pending for
// good, and a rejoin leaves the server with the previous ROM's word.
module rom_identity_first_push {
  import rom_identity(
    JUDGE_OWN_HASH = true,
    HASH_KEEPS_ITS_LOAD = true,
    DROP_SAYS_NOT_READY = true,
    BOOT_WAITS_FOR_HASH = false,
    HOST_START_WAITS_FOR_HASH = false,
    FAILED_HASH_REFUSES = false,
    REJOIN_SAYS_PENDING = false,
    HOST_DROP_SAYS_CHANGING = false,
    HOST_ROM_FROM_LIBRARY = false,
    LOOKS_WHEN_CACHED = false,
  ).*
}

// #289: a guest's page judges only by its own ROM's hash, but the host's
// drop says nothing, so the room names the host's previous ROM while the
// new one is hashed.
module rom_identity_host_silent {
  import rom_identity(
    JUDGE_OWN_HASH = true,
    HASH_KEEPS_ITS_LOAD = true,
    DROP_SAYS_NOT_READY = true,
    BOOT_WAITS_FOR_HASH = true,
    HOST_START_WAITS_FOR_HASH = true,
    FAILED_HASH_REFUSES = true,
    REJOIN_SAYS_PENDING = true,
    HOST_DROP_SAYS_CHANGING = false,
    HOST_ROM_FROM_LIBRARY = false,
    LOOKS_WHEN_CACHED = false,
  ).*
}

// #303: the host's drop says its ROM is changing, but a page that holds no
// ROM when the room names the host's does not look in its library.
module rom_identity_no_library {
  import rom_identity(
    JUDGE_OWN_HASH = true,
    HASH_KEEPS_ITS_LOAD = true,
    DROP_SAYS_NOT_READY = true,
    BOOT_WAITS_FOR_HASH = true,
    HOST_START_WAITS_FOR_HASH = true,
    FAILED_HASH_REFUSES = true,
    REJOIN_SAYS_PENDING = true,
    HOST_DROP_SAYS_CHANGING = true,
    HOST_ROM_FROM_LIBRARY = false,
    LOOKS_WHEN_CACHED = false,
  ).*
}

// #316 as first pushed: a page holding none looks in its library when the
// room names the host's ROM, but not again when a dropped file's copy lands
// there a moment later.
module rom_identity_no_cache_lookup {
  import rom_identity(
    JUDGE_OWN_HASH = true,
    HASH_KEEPS_ITS_LOAD = true,
    DROP_SAYS_NOT_READY = true,
    BOOT_WAITS_FOR_HASH = true,
    HOST_START_WAITS_FOR_HASH = true,
    FAILED_HASH_REFUSES = true,
    REJOIN_SAYS_PENDING = true,
    HOST_DROP_SAYS_CHANGING = true,
    HOST_ROM_FROM_LIBRARY = true,
    LOOKS_WHEN_CACHED = false,
  ).*
}

// Today: all of them.
module rom_identity_current {
  import rom_identity(
    JUDGE_OWN_HASH = true,
    HASH_KEEPS_ITS_LOAD = true,
    DROP_SAYS_NOT_READY = true,
    BOOT_WAITS_FOR_HASH = true,
    HOST_START_WAITS_FOR_HASH = true,
    FAILED_HASH_REFUSES = true,
    REJOIN_SAYS_PENDING = true,
    HOST_DROP_SAYS_CHANGING = true,
    HOST_ROM_FROM_LIBRARY = true,
    LOOKS_WHEN_CACHED = true,
  ).*
}
