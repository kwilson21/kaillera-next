// -*- mode: Bluespec; -*-
//
// A guest dropped as a phantom comes back (PEER-RECOVERED), in a match of
// three or more: does every other guest (a "bystander") end up having run
// that guest's frames on the same inputs as the host?
// (web/static/netplay-rollback.js: _processInputPacket's PEER-RECOVERED,
// _settleInputsBefore, _drainPendingCInputs, _onPastWindowMismatch, the
// rollback input stall, _dispatchScheduledSyncs; build/kn_rollback
// kn_feed_input's rollback cap, DEEP-MISPREDICT-SKIP.)
//
// While the guest (the "mover") is a phantom, every page runs its frames on
// predictions. Its real inputs can still arrive late, at each page at a
// different time: one inside that page's rollback window is applied (the
// page rolls back); one past it is not (DEEP-MISPREDICT-SKIP), and when it
// differs from the prediction the page escalates (a guest asks the host for
// a resync, the host pushes its state to every guest).
//
// On PEER-RECOVERED the host settles the mover's inputs from before its own
// frame minus the delay (_settleInputsBefore): it never hands them to its
// engine again, keeps what it predicted for them, and schedules a resync for
// the mover alone. A bystander settles nothing then: it goes on handing the
// mover's late inputs to its engine until the mover, moved by that resync,
// tells it where its inputs start again (`inputs-settled:`). So a late input
// the host settled can land inside the bystander's window: the bystander
// rolls back and runs the frame on the real input, the host keeps its
// prediction, and nothing compares them again (only the opt-in desync
// detector, RB-CHECK). It needs every input of the mover that came past the
// bystander's window to match the prediction (or the bystander escalates and
// is resynced, bystanderEscalatesTest) and one inside it not to: a player
// who held still while frozen and moved as they came back (BROADCAST false:
// hostAndBystanderAgree VIOLATED, bystanderAppliesWhatTheHostSettledTest).
//
// The bystander need not have dropped the mover at all. When only the host
// stops hearing it (its inputs held up on the way to the host alone), the
// bystander runs every frame on the mover's real inputs, the host on
// predictions, and on PEER-RECOVERED the host settles the whole backlog:
// nothing anywhere differs from a prediction, nothing escalates
// (onlyTheHostDroppedItTest; the sampler's first counterexample). That is
// the ordering tests/rb-mesh.mjs RECOVERY_BYSTANDER=1 drives on the real
// ROM, where the bystander stays split from the host for the rest of the
// match. Its gameplay and game-state hashes never show it: they leave out
// the RDRAM blocks the fighters live in (the run compares RDRAM page by
// page instead), which is why earlier four-player runs looked clean.
//
// The same holds for every input the bystander settles on the mover's word
// alone (`inputs-settled:` from a state the bystander never loads): it keeps
// whatever it ran those frames on, predictions included, and its predictions
// are its own (the newest input its engine was handed for the mover).
//
// The fix (BROADCAST): the resync the host schedules on PEER-RECOVERED goes
// to every guest, as one capture, and the follow-ups the host owes for it
// (a state taken while an input was still predicted that later changed,
// specs/sync_follow_up.qnt) go to every guest that got it. A bystander then
// loads the host's state taken at or after the host settled the mover's
// inputs, so whatever it had run those frames on is replaced; and every
// `inputs-settled:` the mover sends is for a state the bystander loads too.
//
// That is not enough when inputs are lost (LOSSY: the unreliable input
// channel; a page asks again only for an input inside its window, while it
// waits on it). A bystander that still holds the mover as a phantom when the
// broadcast lands runs on predictions after it; the mover's inputs for those
// frames can be lost, and once the bystander hears the mover again they are
// behind its window: never asked for, never compared
// (bystanderStillPhantomTest; ASK_ON_RECOVERY false: VIOLATED). So a guest
// that hears again from any player it held as a phantom asks the host for a
// resync, as it already does when that player is the host (ASK_ON_RECOVERY).
//
// The reconnect path splits the same way (RECONNECT_BROADCAST). The channel
// between the host and the mover dies while the mover's channel to the
// bystander stays up: the host stops hearing the mover, stalls, drops it as a
// phantom and runs its frames on predictions; the bystander runs them on the
// mover's real inputs, which never reach the host (the channel they were on
// is gone). The channel is healed (_meshHealthTick, specs/mesh_heal.qnt; or
// its close event and attemptReconnect): the host resets its entry for the
// mover (resetPeerState: the phantom flag goes, so no PEER-RECOVERED follows
// and recoveryStep never runs), and the mover, whose entry was reconnecting,
// asks the host for an immediate resync from the channel's open handler
// (`sync-request-full`). Before the fix the host answered the mover alone
// (_answerDirectSyncRequest). The mover loads the host's state and tells the
// bystander where its inputs start again (`inputs-settled:`); the bystander
// settles them and keeps what it ran, the mover's real inputs, where the host
// ran predictions: hostAndBystanderAgree VIOLATED
// (recovery_bystander_reconnect_before; reconnectBystanderTest). Nothing on
// the bystander can notice: it never predicted those inputs, so none of them
// differs from a prediction, and it never held the mover as a phantom.
//
// The fix (RECONNECT_BROADCAST): the host's answer to the first resync
// request from a player whose channel it reset for a reconnect goes to every
// guest, as one capture (web/src/recovery-resync.ts, syncRequestAnswer:
// `resync-guests`), as the PEER-RECOVERED resync does; its follow-ups go
// wherever it went.
//
// What is modelled: the host, the mover and one bystander; the mover's
// inputs (keyed by the frame they were made on, applied DELAY frames later,
// each 0 or 1), on their way to each page in any order, possibly lost
// (LOSSY), asked for again by a page waiting on one inside its window; each
// page's frame, rollback window (CAP), the inputs its engine holds, what it
// ran each frame on, its prediction (repeat the newest input it was handed),
// its settled point, and whether it holds the mover as a phantom; the
// window-edge stall (a page that does not hold the mover as a phantom does
// not run a frame whose window edge lacks the mover's input) and the two
// pages pacing each other; the mover freezing (once) and coming back; the
// host's and the bystander's PEER-RECOVERED; the host's states (taken at its
// frame, delivered in order) and their follow-ups; the bystander's resync
// request and the host's answer; each page's escalation on a late input past
// its window that differs from its prediction; the mover's `inputs-settled:`
// and the inputs it sends again when it lands a state; the channel between
// the host and the mover dying once (the mover's inputs on it lost, none
// sent on it, no state landing over it) and healed: the host's reset of the
// mover's entry (it forgets the mover's inputs and any state it owed or was
// sending it), the mover's immediate request, and the host's answer.
//
// Not modelled: the host's and the bystander's own inputs (the mover always
// has them: it never holds them as phantoms, and never asks for a resync of
// its own); more than one bystander; the follow-ups' bound
// (SYNC_FOLLOW_UP_MAX) and every deadline (the host takes a state when it
// likes: confirmed, or at its deadline); who heals the channel and how
// (specs/mesh_heal.qnt, specs/peer_connection.qnt); the mover's own view of
// the host while the channel is down (it holds the host's inputs, as
// everywhere here: on the real page it predicts the host too, and the host's
// state replaces that); a channel to the bystander dying; a dispatch that leaves out a
// guest it owes (an unreachable channel). The mover's inputs that are never
// made (moved over by a resync) are settled everywhere by `inputs-settled:`
// (specs/resync_mesh.qnt).
//
// BROADCAST: the host's PEER-RECOVERED resync goes to every guest, and a
//   dispatch sends one capture to every guest it owes. false = before the
//   fix: to the mover alone.
// ASK_ON_RECOVERY: a guest asks the host for a resync when it hears again
//   from any player it held as a phantom. false = before the fix: only from
//   the host.
// LOSSY: inputs can be lost on the way.
// RECONNECT_BROADCAST: the host's answer to the first resync request after it
//   reset a reconnected player's entry goes to every guest. false = before
//   the fix: to the player that asked alone.
module recovery_bystander {
  const BROADCAST: bool
  const ASK_ON_RECOVERY: bool
  const LOSSY: bool
  const RECONNECT_BROADCAST: bool

