/**
 * A synthetic second player for the demo page: simulated input, latency,
 * jitter, loss, reordering and congestion spikes. Moved from
 * web/static/fake-peer.js.
 *
 * Once a frame (requestAnimationFrame) it reads the engine's frame counter,
 * makes up P2's input for each new frame, queues it with a delivery time, and
 * hands every packet whose time has come to the engine
 * (`NetplayRollback.injectRemoteInput`). The engine encodes and processes the
 * packet as it would one from a real peer; nothing is encoded here.
 *
 * The delivery times are the simulation itself, not deadlines: a queued
 * packet waits on the page's clock and is delivered from the frame callback.
 * Both are reached through the host, as is the random source, so a test can
 * run the peer on a clock and a generator of its own.
 */
import type { WireInput } from '../input-wire.ts';

const STATS_WINDOW_MS = 5000;
const LAST_SEC_MS = 1000;
const REDUNDANT_FRAMES = 5;
/**
 * RetroArch joypad bits picked from for P2's random inputs in a match.
 * Leaves out:
 *   bit 3 (START): pauses the game / opens the pause menu, derails the demo
 *   bit 10 (L):    Smash Remix has L-bound special actions (taunt panel /
 *                  menu) that disrupt match pacing
 */
const BUTTON_BITS = [0, 1, 4, 5, 6, 7, 11, 12];

/**
 * A spike window is a run of frames where every packet gets extra delivery
 * delay. It has to be longer than REDUNDANT_FRAMES to block the redundancy
 * bypass: a single late packet is pre-empted by the redundant copies in the
 * next on-time one. The real-world analogue is brief network congestion (a
 * ~100 ms queue stall, packets released together).
 *
 * Windows open on a fixed cadence (every ~750 ms), not on P2's input
 * changes. Those vary with the random hold timing, so the spike rate
 * drifted with RTT. A fixed cadence keeps the rollback counter going up
 * predictably as the user moves the slider.
 */
const SPIKE_BURST_FRAMES = 6;
/** ~500 ms at 60fps */
const SPIKE_INTERVAL_FRAMES_MIN = 30;
/** ~1 s at 60fps */
const SPIKE_INTERVAL_FRAMES_MAX = 60;
/**
 * The extra delay of a packet in a spike window: "Wi-Fi interference" or a
 * "cable peak-hour micro-burst", in the range real networks show. Sized so
 * the rollback depth lands where shipping fighters' does (3-7 frames):
 *   slider 0 ms RTT:    depth ~3.6  (under cap=7)
 *   slider 50 ms RTT:   depth ~5.1  (under cap)
 *   slider 100 ms RTT:  depth ~6.6  (under cap, matches GGPO worst-case)
 *   slider 130+ ms RTT: depth ~8+   (exceeds cap, silently drops)
 * The 130+ region is the truthful equivalent of "a 150 ms RTT match where
 * rollback can't keep up": the same happens in real GGPO games on a bad
 * day. 100 ms overshot the cap and produced 167-200 ms freezes out of the
 * engine's burst-1 reply path.
 */
const SPIKE_MS = 60;

/**
 * Stall detection: when the engine's frame counter has not advanced for
 * this many frame callbacks, the peer may schedule past the engine's frame
 * (lookahead). That avoids a deadlock when auto-compare pauses predictions
 * during a latency spike: the engine stalls waiting for missing input, the
 * peer reads the frozen frame and stops scheduling, and ROLLBACK-STALL fires
 * 3 s later. 3 callbacks (~50 ms) is well past normal frame-timing jitter
 * and well under that 3 s.
 */
const STALL_DETECT_FRAMES = 3;
/**
 * How far past the engine's frame the peer may schedule once a stall is
 * detected. Sized so a single 60 ms burst has its queued packets drained
 * and the peer keeps producing through the recovery window. With no stall
 * the lookahead is 0, so the peer's pace matches the engine's frame counter
 * and rollbacks fire as designed.
 */
const STALL_LOOKAHEAD_FRAMES = 6;
/**
 * Normal C-rollback depth is <= 12 frames; the engine's frame going back by
 * more than this means it reset its counter (state load, late join,
 * post-sync transition).
 */
