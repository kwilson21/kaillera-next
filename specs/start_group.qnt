// -*- mode: Bluespec; -*-
//
// Who a page waits for before its match runs: the start group
// (web/static/netplay-rollback.js: createPeer, armStartupConnectWatchdog,
// retryStartupConnection, startGameSequence, checkAllEmuReady;
// web/static/play.js: onGameStarted's askForRom, onUsersUpdated).
//
// Once the host presses Start, a page connects to every other player. It
// starts its game sequence (the gesture prompt) when its first channel opens,
// and its match runs once every player it waits for is open and has booted.
// A player that never answers held that wait for ever:
//   - the startup watchdog retried the connection three times, 8 s apart,
//     then said "Peer connection stalled — reload or rejoin to retry" and
//     kept waiting: in a room of two the host never started;
//   - the watchdog stopped once the game sequence had started, so in a room
//     of three a third player who never answered held the match unstarted
//     without even a retry;
//   - a player whose start plan asked for a ROM (gameStartPlan's askForRom,
//     specs/rom_at_start.qnt) runs no engine until a ROM is dropped, and so
//     never answers.
// "Reload or rejoin" is not a recovery: the wait had no deadline that led
// anywhere (docs/netplay-invariants.md I1).
//
// Now the host decides the start group. A player its deadline gives up on
// is left out: its connection is closed and it is held as a late joiner, so
// the host's waits count it no longer, and a host with nobody left to wait
// for starts alone. The host tells the other players (`left-out:<slot>`, on
// each channel open now and on each that opens later), and they stop waiting
// for that player too: each page's match runs only once every player it
// waits for has booted, so a guest still waiting for a player the host left
// out held the host as well. A guest never leaves anyone out itself: two
// guests that cannot reach each other would run with different players. The
// player comes back through the late join. The deadline runs until the match
// runs. A player that takes the ROM prompt says it has no ROM (`rom-ready
// {ready: false}`), and the host, whose ROM is not shared, leaves it out at
// once instead of after the retries.
//
// Modelled from the host's side, with two other players (a room of three);
// a player that is not in the room is "absent". A player that answers
// answers everyone, so a guest's channel to another guest opens when that
// guest answers the host. Not modelled: the retries' timing (a deadline is a
// step that may come at any time), a guest the host never reaches though it
// is alive (it waits for an offer that does not come; separate work), a
// player who leaves the room (the roster removes it), spectators (no
// emulator), streaming (no mesh).
//
// GIVE_UP_LEAVES_OUT: the deadline's give-up leaves the player out of the
//   start group; before, it said the connection had stalled and waited on.
// DEADLINE_UNTIL_RUNNING: the deadline runs until the match runs; before, it
//   stopped once the game sequence had started.
// ROM_PROMPT_LEAVES_OUT: a player at the ROM prompt says it has no ROM and
//   is left out at once.
// HOST_TELLS_LEFT_OUT: the host tells the other players who it left out, and
//   they stop waiting for them.
module start_group {
  const GIVE_UP_LEAVES_OUT: bool
  const DEADLINE_UNTIL_RUNNING: bool
  const ROM_PROMPT_LEAVES_OUT: bool
  const HOST_TELLS_LEFT_OUT: bool

  // The startup watchdog's attempts (STARTUP_CONNECT_MAX_ATTEMPTS).
  pure val MAX_ATTEMPTS = 3
  pure val GUESTS = Set("g1", "g2")
  // What a player's page does once the game starts. "starting" answers the
  // connection; "awaitingRom" shows the ROM prompt and runs no engine;
  // "frozen" never answers (a tab stopped at start, a network with no
  // route); "absent" is not in the room.
  pure val STARTS = Set("starting", "awaitingRom", "frozen", "absent")

  // "lobby" | "waiting": the game started, no game sequence yet |
  // "sequence": the game sequence started (gesture prompt), the match not
  // yet running | "running".
  var host: str
  // The host's connection to each player: "none" (not in the room, or the
  // lobby) | "connecting" | "open" | "stalled" (given up, still waited for) |
  // "leftOut" (out of the start group, held as a late joiner).
  var conn: str -> str
  var attempt: str -> int
  // Each player's page: one of STARTS, then "lateJoining" (its ROM dropped,
  // it joins late) and "joined".
  var page: str -> str
  // The players left out whom the other players have heard of.
  var told: Set[str]

