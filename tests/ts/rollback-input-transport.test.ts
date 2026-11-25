import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { decodeInput, encodeInput } from '../../web/src/input-wire.ts';
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
const pad = { buttons: 8, lx: -48, ly: 29, cx: -12, cy: 24 };
const frame = 140;
function sender(mode: 'dual' | 'reliable' | 'unreliable' = 'dual') {
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
  let now = 1000;
  const context = vm.createContext({
    performance: { now: () => now },
    activePeers: [peer],
    _rbTransport: mode,
    _frameNum: frame,
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
    const _useCRollback = true, _catchUpTo = -1, _resendAtSwitch = {}, _syncLog = () => {};
    ${['RB_RESEND_AT_SWITCH_MAX', 'RB_INPUT_HISTORY_MAX', 'DC_BUFFER_THRESHOLD', 'INPUT_RESEND_EVERY_MS', 'INPUT_RESEND_RELIABLE_MS'].map((k) => between('  const ' + k + ' =', ';') + ';').join('\n')}
    let _rbTransportPacketsSent = 0, _catchUpSendsReliable = 0, _catchUpSendsUnreliable = 0, authored = 0;
    const _recordAuthoredOwnerInput = () => { authored++; };
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

test('dual sends recoverable reliable history first and the same bare current input on the unordered channel', () => {
  const f = sender();
  f.tick();
  assert.deepEqual(f.channels(), ['lockstep', 'rollback-input']);
  const [reliable, fast] = f.decoded();
  assert.ok(reliable!.history.length > 0);
  assert.ok(
    f.writes[0]!.data.byteLength <= 256,
    'legacy peers must admit the reliable frame even if the fast copy is lost',
  );
  assert.deepEqual(
    reliable!.history,
    Array.from({ length: 14 }, (_, i) => frame - 14 + i),
  );
  assert.deepEqual(fast!.history, []);
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
  assert.deepEqual(f.decoded()[0]!.history, []);
  f.peer.lastAckFromPeer = frame; // The fast copy advanced the acknowledgment.
  f.peer.dc.fail = false;
  f.advance(1);
  f.tick();
  assert.deepEqual(f.channels(), ['rollback-input', 'lockstep']);
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
  assert.deepEqual(f.channels(), ['lockstep', 'rollback-input']);
  f.advance(1);
  f.tick();
  assert.deepEqual(f.channels(), ['lockstep', 'rollback-input', 'rollback-input']);
  f.advance(84);
  f.tick();
  assert.deepEqual(f.channels().slice(-2), ['lockstep', 'rollback-input']);
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