  pure val DELAY = 1
  pure val CAP = 2
  pure val LAST = 14
  pure val KEYS = 0.to(LAST)

  pure val PAGES = Set("host", "bystander")
  pure val GUESTS = Set("bystander", "mover")
  pure def other(p: str): str = if (p == "host") "bystander" else "host"
  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def getOr(m: int -> int, k: int, d: int): int = if (m.keys().contains(k)) m.get(k) else d

  type Packet = Input(int) | Settled(int)

  type Page = {
    frame: int,         // the next frame to run
    got: Set[int],      // keys of the mover's inputs its engine holds
    used: int -> int,   // what it ran the mover's input keyed k on (k < frame - DELAY)
    pred: Set[int],     // of those, the ones run on a prediction not yet checked
    last: int,          // the newest key its engine was handed (-1: none)
    lastVal: int,       // that input's value: the prediction
    newest: int,        // the newest key it has received
    floor: int,         // settled point: inputs keyed below it are never handed to its engine
    phantom: bool,      // holds the mover as a phantom
  }

  type State = { frame: int, snap: int -> int }

  var pg: str -> Page
  var mFrame: int            // the mover's next frame
  var made: int -> int       // the mover's inputs, by key: made once, never changed
  var frozen: bool
  var froze: bool
  var wire: str -> Set[Packet]   // on their way to the host and to the bystander
  var owed: Set[str]             // guests the host owes a state
  var watch: str -> int          // frame of the newest state sent to each guest (-1: none)
  var queue: str -> List[State]  // states on their way to each guest, in order
  var asked: bool                // the bystander's request, not answered yet
  var waiting: bool              // the bystander has a request in flight
  var linkDown: bool             // the channel between the host and the mover is dead
  var linkDied: bool             // it has died (once)
  var reconnectAsked: bool       // the mover's request after the heal, not answered yet

