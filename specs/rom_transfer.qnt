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
//   completesShort     the host says the file is complete, but the bytes held
//                      are not as many as its header announced: the page drops
//                      them and shows the drop zone again
//   closes             the channel closes, or no chunk came for 10 s and the
//                      guest closes it. Under load the host can also never
//                      hear the guest's first message, the `rom-resume` sent
//                      the moment the guest's side opens: it then sends
//                      nothing, and this is how that ends, with no byte
//   backoffFires       the 2 s pause before an automatic retry ends
//   resumeTimesOut     no channel came within 15 s of asking
//   userRetry          the guest presses Retry
//   sharingOff / sharingOn   the host turns ROM sharing off or on. The host
//                      closes its channel as it turns sharing off, and the
//                      guest can see that close before the message saying
//                      sharing is off: sharingOff can then find the transfer
//                      already paused, with a retry on its way
//   cancel             the guest cancels, or the game ends
//
// Not modelled: what the bytes are beyond whether the page holds any (size
// and hash checks), the host's side, a second channel replacing the first, a
// stale timer from an earlier request firing late.
//
// DEADLINE_ON_EVERY_ASK: every request for a channel starts the 15 s
//   deadline, however it is sent. false = before this model was written:
//   only the lobby request and the retries did. A request sent mid-game, over
//   the engine channel or by the Socket.IO fallback, left nothing running,
//   so a host that never answered left the guest on "reconnecting..." for
//   good.
// SHORT_COMPLETE_DROPS_COUNT: a short file drops the receiver's count of
//   what arrived, as the page drops the bytes. false = before: the receiver
//   kept its count and header (rom-transfer.ts `{ ...state, phase: 'idle' }`,
//   and play.js's own variables). The next request asked the host to resume
//   from that count with nothing held, so the file could end up missing its
//   start, or never come whole.
// NOTHING_RECEIVED_RESUMES: a transfer that has received nothing resumes on
//   its own like one that has: a channel that closes before any byte is
//   retried after the pause, within the same count, and the host turning
//   sharing back on resumes it. false = before: either left it paused with
//   only a Retry button, so a resume the host never heard ended on "ROM
//   transfer failed" until the player pressed Retry.
// SHARING_OFF_CANCELS_RETRY: the host turning sharing off cancels a retry
//   already on its way, also when the guest saw the channel close first and
//   is paused. false = before: only a transfer still receiving or waiting
//   was stopped, so the guest went on asking a host that was not sharing
//   until its retries ran out.
module rom_transfer {
  const DEADLINE_ON_EVERY_ASK: bool
  const SHORT_COMPLETE_DROPS_COUNT: bool
  const NOTHING_RECEIVED_RESUMES: bool
  const SHARING_OFF_CANCELS_RETRY: bool

  var phase: str          // idle | receiving | paused | resuming | complete
  var retries: int        // automatic retries since the guest last acted
  var gotBytes: bool      // the receiver counts some of the file as arrived (`received` > 0)
  var held: bool          // the page holds bytes of the file (its chunks)
  var timer: str          // none | stall | backoff | resume | poll
  var retryOffered: bool  // the page shows a Retry button
  var byHost: bool        // the pause is the host's doing: it turned sharing off

  pure val MAX_RETRIES = 3

  pure def midGameAskTimer(deadline: bool): str = if (deadline) "resume" else "none"

  action init = all {
    phase' = "idle", retries' = 0, gotBytes' = false, held' = false, timer' = "none", retryOffered' = false, byHost' = false,
  }

  action startWaiting(t: str): bool = all {
    phase' = "resuming", retries' = 0, gotBytes' = false, held' = false, timer' = t, retryOffered' = false, byHost' = false,
  }

  action acceptPreGame = all { phase == "idle", startWaiting("resume") }
  action acceptPolling = all { phase == "idle", startWaiting("poll") }
  action acceptOverEngine = all { phase == "idle", startWaiting(midGameAskTimer(DEADLINE_ON_EVERY_ASK)) }
  action acceptFallback = all { phase == "idle", startWaiting(midGameAskTimer(DEADLINE_ON_EVERY_ASK)) }

  action pollSends = all {
    phase == "resuming", timer == "poll",
    timer' = midGameAskTimer(DEADLINE_ON_EVERY_ASK),
    phase' = phase, retries' = retries, gotBytes' = gotBytes, held' = held, retryOffered' = retryOffered,
    byHost' = byHost,
  }

  action pollGivesUp = all {
    phase == "resuming", timer == "poll",
    timer' = "resume",
    phase' = phase, retries' = retries, gotBytes' = gotBytes, held' = held, retryOffered' = retryOffered,
    byHost' = byHost,
  }

  // A channel that arrives while the guest is waiting to resume keeps what
  // it has; any other arrival starts the file again.
  action channelArrives = all {
    phase != "complete",
    phase' = "receiving", timer' = "stall", retryOffered' = false,
    retries' = if (phase == "resuming" or phase == "paused") retries else 0,
    gotBytes' = if (phase == "resuming" or phase == "paused") gotBytes else false,
    held' = if (phase == "resuming" or phase == "paused") held else false,
    byHost' = false,
  }

