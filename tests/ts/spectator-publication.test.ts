// Run the rollback engine's spectator effects and their actual entry points.
// The canvas and peer connections record capture, sender and offer ownership.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { attachSpectatorMedia, createAndSendOffer } from '../../web/src/page/peer-connection.ts';

const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const between = (start: string, end: string, from = 0) => {
  const a = source.indexOf(start, from);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `missing engine block ${start}`);
  return source.slice(a + start.length, b);
};

function page(holdAudio = false) {
  let hasCanvas = true;
  let captures = 0;
  let draws = 0;
  let offers = 0;
  let applied = 0;
  let stoppedTracks = 0;
  let delivered = 0;
  const finishOffers: (() => void)[] = [];
  const delays: (() => void)[] = [];
  const frames: (() => void)[] = [];
  const audio = { kind: 'audio', stop: () => {} };
  let audioReady = !holdAudio;
  let finishAudio = () => {};
  const context = {
    document: {
      querySelector: () => (hasCanvas ? { width: 640, height: 480 } : null),
      createElement: () => ({
        getContext: () => ({ drawImage: () => draws++ }),
        captureStream: () => {
          captures++;
          const video = { kind: 'video', stop: () => stoppedTracks++ };
          const tracks = [video];
          return {
            getVideoTracks: () => [video],
            getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
            getTracks: () => tracks,
            addTrack: (t: typeof video) => tracks.push(t),
          };
        },
      }),
    },
    _audio: {
      init: () =>
        holdAudio
          ? new Promise<void>((resolve) => {
              finishAudio = () => {
                audioReady = true;
                resolve();
              };
            })
          : Promise.resolve(),
      get destNode() {
        return audioReady ? { stream: { getAudioTracks: () => [audio] } } : null;
      },
    },
    KNEvent: () => {},
    APISandbox: { nativeRAF: (f: () => void) => frames.push(f) },
    window: {
      KNCore: {
        startGroup: {
          startDeadline: ({ onDeadline }: { onDeadline: () => void }) => {
            delays.push(onDeadline);
            return { cancel: () => {} };
          },
        },
      },
    },
    setTimeout: (f: () => void) => delays.push(f),
    _syncLog: () => {},
    KNShared: { attachSpectatorMedia, createAndSendOffer },
    createOffer: async () => {
      offers++;
      await new Promise<void>((resolve) => finishOffers.push(resolve));
      return { type: 'offer', sdp: 'spectator' };
    },
    setLocalDescription: () => applied++,
    _signalSocket: { emit: () => delivered++ },
  };
  const setupChannel = source.indexOf('const setupDataChannel = ');
  const open = between('startRttMeasurement(peer);', '// Opening a late joiner', setupChannel);
  const close = between('const onClose = () => {', 'ch.onerror', setupChannel).split('};')[0];
  const entry = between('    initAudioPlayback()', '// JS-level RNG seed writes');
  const stop = between('// Clean up spectator stream', 'if (_guestVideo)');
  // SAFETY: the fixture below explicitly returns each method in this test-only interface.
  const api = vm.runInNewContext(
    `
    let _phase = 0, _sessionId = 0, _peers = {}, _playerSlot = 0, _isSpectator = false;
    const PHASE_IDLE = 0, PHASE_RUNNING = 1, PHASE_STOPPED = 2;
    ${between('// Spectator streaming state', '// Expose for Playwright')}
    ${between('// -- Audio pipeline (delegated to kn-audio.js) --', 'const feedAudio')}
    ${between('// -- Spectator canvas streaming --------------------------------------------', 'const showSpectatorVideo')}
    const handlePeerDisconnect = () => {};
    const opened = (remoteSid, peer, ch) => { ${open} };
    ({
      enter() { _sessionId++; _phase = PHASE_RUNNING; initAudioPlayback()${entry} },
      open(sid, sameConnection = false) {
        const senders = [];
        const addSender = track => {
          const sender = { track, async replaceTrack(next) { this.track = next; } };
          senders.push(sender);
          return sender;
        };
        const pc = sameConnection && _peers[sid] ? _peers[sid].pc : {
          createOffer, setLocalDescription,
          getSenders: () => senders,
          removeTrack(sender) { sender.track = null; },
          addTransceiver() { return { sender: addSender(null) }; },
          addTrack(track) { if (senders.some(s => s.track === track)) throw Error('duplicate sender'); return addSender(track); }
        };
        const ch = {readyState: 'open', _knPc: pc};
        const peer = _peers[sid] = Object.assign(sameConnection ? _peers[sid] : {}, {slot: null, ready: true, dc: ch, pc});
        opened(sid, peer, ch);
      },
      announce(sid) { opened(sid, _peers[sid], _peers[sid].dc); },
      close(remoteSid) { const ch = _peers[remoteSid].dc; ch.readyState = 'closed'; ${close} },
      tracks(sid) { return _peers[sid].pc.getSenders().filter(s => s.track).map(s => s.track.kind).join(','); },
      stop() { _phase = PHASE_STOPPED; ${stop} _peers = {}; },
    })`,
    context,
  ) as {
    enter(): void;
    open(sid: string, sameConnection?: boolean): void;
    announce(sid: string): void;
    close(sid: string): void;
    tracks(sid: string): string;
    stop(): void;
  };
  return {
    api,
    delays,
    frames,
    finishOffers,
    get finishAudio() {
      return finishAudio;
    },
    canvas: (exists: boolean) => {
      hasCanvas = exists;
    },
    stats: () => ({ captures, draws, offers, applied, stoppedTracks, delivered }),
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('an already-open spectator receives video and audio when the host starts', async () => {
  const p = page();
  p.api.open('early');
  assert.equal(p.stats().captures, 0);
  p.api.enter();
  await settle();
  assert.equal(p.api.tracks('early'), 'video,audio');
  assert.equal(p.stats().offers, 1);
  p.api.open('late');
  p.api.announce('late');
  assert.equal(p.stats().offers, 2);
  assert.equal(p.stats().captures, 1);
  p.api.open('early', true);
  assert.equal(p.api.tracks('early'), 'video,audio');
  assert.equal(p.stats().offers, 3, 'a replacement channel on the same connection gets an offer');
});

test('capture exists only while an open spectator needs it', async () => {
  const p = page();
  p.api.enter();
  await settle();
  assert.equal(p.stats().captures, 0);
  p.api.open('only');
  assert.equal(p.stats().offers, 1);
  p.api.close('only');
  p.frames.splice(0).forEach((f) => f());
  assert.equal(p.stats().stoppedTracks, 1);
  assert.equal(p.stats().draws, 1);
});

test('a stale canvas retry and a queued frame cannot attach to a replacement match', async () => {
  const p = page();
  p.canvas(false);
  p.api.enter();
  await settle();
  p.api.open('old');
  assert.equal(p.delays.length, 1);
  p.api.stop();
  p.canvas(true);
  p.api.enter();
  await settle();
  p.delays.splice(0).forEach((f) => f());
  assert.equal(p.stats().captures, 0);
  p.api.open('new');
  const oldFrame = p.frames.shift();
  p.api.stop();
  p.api.enter();
  await settle();
  oldFrame?.();
  assert.equal(p.stats().draws, 1);
});

test('a delayed media offer is sent only to its original connection', async () => {
  const p = page();
  p.api.enter();
  await settle();
  p.api.open('watcher');
  p.api.stop();
  p.api.enter();
  await settle();
  p.api.open('watcher');
  for (const done of p.finishOffers) done();
  await settle();
  assert.equal(p.stats().applied, 1);
  assert.equal(p.stats().delivered, 1);
});

test('a closed spectator channel releases its senders while another viewer keeps watching', async () => {
  const p = page();
  p.api.enter();
  await settle();
  p.api.open('reconnecting');
  p.api.open('other');
  p.api.close('reconnecting');
  assert.equal(p.api.tracks('reconnecting'), '');
  assert.equal(p.api.tracks('other'), 'video,audio');
  assert.equal(p.stats().stoppedTracks, 0);
  p.api.open('reconnecting', true);
  assert.equal(p.api.tracks('reconnecting'), 'video,audio');
  assert.equal(p.stats().offers, 3);
});

test('video starts while playback is pending and its audio sender becomes live without a second offer', async () => {
  const p = page(true);
  p.api.open('early');
  p.api.enter();
  await settle();
  assert.equal(p.api.tracks('early'), 'video');
  p.api.open('during');
  assert.equal(p.api.tracks('during'), 'video');
  p.finishAudio();
  await settle();
  assert.equal(p.api.tracks('early'), 'video,audio');
  assert.equal(p.api.tracks('during'), 'video,audio');
  assert.equal(p.stats().offers, 2);
});

test('completion of playback from a stopped match cannot publish into its replacement', async () => {
  const p = page(true);
  p.api.enter();
  const oldPlayback = p.finishAudio;
  p.api.stop();
  p.api.open('new');
  p.api.enter();
  oldPlayback();
  await settle();
  assert.equal(p.api.tracks('new'), 'video');
  p.finishAudio();
  await settle();
  assert.equal(p.api.tracks('new'), 'video,audio');
});
