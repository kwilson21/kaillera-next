// -*- mode: Bluespec; -*-
//
// The pause around a late join: the engine's side of a player joining a
// match that is running (handleLateJoinRequest, sendLateJoinState,
// finishLateJoinReady and the `late-join-pause` / `late-join-resume`
// handlers in web/static/netplay-rollback.js).
//
// specs/room_lifecycle.qnt has the page's side: which match a joiner chases
// and when it asks. It serves a joiner in one step. This spec opens that
// step up:
//   - the host pauses the game, tells the other players to pause, captures
//     its state, compresses it (the host is waiting on a worker here) and
//     sends it to the joiner;
//   - the joiner loads it and says it is ready, to the host and, through the
//     server, to everyone;
//   - the host makes the joiner an active player, resumes and tells the
//     others to resume;
//   - if no "ready" comes within 15 s the host resumes and disconnects the
//     joiner so it can try again.
//
// What is modelled: the host, one other player ("guest"), two joiners, the
// host's messages to the guest in order (one data channel), the messages
// that go through the server in any order, the 15 s timer of each serve, a
// joiner leaving, the host reloading.
//
// Not modelled: the joiner's own wait (room_lifecycle.qnt and
// web/src/late-join-wait.ts), a "ready" that arrives before the joiner's
// data channel is open, inputs and frames, spectators, the joiner that has
// become a player while the host is still paused for another (the host tells
// it to pause with everyone else).
//
// PAUSE_PER_JOINER: on the host, the pause belongs to the joiners being
//   served. The game resumes when none is left, and a timer acts only on its
//   own joiner and only while that joiner is still held. false = before: one
//   pause, ended by any "ready" or any timer.
// ARM_AT_PAUSE: the 15 s timer is armed when the pause begins. false =
//   before: after the state has been compressed.
// KEEP_FIRST_DEADLINE: a repeated request for a joiner already being served
//   is the same serve and keeps its timer. false = as first written: each
//   repeat was a new serve, and the timer of the one before did nothing.
// GUEST_RESUMES_ON_HOST_ONLY: a paused guest resumes on the host's word
//   alone. false = before: also on any joiner's "ready".
// GUEST_PAUSE_HAS_DEADLINE: a paused guest has a deadline of its own.
//   false = before: it waited for the host's resume.
module late_join_pause {
  const PAUSE_PER_JOINER: bool
  const ARM_AT_PAUSE: bool
  const KEEP_FIRST_DEADLINE: bool
  const GUEST_RESUMES_ON_HOST_ONLY: bool
  const GUEST_PAUSE_HAS_DEADLINE: bool

  pure val JOINERS = Set("a", "b")

  type Joiner = Away | Asking | Ready | Playing | Gone
  type ToGuest = Pause | Resume
  type Relayed = State(str) | ReadyToHost(str) | ReadyToGuest(str)

  var joiner: str -> Joiner
  var hostUp: bool
  var hostPaused: bool
  var held: Set[str]         // joiners the host holds as not yet active
  var compressing: Set[str]  // state captured, not yet sent
  var timers: Set[str]       // 15 s timers armed, by the joiner each was armed for
  var guestPaused: bool
  var guestDeadline: bool
  var toGuest: List[ToGuest] // the host's data channel to the guest, in order
  var relay: Set[Relayed]    // through the server, any order
  var kickedAPlayer: bool    // history: the host disconnected a joiner who was playing
  var pushedBack: bool       // history: a repeated request replaced a serve's deadline
  var guestResumedBy: str    // history: what last ended the guest's pause

  // ── actions ────────────────────────────────────────────────────────────

  action init = all {
    joiner' = JOINERS.mapBy(_ => Away),
    hostUp' = true, hostPaused' = false,
    held' = Set(), compressing' = Set(), timers' = Set(),
    guestPaused' = false, guestDeadline' = false,
    toGuest' = [], relay' = Set(),
    kickedAPlayer' = false, pushedBack' = false, guestResumedBy' = "",
  }

  action hostUnchanged = all {
    hostUp' = hostUp, hostPaused' = hostPaused, held' = held,
    compressing' = compressing, timers' = timers, kickedAPlayer' = kickedAPlayer,
    pushedBack' = pushedBack,
  }
  action guestUnchanged = all {
    guestPaused' = guestPaused, guestDeadline' = guestDeadline, guestResumedBy' = guestResumedBy,
  }

  // The joiner's page is in the room and its emulator is up: it asks.
  action ask(j: str): bool = all {
    joiner.get(j) == Away,
    joiner' = joiner.set(j, Asking),
    hostUnchanged, guestUnchanged, toGuest' = toGuest, relay' = relay,
  }

