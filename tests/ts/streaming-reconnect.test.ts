import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import vm from 'node:vm';
import { newPageId, readAttemptId } from '../../web/src/attempt-id.ts';
import * as streamingAttempt from '../../web/src/streaming/attempt.ts';
import { createStreamingObserver } from '../../web/src/streaming/observe.ts';
import * as streamingReoffer from '../../web/src/streaming/reoffer.ts';
import * as streamingRoster from '../../web/src/streaming/roster.ts';
import * as streamingSignal from '../../web/src/streaming/signal.ts';

// web/static/netplay-streaming.js itself, run on a fake page whose socket and
// WebRTC record what the engine does: the host's deadline to offer again, and
// which connection each signal reaches (specs/streaming_connection.qnt,
// streaming_connection_current). The rules themselves are tested in
// streaming-attempt.test.ts; this is the engine's use of them.

const ENGINE = readFileSync(new URL('../../web/static/netplay-streaming.js', import.meta.url), 'utf8');

/** The host's deadline in these tests, in place of 10 s. */
const DEADLINE_MS = 40;

interface Attempt {
  readonly page: string;
  readonly attempt: number;
}

/** A `webrtc-signal` as a page sends it, or as the server relays it (`sender` is the server's). */
interface Signal {
  readonly target?: string;
  readonly sender?: string;
  readonly offer?: RTCSessionDescriptionInit;
  readonly answer?: RTCSessionDescriptionInit;
  readonly candidate?: RTCIceCandidateInit;
  readonly attemptId?: Attempt;
}

interface RosterMessage {
  readonly players: Readonly<Record<string, { readonly socketId: string; readonly slot: number }>>;
  readonly spectators: Readonly<Record<string, { readonly socketId: string }>>;
}

type Handler = (data: Signal | RosterMessage) => void;

interface FakeSocket {
  readonly id: string;
  on: (event: string, handler: Handler) => void;
  off: (event: string) => void;
  emit: (event: string, data: Signal) => void;
}

class FakeChannel {
  readyState = 'connecting';
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
  }
}

class FakePc {
  signalingState = 'stable';
  connectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  closed = false;
  channel: FakeChannel | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: (() => void) | null = null;
  ondatachannel: ((event: { channel: FakeChannel }) => void) | null = null;
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (description.type === 'answer' && this.signalingState !== 'have-local-offer') {
      throw new Error('InvalidStateError: no offer waits for this answer');
    }
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  createDataChannel(): FakeChannel {
    this.channel = new FakeChannel();
    return this.channel;
  }
  addTrack(): void {}
  getSenders(): readonly [] {
    return [];
  }
  getReceivers(): readonly [] {
    return [];
  }
  close(): void {
    this.closed = true;
    this.channel?.close();
  }
}

interface FakePeer {
  pc: FakePc;
  dc: FakeChannel | null;
  slot: number | null;
  attempt?: Attempt | null;
  pendingCandidates: RTCIceCandidateInit[];
  remoteDescSet: boolean;
  /** The connection gathers a candidate: it goes out through the socket the peer was made with. */
  gather: () => void;
}

interface FakeKNState {
  DEFAULT_ICE_SERVERS: readonly RTCIceServer[];
  uploadToken: string;
  peers?: Readonly<Record<string, FakePeer>>;
}

/** What a client event carries beside its type and message. */
interface ReportMeta {
  readonly old?: string;
  readonly next?: string;
}

interface FakeInput {
  readonly buttons: number;
  readonly lx: number;
  readonly ly: number;
  readonly cx: number;
  readonly cy: number;
}

interface FakeShared {
  createSyncLogRing: () => { push: () => void; export: () => readonly []; clear: () => void };
  createBasePeer: (ice: readonly RTCIceServer[], remoteSid: string, signalSocket: FakeSocket) => FakePeer;
  drainCandidates: (peer: FakePeer) => Promise<void>;
  createAndSendAnswer: (pc: FakePc, socket: FakeSocket, target: string, attemptId?: Attempt | null) => Promise<void>;
  addBufferedCandidate: (peer: FakePeer, candidate: RTCIceCandidateInit) => Promise<void>;
  setupKeyTracking: () => null;
  applyInputToWasm: () => void;
  readLocalInput: () => FakeInput;
  inputEqual: () => boolean;
  teardownKeyTracking: () => void;
  bootWithCheats: () => void;
  encodeInput: () => Int32Array;
  ZERO_INPUT: FakeInput;
}

class FakeDescription {
  constructor(description: RTCSessionDescriptionInit) {
    Object.assign(this, description);
  }
}