  action chunk = all {
    phase == "receiving",
    gotBytes' = true, held' = true, timer' = "stall",
    phase' = phase, retries' = retries, retryOffered' = retryOffered, byHost' = byHost,
  }

  action completes = all {
    phase == "receiving",
    phase' = "complete", timer' = "none", retryOffered' = false,
    retries' = retries, gotBytes' = gotBytes, held' = held, byHost' = false,
  }

  // The page drops the bytes and shows the drop zone (no Retry); the host,
  // a game start or a reconnect can still start another request.
  action completesShort = all {
    phase == "receiving",
    phase' = "idle", timer' = "none", retryOffered' = false, held' = false,
    gotBytes' = if (SHORT_COMPLETE_DROPS_COUNT) false else gotBytes,
    retries' = if (SHORT_COMPLETE_DROPS_COUNT) 0 else retries,
    byHost' = false,
  }

  // A game starting while the guest, having accepted, still has no ROM.
  action gameStarts = all {
    phase == "idle",
    phase' = "resuming", timer' = "poll", retryOffered' = false,
    retries' = retries, gotBytes' = gotBytes, held' = held, byHost' = false,
  }

  // Retried automatically while retries remain (before NOTHING_RECEIVED_RESUMES:
  // only if part of the file arrived); either way the page offers Retry
  // while paused.
  action closes = all {
    phase == "receiving",
    phase' = "paused", retries' = retries + 1, retryOffered' = true,
    timer' = if (retries + 1 <= MAX_RETRIES and (gotBytes or NOTHING_RECEIVED_RESUMES)) "backoff" else "none",
    gotBytes' = gotBytes, held' = held, byHost' = false,
  }

  action backoffFires = all {
    phase == "paused", timer == "backoff",
    phase' = "resuming", timer' = "resume", retryOffered' = false,
    retries' = retries, gotBytes' = gotBytes, held' = held, byHost' = false,
  }

  action resumeTimesOut = all {
    phase == "resuming", timer == "resume",
    phase' = "paused", retries' = retries + 1, retryOffered' = true,
    timer' = if (retries + 1 <= MAX_RETRIES) "backoff" else "none",
    gotBytes' = gotBytes, held' = held, byHost' = false,
  }

  action userRetry = all {
    retryOffered, phase == "paused",
    phase' = "resuming", retries' = 0, timer' = "resume", retryOffered' = false,
    gotBytes' = gotBytes, held' = held, byHost' = false,
  }

  action sharingOff = all {
    phase == "receiving" or phase == "resuming" or phase == "paused",
    phase' = "paused", retryOffered' = true,
    timer' = if (phase != "paused" or SHARING_OFF_CANCELS_RETRY) "none" else timer,
    retries' = retries, gotBytes' = gotBytes, held' = held, byHost' = true,
  }

  // A paused transfer resumes and one that never began starts. Before
  // NOTHING_RECEIVED_RESUMES, a paused one with nothing received stayed
  // paused, though the host was sharing again.
  action sharingOn = {
    val resumes = phase == "idle" or gotBytes or NOTHING_RECEIVED_RESUMES
    all {
      phase == "paused" or phase == "idle",
      phase' = if (resumes) "resuming" else phase,
      timer' = if (resumes) "resume" else timer,
      retryOffered' = if (resumes) false else retryOffered,
      retries' = retries, gotBytes' = gotBytes, held' = held, byHost' = false,
    }
  }

  action cancel = init