  // The host takes the request: holds the joiner, pauses, tells the guest,
  // captures its state and starts compressing it.
  action beginServe(j: str): bool = all {
    hostUp,
    joiner.get(j) == Asking,
    not(held.contains(j)),
    held' = held.union(Set(j)),
    hostPaused' = true,
    compressing' = compressing.union(Set(j)),
    timers' = if (ARM_AT_PAUSE) timers.union(Set(j)) else timers,
    toGuest' = toGuest.append(Pause),
    hostUp' = hostUp, kickedAPlayer' = kickedAPlayer, pushedBack' = pushedBack,
    joiner' = joiner, guestUnchanged, relay' = relay,
  }

  // The joiner repeats its request (every 5 s until it has a state) and the
  // host takes it while still serving that joiner: it captures and compresses
  // again. As first written this was a new serve with a new timer, and the
  // timer armed for the one before no longer acted.
  action serveAgain(j: str): bool = all {
    hostUp,
    joiner.get(j) == Asking,
    held.contains(j),
    compressing' = compressing.union(Set(j)),
    pushedBack' = (pushedBack or not(KEEP_FIRST_DEADLINE)),
    toGuest' = toGuest.append(Pause),
    hostUp' = hostUp, hostPaused' = hostPaused, held' = held, timers' = timers,
    kickedAPlayer' = kickedAPlayer,
    joiner' = joiner, guestUnchanged, relay' = relay,
  }

  // The worker hands the compressed state back and it is sent. A worker
  // that hangs is this step never being taken.
  action sendState(j: str): bool = all {
    hostUp,
    compressing.contains(j),
    compressing' = compressing.exclude(Set(j)),
    timers' = timers.union(Set(j)),
    relay' = relay.union(Set(State(j))),
    hostUp' = hostUp, hostPaused' = hostPaused, held' = held, kickedAPlayer' = kickedAPlayer,
    pushedBack' = pushedBack,
    joiner' = joiner, guestUnchanged, toGuest' = toGuest,
  }

  // The joiner loads the state and says so to everyone.
  action loadState(j: str): bool = all {
    relay.contains(State(j)),
    relay' = if (joiner.get(j) == Asking)
      relay.exclude(Set(State(j))).union(Set(ReadyToHost(j), ReadyToGuest(j)))
    else relay.exclude(Set(State(j))),
    joiner' = if (joiner.get(j) == Asking) joiner.set(j, Ready) else joiner,
    hostUnchanged, guestUnchanged, toGuest' = toGuest,
  }

  // The host hears "ready": the joiner becomes an active player and the
  // game resumes.
  action hostHearsReady(j: str): bool = {
    val stillHeld = held.exclude(Set(j))
    val resumes = hostPaused and (not(PAUSE_PER_JOINER) or stillHeld == Set())
    all {
      relay.contains(ReadyToHost(j)),
      relay' = relay.exclude(Set(ReadyToHost(j))),
      if (hostUp and held.contains(j)) all {
        held' = stillHeld,
        joiner' = if (joiner.get(j) == Ready) joiner.set(j, Playing) else joiner,
        hostPaused' = if (resumes) false else hostPaused,
        toGuest' = if (resumes) toGuest.append(Resume) else toGuest,
      } else all {
        held' = held, joiner' = joiner, hostPaused' = hostPaused, toGuest' = toGuest,
      },
      hostUp' = hostUp, compressing' = compressing, timers' = timers,
      kickedAPlayer' = kickedAPlayer, pushedBack' = pushedBack, guestUnchanged,
    }
  }

  // A serve's 15 s timer fires.
  action timerFires(j: str): bool = {
    val acts = if (PAUSE_PER_JOINER) held.contains(j) else hostPaused
    val stillHeld = held.exclude(Set(j))
    val resumes = acts and hostPaused and (not(PAUSE_PER_JOINER) or stillHeld == Set())
    all {
      hostUp,
      timers.contains(j),
      timers' = timers.exclude(Set(j)),
      held' = if (acts) stillHeld else held,
      compressing' = if (acts) compressing.exclude(Set(j)) else compressing,
      joiner' = if (acts and joiner.get(j) != Away) joiner.set(j, Gone) else joiner,
      kickedAPlayer' = (kickedAPlayer or (acts and joiner.get(j) == Playing)),
      hostPaused' = if (resumes) false else hostPaused,
      toGuest' = if (resumes) toGuest.append(Resume) else toGuest,
      hostUp' = hostUp, pushedBack' = pushedBack, guestUnchanged, relay' = relay,
    }
  }