  // ── what a page runs on ────────────────────────────────────────────────

  pure def edge(p: Page): int = p.frame - DELAY - CAP

  // The rollback input stall: the input at the window edge is missing.
  pure def blocked(p: Page): bool = and {
    not(p.phantom),
    edge(p) >= 0,
    edge(p) >= p.floor,
    not(p.got.contains(edge(p))),
  }

  def runFrame(p: Page): Page = {
    val j = p.frame - DELAY
    if (j < 0) { ...p, frame: p.frame + 1 }
    else if (p.got.contains(j)) { ...p, frame: p.frame + 1, used: p.used.put(j, made.get(j)) }
    else { ...p, frame: p.frame + 1, used: p.used.put(j, p.lastVal), pred: p.pred.union(Set(j)) }
  }

  // kn_feed_input: hand the engine the input keyed k. A prediction it
  // replaces that differs is rolled back inside the window (the predicted
  // inputs after it are guessed again from the newest) and skipped past it
  // (deep: the page escalates). Returns the page, whether it was deep, and
  // which keys' values changed.
  def feed(p: Page, k: int): { page: Page, deep: bool, changed: Set[int] } =
    if (k < p.floor or p.got.contains(k)) { page: p, deep: false, changed: Set() }
    else {
      val v = made.get(k)
      val newer = k > p.last
      val lastVal2 = if (newer) v else p.lastVal
      val base = { ...p, got: p.got.union(Set(k)), last: if (newer) k else p.last, lastVal: lastVal2 }
      if (not(p.pred.contains(k)))
        { page: base, deep: false, changed: Set() }
      else if (p.used.get(k) == v)
        { page: { ...base, pred: p.pred.exclude(Set(k)) }, deep: false, changed: Set() }
      else if (p.frame - (k + DELAY) > CAP)
        { page: { ...base, pred: p.pred.exclude(Set(k)) }, deep: true, changed: Set() }
      else {
        val again = p.pred.filter(j => j > k)
        val used2 = p.used.keys().mapBy(j =>
          if (j == k) v else if (again.contains(j)) lastVal2 else p.used.get(j))
        {
          page: { ...base, pred: p.pred.exclude(Set(k)), used: used2 },
          deep: false,
          changed: Set(k).union(again.filter(j => p.used.get(j) != lastVal2)),
        }
      }
    }

  // ── actions ────────────────────────────────────────────────────────────

  pure val freshPage: Page = {
    frame: 0, got: Set(), used: Map(), pred: Set(), last: -1, lastVal: 0, newest: -1, floor: 0, phantom: false,
  }

  action init = all {
    pg' = PAGES.mapBy(_ => freshPage),
    mFrame' = 0, made' = Map(), frozen' = false, froze' = false,
    wire' = PAGES.mapBy(_ => Set()),
    owed' = Set(), watch' = GUESTS.mapBy(_ => -1), queue' = GUESTS.mapBy(_ => List()),
    asked' = false, waiting' = false,
    linkDown' = false, linkDied' = false, reconnectAsked' = false,
  }

  action keepHostSide = all {
    owed' = owed, watch' = watch, queue' = queue, asked' = asked, waiting' = waiting, reconnectAsked' = reconnectAsked,
  }
  action keepLink = all { linkDown' = linkDown, linkDied' = linkDied }
  action keepMover = all { mFrame' = mFrame, made' = made, frozen' = frozen, froze' = froze, keepLink }

  // A page runs a frame: it paces the other page, and stalls at the window
  // edge on the mover unless it holds it as a phantom.
  action tick(name: str): bool = {
    val p = pg.get(name)
    all {
      p.frame < LAST,
      edge(p) < pg.get(other(name)).frame,
      not(blocked(p)),
      pg' = pg.set(name, runFrame(p)),
      wire' = wire, keepMover, keepHostSide,
    }
  }

  // A page that has waited on the mover for 5 s drops it as a phantom.
  action markPhantom(name: str): bool = all {
    blocked(pg.get(name)),
    pg' = pg.set(name, { ...pg.get(name), phantom: true }),
    wire' = wire, keepMover, keepHostSide,
  }

