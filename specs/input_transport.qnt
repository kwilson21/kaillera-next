// -*- mode: Bluespec; -*-
//
// One page's inputs on their way to a peer, and the switch from the
// unreliable input channel to the reliable one (the input send and the DC
// health monitor in tick(), and setupRollbackInputDataChannel's onclose, in
// web/static/netplay-rollback.js).
//
// A match the host starts with the unreliable transport (knDiag.setTransport
// ('unreliable'), window._knTransportOverride, broadcast as
// `rb-transport:unreliable`) sends each input on `rollback-input`, an
// unordered channel with maxRetransmits 0: a packet may be lost or arrive out
// of order. Each packet carries the frame's input (the header) and, as
// redundancy, a bounded tail from the page's retained inputs newer than
// the peer's last ack. The ack is the newest frame the peer has received;
// a hole older than the tail can remain below that ack.
//
// The page goes back to the reliable channel (`lockstep`, ordered, which
// delivers everything in order) on two triggers:
//   - the health monitor: the channel's buffer stays full, or the peer's
//     frames stop advancing for 500 ms (DC-FALLBACK reason=buffer,
//     reason=ack-stale); packets already sent on the unreliable channel may
//     still arrive, or be lost;
//   - the unreliable channel closes (DC-FALLBACK reason=rb-dc-close): what
//     was in flight on it is lost.
// From then on the history is not used: the trim takes it down to nothing
// and packets carry the header alone. An input lost on the unreliable
// channel just before the switch, and not acked, was then sent by nothing:
// the comment at the health monitor said the first reliable packet carries
// every unacked frame, and it did not (found reading the code, 2026-11).
// Before #235 the peer stalled on that hole until its 5 s deadline, declared
// the page a phantom and resynced. Since #235 a page stalled on a hole asks
// for it (`resend:<frame>`, RB-INPUT-ASK), which fills it a round trip after
// the stall began.
//
// What is modelled: the sending page's inputs, its history with its cap, the
// unreliable channel (loss, any order, closing), the reliable channel, acks,
// both triggers, and the peer asking for a hole (ASK_FOR_MISSING).
//
// Not modelled: more than one peer (the transport is the page's, one for all
// its peers, and each peer has its own ack: the property is per peer), the
// peer's own inputs, frames and stalls (a page asks only while it waits at
// its rollback window's edge; here it may ask for any hole), the inputs the
// page keeps for `resend:` (600 frames; here, all), and switching back to the
// unreliable channel (only a new match does).
//
// ASK_FOR_MISSING: the peer asks for an input it is missing below the newest
//   it holds, and the page sends it again on the reliable channel (#235).
//   false = before #235.
//
// RESEND_AT_SWITCH: at the switch the page sends, on the reliable channel,
//   every input it made after the peer's ack, from the inputs it keeps, not
//   from the history (which the cap may already have cut). The fix.
//
// RETRY_UNSENT: the resend at the switch is a burst of sends on the reliable
//   channel, and a send can throw partway (the channel's buffer is full):
//   the frames from there on were not sent. With this the page keeps them
//   and sends them again on its next ticks until they are sent or acked
//   (or the peer is reset). Without it they were dropped, and since the
//   page was already on the reliable channel nothing sent them again
//   (resendFailsPartwayTest; found by review, #240).
//
// REDUNDANCY_UNTIL_ACKED: the other way to keep the comment's word: the page
//   keeps the history and sends it as redundancy on the reliable channel
//   until the peer has acked the frame it switched at. Not taken: the
//   history holds only the newest HISTORY_CAP inputs, and a stuck channel
//   leaves more than that unacked (stuckChannelBeyondTheCapTest).
module input_transport {
  const ASK_FOR_MISSING: bool
  const RESEND_AT_SWITCH: bool
  const REDUNDANCY_UNTIL_ACKED: bool
  const RETRY_UNSENT: bool

  // The page makes the inputs for frames 0 .. LAST_FRAME - 1.
  pure val LAST_FRAME = 4
  // This model keeps the header and one prior frame. A 256-byte wire packet
  // can carry a 24-byte header and up to 14 prior 16-byte records.
  pure val HISTORY_CAP = 2

