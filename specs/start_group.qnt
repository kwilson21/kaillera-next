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
// runs. A player that takes the ROM prompt says so (`rom-ready {ready:
// false, prompt: true}`, the server's `romPrompt`), and the host, whose ROM
// is not shared, leaves it out at once instead of after the retries.
//
// Only the host sends `left-out:`, and a guest takes it only from the host's
// channel: one from another guest is dropped and logged. A left-out player
// whose page is alive must not be left in neither the start nor the late
// join: a page that has started normally and has no channel to the host by
// its own deadline joins late instead, as does a page at the ROM prompt once
// a ROM is dropped.
//
// A player that answered but has not loaded its emulator by the host's load
// deadline (60 s from when the host has loaded its own) is left out the same
// way, and told so, itself included (its channel is kept open for the word),
// and joins late: a core that crashed, a tab frozen after it connected, a
// player who never taps "Tap to start", or a page from before `left-out:`
// still waiting for a player the host left out (it ignores the word) no
// longer holds the start.
//
// The guest's deadline is the page's, not a connection's: armed when its
// engine starts, again whenever it loses its channel to the host before its
// match runs, and restarted at each offer the host sends, so it runs out only
// after the host's give-up (rejoinLate needs the host to have left the page
// out). Before, it hung on the connection and went with it: a guest whose
// connection failed after the host's last retry waited for ever
// (GUEST_DEADLINE_ON_LOSS). The give-up closes the connection: before, an
// attempt still in its ICE checks could open after the give-up, and the
// guest, with a channel to a host that no longer counted it, waited in
// neither group (GIVE_UP_CLOSES). A connection lost before the match runs is
// retried like one that never opened, and left out at the give-up: before,
// once the game sequence had started it was dropped without a word, and the
// other guest kept waiting for that player (LOST_IS_RETRIED).
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
// GUEST_REJOINS_LATE: a started page with no channel to the host by its own
//   deadline joins late.
// GIVE_UP_CLOSES: the give-up closes the connection, so it cannot open later.
// GUEST_DEADLINE_ON_LOSS: the guest's deadline is armed again when it loses
//   its connection to the host; before, it went with the connection.
// LOST_IS_RETRIED: a connection lost before the match runs is retried, then
//   given up on; before, after the game sequence had started it was dropped
//   and nobody was told.
// LOAD_DEADLINE: the host leaves out a player that answered but has not
//   loaded by its load deadline, and tells that player too.
module start_group {
  const GIVE_UP_LEAVES_OUT: bool
  const DEADLINE_UNTIL_RUNNING: bool
  const ROM_PROMPT_LEAVES_OUT: bool
  const HOST_TELLS_LEFT_OUT: bool
  const GUEST_REJOINS_LATE: bool
  const GIVE_UP_CLOSES: bool
  const GUEST_DEADLINE_ON_LOSS: bool
  const LOST_IS_RETRIED: bool
  const LOAD_DEADLINE: bool

  // The startup watchdog's attempts (STARTUP_CONNECT_MAX_ATTEMPTS).
  pure val MAX_ATTEMPTS = 3
  pure val GUESTS = Set("g1", "g2")
  // What a player's page does once the game starts. "starting" answers the
  // connection; "awaitingRom" shows the ROM prompt and runs no engine;
  // "frozen" never answers (a tab stopped at start, a network with no
  // route); "stuck" answers but never loads its emulator (a core that
  // crashed, a tab frozen after it connected); "absent" is not in the room.
  pure val STARTS = Set("starting", "awaitingRom", "frozen", "stuck", "absent")

  // "lobby" | "waiting": the game started, no game sequence yet |
  // "sequence": the game sequence started (gesture prompt), the match not
  // yet running | "running".
  var host: str
  // The host's connection to each player: "none" (not in the room, or the
  // lobby) | "connecting" | "open" | "stalled" (given up, still waited for) |
  // "leftOut" (out of the start group, held as a late joiner) | "dropped"
  // (lost and forgotten: not counted, not held, nobody told).
  var conn: str -> str
  var attempt: str -> int
  // Each player's page: one of STARTS, then "lateJoining" (its ROM dropped,
  // it joins late) and "joined".
  var page: str -> str
  // The players left out whom the other players have heard of.
  var told: Set[str]
  // The guests whose own deadline on the host is armed.
  var guestDeadline: Set[str]
  // The guests with a channel open to a host that has left them out.
  var openToNobody: Set[str]

