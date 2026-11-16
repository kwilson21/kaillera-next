// -*- mode: Bluespec; -*-
//
// Which ROM a guest's page judges, announces and boots while a ROM it was
// given is still being hashed (web/static/play.js: loadRomData,
// loadRomFromLibrary, clearLoadedRom, handleHostRomChanged, notifyRomReady,
// onGameStarted, the join-room and rejoin paths, startGame; the server's
// rom-ready and start-game checks in server/src/api/signaling.py).
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
// "right" is the host's ROM, "wrong" is not. A wrong ROM may be the same
// size as the host's (two releases of one game often are), and the server
// and the page check the size first. A load is each change of the page's
// ROM: a drop, a pick from the ROM library (whose hash is known at once), a
// clear.
//
// What is modelled: one guest, the host's ROM becoming known once, drops,
// library picks and clears in any order, their hashes landing or failing in
// any order, the guest's socket dropping and the page rejoining, the host
// sharing its ROM or not, and a start: the host's Start (the host's own drop
// being hashed or not), the server taking it, and the guest's page deciding
// what to do with it. The server's view is what the page last told it while
// its socket was up, heard at once (rom_at_start.qnt has the socket's
// ordering), and the server keeps it across a rejoin.
//
// Not modelled: what the host's new ROM means for the guests (the host
// changing its ROM; its drop is here only for its own Start), the ROM
// transfer (its hash is the host's, known at once), the host's ROM arriving
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
module rom_identity {
  const JUDGE_OWN_HASH: bool
  const HASH_KEEPS_ITS_LOAD: bool
  const DROP_SAYS_NOT_READY: bool
  const BOOT_WAITS_FOR_HASH: bool
  const HOST_START_WAITS_FOR_HASH: bool
  const FAILED_HASH_REFUSES: bool
  const REJOIN_SAYS_PENDING: bool

  pure val ROMS = Set("right", "wrong")

  var sameSize: bool // the wrong ROM is the size of the host's
  var sharing: bool // the host shares its ROM: the server starts without the guest's word
  var up: bool // the guest's socket is connected
  var loaded: str // the ROM the page holds: "none" | "right" | "wrong"
  var load: int // which load that is
  var loadedIsDrop: bool // the player dropped it (its refusal shows a banner)
  var hash: str // `_romHash`: "none" | "right" | "wrong"
  var hashLoad: int // the load `hash` was computed for
  var hashing: Set[(int, str)] // drops being hashed: (load, ROM)
  var hostKnown: bool // the host's ROM has reached the page
  var told: str // the server's word for this page: "none" (not ready) | "nohash" | a ROM
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

  def wordFor(h: str): str = if (h == "none") "nohash" else h

  def staleWord(h: str): bool = loaded == "none" or (h != "none" and h != loaded)

  // The server counts the page ready on a word that is not about the ROM it
  // holds: a hash that is not its ROM's, or no hash for an earlier load.
  def serverWordIsStale = told != "none" and (if (told == "nohash") toldFor != load else told != loaded)

