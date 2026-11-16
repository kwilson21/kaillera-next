import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import * as streamingRoster from '../../web/src/streaming/roster.ts';
import * as streamingSignal from '../../web/src/streaming/signal.ts';
import * as streamingVideo from '../../web/src/streaming/video.ts';
import * as streamingInput from '../../web/src/streaming/input.ts';

// web/static/netplay-streaming.js itself, run on a fake page whose socket,
// WebRTC and bundle helpers record what the engine does with them: which
// offers a page that receives the stream answers, which it holds for a
// roster, and that stop() forgets what it held. The rule itself is tested in
// streaming-signal.test.ts; this is the engine's use of it.

const ENGINE = readFileSync(new URL('../../web/static/netplay-streaming.js', import.meta.url), 'utf8');

/** A `webrtc-signal` as the server relays it: `sender` is the server's. */
interface SignalMessage {
  readonly sender: string;
  readonly target: string;
  readonly offer?: RTCSessionDescriptionInit;
  readonly candidate?: RTCIceCandidateInit;
}

interface RosterPlayer {
  readonly socketId: string;
  readonly slot: number;
}

interface RosterSpectator {
  readonly socketId: string;
}

interface RosterMessage {
  readonly players: Readonly<Record<string, RosterPlayer>>;
  readonly spectators: Readonly<Record<string, RosterSpectator>>;
}

type Handler = (data: SignalMessage | RosterMessage) => void;

interface FakeSocket {
  readonly id: string;
  on: (event: string, handler: Handler) => void;
  off: (event: string) => void;
  emit: () => void;
}

interface FakeChannel {
  readyState: string;
}

/** The page's WebRTC connection, as far as the engine's offer path reaches into it. */
class FakePc {
  remote: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  connectionState = 'new';
  onconnectionstatechange: (() => void) | null = null;
  ontrack: (() => void) | null = null;
  ondatachannel: (() => void) | null = null;
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remote = description;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0\r\n' };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }
  createDataChannel(): FakeChannel {
    return { readyState: 'connecting' };
  }
  getSenders(): readonly [] {
    return [];
  }
  getReceivers(): readonly [] {
    return [];
  }
  close(): void {}
}

interface FakePeer {
  pc: FakePc;
  dc: null;
  slot: number | null;
  pendingCandidates: RTCIceCandidateInit[];
  remoteDescSet: boolean;
}

interface EngineConfig {
  socket: FakeSocket;
  playerSlot: number;
  isSpectator: boolean;
  initialPlayers: RosterMessage | null;
}

/** window.NetplayStreaming, as far as these tests use it. */
interface EngineApi {
  init: (config: EngineConfig) => void;
  stop: () => void;
  getPeerConnection: (sid: string) => FakePc | null;
}

interface FakeKNState {
  DEFAULT_ICE_SERVERS: readonly RTCIceServer[];
  uploadToken: string;
  peers?: Readonly<Record<string, FakePeer>>;
}

interface Report {
  readonly type: string;
  readonly message: string;
}

const STREAMING = { ...streamingRoster, ...streamingSignal, ...streamingInput, ...streamingVideo };

/** The page's global object: what the engine reads from it, and what it leaves there. */
interface FakeWindow {
  window?: FakeWindow;
  NetplayStreaming?: EngineApi;
  console: { log: (line: string) => void };
  performance: Performance;
  queueMicrotask: (run: () => void) => void;
  RTCSessionDescription: typeof FakeDescription;
  document: { getElementById: () => null };
  KNState: FakeKNState;
  KNEvent: (type: string, message: string) => void;
  KNShared: FakeShared;
  KNCore: { streaming: typeof STREAMING };
}

class FakeDescription {
  constructor(description: RTCSessionDescriptionInit) {
    Object.assign(this, description);
  }
}

interface FakeShared {
  createSyncLogRing: () => { push: () => void; export: () => readonly []; clear: () => void };
  createBasePeer: () => FakePeer;
  drainCandidates: (peer: FakePeer) => Promise<void>;
  createAndSendAnswer: (pc: FakePc, socket: FakeSocket, target: string) => Promise<void>;
  addBufferedCandidate: (peer: FakePeer, candidate: RTCIceCandidateInit) => Promise<void>;
  setupKeyTracking: () => void;
  teardownKeyTracking: () => void;
  bootWithCheats: () => void;
}

