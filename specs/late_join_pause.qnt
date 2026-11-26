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
// host's messages to the guest and to each joiner in order (one data channel
// each), the messages that go through the server in any order, the 15 s
// timer of each serve, a joiner leaving, the host reloading, and:
//   - a joiner made a player while the host is still paused for the other
//     one. The host tells it to pause (finishLateJoinReady), the resume goes
//     to it with everyone else, and its pause has the same deadline as the
//     guest's. It runs between loading the state and hearing that pause, as
//     a single joiner does before the host hears its "ready": the rollback
//     engine predicts the host over those frames.
//   - a joiner's data channel to the host closing during its serve (a lost
//     connection, or the host's own disconnect at the 15 s deadline), and
//     opening again. The host ends the serve (resetPeerState), so the timer
//     and a compression still running do nothing for it; the state may
//     already be on its way through the server, and the joiner may load it
//     after the host has run on. A "ready" that comes while the channel is
//     closed is held until it opens (_pendingLateJoinReadySids).
//
// A Socket.IO reconnect of the joiner is not an action of its own: the host
// keeps the serve under the same key (_peerKey, _currentSid) while the data
// channel is live, and evicts the entry, ending the serve, when it is not;
// both are here. A state sent to the old socket id is lost, and the joiner's
// repeated request is the same serve (serveAgain). A reconnect offer that
// replaces the joiner's connection without a close event leaves the serve as
// it is, which is no step at all.
//
// Not modelled: the joiner's own wait (room_lifecycle.qnt and
// web/src/late-join-wait.ts), a "ready" that arrives before the joiner's
// data channel has ever opened, inputs and frames, spectators, the channel
// of a joiner who is already playing (the regular reconnect path:
// peer_connection.qnt), and the resync itself (resync_flow.qnt): here it
// puts the joiner where the host is in one step.
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
// RESYNC_AFTER_LOST_HOST: a joiner whose channel to the host closed while
//   it waited for the state, or while loading it, asks the host for a full
//   resync once it has loaded and its channel is open. false = before: only
//   a joiner already running did (the regular reconnect path), and one that
//   lost the channel before loading was made a player on a state the host
//   had run past.
// KEEP_MARKER_UNTIL_APPLIED: that joiner keeps its "lost the host" marker
//   until a state from the host is applied, asks again when a request goes
//   unanswered (refused by the host's rate limit, a failed capture, a lost
//   answer: the request's deadline), and after MAX_ASKS asks gives up
//   visibly. false = as first written: the marker was cleared when the
//   request was sent, and an unanswered one left the joiner behind for good.
module late_join_pause {
  const PAUSE_PER_JOINER: bool
  const ARM_AT_PAUSE: bool
  const KEEP_FIRST_DEADLINE: bool
  const GUEST_RESUMES_ON_HOST_ONLY: bool
  const GUEST_PAUSE_HAS_DEADLINE: bool
  const RESYNC_AFTER_LOST_HOST: bool
  const KEEP_MARKER_UNTIL_APPLIED: bool

  pure val JOINERS = Set("a", "b")
  pure val MAX_ASKS = 3

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
  var channel: Set[str]      // joiners with an open data channel to the host
  var toJoiner: str -> List[ToGuest] // the host's data channel to each joiner, in order
  var joinerPaused: Set[str]
  var joinerDeadline: Set[str]
  var pendingReady: Set[str] // host: "ready" heard while the joiner's channel was closed
  var lostHost: Set[str]     // joiner: its channel to the host closed since it asked
  var resyncOwed: Set[str]   // joiner: a full resync from the host is on its way
  var behind: Set[str]       // history: the host ran on past the state this joiner loads
  var asks: str -> int       // joiner: resync requests sent for its lost-host marker
  var gaveUp: Set[str]       // joiner: gave up asking, visibly (LATE-JOIN-LOST-HOST-GIVEUP)

  // ── actions ────────────────────────────────────────────────────────────

  action init = all {
    joiner' = JOINERS.mapBy(_ => Away),
    hostUp' = true, hostPaused' = false,
    held' = Set(), compressing' = Set(), timers' = Set(),
    guestPaused' = false, guestDeadline' = false,
    toGuest' = [], relay' = Set(),
    kickedAPlayer' = false, pushedBack' = false, guestResumedBy' = "",
    channel' = Set(), toJoiner' = JOINERS.mapBy(_ => []),
    joinerPaused' = Set(), joinerDeadline' = Set(),
    pendingReady' = Set(), lostHost' = Set(), resyncOwed' = Set(), behind' = Set(),
    asks' = JOINERS.mapBy(_ => 0), gaveUp' = Set(),
  }