  // `frames`: the inputs it carries, the header among them.
  type Packet = { header: int, frames: Set[int] }

  var made: int              // inputs made: frames 0 .. made - 1
  var history: Set[int]      // frames eligible for the next packet's redundancy
  var ack: int               // the peer's ack as the page knows it (lastAckFromPeer)
  var unreliable: bool       // _rbTransport === 'unreliable'
  var rbOpen: bool           // the unreliable channel is open
  var lossy: Set[Packet]     // in flight on the unreliable channel
  var ordered: List[Packet]  // in flight on the reliable channel, in order
  var got: Set[int]          // the peer holds these inputs of the page's
  // History: the inputs made after the ack when the page switched, and the
  // newest frame then (-1: not switched).
  var unackedAtSwitch: Set[int]
  var switchedAt: int
  // The resend's frames a send failed on, kept to send again (RETRY_UNSENT).
  var unsent: Set[int]

  pure def newest(s: Set[int]): int = s.fold(-1, (a, k) => if (k > a) k else a)
  pure def framesBetween(lo: int, hi: int): Set[int] = 0.to(LAST_FRAME).filter(k => k > lo and k <= hi)

  // Redundancy is sent, and the history trimmed only to the ack.
  def redundancyOn: bool =
    unreliable or (REDUNDANCY_UNTIL_ACKED and switchedAt >= 0 and ack < switchedAt)

  // The trim (minPeerAck, then the cap): with redundancy off, down to nothing.
  def trimmed(h: Set[int], frame: int): Set[int] = {
    val kept = h.filter(k => k > (if (redundancyOn) ack else frame))
    kept.filter(k => kept.filter(j => j > k).size() < HISTORY_CAP)
  }

  action sendOn(p: Packet): bool = all {
    if (unreliable and rbOpen) all { lossy' = lossy.union(Set(p)), ordered' = ordered }
    else all { lossy' = lossy, ordered' = ordered.append(p) },
  }

  action init = all {
    made' = 0, history' = Set(), ack' = -1, unreliable' = true, rbOpen' = true,
    lossy' = Set(), ordered' = List(), got' = Set(), unackedAtSwitch' = Set(), switchedAt' = -1,
    unsent' = Set(),
  }

  // One tick: the input for frame `frame` (a new one, or, while the page is
  // stalled, the same one again) with the history as redundancy.
  action send(frame: int, isNew: bool): bool = {
    val h = trimmed(if (isNew) history.union(Set(frame)) else history, frame)
    all {
      history' = h,
      sendOn({ header: frame, frames: Set(frame).union(if (redundancyOn) h.filter(k => k < frame) else Set()) }),
      made' = if (isNew) made + 1 else made,
      ack' = ack, unreliable' = unreliable, rbOpen' = rbOpen, got' = got,
      unackedAtSwitch' = unackedAtSwitch, switchedAt' = switchedAt, unsent' = unsent,
    }
  }

  action tick = all { made < LAST_FRAME, send(made, true) }
  action tickStalled = all { made > 0, send(made - 1, false) }

  action deliverLossy(p: Packet): bool = all {
    lossy.contains(p),
    lossy' = lossy.exclude(Set(p)), got' = got.union(p.frames),
    made' = made, history' = history, ack' = ack, unreliable' = unreliable, rbOpen' = rbOpen,
    ordered' = ordered, unackedAtSwitch' = unackedAtSwitch, switchedAt' = switchedAt, unsent' = unsent,
  }

  action lose(p: Packet): bool = all {
    lossy.contains(p),
    lossy' = lossy.exclude(Set(p)),
    made' = made, history' = history, ack' = ack, unreliable' = unreliable, rbOpen' = rbOpen,
    ordered' = ordered, got' = got, unackedAtSwitch' = unackedAtSwitch, switchedAt' = switchedAt, unsent' = unsent,
  }