  action init = all {
    host' = "lobby",
    conn' = GUESTS.mapBy(_ => "none"),
    attempt' = GUESTS.mapBy(_ => 0),
    page' = GUESTS.mapBy(_ => "absent"),
    told' = Set(),
    guestDeadline' = Set(),
    openToNobody' = Set(),
  }

  // The guest side's state, unchanged.
  action guestsKeep = all { guestDeadline' = guestDeadline, openToNobody' = openToNobody }

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
      // A page that starts its engine arms its deadline on the host.
      guestDeadline' = GUESTS.filter(g => pages.get(g) == "starting"),
      openToNobody' = openToNobody,
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
    page.get(g).in(Set("starting", "stuck")),
    conn' = conn.set(g, "open"),
    host' = if (host == "waiting") "sequence" else host,
    attempt' = attempt,
    page' = page,
    told' = told,
    // Its channel to the host is open: the guest's deadline ends.
    guestDeadline' = guestDeadline.exclude(Set(g)),
    openToNobody' = openToNobody,
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
    guestsKeep,
  }

  // The startup deadline: no open channel in time. Another attempt while
  // there are attempts left; then the give-up.
  action deadline(g: str): bool = all {
    deadlineArmed,
    conn.get(g) == "connecting",
    if (attempt.get(g) < MAX_ATTEMPTS)
      all {
        attempt' = attempt.set(g, attempt.get(g) + 1),
        conn' = conn,
        page' = page,
        host' = host,
        told' = told,
        // The host's next offer restarts the guest's deadline.
        guestDeadline' = if (page.get(g) == "starting") guestDeadline.union(Set(g)) else guestDeadline,
        openToNobody' = openToNobody,
      }
    else if (GIVE_UP_LEAVES_OUT)
      leaveOut(g)
    else
      all {
        conn' = conn.set(g, "stalled"),
        attempt' = attempt,
        page' = page,
        host' = host,
        told' = told,
        guestsKeep,
      },
  }

  // An attempt still in its ICE checks at the give-up completes after it: the
  // guest has a channel open to a host that no longer counts it. Its deadline
  // sees the channel and does nothing. Only while the give-up leaves the
  // connection open.
  action lateOpen(g: str): bool = all {
    not(GIVE_UP_CLOSES),
    page.get(g) == "starting",
    conn.get(g) == "leftOut",
    not(openToNobody.contains(g)),
    openToNobody' = openToNobody.union(Set(g)),
    guestDeadline' = guestDeadline.exclude(Set(g)),
    host' = host,
    conn' = conn,
    attempt' = attempt,
    page' = page,
    told' = told,
  }

  // The guest's side of a connection that has not opened fails (the host
  // closed it at the give-up, or a network that never let it through): the
  // guest drops its connection to the host. Its deadline is armed again, or,
  // before, went with the connection.
  action guestLosesHost(g: str): bool = all {
    page.get(g) == "starting",
    conn.get(g).in(Set("connecting", "stalled", "leftOut", "dropped")),
    not(openToNobody.contains(g)),
    guestDeadline' =
      if (GUEST_DEADLINE_ON_LOSS) guestDeadline.union(Set(g)) else guestDeadline.exclude(Set(g)),
    openToNobody' = openToNobody,
    host' = host,
    conn' = conn,
    attempt' = attempt,
    page' = page,
    told' = told,
  }

  // An open connection is lost before the match runs. It is retried like one
  // that never opened; before, once the game sequence had started, the host
  // dropped it without a word.
  action lose(g: str): bool = all {
    host.in(Set("waiting", "sequence")),
    page.get(g) == "starting",
    conn.get(g) == "open",
    conn' = conn.set(g, if (LOST_IS_RETRIED) "connecting" else "dropped"),
    attempt' = attempt.set(g, 1),
    // The guest lost its channel to the host too.
    guestDeadline' = if (GUEST_DEADLINE_ON_LOSS) guestDeadline.union(Set(g)) else guestDeadline,
    openToNobody' = openToNobody,
    host' = host,
    page' = page,
    told' = told,
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

  // A player left out, or dropped, whom the other players still wait for:
  // neither told nor back by the late join.
  val waitedForBehindTheHost =
    GUESTS.filter(g => conn.get(g).in(Set("leftOut", "dropped")) and not(told.contains(g)))

  // A player in the start group has loaded: it answered, its emulator runs,
  // and it waits for no player the host left out without telling it.
  def ready(g: str): bool = and {
    conn.get(g) == "open",
    page.get(g) != "stuck",
    waitedForBehindTheHost.exclude(Set(g)).size() == 0,
  }

  // Every player in the start group has loaded: the match runs.
  val everyoneIsIn = startGroup.forall(g => ready(g))

  // The host's match runs once every player in its start group is in.
  action matchRuns = all {
    host == "sequence",
    everyoneIsIn,
    host' = "running",
    conn' = conn,
    attempt' = attempt,
    page' = page,
    told' = told,
    guestsKeep,
  }

  // The player at the ROM prompt drops one: it joins late.
  action dropRom(g: str): bool = all {
    page.get(g) == "awaitingRom",
    page' = page.set(g, "lateJoining"),
    host' = host,
    conn' = conn,
    attempt' = attempt,
    told' = told,
    guestsKeep,
  }

  // The host's load deadline: a player that answered has not loaded. It is
  // left out and told so, itself included: a page that hears it joins late
  // (its way into the late join is armed, as by its own deadline). A page
  // from before `left-out:` does not hear it.
  action loadDeadline(g: str): bool = all {
    LOAD_DEADLINE,
    host == "sequence",
    conn.get(g) == "open",
    not(ready(g)),
    conn' = conn.set(g, "leftOut"),
    told' = if (HOST_TELLS_LEFT_OUT) told.union(Set(g)) else told,
    guestDeadline' = if (HOST_TELLS_LEFT_OUT) guestDeadline.union(Set(g)) else guestDeadline,
    openToNobody' = openToNobody,
    host' = host,
    attempt' = attempt,
    page' = page,
  }

  // A page that started normally but was left out (it answered too late, or
  // its network never reached the host, or it had not loaded by the host's
  // load deadline and was told) has no channel to the host when its own
  // deadline runs out, or hears it is out: it joins late. The deadline restarts at each of the
  // host's offers, so it runs out only once the host has stopped trying.
  action rejoinLate(g: str): bool = all {
    GUEST_REJOINS_LATE,
    page.get(g) == "starting",
    conn.get(g).in(Set("leftOut", "dropped")),
    guestDeadline.contains(g),
    page' = page.set(g, "lateJoining"),
    guestDeadline' = guestDeadline.exclude(Set(g)),
    openToNobody' = openToNobody,
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
    guestsKeep,
  }

  action nothing = all { host' = host, conn' = conn, attempt' = attempt, page' = page, told' = told, guestsKeep }

  action step = any {
    start,
    nondet g = GUESTS.oneOf()
    any {
      answer(g),
      deadline(g),
      loadDeadline(g),
      lateOpen(g),
      guestLosesHost(g),
      lose(g),
      romPromptHeard(g),
      dropRom(g),
      rejoinLate(g),
      lateJoin(g),
    },
    matchRuns,
  }

  // ── properties ──────────────────────────────────────────────────────────

  // What could still move the host on.
  val anAnswerComes = GUESTS.exists(g => conn.get(g) == "connecting" and page.get(g) == "starting")
  val aDeadlineRuns = deadlineArmed and GUESTS.exists(g => conn.get(g) == "connecting")
  val aRomPromptIsHeard = ROM_PROMPT_LEAVES_OUT and startGroup.exists(g => page.get(g) == "awaitingRom")
  val aLoadDeadlineRuns =
    LOAD_DEADLINE and host == "sequence" and startGroup.exists(g => conn.get(g) == "open" and not(ready(g)))
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
    host.in(Set("waiting", "sequence")) implies or {
      theHostCanGoOn,
      anAnswerComes,
      aDeadlineRuns,
      aRomPromptIsHeard,
      aLoadDeadlineRuns,
    }

  // A late joiner waiting on a running match is held as one: the host has
  // left it out of the start, so the late join can take it.
  val aLateJoinerIsHeldAsOne =
    GUESTS.forall(g => (page.get(g) == "lateJoining" and host == "running") implies conn.get(g) == "leftOut")

  // A running match waited for no player that was not answering.
  val aRunningMatchHasNoSilentPlayer =
    host == "running" implies startGroup.forall(g => conn.get(g) == "open")

  // No player whose page is alive is in neither the start nor the late join:
  // a page that started normally and was left out, or dropped, has its own
  // deadline armed into the late join. VIOLATED while it waited for the
  // host's offer for ever (start_group_no_rejoin, aSlowGuestTest), while its
  // channel could open after the give-up (start_group_open_after_give_up,
  // aLateOpenTest), and while its deadline went with a connection that failed
  // (start_group_deadline_with_the_connection, aGuestLosesTheHostTest).
  val nobodyIsInNeither =
    GUESTS.forall(g =>
      (page.get(g) == "starting" and conn.get(g).in(Set("leftOut", "dropped")))
        implies (GUEST_REJOINS_LATE and guestDeadline.contains(g))
    )

  val allHold = neverStuck and aLateJoinerIsHeldAsOne and aRunningMatchHasNoSilentPlayer and nobodyIsInNeither

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
  action rejoinLateAny(g: str): bool =
    if (
      GUEST_REJOINS_LATE and page.get(g) == "starting" and conn.get(g).in(Set("leftOut", "dropped"))
        and guestDeadline.contains(g)
    )
      rejoinLate(g)
    else nothing
  action lateOpenAny(g: str): bool =
    if (not(GIVE_UP_CLOSES) and page.get(g) == "starting" and conn.get(g) == "leftOut") lateOpen(g) else nothing

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
      .expect(neverStuck == (GIVE_UP_LEAVES_OUT and DEADLINE_UNTIL_RUNNING and (HOST_TELLS_LEFT_OUT or LOAD_DEADLINE)))

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

  // A room of two; the guest's page is alive but its answer comes too late
  // (or never gets through): the host gives up and starts alone. The guest
  // then joins late by its own deadline; before, it waited for an offer that
  // did not come, in neither the start nor the late join.
  run aSlowGuestTest =
    init
      .then(startWith("starting", "absent"))
      .then(deadline("g1"))
      .then(deadline("g1"))
      .then(deadlineAny("g1"))
      .expect(nobodyIsInNeither == (GUEST_REJOINS_LATE or not(GIVE_UP_LEAVES_OUT)))
      .then(matchRunsAny)
      .then(rejoinLateAny("g1"))
      .then(lateJoinAny("g1"))
      .expect(page.get("g1") == (if (GIVE_UP_LEAVES_OUT and GUEST_REJOINS_LATE) "joined" else "starting"))

  // A room of two; the guest at the ROM prompt is left out at once, then has
  // its ROM a moment later, before the host's match runs: it waits, joining
  // late, until the match runs, and is then taken in. No ordering leaves it
  // in neither.
  run aRomReadyAMomentLaterTest =
    init
      .then(startWith("awaitingRom", "absent"))
      .then(romPromptAny("g1"))
      .then(dropRom("g1"))
      .expect(page.get("g1") == "lateJoining")
      .expect(allHold)
      .then(deadlineAny("g1"))
      .then(deadlineAny("g1"))
      .then(deadlineAny("g1"))
      .then(matchRunsAny)
      .then(lateJoinAny("g1"))
      .expect(page.get("g1") == (if (GIVE_UP_LEAVES_OUT or ROM_PROMPT_LEAVES_OUT) "joined" else "lateJoining"))

  // A room of two; the guest's answer is slow and the host gives up while the
  // last attempt is in its ICE checks. Before, that attempt could complete
  // afterwards: the guest had a channel open to a host that no longer counted
  // it, and its deadline, seeing the channel, did nothing.
  run aLateOpenTest =
    init
      .then(startWith("starting", "absent"))
      .then(deadline("g1"))
      .then(deadline("g1"))
      .then(deadline("g1"))
      .then(lateOpenAny("g1"))
      .expect(nobodyIsInNeither == (not(GIVE_UP_LEAVES_OUT) or (GIVE_UP_CLOSES and GUEST_REJOINS_LATE)))
      .then(matchRunsAny)
      .then(rejoinLateAny("g1"))
      .then(lateJoinAny("g1"))
      .expect(page.get("g1") == (if (GIVE_UP_LEAVES_OUT and GIVE_UP_CLOSES and GUEST_REJOINS_LATE) "joined" else "starting"))

  // A room of two; the guest's connection fails on its side after the host's
  // last retry (a network that never lets it through). Before, the guest's
  // deadline went with the connection, and no offer came again.
  run aGuestLosesTheHostTest =
    init
      .then(startWith("starting", "absent"))
      .then(deadline("g1"))
      .then(deadline("g1"))
      .then(deadline("g1"))
      .then(guestLosesHost("g1"))
      .expect(nobodyIsInNeither == (not(GIVE_UP_LEAVES_OUT) or (GUEST_DEADLINE_ON_LOSS and GUEST_REJOINS_LATE)))
      .then(matchRunsAny)
      .then(rejoinLateAny("g1"))
      .then(lateJoinAny("g1"))
      .expect(
        page.get("g1") == (if (GIVE_UP_LEAVES_OUT and GUEST_DEADLINE_ON_LOSS and GUEST_REJOINS_LATE) "joined" else "starting")
      )

  // A room of three; both guests answer, then one connection to the host is
  // lost before the match runs. Before, the host dropped it without a word:
  // the host stopped counting that player but the other guest still waited
  // for it, and the host for the other guest.
  run aLostAfterTheSequenceTest =
    init
      .then(startWith("starting", "starting"))
      .then(answer("g1"))
      .then(answer("g2"))
      .then(lose("g2"))
      .expect(neverStuck == (LOST_IS_RETRIED or LOAD_DEADLINE))
      .then(deadlineAny("g2"))
      .then(deadlineAny("g2"))
      .then(deadlineAny("g2"))
      .then(matchRunsAny)
      // The other guest still waits for a player it was not told of: the load
      // deadline leaves it out too.
      .then(loadDeadlineAny("g1"))
      .then(matchRunsAny)
      .expect(
        host == (
          if (LOAD_DEADLINE or (LOST_IS_RETRIED and HOST_TELLS_LEFT_OUT and DEADLINE_UNTIL_RUNNING)) "running"
          else "sequence"
        )
      )

  action loadDeadlineAny(g: str): bool =
    if (LOAD_DEADLINE and host == "sequence" and conn.get(g) == "open" and not(ready(g))) loadDeadline(g) else nothing

  // A room of two; the guest answers but its emulator never loads. Before,
  // the host waited at emu-ready for ever. Now its load deadline leaves the
  // guest out, and the match runs.
  run aStuckGuestTest =
    init
      .then(startWith("stuck", "absent"))
      .then(answer("g1"))
      .expect(host == "sequence")
      .expect(neverStuck == LOAD_DEADLINE)
      .then(loadDeadlineAny("g1"))
      .then(matchRunsAny)
      .expect(host == (if (LOAD_DEADLINE) "running" else "sequence"))

  // A room of three with a page from before `left-out:`: the other guest
  // answers, the third never does. The host leaves the third out but the old
  // page does not hear of it and waits for it. The load deadline leaves the
  // old page out too, and the host's match runs. The old page sits waiting
  // until it reloads (in neither the start nor the late join).
  run anOldGuestTest =
    init
      .then(startWith("starting", "frozen"))
      .then(answer("g1"))
      .then(deadlineAny("g2"))
      .then(deadlineAny("g2"))
      .then(deadlineAny("g2"))
      .then(matchRunsAny)
      .then(loadDeadlineAny("g1"))
      .then(matchRunsAny)
      .expect(
        host == (
          if (GIVE_UP_LEAVES_OUT and DEADLINE_UNTIL_RUNNING and (HOST_TELLS_LEFT_OUT or LOAD_DEADLINE)) "running"
          else "sequence"
        )
      )

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
    GUEST_REJOINS_LATE = false,
    GIVE_UP_CLOSES = false,
    GUEST_DEADLINE_ON_LOSS = false,
    LOST_IS_RETRIED = false,
    LOAD_DEADLINE = false,
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
    GUEST_REJOINS_LATE = false,
    GIVE_UP_CLOSES = false,
    GUEST_DEADLINE_ON_LOSS = false,
    LOST_IS_RETRIED = false,
    LOAD_DEADLINE = false,
  ).*
}