  // The mover runs a frame and sends its input to both pages. It holds both
  // pages' inputs up to its window edge (it never drops them as phantoms).
  action moverTick(v: int): bool = all {
    not(frozen),
    mFrame < LAST,
    mFrame - DELAY - CAP < pg.get("host").frame,
    mFrame - DELAY - CAP < pg.get("bystander").frame,
    mFrame' = mFrame + 1,
    made' = if (made.keys().contains(mFrame)) made else made.put(mFrame, v),
    // Nothing goes on a dead channel.
    wire' = PAGES.mapBy(n =>
      if (n == "host" and linkDown) wire.get(n) else wire.get(n).union(Set(Input(mFrame)))),
    frozen' = frozen, froze' = froze, keepLink,
    pg' = pg, keepHostSide,
  }

  action moverFreeze = all {
    not(froze),
    frozen' = true, froze' = true,
    mFrame' = mFrame, made' = made, keepLink, pg' = pg, wire' = wire, keepHostSide,
  }

  action moverResume = all {
    frozen,
    frozen' = false,
    froze' = froze, mFrame' = mFrame, made' = made, keepLink, pg' = pg, wire' = wire, keepHostSide,
  }

  // The guests a host's state goes to: its follow-ups go wherever the state
  // they follow went.
  def followUpsFor(changed: Set[int]): Set[str] =
    GUESTS.filter(g => watch.get(g) >= 0 and changed.exists(j => j < watch.get(g) - DELAY))

  val RECOVERY_TARGETS = if (BROADCAST) GUESTS else Set("mover")

  // An input of the mover reaches a page. A newer one than it has, while it
  // holds the mover as a phantom, is PEER-RECOVERED: the host settles the
  // mover's inputs before its frame minus the delay and owes a resync; the
  // bystander (ASK_ON_RECOVERY) asks for one.
  action deliverInput(name: str, k: int): bool = {
    val p0 = pg.get(name)
    val recovering = p0.phantom and k > p0.newest
    val p1 = {
      ...p0,
      newest: max(p0.newest, k),
      phantom: if (recovering) false else p0.phantom,
      floor: if (recovering and name == "host") max(p0.floor, p0.frame - DELAY) else p0.floor,
    }
    val r = feed(p1, k)
    val bystanderAsks = name == "bystander" and (r.deep or (recovering and ASK_ON_RECOVERY)) and not(waiting)
    all {
      wire.get(name).contains(Input(k)),
      wire' = wire.set(name, wire.get(name).exclude(Set(Input(k)))),
      pg' = pg.set(name, r.page),
      owed' = if (name != "host") owed else owed
        .union(if (recovering) RECOVERY_TARGETS else Set())
        .union(if (r.deep) GUESTS else Set())
        .union(followUpsFor(r.changed)),
      asked' = (asked or bystanderAsks),
      waiting' = (waiting or bystanderAsks),
      watch' = watch, queue' = queue, reconnectAsked' = reconnectAsked, keepMover,
    }
  }

  action deliverSettled(name: str, s: int): bool = all {
    wire.get(name).contains(Settled(s)),
    wire' = wire.set(name, wire.get(name).exclude(Set(Settled(s)))),
    pg' = pg.set(name, { ...pg.get(name), floor: max(pg.get(name).floor, s) }),
    keepMover, keepHostSide,
  }

  // The unreliable input channel loses an input.
  action lose(name: str, k: int): bool = all {
    LOSSY,
    wire.get(name).contains(Input(k)),
    wire' = wire.set(name, wire.get(name).exclude(Set(Input(k)))),
    pg' = pg, keepMover, keepHostSide,
  }

  // A page waiting inside its window on an input the mover has made (it has
  // a newer one) asks for it again (`resend:`).
  action ask(name: str, k: int): bool = {
    val p = pg.get(name)
    all {
      not(p.phantom),
      not(name == "host" and linkDown),
      made.keys().contains(k),
      k <= p.newest,
      k >= p.floor,
      k >= edge(p),
      k <= p.frame - DELAY,
      not(p.got.contains(k)),
      not(wire.get(name).contains(Input(k))),
      wire' = wire.set(name, wire.get(name).union(Set(Input(k)))),
      pg' = pg, keepMover, keepHostSide,
    }
  }

  def capture: State = {
    val t = pg.get("host").frame
    { frame: t, snap: pg.get("host").used.keys().filter(j => j < t - DELAY).mapBy(j => pg.get("host").used.get(j)) }
  }

  // The host takes its state now and sends it to every guest it owes one.
  action hostDispatch = all {
    owed != Set(),
    queue' = GUESTS.mapBy(g => if (owed.contains(g)) queue.get(g).append(capture) else queue.get(g)),
    watch' = GUESTS.mapBy(g => if (owed.contains(g)) capture.frame else watch.get(g)),
    owed' = Set(),
    asked' = asked, waiting' = waiting, reconnectAsked' = reconnectAsked,
    pg' = pg, wire' = wire, keepMover,
  }

  // The host answers the bystander's request at once, with its state now.
  action hostAnswer = all {
    asked,
    asked' = false,
    queue' = queue.set("bystander", queue.get("bystander").append(capture)),
    watch' = watch.set("bystander", capture.frame),
    owed' = owed, waiting' = waiting, reconnectAsked' = reconnectAsked,
    pg' = pg, wire' = wire, keepMover,
  }

  // The bystander loads a state: its frame is the host's, what it ran
  // before it is the host's, and the inputs before it minus the delay are
  // settled (_settleInputsAtResync).
  action bystanderLoads(s: State): bool = {
    val p = pg.get("bystander")
    all {
      queue' = queue.set("bystander", queue.get("bystander").tail()),
      pg' = pg.set("bystander", { ...p, frame: s.frame, used: s.snap, pred: Set(), floor: max(p.floor, s.frame - DELAY) }),
      waiting' = false,
      owed' = owed, watch' = watch, asked' = asked, reconnectAsked' = reconnectAsked,
      wire' = wire, keepMover,
    }
  }
  action bystanderLands = all {
    queue.get("bystander").length() > 0,
    bystanderLoads(queue.get("bystander").head()),
  }

  // The mover loads a state: it makes (neutral) the inputs it never made
  // from the state's frame minus the delay on, and tells every page where
  // its inputs start again, sending that range's inputs again.
  action moverLoads(s: State): bool = {
    val from = max(0, s.frame - DELAY)
    val resent = from.to(s.frame - 1)
    all {
      queue' = queue.set("mover", queue.get("mover").tail()),
      mFrame' = s.frame,
      made' = resent.fold(made, (m, k) => if (m.keys().contains(k)) m else m.put(k, 0)),
      wire' = PAGES.mapBy(n => wire.get(n).union(Set(Settled(from))).union(resent.map(k => Input(k)))),
      frozen' = frozen, froze' = froze, keepLink,
      owed' = owed, watch' = watch, asked' = asked, waiting' = waiting, reconnectAsked' = reconnectAsked,
      pg' = pg,
    }
  }
  action moverLands = all {
    not(frozen),
    not(linkDown),
    queue.get("mover").length() > 0,
    moverLoads(queue.get("mover").head()),
  }

  // The channel between the host and the mover dies: what was on its way to
  // the host on it is lost, and nothing more goes on it. The mover's channel
  // to the bystander stays up.
  action linkDies = all {
    not(linkDied),
    linkDown' = true, linkDied' = true,
    wire' = wire.set("host", Set()),
    mFrame' = mFrame, made' = made, frozen' = frozen, froze' = froze,
    pg' = pg, keepHostSide,
  }

  // The channel is healed. The host resets its entry for the mover
  // (resetPeerState): the phantom flag, the inputs it holds for it and its
  // newest frame go, and so does any state it owed or was sending it (the
  // scheduled requests for that player and its transfer chain). The mover's
  // entry was reconnecting: its channel's open handler asks the host for a
  // resync at once (`sync-request-full`).
  action heal = {
    val h = pg.get("host")
    all {
      linkDown,
      linkDown' = false, linkDied' = linkDied,
      pg' = pg.set("host", { ...h, phantom: false, got: Set(), newest: -1 }),
      owed' = owed.exclude(Set("mover")),
      queue' = queue.set("mover", List()),
      watch' = watch.set("mover", -1),
      reconnectAsked' = true,
      asked' = asked, waiting' = waiting,
      wire' = wire, mFrame' = mFrame, made' = made, frozen' = frozen, froze' = froze,
    }
  }

  val RECONNECT_TARGETS = if (RECONNECT_BROADCAST) GUESTS else Set("mover")

  // The host answers the mover's request with its state now: to the mover
  // alone (_answerDirectSyncRequest), or (RECONNECT_BROADCAST) one capture to
  // every guest.
  action hostAnswerReconnect = all {
    reconnectAsked,
    reconnectAsked' = false,
    queue' = GUESTS.mapBy(g =>
      if (RECONNECT_TARGETS.contains(g)) queue.get(g).append(capture) else queue.get(g)),
    watch' = GUESTS.mapBy(g => if (RECONNECT_TARGETS.contains(g)) capture.frame else watch.get(g)),
    owed' = owed, asked' = asked, waiting' = waiting,
    pg' = pg, wire' = wire, keepMover,
  }

  // Nothing happens (a scenario step that only some variants take).
  action idle = all { pg' = pg, wire' = wire, keepMover, keepHostSide }

  action step = any {
    nondet v = Set(0, 1).oneOf()
    moverTick(v),
    moverFreeze,
    moverResume,
    nondet name = PAGES.oneOf()
    nondet k = KEYS.oneOf()
    any {
      tick(name),
      markPhantom(name),
      deliverInput(name, k),
      deliverSettled(name, k),
      lose(name, k),
      ask(name, k),
    },
    hostDispatch,
    hostAnswer,
    bystanderLands,
    moverLands,
    linkDies,
    heal,
    hostAnswerReconnect,
  }

  // ── properties ─────────────────────────────────────────────────────────

  // The page will not change what it ran the input keyed k on by itself:
  // settled, or past its rollback window.
  pure def final(p: Page, k: int): bool = and {
    k < p.frame - DELAY,
    k < p.floor or k < edge(p),
  }

  // Something on its way can still change what the bystander ran k on: a
  // state the host owes it, is sending or will send it in answer; a late
  // input either page will find differs from its prediction (inside the
  // window it rolls back, past it it escalates); an input the mover has yet
  // to make.
  def mayStillChange(k: int): bool = {
    val h = pg.get("host")
    val b = pg.get("bystander")
    or {
      owed.contains("bystander"),
      queue.get("bystander").length() > 0,
      asked,
      waiting,
      reconnectAsked,
      and {
        wire.get("bystander").contains(Input(k)), k >= b.floor, b.pred.contains(k),
        getOr(made, k, -1) != getOr(b.used, k, -1),
      },
      and {
        wire.get("host").contains(Input(k)), k >= h.floor, h.pred.contains(k),
        getOr(made, k, -1) != getOr(h.used, k, -1),
      },
      and { not(made.keys().contains(k)), k >= mFrame },
    }
  }

  // Once neither page holds the mover as a phantom, the host and the
  // bystander ran every frame both have finished with on the same input of
  // the mover. Violated before the fix (BROADCAST false); with inputs lost,
  // violated too while a guest asks only when it hears from the host again
  // (ASK_ON_RECOVERY false).
  val hostAndBystanderAgree = {
    val h = pg.get("host")
    val b = pg.get("bystander")
    (not(h.phantom) and not(b.phantom)) implies
      KEYS.forall(k =>
        (final(h, k) and final(b, k) and not(mayStillChange(k))) implies getOr(h.used, k, -1) == getOr(b.used, k, -1))
  }

  val allHold = hostAndBystanderAgree

  // ── scenarios ──────────────────────────────────────────────────────────

  // The mover landed a state at frame 8: both pages get its settled point
  // (7) and its input 7 again.
  run settledAndResent =
    deliverSettled("host", 7).then(deliverInput("host", 7))
      .then(deliverSettled("bystander", 7)).then(deliverInput("bystander", 7))

  // The mover makes inputs 0 and 1 (neutral) and freezes. Both pages run on
  // to their window edge, drop it as a phantom, and run on alone to frame 8.
  run frozenMoverTest =
    init
      .then(moverTick(0)).then(moverTick(0))
      .then(deliverInput("host", 0)).then(deliverInput("host", 1))
      .then(deliverInput("bystander", 0)).then(deliverInput("bystander", 1))
      .then(moverFreeze)
      .then(5.reps(_ => tick("host").then(tick("bystander"))))
      .expect(blocked(pg.get("host")) and blocked(pg.get("bystander")))
      .then(markPhantom("host")).then(markPhantom("bystander"))
      .then(3.reps(_ => tick("host").then(tick("bystander"))))
      .expect(pg.get("host").frame == 8 and pg.get("bystander").frame == 8)

  // The mover comes back. Inputs 2 to 4 are neutral, as predicted; 5 and 6
  // are not. The host hears input 2 first (PEER-RECOVERED at frame 8: inputs
  // before 7 settled) and hands none of them to its engine. At the
  // bystander, 2 to 4 are past its window and match; 5 and 6 are inside it
  // (frame 8, delay 1, window 2): it rolls back and runs them as made.
  run bystanderAppliesWhatTheHostSettledTest =
    frozenMoverTest
      .then(moverResume)
      .then(moverTick(0)).then(moverTick(0)).then(moverTick(0)).then(moverTick(1)).then(moverTick(1))
      .then(deliverInput("host", 2))
      .expect(pg.get("host").floor == 7 and owed == RECOVERY_TARGETS)
      .then(deliverInput("host", 3)).then(deliverInput("host", 4))
      .then(deliverInput("host", 5)).then(deliverInput("host", 6))
      .then(deliverInput("bystander", 2)).then(deliverInput("bystander", 3)).then(deliverInput("bystander", 4))
      .then(deliverInput("bystander", 5)).then(deliverInput("bystander", 6))
      .expect(pg.get("host").used.get(5) == 0 and pg.get("bystander").used.get(5) == 1)
      .expect(not(asked) == not(ASK_ON_RECOVERY))
      // The host sends its state; the mover lands it and tells both pages.
      .then(hostDispatch)
      .then(moverLands)
      .then(if (BROADCAST) bystanderLands else idle)
      .then(if (ASK_ON_RECOVERY) hostAnswer.then(bystanderLands) else idle)
      .then(settledAndResent)
      .expect(hostAndBystanderAgree == BROADCAST)

  // Only the host drops the mover: its inputs from 2 on are held on the way
  // to the host alone, while the bystander gets each one in time and runs
  // its frames on them. The host runs them on predictions, drops the mover at
  // its window edge, and runs on. When the held inputs reach it, the first is
  // PEER-RECOVERED: all of them are settled, none is handed to its engine,
  // and nothing anywhere differs from a prediction. The first counterexample
  // the sampler finds; the fault tests/rb-mesh.mjs (RECOVERY_BYSTANDER=1)
  // drives on the real ROM.
  run onlyTheHostDroppedItTest =
    init
      .then(moverTick(0)).then(moverTick(0))
      .then(deliverInput("host", 0)).then(deliverInput("host", 1))
      .then(deliverInput("bystander", 0)).then(deliverInput("bystander", 1))
      .then(3.reps(_ => tick("host").then(tick("bystander"))))
      .then(moverTick(1)).then(moverTick(1)).then(moverTick(1))
      .then(deliverInput("bystander", 2)).then(deliverInput("bystander", 3)).then(deliverInput("bystander", 4))
      .then(2.reps(_ => tick("host").then(tick("bystander"))))
      .expect(blocked(pg.get("host")) and not(blocked(pg.get("bystander"))))
      .then(markPhantom("host"))
      .then(tick("host")).then(tick("bystander"))
      .then(moverTick(1)).then(deliverInput("bystander", 5))
      .then(tick("host")).then(tick("bystander"))
      .then(moverTick(1)).then(deliverInput("bystander", 6))
      .then(tick("host")).then(tick("bystander"))
      .expect(pg.get("host").frame == 8 and pg.get("bystander").frame == 8)
      // The held inputs reach the host.
      .then(deliverInput("host", 2))
      .expect(pg.get("host").floor == 7 and not(pg.get("host").phantom))
      .then(deliverInput("host", 3)).then(deliverInput("host", 4))
      .then(deliverInput("host", 5)).then(deliverInput("host", 6))
      .expect(getOr(pg.get("host").used, 4, -1) == 0 and getOr(pg.get("bystander").used, 4, -1) == 1)
      .then(hostDispatch)
      .then(moverLands)
      .then(if (BROADCAST) bystanderLands else idle)
      .then(settledAndResent)
      .expect(hostAndBystanderAgree == BROADCAST)

  // The reconnect path. As in onlyTheHostDroppedItTest the host stops
  // hearing the mover while the bystander hears it all along, but because
  // the channel between them dies: the mover's inputs from 2 on are lost on
  // it, never resent. The host drops the mover, runs its frames on
  // predictions (neutral) to frame 8, and the bystander runs them on the
  // mover's real inputs (walking). The channel is healed: the host resets its
  // entry (no PEER-RECOVERED follows) and the mover asks for a resync. The
  // host answers it; the mover lands the state at 8 and tells both pages its
  // inputs start again at 7. The bystander settles them, and keeps what it
  // ran, unless the answer went to it too (RECONNECT_BROADCAST). The ordering
  // tests/rb-mesh.mjs RECOVERY_BYSTANDER=1 RECOVERY_MODE=reconnect drives on
  // the real ROM.
  run reconnectBystanderTest =
    init
      .then(moverTick(0)).then(moverTick(0))
      .then(deliverInput("host", 0)).then(deliverInput("host", 1))
      .then(deliverInput("bystander", 0)).then(deliverInput("bystander", 1))
      .then(3.reps(_ => tick("host").then(tick("bystander"))))
      .then(linkDies)
      .then(moverTick(1)).then(moverTick(1)).then(moverTick(1))
      .expect(wire.get("host") == Set())
      .then(deliverInput("bystander", 2)).then(deliverInput("bystander", 3)).then(deliverInput("bystander", 4))
      .then(2.reps(_ => tick("host").then(tick("bystander"))))
      .expect(blocked(pg.get("host")) and not(blocked(pg.get("bystander"))))
      .then(markPhantom("host"))
      .then(tick("host")).then(tick("bystander"))
      .then(moverTick(1)).then(deliverInput("bystander", 5))
      .then(tick("host")).then(tick("bystander"))
      .then(moverTick(1)).then(deliverInput("bystander", 6))
      .then(tick("host")).then(tick("bystander"))
      .expect(pg.get("host").frame == 8 and pg.get("bystander").frame == 8)
      .then(heal)
      .expect(not(pg.get("host").phantom) and reconnectAsked and owed == Set())
      .then(hostAnswerReconnect)
      .expect(queue.get("bystander").length() == (if (RECONNECT_BROADCAST) 1 else 0))
      .then(moverLands)
      .then(if (RECONNECT_BROADCAST) bystanderLands else idle)
      .then(settledAndResent)
      .expect(getOr(pg.get("host").used, 4, -1) == 0)
      .expect(getOr(pg.get("bystander").used, 4, -1) == (if (RECONNECT_BROADCAST) 0 else 1))
      .expect(hostAndBystanderAgree == RECONNECT_BROADCAST)

  // The same, but an input past the bystander's window differs (input 4):
  // the bystander escalates, asks for a resync, and lands the host's state.
  // Before the fix its only way back, and the one random inputs nearly
  // always take after a freeze both pages saw.
  run bystanderEscalatesTest =
    frozenMoverTest
      .then(moverResume)
      .then(moverTick(0)).then(moverTick(0)).then(moverTick(1)).then(moverTick(1)).then(moverTick(1))
      .then(deliverInput("host", 2)).then(deliverInput("host", 3)).then(deliverInput("host", 4))
      .then(deliverInput("host", 5)).then(deliverInput("host", 6))
      .then(deliverInput("bystander", 2)).then(deliverInput("bystander", 3)).then(deliverInput("bystander", 4))
      .expect(asked)
      .then(deliverInput("bystander", 5)).then(deliverInput("bystander", 6))
      .then(hostAnswer).then(bystanderLands)
      .then(hostDispatch).then(moverLands)
      .then(if (BROADCAST) bystanderLands else idle)
      .then(settledAndResent)
      .expect(hostAndBystanderAgree)

  // Inputs lost. The host hears the mover again; the bystander hears
  // nothing of it (its inputs 2 to 8 are lost on the way), so it still holds
  // the mover as a phantom when the broadcast lands, and runs on predictions
  // after it. The mover plays input 8 (not neutral): the host runs it, the
  // bystander predicts it. The bystander hears the mover again on input 10,
  // at frame 12: 8 is behind its window by then, never asked for, never
  // compared. With ASK_ON_RECOVERY it asks the host for its state, and lands
  // the host's frame 8 run on the real input.
  run bystanderStillPhantomTest =
    if (LOSSY)
      frozenMoverTest
        .then(moverResume)
        .then(5.reps(_ => moverTick(0)))
        .then(deliverInput("host", 2))
        .then(deliverInput("host", 3)).then(deliverInput("host", 4))
        .then(deliverInput("host", 5)).then(deliverInput("host", 6))
        .then(lose("bystander", 2)).then(lose("bystander", 3)).then(lose("bystander", 4))
        .then(lose("bystander", 5)).then(lose("bystander", 6))
        .then(hostDispatch)
        .then(moverLands)
        .then(if (BROADCAST) bystanderLands else idle)
        .then(deliverSettled("host", 7)).then(deliverInput("host", 7))
        .then(deliverSettled("bystander", 7)).then(lose("bystander", 7))
        .expect(pg.get("bystander").phantom and pg.get("bystander").frame == 8)
        .then(tick("host")).then(tick("bystander"))
        .then(moverTick(1)).then(deliverInput("host", 8)).then(lose("bystander", 8))
        .then(tick("host")).then(tick("bystander"))
        .then(moverTick(1)).then(deliverInput("host", 9)).then(lose("bystander", 9))
        .then(tick("host")).then(tick("bystander"))
        .then(moverTick(1)).then(deliverInput("host", 10))
        .then(tick("host")).then(tick("bystander"))
        .expect(pg.get("host").frame == 12 and pg.get("bystander").frame == 12)
        .then(deliverInput("bystander", 10))
        .expect(not(pg.get("bystander").phantom) and asked == ASK_ON_RECOVERY)
        .expect(getOr(pg.get("host").used, 8, -1) == 1 and getOr(pg.get("bystander").used, 8, -1) == 0)
        .expect(hostAndBystanderAgree == ASK_ON_RECOVERY)
        .then(if (ASK_ON_RECOVERY) hostAnswer.then(bystanderLands) else idle)
        .expect(hostAndBystanderAgree == ASK_ON_RECOVERY)
    else
      init
}