  action init = all {
    host' = "lobby",
    conn' = GUESTS.mapBy(_ => "none"),
    attempt' = GUESTS.mapBy(_ => 0),
    page' = GUESTS.mapBy(_ => "absent"),
    told' = Set(),
  }

  // The start group: the players the host waits for.
  val startGroup = GUESTS.filter(g => conn.get(g).in(Set("connecting", "open", "stalled")))

  // The host presses Start with these two players in the room as they are.
  action startWith(p1: str, p2: str): bool = {
    val pages = Map("g1" -> p1, "g2" -> p2)
    all {
      host == "lobby",
      // At least one other player: a host alone starts at once (solo mode).
      pages.keys().exists(g => pages.get(g) != "absent"),
      host' = "waiting",
      page' = pages,
      conn' = GUESTS.mapBy(g => if (pages.get(g) == "absent") "none" else "connecting"),
      attempt' = GUESTS.mapBy(g => if (pages.get(g) == "absent") 0 else 1),
      told' = told,
    }
  }

  action start = {
    nondet p1 = STARTS.oneOf()
    nondet p2 = STARTS.oneOf()
    startWith(p1, p2)
  }

  // A player that is starting answers: the channel opens. The host's first
  // open channel starts its game sequence.
  action answer(g: str): bool = all {
    conn.get(g) == "connecting",
    page.get(g) == "starting",
    conn' = conn.set(g, "open"),
    host' = if (host == "waiting") "sequence" else host,
    attempt' = attempt,
    page' = page,
    told' = told,
  }

  // The deadline is armed while the host waits for the game sequence, and
  // then until the match runs once it no longer stops there.
  val deadlineArmed = host == "waiting" or (DEADLINE_UNTIL_RUNNING and host == "sequence")