  action deliverOrdered = all {
    ordered.length() > 0,
    ordered' = ordered.tail(), got' = got.union(ordered.head().frames),
    made' = made, history' = history, ack' = ack, unreliable' = unreliable, rbOpen' = rbOpen,
    lossy' = lossy, unackedAtSwitch' = unackedAtSwitch, switchedAt' = switchedAt, unsent' = unsent,
  }

  // The peer's packets carry its ack: the newest frame it holds.
  action ackArrives = all {
    newest(got) > ack,
    ack' = newest(got),
    made' = made, history' = history, unreliable' = unreliable, rbOpen' = rbOpen,
    lossy' = lossy, ordered' = ordered, got' = got, unackedAtSwitch' = unackedAtSwitch, switchedAt' = switchedAt,
    unsent' = unsent,
  }

  // The switch to the reliable channel, on either trigger. The resend goes
  // out oldest first, one send per frame; a send can throw at frame `cut`,
  // leaving that frame and every later one unsent (cut > made - 1: none).
  action switchNow(ordered0: List[Packet], cut: int): bool = {
    val unacked = framesBetween(ack, made - 1)
    val sentNow = unacked.filter(k => k < cut)
    val left = unacked.filter(k => k >= cut)
    all {
      unreliable' = false,
      unackedAtSwitch' = unacked,
      switchedAt' = made - 1,
      ordered' = if (RESEND_AT_SWITCH and sentNow != Set()) ordered0.append({ header: newest(sentNow), frames: sentNow })
        else ordered0,
      unsent' = if (RESEND_AT_SWITCH and RETRY_UNSENT) left else Set(),
    }
  }

  // DC-FALLBACK reason=buffer / reason=ack-stale. Packets on the unreliable
  // channel stay there, to arrive or be lost.
  action healthFallbackAt(cut: int): bool = all {
    unreliable, rbOpen,
    switchNow(ordered, cut),
    made' = made, history' = history, ack' = ack, rbOpen' = rbOpen, lossy' = lossy, got' = got,
  }
  // Every send of the resend goes through.
  action healthFallback = healthFallbackAt(LAST_FRAME)

  // The unreliable channel closes: what was in flight on it is lost. With
  // the unreliable transport in use, DC-FALLBACK reason=rb-dc-close.
  action channelClosesAt(cut: int): bool = all {
    rbOpen,
    rbOpen' = false, lossy' = Set(),
    if (unreliable) switchNow(ordered, cut)
    else all {
      unreliable' = unreliable, unackedAtSwitch' = unackedAtSwitch, switchedAt' = switchedAt, ordered' = ordered,
      unsent' = unsent,
    },
    made' = made, history' = history, ack' = ack, got' = got,
  }
  action channelCloses = channelClosesAt(LAST_FRAME)

  // A later tick sends every kept frame (or a send throws again and the
  // tick sends none: nothing changes). Not only those after the ack: on the
  // reliable channel a packet carries its own frame alone, so the ack (the
  // newest frame the peer holds) can pass a kept frame the peer is missing
  // (the next tick's packet arrives first). The peer drops a duplicate.
  action retryUnsent = all {
    unsent != Set(),
    ordered' = ordered.append({ header: newest(unsent), frames: unsent }),
    unsent' = Set(),
    made' = made, history' = history, ack' = ack, unreliable' = unreliable, rbOpen' = rbOpen,
    lossy' = lossy, got' = got, unackedAtSwitch' = unackedAtSwitch, switchedAt' = switchedAt,
  }

  // The peer asks for an input it is missing below the newest it holds; the
  // page sends it again from the inputs it keeps.
  action ask(k: int): bool = all {
    ASK_FOR_MISSING,
    k < newest(got), not(got.contains(k)),
    not(ordered.indices().exists(i => ordered[i].frames.contains(k))),
    ordered' = ordered.append({ header: k, frames: Set(k) }),
    made' = made, history' = history, ack' = ack, unreliable' = unreliable, rbOpen' = rbOpen,
    lossy' = lossy, got' = got, unackedAtSwitch' = unackedAtSwitch, switchedAt' = switchedAt, unsent' = unsent,
  }

