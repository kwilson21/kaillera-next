// -*- mode: Bluespec; -*-
//
// A phantom's recovery in a match of three or more: the host settles the
// phantom's inputs, and the other guests must end on the same values.
// web/static/netplay-rollback.js, the host's PEER-RECOVERED branch
// (_settleInputsBefore, the peer-recovery resync) and the guest's apply of a
// host state.
//
// Guest P stops sending for long enough to be made a phantom (a frozen page).
// The host and guest B run on predictions of P's input. When P is heard from
// again, the host settles P's inputs before the recovery frame F
// (_settleInputsBefore): its predictions for them are final, and P's real
// inputs for those frames, if they ever reach it, are never fed. It resyncs
// P to its state. Guest B is a third page: P's real inputs before F can
// still reach it, within its rollback window, and B rolls back to them. B
// then holds P's real input where the host holds its prediction: two values
// for one frame of one player, and nothing corrects it (found in an rb-mesh
// FOLLOW_UP_RECIPIENT run on 3470285, 2026-11: P3 rolled back to P2's real
// [1,50,0] at 1084..1086, the host kept its prediction [0,-70,0] and
// settled before 1092; full-state hashes differed on 389 frames, and
// KNDesync flagged ft_buffer every 60 frames from 1092).
//
// The guest cannot see this: B's rollback to P's real input was in window and
// clean. Only the host knows it settled a prediction. So the fix is the
// host's:
//
// RESYNC_ALL: on a phantom's recovery the host sends its state to every
//   guest, not only to the phantom. A guest that applies a host state at F
//   settles every remote input before F as the host's (it starts from that
//   state), so P's real inputs arriving at B afterwards change nothing.
//
// SEND_SETTLED: the host sends the other guests the values it settled, and a
//   guest overwrites P's inputs before F with them, rolling back when they
//   are in its window and asking for a resync when they are not. Modelled to
//   compare: it overwrites a remote input already received and consumed,
//   which today's engine never does (inputs are immutable once received), and
//   it needs the resync path anyway for the out-of-window case.
//
// What is modelled: one frame of P's input before F (its real value differs
// from the prediction; the case where they are equal splits nothing), whether
// its real value reached the host before the recovery, B's copy, the host's
// recovery, B's resync or settled-input message, and B being in or out of
// window when that arrives.
//
// Not modelled: more frames (each is independent), more than one other guest
// (each behaves as B; one scheduled request per guest however many phantoms
// recover, web/src/recovery-resync.ts), delivery failures and retries of B's resync (recovery
// delivery's actors own those, specs/recovery_delivery.qnt), the phantom P
// itself (resynced today).

module phantom_settle {
  const RESYNC_ALL: bool
  const SEND_SETTLED: bool

  // Where P's real input for the frame has got to.
  var realAtHost: bool     // reached the host before the recovery (fed there)
  var realAtB: bool        // reached B
  // What each page's state uses for P's input at that frame: true = real.
  var hostUsesReal: bool
  var bUsesReal: bool
  var recovered: bool      // the host has settled P's inputs before F
  var bSettled: bool       // B applied a host state at F: inputs before F are the host's
  var bOwed: bool          // a resync or settled-input message to B is on its way
  var bInWindow: bool      // whether B can still roll back to before F when it arrives
  var bAsked: bool         // B asked for a resync (SEND_SETTLED, out of window)

  action init = {
    nondet w = oneOf(Set(true, false))
    all {
      realAtHost' = false, realAtB' = false,
      hostUsesReal' = false, bUsesReal' = false,
      recovered' = false, bSettled' = false, bOwed' = false,
      bInWindow' = w,
      bAsked' = false,
    }
  }

  // P's real input reaches the host, before the recovery only: after it, the
  // host has settled the frame and never feeds it.
  action realReachesHost = all {
    not(realAtHost), not(recovered),
    realAtHost' = true, hostUsesReal' = true,
    realAtB' = realAtB, bUsesReal' = bUsesReal, recovered' = recovered,
    bSettled' = bSettled, bOwed' = bOwed, bInWindow' = bInWindow, bAsked' = bAsked,
  }

  // P's real input reaches B. B rolls back to it unless a host state has
  // settled the frame there: a guest applying a host state at F settles every
  // peer's inputs before F - delay (_settleInputsAtResync), and
  // _drainPendingCInputs never feeds one below that to the engine
  // (C-INPUT-SETTLED-SKIP). C would not refuse it on its own: kn_set_frame
  // keeps the ring, so a rollback there could restore B's own save from
  // before the resync. Pinned by test_a_resynced_guest_never_feeds_a_settled_input
  // and rb-mesh PHANTOM_SETTLE_LATE=1.
  action realReachesB = all {
    not(realAtB),
    realAtB' = true,
    bUsesReal' = if (bSettled) bUsesReal else true,
    realAtHost' = realAtHost, hostUsesReal' = hostUsesReal, recovered' = recovered,
    bSettled' = bSettled, bOwed' = bOwed, bInWindow' = bInWindow, bAsked' = bAsked,
  }