  // The guest reads the next message on the host's channel.
  action guestHears = all {
    toGuest.length() > 0,
    toGuest' = toGuest.tail(),
    match toGuest.head() {
      | Pause => all {
          guestPaused' = true, guestDeadline' = GUEST_PAUSE_HAS_DEADLINE, guestResumedBy' = guestResumedBy,
        }
      | Resume => all {
          guestPaused' = false, guestDeadline' = false,
          guestResumedBy' = if (guestPaused) "host" else guestResumedBy,
        }
    },
    hostUnchanged, joiner' = joiner, relay' = relay,
  }

  // The joiner's "ready" reaches the guest. Before, the guest resumed on it,
  // whichever joiner it was from and whatever the host was doing.
  action guestHearsReady(j: str): bool = all {
    relay.contains(ReadyToGuest(j)),
    relay' = relay.exclude(Set(ReadyToGuest(j))),
    guestPaused' = if (GUEST_RESUMES_ON_HOST_ONLY) guestPaused else false,
    guestDeadline' = if (GUEST_RESUMES_ON_HOST_ONLY) guestDeadline else false,
    guestResumedBy' = if (guestPaused and not(GUEST_RESUMES_ON_HOST_ONLY)) "joiner" else guestResumedBy,
    hostUnchanged, joiner' = joiner, toGuest' = toGuest,
  }

  action guestDeadlineFires = all {
    guestPaused, guestDeadline,
    guestPaused' = false, guestDeadline' = false, guestResumedBy' = "deadline",
    hostUnchanged, joiner' = joiner, toGuest' = toGuest, relay' = relay,
  }

  action joinerLeaves(j: str): bool = all {
    joiner.get(j) == Asking or joiner.get(j) == Ready,
    joiner' = joiner.set(j, Gone),
    hostUnchanged, guestUnchanged, toGuest' = toGuest, relay' = relay,
  }

  // The host's page reloads: its pause, timers and channel are gone.
  action hostReloads = all {
    hostUp,
    hostUp' = false, hostPaused' = false,
    held' = Set(), compressing' = Set(), timers' = Set(),
    toGuest' = [],
    kickedAPlayer' = kickedAPlayer, pushedBack' = pushedBack,
    joiner' = joiner, guestUnchanged, relay' = relay,
  }

  action step = any {
    guestHears,
    guestDeadlineFires,
    hostReloads,
    nondet j = oneOf(JOINERS)
    any {
      ask(j), beginServe(j), serveAgain(j), sendState(j), loadState(j), hostHearsReady(j),
      timerFires(j), guestHearsReady(j), joinerLeaves(j),
    },
  }

  // ── properties ─────────────────────────────────────────────────────────

  // A joiner still to load a state was given the state of a paused game.
  def stillToLoad(j: str): bool = and {
    held.contains(j),
    joiner.get(j) == Asking,
    compressing.contains(j) or relay.contains(State(j)),
  }

  // The game does not run on while a joiner has yet to load the state
  // captured for it: the joiner would start frames behind.
  // Violated before the pause belonged to the joiners being served: another
  // joiner's "ready", or its timer, ended the pause.
  val gameStaysPausedWhileAJoinerLoads =
    hostUp implies JOINERS.forall(j => stillToLoad(j) implies hostPaused)

  // The host never disconnects a joiner who is playing.
  // Violated before each timer acted only on its own joiner: one armed for a
  // joiner who had since joined fired during the pause for another.
  val neverKicksAPlayerWhoJoined = not(kickedAPlayer)

  // A timer that will end the host's pause.
  def hostDeadline: bool = timers.exists(j => not(PAUSE_PER_JOINER) or held.contains(j))

  // Netplay invariant I1 for the host's pause.
  // Violated before the timer was armed at the pause: the host had none
  // while the state was being compressed.
  val hostPauseHasADeadline = (hostUp and hostPaused) implies hostDeadline

  // The deadline of a serve is the one armed when it began.
  // Violated as first written: the joiner repeats its request every 5 s, and
  // each one the host took put the deadline 15 s out again.
  val aRepeatedRequestKeepsTheDeadline = not(pushedBack)

  // A paused guest runs again on the host's word, or at its own deadline.
  // Violated before: any joiner's "ready" resumed it, and with the pause
  // kept for a second joiner the guest then ran on while the host stood
  // still.
  val guestResumesOnTheHostsWord = guestResumedBy != "joiner"

  // The same for the guest's pause.
  // Violated before the guest had a deadline of its own: a host that
  // reloaded left it paused.
  val guestPauseHasADeadline = guestPaused implies or {
    guestDeadline,
    toGuest.select(m => m == Resume).length() > 0,
    hostUp and hostPaused and hostDeadline,
  }

