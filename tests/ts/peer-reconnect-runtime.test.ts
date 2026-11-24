import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { isOlderAttempt, readAttemptId } from '../../web/src/attempt-id.ts';
import type { WirePayload } from '../../web/src/wire.ts';
import { createPeerDriver } from '../../web/src/peer-driver.ts';
import { addBufferedCandidate, createAndSendAnswer, drainCandidates } from '../../web/src/page/peer-connection.ts';
import { PEER_TIMING } from '../../web/src/peer-connection.ts';

const engine = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const section = (from: string, to: string) => {
  const start = engine.indexOf(from);
  const end = engine.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return engine.slice(start, end);
};
const retry = section('  const _stopPeerReconnect =', '  // -- Helper: get active player peers');
const owns = section('  const _ownsPeerConnection =', '  const _acceptLockstepChannel =');

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

for (const interrupted of ['createOffer', 'setLocalDescription'] as const) {
  test(`a recovered connection cannot publish an obsolete offer after ${interrupted}`, async () => {
    const blocked = deferred();
    const entered = deferred();
    const descriptions: string[] = [];
    const signals: string[] = [];
    const pc = {
      localDescription: { type: 'offer' },
      async createOffer() {
        if (interrupted === 'createOffer') {
          entered.resolve();
          await blocked.promise;
        }
        return this.localDescription;
      },
      async setLocalDescription() {
        descriptions.push('offer');
        if (interrupted === 'setLocalDescription') {
          entered.resolve();
          await blocked.promise;
        }
      },
    };
    const peer = { slot: 1, reconnecting: true, pc };
    const driver = createPeerDriver({ page: 'mine', mySlot: () => 0, offersMade: () => 0, log: () => {} });
    const context = {
      window: { KNCore: { peerTiming: PEER_TIMING } },
      _peers: { sid: peer },
      _phase: 5,
      PHASE_RUNNING: 5,
      _knownPlayers: {},
      _peerDriver: () => driver,
      _offerCounts: new Map(),
      _offerCountKey: (slot: number) => slot,
      KNShared: { resetPeerConnection() {} },
      _getIceServers: () => [],
      _syncLog() {},
      setStatus() {},
      _signalSocket: {
        emit(name: string) {
          signals.push(name);
        },
      },
      createOutgoingPeerChannels() {},
    };
    try {
      runInNewContext(owns + retry + "\nattemptReconnect('sid');", context);
      await entered.promise;
      peer.reconnecting = false;
      blocked.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(signals, []);
      if (interrupted === 'createOffer') assert.deepEqual(descriptions, []);
    } finally {
      driver.stop();
    }
  });
}

const answeringPage = () => {
  const signal = section('  async function onWebRTCSignal(', '  // -- Data channel');
  const remotePause = deferred();
  const answerPause = deferred();
  const pcWaitingOnAnswer = deferred();
  let holdRemote = false;
  let holdAnswer = false;
  const makePc = () => ({
    connectionState: 'connecting',
    closes: 0,
    answers: 0,
    _knAttempt: { page: 'lo', attempt: 2 },
    descriptions: new Array<string>(),
    candidates: new Array<string>(),
    async addIceCandidate(candidate: RTCIceCandidateInit) {
      this.candidates.push(candidate.candidate ?? '');
    },
    async setRemoteDescription(description: RTCSessionDescriptionInit) {
      this.descriptions.push(description.sdp ?? '');
      if (holdRemote) {
        holdRemote = false;
        await remotePause.promise;
      }
    },
    async createAnswer() {
      this.answers++;
      return { type: 'answer' };
    },
    async setLocalDescription() {
      if (holdAnswer) {
        holdAnswer = false;
        pcWaitingOnAnswer.resolve();
        await answerPause.promise;
      }
    },
    close() {
      this.closes++;
    },
  });
  const peer = {
    slot: 0,
    reconnecting: false,
    pc: makePc(),
    remoteDescSet: false,
    pendingCandidates: new Array<RTCIceCandidateInit>(),
  };
  const drained = new Array<typeof peer.pc>();
  const signals: number[] = [];
  const dropped: string[] = [];
  const deadlines: { deadlineMs: number; onDeadline: () => void }[] = [];
  const answer: (signal: WirePayload) => Promise<void> = runInNewContext(owns + retry + signal + '\nonWebRTCSignal', {
    window: {
      KNCore: {
        peerTiming: PEER_TIMING,
        attemptId: { isOlderAttempt },
        startGroup: {
          startDeadline(wait: (typeof deadlines)[number]) {
            deadlines.push(wait);
            return { cancel() {} };
          },
        },
      },
    },
    _peers: { lower: peer },
    _knownPlayers: {},
    _peerKey: (key: string) => key,
    _readAttemptId: readAttemptId,
    _syncLog() {},
    _meshCore() {},
    _meshCompare() {},
    _peerDriver() {},
    _slotOfKey: () => 0,
    _phase: 5,
    PHASE_GAME_STARTED: 4,
    PHASE_RUNNING: 5,
    _signalSocket: {
      emit(_name: string, data: { attemptId: { attempt: number } }) {
        signals.push(data.attemptId.attempt);
      },
    },
    _getIceServers: () => [],
    _isSpectator: false,
    _isValidPlayerSlot: (slot: number) => slot >= 0 && slot <= 3,
    _armHostAnswerDeadline() {},
    STARTUP_HOST_AFTER_OFFER_MS: 16000,
    RTCSessionDescription: class {
      constructor(description: RTCSessionDescriptionInit) {
        Object.assign(this, description);
      }
    },
    installPeerDataChannelHandlers() {},
    KNShared: {
      resetPeerConnection() {
        peer.pc = makePc();
      },
      drainCandidates(held: Parameters<typeof drainCandidates>[0]) {
        drained.push(peer.pc);
        return drainCandidates(held);
      },
      addBufferedCandidate,
      createAndSendAnswer,
    },
    hardDisconnectPeer(sid: string) {
      dropped.push(sid);
    },
    setStatus(message: string) {
      assert.fail(message);
    },
  });
  const offer = (attempt: number) =>
    answer({ sender: 'lower', reconnect: true, offer: { type: 'offer' }, attemptId: { page: 'lo', attempt } });
  return {
    peer,
    offer,
    receive: answer,
    drained,
    deadlines,
    dropped,
    signals,
    remotePause,
    answerPause,
    pcWaitingOnAnswer,
    holdRemote: () => {
      holdRemote = true;
    },
    holdAnswer: () => {
      holdAnswer = true;
    },
  };
};

