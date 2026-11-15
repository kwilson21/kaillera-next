// -*- mode: Bluespec; -*-
//
// Whether a page boots a game it has no ROM for (web/static/play.js:
// clearLoadedRom, onGameStarted; web/src/play/game-start.ts: gameStartPlan;
// server/src/api/signaling.py: start-game, rom-ready).
//
// The server starts a game that is not streamed, with the host not sharing
// its ROM, only when every player has told it with `rom-ready` that a ROM is
// loaded. A page says so when it loads a ROM. Clearing one (deleting the
// loaded ROM from the ROM library, a ROM that is not the host's) did not say
// the page had none, so the server kept counting it as ready, the host
// could start, and the page's start plan answered `play` with no ROM: the
// emulator booted with nothing to run. Even once clearing says so, the
// message is on the socket while the host may press Start, so the plan must
// not boot without a ROM either: it asks for one, and a ROM dropped then
// joins the match late, as a late joiner's does.
//
// Not modelled: the host's ROM sharing (gameStartPlan's other answers,
// proved in game-start.ts), spectators and streamed games (no ROM needed),
// more than one guest (each is the same), a ROM that is not the host's (the
// page clears it, which is the clear here).
//
// CLEAR_SAYS_NOT_READY: clearLoadedRom sends `rom-ready {ready: false}`.
// PLAN_NEEDS_A_ROM: gameStartPlan never answers `play` without a ROM.
module rom_at_start {
  const CLEAR_SAYS_NOT_READY: bool
  const PLAN_NEEDS_A_ROM: bool

  var hasRom: bool // the page has a ROM loaded
  var told: List[bool] // `rom-ready` messages on the socket, oldest first
  var serverReady: bool // the page's socket is in room.rom_ready
  var started: bool // the server took the host's start-game
  var page: str // "lobby" | "booted" | "awaitingRom"
  var bootedWithoutRom: bool

  action init = all {
    hasRom' = false,
    told' = List(),
    serverReady' = false,
    started' = false,
    page' = "lobby",
    bootedWithoutRom' = false,
  }

  action unchangedServer = all { serverReady' = serverReady, started' = started }

  // The player loads a ROM (drop, library, cache): the page tells the server.
  action loadRom = all {
    not(hasRom),
    hasRom' = true,
    told' = told.append(true),
    unchangedServer,
    // A page waiting for a ROM in a started game joins it late with this one.
    page' = if (page == "awaitingRom") "booted" else page,
    bootedWithoutRom' = bootedWithoutRom,
  }

  // The page clears its ROM in the lobby.
  action clearRom = all {
    hasRom,
    page == "lobby",
    hasRom' = false,
    told' = if (CLEAR_SAYS_NOT_READY) told.append(false) else told,
    unchangedServer,
    page' = page,
    bootedWithoutRom' = bootedWithoutRom,
  }

  // The server handles the oldest message on the socket.
  action deliver = all {
    told.length() > 0,
    serverReady' = told.head(),
    told' = told.tail(),
    started' = started,
    hasRom' = hasRom,
    page' = page,
    bootedWithoutRom' = bootedWithoutRom,
  }

  // Nothing happens (for a scenario: the clear may have sent nothing).
  action nothing = all {
    hasRom' = hasRom,
    told' = told,
    unchangedServer,
    page' = page,
    bootedWithoutRom' = bootedWithoutRom,
  }

  action deliverAny = if (told.length() > 0) deliver else nothing

  // The host presses Start; the server takes it only with every player ready.
  action start = all {
    not(started),
    serverReady,
    started' = true,
    serverReady' = serverReady,
    told' = told,
    hasRom' = hasRom,
    page' = page,
    bootedWithoutRom' = bootedWithoutRom,
  }

  // The page handles `game-started` and does what its start plan says.
  action gameStarted = {
    val boots = (hasRom or not(PLAN_NEEDS_A_ROM))
    all {
      started,
      page == "lobby",
      page' = if (boots) "booted" else "awaitingRom",
      bootedWithoutRom' = (bootedWithoutRom or (boots and not(hasRom))),
      hasRom' = hasRom,
      told' = told,
      unchangedServer,
    }
  }

  action step = any { loadRom, clearRom, deliver, start, gameStarted }

  // The page never boots the emulator without a ROM. Violated before the
  // plan asked for one, even with clearing telling the server (a start
  // taken while the message was on the socket).
  val neverBootsWithoutRom = not(bootedWithoutRom)

  // With nothing on the socket, the server knows whether the page has a ROM.
  // Violated before clearing told it.
  val serverKnowsTheRom = told.length() == 0 implies serverReady == hasRom

  // A page in a started game that did not boot is waiting for a ROM, and
  // has none: dropping one is its way in.
  val aPageLeftOutIsAskedForARom = (started and page == "awaitingRom") implies not(hasRom)

  val allHold = neverBootsWithoutRom and serverKnowsTheRom and aPageLeftOutIsAskedForARom

  // The player loads a ROM, the server hears it, the player deletes it from
  // the ROM library.
  run deletedRomTest =
    init
      .then(loadRom)
      .then(deliver)
      .then(clearRom)
      .expect(serverKnowsTheRom == CLEAR_SAYS_NOT_READY)

  // The same, and the host presses Start before the server hears of the
  // delete (or never does): the page is told the game started.
  run startBeforeTheClearArrivesTest =
    init
      .then(loadRom)
      .then(deliver)
      .then(clearRom)
      .then(start)
      .then(gameStarted)
      .expect(neverBootsWithoutRom == PLAN_NEEDS_A_ROM)
      .expect(page == (if (PLAN_NEEDS_A_ROM) "awaitingRom" else "booted"))
      .expect(aPageLeftOutIsAskedForARom)

  // Asked for a ROM, the player drops one and the page joins the game.
  run aRomDroppedThenJoinsTest =
    init
      .then(loadRom)
      .then(deliver)
      .then(clearRom)
      .then(start)
      .then(gameStarted)
      .then(loadRom)
      .expect(page == "booted")
      .expect(neverBootsWithoutRom == PLAN_NEEDS_A_ROM)

  // Cleared, and everything on the socket heard before Start: the server
  // refuses the start once clearing says so.
  run clearedAndHeardTest =
    init
      .then(loadRom)
      .then(deliver)
      .then(clearRom)
      .then(deliverAny)
      .expect(serverReady == not(CLEAR_SAYS_NOT_READY))
}

// Before: clearing a ROM said nothing, and the plan answered `play` without one.
module rom_at_start_before {
  import rom_at_start(CLEAR_SAYS_NOT_READY = false, PLAN_NEEDS_A_ROM = false).*
}

// Clearing tells the server; the plan still boots without a ROM.
module rom_at_start_clear_only {
  import rom_at_start(CLEAR_SAYS_NOT_READY = true, PLAN_NEEDS_A_ROM = false).*
}

// Today: both.
module rom_at_start_current {
  import rom_at_start(CLEAR_SAYS_NOT_READY = true, PLAN_NEEDS_A_ROM = true).*
}