  action step = any {
    tick, tickStalled, deliverOrdered, ackArrives, retryUnsent,
    nondet cut = oneOf(0.to(LAST_FRAME))
    any { healthFallbackAt(cut), channelClosesAt(cut) },
    nondet p = oneOf(lossy)
    any { deliverLossy(p), lose(p) },
    nondet k = oneOf(0.to(LAST_FRAME))
    ask(k),
  }

  // ── properties ─────────────────────────────────────────────────────────

  def onTheWire(k: int): bool =
    lossy.exists(p => p.frames.contains(k)) or ordered.indices().exists(i => ordered[i].frames.contains(k))

  // The page sends it again without being asked: the header goes out on
  // every tick, and the history with it while redundancy is on.
  def sentAgainUnasked(k: int): bool =
    k == made - 1 or (redundancyOn and history.contains(k)) or unsent.contains(k)

  // What the comment at the health monitor promises: every input the peer
  // had not acked when the page switched reaches it without the peer having
  // to ask. It holds it, it is on its way, or the page will send it again.
  // Violated today: the switch lets the history go, so an input lost on the
  // unreliable channel before it is sent by nothing (lostThenFallbackTest,
  // lostThenChannelClosesTest). Violated with REDUNDANCY_UNTIL_ACKED when
  // more inputs were unacked than the history holds
  // (stuckChannelBeyondTheCapTest).
  val unackedInputsAreSentAgainAtTheSwitch =
    unackedAtSwitch.forall(k => got.contains(k) or onTheWire(k) or sentAgainUnasked(k))

  // No input is lost for good: the peer holds it, it is on its way, the page
  // will send it again, or the peer will ask for it (it will hear a newer
  // input: the page's header goes out on every tick).
  // Violated before #235, when nothing asked: the peer stalled on the hole
  // for 5 s and declared the page a phantom.
  val noInputIsLostForGood =
    0.to(LAST_FRAME - 1).forall(k =>
      k >= made or got.contains(k) or onTheWire(k) or sentAgainUnasked(k) or (ASK_FOR_MISSING and k < made - 1)
    )

  val allHold = unackedInputsAreSentAgainAtTheSwitch and noInputIsLostForGood

  // ── scenarios ──────────────────────────────────────────────────────────

  // Inputs 0 and 1 go out on the unreliable channel and are lost; the health
  // monitor switches; the page, stalled, sends input 1 again on the reliable
  // channel.
  run lostThenFallbackTest =
    init
      .then(tick).then(tick)
      .expect(lossy == Set({ header: 0, frames: Set(0) }, { header: 1, frames: Set(0, 1) }))
      .then(lose({ header: 0, frames: Set(0) }))
      .then(lose({ header: 1, frames: Set(0, 1) }))
      .then(healthFallback)
      .expect(unackedAtSwitch == Set(0, 1))
      .expect(unackedInputsAreSentAgainAtTheSwitch == (RESEND_AT_SWITCH or REDUNDANCY_UNTIL_ACKED))
      .then(tickStalled)
      .then(deliverOrdered)
      .then(if (RESEND_AT_SWITCH) deliverOrdered else ackArrives)
      // Fixed (either way): the peer holds 0 and 1. Today: 1 alone, and
      // nothing will send 0 unless the peer asks.
      .expect(got == (if (RESEND_AT_SWITCH or REDUNDANCY_UNTIL_ACKED) Set(0, 1) else Set(1)))
      .expect(unackedInputsAreSentAgainAtTheSwitch == (RESEND_AT_SWITCH or REDUNDANCY_UNTIL_ACKED))
      .expect(noInputIsLostForGood == (RESEND_AT_SWITCH or REDUNDANCY_UNTIL_ACKED or ASK_FOR_MISSING))

  // Since #235 the peer asks for the hole and gets it, a round trip later.
  run theAskFillsTheHoleTest =
    if (not(ASK_FOR_MISSING) or RESEND_AT_SWITCH or REDUNDANCY_UNTIL_ACKED) init else init
      .then(tick).then(tick)
      .then(lose({ header: 0, frames: Set(0) }))
      .then(lose({ header: 1, frames: Set(0, 1) }))
      .then(healthFallback)
      .then(tick)
      .then(deliverOrdered)
      .expect(got == Set(2))
      .then(ask(0)).then(ask(1))
      .then(deliverOrdered).then(deliverOrdered)
      .expect(got == Set(0, 1, 2))