interface EngineApi {
  init: (config: {
    socket: FakeSocket;
    playerSlot: number;
    isSpectator: boolean;
    initialPlayers: RosterMessage | null;
    onStatus: (text: string) => void;
  }) => void;
  stop: () => void;
  observed: () => { compared: Record<string, number>; disagreed: number; failed: number };
}

/** Every engine a test started. Each is stopped after its test, passed or failed, so no deadline outlives it. */
const started: EngineApi[] = [];
afterEach(() => {
  for (const engine of started.splice(0)) engine.stop();
});

const STREAMING = {
  ...streamingRoster,
  ...streamingSignal,
  ...streamingAttempt,
  ...streamingReoffer,
  startReofferDeadlines: (options: streamingReoffer.ReofferOptions) =>
    streamingReoffer.startReofferDeadlines({ ...options, delayMs: () => DEADLINE_MS }),
  createObserver: createStreamingObserver,
};

/** The page's global object: what the engine reads from it, and what it leaves there. */
interface FakeWindow {
  window?: FakeWindow;
  NetplayStreaming?: EngineApi;
  console: { log: (line: string) => void };
  performance: Performance;
  queueMicrotask: (run: () => void) => void;
  AbortController: typeof AbortController;
  addEventListener: () => void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  RTCSessionDescription: typeof FakeDescription;
  document: { getElementById: () => null; querySelector: () => null; addEventListener: () => void };
  KNState: FakeKNState;
  KNEvent: (type: string, message: string, meta?: ReportMeta) => void;
  KNStorage: { get: () => null };
  KNShared: FakeShared;
  KNCore: {
    streaming: typeof STREAMING;
    attemptId: { newPageId: typeof newPageId; readAttemptId: typeof readAttemptId };
  };
}

const ZERO: FakeInput = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };

