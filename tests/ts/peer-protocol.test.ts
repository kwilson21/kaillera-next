import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkPeerJson, checkPeerText, checkRelay, textKind } from '../../web/src/peer-protocol.ts';
import { createProtocolObserver, PEER_SAMPLE, type ProtocolReport } from '../../web/src/socket-boundary.ts';

const ok = (channel: 'lockstep' | 'sync-state' | 'rom-transfer', text: string): void => {
  assert.equal(checkPeerText(channel, text).issue, null, text);
};
const bad = (channel: 'lockstep' | 'sync-state' | 'rom-transfer', text: string): void => {
  assert.notEqual(checkPeerText(channel, text).issue, null, text);
};

// ── control strings, as web/static/netplay-rollback.js builds them ───────────

test('the bare control words match', () => {
  for (const word of ['ready', 'emu-ready', 'late-join-pause', 'late-join-resume', 'late-join-ready', 'leaving']) {
    ok('lockstep', word);
  }
  ok('lockstep', 'peer-resumed');
  ok('lockstep', 'sync-request-full');
  bad('lockstep', 'ready:1');
  bad('lockstep', 'Ready');
});

test('roster carries a frame and the slots in play', () => {
  ok('lockstep', 'roster:1840:0,1,3');
  ok('lockstep', 'roster:0:0');
  // No slots: `${frame}:${[].join(',')}`.
  ok('lockstep', 'roster:12:');
  bad('lockstep', 'roster:12');
  bad('lockstep', 'roster:12:0,,1');
  bad('lockstep', 'roster:x:0');
});

test('menu and phase messages carry integers', () => {
  ok('lockstep', 'phase:412:7:1');
  ok('lockstep', 'menu-ready:300:16');
  ok('lockstep', 'resend:77');
  ok('lockstep', 'rb-delay:3');
  ok('lockstep', 'rb-init-frame:0');
  ok('lockstep', 'fpu-trace:600:-1234567:42');
  ok('lockstep', 'sync-request-full-at:980');
  bad('lockstep', 'phase:412:7');
  bad('lockstep', 'menu-ready:300:NaN');
  bad('lockstep', 'resend:undefined');
  bad('lockstep', 'rb-delay:');
});

test('rollback checks: hashes are signed integers, the game hash optional', () => {
  ok('lockstep', 'rb-check:1200:-889275714:305419896');
  ok('lockstep', 'rb-check:1200:4294967295');
  bad('lockstep', 'rb-check:1200');
  bad('lockstep', 'rb-check:1200:0xdeadbeef');
});

test('block, region and sub-hash lists are hex', () => {
  ok('lockstep', 'rb-blocks:1200:00000000deadbeef0badf00d');
  ok('lockstep', 'rb-blocks:1200:');
  bad('lockstep', 'rb-blocks:1200:deadbee');
  ok('lockstep', 'rb-regions:1200:1a2b,ffffffff,0');
  bad('lockstep', 'rb-regions:1200:1a2b,,0');
  ok('lockstep', 'rb-subhash:1200:3:aa,bb,cc');
  bad('lockstep', 'rb-subhash:1200:aa,bb');
});

test('the transport is one of two words', () => {
  ok('lockstep', 'rb-transport:reliable');
  ok('lockstep', 'rb-transport:unreliable');
  bad('lockstep', 'rb-transport:fast');
});

test('the sync-state channel has its own headers', () => {
  ok('sync-state', 'sync-start:900:23:1:0');
  ok('sync-state', 'sync-regions-start:900:4');
  bad('sync-state', 'sync-start:900:23:yes:no');
  bad('sync-state', 'sync-start:900:23:1');
  // A lockstep word on the wrong channel is unknown there.
  assert.equal(checkPeerText('sync-state', 'rb-check:1:2').kind, 'sync-state (unknown)');
  bad('sync-state', '{"type":"digest"}');
});

test('an unknown control string is a mismatch and its text is not echoed', () => {
  const verdict = checkPeerText('lockstep', 'secret-token-abc:123');
  assert.equal(verdict.kind, 'lockstep (unknown)');
  assert.ok(verdict.issue !== null && !verdict.issue.includes('secret-token-abc'));
  assert.equal(textKind('rb-check:1:2:3'), 'rb-check');
  assert.equal(textKind('ready'), 'ready');
});

