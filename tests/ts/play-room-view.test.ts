import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  infoPanel,
  slotView,
  spectatorLine,
  startButton,
  type EngineInfo,
  type SlotPlayer,
} from '../../web/src/play/room-view.ts';

// ── the code this module replaced, kept as an oracle ─────────────────────────
// web/static/play.js as of #150, with its element writes turned into a
// returned record and its page state turned into parameters.

type OldBadge = [string, string, boolean];

const oldSlot = (player: SlotPlayer | null, isOwner: boolean, gameRunning: boolean, isSpectator: boolean) => {
  const noInput: OldBadge = ['', '', false];
  const noDevice: OldBadge = ['', '', false];
  const out = {
    name: '',
    empty: false,
    flair: false,
    romText: '',
    romClassName: 'rom-status',
    input: noInput,
    device: noDevice,
    claimHidden: true,
  };
  if (player) {
    out.claimHidden = true;
    const suffix = isOwner ? ' (host)' : '';
    out.name = player.playerName + suffix;
    out.empty = false;
    out.flair = /\b(a21|agent[- ]?21|atwenty0ne)\b/i.test(player.playerName);
    if (!gameRunning) {
      const ready = !!player.romReady;
      out.romText = ready ? '✓ ROM' : 'needs ROM';
      out.romClassName = `rom-status ${ready ? 'ready' : 'not-ready'}`;
    } else {
      out.romText = '';
      out.romClassName = 'rom-status';
    }
    const itype = player.inputType || 'keyboard';
    out.input = [itype === 'gamepad' ? '🎮' : '⌨️', itype === 'gamepad' ? 'Gamepad' : 'Keyboard', true];
    const dtype = player.deviceType || 'desktop';
    out.device = [dtype === 'mobile' ? '📱' : '🖥️', dtype === 'mobile' ? 'Mobile' : 'Desktop', true];
  } else {
    out.name = 'Open';
    out.empty = true;
    out.flair = false;
    out.claimHidden = !(isSpectator && !gameRunning);
  }
  return out;
};

const oldStart = (players: readonly { romReady?: boolean }[], selectedMode: string, romSharing: boolean) => {
  const playerCount = players.length;
  if (playerCount < 1) return { disabled: true, label: 'Start Game' };
  if (selectedMode === 'streaming' && playerCount < 2) return { disabled: true, label: 'Start Game (need 2+)' };
  if (selectedMode === 'streaming') return { disabled: false, label: 'Start Game' };
  const allReady = players.every((p) => p.romReady);
  if (!allReady && !romSharing) {
    const readyCount = players.filter((p) => p.romReady).length;
    return { disabled: true, label: `Waiting for ROMs (${readyCount}/${playerCount})` };
  }
  return { disabled: false, label: 'Start Game' };
};

const oldNormalizeMode = (raw: string) => (raw === 'streaming' ? 'streaming' : 'rollback');