/**
 * The engine on a page whose own socket is `sid`.
 */
const page = (sid: string) => {
  const handlers = new Map<string, Handler>();
  const answered: string[] = [];
  const logs: string[] = [];
  const reports: Report[] = [];
  const socket: FakeSocket = {
    id: sid,
    on: (event, handler) => handlers.set(event, handler),
    off: (event) => handlers.delete(event),
    emit: () => undefined,
  };
  const knState: FakeKNState = { DEFAULT_ICE_SERVERS: [], uploadToken: 'token' };
  const window: FakeWindow = {
    console: { log: (line) => logs.push(line) },
    performance,
    queueMicrotask,
    RTCSessionDescription: FakeDescription,
    document: { getElementById: () => null },
    KNState: knState,
    KNEvent: (type, message) => reports.push({ type, message }),
    KNShared: {
      createSyncLogRing: () => ({ push: () => undefined, export: () => [], clear: () => undefined }),
      createBasePeer: () => ({ pc: new FakePc(), dc: null, slot: null, pendingCandidates: [], remoteDescSet: false }),
      drainCandidates: async (peer) => {
        peer.remoteDescSet = true;
      },
      createAndSendAnswer: async (_pc, _socket, target) => {
        answered.push(target);
      },
      addBufferedCandidate: async (peer, candidate) => {
        peer.pendingCandidates.push(candidate);
      },
      setupKeyTracking: () => undefined,
      teardownKeyTracking: () => undefined,
      bootWithCheats: () => undefined,
    },
    KNCore: { streaming: STREAMING },
  };
  window.window = window;
  vm.runInNewContext(ENGINE, window);
  const engine = window.NetplayStreaming;
  assert.ok(engine);
  return {
    engine,
    /** The page's signaling socket, for the engine's config. */
    socket,
    answered,
    reports,
    /** The candidates the engine handed to its connection for `sid`. */
    candidatesFor: (sid: string) => knState.peers?.[sid]?.pendingCandidates ?? null,
    /** The engine's own log lines that mention `text`. */
    logged: (text: string) => logs.filter((line) => line.includes(text)),
    signal: (data: SignalMessage) => handlers.get('webrtc-signal')?.(data),
    roster: (data: RosterMessage) => handlers.get('users-updated')?.(data),
    listening: () => handlers.has('webrtc-signal'),
  };
};