/** A page running the engine, whose own socket is `sid`. */
const page = (sid: string) => {
  const handlers = new Map<string, Handler>();
  const sent: Signal[] = [];
  const logs: string[] = [];
  const statuses: string[] = [];
  const reports: string[] = [];
  const knState: FakeKNState = { DEFAULT_ICE_SERVERS: [], uploadToken: 'token' };
  const socket: FakeSocket = {
    id: sid,
    on: (event, handler) => handlers.set(event, handler),
    off: (event) => handlers.delete(event),
    emit: (event, data) => {
      if (event === 'webrtc-signal') sent.push(data);
    },
  };
  const window: FakeWindow = {
    console: { log: (line: string) => logs.push(line) },
    performance,
    queueMicrotask,
    AbortController,
    addEventListener: () => undefined,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    RTCSessionDescription: FakeDescription,
    document: { getElementById: () => null, querySelector: () => null, addEventListener: () => undefined },
    KNState: knState,
    KNEvent: (type, message, meta) => reports.push(`${type} ${message} ${JSON.stringify(meta)}`),
    KNStorage: { get: () => null },
    KNShared: {
      createSyncLogRing: () => ({ push: () => undefined, export: () => [], clear: () => undefined }),
      // As the real one: the connection's candidates go out through the socket it is given.
      createBasePeer: (_ice, remoteSid, signalSocket) => {
        const pc = new FakePc();
        return {
          pc,
          dc: null,
          slot: null,
          pendingCandidates: [],
          remoteDescSet: false,
          gather: () => signalSocket.emit('webrtc-signal', { target: remoteSid, candidate: { candidate: 'c' } }),
        };
      },
      drainCandidates: async (peer) => {
        peer.remoteDescSet = true;
      },
      createAndSendAnswer: async (pc, _socket, target, attemptId) => {
        await pc.setLocalDescription({ type: 'answer', sdp: 'v=0\r\n' });
        sent.push(
          attemptId ? { target, answer: { type: 'answer' }, attemptId } : { target, answer: { type: 'answer' } },
        );
      },
      addBufferedCandidate: async (peer, candidate) => {
        peer.pendingCandidates.push(candidate);
      },
      setupKeyTracking: () => null,
      applyInputToWasm: () => undefined,
      readLocalInput: () => ZERO,
      inputEqual: () => true,
      teardownKeyTracking: () => undefined,
      bootWithCheats: () => undefined,
      encodeInput: () => new Int32Array(6),
      ZERO_INPUT: ZERO,
    },
    KNCore: { streaming: STREAMING, attemptId: { newPageId, readAttemptId } },
  };
  window.window = window;
  vm.runInNewContext(ENGINE, window);
  const engine = window.NetplayStreaming;
  assert.ok(engine);
  started.push(engine);
  const peers = () => knState.peers ?? {};
  return {
    engine,
    sent,
    statuses,
    reports,
    peers,
    /** The engine's own log lines that mention `text`. */
    logged: (text: string) => logs.filter((line) => line.includes(text)),
    start: (slot: number, roster: RosterMessage) =>
      engine.init({
        socket,
        playerSlot: slot,
        isSpectator: false,
        initialPlayers: roster,
        onStatus: (text) => statuses.push(text),
      }),
    signal: (data: Signal) => handlers.get('webrtc-signal')?.(data),
    roster: (data: RosterMessage) => handlers.get('users-updated')?.(data),
  };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ROOM: RosterMessage = {
  players: { a: { socketId: 'host', slot: 0 }, b: { socketId: 'p2', slot: 1 } },
  spectators: {},
};
const ALONE: RosterMessage = { players: { a: { socketId: 'host', slot: 0 } }, spectators: {} };

const offersTo = (sent: readonly Signal[], target: string) => sent.filter((s) => s.target === target && s.offer);
const attemptsOf = (signals: readonly Signal[]) => signals.map((s) => s.attemptId?.attempt ?? 0);

test('the host names each connection it offers, and its candidates carry the name', async () => {
  const host = page('host');
  host.start(0, ROOM);
  await settle();
  const [offer] = offersTo(host.sent, 'p2');
  assert.ok(offer?.attemptId, 'the offer names its connection');
  assert.equal(offer.attemptId.attempt, 1);
  assert.ok(offer.attemptId.page.length > 0);
  host.peers()['p2']?.gather();
  const candidate = host.sent.find((s) => s.candidate);
  assert.deepEqual(candidate?.attemptId, offer.attemptId);
  host.engine.stop();
});

test('a lost offer is offered again on a new connection at the deadline, until the channel opens', async () => {
  const host = page('host');
  host.start(0, ROOM);
  await settle();
  const first = host.peers()['p2'];
  assert.ok(first);
  await wait(DEADLINE_MS * 2.6);
  // Two deadlines passed with no answer: two new connections, each offered with a newer name.
  const offers = offersTo(host.sent, 'p2');
  assert.ok(offers.length >= 3, `offers: ${JSON.stringify(attemptsOf(offers))}`);
  assert.deepEqual(attemptsOf(offers).slice(0, 3), [1, 2, 3]);
  assert.ok(first.pc.closed, 'the replaced connection is closed');
  assert.ok(host.logged('STREAM-REOFFER p2 try=1').length === 1);

  // The guest answers the latest offer; its channel opens and nothing is offered again.
  const latest = host.peers()['p2'];
  assert.ok(latest?.attempt);
  host.signal({ sender: 'p2', answer: { type: 'answer', sdp: 'v=0\r\n' }, attemptId: latest.attempt });
  await settle();
  assert.equal(latest.pc.signalingState, 'stable');
  latest.dc?.open();
  const count = offersTo(host.sent, 'p2').length;
  await wait(DEADLINE_MS * 2.5);
  assert.equal(offersTo(host.sent, 'p2').length, count);
  assert.equal(host.engine.observed().disagreed, 0, host.reports.join('\n'));
  host.engine.stop();
});

test("the host drops the answer to an offer it replaced and takes the one to its connection's", async () => {
  const host = page('host');
  host.start(0, ROOM);
  await settle();
  await wait(DEADLINE_MS * 1.5);
  const current = host.peers()['p2'];
  assert.equal(current?.attempt?.attempt, 2);
  const page1 = { page: current.attempt.page, attempt: 1 };
  host.signal({ sender: 'p2', answer: { type: 'answer' }, attemptId: page1 });
  await settle();
  assert.equal(current.pc.signalingState, 'have-local-offer', 'the old answer was not applied');
  assert.equal(host.logged('dropped answer from p2').length, 1);
  host.signal({ sender: 'p2', answer: { type: 'answer' }, attemptId: current.attempt });
  await settle();
  assert.equal(current.pc.signalingState, 'stable');
  assert.equal(host.engine.observed().disagreed, 0, host.reports.join('\n'));
  host.engine.stop();
});

test('a connection that drops is offered again, and nothing is once the roster stops listing the member', async () => {
  const host = page('host');
  host.start(0, ROOM);
  await settle();
  const first = host.peers()['p2'];
  assert.ok(first?.attempt);
  host.signal({ sender: 'p2', answer: { type: 'answer' }, attemptId: first.attempt });
  await settle();
  first.dc?.open();
  // The channel closes (the network dropped the connection): the host forgets the guest...
  first.dc?.close();
  assert.equal(host.peers()['p2'], undefined);
  // ...and offers again at its deadline.
  await wait(DEADLINE_MS * 1.5);
  const offers = offersTo(host.sent, 'p2');
  assert.deepEqual(attemptsOf(offers).slice(0, 2), [1, 2]);

  // The guest leaves: the roster no longer lists it, and the waits end.
  host.roster(ALONE);
  const count = offersTo(host.sent, 'p2').length;
  await wait(DEADLINE_MS * 3);
  assert.equal(offersTo(host.sent, 'p2').length, count);
  host.engine.stop();
});

test('stop() ends the deadlines: nothing is offered after the match', async () => {
  const host = page('host');
  host.start(0, ROOM);
  await settle();
  host.engine.stop();
  const count = host.sent.length;
  await wait(DEADLINE_MS * 3);
  assert.equal(host.sent.length, count);
});

test("a guest replaces its connection for the host's newer offer, and drops an older one and the old candidates", async () => {
  const guest = page('p2');
  guest.start(1, ROOM);
  // Signals come as socket events, after the roster init handled.
  await settle();
  const name = (attempt: number): Attempt => ({ page: 'hostpage', attempt });
  const offer = (attempt: number): Signal => ({
    sender: 'host',
    offer: { type: 'offer', sdp: 'v=0\r\n' },
    attemptId: name(attempt),
  });

  guest.signal(offer(1));
  await settle();
  const first = guest.peers()['host'];
  assert.deepEqual(first?.attempt, name(1));
  assert.deepEqual(guest.sent.at(-1)?.attemptId, name(1), 'the answer names the connection');

  // The host made a new connection: the guest closes the old one and answers from a new one.
  guest.signal(offer(2));
  await settle();
  const second = guest.peers()['host'];
  assert.notEqual(second, first);
  assert.ok(first.pc.closed);
  assert.deepEqual(second?.attempt, name(2));
  assert.deepEqual(guest.sent.at(-1)?.attemptId, name(2));

  // The first offer, late: dropped; the guest keeps the newer connection and sends nothing.
  const answers = guest.sent.length;
  guest.signal(offer(1));
  await settle();
  assert.equal(guest.peers()['host'], second);
  assert.equal(guest.sent.length, answers);

  // A candidate for the old connection does not reach the new one; one for it does.
  guest.signal({ sender: 'host', candidate: { candidate: 'old' }, attemptId: name(1) });
  guest.signal({ sender: 'host', candidate: { candidate: 'new' }, attemptId: name(2) });
  await settle();
  assert.deepEqual(
    second.pendingCandidates.map((c) => c.candidate),
    ['new'],
  );

  // The same offer again (the host's renegotiation) is applied to the connection held.
  guest.signal(offer(2));
  await settle();
  assert.equal(guest.peers()['host'], second);
  assert.equal(guest.engine.observed().disagreed, 0, guest.reports.join('\n'));
  assert.deepEqual(guest.reports, []);
  guest.engine.stop();
});

test('a guest whose connection to the host drops says it is reconnecting', async () => {
  const guest = page('p2');
  guest.start(1, ROOM);
  // Signals come as socket events, after the roster init handled.
  await settle();
  guest.signal({ sender: 'host', offer: { type: 'offer', sdp: 'v=0\r\n' }, attemptId: { page: 'h', attempt: 1 } });
  await settle();
  const peer = guest.peers()['host'];
  assert.ok(peer);
  peer.pc.ondatachannel?.({ channel: new FakeChannel() });
  peer.dc?.open();
  peer.dc?.close();
  assert.equal(guest.peers()['host'], undefined);
  assert.ok(
    guest.statuses.some((status) => status.includes('reconnecting')),
    JSON.stringify(guest.statuses),
  );
  guest.engine.stop();
});

test('signals that name no connection, from a page from before, are handled as before', async () => {
  const guest = page('p2');
  guest.start(1, ROOM);
  // Signals come as socket events, after the roster init handled.
  await settle();
  guest.signal({ sender: 'host', offer: { type: 'offer', sdp: 'v=0\r\n' } });
  await settle();
  const first = guest.peers()['host'];
  assert.ok(first);
  assert.equal(guest.sent.at(-1)?.attemptId, undefined, 'the answer names nothing either');
  guest.signal({ sender: 'host', offer: { type: 'offer', sdp: 'v=0\r\n' } });
  guest.signal({ sender: 'host', candidate: { candidate: 'x' } });
  await settle();
  assert.equal(guest.peers()['host'], first, 'a second offer renegotiates the connection held');
  assert.deepEqual(
    first.pendingCandidates.map((c) => c.candidate),
    ['x'],
  );
  assert.equal(guest.engine.observed().disagreed, 0, guest.reports.join('\n'));
  guest.engine.stop();
});