  action step = any {
    acceptPreGame, acceptPolling, acceptOverEngine, acceptFallback, pollSends, pollGivesUp,
    channelArrives, chunk, completes, completesShort, gameStarts, closes, backoffFires, resumeTimesOut,
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

  // What the receiver counts as arrived is what the page holds: a resumed
  // channel asks the host to go on from the bytes the page has.
  val countIsHeld = gotBytes == held

  // The guest is left to press Retry only when it is out of automatic
  // retries, or the host stopped sharing. A channel that closed before any
  // byte (a resume the host never heard) used to stop there at once.
  val retriesBeforeAsking = (phase == "paused" and timer == "none") implies (retries > MAX_RETRIES or byHost)

  // Nothing asks the host again by itself once it has stopped sharing.
  val noRetryWhileHostStopped = byHost implies timer != "backoff"

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

  // A channel that dies before any byte (the host never heard the resume):
  // retried after the pause like any other; before, only the Retry button.
  run closedBeforeAnyByteTest =
    init
      .then(acceptPreGame)
      .then(channelArrives)
      .then(closes)
      .expect(phase == "paused" and retryOffered and (timer == "backoff") == NOTHING_RECEIVED_RESUMES)
      .expect(retriesBeforeAsking == NOTHING_RECEIVED_RESUMES)

  // The retry opens a new channel and the file arrives, with no one pressing
  // anything (before: only after the player pressed Retry).
  run lostResumeThenRetryTest =
    init
      .then(acceptPreGame)
      .then(channelArrives)
      .then(closes)
      .then(if (NOTHING_RECEIVED_RESUMES) backoffFires else userRetry)
      .then(channelArrives).then(chunk).then(completes)
      .expect(phase == "complete" and retries == (if (NOTHING_RECEIVED_RESUMES) 1 else 0))

  // The host turns sharing off before any byte arrived, then on again: the
  // transfer asks again (before: it stayed paused, offering only Retry).
  run sharingAgainBeforeAnyByteTest =
    init
      .then(acceptPreGame)
      .then(channelArrives)
      .then(sharingOff)
      .then(sharingOn)
      .expect(phase == (if (NOTHING_RECEIVED_RESUMES) "resuming" else "paused"))
      .expect(retriesBeforeAsking == NOTHING_RECEIVED_RESUMES)

  // The host turns sharing off; the guest sees its channel close before the
  // message saying so. The retry the close scheduled is cancelled (before:
  // it went on, and asked a host that was not sharing).
  run closeBeforeSharingOffTest =
    init
      .then(acceptPreGame)
      .then(channelArrives).then(chunk)
      .then(closes)
      .expect(timer == "backoff")
      .then(sharingOff)
      .expect(phase == "paused" and byHost)
      .expect((timer == "none") == SHARING_OFF_CANCELS_RETRY)
      .expect(noRetryWhileHostStopped == SHARING_OFF_CANCELS_RETRY)

  // Channels that keep dying before any byte use the automatic retries, then
  // the guest is asked; before, every one of them asked.
  run emptyClosesRunOutTest =
    init
      .then(acceptPreGame)
      .then(channelArrives).then(closes)
      .then(if (NOTHING_RECEIVED_RESUMES) backoffFires else userRetry)
      .then(channelArrives).then(closes)
      .then(if (NOTHING_RECEIVED_RESUMES) backoffFires else userRetry)
      .then(channelArrives).then(closes)
      .then(if (NOTHING_RECEIVED_RESUMES) backoffFires else userRetry)
      .then(channelArrives).then(closes)
      .expect(phase == "paused" and timer == "none" and retryOffered)
      .expect(retries == (if (NOTHING_RECEIVED_RESUMES) 4 else 1))

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

  // A short file, then the host turns sharing off and on again: the new
  // channel resumes from what the receiver counts. Before the fix that was
  // the dropped file's count, with nothing held.
  run shortFileThenSharingAgainTest =
    init
      .then(acceptPreGame)
      .then(channelArrives).then(chunk)
      .then(completesShort)
      .expect(countIsHeld == SHORT_COMPLETE_DROPS_COUNT)
      .then(sharingOn)
      .then(channelArrives)
      .expect(phase == "receiving" and countIsHeld == SHORT_COMPLETE_DROPS_COUNT)

  // The same through a game starting while the guest still has no ROM.
  run shortFileThenGameStartsTest =
    init
      .then(acceptPreGame)
      .then(channelArrives).then(chunk)
      .then(completesShort)
      .then(gameStarts).then(pollGivesUp)
      .then(channelArrives)
      .expect(phase == "receiving" and countIsHeld == SHORT_COMPLETE_DROPS_COUNT)
}

// Before this model: a request sent mid-game had no deadline.
module rom_transfer_before {
  import rom_transfer(
    DEADLINE_ON_EVERY_ASK = false, SHORT_COMPLETE_DROPS_COUNT = false, NOTHING_RECEIVED_RESUMES = false,
    SHARING_OFF_CANCELS_RETRY = false,
  ).*
}

// Before the short-file fix: the receiver kept the dropped file's count.
module rom_transfer_short_kept {
  import rom_transfer(
    DEADLINE_ON_EVERY_ASK = true, SHORT_COMPLETE_DROPS_COUNT = false, NOTHING_RECEIVED_RESUMES = false,
    SHARING_OFF_CANCELS_RETRY = false,
  ).*
}

// Before a transfer with nothing received resumed on its own: a resume the
// host never heard left the guest on "ROM transfer failed" until it pressed
// Retry, even once the host was sharing again.
module rom_transfer_nothing_received_waits {
  import rom_transfer(
    DEADLINE_ON_EVERY_ASK = true, SHORT_COMPLETE_DROPS_COUNT = true, NOTHING_RECEIVED_RESUMES = false,
    SHARING_OFF_CANCELS_RETRY = false,
  ).*
}

// With nothing-received retries, before the host turning sharing off cancelled
// a retry the guest's close had already scheduled.
module rom_transfer_retry_outlives_sharing {
  import rom_transfer(
    DEADLINE_ON_EVERY_ASK = true, SHORT_COMPLETE_DROPS_COUNT = true, NOTHING_RECEIVED_RESUMES = true,
    SHARING_OFF_CANCELS_RETRY = false,
  ).*
}

// Today.
module rom_transfer_current {
  import rom_transfer(
    DEADLINE_ON_EVERY_ASK = true, SHORT_COMPLETE_DROPS_COUNT = true, NOTHING_RECEIVED_RESUMES = true,
    SHARING_OFF_CANCELS_RETRY = true,
  ).*
}