const oldInfo = (info: EngineInfo | null, hasGamepad: boolean) => {
  if (!info) return { header: '', stats: 'FPS: -- | Ping: --', peers: '' };
  const inputType = hasGamepad ? 'Gamepad' : 'Keyboard';
  const engineMode = oldNormalizeMode(info.mode);
  const modeLabel = engineMode === 'streaming' ? 'Streaming' : 'Rollback';
  const parts: string[] = [];
  parts.push(`FPS: ${info.fps || 0}`);
  const pingStr = info.ping !== null && info.ping !== undefined ? `${Math.round(info.ping)}ms` : '--';
  parts.push(`Ping: ${pingStr}`);
  if (engineMode === 'rollback') {
    if (info.rollback) parts.push(`Delay: ${info.frameDelay}f (feels 0f)`);
    else parts.push(`Delay: ${info.frameDelay}f`);
    parts.push(`Players: ${info.playerCount}`);
    if (info.rollback) parts.push(`Rollback: ${info.rollback.rollbacks}/${info.rollback.predictions}`);
    if (info.syncEnabled && (info.resyncCount ?? 0) > 0) parts.push(`Resyncs: ${info.resyncCount}`);
  } else {
    if (info.codec && info.codec !== '?') parts.push(info.codec);
    if (info.resolution && info.resolution !== '?x?') parts.push(info.resolution);
    parts.push(`Players: ${info.playerCount}`);
  }
  const peerLines: string[] = [];
  if (engineMode === 'rollback' && info.peers) {
    for (const p of info.peers) {
      const pRtt = p.rtt !== null ? `${Math.round(p.rtt)}ms` : '--';
      peerLines.push(`P${p.slot + 1}: ${pRtt}`);
    }
  } else if (info.mode === 'streaming') {
    if (info.encodeTime !== null) peerLines.push(`Encode: ${info.encodeTime}ms`);
    if (info.bitrate !== null) peerLines.push(`BW: ${info.bitrate}Mbps`);
    if (info.jitter !== null) peerLines.push(`Jitter: ${info.jitter}ms`);
    if (info.lossRate && info.lossRate > 0) peerLines.push(`Loss: ${info.lossRate}%`);
  }
  return { header: `${modeLabel} | ${inputType}`, stats: parts.join(' | '), peers: peerLines.join(' | ') };
};

// ── slots ────────────────────────────────────────────────────────────────────

test('every slot shows what the old code showed', () => {
  const players: (SlotPlayer | null)[] = [null];
  for (const playerName of ['Ana', 'agent 21', 'A21', 'a210', '']) {
    for (const romReady of [true, false, undefined]) {
      for (const inputType of ['keyboard', 'gamepad', '', undefined]) {
        for (const deviceType of ['desktop', 'mobile', undefined]) {
          players.push({ playerName, romReady, inputType, deviceType });
        }
      }
    }
  }
  let compared = 0;
  for (const player of players) {
    for (const isOwner of [true, false]) {
      for (const gameRunning of [true, false]) {
        for (const viewerSpectates of [true, false]) {
          const view = slotView(player, { isOwner, gameRunning, viewerSpectates });
          const old = oldSlot(player, isOwner, gameRunning, viewerSpectates);
          assert.deepEqual(
            {
              name: view.name,
              empty: view.empty,
              flair: view.flair,
              romText: view.romText,
              romClassName: view.romClass ? `rom-status ${view.romClass}` : 'rom-status',
              input: view.input ? [view.input.icon, view.input.label, true] : ['', '', false],
              device: view.device ? [view.device.icon, view.device.label, true] : ['', '', false],
              claimHidden: view.claimHidden,
            },
            old,
          );
          compared++;
        }
      }
    }
  }
  assert.equal(compared, 1448);
});

test('a slot names its player, marks the host, and says who still needs a ROM', () => {
  const lobby = { isOwner: true, gameRunning: false, viewerSpectates: false };
  const view = slotView({ playerName: 'Ana', romReady: false, inputType: 'gamepad', deviceType: 'mobile' }, lobby);
  assert.equal(view.name, 'Ana (host)');
  assert.deepEqual([view.romText, view.romClass], ['needs ROM', 'not-ready']);
  assert.deepEqual([view.input?.label, view.device?.label], ['Gamepad', 'Mobile']);
});

test('an open slot can be taken by a spectator, in the lobby only', () => {
  const open = (viewerSpectates: boolean, gameRunning: boolean) =>
    slotView(null, { isOwner: false, gameRunning, viewerSpectates }).claimHidden;
  assert.equal(open(true, false), false);
  assert.equal(open(true, true), true);
  assert.equal(open(false, false), true);
});

test('the spectator line names who is watching, or is empty', () => {
  assert.equal(spectatorLine([]), '');
  assert.equal(spectatorLine(['Bo', 'Cy']), 'Watching: Bo, Cy');
});

// ── Start ────────────────────────────────────────────────────────────────────