/** Every handler, and what it handed on, has run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const ROOM: RosterMessage = {
  players: { a: { socketId: 'host', slot: 0 }, b: { socketId: 'p2', slot: 1 }, c: { socketId: 'p3', slot: 2 } },
  spectators: { w: { socketId: 'w1' } },
};
const offerFrom = (sender: string): SignalMessage => ({
  sender,
  target: 'p2',
  offer: { type: 'offer', sdp: 'v=0\r\nm=video 9\r\n' },
});
const candidateFrom = (sender: string, n: number): SignalMessage => ({
  sender,
  target: 'p2',
  candidate: { candidate: `c${n}` },
});

test("a guest answers the host's offer and refuses another player's or a spectator's", async () => {
  const p2 = page('p2');
  p2.engine.init({ socket: p2.socket, playerSlot: 1, isSpectator: false, initialPlayers: ROOM });

  p2.signal(offerFrom('p3'));
  p2.signal(offerFrom('p3'));
  p2.signal(offerFrom('w1'));
  p2.signal(candidateFrom('p3', 1));
  await settle();
  assert.equal(p2.engine.getPeerConnection('p3'), null);
  assert.equal(p2.engine.getPeerConnection('w1'), null);
  assert.deepEqual(p2.answered, []);
  // Each refused sender is logged once, however often it tries.
  assert.equal(p2.logged('refused offer from p3').length, 1);
  assert.equal(p2.logged('refused offer from w1').length, 1);

  p2.signal(offerFrom('host'));
  await settle();
  assert.deepEqual(p2.answered, ['host']);
  assert.equal(p2.engine.getPeerConnection('host')?.remote?.type, 'offer');

  assert.deepEqual(p2.reports, []);
});

test('an offer before any roster is held with its candidates, and applied when the roster places it at slot 0', async () => {
  const p2 = page('p2');
  p2.engine.init({ socket: p2.socket, playerSlot: 1, isSpectator: false, initialPlayers: null });
  p2.signal(offerFrom('host'));
  p2.signal(candidateFrom('host', 1));
  p2.signal(candidateFrom('host', 2));
  await settle();
  assert.equal(p2.engine.getPeerConnection('host'), null);
  assert.deepEqual(p2.answered, []);
  assert.equal(p2.logged('holding offer from host').length, 1);

  p2.roster(ROOM);
  await settle();
  assert.deepEqual(p2.answered, ['host']);
  assert.equal(p2.engine.getPeerConnection('host')?.remote?.type, 'offer');
  assert.equal(p2.logged('applying held offer from host').length, 1);
  // Its candidates follow it to the connection, in order.
  assert.deepEqual(p2.candidatesFor('host'), [{ candidate: 'c1' }, { candidate: 'c2' }]);
  assert.deepEqual(p2.reports, []);
});

test('a held offer is dropped when the roster places its sender anywhere but slot 0', async () => {
  const p2 = page('p2');
  p2.engine.init({ socket: p2.socket, playerSlot: 1, isSpectator: false, initialPlayers: null });
  p2.signal(offerFrom('p3'));
  p2.signal(offerFrom('w1'));
  await settle();
  p2.roster(ROOM);
  await settle();
  assert.equal(p2.engine.getPeerConnection('p3'), null);
  assert.equal(p2.engine.getPeerConnection('w1'), null);
  assert.deepEqual(p2.answered, []);
  assert.equal(p2.logged('dropped held offer from p3').length, 1);
  assert.equal(p2.logged('dropped held offer from w1').length, 1);
  // Gone, not waiting: a later roster placing p3 at slot 0 has nothing to apply.
  p2.roster({ players: { c: { socketId: 'p3', slot: 0 }, b: { socketId: 'p2', slot: 1 } }, spectators: {} });
  await settle();
  assert.deepEqual(p2.answered, []);
});

test("a reloaded host's offer from its new socket is held until the roster names it, then answered", async () => {
  const p2 = page('p2');
  p2.engine.init({ socket: p2.socket, playerSlot: 1, isSpectator: false, initialPlayers: ROOM });
  p2.signal(offerFrom('host2'));
  await settle();
  assert.deepEqual(p2.answered, []);
  // A roster that still does not list it leaves it held.
  p2.roster({ players: { b: { socketId: 'p2', slot: 1 } }, spectators: {} });
  await settle();
  assert.deepEqual(p2.answered, []);
  p2.roster({ players: { a: { socketId: 'host2', slot: 0 }, b: { socketId: 'p2', slot: 1 } }, spectators: {} });
  await settle();
  assert.deepEqual(p2.answered, ['host2']);
});

test('stop() forgets held offers: a roster in the next match applies nothing from the last', async () => {
  const p2 = page('p2');
  p2.engine.init({ socket: p2.socket, playerSlot: 1, isSpectator: false, initialPlayers: null });
  p2.signal(offerFrom('host'));
  await settle();
  assert.equal(p2.logged('holding offer from host').length, 1);
  // The match ends (game-ended, leaving the room and a new engine all stop it).
  p2.engine.stop();
  assert.equal(p2.listening(), false);

  p2.engine.init({ socket: p2.socket, playerSlot: 1, isSpectator: false, initialPlayers: ROOM });
  await settle();
  assert.equal(p2.engine.getPeerConnection('host'), null);
  assert.deepEqual(p2.answered, []);
  assert.deepEqual(p2.logged('applying held offer'), []);
  // The refusal log starts again too: a sender refused last match is logged once more.
  p2.signal(offerFrom('p3'));
  await settle();
  assert.equal(p2.logged('refused offer from p3').length, 1);
});

test("the host's page answers any offer, as before", async () => {
  const host = page('host');
  host.engine.init({
    socket: host.socket,
    playerSlot: 0,
    isSpectator: false,
    initialPlayers: { players: { a: { socketId: 'host', slot: 0 } }, spectators: {} },
  });
  host.signal(offerFrom('p3'));
  await settle();
  assert.deepEqual(host.answered, ['p3']);
  assert.deepEqual(host.logged('refused offer'), []);
});
