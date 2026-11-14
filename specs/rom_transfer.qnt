// -*- mode: Bluespec; -*-
//
// ROM transfer, from the guest's side: a guest that accepted the host's ROM
// waits for a `rom-transfer` DataChannel, receives the file in chunks, and
// retries when the channel dies (web/src/play/rom-transfer.ts, driven from
// web/static/play.js).
//
// The guest cannot make the host send anything. Every state in which it is
// waiting on the host therefore needs a way out that the guest owns: a timer
// that will fire, or a Retry button on the page.
//
// What is modelled:
//   acceptPreGame      the guest accepts in the lobby; the request goes over
//                      Socket.IO with a 15 s deadline
//   acceptPolling      the guest accepts mid-game before its engine channel
//                      to the host is open; a poll waits for the channel
//   acceptOverEngine   the guest accepts mid-game with the channel open and
//                      asks over it
//   acceptFallback     the guest accepts mid-game with an engine but no open
//                      channel to the host, and asks over Socket.IO
//   pollSends          the poll finds the channel open and asks over it
//   pollGivesUp        the poll runs out (15 s) and asks over Socket.IO
//   channelArrives     the host opens a rom-transfer channel
//   chunk              a chunk arrives
//   completes          the host says the file is complete
//   closes             the channel closes, or no chunk came for 10 s and the
//                      guest closes it
//   backoffFires       the 2 s pause before an automatic retry ends
//   resumeTimesOut     no channel came within 15 s of asking
//   userRetry          the guest presses Retry
//   sharingOff / sharingOn   the host turns ROM sharing off or on
//   cancel             the guest cancels, or the game ends
//
// Not modelled: what the bytes are (size and hash checks), the host's side,
// a second channel replacing the first, a stale timer from an earlier
// request firing late.
//
// DEADLINE_ON_EVERY_ASK: every request for a channel starts the 15 s
//   deadline, however it is sent. false = before this model was written:
//   only the lobby request and the retries did. A request sent mid-game, over
//   the engine channel or by the Socket.IO fallback, left nothing running,
//   so a host that never answered left the guest on "reconnecting..." for
//   good.
module rom_transfer {
  const DEADLINE_ON_EVERY_ASK: bool

  var phase: str          // idle | receiving | paused | resuming | complete
  var retries: int        // automatic retries since the guest last acted
  var gotBytes: bool      // something of the file has arrived
  var timer: str          // none | stall | backoff | resume | poll
  var retryOffered: bool  // the page shows a Retry button

  pure val MAX_RETRIES = 3

  pure def midGameAskTimer(deadline: bool): str = if (deadline) "resume" else "none"

  action init = all {
    phase' = "idle", retries' = 0, gotBytes' = false, timer' = "none", retryOffered' = false,
  }

  action startWaiting(t: str): bool = all {
    phase' = "resuming", retries' = 0, gotBytes' = false, timer' = t, retryOffered' = false,
  }

  action acceptPreGame = all { phase == "idle", startWaiting("resume") }
  action acceptPolling = all { phase == "idle", startWaiting("poll") }
  action acceptOverEngine = all { phase == "idle", startWaiting(midGameAskTimer(DEADLINE_ON_EVERY_ASK)) }
  action acceptFallback = all { phase == "idle", startWaiting(midGameAskTimer(DEADLINE_ON_EVERY_ASK)) }

  action pollSends = all {
    phase == "resuming", timer == "poll",
    timer' = midGameAskTimer(DEADLINE_ON_EVERY_ASK),
    phase' = phase, retries' = retries, gotBytes' = gotBytes, retryOffered' = retryOffered,
  }

  action pollGivesUp = all {
    phase == "resuming", timer == "poll",
    timer' = "resume",
    phase' = phase, retries' = retries, gotBytes' = gotBytes, retryOffered' = retryOffered,
  }

  // A channel that arrives while the guest is waiting to resume keeps what
  // it has; any other arrival starts the file again.
  action channelArrives = all {
    phase != "complete",
    phase' = "receiving", timer' = "stall", retryOffered' = false,
    retries' = if (phase == "resuming" or phase == "paused") retries else 0,
    gotBytes' = if (phase == "resuming" or phase == "paused") gotBytes else false,
  }

  action chunk = all {
    phase == "receiving",
    gotBytes' = true, timer' = "stall",
    phase' = phase, retries' = retries, retryOffered' = retryOffered,
  }

  action completes = all {
    phase == "receiving",
    phase' = "complete", timer' = "none", retryOffered' = false,
    retries' = retries, gotBytes' = gotBytes,
  }