// A host of today with guests from before `left-out:` (they ignore the word,
// have no deadline of their own on the host, and say nothing at the ROM
// prompt the host takes for the prompt). The load deadline leaves an old page
// that waits for a player the host left out out too, so the host's match runs
// (neverStuck holds); the old page waits on, in neither the start nor the
// late join, until it reloads (nobodyIsInNeither does not).
module start_group_untold {
  import start_group(
    GIVE_UP_LEAVES_OUT = true,
    DEADLINE_UNTIL_RUNNING = true,
    ROM_PROMPT_LEAVES_OUT = true,
    HOST_TELLS_LEFT_OUT = false,
    GUEST_REJOINS_LATE = false,
    GIVE_UP_CLOSES = true,
    GUEST_DEADLINE_ON_LOSS = false,
    LOST_IS_RETRIED = true,
    LOAD_DEADLINE = true,
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
    GUEST_REJOINS_LATE = true,
    GIVE_UP_CLOSES = true,
    GUEST_DEADLINE_ON_LOSS = true,
    LOST_IS_RETRIED = true,
    LOAD_DEADLINE = true,
  ).*
}

// The same with #274's host, which has no load deadline: in a room of three
// the old page waits for the left-out player, and the host's match waits for
// the old page.
module start_group_untold_no_load {
  import start_group(
    GIVE_UP_LEAVES_OUT = true,
    DEADLINE_UNTIL_RUNNING = true,
    ROM_PROMPT_LEAVES_OUT = true,
    HOST_TELLS_LEFT_OUT = false,
    GUEST_REJOINS_LATE = false,
    GIVE_UP_CLOSES = true,
    GUEST_DEADLINE_ON_LOSS = false,
    LOST_IS_RETRIED = true,
    LOAD_DEADLINE = false,
  ).*
}