const RESET_BACKWARD_THRESHOLD = 30;

/** One frame of P2's input, as the engine takes it. */
export type PeerInput = WireInput;

/** The simulated network between the peer and the engine. */
export interface FakeNetwork {
  /** One-way travel time added to every packet. */
  latencyMs: number;
  /** Each packet's travel time varies by up to this, either way. */
  jitterMs: number;
  /** Chance that a packet is never delivered. */
  lossProb: number;
  /** Outside a match, with no menu input supplied: chance per frame of a random input. */
  mispredictProb: number;
  /**
   * Chance per packet that its delivery time is swapped with the one queued
   * before it, so the engine sees a later frame arrive first whatever the
   * jitter. The knob for stress-testing the C engine's out-of-order input
   * handling.
   */
  reorderProb: number;
}

/** New values for some of the network's settings; the rest stay as they are. */
export type FakeNetworkChange = { readonly [K in keyof FakeNetwork]?: number | null | undefined };

/** How demo.js starts the peer. */
export interface FakePeerStart {
  /** The player slot the peer plays; 1 unless a whole number is given. */
  readonly slot?: number | undefined;
  /** The engine's frame, used when its HUD counters have none. */
  readonly getCurrentFrame?: (() => number) | null | undefined;
  /**
   * Outside a match: P2's input for an engine frame (the menu autopilot, or a
   * recording), or nothing when there is none for it.
   */
  readonly getMirroredInput?: ((frame: number) => PeerInput | null | undefined) | null | undefined;
}

/** What `getStats` reports: the last five seconds of the simulated network. */
export interface FakePeerStats {
  readonly p95LatenessMs: number;
  readonly queuedPackets: number;
  readonly mispredictsLastSec: number;
  readonly lossLastSec: number;
  readonly reordersLastSec: number;
  readonly spikesLastSec: number;
  readonly maxSpikeMs: number;
}

/** What the demo page reads as `window.KNFakePeer`. A plain object: tests wrap `start`. */
export interface FakePeer {
  start: (options?: FakePeerStart) => void;
  stop: () => void;
  setNetwork: (change?: FakeNetworkChange) => void;
  /**
   * demo.js's word on whether a match is on, which gates the random inputs:
   * true or false to decide it, null to go back to the engine's own
   * scene+status read (`isInMatch`). The demo's state machine is more
   * reliable than SSB64's status value on the results screen, which is not
   * known to leave 1.
   */
  setMatchActive: (active: boolean | null | undefined) => void;
  getStats: () => FakePeerStats;
}

/** One packet as handed to the engine. */
export interface SyntheticPacket {
  readonly slot: number;
  readonly frame: number;
  readonly input: PeerInput;
  readonly ackFrame: number;
  readonly redundantFrames: ReadonlyArray<PeerInput & { readonly frame: number }>;
  /** Round trip, as a real peer would have measured it. */
  readonly observedRttMs: number;
}

/** The engine's HUD counters, as far as the peer reads them. */
interface HudCounters {
  readonly currentFrame?: number | null | undefined;
  readonly delay?: number | null | undefined;
}

/** The part of `window.NetplayRollback` the peer uses. */
export interface FakePeerEngine {
  readonly isInMatch?: (() => boolean) | undefined;
  readonly injectRemoteInput?: ((packet: SyntheticPacket) => boolean | void) | undefined;
  readonly getHudCounters?: (() => HudCounters | null | undefined) | undefined;
  readonly seedSyntheticRtt?:
    | ((seed: { readonly slot: number; readonly rttMs: number; readonly jitterMs: number }) => boolean | void)
    | undefined;
}

/** One frame callback's bookkeeping, pushed to `window.__knFakePeerProbe` when a test put an array there. */
export interface FakePeerProbe {
  readonly t: number;
  readonly engineFrame: number;
  readonly lastSeenFrame: number;
  readonly stallTicks: number;
  readonly lookahead: number;
  readonly scheduledThisTick: number;
  readonly queueLen: number;
}