test('every string the engine dispatches on is in the grammar', () => {
  // The dispatchers compare `e.data` with a word or test a `prefix:`. A new
  // one added there without a line in peer-protocol.ts fails here.
  const engine = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
  // `(?<!typeof )` skips the `typeof e.data === 'string'` type tests.
  const words = [...engine.matchAll(/(?<!typeof )e\.data === '([a-z-]+)'/g)].map((m) => m[1] ?? '');
  const prefixes = [...engine.matchAll(/e\.data\.startsWith\('([a-z-]+):'\)/g)].map((m) => m[1] ?? '');
  assert.ok(words.length >= 8 && prefixes.length >= 12, 'the dispatchers were not found');
  for (const kind of new Set([...words, ...prefixes])) {
    const onLockstep = checkPeerText('lockstep', kind).kind !== 'lockstep (unknown)';
    const onSync = checkPeerText('sync-state', kind).kind !== 'sync-state (unknown)';
    assert.ok(onLockstep || onSync, `${kind} is dispatched by the engine but not described`);
  }
});

// ── JSON on a DataChannel ───────────────────────────────────────────────────

test('JSON messages on the lockstep channel match by type', () => {
  ok('lockstep', JSON.stringify({ type: 'delay-ping', ts: 15234.300000011921 }));
  ok('lockstep', JSON.stringify({ type: 'delay-pong', ts: 15234.3 }));
  const caps = { rdpReplaySkip: true, trueRollback: true, inputModel: 2, stateBackend: 'split-rdram' };
  ok('lockstep', JSON.stringify({ type: 'lockstep-ready', delay: 2, extraDelay: 0, caps }));
  ok('lockstep', JSON.stringify({ type: 'digest', frame: 600, hashes: [1, 2, 3], replayMeta: null }));
  ok('lockstep', JSON.stringify({ type: 'rom-accepted' }));
  bad('lockstep', JSON.stringify({ type: 'delay-ping' }));
  bad('lockstep', JSON.stringify({ type: 'digest', frame: 600, hashes: 'abc' }));
  bad('lockstep', '{"type":"delay-ping",');
  assert.equal(checkPeerText('lockstep', '{"type":"made-up"}').kind, 'lockstep (unknown type)');
  assert.equal(checkPeerText('lockstep', '{"ts":1}').kind, 'lockstep (no type)');
});

test('the ROM transfer channel carries three JSON messages', () => {
  ok('rom-transfer', JSON.stringify({ type: 'rom-resume', offset: 0 }));
  ok('rom-transfer', JSON.stringify({ type: 'rom-header', name: 'Smash.z64', size: 16777216, hash: 'ab'.repeat(32) }));
  ok('rom-transfer', JSON.stringify({ type: 'rom-header', name: 'Smash.z64', size: 16777216 }));
  ok('rom-transfer', JSON.stringify({ type: 'rom-complete' }));
  bad('rom-transfer', JSON.stringify({ type: 'rom-header', name: 'Smash.z64' }));
  bad('rom-transfer', JSON.stringify({ type: 'rom-resume', offset: '0' }));
  bad('rom-transfer', 'ready');
});

// ── relayed Socket.IO events ────────────────────────────────────────────────

const issueOf = (event: string, data: Parameters<typeof checkRelay>[1]): string | null | undefined =>
  checkRelay(event, data)?.issue;

test('data-message relays match by type', () => {
  assert.equal(issueOf('data-message', { type: 'mode-select', mode: 'streaming' }), null);
  assert.notEqual(issueOf('data-message', { type: 'mode-select', mode: 'lockstep' }), null);
  assert.equal(issueOf('data-message', { type: 'rom-accepted', sender: 'sid-guest' }), null);
  assert.equal(issueOf('data-message', { type: 'request-late-join', requesterSid: 'sid-guest' }), null);
  assert.equal(issueOf('data-message', { type: 'late-join-ready', senderSid: 'sid-guest' }), null);
  const lateJoinReady = { type: 'streaming-late-join-ready', senderSid: 'sid-guest', isSpectator: true };
  assert.equal(issueOf('data-message', lateJoinReady), null);
  const request = { type: 'sync-request-full-socket', targetSid: 'h', requesterSid: 'g', reason: 'stall', frame: 9 };
  assert.equal(issueOf('data-message', request), null);
  assert.notEqual(issueOf('data-message', { type: 'request-late-join' }), null);
  assert.equal(checkRelay('data-message', { type: 'made-up' })?.kind, 'data-message (unknown type)');
});