  action hostUnchanged = all {
    hostUp' = hostUp, hostPaused' = hostPaused, held' = held,
    compressing' = compressing, timers' = timers, kickedAPlayer' = kickedAPlayer,
    pushedBack' = pushedBack,
  }
  action guestUnchanged = all {
    guestPaused' = guestPaused, guestDeadline' = guestDeadline, guestResumedBy' = guestResumedBy,
  }
  action joinersUnchanged = all {
    channel' = channel, toJoiner' = toJoiner, joinerPaused' = joinerPaused,
    joinerDeadline' = joinerDeadline, pendingReady' = pendingReady, lostHost' = lostHost,
    resyncOwed' = resyncOwed, asks' = asks, gaveUp' = gaveUp, behind' = behind,
  }
  action unchangedAll = all {
    joiner' = joiner, hostUnchanged, guestUnchanged, joinersUnchanged,
    toGuest' = toGuest, relay' = relay,
  }

  // The host's word to every joiner with an open channel but `except`.
  def tellJoiners(m: ToGuest, except: str): str -> List[ToGuest] =
    JOINERS.mapBy(k => if (channel.contains(k) and k != except) toJoiner.get(k).append(m) else toJoiner.get(k))

  // When the host runs on: the joiners holding, or about to load, a state
  // captured during this pause who are not players yet. `except` is the
  // joiner the same step makes a player.
  def runsPast(except: str): Set[str] = JOINERS.filter(k => and {
    k != except,
    joiner.get(k) == Ready or (joiner.get(k) == Asking and relay.contains(State(k))),
  })

  // The joiner's side of a closed channel: a joiner already running has lost
  // a peer (the regular reconnect path, which resyncs); one still waiting or
  // loading only with RESYNC_AFTER_LOST_HOST.
  def losesHost(j: str): Set[str] =
    if (joiner.get(j) == Ready or RESYNC_AFTER_LOST_HOST) lostHost.union(Set(j)) else lostHost

  // Asking for the resync. As first written the marker went with the ask;
  // with KEEP_MARKER_UNTIL_APPLIED it stays until a state is applied.
  def markerAfterAsk(j: str): Set[str] =
    if (KEEP_MARKER_UNTIL_APPLIED) lostHost else lostHost.exclude(Set(j))

  // The joiner's page is in the room and its emulator is up: its channel to
  // the host is open and it asks.
  action ask(j: str): bool = all {
    joiner.get(j) == Away,
    joiner' = joiner.set(j, Asking),
    channel' = channel.union(Set(j)),
    hostUnchanged, guestUnchanged, toGuest' = toGuest, relay' = relay,
    toJoiner' = toJoiner, joinerPaused' = joinerPaused, joinerDeadline' = joinerDeadline,
    pendingReady' = pendingReady, lostHost' = lostHost, resyncOwed' = resyncOwed, asks' = asks, gaveUp' = gaveUp, behind' = behind,
  }

  // The host takes the request: holds the joiner, pauses, tells the guest
  // and every other joiner with an open channel, captures its state and
  // starts compressing it. The serve needs no channel: the state goes
  // through the server.
  action beginServe(j: str): bool = all {
    hostUp,
    joiner.get(j) == Asking,
    not(held.contains(j)),
    held' = held.union(Set(j)),
    hostPaused' = true,
    compressing' = compressing.union(Set(j)),
    timers' = if (ARM_AT_PAUSE) timers.union(Set(j)) else timers,
    toGuest' = toGuest.append(Pause),
    toJoiner' = tellJoiners(Pause, j),
    // A fresh capture: this joiner is no longer behind, unless an older
    // state is still on its way to it.
    behind' = if (relay.contains(State(j))) behind else behind.exclude(Set(j)),
    hostUp' = hostUp, kickedAPlayer' = kickedAPlayer, pushedBack' = pushedBack,
    joiner' = joiner, guestUnchanged, relay' = relay,
    channel' = channel, joinerPaused' = joinerPaused, joinerDeadline' = joinerDeadline,
    pendingReady' = pendingReady, lostHost' = lostHost, resyncOwed' = resyncOwed, asks' = asks, gaveUp' = gaveUp,
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
    toJoiner' = tellJoiners(Pause, j),
    behind' = if (relay.contains(State(j))) behind else behind.exclude(Set(j)),
    hostUp' = hostUp, hostPaused' = hostPaused, held' = held, timers' = timers,
    kickedAPlayer' = kickedAPlayer,
    joiner' = joiner, guestUnchanged, relay' = relay,
    channel' = channel, joinerPaused' = joinerPaused, joinerDeadline' = joinerDeadline,
    pendingReady' = pendingReady, lostHost' = lostHost, resyncOwed' = resyncOwed, asks' = asks, gaveUp' = gaveUp,
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
    joiner' = joiner, guestUnchanged, toGuest' = toGuest, joinersUnchanged,
  }

