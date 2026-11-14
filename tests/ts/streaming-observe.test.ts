import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guestPacket } from '../../web/src/streaming/input.ts';
import {
  createStreamingObserver,
  SAMPLE_FIRST,
  SAMPLE_MAX,
  type EngineView,
  type PeerView,
  type StreamingDisagreeReport,
} from '../../web/src/streaming/observe.ts';
import type { Slot } from '../../web/src/streaming/roster.ts';

type EngineState = {
  sid: string;
  slot: Slot;
  spectator: boolean;
  peers: Map<string, PeerView>;
  known: Map<string, { slot?: Slot }>;
  running: boolean;
  live: boolean;
  capture: { mode: string; scale: number };
  cooldownUntil: number;
};

/** An engine's state a test can change, an observer on it, and the handlers' "afterwards" run by hand. */
const engine = (ready: () => boolean = () => true) => {
  const state: EngineState = {
    sid: 'host',
    slot: 0,
    spectator: false,
    peers: new Map(),
    known: new Map(),
    running: false,
    live: false,
    capture: { mode: 'none', scale: 1 },
    cooldownUntil: 0,
  };
  const view: EngineView = {
    sid: () => state.sid,
    slot: () => state.slot,
    spectator: () => state.spectator,
    peers: () => Object.fromEntries(state.peers),
    known: () => Object.fromEntries(state.known),
    running: () => state.running,
    live: () => state.live,
    capture: () => state.capture,
    cooldownUntil: () => state.cooldownUntil,
    packet: (input) => guestPacket(input),
    page: () => ({ search: '', stored: null, userAgent: 'Chrome' }),
  };
  const sent: StreamingDisagreeReport[] = [];
  const later: (() => void)[] = [];
  const observer = createStreamingObserver(
    (report) => {
      if (!ready()) return false;
      sent.push(report);
      return true;
    },
    view,
    (run) => later.push(run),
  );
  /** The engine's handler has returned. */
  const settle = (): void => {
    for (const run of later.splice(0)) run();
  };
  return { state, observer, sent, settle };
};

const stamped = (sid: string, slot: number | null) => ({
  type: 'streaming-late-join-ready',
  knFrom: { sid, slot, owner: false },
});
const INPUT = { buttons: 3, lx: 10, ly: -10, cx: 0, cy: 0 };

test('an engine doing what the rules say reports nothing, and every decision is counted', () => {
  const { state, observer, sent, settle } = engine();

  // The roster lists a guest: the host connects and offers.
  observer.roster({ players: { a: { socketId: 'host', slot: 0 }, b: { socketId: 'p2', slot: 1 } }, spectators: {} });
  state.known.set('host', { slot: 0 }).set('p2', { slot: 1 });
  const p2: PeerView = { slot: 1, pc: { connectionState: 'new', localDescription: null, getSenders: () => [] } };
  state.peers.set('p2', p2);
  observer.offered('p2');
  observer.offerSdp('v=0\r\nm=video 9 X 96\r\nc=IN\r\n', 'v=0\r\nm=video 9 X 96\r\nc=IN\r\nb=AS:3000\r\n');
  settle();
  observer.controllerMask(0b0011);

  // The guest answers, the channel opens, the host starts.
  observer.signal({ sender: 'p2', answer: {} }).act = 'answer';
  observer.signal({ sender: 'p2', candidate: {} }).act = 'candidate';
  observer.signal({ sender: 'gone', candidate: {} });
  observer.channelOpen('p2').act = 'startHost';
  state.running = true;
  settle();

  // Capture starts; a sender is tuned.
  observer.capture('direct', false, { width: 1280, height: 960 });
  state.capture = { mode: 'direct', scale: 2 };
  state.live = true;
  const params: RTCRtpSendParameters = {
    transactionId: 't',
    encodings: [{}],
    codecs: [],
    headerExtensions: [],
    rtcp: {},
  };
  observer.encoding(params);
  Object.assign(params.encodings[0] ?? {}, {
    maxBitrate: 2_500_000,
    maxFramerate: 60,
    networkPriority: 'high',
    scaleResolutionDownBy: 2,
  });
  params.degradationPreference = 'maintain-framerate';
  observer.blitCrop({ sx: 240, sy: 0, sw: 1440, sh: 1080 }, 1920, 1080);
  settle();

  // Input arrives; a third player joins the stream in play.
  const decoded = { ...INPUT, frame: 0, ackFrame: -1 };
  observer.inputPacket('p2', guestPacket(INPUT).buffer).applied = [1, decoded];
  observer.roster({ players: { a: { socketId: 'host', slot: 0 }, c: { socketId: 'p3', slot: 2 } }, spectators: {} });
  state.known.set('p3', { slot: 2 });
  state.peers.set('p3', { slot: 2, pc: { localDescription: null } });
  settle();
  observer.lateJoinReady(stamped('p3', 2)).act = 'offer';
  observer.lateJoinReady({ type: 'mode-select' });
  settle();

  // The watchdog samples; the guest's connection fails and is dropped.
  observer.fpsWatchdog(10_000, 1000, 60);
  settle();
  observer.fpsWatchdog(11_000, 1000, 90);
  state.cooldownUntil = 16_000;
  settle();
  observer.connectionState('p2', p2, 'failed');
  state.peers.delete('p2');
  settle();

  assert.deepEqual(sent, []);
  assert.deepEqual(observer.counts(), {
    compared: {
      'offer-sdp': 1,
      roster: 2,
      'controller-mask': 1,
      'signal:answer': 1,
      'signal:candidate': 2,
      'channel-open': 1,
      capture: 1,
      encoding: 1,
      'blit-crop': 1,
      'input-packet': 1,
      'late-join-ready': 1,
      'fps-watchdog': 2,
      'connection-state': 1,
    },
    disagreed: 0,
    failed: 0,
  });
});