  // The same loss, and the unreliable channel closes instead.
  run lostThenChannelClosesTest =
    init
      .then(tick).then(tick)
      .then(channelCloses)
      .expect(not(unreliable) and lossy == Set() and unackedAtSwitch == Set(0, 1))
      .expect(unackedInputsAreSentAgainAtTheSwitch == (RESEND_AT_SWITCH or REDUNDANCY_UNTIL_ACKED))
      .expect(noInputIsLostForGood == (RESEND_AT_SWITCH or REDUNDANCY_UNTIL_ACKED or ASK_FOR_MISSING))
      .then(tickStalled)
      .then(deliverOrdered)
      .then(if (RESEND_AT_SWITCH) deliverOrdered else ackArrives)
      .expect(got == (if (RESEND_AT_SWITCH or REDUNDANCY_UNTIL_ACKED) Set(0, 1) else Set(1)))

  // What was acked before the loss is not sent again.
  run onlyTheUnackedAreSentAgainTest =
    init
      .then(tick)
      .then(deliverLossy({ header: 0, frames: Set(0) }))
      .then(ackArrives)
      .then(tick)
      .expect(lossy == Set({ header: 1, frames: Set(1) }))
      .then(lose({ header: 1, frames: Set(1) }))
      .then(healthFallback)
      .expect(unackedAtSwitch == Set(1))
      .expect(ordered == (if (RESEND_AT_SWITCH) List({ header: 1, frames: Set(1) }) else List()))
      // Input 1 is the newest: the next tick's header carries it in every
      // variant. Only inputs before the newest can be left behind.
      .expect(allHold)

  // The channel stops delivering altogether (the iOS fault the monitor is
  // for) while the page makes more inputs than the history holds; then it
  // closes. Only the inputs the page keeps hold them all.
  run stuckChannelBeyondTheCapTest =
    init
      .then(tick).then(tick).then(tick)
      .expect(history == Set(1, 2))
      .then(channelCloses)
      .expect(unackedAtSwitch == Set(0, 1, 2))
      .expect(unackedInputsAreSentAgainAtTheSwitch == RESEND_AT_SWITCH)
      .then(tickStalled)
      .then(deliverOrdered)
      .then(if (RESEND_AT_SWITCH) deliverOrdered else ackArrives)
      .expect(got == (
        if (RESEND_AT_SWITCH) Set(0, 1, 2) else if (REDUNDANCY_UNTIL_ACKED) Set(1, 2) else Set(2)
      ))

  // A healthy match on the unreliable channel: a lost packet's inputs come
  // with the next one, in every variant.
  run lossOnTheUnreliableChannelAloneTest =
    init
      .then(tick).then(tick)
      .then(lose({ header: 0, frames: Set(0) }))
      .then(deliverLossy({ header: 1, frames: Set(0, 1) }))
      .expect(got == Set(0, 1) and allHold)

  // The channel closes with three inputs unacked; the resend's send throws
  // at frame 1, so only frame 0 goes out. Frame 2 is the newest: the next
  // tick's header carries it. Frame 1 is sent by nothing unless the page
  // kept it (RETRY_UNSENT).
  run resendFailsPartwayTest =
    init
      .then(tick).then(tick).then(tick)
      .then(channelClosesAt(1))
      .expect(unackedAtSwitch == Set(0, 1, 2))
      .expect(ordered == (if (RESEND_AT_SWITCH) List({ header: 0, frames: Set(0) }) else List()))
      // The history (frames 1 and 2) is past frame 0 already: redundancy
      // until the ack does not cover it either.
      .expect(unackedInputsAreSentAgainAtTheSwitch == (RESEND_AT_SWITCH and RETRY_UNSENT))
      .then(if (RETRY_UNSENT) retryUnsent.then(deliverOrdered).then(deliverOrdered) else tickStalled)
      .expect(if (RETRY_UNSENT) got == Set(0, 1, 2) and allHold else true)
}