/** The part of `window` the peer uses. */
export interface FakePeerHost {
  readonly location?: { readonly search?: string } | undefined;
  /** The browser's own timing functions, saved before the engine replaces them. */
  readonly APISandbox?:
    | {
        readonly nativePerfNow?: (() => number) | undefined;
        readonly nativeRAF?: ((callback: () => void) => number) | undefined;
        readonly nativeCancelRAF?: ((id: number) => void) | undefined;
      }
    | undefined;
  readonly performance: { now: () => number };
  requestAnimationFrame: (callback: () => void) => number;
  cancelAnimationFrame: (id: number) => void;
  readonly KNShared?: { readonly N64_MAX?: number | undefined } | undefined;
  readonly NetplayRollback?: FakePeerEngine | undefined;
  /** ?record=p2: the user's live input, published by demo.js each frame. */
  readonly __knDemoP2LiveInput?: PeerInput | null | undefined;
  readonly __knFakePeerProbe?: FakePeerProbe[] | null | undefined;
}

/** What a test may replace. */
export interface FakePeerOptions {
  /** The random source, in [0, 1). The page's `Math.random` unless given. */
  readonly random?: (() => number) | undefined;
}

/** The two diagnostic switches in the page's URL. */
export interface FakePeerUrlFlags {
  /**
   * `?fakePeerJitter=1`: add ±2 units of noise per frame to a held stick
   * value, like an analog stick's ADC noise and hand tremor. Without it the
   * peer holds an exact stick value for a whole hold period, so the C
   * engine's predictor is exact on every match frame.
   */
  readonly jitter: boolean;
  /**
   * `?fakePeerSpikes=0` turns the congestion bursts off, leaving steady
   * latency and jitter: for measuring how much of the rollback cost the
   * demo's deliberate spikes cause against the network itself.
   */
  readonly spikes: boolean;
}

/** Read the diagnostic switches from the URL's query string. */
export const fakePeerUrlFlags = (search: string): FakePeerUrlFlags => {
  const params = new URLSearchParams(search);
  return { jitter: params.get('fakePeerJitter') === '1', spikes: params.get('fakePeerSpikes') !== '0' };
};

/** A network setting kept inside its range; anything that is not a number is 0. */
export const clampSetting = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Number(value) || 0));

/**
 * ±2 units of ADC-style noise from one roll in [0, 1). Leans toward 0 (no
 * noise on about half the frames), so a held value near a zone boundary
 * crosses it on a fraction of frames, as real hardware's tremor does, not on
 * every one.
 */
export const adcJitter = (roll: number): number => {
  if (roll < 0.5) return 0;
  if (roll < 0.75) return 1;
  if (roll < 0.9) return -1;
  if (roll < 0.97) return 2;
  return -2;
};

/** Something that happened on the simulated network, kept for the stats window. */
interface PeerEvent {
  readonly t: number;
  readonly mispredict?: boolean;
  readonly loss?: boolean;
  readonly reorder?: boolean;
  readonly spike?: boolean;
  readonly spikeMs?: number;
  readonly delivered?: boolean;
  readonly lateness?: number;
}

/** A packet waiting for its delivery time. */
interface QueuedPacket {
  readonly frame: number;
  readonly input: PeerInput;
  scheduledDeliveryAt: number;
  readonly enqueuedAt: number;
}

/** An input the peer generated, kept to send again as redundancy. */
interface GeneratedInput {
  readonly frame: number;
  readonly input: PeerInput;
}

/**
 * Make the synthetic peer for a page. Nothing runs until `start`. The
 * browser's timing functions are taken here, when the script loads, before
 * the engine replaces them.
 */