test('a replacement offer before local loss gets one give-up across unanswered replacements', async () => {
  const { peer, offer, deadlines, dropped } = answeringPage();
  await offer(1);
  const first = peer.pc;
  await offer(2);
  const second = peer.pc;
  assert.equal(peer.reconnecting, true);
  const answerWaits = deadlines.filter((wait) => wait.deadlineMs === PEER_TIMING.answerAfterMs);
  assert.equal(answerWaits.length, 2);
  answerWaits[0]!.onDeadline();
  assert.equal(second.closes, 0);
  answerWaits[1]!.onDeadline();
  assert.equal(first.closes, 0);
  assert.equal(second.closes, 1);
  const giveUps = deadlines.filter((wait) => wait.deadlineMs > PEER_TIMING.answerAfterMs);
  assert.equal(giveUps.length, 1);
  giveUps[0]!.onDeadline();
  assert.deepEqual(dropped, ['lower']);
});

test('overlapping incoming replacement descriptions can only answer the current offer', async () => {
  const page = answeringPage();
  page.holdRemote();
  const first = page.offer(1);
  const stale = page.peer.pc;
  await page.offer(2);
  page.remotePause.resolve();
  await first;
  assert.equal(stale.answers, 0);
  assert.equal(page.peer.pc.answers, 1);
  assert.deepEqual(page.signals, [2]);
});

test('an answer finishing after its connection was replaced cannot signal the old attempt', async () => {
  const page = answeringPage();
  page.holdAnswer();
  const first = page.offer(1);
  await page.pcWaitingOnAnswer.promise;
  await page.offer(2);
  page.answerPause.resolve();
  await first;
  assert.deepEqual(page.signals, [2]);
});

test('an ICE batch being drained belongs to the original peer connection', async () => {
  const first = deferred();
  const added: string[] = [];
  const peer = {
    pendingCandidates: [{ candidate: 'a' }, { candidate: 'b' }],
    pc: {
      async addIceCandidate(c: { candidate: string }) {
        added.push('old ' + c.candidate);
        await first.promise;
      },
    },
  };
  const draining: Promise<void> = runInNewContext('drainCandidates(peer)', { peer, drainCandidates });
  peer.pc = {
    async addIceCandidate(c) {
      added.push('new ' + c.candidate);
    },
  };
  first.resolve();
  await draining;
  assert.deepEqual(added, ['old a', 'old b']);
});

for (const kind of ['answer', 'candidate'] as const) {
  test(`a delayed ${kind} from a previous numbered attempt cannot touch the replacement`, async () => {
    const page = answeringPage();
    page.peer.reconnecting = true;
    const send = (name: string, id?: { page: string; attempt: number }) =>
      page.receive({
        sender: 'lower',
        [kind]: kind === 'answer' ? { type: kind, sdp: name } : { candidate: name },
        attemptId: id,
      });
    await send('stale', { page: 'lo', attempt: 1 });
    assert.deepEqual(page.peer.pc.descriptions, []);
    assert.deepEqual(page.peer.pendingCandidates, []);
    assert.deepEqual(page.drained, []);
    page.peer.remoteDescSet = true;
    await send('stale', { page: 'lo', attempt: 1 });
    await send('current', { page: 'lo', attempt: 2 });
    await send('legacy');
    await send('unknown-page', { page: 'other', attempt: 1 });
    await send('ahead', { page: 'lo', attempt: 3 });
    assert.deepEqual(kind === 'answer' ? page.peer.pc.descriptions : page.peer.pc.candidates, [
      'current',
      'legacy',
      'unknown-page',
      'ahead',
    ]);
  });
}

test('a valid answer replaced while setting its description cannot drain the new connection', async () => {
  const page = answeringPage();
  page.peer.reconnecting = true;
  page.holdRemote();
  const initial = page.receive({ sender: 'lower', answer: { type: 'answer' }, attemptId: { page: 'lo', attempt: 2 } });
  await page.offer(3);
  const replacement = page.peer.pc;
  page.remotePause.resolve();
  await initial;
  assert.deepEqual(page.drained, [replacement]);
});
