/**
 * The simulated network every rollback harness page runs on: an init script
 * for a Playwright browser context, as source (its argument cannot carry a
 * function, so the link schedule goes in as text too). Shared by
 * tests/rb-two-player.mjs and tests/rb-mesh.mjs; the knobs it reads from
 * `window` (__knHoldSyncAnswerMs and the others) are documented where each
 * harness sets them.
 */
import { createLinkSchedule } from './link-schedule.mjs';
import { createDirectionalInputGate } from './directional-input-gate.mjs';

export const networkInitScript = ({ lat, jitter, kbps }, createLinkSchedule, createDirectionalInputGate) => {
  // Simulated network (tests/link-schedule.mjs): every outgoing DataChannel
  // message is held (DELAY_SYNC_ANSWER_MS), carried by its connection's link
  // at LINK_KBPS (no limit when 0), then delayed LAT ms + up to JITTER ms.
  // Jitter never reorders a channel: real SCTP data channels deliver in
  // order, and chunked transfers (compressed save states) rely on it.
  const orig = RTCDataChannel.prototype.send;
  const net = createLinkSchedule({ kbps, lat, jitter });
  window.__knLink = { stats: net.stats, unmappedChannels: 0 };
  // Which connection a channel belongs to: the ones this page creates, and
  // the ones the other page creates (the `datachannel` event). The listener
  // is added as the connection is made, so it runs before the page's own
  // ondatachannel handler, which sends on the channel.
  const pcOf = new WeakMap();
  const RealPC = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(RealPC, {
    construct(target, args, newTarget) {
      const pc = Reflect.construct(target, args, newTarget);
      pc.addEventListener('datachannel', (e) => pcOf.set(e.channel, pc));
      return pc;
    },
  });
  const realCreate = RealPC.prototype.createDataChannel;
  RealPC.prototype.createDataChannel = function (...args) {
    const ch = realCreate.apply(this, args);
    pcOf.set(ch, this);
    return ch;
  };
  const links = new WeakMap(); // connection (or a channel with none known) -> {link, timer}
  const channels = new WeakMap(); // RTCDataChannel -> its channel on the link
  const scheduleOf = (dc) => {
    let ch = channels.get(dc);
    if (ch) return ch;
    let owner = pcOf.get(dc);
    if (!owner) {
      // Not seen being made: it gets a link of its own, and the summary says so.
      owner = dc;
      window.__knLink.unmappedChannels++;
    }
    let l = links.get(owner);
    if (!l) links.set(owner, (l = { link: net.link(), timer: null, dcs: [] }));
    ch = net.channel(l.link, dc.label);
    ch.pumped = l;
    l.dcs.push([dc, ch]);
    channels.set(dc, ch);
    return ch;
  };
  const pump = (l) => {
    l.timer = null;
    const now = performance.now();
    for (const [dc, ch] of l.dcs) {
      for (const data of net.take(ch, now)) {
        try {
          if (dc.readyState === 'open') orig.call(dc, data);
        } catch (_) {}
      }
    }
    arm(l);
  };
  const arm = (l) => {
    const at = net.wakeAt(l.link, performance.now());
    if (at === Infinity) return;
    clearTimeout(l.timer);
    l.timer = setTimeout(() => pump(l), Math.max(0, at - performance.now()));
  };
  // What a channel has been handed by send() and not yet sent is its
  // bufferedAmount. On `sync-state`, everything still in the simulated
  // network for it, held or on the link or in flight: the engine hands its
  // resync state over a chunk at a time, waiting for bufferedAmount to fall
  // below a low-water mark (KNCore.syncSend), and without this the queue hid
  // a held answer from it, and on release the whole of it, 2.9 MB with the
  // next answer behind it, went into the connection at once. On the other
  // channels, only the bytes the capped link has not carried yet (none
  // without LINK_KBPS): those are the channel's own unsent bytes, as on a
  // congested real connection, while bytes in flight are not, so the input
  // channels' own buffer checks (DC-FALLBACK) see what they would see there.
  const realBuffered = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'bufferedAmount');
  const bytesOf = (data) => (typeof data === 'string' ? data.length : (data?.byteLength ?? data?.size ?? 0));
  Object.defineProperty(RTCDataChannel.prototype, 'bufferedAmount', {
    configurable: true,
    get() {
      const real = realBuffered.get.call(this);
      const ch = channels.get(this);
      if (!ch) return real;
      return real + (this.label === 'sync-state' ? net.queued(ch) : net.unsent(ch, performance.now()));
    },
  });
  // DELAY_SYNC_ANSWER_MS: once the test sets window.__knHoldSyncAnswerMs, the
  // next numbered answer to a resync request on the `sync-state` channel is
  // held that long. The channel's order keeps the header and the binary
  // chunks that follow it behind it, so they are released in order after it;
  // the other channels' messages do not wait for it, until it is on the link.
  // That channel carries state transfers only, never input.
  window.__knHoldSyncAnswerMs = 0;
  window.__knSyncAnswersHeld = [];
  // LOSE_INPUTS_BEFORE_FALLBACK: once the test sets window.__knLoseRbInputs,
  // every binary input sent on `rollback-input` (the unordered input channel)
  // is dropped before it reaches the simulated link (it is neither queued
  // nor counted there), and its frame (the packet's first word) kept.
  window.__knLoseRbInputs = false;
  window.__knRbInputsLost = [];
  // SYNC_FOLLOW_UP (the guest page): while window.__knHoldInputsMs is above
  // 0, every input packet (binary, on `lockstep` or `rollback-input`) is held
  // that long. A channel never reorders, so what follows waits behind it.
  window.__knHoldInputsMs = 0;
  // SYNC_FOLLOW_UP=direct (the guest page): while performance.now() is before
  // window.__knHoldInputsUntil, every input packet (binary, on `lockstep` or
  // `rollback-input`) is held until then, so all of them go out together at
  // that moment; what the page sends after them on the same channel (its
  // resync request) follows them in the same burst.
  window.__knHoldInputsUntil = 0;
  // SYNC_FOLLOW_UP=socket (the guest page): while window.__knInputGate is
  // set, every input packet (binary, on `lockstep` or `rollback-input`) is
  // kept back, and window.__knReleaseInputs() sends them all, in order, when
  // the test says (after the host has answered a request sent meanwhile over
  // the signaling socket, which nothing orders against the data channels).
  window.__knInputGate = false;
  const gatedInputs = [];
  window.__knReleaseInputs = () => {
    window.__knInputGate = false;
    const n = gatedInputs.length;
    for (const send of gatedInputs.splice(0)) send();
    return n;
  };
  // CATCH_UP_HOLE_MS (the host page): once window.__knDropInputsAfterOpenMs
  // is above 0, a channel whose first input packet goes out after that drops
  // every input packet (binary, on `lockstep` or `rollback-input`) from its
  // first one until that long after the page next sends a state
  // (`sync-start:`): the reconnected channel loses the host's inputs from
  // just before the state it sends, so the guest's catch-up waits on a
  // hole. Channels opened before arming are untouched. The dropped frames
  // are kept in __knInputsDroppedAfterOpen.
  window.__knDropInputsAfterOpenMs = 0;
  // ASK_UNANSWERED_STALL_MS (the guest page): while performance.now() is before
  // window.__knDropInputsUntil, every input packet (binary, on `lockstep` or
  // `rollback-input`) is dropped: the host's asks for them go unanswered.
  window.__knDropInputsUntil = 0;
  window.__knInputsDroppedUntil = 0;
  // ASK_UNANSWERED_STALL_MS: every input packet whose frame (its first word) is in
  // [__knDropInputFrom, __knDropInputTo) is dropped, for good, resends
  // included, while later frames go through: the peer learns they were made
  // and asks for them, and the asks are never answered.
  window.__knDropInputFrom = -1;
  window.__knDropInputTo = -1;
  // ASK_UNANSWERED_ACK_LOST: until __knDropSettledUntil, the page's
  // acknowledgements of a pushed state are dropped too: `recovery-settled:`
  // (the one that settles a recovery) and `inputs-settled:` (which tells the
  // host not to wait for the frames the state skipped).
  window.__knDropSettledUntil = 0;
  window.__knSettledDropped = 0;
  // ASK_UNANSWERED_ACKS (the host page): until __knDropSyncStateUntil, and only
  // until the host gives up on the guest (its input-ask-push-giveup event),
  // every send on `sync-state` is dropped. The engine hands each state over
  // as usual; the guest never gets one, so it never applies or acknowledges
  // a push and plays on its own frames.
  window.__knDropSyncStateUntil = 0;
  window.__knSyncStateDropped = 0;
  window.__knDropArmedAt = 0;
  window.__knInputsDroppedAfterOpen = [];
  let stateSentAfterArming = 0;
  const firstInputSendAt = new WeakMap();
  // UNANSWERED_SOCKET_RESYNC: each entry of window.__knSyncAnswerDrops is
  // taken by the next numbered answer on `sync-state` (its `sync-answer-id:`
  // message): 'chunks' passes the answer's id and header and drops its
  // binary chunks; 'whole' drops the id, the header and the chunks. Either
  // lasts until the next message that starts a transfer. With
  // __knSyncAnswerDropRepeats set, an answer sent again under an id already
  // dropped whole is dropped whole too, without taking an entry. What was
  // dropped is kept in __knSyncAnswersDropped.
  window.__knSyncAnswerDrops = [];
  window.__knSyncAnswerDropRepeats = false;
  window.__knSyncAnswersDropped = [];
  const syncIdsDroppedWhole = new Set();
  let syncDropping = null;
  let syncIdJustSent = false;
  const syncStateDrops = (data) => {
    if (typeof data === 'string') {
      if (data.startsWith('sync-answer-id:')) {
        const repeat = window.__knSyncAnswerDropRepeats && syncIdsDroppedWhole.has(data);
        syncDropping = repeat ? 'whole' : (window.__knSyncAnswerDrops.shift() ?? null);
        if (syncDropping === 'whole') syncIdsDroppedWhole.add(data);
        syncIdJustSent = true;
        if (syncDropping) window.__knSyncAnswersDropped.push({ answer: data, drop: syncDropping });
        return syncDropping === 'whole';
      }
      if (data.startsWith('sync-start:') || data.startsWith('sync-regions-start:')) {
        if (!syncIdJustSent) syncDropping = null;
        syncIdJustSent = false;
        return syncDropping === 'whole';
      }
      return false;
    }
    return syncDropping !== null;
  };
  // UNANSWERED_SOCKET_RESYNC: while window.__knDropSocketAnswers is above 0,
  // the page's next state answer over the socket (`data-message` of type
  // `sync-state-socket`) is dropped before it reaches the server, and its
  // request number kept. socket.io.min.js assigns window.io as it loads.
  window.__knDropSocketAnswers = 0;
  window.__knSocketAnswersDropped = [];
  // UNANSWERED_SOCKET_RESYNC=ignored (the guest page): while
  // window.__knHoldSocketAnswers is above 0, the next state answer that
  // arrives over the socket is held, and delivered as soon as the last chunk
  // of the next answer on `sync-state` has been handled. Kept in
  // __knSocketAnswersHeld.
  window.__knHoldSocketAnswers = 0;
  window.__knSocketAnswersHeld = [];
  const heldSocketPackets = [];
  let realOnevent = null;
  // And the page's next two decode results (the sync worker's replies) once
  // the held answer is let go are held and delivered back to back in one
  // task: the newest answer's first, then the late one's. A held "now"
  // answer is applied at the next tick, a few ms after its decode; the late
  // answer's base64 decode takes longer than that, so without this it lands
  // after the apply and is only discarded as stale.
  let workerHold = 0;
  const workerHeld = [];
  window.__knWorkerResultsHeld = [];
  const realWorkerOnmessage = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage');
  if (realWorkerOnmessage?.set) {
    Object.defineProperty(Worker.prototype, 'onmessage', {
      configurable: true,
      get() {
        return realWorkerOnmessage.get.call(this);
      },
      set(fn) {
        if (typeof fn !== 'function') {
          realWorkerOnmessage.set.call(this, fn);
          return;
        }
        realWorkerOnmessage.set.call(this, function (e) {
          const d = e?.data;
          if (workerHold > 0 && d && typeof d.id === 'number' && d.data instanceof Uint8Array) {
            workerHeld.push({ self: this, e });
            window.__knWorkerResultsHeld.push({ id: d.id, at: performance.now() });
            if (workerHeld.length >= workerHold) {
              workerHold = 0;
              for (const held of workerHeld.splice(0)) fn.call(held.self, held.e);
            }
            return undefined;
          }
          return fn.call(this, e);
        });
      },
    });
  }
  const releaseHeldSocketAnswers = () => {
    if (heldSocketPackets.length) workerHold = 2;
    while (heldSocketPackets.length) {
      const { socket, packet, record } = heldSocketPackets.shift();
      record.releasedAt = performance.now();
      realOnevent.call(socket, packet);
    }
  };
  let syncChunksLeft = 0;
  const afterSyncStateMessage = (data) => {
    if (typeof data === 'string') {
      if (data.startsWith('sync-start:')) syncChunksLeft = Number(data.split(':')[2]) || 0;
      return;
    }
    if (syncChunksLeft <= 0) return;
    syncChunksLeft--;
    if (syncChunksLeft === 0 && heldSocketPackets.length) releaseHeldSocketAnswers();
  };
  const receiveGate = createDirectionalInputGate({
    now: () => performance.now(),
    target: (ch, slot) =>
      Object.values(window.NetplayRollback?._getPeers?.() ?? {}).some(
        (peer) => peer.slot === slot && (peer.dc === ch || peer.rbDc === ch),
      ),
  });
  window.__knDirectionalInputGate = receiveGate;
  const realOnmessage = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage');
  Object.defineProperty(RTCDataChannel.prototype, 'onmessage', {
    configurable: true,
    get() {
      return realOnmessage.get.call(this);
    },
    set(fn) {
      if (typeof fn !== 'function') {
        realOnmessage.set.call(this, fn);
        return;
      }
      const ch = this;
      realOnmessage.set.call(this, function (e) {
        const result = receiveGate.receive(ch, e.data, (data) =>
          fn.call(this, data === e.data ? e : new MessageEvent('message', { data })),
        );
        if (ch.label === 'sync-state') afterSyncStateMessage(e.data);
        return result;
      });
    },
  });
  Object.defineProperty(window, 'io', {
    configurable: true,
    set(io) {
      const onevent = io?.Socket?.prototype?.onevent;
      if (onevent) {
        realOnevent = onevent;
        io.Socket.prototype.onevent = function (packet) {
          const args = packet?.data;
          if (
            window.__knHoldSocketAnswers > 0 &&
            args?.[0] === 'data-message' &&
            args[1]?.type === 'sync-state-socket'
          ) {
            window.__knHoldSocketAnswers--;
            const record = { requestId: args[1].requestId ?? null, heldAt: performance.now(), releasedAt: null };
            window.__knSocketAnswersHeld.push(record);
            heldSocketPackets.push({ socket: this, packet, record });
            return;
          }
          return onevent.call(this, packet);
        };
      }
      const emit = io?.Socket?.prototype?.emit;
      if (emit) {
        io.Socket.prototype.emit = function (event, data, ...rest) {
          if (window.__knDropSocketAnswers > 0 && event === 'data-message' && data?.type === 'sync-state-socket') {
            window.__knDropSocketAnswers--;
            window.__knSocketAnswersDropped.push(data.requestId ?? null);
            return this;
          }
          return emit.call(this, event, data, ...rest);
        };
      }
      Object.defineProperty(window, 'io', { value: io, writable: true, configurable: true, enumerable: true });
    },
  });
  RTCDataChannel.prototype.send = function (data) {
    if (
      window.__knDropArmedAt > 0 &&
      !stateSentAfterArming &&
      this.label === 'sync-state' &&
      typeof data === 'string' &&
      data.startsWith('sync-start:')
    ) {
      stateSentAfterArming = performance.now();
    }
    if (this.label === 'sync-state' && syncStateDrops(data)) return;
    if (
      this.label === 'sync-state' &&
      performance.now() < window.__knDropSyncStateUntil &&
      !(window.__knEvents ?? []).some((e) => e.meta?.kind === 'input-ask-push-giveup')
    ) {
      window.__knSyncStateDropped++;
      return;
    }
    if (window.__knLoseRbInputs && this.label === 'rollback-input' && data instanceof ArrayBuffer) {
      if (data.byteLength >= 4) window.__knRbInputsLost.push(new Int32Array(data, 0, 1)[0]);
      return;
    }
    if (
      window.__knDropInputsUntil > 0 &&
      performance.now() < window.__knDropInputsUntil &&
      (this.label === 'lockstep' || this.label === 'rollback-input') &&
      data instanceof ArrayBuffer
    ) {
      window.__knInputsDroppedUntil++;
      return;
    }
    if (
      window.__knDropInputTo > window.__knDropInputFrom &&
      (this.label === 'lockstep' || this.label === 'rollback-input') &&
      data instanceof ArrayBuffer &&
      data.byteLength >= 4
    ) {
      const frame = new Int32Array(data, 0, 1)[0];
      if (frame >= window.__knDropInputFrom && frame < window.__knDropInputTo) {
        window.__knInputsDroppedUntil++;
        return;
      }
    }
    if (
      performance.now() < window.__knDropSettledUntil &&
      typeof data === 'string' &&
      (data.startsWith('recovery-settled:') || data.startsWith('inputs-settled:'))
    ) {
      window.__knSettledDropped++;
      return;
    }
    if ((this.label === 'lockstep' || this.label === 'rollback-input') && data instanceof ArrayBuffer) {
      const now = performance.now();
      if (!firstInputSendAt.has(this)) firstInputSendAt.set(this, now);
      const first = firstInputSendAt.get(this);
      if (
        window.__knDropInputsAfterOpenMs > 0 &&
        window.__knDropArmedAt > 0 &&
        first >= window.__knDropArmedAt &&
        (stateSentAfterArming === 0 || now - stateSentAfterArming < window.__knDropInputsAfterOpenMs)
      ) {
        if (data.byteLength >= 4) window.__knInputsDroppedAfterOpen.push(new Int32Array(data, 0, 1)[0]);
        return;
      }
    }
    if (
      this.label === 'sync-state' &&
      typeof data === 'string' &&
      data.startsWith('sync-start:') &&
      Object.values(window.NetplayRollback?._getPeers?.() ?? {}).some(
        (peer) => peer.slot === window.__knWatchSyncTargetSlot && peer.syncDc === this,
      )
    ) {
      (window.__knWatchedSyncHeaders ??= []).push({ frame: Number(data.split(':')[1]), at: performance.now() });
    }
    const ch = scheduleOf(this);
    let hold = 0;
    if (
      window.__knHoldSyncAnswerMs > 0 &&
      this.label === 'sync-state' &&
      typeof data === 'string' &&
      data.startsWith('sync-answer-id:')
    ) {
      hold = window.__knHoldSyncAnswerMs;
      window.__knHoldSyncAnswerMs = 0;
      window.__knSyncAnswersHeld.push({ answer: data, heldAt: performance.now(), ms: hold });
    }
    if (
      window.__knHoldInputsMs > 0 &&
      (this.label === 'lockstep' || this.label === 'rollback-input') &&
      data instanceof ArrayBuffer
    )
      hold = Math.max(hold, window.__knHoldInputsMs);
    if (
      (this.label === 'lockstep' || this.label === 'rollback-input') &&
      data instanceof ArrayBuffer &&
      performance.now() < window.__knHoldInputsUntil
    )
      hold = Math.max(hold, window.__knHoldInputsUntil - performance.now());
    if (
      window.__knInputGate &&
      (this.label === 'lockstep' || this.label === 'rollback-input') &&
      data instanceof ArrayBuffer
    ) {
      gatedInputs.push(() => {
        net.send(ch, data, bytesOf(data), 0, performance.now());
        arm(ch.pumped);
      });
      return;
    }
    net.send(ch, data, bytesOf(data), hold, performance.now());
    arm(ch.pumped);
  };
};

/** Install the simulated network on a browser context: LAT ms plus up to JITTER ms, at kbps (0 = no cap). */
export const addNetworkInitScript = (ctx, { lat, jitter, kbps = 0 }) =>
  ctx.addInitScript({
    content: `(${networkInitScript})(${JSON.stringify({ lat, jitter, kbps })}, ${createLinkSchedule}, ${createDirectionalInputGate});`,
  });
