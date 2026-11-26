import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { decodeInput, decodeWords, encodeInput } from '../../web/src/input-wire.ts';
import { framesToSendAgain } from '../../web/src/input-resend.ts';

const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
function between(start: string, end: string) {
  const i = source.indexOf(start),
    j = source.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `missing sender between ${start} and ${end}`);
  return source.slice(i, j);
}
function engineFunction(name: string) {
  return between('  const ' + name + ' =', '\n  };') + '\n  };';
}
for (const mode of ['dual', 'unreliable']) {
  test(`closing the optional channel in ${mode} keeps existing input wait deadlines`, () => {
    const closed = { readyState: 'connecting' };
    const peer = { slot: 2, rbDc: closed, rbDcUnreliable: true };
    const context = vm.createContext({ closed, peer, mode });
    const state = vm.runInContext(
      `
      const _peers = { remote: peer }, _dcBufferStaleStreak = { remote: 2 }, _rbTransport = mode;
      const _rbInputStallAt = new Map([[1, 1000], [2, 1050]]);
      const _lockstepWaitAt = new Map([[2, 1100]]);
      let fallback = null;
      const _syncLog = () => {};
      const _switchInputsToReliable = (reason) => { fallback = reason; };
      ${engineFunction('clearPeerStallTimers')}
      ${engineFunction('resetPeerRollbackTransport')}
      ${engineFunction('setupRollbackInputDataChannel')}
      setupRollbackInputDataChannel('remote', closed);
      closed.onclose();
      [_rbInputStallAt.get(1), _rbInputStallAt.get(2), _lockstepWaitAt.get(2),
        peer.rbDc, peer.rbDcUnreliable, _dcBufferStaleStreak.remote, fallback];
      `,
      context,
    );
    assert.deepEqual(Array.from(state), [
      1000,
      1050,
      1100,
      null,
      false,
      0,
      mode === 'unreliable' ? 'rb-dc-close' : null,
    ]);
  });
}

const pad = { buttons: 8, lx: -48, ly: 29, cx: -12, cy: 24 };
const frame = 140;
function sender(mode: 'dual' | 'reliable' | 'unreliable' = 'dual', mesh = false) {
  const writes: { channel: string; data: ArrayBuffer }[] = [];
  const channel = (label: string) => ({
    label,
    readyState: 'open',
    bufferedAmount: 0,
    fail: false,
    send(data: ArrayBuffer) {
      if (this.fail) throw new Error('channel closed while sending');
      writes.push({ channel: label, data });
    },
  });
  const peer = {
    slot: 1,
    lastAckFromPeer: 0,
    lastFrameFromPeer: 118,
    rbDcUnreliable: true,
    dc: channel('lockstep'),
    rbDc: channel('rollback-input'),
  };
  const activePeers = [peer];
  if (mesh) {
    activePeers.push({ ...peer, slot: 2, dc: channel('lockstep-2'), rbDc: channel('rollback-input-2') });
  }
  const resendAtSwitch: Record<number, { from: number; upTo: number; ack: number }> = {};
  let now = 1000;
  const context = vm.createContext({
    performance: { now: () => now },
    activePeers,
    _rbTransport: mode,
    _frameNum: frame,
    _resendAtSwitch: resendAtSwitch,
    // A resync can rewind the guest into an already authored range.
    _localInputs: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [frame - 30 + i, i === 30 ? pad : { ...pad, buttons: i + 1 }]),
    ),
    window: { KNCore: { framesToSendAgain } },
    KNShared: { encodeInput },
    localInput: pad,
  });
  const tick = vm.runInContext(
    `
    const _useCRollback = true, _catchUpTo = -1, _syncLog = () => {};
    ${['KN_MAX_VISIBLE_ROLLBACK_DEPTH', 'RB_RESEND_AT_SWITCH_MAX', 'RB_INPUT_HISTORY_MAX', 'DC_BUFFER_THRESHOLD', 'INPUT_RESEND_EVERY_MS', 'INPUT_RESEND_RELIABLE_MS'].map((k) => between('  const ' + k + ' =', ';') + ';').join('\n')}
    let _rbTransportPacketsSent = 0, _catchUpSendsReliable = 0, _catchUpSendsUnreliable = 0, authored = 0;
    const _recordAuthoredOwnerInput = () => { authored++; };
    ${engineFunction('_buildInputHistoryTail')}
    ${engineFunction('_sendFrameInput')}
    ${engineFunction('_keepReliableInputs')}
    ${engineFunction('_sendResendAtSwitch')}
    () => {
      let recordAuthorOnSend = true;
      ${between('    const shouldSendRedundancy =', '    // ── DC health monitor')}
    }
  `,
    context,
  );
  const decoded = () =>
    writes.map(({ data }) => {
      const packet = decodeInput(data);
      assert.equal(packet.frame, frame);
      assert.equal(packet.ackFrame, 118);
      const { buttons, lx, ly, cx, cy } = packet;
      assert.deepEqual({ buttons, lx, ly, cx, cy }, pad);
      const records = ('redundant' in packet && packet.redundant) || [];
      for (const r of records) assert.deepEqual(r, { ...pad, frame: r.frame, buttons: r.frame - frame + 31 });
      return { history: records.map((r) => r.frame) };
    });
  return {
    peer,
    resendAtSwitch,
    tick,
    writes,
    channels: () => writes.map((w) => w.channel),
    decoded,
    advance: (ms: number) => {
      now += ms;
    },
    authored: () => vm.runInContext('authored', context),
  };
}