// The host's side complete, but a left-out page that started normally waits
// for an offer that does not come: in neither the start nor the late join.
module start_group_no_rejoin {
  import start_group(
    GIVE_UP_LEAVES_OUT = true,
    DEADLINE_UNTIL_RUNNING = true,
    ROM_PROMPT_LEAVES_OUT = true,
    HOST_TELLS_LEFT_OUT = true,
    GUEST_REJOINS_LATE = false,
    GIVE_UP_CLOSES = true,
    GUEST_DEADLINE_ON_LOSS = true,
    LOST_IS_RETRIED = true,
    LOAD_DEADLINE = true,
  ).*
}

// The first push of #274: the give-up left the connection open, the guest's
// deadline went with its connection, and a connection lost after the game
// sequence started was dropped without a word.
module start_group_open_after_give_up {
  import start_group(
    GIVE_UP_LEAVES_OUT = true,
    DEADLINE_UNTIL_RUNNING = true,
    ROM_PROMPT_LEAVES_OUT = true,
    HOST_TELLS_LEFT_OUT = true,
    GUEST_REJOINS_LATE = true,
    GIVE_UP_CLOSES = false,
    GUEST_DEADLINE_ON_LOSS = true,
    LOST_IS_RETRIED = true,
    LOAD_DEADLINE = true,
  ).*
}