test('a guest that sends when the rules say so reports nothing', () => {
  const { state, observer, sent, settle } = engine();
  state.slot = 1;
  state.peers.set('host', { slot: 0, dc: { readyState: 'open' } });
  observer.guestSend(true, INPUT, INPUT).send = true;
  observer.guestSend(false, INPUT, INPUT);
  observer.guestSend(false, INPUT, { ...INPUT, buttons: 0 }).send = true;
  observer.channelOpen('host').act = 'startGuestInput';
  settle();
  assert.deepEqual(sent, []);
  assert.deepEqual(observer.counts().compared, { 'guest-send:repeat': 1, 'guest-send:change': 2, 'channel-open': 1 });
});

test('an engine that does something else is reported as streaming-disagree', () => {
  const { state, observer, sent, settle } = engine();
  // The engine offered to a page joining a stream in play, without waiting for it to be ready.
  state.running = true;
  state.live = true;
  observer.roster({ players: { a: { socketId: 'host', slot: 0 }, b: { socketId: 'p2', slot: 1 } } });
  state.peers.set('p2', { slot: 1 });
  observer.offered('p2');
  // It applied input from a spectator's channel.
  state.peers.set('w1', { slot: null });
  observer.inputPacket('w1', guestPacket(INPUT).buffer).applied = [0, { ...INPUT }];
  settle();
  assert.deepEqual(
    sent.map((report) => [report.type, report.message]),
    [
      ['streaming-disagree', 'roster'],
      ['streaming-disagree', 'input-packet'],
    ],
  );
  assert.match(sent[0]?.old ?? '', /"step":"offer"/);
  assert.match(sent[0]?.next ?? '', /"step":"awaitReady"/);
  assert.equal(sent[1]?.next, 'null');
  assert.equal(observer.counts().disagreed, 2);
});

test('reports wait until they can be sent', () => {
  let ready = false;
  const { observer, sent } = engine(() => ready);
  observer.controllerMask(0b1111);
  assert.equal(sent.length, 0);
  ready = true;
  observer.flush();
  assert.deepEqual(
    sent.map((report) => [report.message, report.old, report.next]),
    [['controller-mask', '15', '1']],
  );
});

test('the input path is sampled: the first few, then now and then, up to a total', () => {
  const { state, observer, settle } = engine();
  state.peers.set('p2', { slot: 1 });
  const packet = guestPacket(INPUT).buffer;
  for (let i = 0; i < SAMPLE_FIRST; i++) observer.inputPacket('p2', packet).applied = [1, INPUT];
  settle();
  assert.equal(observer.counts().compared['input-packet'], SAMPLE_FIRST);
  for (let i = 0; i < 200_000; i++) observer.inputPacket('p2', packet).applied = [1, INPUT];
  settle();
  assert.equal(observer.counts().compared['input-packet'], SAMPLE_MAX);
  assert.equal(observer.counts().disagreed, 0);
});

test('nothing the observer does can throw into the engine', () => {
  const broken = (): never => {
    throw new Error('the view is broken');
  };
  const later: (() => void)[] = [];
  const observer = createStreamingObserver(
    broken,
    {
      sid: broken,
      slot: broken,
      spectator: broken,
      peers: broken,
      known: broken,
      running: broken,
      live: broken,
      capture: broken,
      cooldownUntil: broken,
      packet: broken,
      page: broken,
    },
    (run) => later.push(run),
  );
  observer.roster({ players: {} });
  observer.controllerMask(1);
  // The handlers still get a record to write their marks into.
  observer.signal({ sender: 'p2', offer: {} }).act = 'offer';
  observer.lateJoinReady(stamped('p2', 1)).act = 'offer';
  observer.channelOpen('p2').act = 'startHost';
  observer.inputPacket('p2', new ArrayBuffer(24)).applied = [1, INPUT];
  observer.guestSend(true, INPUT, INPUT).send = true;
  observer.connectionState('p2', {}, 'failed');
  observer.capture('direct', false, { width: 1, height: 1 });
  observer.fpsWatchdog(0, 0, 0);
  observer.offered('p2');
  for (const run of later.splice(0)) run();
  const counts = observer.counts();
  assert.ok(counts.failed >= 9, `failed ${counts.failed}`);
  // A rule that cannot run is one disagreement the sink could not take, never an exception.
  observer.offerSdp('a', 'a');
  observer.flush();
});