test('dual compacts both histories and keeps the current frame readable by legacy peers', () => {
  const f = sender();
  f.tick();
  assert.deepEqual(f.channels(), ['rollback-input', 'lockstep']);
  const [fast, reliable] = f.decoded();
  assert.ok(reliable!.history.length > 0);
  assert.equal(f.writes[1]!.data.byteLength, 136);
  assert.deepEqual(
    reliable!.history,
    Array.from({ length: 14 }, (_, i) => frame - 14 + i),
  );
  assert.equal(f.writes[0]!.data.byteLength, 80);
  assert.deepEqual(
    fast!.history,
    Array.from({ length: 7 }, (_, i) => frame - 7 + i),
  );
  for (const { data } of f.writes) {
    assert.deepEqual(decodeWords(Array.from(new Int32Array(data))), {
      frame,
      ...pad,
      ackFrame: 118,
      redundant: [],
    });
  }
  assert.equal(f.authored(), 1);
});

test('a fast packet repairs a recent hole below the highest ack while ordered delivery is blocked', () => {
  const f = sender();
  f.peer.lastAckFromPeer = frame - 1;
  f.tick();
  // Only the fast packet gets through. The receiver already acknowledged a
  // later input, but is still missing the oldest one in its rollback window.
  const [fast, reliable] = f.decoded();
  assert.deepEqual(reliable!.history, []);
  assert.ok(fast!.history.includes(frame - 7));
});

test('dual queues fast packets for every peer before an ordered retry backlog', () => {
  const f = sender('dual', true);
  f.resendAtSwitch[1] = { from: frame - 2, upTo: frame - 1, ack: 0 };
  f.tick();
  assert.deepEqual(
    f.writes.map(({ channel, data }) => [channel, decodeInput(data).frame]),
    [
      ['rollback-input', frame],
      ['rollback-input-2', frame],
      ['lockstep', frame - 2],
      ['lockstep', frame - 1],
      ['lockstep', frame],
      ['lockstep-2', frame],
    ],
  );
  assert.equal(f.authored(), 1);
});

for (const problem of ['closed', 'reliable-instead', 'backpressured', 'throwing'] as const) {
  test(`dual preserves reliable delivery when the fast channel is ${problem}`, () => {
    const f = sender();
    if (problem === 'closed') f.peer.rbDc.readyState = 'closed';
    if (problem === 'reliable-instead') f.peer.rbDcUnreliable = false;
    if (problem === 'backpressured') f.peer.rbDc.bufferedAmount = 8192;
    if (problem === 'throwing') f.peer.rbDc.fail = true;
    f.tick();
    assert.deepEqual(f.channels(), ['lockstep']);
    assert.ok(f.decoded()[0]!.history.length > 0);
    assert.equal(f.authored(), 1);
  });
}

test('a throwing reliable send still races the current input, and the next tick retries the missing reliable send', () => {
  const f = sender();
  f.peer.dc.fail = true;
  f.tick();
  assert.deepEqual(f.channels(), ['rollback-input']);
  assert.ok(f.decoded()[0]!.history.includes(frame - 1));
  f.peer.lastAckFromPeer = frame; // The fast copy advanced the acknowledgment.
  f.peer.dc.fail = false;
  f.advance(1);
  f.tick();
  assert.deepEqual(f.channels(), ['rollback-input', 'lockstep']);
  assert.equal(f.writes[1]!.data.byteLength, 24);
});