  // The host hears from P again: it settles P's inputs before F and resyncs
  // P; with a fix it also owes B its state, or the settled values.
  action recover = all {
    not(recovered),
    recovered' = true,
    bOwed' = (RESYNC_ALL or SEND_SETTLED),
    realAtHost' = realAtHost, hostUsesReal' = hostUsesReal, realAtB' = realAtB,
    bUsesReal' = bUsesReal, bSettled' = bSettled, bInWindow' = bInWindow, bAsked' = bAsked,
  }

  // B receives what it is owed. A host state: B is on the host's values and
  // settles before F. Settled values: in window, B rolls back to them and
  // ignores P's real input for that frame from then on; out of window, it
  // asks for a resync.
  action bReceives = all {
    bOwed, bOwed' = false,
    if (RESYNC_ALL or bInWindow) all {
      bUsesReal' = hostUsesReal, bSettled' = true, bAsked' = bAsked,
    } else all {
      // Out of window: B cannot roll back there; it keeps its value and asks.
      bUsesReal' = bUsesReal, bSettled' = bSettled, bAsked' = true,
    },
    realAtHost' = realAtHost, hostUsesReal' = hostUsesReal, realAtB' = realAtB,
    recovered' = recovered, bInWindow' = bInWindow,
  }

  // B's own resync request (SEND_SETTLED, out of window) is answered with a
  // host state.
  action bResynced = all {
    bAsked, bAsked' = false,
    bUsesReal' = hostUsesReal, bSettled' = true,
    realAtHost' = realAtHost, hostUsesReal' = hostUsesReal, realAtB' = realAtB,
    recovered' = recovered, bOwed' = bOwed, bInWindow' = bInWindow,
  }

  action nothingHappens = all {
    realAtHost' = realAtHost, realAtB' = realAtB, hostUsesReal' = hostUsesReal,
    bUsesReal' = bUsesReal, recovered' = recovered, bSettled' = bSettled,
    bOwed' = bOwed, bInWindow' = bInWindow, bAsked' = bAsked,
  }

  action step = any { realReachesHost, realReachesB, recover, bReceives, bResynced, nothingHappens }

  // Once the host has recovered P and nothing more is on its way to B, B's
  // state uses the same value for P's input as the host's.
  val othersEndOnTheHostsValues =
    (recovered and not(bOwed) and not(bAsked)) implies (bUsesReal == hostUsesReal)

  // B is never taken off the host's values by P's real input once it holds
  // the host's state.
  val aSettledGuestStaysSettled = bSettled implies (bUsesReal == hostUsesReal)

  val allHold = othersEndOnTheHostsValues and aSettledGuestStaysSettled

  // ── scenarios ──────────────────────────────────────────────────────────

  // The run's ordering: P's real input reaches B (in window, B rolls back to
  // it), never the host; the host recovers P and settles its prediction.
  // Today B stays on P's real value for good.
  run settledPredictionSplitsTest =
    init.then(realReachesB).then(recover)
      .expect(bUsesReal and not(hostUsesReal))
      .then(if (RESYNC_ALL or SEND_SETTLED) bReceives.then(if (bAsked) bResynced else nothingHappens) else nothingHappens)
      .expect(othersEndOnTheHostsValues == (RESYNC_ALL or SEND_SETTLED))

  // P's real input reaches B only after B was resynced: it changes nothing.
  run lateRealAfterResyncTest =
    init.then(recover)
      .then(if (RESYNC_ALL or SEND_SETTLED) bReceives.then(if (bAsked) bResynced else nothingHappens) else nothingHappens)
      .then(realReachesB)
      .expect(othersEndOnTheHostsValues == (RESYNC_ALL or SEND_SETTLED))

  // The real input reached the host before the recovery: both use it, no
  // split, and a fix's extra state changes nothing.
  run realAtHostTest =
    init.then(realReachesHost).then(realReachesB).then(recover)
      .then(if (RESYNC_ALL or SEND_SETTLED) bReceives else nothingHappens)
      .expect(othersEndOnTheHostsValues and bUsesReal and hostUsesReal)
}

// Today: only the phantom is resynced.
module phantom_settle_current {
  import phantom_settle(RESYNC_ALL = false, SEND_SETTLED = false).*
}

// Send the settled values (out of window: B asks for a resync).
module phantom_settle_send_settled {
  import phantom_settle(RESYNC_ALL = false, SEND_SETTLED = true).*
}

// The fix: resync every guest on a phantom's recovery.
module phantom_settle_fixed {
  import phantom_settle(RESYNC_ALL = true, SEND_SETTLED = false).*
}