  // The joiner loads the state, clears a pause it heard while waiting
  // (handleLateJoinState) and says it is ready to everyone. With
  // RESYNC_AFTER_LOST_HOST, a joiner that lost its channel to the host asks
  // for a resync now if the channel is open, or when it opens.
  action loadState(j: str): bool = {
    val loads = joiner.get(j) == Asking
    val asksNow = loads and lostHost.contains(j) and channel.contains(j) and not(resyncOwed.contains(j))
    all {
      relay.contains(State(j)),
      relay' = if (loads)
        relay.exclude(Set(State(j))).union(Set(ReadyToHost(j), ReadyToGuest(j)))
      else relay.exclude(Set(State(j))),
      joiner' = if (loads) joiner.set(j, Ready) else joiner,
      joinerPaused' = if (loads) joinerPaused.exclude(Set(j)) else joinerPaused,
      joinerDeadline' = if (loads) joinerDeadline.exclude(Set(j)) else joinerDeadline,
      resyncOwed' = if (asksNow) resyncOwed.union(Set(j)) else resyncOwed,
      asks' = if (asksNow) asks.set(j, asks.get(j) + 1) else asks, gaveUp' = gaveUp,
      lostHost' = if (asksNow) markerAfterAsk(j) else lostHost,
      hostUnchanged, guestUnchanged, toGuest' = toGuest,
      channel' = channel, toJoiner' = toJoiner, pendingReady' = pendingReady, behind' = behind,
    }
  }

  // The host hears "ready" (finishLateJoinReady). It acts on any joiner it
  // has not made a player yet, whether or not it still serves it. With the
  // joiner's channel open it makes it a player; if the pause is kept for
  // another joiner it tells this one to pause too. With the channel closed it
  // holds the "ready" until the channel opens, and ends the serve.
  action hostHearsReady(j: str): bool = {
    val acts = hostUp and joiner.get(j) == Ready and not(pendingReady.contains(j))
    val open = channel.contains(j)
    val stillHeld = held.exclude(Set(j))
    val resumes = acts and hostPaused and (not(PAUSE_PER_JOINER) or stillHeld == Set())
    val pausesIt = acts and open and hostPaused and not(resumes)
    all {
      relay.contains(ReadyToHost(j)),
      relay' = relay.exclude(Set(ReadyToHost(j))),
      held' = if (acts) stillHeld else held,
      joiner' = if (acts and open) joiner.set(j, Playing) else joiner,
      pendingReady' = if (acts and not(open)) pendingReady.union(Set(j)) else pendingReady,
      hostPaused' = if (resumes) false else hostPaused,
      toGuest' = if (resumes) toGuest.append(Resume) else toGuest,
      toJoiner' = if (resumes) tellJoiners(Resume, "")
        else if (pausesIt) toJoiner.set(j, toJoiner.get(j).append(Pause))
        else toJoiner,
      behind' = if (resumes) behind.union(runsPast(if (open) j else "")) else behind,
      hostUp' = hostUp, compressing' = compressing, timers' = timers,
      kickedAPlayer' = kickedAPlayer, pushedBack' = pushedBack, guestUnchanged,
      channel' = channel, joinerPaused' = joinerPaused, joinerDeadline' = joinerDeadline,
      lostHost' = lostHost, resyncOwed' = resyncOwed, asks' = asks, gaveUp' = gaveUp,
    }
  }