test('state transfers over Socket.IO match with and without their sidecars', () => {
  const saveState = {
    type: 'save-state',
    frame: 0,
    stateFormat: 'kn-sync',
    sourceRuntimeFamily: 'chromium',
    hiddenWords: [1, 2, 3],
    audioFifo: { head: 0 },
    data: 'H4sIAAAAAAAAA...',
    saveRam: null,
    toPlayers: true,
  };
  assert.equal(issueOf('data-message', saveState), null);
  assert.equal(issueOf('data-message', { type: 'save-state', frame: 0, data: 'H4sI' }), null);
  assert.notEqual(issueOf('data-message', { type: 'save-state', frame: 0 }), null);
  const lateJoin = {
    type: 'late-join-state',
    targetSid: 'sid-guest',
    frame: 4200,
    data: 'H4sI',
    effectiveDelay: 3,
    rbTransport: 'unreliable',
    rngValues: { a: 1 },
    saveRam: 'H4sI',
  };
  assert.equal(issueOf('data-message', lateJoin), null);
  const syncState = {
    type: 'sync-state-socket',
    targetSid: 'g',
    senderSid: 'h',
    frame: 900,
    full: true,
    proactive: false,
    reason: 'socket-sync',
    rawSize: 3500000,
    compressedSize: 900000,
    data: 'H4sI',
  };
  assert.equal(issueOf('data-message', syncState), null);
  assert.notEqual(issueOf('data-message', { ...syncState, full: 'yes' }), null);
});

test("signal relays carry a sender; the server's own renegotiate request does not", () => {
  const offer = { type: 'offer', sdp: 'v=0...' };
  assert.equal(issueOf('webrtc-signal', { sender: 'a', target: 'b', offer, reconnect: true }), null);
  assert.equal(issueOf('webrtc-signal', { sender: 'a', target: 'b', answer: { type: 'answer', sdp: 'v=0' } }), null);
  const candidate = { candidate: 'candidate:1 1 udp ...', sdpMid: '0', sdpMLineIndex: 0 };
  assert.equal(issueOf('webrtc-signal', { sender: 'a', target: 'b', candidate }), null);
  assert.equal(issueOf('webrtc-signal', { sender: 'a', target: 'b', candidate: null }), null);
  assert.equal(checkRelay('webrtc-signal', { requestRenegotiate: true })?.kind, 'webrtc-signal (renegotiate)');
  assert.notEqual(issueOf('webrtc-signal', { target: 'b', offer }), null);
  assert.equal(issueOf('rom-signal', { sender: 'a', target: 'b', offer }), null);
  assert.notEqual(issueOf('rom-signal', { requestRenegotiate: true }), null);
  assert.equal(checkRelay('users-updated', {}), null);
});

test('checkPeerJson names the route and type', () => {
  assert.deepEqual(checkPeerJson('rom-transfer', { type: 'rom-complete' }), {
    kind: 'rom-transfer rom-complete',
    issue: null,
  });
});

// ── the observer ────────────────────────────────────────────────────────────

const collector = () => {
  const reports: ProtocolReport[] = [];
  const observer = createProtocolObserver((report) => {
    reports.push(report);
    return true;
  });
  return { reports, observer };
};

test('the observer reports a peer mismatch once and checks relays on the socket', () => {
  const { reports, observer } = collector();
  observer.peerText('lockstep', 'rb-check:1:2:3');
  observer.peerText('lockstep', 'rb-check:oops');
  observer.peerText('lockstep', 'rb-check:oops');
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.message, 'dc lockstep rb-check');
  assert.equal(observer.check('data-message', { type: 'mode-select', mode: 'turbo' }), false);
  assert.equal(reports[1]?.message, 'data-message mode-select');
  assert.equal(observer.check('webrtc-signal', { sender: 'a', target: 'b', candidate: null }), true);
});

test('only the first few messages of a kind are checked', () => {
  const { reports, observer } = collector();
  for (let frame = 0; frame < PEER_SAMPLE; frame += 1) observer.peerText('lockstep', `rb-check:${frame}:1:2`);
  // Past the sample, a malformed one of the same kind is not looked at.
  observer.peerText('lockstep', 'rb-check:broken');
  assert.equal(reports.length, 0);
  // Another kind still has its own sample.
  observer.peerText('lockstep', 'rb-delay:broken');
  assert.equal(reports.length, 1);
});
