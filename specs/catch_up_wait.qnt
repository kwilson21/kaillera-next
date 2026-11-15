// -*- mode: Bluespec; -*-
//
// A guest catching up from a host state behind it, waiting on a hole, and
// what it sends meanwhile: tick()'s input send, its catch-up branch and
// _catchUpSlice in web/static/netplay-rollback.js.
//
// After a reconnect the guest applies the host's state from before its own
// frame and runs the frames up to its own again (#261). That needs the
// host's inputs for the frames just before the state, which went out on the
// channel that died. A slice that finds one missing asks for it
// (`resend:<frame>`, every 500 ms) and waits, up to CATCH_UP_HOLE_WAIT_MS.
//
// It waited by returning, and the tick marked itself replay-only, so the
// scheduler ran the next tick at once: 59k-397k slices in a few seconds,
// against 5-14 when no input was missing. And every tick sent this frame's
// input again, before the catch-up branch, even though no frame had
// advanced. On the reliable, ordered channel (right after a reconnect, or
// after DC-FALLBACK) each of those packets is delivered, in order, ahead of
// the asks: the host got them about 50 s late, the catch-up gave up at 3 s,
// the host, holding the guest as a phantom, ran on, and the guest's inputs
// came back too old to clear it (the runaway; DROP_PEER_MS=12000, 1 run in
// 4 on main d8be9d8: host 3112 frames, guest 1915).
//
// YIELD_WHILE_WAITING: a catch-up waiting on a hole spends the tick's 60 Hz
//   slot, so the next tick waits for the next slot. The fix for the spin
//   (I1: the wait keeps its deadline).
//
// RESEND_LIMITED: the same frame's input goes out again at most once every
//   R slots (100 ms: R = 6; the model uses 2), on either channel. Not never:
//   a page far behind drops a peer's inputs as too far ahead (INPUT-OOR)
//   even on the reliable channel, and the resend after it caught up is what
//   brought the input back (#272's HEAL_BOTH_SIDES run on a send-once
//   build split at 1911). That masks a receiver bug: the follow-up has the
//   receiver ask for what it dropped once it reaches it.
//
// What is modelled: one guest, its frame, the hole the catch-up waits on,
// ticks and 60 Hz slots, the input sends, the reliable channel as a queue
// that delivers a few packets a slot, and one ask for the hole.
//
// Not modelled: the unreliable channel, the host's side beyond answering
// the ask, the rest of the catch-up (specs/resync_flow.qnt, CATCH_UP), and
// the phantom on the host (the runaway's consequence, not its cause).

module catch_up_wait {
  const YIELD_WHILE_WAITING: bool
  const RESEND_LIMITED: bool

  // Packets the reliable channel delivers per slot (bounded for the model).
  pure val DRAIN = 2
  // The most packets ahead of the ask that still get it answered within
  // the hole's deadline (a few slots).
  pure val ASK_BOUND = 4
  // Bound on the queue for the model.
  pure val QUEUE_CAP = 12
  // Slots between two sends of the same frame (6 in the engine).
  pure val R = 2

  var waiting: bool        // the catch-up waits on a hole
  var holeFilled: bool
  var lastSent: int        // the newest frame whose input went out on the reliable channel
  var frame: int           // the guest's frame (does not move while waiting)
  var queue: int           // packets on the reliable channel not yet delivered
  var askAhead: int        // packets queued ahead of the ask; -1 = no ask in flight
  var ticksThisSlot: int
  var slotsSinceSend: int  // slots since the last send (capped at R)
  var tooSoon: bool        // history: the same frame went out again within R slots
  var buried: bool         // history: the ask was queued behind more than ASK_BOUND

  action init = all {
    waiting' = true, holeFilled' = false,
    lastSent' = 10, frame' = 10,
    queue' = 0, askAhead' = -1, ticksThisSlot' = 0,
    slotsSinceSend' = R, tooSoon' = false, buried' = false,
  }

  // A tick. While waiting it runs a slice (no frame advances) after the
  // input send; it may run again in the same slot only if it does not
  // spend the slot.
  def mayTick: bool = ticksThisSlot == 0 or not(YIELD_WHILE_WAITING and waiting)
  def sameFrame: bool = lastSent >= frame
  def sends: bool = not(RESEND_LIMITED) or not(sameFrame) or slotsSinceSend >= R
  action tick = all {
    mayTick, queue < QUEUE_CAP, ticksThisSlot < 6,
    ticksThisSlot' = ticksThisSlot + 1,
    queue' = if (sends) queue + 1 else queue,
    tooSoon' = (tooSoon or (sends and sameFrame and slotsSinceSend < R)),
    slotsSinceSend' = if (sends) 0 else slotsSinceSend,
    lastSent' = if (sends) frame else lastSent,
    // Once the hole is filled the catch-up runs on: the frame advances.
    frame' = if (not(waiting)) frame + 1 else frame,
    waiting' = waiting, holeFilled' = holeFilled, askAhead' = askAhead, buried' = buried,
  }