  // The start and late-join plans: whether they count a ROM the page holds.
  def planHasRom(v: str): bool = if (BOOT_WAITS_FOR_HASH) (v == "match" or v == "mismatch") else loaded != "none"

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
    hostKnown' = false,
    told' = "none",
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
  }

  action init = { nondet same = oneOf(Set(true, false)) nondet shares = oneOf(Set(true, false)) initWith(same, shares) }

  // A word to the server; it goes only while the socket is up.
  action tell(t: str, forLoad: int, stale: bool): bool = all {
    told' = if (up) t else told,
    toldFor' = if (up) forLoad else toldFor,
    toldStale' = (toldStale or (up and stale)),
  }

  action keepTold = all { told' = told, toldFor' = toldFor, toldStale' = toldStale }

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
    hostKnown' = hostKnown,
    hostHashing' = hostHashing,
    started' = started,
  }

  action unchangedStart = all {
    plan' = plan,
    bootedWrong' = bootedWrong,
    startedStale' = startedStale,
    hostStartedStale' = hostStartedStale,
  }

  // The page clears its ROM and says it has none (clearLoadedRom): as not the
  // host's (a dropped one with the banner), or as unreadable.
  action refuse(notTheHosts: bool, showBanner: bool): bool = all {
    loaded' = "none",
    load' = load + 1,
    loadedIsDrop' = false,
    hash' = "none",
    hashLoad' = load + 1,
    tell("none", load + 1, false),
    banner' = showBanner,
    clearedRight' = (clearedRight or (notTheHosts and loaded == "right")),
  }

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
    unchangedWorld,
    unchangedStart,
  }

  // The player (or the page, matching the host's hash) picks a ROM from the
  // library: its hash is known at once (loadRomFromLibrary). A page waiting
  // in a started game joins it late with a ROM that is the host's.
  action pick(r: str): bool = {
    val v = verdictOf(JUDGE_OWN_HASH, true, true, hostKnown, r, r == "wrong" and not(sameSize))
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
        tell(r, load + 1, false),
        banner' = false,
        clearedRight' = clearedRight,
      },
      plan' = if (joins) "booted" else plan,
      bootedWrong' = (bootedWrong or (joins and r == "wrong")),
      startedStale' = startedStale,
      hostStartedStale' = hostStartedStale,
      hashing' = hashing,
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
    unchangedWorld,
    unchangedStart,
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
      sharing' = sharing,
      up' = up,
      hostHashing' = hostHashing,
      started' = started,
      unchangedStart,
      if (v == "mismatch") refuse(true, loadedIsDrop)
      else all {
        unchangedRom,
        banner' = banner,
        clearedRight' = clearedRight,
        if (v == "match") announce else keepTold,
      },
    }
  }

  // The room changes (users-updated): the page says it is ready with its ROM
  // unless that is known not to be the host's.
  action roomUpdate = all {
    if (verdict == "match") announce else keepTold,
    unchangedRom,
    banner' = banner,
    clearedRight' = clearedRight,
    hashing' = hashing,
    unchangedWorld,
    unchangedStart,
  }

  // A dropped file's hash lands (the FileReader's onload): the page takes it
  // as its ROM's hash, then refuses the ROM if the host's is known and it is
  // not that, or else announces it, and a page waiting in a started game
  // joins it late (dismissLateJoinPrompt).
  action hashLands(l: int, r: str): bool = {
    val v = verdictOf(JUDGE_OWN_HASH, loaded != "none", l == load, hostKnown, r, sizeDiffers)
    // The onload announces with the hash it just set, whatever the page holds.
    val sends = not(JUDGE_OWN_HASH and l != load)
    val joins = plan == "awaiting" and v == "match" and loaded != "none"
    all {
      hashing.contains((l, r)),
      hashing' = hashing.exclude(Set((l, r))),
      unchangedWorld,
      startedStale' = startedStale,
      hostStartedStale' = hostStartedStale,
      if (HASH_KEEPS_ITS_LOAD and l != load) all {
        unchangedRom,
        banner' = banner,
        clearedRight' = clearedRight,
        keepTold,
        plan' = plan,
        bootedWrong' = bootedWrong,
      } else if (v == "mismatch") all {
        refuse(true, true),
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
    startedStale' = startedStale,
    hostStartedStale' = hostStartedStale,
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
    keepTold,
    banner' = banner,
    clearedRight' = clearedRight,
    hashing' = hashing,
    sameSize' = sameSize,
    sharing' = sharing,
    hostKnown' = hostKnown,
    hostHashing' = hostHashing,
    started' = started,
    unchangedStart,
  }

  // The page rejoins: the server carries the old socket's word over, and the
  // page says what it has (a ROM it can announce, none, or one being hashed).
  action rejoin = all {
    not(up),
    up' = true,
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
    hostKnown' = hostKnown,
    hostHashing' = hostHashing,
    started' = started,
    unchangedStart,
  }

  // The host drops a new ROM of its own (here only for its own Start).
  action hostDrops = all {
    not(started),
    not(hostHashing),
    hostHashing' = true,
    unchangedRom,
    keepTold,
    banner' = banner,
    clearedRight' = clearedRight,
    hashing' = hashing,
    sameSize' = sameSize,
    sharing' = sharing,
    up' = up,
    hostKnown' = hostKnown,
    started' = started,
    unchangedStart,
  }

  action hostHashLands = all {
    hostHashing,
    hostHashing' = false,
    unchangedRom,
    keepTold,
    banner' = banner,
    clearedRight' = clearedRight,
    hashing' = hashing,
    sameSize' = sameSize,
    sharing' = sharing,
    up' = up,
    hostKnown' = hostKnown,
    started' = started,
    unchangedStart,
  }

  // The host presses Start. The host's page refuses while its own ROM is
  // being hashed (HOST_START_WAITS_FOR_HASH); the server takes it when the
  // host shares its ROM or the guest's word says ready.
  action start = {
    val hostRefuses = HOST_START_WAITS_FOR_HASH and hostHashing
    val takes = not(hostRefuses) and (sharing or told != "none")
    all {
      not(started),
      hostKnown,
      started' = takes,
      // While the guest's socket is down the server holds its last word,
      // whatever the page does (rom_at_start.qnt, clearedWhileDownTest).
      startedStale' = (startedStale or (takes and up and not(sharing) and serverWordIsStale)),
      hostStartedStale' = (hostStartedStale or (takes and hostHashing)),
      plan' = plan,
      bootedWrong' = bootedWrong,
      unchangedRom,
      keepTold,
      banner' = banner,
      clearedRight' = clearedRight,
      hashing' = hashing,
      sameSize' = sameSize,
      sharing' = sharing,
      up' = up,
      hostKnown' = hostKnown,
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
      unchangedRom,
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
    dropSocket,
    rejoin,
    hostDrops,
    hostHashLands,
    start,
    gameStarted,
  }

  // The page never tells the server a hash that is not the ROM it holds, and
  // never says it is ready with no ROM.
  val neverAnnouncesAStaleRom = not(toldStale)

  // The page never clears the host's ROM as not the host's.
  val aRightRomStays = not(clearedRight)

  // With the socket up, nothing being hashed and the host's ROM known, the
  // page holds the host's ROM and has said so, or holds none.
  val aSettledRomIsTheHosts =
    (up and hashing == Set() and hostKnown and loaded != "none") implies (loaded == "right" and told == "right")

  // Once nothing is being hashed, the hash the page holds is its ROM's own.
  val aSettledRomKeepsItsHash = (hashing == Set() and loaded != "none") implies (hashLoad == load and hash == loaded)

  // A start never counts the page ready, with its socket up, on a word that
  // is not about the ROM it holds.
  val aStartCountsOnlyTheLoadedRom = not(startedStale)

  // The page never boots a ROM that is not the host's.
  val neverBootsAWrongRom = not(bootedWrong)

  // The host never starts on a hash that is not its loaded ROM's.
  val theHostStartsOnItsOwnHash = not(hostStartedStale)

  val allHold = and {
    neverAnnouncesAStaleRom,
    aRightRomStays,
    aSettledRomIsTheHosts,
    aSettledRomKeepsItsHash,
    aStartCountsOnlyTheLoadedRom,
    neverBootsAWrongRom,
    theHostStartsOnItsOwnHash,
  }

  // The guest has a wrong ROM, drops the host's over it, and the host's ROM
  // arrives before the new file is hashed. Before, the old hash refused the
  // right ROM, and its hash, landing after, said ready with no ROM.
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

  // Two drops, the second (the host's ROM) hashed first: the first's hash,
  // landing late, is taken as the loaded ROM's. Before, it refused the host's
  // ROM; judging by own hash alone, the page keeps the ROM but its own hash
  // is gone, so it can never be announced again.
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
      .then(hostDrops)
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
  ).*
}