  // The leave-out: the player's connection closes and it is held as a late
  // joiner. With nobody left to wait for, the host starts alone.
  action leaveOut(g: str): bool = all {
    conn' = conn.set(g, "leftOut"),
    attempt' = attempt,
    page' = page,
    told' = if (HOST_TELLS_LEFT_OUT) told.union(Set(g)) else told,
    host' = {
      val rest = startGroup.exclude(Set(g))
      if (host == "waiting" and rest.size() == 0) "sequence" else host
    },
  }

  // The startup deadline: no open channel in time. Another attempt while
  // there are attempts left; then the give-up.
  action deadline(g: str): bool = all {
    deadlineArmed,
    conn.get(g) == "connecting",
    if (attempt.get(g) < MAX_ATTEMPTS)
      all { attempt' = attempt.set(g, attempt.get(g) + 1), conn' = conn, page' = page, host' = host, told' = told }
    else if (GIVE_UP_LEAVES_OUT)
      leaveOut(g)
    else
      all { conn' = conn.set(g, "stalled"), attempt' = attempt, page' = page, host' = host, told' = told },
  }

  // A player at the ROM prompt says it has no ROM; the host, whose ROM is
  // not shared, leaves it out of the start.
  action romPromptHeard(g: str): bool = all {
    ROM_PROMPT_LEAVES_OUT,
    page.get(g) == "awaitingRom",
    g.in(startGroup),
    host.in(Set("waiting", "sequence")),
    leaveOut(g),
  }

  // A player left out whom the other players still wait for: neither told
  // nor back by the late join.
  val waitedForBehindTheHost = GUESTS.filter(g => conn.get(g) == "leftOut" and not(told.contains(g)))

  // Every player in the start group is open, and none of them still waits
  // for a player the host left out: each one boots, and the match runs.
  val everyoneIsIn =
    startGroup.forall(g => conn.get(g) == "open") and (startGroup.size() == 0 or waitedForBehindTheHost.size() == 0)

  // The host's match runs once every player in its start group is in.
  action matchRuns = all {
    host == "sequence",
    everyoneIsIn,
    host' = "running",
    conn' = conn,
    attempt' = attempt,
    page' = page,
    told' = told,
  }

  // The player at the ROM prompt drops one: it joins late.
  action dropRom(g: str): bool = all {
    page.get(g) == "awaitingRom",
    page' = page.set(g, "lateJoining"),
    host' = host,
    conn' = conn,
    attempt' = attempt,
    told' = told,
  }

  // A late joiner joins a running match: the host serves it a player it holds
  // as a late joiner.
  action lateJoin(g: str): bool = all {
    page.get(g) == "lateJoining",
    host == "running",
    conn.get(g) == "leftOut",
    page' = page.set(g, "joined"),
    conn' = conn.set(g, "open"),
    host' = host,
    attempt' = attempt,
    told' = told,
  }

  action nothing = all { host' = host, conn' = conn, attempt' = attempt, page' = page, told' = told }

  action step = any {
    start,
    nondet g = GUESTS.oneOf()
    any { answer(g), deadline(g), romPromptHeard(g), dropRom(g), lateJoin(g) },
    matchRuns,
  }

  // ── properties ──────────────────────────────────────────────────────────

  // What could still move the host on.
  val anAnswerComes = GUESTS.exists(g => conn.get(g) == "connecting" and page.get(g) == "starting")
  val aDeadlineRuns = deadlineArmed and GUESTS.exists(g => conn.get(g) == "connecting")
  val aRomPromptIsHeard = ROM_PROMPT_LEAVES_OUT and startGroup.exists(g => page.get(g) == "awaitingRom")
  val theHostCanGoOn = or {
    host == "waiting" and GUESTS.exists(g => conn.get(g) == "open"),
    host == "sequence" and everyoneIsIn,
  }

  // A host that has started a game but whose match does not run always has a
  // way on: a player still answering, a deadline still armed, a ROM prompt it
  // will hear, or its own next step. VIOLATED while the give-up waited on
  // (start_group_before, aFrozenGuestTest: in a room of two the host never
  // starts) and while the deadline stopped at the game sequence
  // (start_group_give_up_only, aThirdPlayerFrozenTest).
  val neverStuck =
    host.in(Set("waiting", "sequence")) implies or { theHostCanGoOn, anAnswerComes, aDeadlineRuns, aRomPromptIsHeard }

  // A late joiner waiting on a running match is held as one: the host has
  // left it out of the start, so the late join can take it.
  val aLateJoinerIsHeldAsOne =
    GUESTS.forall(g => (page.get(g) == "lateJoining" and host == "running") implies conn.get(g) == "leftOut")

  // A running match waited for no player that was not answering.
  val aRunningMatchHasNoSilentPlayer =
    host == "running" implies startGroup.forall(g => conn.get(g) == "open")

  val allHold = neverStuck and aLateJoinerIsHeldAsOne and aRunningMatchHasNoSilentPlayer

  // ── scenarios ───────────────────────────────────────────────────────────

  // Steps a scenario takes only where the variant allows them.
  action deadlineAny(g: str): bool = if (deadlineArmed and conn.get(g) == "connecting") deadline(g) else nothing
  action matchRunsAny = if (host == "sequence" and everyoneIsIn) matchRuns else nothing
  action romPromptAny(g: str): bool =
    if (ROM_PROMPT_LEAVES_OUT and page.get(g) == "awaitingRom" and g.in(startGroup) and host.in(Set("waiting", "sequence")))
      romPromptHeard(g)
    else nothing
  action lateJoinAny(g: str): bool =
    if (page.get(g) == "lateJoining" and host == "running" and conn.get(g) == "leftOut") lateJoin(g) else nothing

  // A room of two; the guest's tab never answers. Before: three attempts, then
  // the host waits for ever. Now the give-up leaves the guest out and the host
  // starts alone.
  run aFrozenGuestTest =
    init
      .then(startWith("frozen", "absent"))
      .then(deadline("g1"))
      .then(deadline("g1"))
      .then(deadline("g1"))
      .expect(neverStuck == GIVE_UP_LEAVES_OUT)
      .then(matchRunsAny)
      .expect(host == (if (GIVE_UP_LEAVES_OUT) "running" else "waiting"))

  // A room of three; one guest answers, the other never does. The game
  // sequence starts on the first channel; before, the deadline stopped there
  // and the match waited for the silent player with nothing armed.
  run aThirdPlayerFrozenTest =
    init
      .then(startWith("starting", "frozen"))
      .then(answer("g1"))
      .expect(host == "sequence")
      .expect(neverStuck == DEADLINE_UNTIL_RUNNING)
      .then(deadlineAny("g2"))
      .then(deadlineAny("g2"))
      .then(deadlineAny("g2"))
      .then(matchRunsAny)
      .expect(host == (if (GIVE_UP_LEAVES_OUT and DEADLINE_UNTIL_RUNNING and HOST_TELLS_LEFT_OUT) "running" else "sequence"))
      .expect(neverStuck == (GIVE_UP_LEAVES_OUT and DEADLINE_UNTIL_RUNNING and HOST_TELLS_LEFT_OUT))

  // A room of two; the guest has no ROM and takes the ROM prompt
  // (tests/test_gesture_prompt.py found it). The host leaves it out at once
  // and starts; the guest drops a ROM and joins late. Without the word from
  // the ROM prompt the give-up still gets there, after the retries.
  run aRomPromptGuestTest =
    init
      .then(startWith("awaitingRom", "absent"))
      .then(romPromptAny("g1"))
      .expect(host == (if (ROM_PROMPT_LEAVES_OUT) "sequence" else "waiting"))
      .then(deadlineAny("g1"))
      .then(deadlineAny("g1"))
      .then(deadlineAny("g1"))
      .then(matchRunsAny)
      .then(dropRom("g1"))
      .then(lateJoinAny("g1"))
      .expect(page.get("g1") == (if (GIVE_UP_LEAVES_OUT or ROM_PROMPT_LEAVES_OUT) "joined" else "lateJoining"))
      .expect(allHold == (GIVE_UP_LEAVES_OUT or ROM_PROMPT_LEAVES_OUT))

  // Two players who answer: nobody is left out and the match runs.
  run everyoneAnswersTest =
    init
      .then(startWith("starting", "starting"))
      .then(answer("g2"))
      .then(answer("g1"))
      .then(matchRuns)
      .expect(host == "running")
      .expect(startGroup == GUESTS)
      .expect(allHold)
}

// Before: the give-up waited on, and the deadline stopped at the game sequence.
module start_group_before {
  import start_group(
    GIVE_UP_LEAVES_OUT = false,
    DEADLINE_UNTIL_RUNNING = false,
    ROM_PROMPT_LEAVES_OUT = false,
    HOST_TELLS_LEFT_OUT = false,
  ).*
}

// The give-up leaves the player out, but the deadline still stops at the game
// sequence: a room of three still waits on its silent player.
module start_group_give_up_only {
  import start_group(
    GIVE_UP_LEAVES_OUT = true,
    DEADLINE_UNTIL_RUNNING = false,
    ROM_PROMPT_LEAVES_OUT = false,
    HOST_TELLS_LEFT_OUT = false,
  ).*
}

// The host leaves the player out at every stage but tells nobody: in a room
// of three the other guest still waits for it, and so does the host's match.
module start_group_untold {
  import start_group(
    GIVE_UP_LEAVES_OUT = true,
    DEADLINE_UNTIL_RUNNING = true,
    ROM_PROMPT_LEAVES_OUT = false,
    HOST_TELLS_LEFT_OUT = false,
  ).*
}

// The deadline leads somewhere at every stage, without the ROM prompt's word:
// a player at the ROM prompt is left out only after the retries.
module start_group_deadline_only {
  import start_group(
    GIVE_UP_LEAVES_OUT = true,
    DEADLINE_UNTIL_RUNNING = true,
    ROM_PROMPT_LEAVES_OUT = false,
    HOST_TELLS_LEFT_OUT = true,
  ).*
}

// Today: all four.
module start_group_current {
  import start_group(
    GIVE_UP_LEAVES_OUT = true,
    DEADLINE_UNTIL_RUNNING = true,
    ROM_PROMPT_LEAVES_OUT = true,
    HOST_TELLS_LEFT_OUT = true,
  ).*
}
