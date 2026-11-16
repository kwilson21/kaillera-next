import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const handler = source.slice(
  source.indexOf('  const _processInputPacket ='),
  source.indexOf('  // Unordered input DC'),
);

for (const incomingLx of [0, 35]) {
  for (const seeded of [false, true]) {
    for (const redundant of [false, true]) {
      test(`real lx=${incomingLx} ${redundant ? 'redundancy' : 'header'} replaces placeholder once (seed marker=${seeded})`, () => {
        const ctx = vm.createContext({ seeded, redundant, incomingLx });
        vm.runInContext(
          `
        const zero={buttons:0,lx:0,ly:0,cx:0,cy:0};
        const KNShared={ZERO_INPUT:zero,decodeInput:x=>x};
        const _isPeerPendingLateJoin=()=>false, _syncLog=()=>{}, _auditRecordRemote=()=>{};
        const performance={now:()=>1};
        const _frameNum=1602, _catchUpTo=0, DELAY_FRAMES=12;
        const INPUT_PAST_WINDOW_FRAMES=240, INPUT_FUTURE_MARGIN_FRAMES=60;
        const _phase=1, PHASE_RUNNING=1, _inputLateLogTime={};
        const _remoteInputs={0:{1603:zero}}, _peerLastAdvanceTime={}, _lastKnownInput={};
        const _pendingCInputs=[], _useCRollback=true;
        let _rbTransportDupsRecv=0, _remoteReceived=0, _lastRemoteFrame=-1;
        const _peerInputStarted={}, _lastRemoteFramePerSlot={}, _peerPhantom={};
        const marks=new Set(seeded?[1603]:[]);
        const _consumeLateJoinSeededInput=(slot,frame)=>marks.delete(frame);
        const _inputEq=(a,b)=>a&&a.buttons===b.buttons&&a.lx===b.lx&&a.ly===b.ly&&a.cx===b.cx&&a.cy===b.cy;
        const peer={slot:0};
        ${handler}
        // Future left arrives first: native prediction must not override
        // the real neutral 1603 merely because JS had a neutral placeholder.
        _processInputPacket('host',peer,{frame:1613,...zero,lx:-70});
        const packet=redundant
          ? {frame:1613,...zero,lx:-70,redundant:[{frame:1603,...zero,lx:incomingLx}]}
          : {frame:1603,...zero,lx:incomingLx};
        _processInputPacket('host',peer,packet);
        _processInputPacket('host',peer,packet);
        globalThis.queued=_pendingCInputs.filter(x=>x.frame===1603);
      `,
          ctx,
        );
        assert.equal(ctx.queued.length, 1, 'first real neutral must reach C, true duplicate must not');
        assert.equal(ctx.queued[0].lx, incomingLx);
        assert.equal(vm.runInContext('_remoteInputs[0][1603]===zero', ctx), false);
      });
    }
  }
}