test('the Start button is what the old code made it', () => {
  let compared = 0;
  for (const mode of ['rollback', 'streaming', 'lockstep', '']) {
    for (const romSharing of [true, false]) {
      for (let count = 0; count <= 4; count++) {
        for (let ready = 0; ready <= count; ready++) {
          const players = Array.from({ length: count }, (_, i) => ({ romReady: i < ready }));
          assert.deepEqual(startButton(count, ready, mode, romSharing), oldStart(players, mode, romSharing));
          compared++;
        }
      }
    }
  }
  assert.equal(compared, 120);
});

test('rollback waits for every ROM unless the host shares theirs; streaming needs a second person', () => {
  assert.deepEqual(startButton(2, 1, 'rollback', false), { disabled: true, label: 'Waiting for ROMs (1/2)' });
  assert.deepEqual(startButton(2, 1, 'rollback', true), { disabled: false, label: 'Start Game' });
  assert.deepEqual(startButton(1, 0, 'streaming', false), { disabled: true, label: 'Start Game (need 2+)' });
  assert.deepEqual(startButton(2, 0, 'streaming', false), { disabled: false, label: 'Start Game' });
});

// ── info panel ───────────────────────────────────────────────────────────────

test('the info panel reads as the old code wrote it', () => {
  const infos: (EngineInfo | null)[] = [null];
  for (const mode of ['rollback', 'streaming', 'lockstep']) {
    for (const rollback of [null, { rollbacks: 3, predictions: 40 }]) {
      for (const ping of [null, undefined, 0, 41.6]) {
        for (const peers of [
          null,
          [],
          [
            { slot: 0, rtt: 12.4 },
            { slot: 2, rtt: null },
          ],
        ]) {
          for (const lossRate of [null, 0, 1.5]) {
            infos.push({
              mode,
              fps: ping === 0 ? 0 : 59,
              ping,
              frameDelay: 3,
              playerCount: 2,
              rollback,
              syncEnabled: lossRate !== null,
              resyncCount: lossRate ? 2 : 0,
              codec: lossRate === 0 ? '?' : 'VP9',
              resolution: lossRate === 0 ? '?x?' : '640x480',
              peers,
              encodeTime: lossRate === null ? null : 4,
              bitrate: lossRate === null ? null : 2.5,
              jitter: lossRate === null ? null : 7,
              lossRate,
            });
          }
        }
      }
    }
  }
  for (const info of infos) {
    for (const hasGamepad of [true, false]) {
      assert.deepEqual(infoPanel(info, hasGamepad), oldInfo(info, hasGamepad));
    }
  }
  assert.equal(infos.length, 217);
});

test('a rollback match shows delay, rollbacks and each peer; a stream shows its codec and network', () => {
  assert.deepEqual(
    infoPanel(
      {
        mode: 'rollback',
        fps: 60,
        ping: 33.4,
        frameDelay: 2,
        playerCount: 2,
        rollback: { rollbacks: 5, predictions: 90 },
        peers: [{ slot: 1, rtt: 33.4 }],
      },
      false,
    ),
    {
      header: 'Rollback | Keyboard',
      stats: 'FPS: 60 | Ping: 33ms | Delay: 2f (feels 0f) | Players: 2 | Rollback: 5/90',
      peers: 'P2: 33ms',
    },
  );
  assert.deepEqual(
    infoPanel(
      {
        mode: 'streaming',
        fps: 30,
        ping: null,
        playerCount: 3,
        codec: 'VP9',
        resolution: '640x480',
        encodeTime: 4,
        bitrate: 2.5,
        jitter: 7,
        lossRate: 0,
      },
      true,
    ),
    {
      header: 'Streaming | Gamepad',
      stats: 'FPS: 30 | Ping: -- | VP9 | 640x480 | Players: 3',
      peers: 'Encode: 4ms | BW: 2.5Mbps | Jitter: 7ms',
    },
  );
});