  val holdToday = and { gameStaysPausedWhileAJoinerLoads, neverKicksAPlayerWhoJoined, hostPauseHasADeadline }
  val allHold = and {
    holdToday, aRepeatedRequestKeepsTheDeadline, guestResumesOnTheHostsWord, guestPauseHasADeadline,
  }

  // ── scenarios ──────────────────────────────────────────────────────────

  // One joiner, nothing in the way: everyone ends up playing.
  run oneJoinerTest =
    init
      .then(ask("a")).then(beginServe("a")).then(guestHears)
      .expect(hostPaused and guestPaused)
      .then(sendState("a")).then(loadState("a")).then(hostHearsReady("a")).then(guestHears)
      .expect(joiner.get("a") == Playing and not(hostPaused) and not(guestPaused))
      .then(timerFires("a"))
      .expect(joiner.get("a") == Playing)

  // Two joiners. The first one's "ready" arrives while the second is still
  // to load its state.
  run firstReadyEndsThePauseForTheSecondTest =
    init
      .then(ask("a")).then(beginServe("a")).then(sendState("a"))
      .then(ask("b")).then(beginServe("b")).then(sendState("b"))
      .then(loadState("a")).then(hostHearsReady("a"))
      .expect(gameStaysPausedWhileAJoinerLoads == PAUSE_PER_JOINER)

  // The first joiner is playing; its timer fires during the pause for the
  // second.
  run timerDisconnectsAPlayerTest =
    init
      .then(ask("a")).then(beginServe("a")).then(sendState("a"))
      .then(loadState("a")).then(hostHearsReady("a"))
      .then(ask("b")).then(beginServe("b"))
      .then(timerFires("a"))
      .expect(neverKicksAPlayerWhoJoined == PAUSE_PER_JOINER)

  // The worker never hands the state back.
  run compressionHangsTest =
    init
      .then(ask("a")).then(beginServe("a"))
      .expect(hostPauseHasADeadline == ARM_AT_PAUSE)

  // The host reloads while the guest is paused.
  run hostReloadsDuringThePauseTest =
    init
      .then(ask("a")).then(beginServe("a")).then(sendState("a")).then(guestHears)
      .then(hostReloads)
      .expect(guestPauseHasADeadline == GUEST_PAUSE_HAS_DEADLINE)

  // Two joiners and a guest. The first joiner's "ready" reaches the guest
  // while the host is still paused for the second.
  run guestRunsOnWhileTheHostIsPausedTest =
    init
      .then(ask("a")).then(beginServe("a")).then(guestHears).then(sendState("a"))
      .then(ask("b")).then(beginServe("b")).then(guestHears).then(sendState("b"))
      .then(loadState("a")).then(hostHearsReady("a")).then(guestHearsReady("a"))
      .expect(PAUSE_PER_JOINER implies hostPaused)
      .expect(guestPaused == GUEST_RESUMES_ON_HOST_ONLY)
      .expect(guestResumesOnTheHostsWord == GUEST_RESUMES_ON_HOST_ONLY)

  // The worker hangs and the joiner asks again.
  run repeatedRequestTest =
    init
      .then(ask("a")).then(beginServe("a"))
      .then(serveAgain("a"))
      .expect(aRepeatedRequestKeepsTheDeadline == KEEP_FIRST_DEADLINE)
      .expect(hostPauseHasADeadline == ARM_AT_PAUSE)
}

// Before: one pause for everyone, its timer armed after compression.
module late_join_pause_before {
  import late_join_pause(
    PAUSE_PER_JOINER = false, ARM_AT_PAUSE = false, KEEP_FIRST_DEADLINE = true,
    GUEST_RESUMES_ON_HOST_ONLY = false, GUEST_PAUSE_HAS_DEADLINE = false
  ).*
}

// The host's side as first written: the pause per joiner, but a repeated
// request re-armed it and the guest still resumed on a joiner's word.
module late_join_pause_host_side {
  import late_join_pause(
    PAUSE_PER_JOINER = true, ARM_AT_PAUSE = true, KEEP_FIRST_DEADLINE = false,
    GUEST_RESUMES_ON_HOST_ONLY = false, GUEST_PAUSE_HAS_DEADLINE = false
  ).*
}

// Today.
module late_join_pause_current {
  import late_join_pause(
    PAUSE_PER_JOINER = true, ARM_AT_PAUSE = true, KEEP_FIRST_DEADLINE = true,
    GUEST_RESUMES_ON_HOST_ONLY = true, GUEST_PAUSE_HAS_DEADLINE = true
  ).*
}