export const startFakePeer = (host: FakePeerHost, options: FakePeerOptions = {}): FakePeer => {
  const random = options.random ?? (() => Math.random());
  let jitterEnabled = false;
  let spikesEnabled = true;
  try {
    const flags = fakePeerUrlFlags(host.location?.search || '');
    jitterEnabled = flags.jitter;
    spikesEnabled = flags.spikes;
  } catch {
    /* a query string that cannot be read leaves both switches as they are */
  }
  const nativeNow = host.APISandbox?.nativePerfNow || host.performance.now.bind(host.performance);
  const nativeRAF = host.APISandbox?.nativeRAF || host.requestAnimationFrame.bind(host);
  const nativeCancelRAF = host.APISandbox?.nativeCancelRAF || host.cancelAnimationFrame.bind(host);

  let running = false;
  let rafId = 0;
  let slot = 1;
  let getCurrentFrame: () => number = () => 0;
  // Supplied by demo.js: P2's input for an engine frame outside a match, so
  // P2's cursor makes its character selection on the menus.
  let getMirroredInput: ((frame: number) => PeerInput | null | undefined) | null = null;
  // null: ask the engine (`isInMatch`). true/false: demo.js has decided.
  let matchActiveOverride: boolean | null = null;
  // The last in-match decision, so the held random input is dropped when a
  // match ends: a stale held button or stick would otherwise leak into the
  // next match's first 30-90 frames, until its hold ran out.
  let lastInMatch = false;
  let lastSeenFrame = -1;
  let lastEngineFrameSeen = -1;
  let queue: QueuedPacket[] = [];
  let inputHistory: GeneratedInput[] = [];
  let events: PeerEvent[] = [];
  let network: FakeNetwork = {
    latencyMs: 80,
    jitterMs: 8,
    lossProb: 0.02,
    mispredictProb: 0.08,
    reorderProb: 0,
  };

  const now = (): number => nativeNow();

  const zeroInput = (): PeerInput => ({ buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 });

  const randomAxis = (): number => {
    const max = host.KNShared?.N64_MAX ?? 83;
    const mag = Math.max(18, Math.round((0.35 + random() * 0.65) * max));
    return random() < 0.5 ? -mag : mag;
  };

  const randomInput = (): PeerInput => {
    if (random() < 0.65) {
      const bit = BUTTON_BITS[Math.floor(random() * BUTTON_BITS.length)] ?? 0;
      return { buttons: 1 << bit, lx: 0, ly: 0, cx: 0, cy: 0 };
    }
    if (random() < 0.5) {
      return { buttons: 0, lx: randomAxis(), ly: randomAxis(), cx: 0, cy: 0 };
    }
    return { buttons: 0, lx: 0, ly: 0, cx: randomAxis(), cy: randomAxis() };
  };

  // In a match P2 holds each random input for several frames before
  // changing, so it acts like a player making decisions, not a key masher.
  // The engine predicts each frame as the one before, so every change is a
  // misprediction and a rollback: that is what the demo's Rollbacks counter
  // shows.
  let heldRandomInput: PeerInput | null = null;
  let heldUntilFrame = -1;

  const applyJitter = (input: PeerInput): PeerInput => {
    if (!jitterEnabled) return input;
    // A frame with every axis at rest is left alone: ADC noise is only there
    // when the stick is pushed off-centre, and noise on a centred stick
    // would make divergence the demo does not mean to show.
    if (input.lx === 0 && input.ly === 0 && input.cx === 0 && input.cy === 0) return input;
    return {
      buttons: input.buttons,
      lx: input.lx ? input.lx + adcJitter(random()) : 0,
      ly: input.ly ? input.ly + adcJitter(random()) : 0,
      cx: input.cx ? input.cx + adcJitter(random()) : 0,
      cy: input.cy ? input.cy + adcJitter(random()) : 0,
    };
  };

  let spikeWindowEnd = -1;
  let nextSpikeAtFrame = -1;

  const matchInputForFrame = (frame: number): PeerInput => {
    if (frame > heldUntilFrame || !heldRandomInput) {
      heldRandomInput = randomInput();
      // Held 30-90 frames (~500ms-1.5s): close to how long a person holds a
      // button (run, charge, neutral).
      heldUntilFrame = frame + 30 + Math.floor(random() * 60);
    }
    return applyJitter(heldRandomInput);
  };

  /** Open a new spike window when one is due. */
  const maybeOpenSpikeWindow = (frame: number): void => {
    if (!spikesEnabled) return;
    if (nextSpikeAtFrame < 0) {
      nextSpikeAtFrame =
        frame +
        SPIKE_INTERVAL_FRAMES_MIN +
        Math.floor(random() * (SPIKE_INTERVAL_FRAMES_MAX - SPIKE_INTERVAL_FRAMES_MIN));
      return;
    }
    if (frame >= nextSpikeAtFrame && frame > spikeWindowEnd) {
      spikeWindowEnd = frame + SPIKE_BURST_FRAMES - 1;
      nextSpikeAtFrame =
        frame +
        SPIKE_INTERVAL_FRAMES_MIN +
        Math.floor(random() * (SPIKE_INTERVAL_FRAMES_MAX - SPIKE_INTERVAL_FRAMES_MIN));
    }
  };

  const pruneEvents = (at: number): void => {
    for (let first = events[0]; first !== undefined && at - first.t > STATS_WINDOW_MS; first = events[0]) {
      events.shift();
    }
  };

  const recordEvent = (event: Omit<PeerEvent, 't'>): void => {
    const at = now();
    events.push({ t: at, ...event });
    pruneEvents(at);
  };

  const recordGeneratedInput = (frame: number, input: PeerInput): void => {
    inputHistory.push({ frame, input });
    while (inputHistory.length > 30) inputHistory.shift();
  };

  const redundantForFrame = (frame: number): Array<PeerInput & { frame: number }> =>
    inputHistory
      .filter((entry) => entry.frame < frame)
      .slice(-REDUNDANT_FRAMES)
      .map((entry) => ({ frame: entry.frame, ...entry.input }));

  /** Make up P2's input for a frame and queue its packet (or lose it). */
  const scheduleFrame = (frame: number, at: number): void => {
    // ?record=p2: the user's live input is P2's, whatever else is going on,
    // so the user steers P2's cursor while P1 follows the autopilot.
    const liveP2 = host.__knDemoP2LiveInput;
    let input: PeerInput;
    if (liveP2) {
      input = {
        buttons: liveP2.buttons | 0,
        lx: liveP2.lx | 0,
        ly: liveP2.ly | 0,
        cx: liveP2.cx | 0,
        cy: liveP2.cy | 0,
      };
    } else {
      // In a match, P2 plays held random inputs. Outside one (title, menus,
      // results, between matches) demo.js supplies P2's menu input through
      // getMirroredInput; with none supplied the peer sends neutral, or a
      // random input with chance mispredictProb.
      const inMatch = matchActiveOverride !== null ? !!matchActiveOverride : !!host.NetplayRollback?.isInMatch?.();
      if (inMatch !== lastInMatch) {
        heldRandomInput = null;
        heldUntilFrame = -1;
        lastInMatch = inMatch;
      }
      if (inMatch) {
        input = matchInputForFrame(frame);
        // Without spikes the simulated jitter never pushes an arrival past
        // the frame it applies to (the input delay covers RTT/2 + jitter),
        // so no rollback would ever fire.
        maybeOpenSpikeWindow(frame);
      } else if (getMirroredInput) {
        const mirrored = getMirroredInput(frame);
        input = mirrored || zeroInput();
      } else {
        const mispredict = random() < network.mispredictProb;
        input = mispredict ? randomInput() : zeroInput();
        if (mispredict) recordEvent({ mispredict: true });
      }
    }
    recordGeneratedInput(frame, input);

    if (random() < network.lossProb) {
      recordEvent({ loss: true });
      return;
    }

    const jitter = network.jitterMs > 0 ? (random() * 2 - 1) * network.jitterMs : 0;
    // Every packet in the spike window is late, primary and redundant
    // copies alike, so the engine really has to predict, and rolls back
    // when the late burst arrives.
    let spikeMs = 0;
    if (network.latencyMs > 0 && frame <= spikeWindowEnd) {
      spikeMs = SPIKE_MS;
      if (frame === spikeWindowEnd) {
        recordEvent({ spike: true, spikeMs: Math.round(spikeMs) });
      }
    }
    const newEntry: QueuedPacket = {
      frame,
      input,
      scheduledDeliveryAt: at + Math.max(0, network.latencyMs + jitter + spikeMs),
      enqueuedAt: at,
    };
    const prev = queue[queue.length - 1];
    if (network.reorderProb > 0 && prev !== undefined && random() < network.reorderProb) {
      const tmp = prev.scheduledDeliveryAt;
      prev.scheduledDeliveryAt = newEntry.scheduledDeliveryAt;
      newEntry.scheduledDeliveryAt = tmp;
      recordEvent({ reorder: true });
    }
    queue.push(newEntry);
  };

  const injectNow = (frame: number, input: PeerInput, observedRttMs: number): boolean =>
    !!host.NetplayRollback?.injectRemoteInput?.({
      slot,
      frame,
      input,
      ackFrame: Math.max(-1, lastEngineFrameSeen - 1),
      redundantFrames: redundantForFrame(frame),
      observedRttMs,
    });

  /** Hand the engine every queued packet whose delivery time has come, earliest first. */
  const drainQueue = (at: number): void => {
    const due: QueuedPacket[] = [];
    const pending: QueuedPacket[] = [];
    for (const entry of queue) {
      if (entry.scheduledDeliveryAt <= at) due.push(entry);
      else pending.push(entry);
    }
    queue = pending;
    due.sort((a, b) => a.scheduledDeliveryAt - b.scheduledDeliveryAt || a.frame - b.frame);

    for (const entry of due) {
      const hud = host.NetplayRollback?.getHudCounters?.();
      const engineFrameAtDelivery = Math.max(0, Math.trunc(Number(hud?.currentFrame) || lastEngineFrameSeen));
      const delay = Math.max(0, Math.trunc(Number(hud?.delay) || 0));
      const frameLateness = Math.max(0, engineFrameAtDelivery - delay - entry.frame);
      // The engine is told a round trip: twice the one-way latency the
      // delivery schedule applies, which is what a real peer's ping would
      // have measured.
      const accepted = injectNow(entry.frame, entry.input, network.latencyMs * 2);
      recordEvent({
        delivered: !!accepted,
        lateness: frameLateness * (1000 / 60),
      });
    }
  };

  let stallTickCount = 0;
  let lastEngineFrameSeenForStall = -1;

  /** One frame callback: schedule the new frames, deliver what is due, ask for the next callback. */
  const tick = (): void => {
    if (!running) return;
    const at = now();
    const hud = host.NetplayRollback?.getHudCounters?.();
    const engineFrame = Math.max(0, Math.trunc(Number(hud?.currentFrame ?? getCurrentFrame()) || 0));
    lastEngineFrameSeen = engineFrame;

    // First callback, or the engine reset its frame counter: drop the
    // packets in flight and start again from the engine's frame.
    const isReset = lastSeenFrame >= 0 && lastSeenFrame - engineFrame > RESET_BACKWARD_THRESHOLD;
    if (lastSeenFrame < 0 || isReset) {
      lastSeenFrame = Math.max(-1, engineFrame - 1);
      queue = [];
      inputHistory = [];
    }

    // An engine stall is callbacks in a row with no frame advance.
    if (engineFrame === lastEngineFrameSeenForStall) {
      stallTickCount++;
    } else {
      stallTickCount = 0;
      lastEngineFrameSeenForStall = engineFrame;
    }
    // One input per callback in normal play, at the engine's pace. Past
    // STALL_DETECT_FRAMES of stall, up to STALL_LOOKAHEAD_FRAMES ahead of
    // the engine: with no lookahead a paused-predictions stall deadlocks
    // (the engine waits for input, the peer waits for the frame to move);
    // with unlimited lookahead every remote input is already there and
    // rollbacks never fire, which is what the demo is for.
    const lookahead = stallTickCount >= STALL_DETECT_FRAMES ? STALL_LOOKAHEAD_FRAMES : 0;
    const lookaheadCap = engineFrame + lookahead;
    const targetFrame = Math.max(engineFrame, Math.min(lastSeenFrame + 1, lookaheadCap));
    let scheduledThisTick = 0;
    for (let frame = lastSeenFrame + 1; frame <= targetFrame; frame++) {
      scheduleFrame(frame, at);
      scheduledThisTick++;
    }
    lastSeenFrame = Math.max(lastSeenFrame, targetFrame);
    drainQueue(at);
    const probe = host.__knFakePeerProbe;
    if (probe) {
      probe.push({
        t: at,
        engineFrame,
        lastSeenFrame,
        stallTicks: stallTickCount,
        lookahead,
        scheduledThisTick,
        queueLen: queue.length,
      });
      if (probe.length > 4_000) probe.shift();
    }
    rafId = nativeRAF(tick);
  };

  const stop = (): void => {
    running = false;
    if (rafId) nativeCancelRAF(rafId);
    rafId = 0;
    queue = [];
    inputHistory = [];
    events = [];
    getMirroredInput = null;
    heldRandomInput = null;
    heldUntilFrame = -1;
    matchActiveOverride = null;
    lastInMatch = false;
  };

  const start = (how: FakePeerStart = {}): void => {
    stop();
    const wanted = how.slot === undefined ? 1 : how.slot;
    slot = Number.isInteger(wanted) ? wanted : 1;
    getCurrentFrame = typeof how.getCurrentFrame === 'function' ? how.getCurrentFrame : () => 0;
    getMirroredInput = typeof how.getMirroredInput === 'function' ? how.getMirroredInput : null;
    const currentFrame = Math.max(0, Math.trunc(Number(getCurrentFrame()) || 0));
    lastEngineFrameSeen = currentFrame;
    lastSeenFrame = -1;
    matchActiveOverride = null;
    lastInMatch = false;
    running = true;
    rafId = nativeRAF(tick);
  };

  const setNetwork = (change: FakeNetworkChange = {}): void => {
    network = {
      latencyMs: clampSetting(change.latencyMs ?? network.latencyMs, 0, 300),
      jitterMs: clampSetting(change.jitterMs ?? network.jitterMs, 0, 100),
      lossProb: clampSetting(change.lossProb ?? network.lossProb, 0, 0.3),
      mispredictProb: clampSetting(change.mispredictProb ?? network.mispredictProb, 0, 0.5),
      reorderProb: clampSetting(change.reorderProb ?? network.reorderProb, 0, 0.5),
    };
    // The engine's delay negotiation at match start reads the peer's RTT
    // samples; a real peer fills them from pings. Seeding them here is what
    // makes the simulated latency reach the delay budget: without it every
    // demo session runs at the default delay whatever the slider says, and
    // the rollback rate is artificially high.
    try {
      host.NetplayRollback?.seedSyntheticRtt?.({
        slot,
        rttMs: network.latencyMs * 2,
        // A round-trip ping sees the one-way jitter on each leg, so about
        // twice jitterMs.
        jitterMs: network.jitterMs * 2,
      });
    } catch {
      /* an engine that cannot take the samples yet negotiates without them */
    }
  };

  const getStats = (): FakePeerStats => {
    const at = now();
    pruneEvents(at);
    const lateness: number[] = [];
    for (const event of events) {
      if (event.lateness !== undefined && Number.isFinite(event.lateness)) lateness.push(event.lateness);
    }
    lateness.sort((a, b) => a - b);
    const p95Index = lateness.length > 0 ? Math.floor((lateness.length - 1) * 0.95) : -1;
    const recent = events.filter((event) => at - event.t <= LAST_SEC_MS);
    let maxSpikeMs = 0;
    for (const event of events) {
      if (event.spikeMs) maxSpikeMs = Math.max(maxSpikeMs, event.spikeMs);
    }
    return {
      p95LatenessMs: (p95Index >= 0 ? lateness[p95Index] : 0) ?? 0,
      queuedPackets: queue.length,
      mispredictsLastSec: recent.filter((event) => event.mispredict).length,
      lossLastSec: recent.filter((event) => event.loss).length,
      reordersLastSec: recent.filter((event) => event.reorder).length,
      spikesLastSec: recent.filter((event) => event.spike).length,
      maxSpikeMs,
    };
  };

  const setMatchActive = (active: boolean | null | undefined): void => {
    matchActiveOverride = active === null || active === undefined ? null : !!active;
    // When demo.js says the match is over, the held random input goes (so a
    // stale button-hold cannot play again if a match starts), and so do the
    // packets in flight: random inputs scheduled during the match, still
    // waiting out their latency, would otherwise reach the engine after the
    // match has visibly ended.
    if (matchActiveOverride === false) {
      heldRandomInput = null;
      heldUntilFrame = -1;
      lastInMatch = false;
      queue = [];
    }
  };

  return { start, stop, setNetwork, setMatchActive, getStats };
};

declare global {
  interface Window {
    KNFakePeer?: FakePeer;
  }
}