module start_group_deadline_with_the_connection {
  import start_group(
    GIVE_UP_LEAVES_OUT = true,
    DEADLINE_UNTIL_RUNNING = true,
    ROM_PROMPT_LEAVES_OUT = true,
    HOST_TELLS_LEFT_OUT = true,
    GUEST_REJOINS_LATE = true,
    GIVE_UP_CLOSES = true,
    GUEST_DEADLINE_ON_LOSS = false,
    LOST_IS_RETRIED = true,
    LOAD_DEADLINE = true,
  ).*
}

// A connection lost after the game sequence is dropped, with #274's host (no
// load deadline: the load deadline would end that stall too).
module start_group_lost_dropped {
  import start_group(
    GIVE_UP_LEAVES_OUT = true,
    DEADLINE_UNTIL_RUNNING = true,
    ROM_PROMPT_LEAVES_OUT = true,
    HOST_TELLS_LEFT_OUT = true,
    GUEST_REJOINS_LATE = true,
    GIVE_UP_CLOSES = true,
    GUEST_DEADLINE_ON_LOSS = true,
    LOST_IS_RETRIED = false,
    LOAD_DEADLINE = false,
  ).*
}

// Today: all nine.
module start_group_current {
  import start_group(
    GIVE_UP_LEAVES_OUT = true,
    DEADLINE_UNTIL_RUNNING = true,
    ROM_PROMPT_LEAVES_OUT = true,
    HOST_TELLS_LEFT_OUT = true,
    GUEST_REJOINS_LATE = true,
    GIVE_UP_CLOSES = true,
    GUEST_DEADLINE_ON_LOSS = true,
    LOST_IS_RETRIED = true,
    LOAD_DEADLINE = true,
  ).*
}