for (const mode of ['reliable', 'unreliable'] as const) {
  test(`explicit ${mode} uses its single carrier`, () => {
    const f = sender(mode);
    f.tick();
    assert.deepEqual(f.channels(), [mode === 'reliable' ? 'lockstep' : 'rollback-input']);
    assert.equal(f.decoded()[0]!.history.length > 0, mode === 'unreliable');
  });
}

test('a stuck simulation frame preserves the independent rate limit on each carrier', () => {
  const f = sender();
  f.tick();
  f.advance(15);
  f.tick();
  assert.deepEqual(f.channels(), ['rollback-input', 'lockstep']);
  f.advance(1);
  f.tick();
  assert.deepEqual(f.channels(), ['rollback-input', 'lockstep', 'rollback-input']);
  f.advance(84);
  f.tick();
  assert.deepEqual(f.channels().slice(-2), ['rollback-input', 'lockstep']);
});

test('the host negotiates the lobby choice unless diagnostics override it', () => {
  const negotiate = (dualInputEnabled?: boolean, overrides: (string | null)[] = [], slot = 0, local = true) => {
    const messages: string[] = [];
    const context = {
      _isLocalDev: local,
      _config: { dualInputEnabled },
      _playerSlot: slot,
      _peers: { peer: { dc: { readyState: 'open', send: (message: string) => messages.push(message) } } },
      overrides,
      window: {},
    };
    const transport = vm.runInNewContext(
      `
        const maxDelay = 2, _phase = 0, PHASE_RUNNING = 1, _syncLog = () => {};
        let _rbTransport = 'reliable';
        ${engineFunction('_sendInputTransport')}
        const diag = { ${between('          setTransport(mode) {', '\n          },')} } };
        for (const mode of overrides) diag.setTransport(mode);
        ${between('    // Host broadcasts effective delay so all players', '    _syncLog(`${readyCount + 1} players lockstep-ready')}
        _rbTransport;
      `,
      context,
    );
    return { transport, announcements: messages.filter((message) => message.startsWith('rb-transport:')) };
  };
  const ordered = { transport: 'reliable', announcements: ['rb-transport:reliable'] };
  const dual = { transport: 'dual', announcements: ['rb-transport:reliable', 'rb-transport:dual'] };
  assert.deepEqual(negotiate(), ordered);
  assert.deepEqual(negotiate(false), ordered);
  assert.deepEqual(negotiate(true), dual);
  assert.deepEqual(negotiate(false, ['dual']), dual);
  assert.deepEqual(negotiate(true, ['unreliable'], 0, false), dual);
  assert.deepEqual(negotiate(true, ['reliable']), ordered);
  assert.deepEqual(negotiate(true, ['unreliable']), {
    transport: 'unreliable',
    announcements: ['rb-transport:unreliable'],
  });
  assert.deepEqual(negotiate(true, ['reliable', null]), dual);
  assert.deepEqual(negotiate(false, ['dual', null]), ordered);
  assert.deepEqual(negotiate(true, ['dual'], 1), { transport: 'reliable', announcements: [] });
});

test('a dual announcement moves a legacy unordered guest to reliable before announcing the new policy', () => {
  const messages: string[] = [];
  const sendPolicy = vm.runInNewContext(engineFunction('_sendInputTransport') + '; _sendInputTransport');
  sendPolicy({ dc: { send: (message: string) => messages.push(message) } }, 'dual');
  assert.deepEqual(messages, ['rb-transport:reliable', 'rb-transport:dual']);
});

test('a retired fast channel cannot deliver queued input from an old connection in a mixed-version room', () => {
  const seen: ArrayBuffer[] = [];
  const open = vm.runInNewContext(
    `
   const peer={pc:{}}; const _peers={guest:peer};
   const _reconnectProofStatus=()=>false, _processInputPacket=(_sid,_peer,data)=>seen.push(data);
   ${engineFunction('setupRollbackInputDataChannel')}
   const channel={readyState:'connecting'}; peer.rbDc=channel;
   setupRollbackInputDataChannel('guest',channel);
   ({channel,peer})
 `,
    { ArrayBuffer, seen },
  );
  const data = encodeInput(frame, pad).buffer;
  open.channel.onmessage({ data });
  assert.deepEqual(seen, [data]);
  open.peer.pc = {};
  open.channel.onmessage({ data });
  assert.deepEqual(seen, [data]);
});