  // A serve's 15 s timer fires. It disconnects the joiner (hardDisconnectPeer),
  // which closes its channel: the joiner page is still there and may yet
  // load a state that is on its way.
  action timerFires(j: str): bool = {
    val acts = if (PAUSE_PER_JOINER) held.contains(j) else hostPaused
    val stillHeld = held.exclude(Set(j))
    val resumes = acts and hostPaused and (not(PAUSE_PER_JOINER) or stillHeld == Set())
    val drops = acts and channel.contains(j) and joiner.get(j) != Gone
    all {
      hostUp,
      timers.contains(j),
      timers' = timers.exclude(Set(j)),
      held' = if (acts) stillHeld else held,
      compressing' = if (acts) compressing.exclude(Set(j)) else compressing,
      kickedAPlayer' = (kickedAPlayer or (acts and joiner.get(j) == Playing)),
      hostPaused' = if (resumes) false else hostPaused,
      toGuest' = if (resumes) toGuest.append(Resume) else toGuest,
      channel' = if (drops) channel.exclude(Set(j)) else channel,
      toJoiner' = {
        val told = if (resumes) tellJoiners(Resume, j) else toJoiner
        if (drops) told.set(j, []) else told
      },
      lostHost' = if (drops and joiner.get(j) != Playing) losesHost(j) else lostHost,
      behind' = if (resumes) behind.union(runsPast("")) else behind,
      hostUp' = hostUp, pushedBack' = pushedBack, guestUnchanged, relay' = relay,
      joiner' = joiner, joinerPaused' = joinerPaused, joinerDeadline' = joinerDeadline,
      pendingReady' = pendingReady, resyncOwed' = resyncOwed, asks' = asks, gaveUp' = gaveUp,
    }
  }

  // A joiner's channel to the host closes before it is a player. The host
  // drops it as a pending late joiner (handlePeerDisconnect ->
  // hardDisconnectPeer -> resetPeerState): its serve ends, and the pause
  // with it if no other joiner is held. The joiner sees the close too.
  action channelDrops(j: str): bool = {
    val ends = held.contains(j)
    val stillHeld = held.exclude(Set(j))
    val resumes = ends and hostPaused and stillHeld == Set()
    all {
      hostUp,
      channel.contains(j),
      joiner.get(j) == Asking or joiner.get(j) == Ready,
      channel' = channel.exclude(Set(j)),
      held' = stillHeld,
      compressing' = compressing.exclude(Set(j)),
      // The timer stays armed but finds its serve gone: it does nothing.
      timers' = if (ends) timers.exclude(Set(j)) else timers,
      hostPaused' = if (resumes) false else hostPaused,
      toGuest' = if (resumes) toGuest.append(Resume) else toGuest,
      toJoiner' = {
        val told = if (resumes) tellJoiners(Resume, j) else toJoiner
        told.set(j, [])
      },
      lostHost' = losesHost(j),
      behind' = if (resumes) behind.union(runsPast("")) else behind,
      hostUp' = hostUp, kickedAPlayer' = kickedAPlayer, pushedBack' = pushedBack,
      joiner' = joiner, guestUnchanged, relay' = relay,
      joinerPaused' = joinerPaused, joinerDeadline' = joinerDeadline,
      pendingReady' = pendingReady, resyncOwed' = resyncOwed, asks' = asks, gaveUp' = gaveUp,
    }
  }

  // The channel opens again (the joiner's reconnect offer, or the host's mesh
  // health check). A "ready" held for it now makes the joiner a player
  // ("deferred DC open"), paused if the pause is kept for another joiner. A
  // joiner that has loaded and lost the host asks for its resync.
  action channelReopens(j: str): bool = {
    val activates = pendingReady.contains(j) and joiner.get(j) == Ready
    val asksNow = lostHost.contains(j) and joiner.get(j) == Ready and not(resyncOwed.contains(j))
    all {
      hostUp,
      not(channel.contains(j)),
      joiner.get(j) == Asking or joiner.get(j) == Ready,
      channel' = channel.union(Set(j)),
      joiner' = if (activates) joiner.set(j, Playing) else joiner,
      pendingReady' = pendingReady.exclude(Set(j)),
      toJoiner' = if (activates and hostPaused) toJoiner.set(j, [Pause]) else toJoiner.set(j, []),
      resyncOwed' = if (asksNow) resyncOwed.union(Set(j)) else resyncOwed,
      asks' = if (asksNow) asks.set(j, asks.get(j) + 1) else asks, gaveUp' = gaveUp,
      lostHost' = if (asksNow) markerAfterAsk(j) else lostHost,
      hostUnchanged, guestUnchanged, toGuest' = toGuest, relay' = relay,
      joinerPaused' = joinerPaused, joinerDeadline' = joinerDeadline, behind' = behind,
    }
  }

  // The host answers the joiner's full resync request with the state it is
  // at now, and the joiner applies it: the marker goes with it.
  action resyncs(j: str): bool = all {
    hostUp,
    resyncOwed.contains(j),
    channel.contains(j),
    resyncOwed' = resyncOwed.exclude(Set(j)),
    behind' = behind.exclude(Set(j)),
    lostHost' = lostHost.exclude(Set(j)),
    asks' = asks.set(j, 0), gaveUp' = gaveUp,
    hostUnchanged, guestUnchanged, joiner' = joiner, toGuest' = toGuest, relay' = relay,
    channel' = channel, toJoiner' = toJoiner, joinerPaused' = joinerPaused,
    joinerDeadline' = joinerDeadline, pendingReady' = pendingReady,
  }

  // The request goes unanswered: the host's rate limit refuses it, its
  // capture fails, or the answer is lost. The request's deadline
  // (RESYNC-REQUEST-TIMEOUT) ends it.
  action resyncUnanswered(j: str): bool = all {
    resyncOwed.contains(j),
    resyncOwed' = resyncOwed.exclude(Set(j)),
    hostUnchanged, guestUnchanged, joiner' = joiner, toGuest' = toGuest, relay' = relay,
    channel' = channel, toJoiner' = toJoiner, joinerPaused' = joinerPaused,
    joinerDeadline' = joinerDeadline, pendingReady' = pendingReady, lostHost' = lostHost,
    behind' = behind, asks' = asks, gaveUp' = gaveUp,
  }

  // At that deadline a joiner still marked asks again, up to MAX_ASKS.
  action askAgain(j: str): bool = all {
    lostHost.contains(j),
    joiner.get(j) == Ready or joiner.get(j) == Playing,
    channel.contains(j),
    not(resyncOwed.contains(j)),
    asks.get(j) > 0, asks.get(j) < MAX_ASKS,
    resyncOwed' = resyncOwed.union(Set(j)),
    asks' = asks.set(j, asks.get(j) + 1),
    lostHost' = markerAfterAsk(j),
    hostUnchanged, guestUnchanged, joiner' = joiner, toGuest' = toGuest, relay' = relay,
    channel' = channel, toJoiner' = toJoiner, joinerPaused' = joinerPaused,
    joinerDeadline' = joinerDeadline, pendingReady' = pendingReady, behind' = behind,
    gaveUp' = gaveUp,
  }

  // After MAX_ASKS unanswered asks the joiner gives up, visibly.
  action giveUp(j: str): bool = all {
    lostHost.contains(j),
    not(resyncOwed.contains(j)),
    asks.get(j) >= MAX_ASKS,
    lostHost' = lostHost.exclude(Set(j)),
    gaveUp' = gaveUp.union(Set(j)),
    asks' = asks.set(j, 0),
    hostUnchanged, guestUnchanged, joiner' = joiner, toGuest' = toGuest, relay' = relay,
    channel' = channel, toJoiner' = toJoiner, joinerPaused' = joinerPaused,
    joinerDeadline' = joinerDeadline, pendingReady' = pendingReady, behind' = behind,
    resyncOwed' = resyncOwed,
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
    hostUnchanged, joiner' = joiner, relay' = relay, joinersUnchanged,
  }

  // The joiner reads the next message on the host's channel. Same handlers
  // as the guest's.
  action joinerHears(j: str): bool = all {
    toJoiner.get(j).length() > 0,
    toJoiner' = toJoiner.set(j, toJoiner.get(j).tail()),
    match toJoiner.get(j).head() {
      | Pause => all {
          joinerPaused' = joinerPaused.union(Set(j)),
          joinerDeadline' = if (GUEST_PAUSE_HAS_DEADLINE) joinerDeadline.union(Set(j)) else joinerDeadline,
        }
      | Resume => all {
          joinerPaused' = joinerPaused.exclude(Set(j)),
          joinerDeadline' = joinerDeadline.exclude(Set(j)),
        }
    },
    hostUnchanged, guestUnchanged, joiner' = joiner, toGuest' = toGuest, relay' = relay,
    channel' = channel, pendingReady' = pendingReady, lostHost' = lostHost,
    resyncOwed' = resyncOwed, asks' = asks, gaveUp' = gaveUp, behind' = behind,
  }

  // The joiner's (20 s) deadline is longer than the host's (15 s per serve),
  // and every pause the host sends it is a serve beginning or a "ready" heard
  // while another serve is held: a host that is up and paused with a timer
  // armed resumes first.
  action joinerDeadlineFires(j: str): bool = all {
    joinerPaused.contains(j), joinerDeadline.contains(j),
    not(hostUp and hostPaused and hostDeadline),
    joinerPaused' = joinerPaused.exclude(Set(j)),
    joinerDeadline' = joinerDeadline.exclude(Set(j)),
    hostUnchanged, guestUnchanged, joiner' = joiner, toGuest' = toGuest, relay' = relay,
    channel' = channel, toJoiner' = toJoiner, pendingReady' = pendingReady, lostHost' = lostHost,
    resyncOwed' = resyncOwed, asks' = asks, gaveUp' = gaveUp, behind' = behind,
  }

  // The joiner's "ready" reaches the guest. Before, the guest resumed on it,
  // whichever joiner it was from and whatever the host was doing.
  action guestHearsReady(j: str): bool = all {
    relay.contains(ReadyToGuest(j)),
    relay' = relay.exclude(Set(ReadyToGuest(j))),
    guestPaused' = if (GUEST_RESUMES_ON_HOST_ONLY) guestPaused else false,
    guestDeadline' = if (GUEST_RESUMES_ON_HOST_ONLY) guestDeadline else false,
    guestResumedBy' = if (guestPaused and not(GUEST_RESUMES_ON_HOST_ONLY)) "joiner" else guestResumedBy,
    hostUnchanged, joiner' = joiner, toGuest' = toGuest, joinersUnchanged,
  }

  action guestDeadlineFires = all {
    guestPaused, guestDeadline,
    guestPaused' = false, guestDeadline' = false, guestResumedBy' = "deadline",
    hostUnchanged, joiner' = joiner, toGuest' = toGuest, relay' = relay, joinersUnchanged,
  }

  action joinerLeaves(j: str): bool = all {
    joiner.get(j) == Asking or joiner.get(j) == Ready,
    joiner' = joiner.set(j, Gone),
    hostUnchanged, guestUnchanged, toGuest' = toGuest, relay' = relay, joinersUnchanged,
  }

  // The host's page reloads: its pause, timers and channels are gone.
  action hostReloads = all {
    hostUp,
    hostUp' = false, hostPaused' = false,
    held' = Set(), compressing' = Set(), timers' = Set(),
    toGuest' = [],
    kickedAPlayer' = kickedAPlayer, pushedBack' = pushedBack,
    joiner' = joiner, guestUnchanged, relay' = relay,
    channel' = Set(), toJoiner' = JOINERS.mapBy(_ => []), pendingReady' = Set(),
    joinerPaused' = joinerPaused, joinerDeadline' = joinerDeadline, lostHost' = lostHost,
    resyncOwed' = resyncOwed, asks' = asks, gaveUp' = gaveUp, behind' = behind,
  }

  action step = any {
    guestHears,
    guestDeadlineFires,
    hostReloads,
    nondet j = oneOf(JOINERS)
    any {
      ask(j), beginServe(j), serveAgain(j), sendState(j), loadState(j), hostHearsReady(j),
      timerFires(j), guestHearsReady(j), joinerLeaves(j),
      channelDrops(j), channelReopens(j), resyncs(j), joinerHears(j), joinerDeadlineFires(j),
      resyncUnanswered(j), askAgain(j), giveUp(j),
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

  // I1 for a joiner's pause, the one it hears while waiting and the one it
  // hears as a new player.
  // Violated before the guest had a deadline of its own (the joiner's page
  // runs the same handler).
  val joinerPauseHasADeadline = JOINERS.forall(j => joinerPaused.contains(j) implies or {
    joinerDeadline.contains(j),
    toJoiner.get(j).select(m => m == Resume).length() > 0,
    hostUp and hostPaused and hostDeadline,
  })

  // The last word on the channel to `j` is a pause.
  def pauseOnItsWay(j: str): bool = {
    val q = toJoiner.get(j)
    q.length() > 0 and q[q.length() - 1] == Pause
  }

  // A joiner made a player while the host is paused for another joiner does
  // not run on while the host stands still: it is paused, or the pause is on
  // its way to it (the resume comes with everyone else's).
  val aNewPlayerWaitsForTheHost = (hostUp and hostPaused) implies JOINERS.forall(j =>
    (joiner.get(j) == Playing and channel.contains(j)) implies
      (joinerPaused.contains(j) or pauseOnItsWay(j))
  )

  // A joiner is not made a player on a state the host has run past, unless a
  // full resync is on its way to put it where the host is, it is still
  // marked to ask for one, or it has given up visibly.
  // Violated before RESYNC_AFTER_LOST_HOST: the joiner's channel closed
  // after the state was sent (a lost connection, or the 15 s deadline); the
  // host ended the serve and ran on; the joiner loaded the old state, its
  // channel opened again, and its "ready" made it a player frames behind.
  // Violated before KEEP_MARKER_UNTIL_APPLIED: the marker went with the
  // request, and one that went unanswered was never asked again.
  val aJoinerIsNotMadeAPlayerBehindTheHost = JOINERS.forall(j =>
    (joiner.get(j) == Playing and behind.contains(j)) implies
      (resyncOwed.contains(j) or lostHost.contains(j) or gaveUp.contains(j))
  )

  val holdToday = and { gameStaysPausedWhileAJoinerLoads, neverKicksAPlayerWhoJoined, hostPauseHasADeadline }
  // Everything but the last property.
  val holdBeforeTheResyncFix = and {
    holdToday, aRepeatedRequestKeepsTheDeadline, guestResumesOnTheHostsWord, guestPauseHasADeadline,
    joinerPauseHasADeadline, aNewPlayerWaitsForTheHost,
  }
  val allHold = and { holdBeforeTheResyncFix, aJoinerIsNotMadeAPlayerBehindTheHost }

  // ── scenarios ──────────────────────────────────────────────────────────

  // One joiner, nothing in the way: everyone ends up playing.
  run oneJoinerTest =
    init
      .then(ask("a")).then(beginServe("a")).then(guestHears)
      .expect(hostPaused and guestPaused)
      .then(sendState("a")).then(loadState("a")).then(hostHearsReady("a")).then(guestHears)
      .expect(joiner.get("a") == Playing and not(hostPaused) and not(guestPaused))
      .then(timerFires("a"))
      .expect(joiner.get("a") == Playing and channel.contains("a"))
      .expect(allHold)

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

  // Two joiners. `a` is made a player while the host is still paused for
  // `b`: it hears the pause `b`'s serve began with, then the one sent with
  // its "ready", and waits; `b`'s "ready" resumes everyone, `a` included.
  // Before the pause was per joiner, `a`'s "ready" ended the pause.
  run aNewPlayerPausesWithTheHostTest =
    init
      .then(ask("a")).then(beginServe("a")).then(sendState("a"))
      .then(ask("b")).then(beginServe("b")).then(sendState("b"))
      .then(loadState("a")).then(hostHearsReady("a"))
      .expect(joiner.get("a") == Playing)
      .expect(PAUSE_PER_JOINER implies (hostPaused and toJoiner.get("a") == [Pause, Pause]))
      .expect(not(PAUSE_PER_JOINER) implies (not(hostPaused) and toJoiner.get("a") == [Pause, Resume]))
      .then(joinerHears("a")).then(joinerHears("a"))
      .expect(joinerPaused.contains("a") == PAUSE_PER_JOINER)
      .expect(PAUSE_PER_JOINER implies (joinerDeadline.contains("a") == GUEST_PAUSE_HAS_DEADLINE))
      .expect(aNewPlayerWaitsForTheHost and joinerPauseHasADeadline)
      .then(loadState("b")).then(hostHearsReady("b"))
      .expect(not(hostPaused) and joiner.get("b") == Playing)
      .then(if (PAUSE_PER_JOINER) joinerHears("a") else unchangedAll)
      .expect(not(joinerPaused.contains("a")))
      // Before, the host ran on past `b`'s state when `a` was ready.
      .expect(PAUSE_PER_JOINER implies allHold)

  // `a` is a player when `b`'s serve begins (it heard the resume of its own
  // serve, as every page does): it is told to pause with the guest, and
  // resumed with it.
  run aPlayerPausesForTheNextJoinerTest =
    init
      .then(ask("a")).then(beginServe("a")).then(sendState("a"))
      .then(loadState("a")).then(hostHearsReady("a"))
      .expect(toJoiner.get("a") == [Resume])
      .then(ask("b")).then(beginServe("b")).then(sendState("b"))
      .then(joinerHears("a")).then(joinerHears("a"))
      .expect(hostPaused and joinerPaused.contains("a"))
      .then(timerFires("b"))
      .expect(not(hostPaused) and toJoiner.get("a") == [Resume] and not(channel.contains("b")))
      .then(joinerHears("a"))
      .expect(not(joinerPaused.contains("a")))
      .expect(allHold)

  // The joiner's channel closes after its state was sent. The host ends the
  // serve and runs on; the joiner loads the old state, its channel opens
  // again and its "ready" makes it a player.
  run joinerLosesTheHostAfterTheStateIsSentTest =
    init
      .then(ask("a")).then(beginServe("a")).then(sendState("a"))
      .then(channelDrops("a"))
      .expect(not(hostPaused) and held == Set() and timers == Set() and behind == Set("a"))
      .then(loadState("a")).then(channelReopens("a")).then(hostHearsReady("a"))
      .expect(joiner.get("a") == Playing)
      .expect(aJoinerIsNotMadeAPlayerBehindTheHost == RESYNC_AFTER_LOST_HOST)
      .then(if (RESYNC_AFTER_LOST_HOST) resyncs("a") else unchangedAll)
      .expect(RESYNC_AFTER_LOST_HOST implies (behind == Set() and allHold))

  // The same through the host's own deadline: the state is on its way, the
  // joiner is slow to load it, the timer fires and disconnects it. Its
  // "ready" comes while the channel is still closed and is held until the
  // channel opens.
  run timerFiresWhileTheStateIsOnItsWayTest =
    init
      .then(ask("a")).then(beginServe("a")).then(sendState("a"))
      .then(timerFires("a"))
      .expect(not(hostPaused) and not(channel.contains("a")) and joiner.get("a") == Asking)
      .then(loadState("a")).then(hostHearsReady("a"))
      .expect(pendingReady == Set("a") and joiner.get("a") == Ready)
      .then(channelReopens("a"))
      .expect(joiner.get("a") == Playing)
      .expect(aJoinerIsNotMadeAPlayerBehindTheHost == RESYNC_AFTER_LOST_HOST)

  // The channel closes before the state is sent: the serve ends, nothing is
  // sent for it, and the joiner's next request is a new serve with a state
  // captured now. No resync is needed.
  run channelClosesBeforeTheStateIsSentTest =
    init
      .then(ask("a")).then(beginServe("a"))
      .then(channelDrops("a"))
      .expect(not(hostPaused) and compressing == Set() and timers == Set())
      .then(channelReopens("a")).then(beginServe("a")).then(sendState("a"))
      .then(loadState("a"))
      .expect((resyncOwed == Set("a")) == RESYNC_AFTER_LOST_HOST)
      .then(hostHearsReady("a"))
      .expect(joiner.get("a") == Playing and behind == Set() and not(hostPaused))
      .expect(allHold)

  // The joiner made a player behind the host asks for its resync, and the
  // request goes unanswered (the host's rate limit refused it, its capture
  // failed, the answer was lost). As first written the marker had gone with
  // the request, and the joiner stayed behind the host for good.
  run resyncRequestUnansweredTest =
    init
      .then(ask("a")).then(beginServe("a")).then(sendState("a"))
      .then(channelDrops("a")).then(loadState("a")).then(channelReopens("a")).then(hostHearsReady("a"))
      .expect(joiner.get("a") == Playing and behind == Set("a"))
      .then(if (RESYNC_AFTER_LOST_HOST) resyncUnanswered("a") else unchangedAll)
      .expect(aJoinerIsNotMadeAPlayerBehindTheHost == (RESYNC_AFTER_LOST_HOST and KEEP_MARKER_UNTIL_APPLIED))
      .then(if (KEEP_MARKER_UNTIL_APPLIED) askAgain("a") else unchangedAll)
      .then(if (KEEP_MARKER_UNTIL_APPLIED) resyncs("a") else unchangedAll)
      .expect(KEEP_MARKER_UNTIL_APPLIED implies (behind == Set() and lostHost == Set() and allHold))

  // Every request goes unanswered: after MAX_ASKS the joiner gives up,
  // visibly, and asks no more.
  run resyncGivesUpAfterMaxAsksTest =
    init
      .then(ask("a")).then(beginServe("a")).then(sendState("a"))
      .then(channelDrops("a")).then(loadState("a")).then(channelReopens("a")).then(hostHearsReady("a"))
      .then(if (RESYNC_AFTER_LOST_HOST) resyncUnanswered("a") else unchangedAll)
      .then(if (KEEP_MARKER_UNTIL_APPLIED) askAgain("a") else unchangedAll)
      .then(if (KEEP_MARKER_UNTIL_APPLIED) resyncUnanswered("a") else unchangedAll)
      .then(if (KEEP_MARKER_UNTIL_APPLIED) askAgain("a") else unchangedAll)
      .then(if (KEEP_MARKER_UNTIL_APPLIED) resyncUnanswered("a") else unchangedAll)
      .expect(KEEP_MARKER_UNTIL_APPLIED implies (asks.get("a") == MAX_ASKS and lostHost == Set("a")))
      .then(if (KEEP_MARKER_UNTIL_APPLIED) giveUp("a") else unchangedAll)
      .expect(KEEP_MARKER_UNTIL_APPLIED implies (gaveUp == Set("a") and lostHost == Set() and allHold))
      .expect(not(KEEP_MARKER_UNTIL_APPLIED) implies (gaveUp == Set() and not(aJoinerIsNotMadeAPlayerBehindTheHost)))

  // Two joiners: `b`'s channel closes while it waits; `a` is still held, so
  // the pause is kept.
  run oneJoinerLostTheOtherStillHeldTest =
    init
      .then(ask("a")).then(beginServe("a"))
      .then(ask("b")).then(beginServe("b")).then(sendState("b"))
      .then(channelDrops("b"))
      .expect(hostPaused and held == Set("a") and (ARM_AT_PAUSE implies hostPauseHasADeadline))
      .expect(behind == Set())
}

// Before: one pause for everyone, its timer armed after compression.
module late_join_pause_before {
  import late_join_pause(
    PAUSE_PER_JOINER = false, ARM_AT_PAUSE = false, KEEP_FIRST_DEADLINE = true,
    GUEST_RESUMES_ON_HOST_ONLY = false, GUEST_PAUSE_HAS_DEADLINE = false,
    RESYNC_AFTER_LOST_HOST = false, KEEP_MARKER_UNTIL_APPLIED = false
  ).*
}

// The host's side as first written: the pause per joiner, but a repeated
// request re-armed it and the guest still resumed on a joiner's word.
module late_join_pause_host_side {
  import late_join_pause(
    PAUSE_PER_JOINER = true, ARM_AT_PAUSE = true, KEEP_FIRST_DEADLINE = false,
    GUEST_RESUMES_ON_HOST_ONLY = false, GUEST_PAUSE_HAS_DEADLINE = false,
    RESYNC_AFTER_LOST_HOST = false, KEEP_MARKER_UNTIL_APPLIED = false
  ).*
}

// Before a joiner that lost its channel to the host resynced: it was made
// a player on a state the host had run past.
module late_join_pause_before_resync {
  import late_join_pause(
    PAUSE_PER_JOINER = true, ARM_AT_PAUSE = true, KEEP_FIRST_DEADLINE = true,
    GUEST_RESUMES_ON_HOST_ONLY = true, GUEST_PAUSE_HAS_DEADLINE = true,
    RESYNC_AFTER_LOST_HOST = false, KEEP_MARKER_UNTIL_APPLIED = false
  ).*
}

// The lost-host resync as first written: the marker went with the request,
// and one that went unanswered left the joiner behind the host for good.
module late_join_pause_marker_at_send {
  import late_join_pause(
    PAUSE_PER_JOINER = true, ARM_AT_PAUSE = true, KEEP_FIRST_DEADLINE = true,
    GUEST_RESUMES_ON_HOST_ONLY = true, GUEST_PAUSE_HAS_DEADLINE = true,
    RESYNC_AFTER_LOST_HOST = true, KEEP_MARKER_UNTIL_APPLIED = false
  ).*
}

// Today: a joiner that lost its channel to the host asks for a full resync
// once it has loaded (_lateJoinLostHost, _resyncAfterLostHost), keeps the
// marker until a state is applied (applySyncState), asks again at each
// request's deadline and gives up visibly after
// LATE_JOIN_LOST_HOST_MAX_ASKS (3).
module late_join_pause_current {
  import late_join_pause(
    PAUSE_PER_JOINER = true, ARM_AT_PAUSE = true, KEEP_FIRST_DEADLINE = true,
    GUEST_RESUMES_ON_HOST_ONLY = true, GUEST_PAUSE_HAS_DEADLINE = true,
    RESYNC_AFTER_LOST_HOST = true, KEEP_MARKER_UNTIL_APPLIED = true
  ).*
}

// A compression failure belongs to the route that started the serve. A
// replacement can take the same controller slot while the old worker runs.
module late_join_serve_failure {
  const FENCE_FAILURE: bool
  var owner: int
  var pending: bool

  action init = all { owner' = 1, pending' = true }
  action replace = all { owner == 1, owner' = 2, pending' = true }
  action oldFailure = all {
    owner' = owner,
    pending' = (pending and (FENCE_FAILURE and owner != 1)),
  }
  action step = any { replace, oldFailure }

  val obsoleteFailurePreservesReplacement = owner != 2 or pending

  run replacementKeepsItsSlotTest =
    init.then(replace).then(oldFailure).expect(pending == FENCE_FAILURE)

  run currentFailureStillClearsItsSlotTest =
    init.then(oldFailure).expect(not(pending))
}

module late_join_serve_failure_before {
  import late_join_serve_failure(FENCE_FAILURE = false).*
}

module late_join_serve_failure_fixed {
  import late_join_serve_failure(FENCE_FAILURE = true).*
}