// Before #235: nothing asked for a hole, and the switch let the history go.
module input_transport_before_ask {
  import input_transport(
    ASK_FOR_MISSING = false, RESEND_AT_SWITCH = false, REDUNDANCY_UNTIL_ACKED = false, RETRY_UNSENT = false
  ).*
}

// Today: the peer asks for the hole.
module input_transport_current {
  import input_transport(
    ASK_FOR_MISSING = true, RESEND_AT_SWITCH = false, REDUNDANCY_UNTIL_ACKED = false, RETRY_UNSENT = false
  ).*
}

// Option not taken: redundancy on the reliable channel until the peer acks
// the frame of the switch.
module input_transport_until_acked {
  import input_transport(
    ASK_FOR_MISSING = true, RESEND_AT_SWITCH = false, REDUNDANCY_UNTIL_ACKED = true, RETRY_UNSENT = false
  ).*
}

// The resend at the switch, with a failed send's frames dropped (#240 as
// first pushed).
module input_transport_resend_once {
  import input_transport(
    ASK_FOR_MISSING = true, RESEND_AT_SWITCH = true, REDUNDANCY_UNTIL_ACKED = false, RETRY_UNSENT = false
  ).*
}

// The fix: the unacked inputs go out again on the reliable channel at the
// switch, and a failed send's frames on the next ticks.
module input_transport_fixed {
  import input_transport(
    ASK_FOR_MISSING = true, RESEND_AT_SWITCH = true, REDUNDANCY_UNTIL_ACKED = false, RETRY_UNSENT = true
  ).*
}

// One connected peer in dual mode. A successful send queues the current
// input on the reliable channel; its optional history is represented by
// the previous frame. The bare copy can be skipped, lost, or arrive first.
module input_transport_dual {
  var made: int
  var ordered: List[Set[int]]
  var fast: Set[int]
  var got: Set[int]
  var feeds: int   // fresh inputs submitted to the game, including history

  action init = all { made' = 0, ordered' = List(), fast' = Set(), got' = Set(), feeds' = 0 }
  action send(copy: bool): bool = all {
    made < 3, made' = made + 1,
    ordered' = ordered.append(if (made == 0) Set(made) else Set(made - 1, made)),
    fast' = if (copy) fast.union(Set(made)) else fast,
    got' = got, feeds' = feeds,
  }
  action receive(frames: Set[int]): bool = all {
    got' = got.union(frames), feeds' = feeds + frames.exclude(got).size(), made' = made,
  }
  action deliverOrdered = all {
    ordered.length() > 0, receive(ordered.head()), ordered' = ordered.tail(), fast' = fast,
  }
  action deliverFast(frame: int): bool = all {
    fast.contains(frame), receive(Set(frame)), fast' = fast.exclude(Set(frame)), ordered' = ordered,
  }
  // Losing an unordered copy, including the last one before the DC closes.
  action loseFast(frame: int): bool = all {
    fast.contains(frame), fast' = fast.exclude(Set(frame)),
    ordered' = ordered, got' = got, feeds' = feeds, made' = made,
  }
  action step = any {
    send(true), send(false), deliverOrdered,
    nondet frame = oneOf(fast)
    any { deliverFast(frame), loseFast(frame) },
  }
  val allHold = feeds == got.size() and 0.to(made - 1).forall(f =>
    got.contains(f) or ordered.indices().exists(i => ordered[i].contains(f)))

  run fastOvertakesReliableTest = init.then(send(false)).then(send(true)).then(deliverFast(1))
    .expect(got == Set(1) and feeds == 1)
    .then(deliverOrdered).then(deliverOrdered).expect(got == Set(0, 1) and feeds == 2)
  run reliableArrivesFirstTest = init.then(send(true)).then(deliverOrdered).then(deliverFast(0))
    .expect(got == Set(0) and feeds == 1)
  run fastLostOrUnavailableTest = init.then(send(true)).then(loseFast(0)).then(send(false))
    .then(deliverOrdered).then(deliverOrdered).expect(got == Set(0, 1) and feeds == 2)
}