  // Retried automatically only if part of the file arrived; either way the
  // page offers Retry while paused.
  action closes = all {
    phase == "receiving",
    phase' = "paused", retries' = retries + 1, retryOffered' = true,
    timer' = if (retries + 1 <= MAX_RETRIES and gotBytes) "backoff" else "none",
    gotBytes' = gotBytes,
  }

  action backoffFires = all {
    phase == "paused", timer == "backoff",
    phase' = "resuming", timer' = "resume", retryOffered' = false,
    retries' = retries, gotBytes' = gotBytes,
  }

  action resumeTimesOut = all {
    phase == "resuming", timer == "resume",
    phase' = "paused", retries' = retries + 1, retryOffered' = true,
    timer' = if (retries + 1 <= MAX_RETRIES) "backoff" else "none",
    gotBytes' = gotBytes,
  }

  action userRetry = all {
    retryOffered, phase == "paused",
    phase' = "resuming", retries' = 0, timer' = "resume", retryOffered' = false,
    gotBytes' = gotBytes,
  }

  action sharingOff = all {
    phase == "receiving" or phase == "resuming",
    phase' = "paused", timer' = "none", retryOffered' = true,
    retries' = retries, gotBytes' = gotBytes,
  }

  action sharingOn = all {
    (phase == "paused" and gotBytes) or phase == "idle",
    phase' = "resuming", timer' = "resume", retryOffered' = false,
    retries' = retries, gotBytes' = gotBytes,
  }

  action cancel = init

  action step = any {
    acceptPreGame, acceptPolling, acceptOverEngine, acceptFallback, pollSends, pollGivesUp,
    channelArrives, chunk, completes, closes, backoffFires, resumeTimesOut,
    userRetry, sharingOff, sharingOn, cancel,
  }

  // ── properties ─────────────────────────────────────────────────────────

  // While the guest waits on the host, something of the guest's own will end
  // the wait: a running timer, or a Retry button.
  val waitingHasAWayOut = and {
    phase == "receiving" implies timer == "stall",
    phase == "resuming" implies timer != "none",
    phase == "paused" implies (timer != "none" or retryOffered),
  }

  // Timers alone give up: no automatic retry is scheduled once the count is
  // past the limit. (The host turning sharing back on resumes without
  // resetting the count, so the count itself is not bounded.)
  val timersAloneStop = (timer == "backoff") implies (retries <= MAX_RETRIES)

  // ── scenarios ──────────────────────────────────────────────────────────

  // The stall this model found: asked over the engine channel, host silent.
  run engineAskHostSilentTest =
    init
      .then(acceptOverEngine)
      .expect(waitingHasAWayOut == DEADLINE_ON_EVERY_ASK)

  // The same when the request falls back to Socket.IO mid-game.
  run fallbackAskHostSilentTest =
    init
      .then(acceptFallback)
      .expect(waitingHasAWayOut == DEADLINE_ON_EVERY_ASK)

  // The same through the poll.
  run pollThenHostSilentTest =
    init
      .then(acceptPolling)
      .then(pollSends)
      .expect(waitingHasAWayOut == DEADLINE_ON_EVERY_ASK)

  // A channel that dies before any byte is not retried automatically; the
  // page offers Retry.
  run closedBeforeAnyByteTest =
    init
      .then(acceptPreGame)
      .then(channelArrives)
      .then(closes)
      .expect(phase == "paused" and timer == "none" and retryOffered)

  // Three automatic retries, then the guest is asked.
  run retriesRunOutTest =
    init
      .then(acceptPreGame)
      .then(channelArrives).then(chunk).then(closes)   // retry 1
      .then(backoffFires).then(resumeTimesOut)         // retry 2
      .then(backoffFires).then(resumeTimesOut)         // retry 3
      .then(backoffFires).then(resumeTimesOut)         // 4: over the limit
      .expect(phase == "paused" and timer == "none" and retryOffered and retries == 4)

  // A resumed channel keeps what arrived.
  run resumeKeepsBytesTest =
    init
      .then(acceptPreGame)
      .then(channelArrives).then(chunk).then(closes)
      .then(backoffFires)
      .then(channelArrives)
      .expect(phase == "receiving" and gotBytes and retries == 1)
}

// Before this model: a request sent mid-game had no deadline.
module rom_transfer_before {
  import rom_transfer(DEADLINE_ON_EVERY_ASK = false).*
}

// Today.
module rom_transfer_current {
  import rom_transfer(DEADLINE_ON_EVERY_ASK = true).*
}
