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
// Within the game sequence the host waits twice: for every player's
// emu-ready, then, once it has synced and is ready itself, for every player's
// lockstep-ready (the ready barrier). The load deadline covers both, for as
// long as the start lasts: it is armed again each time it runs, and each run
// goes on with the start (checkAllEmuReady, checkAllLockstepReady) whether or
// not it left anyone out. It leaves out only a player that has made no start
// step (channel open, emu-ready, lockstep-ready) since it last ran and is
// not waiting on the host's own state: one that is still loading, or still
// taking the host's state in, is never cut. There is one sync per start: the
// host's sync timeout no longer sends it back to wait for emu-ready again. A
// page says lockstep-ready once, and takes the first state it is sent, so a
// second sync could not complete with a player that had said it: the barrier
// waited for it for ever, or, had its word been kept, it would have started
// from the first state and the host from the second. A player behind at the
// barrier is the deadline's to leave out; it joins late, from the running
// state. That includes a host whose state never reaches its players (the
// relay stalls): every player is left out, the host runs alone, and they
// join late (aStateThatNeverArrivesTest). Not modelled: the host's own
// capture of that state, a step of the host's sync here. One that fails is
// tried again, a bounded number of times, and then the host says it cannot
// start: no player has a state from it yet, so trying again is not a second
// sync.
//
// A guest's lockstep-ready can cross the host's cut: the host leaves it out
// at the barrier just as its word is on the way. That page already has the
// host's own ready, so its match runs, while the host's runs without it. A
// guest whose match runs takes the word that it is out, and joins late, as
// long as it has had no input from the host: the host sends none to a player
// it left out. Before, a page whose match ran ignored the word and ran a
// match of its own (RUNNING_TAKES_LEFT_OUT, aReadyCrossesTheCutTest).
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
// guest answers the host, unless the two guests cannot reach each other
// (`apart`): then each waits for the other's emu-ready for ever, and neither
// may leave the other out; the one whose deadline gives up tells the host,
// which decides. Not modelled: the retries' timing (a deadline is a step that
// may come at any time), whether a guest left out that way can then join
// late (the two still cannot reach each other: a relay's job, which TURN
// does where it is set up), a player who leaves the room (the roster
// removes it), spectators (no emulator), streaming (no mesh).
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
// HOST_ARBITRATES: a guest whose deadline gives up on another guest tells the
//   host (`unreachable:<slot>`), which leaves that one out at once and tells
//   it; before, the guest said it was waiting for the host and waited.
// DEADLINE_LIVE: the load deadline is armed again each time it runs, until
//   the match runs, and each run goes on with the start; before (#277's first
//   push) it ran once, and went on only when it had left someone out.
// NO_PROGRESS: the load deadline leaves out only a player that has made no
//   start step since it last ran and is not waiting on the host; before, it
//   left out every player behind at its single time.
// ONE_SYNC: the host's sync timeout does not send it back to the emu-ready
//   wait; before, it did, forgetting the barrier's words of ready.
// READY_KEPT: the load deadline reads every word of ready a player sent on
//   its channel, kept past a sync timeout (#277's first push,
//   `_saidStartReady`), rather than the barrier's own record.
// RUNNING_TAKES_LEFT_OUT: a guest whose match runs, with no input from the
//   host yet, takes the word that it is out and joins late; before, a page
//   whose match ran ignored it.
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
  const HOST_ARBITRATES: bool
  const DEADLINE_LIVE: bool
  const NO_PROGRESS: bool
  const ONE_SYNC: bool
  const READY_KEPT: bool
  const RUNNING_TAKES_LEFT_OUT: bool

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
  // The two guests each reach the host but cannot reach each other.
  var apart: bool
  // Where the host is within its game sequence: "loading" (it waits for
  // every player's emu-ready) | "barrier" (it has synced and is ready itself;
  // it waits for every player's lockstep-ready).
  var stage: str
  // The guests whose emulator has loaded. The page's own: a channel that
  // opens later carries its emu-ready (netplay-rollback.js, the channel's
  // onopen).
  var loaded: Set[str]
  // The host's ready barrier: the guests that said lockstep-ready to it in
  // this sync (`_lockstepReadyPeers`).
  var saidReady: Set[str]
  // The guests that said lockstep-ready on their current channel. A page says
  // it once: not again for a second sync.
  var readyOnChannel: Set[str]
  // The guests that made a start step since the load deadline last ran, or
  // that wait on the host's own step (its sync).
  var progressed: Set[str]
  // The host's load deadline is armed.
  var loadArmed: bool
  // The host will look at its emu-ready wait again (checkAllEmuReady): an
  // emu-ready came, the start group changed, or the deadline went on with the
  // start. A sync timeout leaves nothing due.
  var settleDue: bool
  // The load deadline has left out a player that was making progress, or
  // one that had said it was ready and was forgotten by a sync timeout.
  var cutHealthy: bool
  // The guests whose page has said lockstep-ready (once: a page never says
  // it again, its channel lost or not). The host hears it later, if it still
  // counts that player.
  var sentReady: Set[str]
  // The guests whose own match runs.
  var guestRuns: Set[str]
  // The guests whose match runs and that heard they are out, and ran on.
  var heardOut: Set[str]

  action init = all {
    host' = "lobby",
    conn' = GUESTS.mapBy(_ => "none"),
    attempt' = GUESTS.mapBy(_ => 0),
    page' = GUESTS.mapBy(_ => "absent"),
    told' = Set(),
    guestDeadline' = Set(),
    openToNobody' = Set(),
    apart' = false,
    stage' = "loading",
    loaded' = Set(),
    saidReady' = Set(),
    readyOnChannel' = Set(),
    progressed' = Set(),
    loadArmed' = false,
    settleDue' = false,
    cutHealthy' = false,
    sentReady' = Set(),
    guestRuns' = Set(),
    heardOut' = Set(),
  }

  // The guest side's state, unchanged.
  action guestsKeep = all { guestDeadline' = guestDeadline, openToNobody' = openToNobody, apart' = apart }

  // The game sequence's waits, unchanged.
  action syncKeep = all {
    stage' = stage,
    loaded' = loaded,
    saidReady' = saidReady,
    readyOnChannel' = readyOnChannel,
    progressed' = progressed,
    loadArmed' = loadArmed,
    settleDue' = settleDue,
    cutHealthy' = cutHealthy,
    pagesKeep,
  }

  // The game sequence's waits, unchanged, but not the guests' own words.
  action syncKeepButPages = all {
    stage' = stage,
    loaded' = loaded,
    saidReady' = saidReady,
    readyOnChannel' = readyOnChannel,
    progressed' = progressed,
    loadArmed' = loadArmed,
    settleDue' = settleDue,
    cutHealthy' = cutHealthy,
  }

  // The guests' own words and matches, unchanged.
  action pagesKeep = all { sentReady' = sentReady, guestRuns' = guestRuns, heardOut' = heardOut }

  // The host starts its game sequence: it loads its own emulator and arms its
  // load deadline, which gives every player a fresh window.
  action syncKeepOrArm(arms: bool): bool = all {
    stage' = stage,
    loaded' = loaded,
    saidReady' = saidReady,
    readyOnChannel' = readyOnChannel,
    progressed' = if (arms) GUESTS else progressed,
    loadArmed' = if (arms) LOAD_DEADLINE else loadArmed,
    settleDue' = true,
    cutHealthy' = cutHealthy,
    pagesKeep,
  }

  // The start group: the players the host waits for.
  val startGroup = GUESTS.filter(g => conn.get(g).in(Set("connecting", "open", "stalled")))

  // The host presses Start with these two players in the room as they are,
  // and whether they can reach each other.
  action startApartOrNot(p1: str, p2: str, apartNow: bool): bool = {
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
      apart' = apartNow,
      guestDeadline' = GUESTS.filter(g => pages.get(g) == "starting"),
      openToNobody' = openToNobody,
      syncKeep,
    }
  }

  action startWith(p1: str, p2: str): bool = startApartOrNot(p1, p2, false)

  action start = {
    nondet p1 = STARTS.oneOf()
    nondet p2 = STARTS.oneOf()
    nondet apartNow = Set(false, true).oneOf()
    startApartOrNot(p1, p2, apartNow)
  }

  pure def other(g: str): str = if (g == "g1") "g2" else "g1"

  // A player that is starting answers: the channel opens, a start step (and
  // it carries the page's emu-ready, if it has loaded). The host's first open
  // channel starts its game sequence.
  action answer(g: str): bool = all {
    conn.get(g) == "connecting",
    page.get(g).in(Set("starting", "stuck")),
    conn' = conn.set(g, "open"),
    host' = if (host == "waiting") "sequence" else host,
    attempt' = attempt,
    page' = page,
    told' = told,
    // Its channel to the host is open: the guest's deadline ends.
    apart' = apart,
    guestDeadline' = guestDeadline.exclude(Set(g)),
    openToNobody' = openToNobody,
    stage' = stage,
    loaded' = loaded,
    saidReady' = saidReady,
    readyOnChannel' = readyOnChannel,
    progressed' = if (host == "waiting") GUESTS else progressed.union(Set(g)),
    loadArmed' = if (host == "waiting") LOAD_DEADLINE else loadArmed,
    settleDue' = true,
    cutHealthy' = cutHealthy,
    pagesKeep,
  }

  // The deadline is armed while the host waits for the game sequence, and
  // then until the match runs once it no longer stops there.
  val deadlineArmed = host == "waiting" or (DEADLINE_UNTIL_RUNNING and host == "sequence")

  // The leave-out: the player's connection closes and it is held as a late
  // joiner. With nobody left to wait for, the host starts alone.
  action leaveOut(g: str): bool = {
    val startsAlone = host == "waiting" and startGroup.exclude(Set(g)).size() == 0
    all {
      conn' = conn.set(g, "leftOut"),
      attempt' = attempt,
      page' = page,
      told' = if (HOST_TELLS_LEFT_OUT) told.union(Set(g)) else told,
      host' = if (startsAlone) "sequence" else host,
      guestsKeep,
      // The start group changed: the host goes on with the start.
      syncKeepOrArm(startsAlone),
    }
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
        apart' = apart,
        guestDeadline' = if (page.get(g) == "starting") guestDeadline.union(Set(g)) else guestDeadline,
        openToNobody' = openToNobody,
        syncKeep,
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
        syncKeep,
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
    apart' = apart,
    guestDeadline' = guestDeadline.exclude(Set(g)),
    host' = host,
    conn' = conn,
    attempt' = attempt,
    page' = page,
    told' = told,
    syncKeep,
  }

  // The guest's side of a connection that has not opened fails (the host
  // closed it at the give-up, or a network that never let it through): the
  // guest drops its connection to the host. Its deadline is armed again, or,
  // before, went with the connection.
  action guestLosesHost(g: str): bool = all {
    page.get(g) == "starting",
    conn.get(g).in(Set("connecting", "stalled", "leftOut", "dropped")),
    not(openToNobody.contains(g)),
    apart' = apart,
    guestDeadline' =
      if (GUEST_DEADLINE_ON_LOSS) guestDeadline.union(Set(g)) else guestDeadline.exclude(Set(g)),
    openToNobody' = openToNobody,
    host' = host,
    conn' = conn,
    attempt' = attempt,
    page' = page,
    told' = told,
    syncKeep,
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
    apart' = apart,
    guestDeadline' = if (GUEST_DEADLINE_ON_LOSS) guestDeadline.union(Set(g)) else guestDeadline,
    openToNobody' = openToNobody,
    host' = host,
    page' = page,
    told' = told,
    // The host forgets its words on that channel. A page whose channel comes
    // back sends its emu-ready again, not its lockstep-ready.
    stage' = stage,
    loaded' = loaded,
    saidReady' = saidReady.exclude(Set(g)),
    readyOnChannel' = readyOnChannel.exclude(Set(g)),
    progressed' = progressed,
    loadArmed' = loadArmed,
    settleDue' = settleDue,
    cutHealthy' = cutHealthy,
    pagesKeep,
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

  // A guest that cannot reach the other guest waits for it while the other
  // is in the start: its emu-ready never comes.
  def waitsForTheOther(g: str): bool = apart and other(g).in(startGroup)

  // A guest's emulator loads once its channel is open: a page at the ROM
  // prompt runs none, and a "stuck" one never gets there.
  def canLoad(g: str): bool = and {
    host.in(Set("waiting", "sequence")),
    page.get(g) == "starting",
    conn.get(g) == "open",
    not(loaded.contains(g)),
  }

  // A guest says it is ready once it has the host's state (which comes with
  // the host's own ready): its channel is open, its emulator has loaded, it
  // waits for no player the host left out without telling it nor for one it
  // cannot reach, and it has not said so before.
  def canSendReady(g: str): bool = and {
    host == "sequence",
    stage == "barrier",
    page.get(g) == "starting",
    conn.get(g) == "open",
    loaded.contains(g),
    not(sentReady.contains(g)),
    waitedForBehindTheHost.exclude(Set(g)).size() == 0,
    not(waitsForTheOther(g)),
  }

  // The host hears a guest's ready, if it still counts that player and has
  // not heard it on this channel already.
  def canHearReady(g: str): bool = and {
    sentReady.contains(g),
    conn.get(g) == "open",
    not(readyOnChannel.contains(g)),
  }

  // Whom a guest waits for itself: every other guest in the room the host has
  // not told it is out.
  def guestWaitsFor(g: str): Set[str] =
    GUESTS.exclude(Set(g)).filter(h => page.get(h) != "absent" and not(told.contains(h)))

  // A guest's own match runs once it has said it is ready and has every
  // ready it waits for: the host's (it came with the state) and each other
  // guest's that it can reach.
  def canGuestRun(g: str): bool = and {
    page.get(g) == "starting",
    sentReady.contains(g),
    not(guestRuns.contains(g)),
    not(heardOut.contains(g)),
    guestWaitsFor(g).forall(h => sentReady.contains(h) and not(apart)),
  }

  // Every player in the start group has loaded, as the host has heard.
  val everyoneLoaded = startGroup.forall(g => conn.get(g) == "open" and loaded.contains(g))
  // The host syncs when it next looks and every player has loaded.
  val canSync = host == "sequence" and stage == "loading" and settleDue and everyoneLoaded
  // Every player in the start group has said it is ready: the match runs.
  val everyoneIsIn = startGroup.forall(g => conn.get(g) == "open" and saidReady.contains(g))
  val canRun = host == "sequence" and stage == "barrier" and everyoneIsIn

  action load(g: str): bool = all {
    canLoad(g),
    loaded' = loaded.union(Set(g)),
    progressed' = progressed.union(Set(g)),
    settleDue' = true,
    stage' = stage,
    saidReady' = saidReady,
    readyOnChannel' = readyOnChannel,
    loadArmed' = loadArmed,
    cutHealthy' = cutHealthy,
    pagesKeep,
    host' = host,
    conn' = conn,
    attempt' = attempt,
    page' = page,
    told' = told,
    guestsKeep,
  }

  // The host syncs: it has the starting state and is ready itself. Every
  // player now waits on the host's state, which restarts its window.
  action sync = all {
    canSync,
    stage' = "barrier",
    saidReady' = saidReady,
    progressed' = progressed.union(startGroup),
    settleDue' = false,
    loaded' = loaded,
    readyOnChannel' = readyOnChannel,
    loadArmed' = loadArmed,
    cutHealthy' = cutHealthy,
    pagesKeep,
    host' = host,
    conn' = conn,
    attempt' = attempt,
    page' = page,
    told' = told,
    guestsKeep,
  }

  action sendReady(g: str): bool = all {
    canSendReady(g),
    sentReady' = sentReady.union(Set(g)),
    guestRuns' = guestRuns,
    heardOut' = heardOut,
    syncKeepButPages,
    host' = host,
    conn' = conn,
    attempt' = attempt,
    page' = page,
    told' = told,
    guestsKeep,
  }

  action hearReady(g: str): bool = all {
    canHearReady(g),
    saidReady' = saidReady.union(Set(g)),
    readyOnChannel' = readyOnChannel.union(Set(g)),
    progressed' = progressed.union(Set(g)),
    stage' = stage,
    loaded' = loaded,
    loadArmed' = loadArmed,
    settleDue' = settleDue,
    cutHealthy' = cutHealthy,
    pagesKeep,
    host' = host,
    conn' = conn,
    attempt' = attempt,
    page' = page,
    told' = told,
    guestsKeep,
  }

  action guestRunsItsMatch(g: str): bool = all {
    canGuestRun(g),
    guestRuns' = guestRuns.union(Set(g)),
    sentReady' = sentReady,
    heardOut' = heardOut,
    syncKeepButPages,
    host' = host,
    conn' = conn,
    attempt' = attempt,
    page' = page,
    told' = told,
    guestsKeep,
  }

  // A guest whose match runs hears from the host that it is out (it was cut
  // at the barrier as its ready was on the way). It has had no input from the
  // host, which sends none to a player it left out: it joins late, or,
  // before, ran on with a match of its own.
  action hearLeftOut(g: str): bool = all {
    page.get(g) == "starting",
    guestRuns.contains(g),
    conn.get(g) == "leftOut",
    told.contains(g),
    not(heardOut.contains(g)),
    if (RUNNING_TAKES_LEFT_OUT)
      all {
        page' = page.set(g, "lateJoining"),
        guestRuns' = guestRuns.exclude(Set(g)),
        heardOut' = heardOut,
        guestDeadline' = guestDeadline.exclude(Set(g)),
      }
    else
      all { page' = page, guestRuns' = guestRuns, heardOut' = heardOut.union(Set(g)), guestDeadline' = guestDeadline },
    sentReady' = sentReady,
    syncKeepButPages,
    host' = host,
    conn' = conn,
    attempt' = attempt,
    told' = told,
    apart' = apart,
    openToNobody' = openToNobody,
  }

  // The host's sync times out with a player not ready. Before, it went back
  // to the emu-ready wait and forgot the barrier's words, and nothing looked
  // at that wait again until another emu-ready came. With one sync per start
  // it does not happen: the load deadline decides.
  action syncTimesOut = all {
    not(ONE_SYNC),
    host == "sequence",
    stage == "barrier",
    not(everyoneIsIn),
    stage' = "loading",
    saidReady' = Set(),
    settleDue' = false,
    loaded' = loaded,
    readyOnChannel' = readyOnChannel,
    progressed' = progressed,
    loadArmed' = loadArmed,
    cutHealthy' = cutHealthy,
    pagesKeep,
    host' = host,
    conn' = conn,
    attempt' = attempt,
    page' = page,
    told' = told,
    guestsKeep,
  }

  // The host's match runs once every player in its start group is in.
  action matchRuns = all {
    canRun,
    host' = "running",
    conn' = conn,
    attempt' = attempt,
    page' = page,
    told' = told,
    guestsKeep,
    stage' = stage,
    loaded' = loaded,
    saidReady' = saidReady,
    readyOnChannel' = readyOnChannel,
    progressed' = progressed,
    loadArmed' = false,
    settleDue' = settleDue,
    cutHealthy' = cutHealthy,
    pagesKeep,
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
    syncKeep,
  }

  // Whether the load deadline takes a player for ready: the barrier's record,
  // or, READY_KEPT, every word of ready it sent on its channel.
  def deadlineSeesReady(g: str): bool = if (READY_KEPT) readyOnChannel.contains(g) else saidReady.contains(g)

  // The players behind: in the start group with an open channel, and not
  // loaded, or not ready at the host's barrier.
  val behind =
    startGroup.filter(g =>
      conn.get(g) == "open" and (not(loaded.contains(g)) or (stage == "barrier" and not(deadlineSeesReady(g))))
    )

  // The players the load deadline leaves out when it runs: every player
  // behind, or, NO_PROGRESS, those of them that made no start step since it
  // last ran and do not wait on the host.
  val dueNow = if (NO_PROGRESS) behind.exclude(progressed) else behind

  // The host's load deadline runs. Each player it leaves out is told so,
  // itself included: a page that hears it joins late (its way into the late
  // join is armed, as by its own deadline). A page from before `left-out:`
  // does not hear it. Then it goes on with the start, and is armed again,
  // DEADLINE_LIVE; before, it went on only when it had left someone out, and
  // was not armed again.
  action loadFires = all {
    LOAD_DEADLINE,
    loadArmed,
    host == "sequence",
    conn' = GUESTS.mapBy(g => if (dueNow.contains(g)) "leftOut" else conn.get(g)),
    told' = if (HOST_TELLS_LEFT_OUT) told.union(dueNow) else told,
    guestDeadline' = if (HOST_TELLS_LEFT_OUT) guestDeadline.union(dueNow) else guestDeadline,
    cutHealthy' = (
      cutHealthy or dueNow.exists(g => progressed.contains(g) or (readyOnChannel.contains(g) and not(saidReady.contains(g))))
    ),
    progressed' = Set(),
    loadArmed' = DEADLINE_LIVE,
    settleDue' = (settleDue or DEADLINE_LIVE or dueNow.size() > 0),
    pagesKeep,
    stage' = stage,
    loaded' = loaded,
    saidReady' = saidReady,
    readyOnChannel' = readyOnChannel,
    apart' = apart,
    openToNobody' = openToNobody,
    host' = host,
    attempt' = attempt,
    page' = page,
  }

  // Two guests that each reach the host cannot reach each other: one's
  // deadline on the other gives up, and it tells the host, which leaves the
  // other out at once and tells it (itself included). The guest that
  // reported plays.
  action reportApart(g: str): bool = all {
    HOST_ARBITRATES,
    apart,
    host.in(Set("waiting", "sequence")),
    conn.get(g) == "open",
    conn.get(other(g)) == "open",
    conn' = conn.set(other(g), "leftOut"),
    told' = if (HOST_TELLS_LEFT_OUT) told.union(Set(other(g))) else told,
    apart' = apart,
    guestDeadline' = if (HOST_TELLS_LEFT_OUT) guestDeadline.union(Set(other(g))) else guestDeadline,
    openToNobody' = openToNobody,
    host' = host,
    attempt' = attempt,
    page' = page,
    syncKeepOrArm(false),
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
    not(guestRuns.contains(g)),
    page' = page.set(g, "lateJoining"),
    apart' = apart,
    guestDeadline' = guestDeadline.exclude(Set(g)),
    openToNobody' = openToNobody,
    host' = host,
    conn' = conn,
    attempt' = attempt,
    told' = told,
    syncKeep,
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
    syncKeep,
  }

  action nothing = all { host' = host, conn' = conn, attempt' = attempt, page' = page, told' = told, guestsKeep, syncKeep }

  action step = any {
    start,
    nondet g = GUESTS.oneOf()
    any {
      answer(g),
      deadline(g),
      load(g),
      sendReady(g),
      hearReady(g),
      guestRunsItsMatch(g),
      hearLeftOut(g),
      reportApart(g),
      lateOpen(g),
      guestLosesHost(g),
      lose(g),
      romPromptHeard(g),
      dropRom(g),
      rejoinLate(g),
      lateJoin(g),
    },
    sync,
    syncTimesOut,
    loadFires,
    matchRuns,
  }

  // ── properties ──────────────────────────────────────────────────────────

  // What could still move the host on.
  val anAnswerComes = GUESTS.exists(g => conn.get(g) == "connecting" and page.get(g) == "starting")
  val aDeadlineRuns = deadlineArmed and GUESTS.exists(g => conn.get(g) == "connecting")
  val aRomPromptIsHeard = ROM_PROMPT_LEAVES_OUT and startGroup.exists(g => page.get(g) == "awaitingRom")
  val aPairIsSplit = HOST_ARBITRATES and apart and GUESTS.forall(g => conn.get(g) == "open")
  // A guest's own next step: it loads, or says it is ready.
  val aGuestStepComes = startGroup.exists(g => canLoad(g) or canSendReady(g) or canHearReady(g))
  // The load deadline is armed and its run moves the start on: it leaves
  // someone out now, or, armed again, later, or it goes on with a wait that
  // nothing else will look at again.
  val aLoadDeadlineRuns = and {
    LOAD_DEADLINE,
    loadArmed,
    host == "sequence",
    or {
      dueNow.size() > 0,
      DEADLINE_LIVE and behind.size() > 0,
      DEADLINE_LIVE and stage == "loading" and everyoneLoaded,
    },
  }
  val theHostCanGoOn = or {
    host == "waiting" and GUESTS.exists(g => conn.get(g) == "open"),
    canSync,
    canRun,
  }

  // A host that has started a game but whose match does not run always has a
  // way on: a player still answering, loading or saying it is ready, a
  // deadline still armed that leads somewhere, a ROM prompt it will hear, or
  // its own next step. VIOLATED while the give-up waited on
  // (start_group_before, aFrozenGuestTest: in a room of two the host never
  // starts), while the deadline stopped at the game sequence
  // (start_group_give_up_only, aThirdPlayerFrozenTest), and while the load
  // deadline ran once beside a sync timeout that sent the host back
  // (start_group_deadline_once, aSyncTimesOutTest).
  val neverStuck =
    host.in(Set("waiting", "sequence")) implies or {
      theHostCanGoOn,
      anAnswerComes,
      aDeadlineRuns,
      aRomPromptIsHeard,
      aLoadDeadlineRuns,
      aPairIsSplit,
      aGuestStepComes,
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

  // The load deadline leaves out no player that is making progress: one that
  // took a start step since the deadline last ran, waits on the host's own
  // state, or said it was ready and was forgotten by a sync timeout.
  // VIOLATED while the deadline was one time from the host's emu-ready
  // (start_group_absolute_deadline, aSlowStateTest: a player still taking the
  // host's state in at that time was cut) and while the host synced again
  // after a timeout (start_group_resync, aReadyThenATimeoutTest: a player that
  // had said it was ready never said it again, and was cut).
  val aPlayerMakingProgressStays = not(cutHealthy)

  // A guest the host left out does not run a match of its own once it has
  // heard so. VIOLATED while a page whose match ran ignored the word
  // (start_group_running_ignores_left_out, aReadyCrossesTheCutTest: its ready
  // crossed the host's cut at the barrier).
  val aLeftOutGuestDoesNotRunAlone = GUESTS.forall(g => not(guestRuns.contains(g) and heardOut.contains(g)))

  val allHold =
    neverStuck and aLateJoinerIsHeldAsOne and aRunningMatchHasNoSilentPlayer and nobodyIsInNeither
      and aPlayerMakingProgressStays and aLeftOutGuestDoesNotRunAlone

  // ── scenarios ───────────────────────────────────────────────────────────

  // Steps a scenario takes only where the variant allows them.
  action deadlineAny(g: str): bool = if (deadlineArmed and conn.get(g) == "connecting") deadline(g) else nothing
  action loadAny(g: str): bool = if (canLoad(g)) load(g) else nothing
  action syncAny = if (canSync) sync else nothing
  action sendReadyAny(g: str): bool = if (canSendReady(g)) sendReady(g) else nothing
  action hearReadyAny(g: str): bool = if (canHearReady(g)) hearReady(g) else nothing
  action guestRunsAny(g: str): bool = if (canGuestRun(g)) guestRunsItsMatch(g) else nothing
  action hearLeftOutAny(g: str): bool =
    if (
      page.get(g) == "starting" and guestRuns.contains(g) and conn.get(g) == "leftOut" and told.contains(g)
        and not(heardOut.contains(g))
    )
      hearLeftOut(g)
    else nothing
  // A guest says it is ready, and the host hears it.
  run sayReadyAny(g: str): bool = sendReadyAny(g).then(hearReadyAny(g))
  action matchRunsStep = if (canRun) matchRuns else nothing
  action syncTimesOutAny =
    if (not(ONE_SYNC) and host == "sequence" and stage == "barrier" and not(everyoneIsIn)) syncTimesOut else nothing
  action loadFiresAny = if (LOAD_DEADLINE and loadArmed and host == "sequence") loadFires else nothing
  // The host goes on as far as its players let it: each loads, it syncs,
  // each says it is ready, and the match runs.
  run matchRunsAny =
    loadAny("g1").then(loadAny("g2")).then(syncAny).then(sayReadyAny("g1")).then(sayReadyAny("g2")).then(matchRunsStep)
  // The load deadline over two windows: a player that made no step in the
  // first is left out at the second.
  run loadDeadlineAny = loadFiresAny.then(loadFiresAny)
  action romPromptAny(g: str): bool =
    if (ROM_PROMPT_LEAVES_OUT and page.get(g) == "awaitingRom" and g.in(startGroup) and host.in(Set("waiting", "sequence")))
      romPromptHeard(g)
    else nothing
  action lateJoinAny(g: str): bool =
    if (page.get(g) == "lateJoining" and host == "running" and conn.get(g) == "leftOut") lateJoin(g) else nothing
  action rejoinLateAny(g: str): bool =
    if (
      GUEST_REJOINS_LATE and page.get(g) == "starting" and conn.get(g).in(Set("leftOut", "dropped"))
        and guestDeadline.contains(g) and not(guestRuns.contains(g))
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
      .then(loadAny("g1"))
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


  // A room of three; both guests answer and load, then one connection to the
  // host is lost before the match runs. Before, the host dropped it without a
  // word: the host stopped counting that player but the other guest still
  // waited for it, and the host for the other guest.
  run aLostAfterTheSequenceTest =
    init
      .then(startWith("starting", "starting"))
      .then(answer("g1"))
      .then(answer("g2"))
      .then(loadAny("g1"))
      .then(loadAny("g2"))
      .then(lose("g2"))
      .then(syncAny)
      .expect(neverStuck == (LOST_IS_RETRIED or LOAD_DEADLINE))
      .then(deadlineAny("g2"))
      .then(deadlineAny("g2"))
      .then(deadlineAny("g2"))
      .then(matchRunsAny)
      // The other guest still waits for a player it was not told of: the load
      // deadline leaves it out too.
      .then(loadDeadlineAny)
      .then(matchRunsAny)
      .expect(
        host == (
          if (LOAD_DEADLINE or (LOST_IS_RETRIED and HOST_TELLS_LEFT_OUT and DEADLINE_UNTIL_RUNNING)) "running"
          else "sequence"
        )
      )

  // A room of two; the guest answers but its emulator never loads. Before,
  // the host waited at emu-ready for ever. Now its load deadline leaves the
  // guest out, and the match runs.
  run aStuckGuestTest =
    init
      .then(startWith("stuck", "absent"))
      .then(answer("g1"))
      .expect(host == "sequence")
      .expect(neverStuck == LOAD_DEADLINE)
      .then(loadDeadlineAny)
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
      .then(loadDeadlineAny)
      .then(matchRunsAny)
      .expect(
        host == (
          if (GIVE_UP_LEAVES_OUT and DEADLINE_UNTIL_RUNNING and (HOST_TELLS_LEFT_OUT or LOAD_DEADLINE)) "running"
          else "sequence"
        )
      )

  action reportApartAny(g: str): bool =
    if (HOST_ARBITRATES and apart and host.in(Set("waiting", "sequence")) and GUESTS.forall(h => conn.get(h) == "open"))
      reportApart(g)
    else nothing

  // A room of three; both guests reach the host but not each other. Each
  // waits for the other. Before, the start waited for ever; with only the
  // load deadline, the host leaves both out after it; now the guest whose
  // deadline gave up tells the host, which leaves the other out, and the
  // match runs with the one that reported.
  run aPairApartTest =
    init
      .then(startApartOrNot("starting", "starting", true))
      .then(answer("g1"))
      .then(answer("g2"))
      .then(loadAny("g1"))
      .then(loadAny("g2"))
      .then(syncAny)
      .expect(neverStuck == (HOST_ARBITRATES or LOAD_DEADLINE))
      .then(reportApartAny("g1"))
      .then(matchRunsAny)
      .then(loadDeadlineAny)
      .then(matchRunsAny)
      .expect(host == (if (HOST_ARBITRATES or LOAD_DEADLINE) "running" else "sequence"))
      .expect(HOST_ARBITRATES implies startGroup == Set("g1"))

  // A room of two; the guest loads, the host syncs, and its sync times out
  // before the guest says it is ready (a slow state, a heavy tab). Before,
  // the host went back to wait for emu-ready, which nothing looked at again,
  // and the load deadline, run once, found nobody behind and did not go on
  // with the start: the host waited for ever. Now the host keeps its one
  // sync and the guest's word comes; a host that went back would still be
  // moved on by its deadline, armed again.
  run aSyncTimesOutTest =
    init
      .then(startWith("starting", "absent"))
      .then(answer("g1"))
      .then(loadAny("g1"))
      .then(syncAny)
      .then(syncTimesOutAny)
      .then(loadFiresAny)
      .expect(neverStuck == (ONE_SYNC or (LOAD_DEADLINE and DEADLINE_LIVE)))
      .then(matchRunsAny)
      .expect(host == (if (ONE_SYNC or (LOAD_DEADLINE and DEADLINE_LIVE)) "running" else "sequence"))

  // A room of two; the guest is still taking the host's state in when the
  // load deadline runs. Before, the deadline was one time from the host's
  // emu-ready and left the guest out though it was making progress; now it
  // leaves out only a player that made no start step in a whole window.
  run aSlowStateTest =
    init
      .then(startWith("starting", "absent"))
      .then(answer("g1"))
      .then(loadAny("g1"))
      .then(syncAny)
      .then(loadFiresAny)
      .expect(aPlayerMakingProgressStays == not(LOAD_DEADLINE and not(NO_PROGRESS)))
      .then(matchRunsAny)
      .expect(host == "running")
      .expect(conn.get("g1") == (if (LOAD_DEADLINE and not(NO_PROGRESS)) "leftOut" else "open"))

  // A room of three; both guests load, the host syncs, one guest says it is
  // ready while the other is slow, and the host's sync times out. Before, the
  // host went back and synced again: the guest that had said it was ready
  // took no second state and never said so again. The barrier waited for it,
  // with the deadline reading its old word (#277's first push), or, with the
  // barrier's own record, the deadline left it out though it had done
  // nothing wrong. Now there is one sync: the slow guest says it is ready and
  // the match runs with both.
  run aReadyThenATimeoutTest =
    init
      .then(startWith("starting", "starting"))
      .then(answer("g1"))
      .then(answer("g2"))
      .then(loadAny("g1"))
      .then(loadAny("g2"))
      .then(syncAny)
      .then(sayReadyAny("g1"))
      .then(syncTimesOutAny)
      .then(loadFiresAny)
      .then(syncAny)
      .then(sayReadyAny("g2"))
      .then(loadDeadlineAny)
      .then(matchRunsStep)
      .expect(
        aPlayerMakingProgressStays == not(
          LOAD_DEADLINE and ((ONE_SYNC and not(NO_PROGRESS)) or (not(ONE_SYNC) and DEADLINE_LIVE and not(READY_KEPT)))
        )
      )
      .expect(neverStuck == (ONE_SYNC or (LOAD_DEADLINE and DEADLINE_LIVE and not(READY_KEPT))))
      .expect((ONE_SYNC and NO_PROGRESS) implies (host == "running" and startGroup == GUESTS))

  // A room of three; both guests load and the host syncs, but its state
  // never reaches them (the relay stalls). Neither ever says it is ready. The
  // load deadline leaves both out after a whole window with no step, the
  // host runs alone, and they join late: progress, not a hang.
  run aStateThatNeverArrivesTest =
    init
      .then(startWith("starting", "starting"))
      .then(answer("g1"))
      .then(answer("g2"))
      .then(loadAny("g1"))
      .then(loadAny("g2"))
      .then(syncAny)
      .then(loadDeadlineAny)
      .then(matchRunsStep)
      .expect(host == (if (LOAD_DEADLINE) "running" else "sequence"))
      .then(rejoinLateAny("g1"))
      .then(rejoinLateAny("g2"))
      .then(lateJoinAny("g1"))
      .then(lateJoinAny("g2"))
      .expect(
        GUESTS.forall(g => page.get(g) == (if (LOAD_DEADLINE and HOST_TELLS_LEFT_OUT and GUEST_REJOINS_LATE) "joined" else "starting"))
      )
      // One time for every player (no NO_PROGRESS) cut them while they still
      // waited on the host's state.
      .expect(aPlayerMakingProgressStays == not(LOAD_DEADLINE and not(NO_PROGRESS)))

  // A room of two; the guest is slow to take the host's state in, and says it
  // is ready just as the host's load deadline leaves it out: its word reaches
  // a host that no longer counts it. The guest has the host's own ready, so
  // its match runs. It hears it is out with no input from the host: it joins
  // late. Before, its match ran on, a match of its own.
  run aReadyCrossesTheCutTest =
    init
      .then(startWith("starting", "absent"))
      .then(answer("g1"))
      .then(loadAny("g1"))
      .then(syncAny)
      .then(sendReadyAny("g1"))
      .then(guestRunsAny("g1"))
      .expect(guestRuns.contains("g1"))
      .then(loadDeadlineAny)
      .then(hearReadyAny("g1"))
      .then(hearLeftOutAny("g1"))
      .expect(
        aLeftOutGuestDoesNotRunAlone == not(LOAD_DEADLINE and HOST_TELLS_LEFT_OUT and not(RUNNING_TAKES_LEFT_OUT))
      )
      .then(matchRunsStep)
      .then(lateJoinAny("g1"))
      .expect(
        (LOAD_DEADLINE and HOST_TELLS_LEFT_OUT and RUNNING_TAKES_LEFT_OUT) implies page.get("g1") == "joined"
      )

  // Two players who answer: nobody is left out and the match runs.
  run everyoneAnswersTest =
    init
      .then(startWith("starting", "starting"))
      .then(answer("g2"))
      .then(answer("g1"))
      .then(matchRunsAny)
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
    HOST_ARBITRATES = false,
    DEADLINE_LIVE = false,
    NO_PROGRESS = false,
    ONE_SYNC = false,
    READY_KEPT = false,
    RUNNING_TAKES_LEFT_OUT = false,
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
    HOST_ARBITRATES = false,
    DEADLINE_LIVE = false,
    NO_PROGRESS = false,
    ONE_SYNC = false,
    READY_KEPT = false,
    RUNNING_TAKES_LEFT_OUT = false,
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
    HOST_ARBITRATES = false,
    DEADLINE_LIVE = true,
    NO_PROGRESS = true,
    ONE_SYNC = true,
    READY_KEPT = false,
    RUNNING_TAKES_LEFT_OUT = false,
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
    HOST_ARBITRATES = true,
    DEADLINE_LIVE = true,
    NO_PROGRESS = true,
    ONE_SYNC = true,
    READY_KEPT = false,
    RUNNING_TAKES_LEFT_OUT = true,
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
    HOST_ARBITRATES = false,
    DEADLINE_LIVE = false,
    NO_PROGRESS = false,
    ONE_SYNC = false,
    READY_KEPT = false,
    RUNNING_TAKES_LEFT_OUT = false,
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
    HOST_ARBITRATES = true,
    DEADLINE_LIVE = true,
    NO_PROGRESS = true,
    ONE_SYNC = true,
    READY_KEPT = false,
    RUNNING_TAKES_LEFT_OUT = true,
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
    HOST_ARBITRATES = true,
    DEADLINE_LIVE = true,
    NO_PROGRESS = true,
    ONE_SYNC = true,
    READY_KEPT = false,
    RUNNING_TAKES_LEFT_OUT = true,
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
    HOST_ARBITRATES = true,
    DEADLINE_LIVE = true,
    NO_PROGRESS = true,
    ONE_SYNC = true,
    READY_KEPT = false,
    RUNNING_TAKES_LEFT_OUT = true,
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
    HOST_ARBITRATES = true,
    DEADLINE_LIVE = false,
    NO_PROGRESS = false,
    ONE_SYNC = false,
    READY_KEPT = false,
    RUNNING_TAKES_LEFT_OUT = false,
  ).*
}

// Two guests that cannot reach each other, with #274's host and guests: no
// load deadline, and a guest whose deadline gives up on the other only waits.
module start_group_apart_unarbitrated {
  import start_group(
    GIVE_UP_LEAVES_OUT = true,
    DEADLINE_UNTIL_RUNNING = true,
    ROM_PROMPT_LEAVES_OUT = true,
    HOST_TELLS_LEFT_OUT = true,
    GUEST_REJOINS_LATE = true,
    GIVE_UP_CLOSES = true,
    GUEST_DEADLINE_ON_LOSS = true,
    LOST_IS_RETRIED = true,
    LOAD_DEADLINE = false,
    HOST_ARBITRATES = false,
    DEADLINE_LIVE = false,
    NO_PROGRESS = false,
    ONE_SYNC = false,
    READY_KEPT = false,
    RUNNING_TAKES_LEFT_OUT = false,
  ).*
}

// #277's first push: the load deadline ran once, from the host's emu-ready,
// went on with the start only when it left someone out, and read every word
// of ready kept past a sync timeout; the sync timeout sent the host back to
// wait for emu-ready.
module start_group_deadline_once {
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
    HOST_ARBITRATES = true,
    DEADLINE_LIVE = false,
    NO_PROGRESS = false,
    ONE_SYNC = false,
    READY_KEPT = true,
    RUNNING_TAKES_LEFT_OUT = false,
  ).*
}

// The load deadline armed again and going on with the start, but one time
// for every player: a player still taking the host's state in is cut.
module start_group_absolute_deadline {
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
    HOST_ARBITRATES = true,
    DEADLINE_LIVE = true,
    NO_PROGRESS = false,
    ONE_SYNC = true,
    READY_KEPT = false,
    RUNNING_TAKES_LEFT_OUT = true,
  ).*
}

// The load deadline as today, with the sync timeout sending the host back to
// sync again: a player that said it was ready never says so again, and is cut.
module start_group_resync {
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
    HOST_ARBITRATES = true,
    DEADLINE_LIVE = true,
    NO_PROGRESS = true,
    ONE_SYNC = false,
    READY_KEPT = false,
    RUNNING_TAKES_LEFT_OUT = true,
  ).*
}

// #277 before the crossing was fixed (c9d2d53): a guest whose match ran
// ignored the word that it was out.
module start_group_running_ignores_left_out {
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
    HOST_ARBITRATES = true,
    DEADLINE_LIVE = true,
    NO_PROGRESS = true,
    ONE_SYNC = true,
    READY_KEPT = false,
    RUNNING_TAKES_LEFT_OUT = false,
  ).*
}

// Today: all fifteen.
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
    HOST_ARBITRATES = true,
    DEADLINE_LIVE = true,
    NO_PROGRESS = true,
    ONE_SYNC = true,
    READY_KEPT = false,
    RUNNING_TAKES_LEFT_OUT = true,
  ).*
}
