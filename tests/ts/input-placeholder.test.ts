import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { decodeInput, encodeInput, type FrameInput } from '../../web/src/input-wire.ts';

const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const handler = source.slice(
  source.indexOf('  const _processInputPacket ='),
  source.indexOf('  const setupRollbackInputDataChannel ='),
);
const definition = (name: string, next: string) =>
  source.slice(
    source.indexOf('  const ' + name + ' ='),
    source.indexOf(next, source.indexOf('  const ' + name + ' =')),
  );
const neutral = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };

function receiver(seeded = false) {
  const queued: FrameInput[] = [];
  const audited: { f: number; b: number }[] = [];
  const zero = { ...neutral };
  const inputs = Object.fromEntries([[1603, zero]]);
  const dc = { label: 'lockstep' },
    rbDc = { label: 'rollback-input' };
  const peer = { slot: 1, dc, rbDc };
  const context = vm.createContext({
    performance,
    _hostInputAuthor: () => null,
    _auditPending: audited,
    seeded,
    _remoteInputs: { 1: inputs },
    _pendingCInputs: queued,
    KNShared: { ZERO_INPUT: zero, decodeInput },
    peer,
  });
  const receive: (packet: ArrayBuffer, channel: typeof dc) => boolean = vm.runInContext(
    `
    const _isPeerPendingLateJoin=()=>false, _syncLog=()=>{};
    const _admissionInputFloor=()=>0, _checkpointFloor=0, _checkpoint=null;
    const _frameNum=1602, _catchUpTo=0, DELAY_FRAMES=12;
    const INPUT_PAST_WINDOW_FRAMES=240, INPUT_FUTURE_MARGIN_FRAMES=60;
    const _phase=1, PHASE_RUNNING=1, _inputLateLogTime={};
    const _peerLastAdvanceTime={}, _lastKnownInput={}, _useCRollback=true;
    let _rbTransportDupsRecv=0, _remoteReceived=0, _lastRemoteFrame=-1;
    const _peerInputStarted={}, _lastRemoteFramePerSlot={}, _peerPhantom={};
    const marks=new Set(seeded?[1603]:[]);
    const _consumeLateJoinSeededInput=(slot,frame)=>marks.delete(frame);
    ${definition('_inputButtons', '  const _cloneInput =')}
    const _auditLastRemote={}, AUDIT_PENDING_MAX=20000;
    let _auditSeq=0;
    ${definition('_auditPush', '  const _auditRecordLocal =')}
    ${definition('_auditRecordRemote', '  let _peerInputStarted =')}
    ${handler}
    (packet, channel) => _processInputPacket('guest',peer,packet,channel)
  `,
    context,
  );
  return { queued, audited, inputs, zero, receive, dc, rbDc };
}

for (const incomingLx of [0, 35]) {
  for (const seeded of [false, true]) {
    for (const redundant of [false, true]) {
      test(`real lx=${incomingLx} ${redundant ? 'redundancy' : 'header'} replaces placeholder once (seed marker=${seeded})`, () => {
        const f = receiver(seeded);
        const left = { ...neutral, lx: -70 };
        const input = { ...neutral, lx: incomingLx };
        f.receive(encodeInput(1613, left).buffer, f.rbDc);
        const packet = redundant
          ? encodeInput(1613, left, -1, [{ frame: 1603, ...input }]).buffer
          : encodeInput(1603, input).buffer;
        f.receive(packet, f.dc);
        f.receive(packet, f.dc);
        const queued = f.queued.filter((x) => x.frame === 1603);
        assert.equal(queued.length, 1, 'first real input must reach C, true duplicate must not');
        assert.equal(queued[0]!.lx, incomingLx);
        assert.notEqual(f.inputs[1603], f.zero);
      });
    }
  }
}

for (const fastFirst of [true, false]) {
  test(`the first current input reaches rollback immediately and reliable history fills the gap (fast first=${fastFirst})`, () => {
    const f = receiver();
    const current = { buttons: 8, lx: -44, ly: 21, cx: 16, cy: -25 };
    const prior = { frame: 1612, buttons: 32, lx: 52, ly: -16, cx: 18, cy: 23 };
    const fast = encodeInput(1613, current, 1596).buffer;
    const reliable = encodeInput(1613, current, 1596, [prior]).buffer;
    const first = fastFirst ? () => f.receive(fast, f.rbDc) : () => f.receive(reliable, f.dc);
    const second = fastFirst ? () => f.receive(reliable, f.dc) : () => f.receive(fast, f.rbDc);
    assert.equal(first(), true);
    assert.deepEqual(
      f.queued.map((x) => x.frame),
      fastFirst ? [1613] : [1612, 1613],
    );
    assert.equal(second(), true);
    assert.deepEqual(
      f.queued.map((x) => x.frame),
      fastFirst ? [1613, 1612] : [1612, 1613],
    );
    for (const { frame, ...buttons } of [prior, { frame: 1613, ...current }]) {
      assert.deepEqual({ ...f.inputs[frame] }, buttons);
    }
  });
}

test('late reliable headers leave the input audit unchanged except for newly recovered history', () => {
  const f = receiver();
  const a = { ...neutral, buttons: 1 },
    b = { ...neutral, buttons: 2 };
  f.receive(encodeInput(1613, a).buffer, f.rbDc);
  f.receive(encodeInput(1614, b).buffer, f.rbDc);
  f.receive(encodeInput(1613, a).buffer, f.dc);
  f.receive(encodeInput(1614, b).buffer, f.dc);
  assert.deepEqual(
    f.audited.map((row) => row.f),
    [1613, 1614],
  );
  const repaired = encodeInput(1613, a, -1, [{ frame: 1612, ...neutral }]).buffer;
  f.receive(repaired, f.dc);
  f.receive(encodeInput(1614, b, -1, [{ frame: 1613, ...a }]).buffer, f.dc);
  f.receive(repaired, f.dc);
  f.receive(encodeInput(1615, b).buffer, f.rbDc);
  // A delta for the repaired frame must restore A at 1613 and keep B as
  // the live baseline. Its reliable duplicates must add no further deltas.
  assert.deepEqual(
    f.audited.map((row) => [row.f, row.b]),
    [
      [1613, 1],
      [1614, 2],
      [1612, 0],
      [1613, 1],
    ],
  );
});