// Before the fix: the host's PEER-RECOVERED resync went to the mover alone,
// and a guest asked for one only when it heard from the host again.
module recovery_bystander_before {
  import recovery_bystander(BROADCAST = false, ASK_ON_RECOVERY = false, LOSSY = true, RECONNECT_BROADCAST = false).*
}

// PR #318's fix, before the reconnect fix: the host's answer to the
// reconnected player's resync request went to that player alone
// (reconnectBystanderTest).
module recovery_bystander_reconnect_before {
  import recovery_bystander(BROADCAST = true, ASK_ON_RECOVERY = true, LOSSY = true, RECONNECT_BROADCAST = false).*
}

// The resync goes to every guest, but a bystander that still held the mover
// as a phantom asks for nothing when it hears from it again.
module recovery_bystander_broadcast_only {
  import recovery_bystander(BROADCAST = true, ASK_ON_RECOVERY = false, LOSSY = true, RECONNECT_BROADCAST = true).*
}

// The broadcast alone, with no input ever lost: enough.
module recovery_bystander_broadcast_lossless {
  import recovery_bystander(BROADCAST = true, ASK_ON_RECOVERY = false, LOSSY = false, RECONNECT_BROADCAST = true).*
}

// The fix (web/src/recovery-resync.ts: recoveryStep, syncRequestAnswer).
module recovery_bystander_fixed {
  import recovery_bystander(BROADCAST = true, ASK_ON_RECOVERY = true, LOSSY = true, RECONNECT_BROADCAST = true).*
}