  // The slice asks for the hole (once here; every 500 ms in the engine).
  action ask = all {
    waiting, askAhead < 0,
    askAhead' = queue,
    queue' = queue + 1,
    buried' = (buried or queue > ASK_BOUND),
    waiting' = waiting, holeFilled' = holeFilled, lastSent' = lastSent, frame' = frame,
    ticksThisSlot' = ticksThisSlot, slotsSinceSend' = slotsSinceSend, tooSoon' = tooSoon,
  }

  // A 60 Hz slot: the channel delivers up to DRAIN packets. Once nothing is
  // ahead of the ask, the host has it and answers: the hole fills.
  def delivered: int = if (queue < DRAIN) queue else DRAIN
  action slot = all {
    queue' = queue - delivered,
    askAhead' = if (askAhead < 0) askAhead else if (askAhead < delivered) -1 else askAhead - delivered,
    holeFilled' = (holeFilled or (askAhead >= 0 and askAhead < delivered)),
    waiting' = (waiting and not(askAhead >= 0 and askAhead < delivered)),
    ticksThisSlot' = 0,
    slotsSinceSend' = if (slotsSinceSend < R) slotsSinceSend + 1 else R,
    lastSent' = lastSent, frame' = frame, tooSoon' = tooSoon, buried' = buried,
  }

  action step = any { tick, ask, slot }

  // ── Properties ───────────────────────────────────────────────────────────

  // The same frame's input goes out again at most once every R slots.
  val reliableResendsAreSpaced = not(tooSoon)
  // A catch-up waiting on a hole takes one tick per 60 Hz slot.
  val aWaitingCatchUpDoesNotSpin = waiting implies ticksThisSlot <= 1
  // The ask for the hole is never queued behind more than a few packets.
  val theAskIsNotBuried = not(buried)

  val allHold = and { reliableResendsAreSpaced, aWaitingCatchUpDoesNotSpin, theAskIsNotBuried }

  // ── Scenarios ────────────────────────────────────────────────────────────

  // The runaway's ordering: the catch-up waits, ticks spin and send, then
  // the slice asks.
  run spinThenAskTest =
    if (YIELD_WHILE_WAITING)
      // A second tick in the same slot waits for the next one.
      init.then(tick).expect(not(mayTick))
    else
      init
        .then(tick).then(tick).then(tick).then(tick).then(tick).then(tick)
        .then(ask)
        .expect(theAskIsNotBuried == RESEND_LIMITED)
        .expect(not(aWaitingCatchUpDoesNotSpin))

  // With the fix the second tick in a slot waits for the next slot, and the
  // ask is answered in the slot after it is sent.
  run yieldThenAskTest =
    if (YIELD_WHILE_WAITING and RESEND_LIMITED)
      init.then(tick).then(ask).then(slot)
        .expect(holeFilled and not(waiting) and allHold)
        .then(tick).then(tick)
        .expect(allHold)
    else if (YIELD_WHILE_WAITING)
      // Yielding alone: one tick a slot, but each sends the same frame again.
      init.then(tick).then(slot).then(tick)
        .expect(aWaitingCatchUpDoesNotSpin and not(reliableResendsAreSpaced))
    else
      init.then(tick).then(tick)
        .expect(not(aWaitingCatchUpDoesNotSpin))
}

// Today: the waiting catch-up spins and every tick sends the frame again.
module catch_up_wait_current {
  import catch_up_wait(YIELD_WHILE_WAITING = false, RESEND_LIMITED = false).*
}

// Yielding alone: the same frame still goes out again every slot.
module catch_up_wait_yield_only {
  import catch_up_wait(YIELD_WHILE_WAITING = true, RESEND_LIMITED = false).*
}

// Limiting the resend alone: the slice still spins.
module catch_up_wait_resend_limited_only {
  import catch_up_wait(YIELD_WHILE_WAITING = false, RESEND_LIMITED = true).*
}

// The fix.
module catch_up_wait_fixed {
  import catch_up_wait(YIELD_WHILE_WAITING = true, RESEND_LIMITED = true).*
}
