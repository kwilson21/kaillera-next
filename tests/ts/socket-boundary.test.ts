import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkServerMessage,
  createBoundary,
  createProtocolObserver,
  DROP_LOG_LIMIT,
  takeAck,
  takeServerMessage,
  type ProtocolReport,
  redactPath,
  type WirePayload,
  REPORT_LIMIT,
} from '../../web/src/socket-boundary.ts';
import { KNCore } from '../../web/src/index.ts';
import { UsersUpdated } from '../../web/src/protocol.ts';

const token = { token: '1762992000.9f8e7d' };

/** A socket that only knows how to hand events to `onAny` listeners, as Socket.IO does. */
const fakeSocket = () => {
  const listeners: Array<(event: string, data: WirePayload) => void> = [];
  return {
    onAny: (listener: (event: string, data: WirePayload) => void): void => {
      listeners.push(listener);
    },
    receive: (event: string, data: WirePayload) => {
      for (const listener of listeners) listener(event, data);
    },
  };
};

const collector = (ready: () => boolean = () => true) => {
  const reports: ProtocolReport[] = [];
  const observer = createProtocolObserver((report) => {
    if (!ready()) return false;
    reports.push(report);
    return true;
  });
  return { reports, observer };
};

const microtasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test('a message that matches its schema is not an issue', () => {
  assert.equal(checkServerMessage('upload-token', token), null);
  assert.equal(checkServerMessage('game-ended', { matchId: null }), null);
  assert.equal(checkServerMessage('session-log ack', { lastSeq: 3, auditLastSeq: -1 }), null);
});

test('a message off its schema names the path, not the value', () => {
  const issue = checkServerMessage('game-ended', { matchId: 7 });
  assert.ok(issue?.includes('matchId'));
  const named = checkServerMessage('upload-token', { token: { leaked: 'do-not-report-me' } });
  assert.ok(named?.includes('token'));
  assert.ok(!named?.includes('do-not-report-me'));
});

test('a record key in the path is payload data and is starred out, whatever it looks like', () => {
  const underKey = (key: string): string =>
    checkServerMessage('users-updated', { players: { [key]: { socketId: 7 } } }) ?? '';
  for (const key of [
    'b955ef2d-e4c1-4f6c-ad85-861949b2fe25',
    // A client may call itself anything: short and letters-only is still not ours.
    'Alice',
    // Even the name of one of our own fields, when it sits where a key goes.
    'slot',
    'has"quote',
    'has]bracket',
  ]) {
    const issue = underKey(key);
    assert.ok(issue.includes('["players"]["*"]["socketId"]'), `${key}: ${issue}`);
    assert.ok(!issue.includes(key), `${key}: ${issue}`);
  }
});

test('field names survive at every depth, and array positions are starred', () => {
  const ast = UsersUpdated.ast;
  assert.equal(redactPath('at ["hostRom"]["game_id"]', ast), 'at ["hostRom"]["game_id"]');
  assert.equal(redactPath('at ["players"]["Alice"]["slot"]', ast), 'at ["players"]["*"]["slot"]');
  // A key that is not in the schema at all tells nothing about where to go next.
  assert.equal(redactPath('at ["nope"]["slot"]', ast), 'at ["*"]["*"]');
  assert.equal(redactPath('no path here', ast), 'no path here');
});

test('relays and unknown events are not judged', () => {
  // Peers' signals and data messages are built by another client, not the server.
  assert.equal(checkServerMessage('webrtc-signal', { sender: 'a', offer: {} }), null);
  assert.equal(checkServerMessage('data-message', { type: 'mode-select', mode: 'turbo' }), null);
  assert.equal(checkServerMessage('connect', undefined), null);
});

test('the observer reports a mismatch on an incoming event', async () => {
  const { reports, observer } = collector();
  const socket = fakeSocket();
  observer.observe(socket);
  socket.receive('upload-token', token);
  socket.receive('game-ended', {});
  await microtasks();
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.type, 'protocol-mismatch');
  assert.equal(reports[0]?.message, 'game-ended');
});

test('the same mismatch is reported once, a different one again', () => {
  const { reports, observer } = collector();
  assert.equal(observer.check('game-ended', {}), false);
  assert.equal(observer.check('game-ended', {}), false);
  assert.equal(observer.check('game-ended', { matchId: 7 }), false);
  assert.equal(observer.check('game-ended', { matchId: null }), true);
  assert.equal(reports.length, 2);
});

test('an ack is checked under the name of the event it answers', () => {
  const { reports, observer } = collector();
  assert.equal(observer.checkAck('session-log', { lastSeq: 1, auditLastSeq: 0 }), true);
  assert.equal(observer.checkAck('join-room', { players: {} }), false);
  assert.equal(reports[0]?.message, 'join-room ack');
});

test('an observed socket holds its reports until the server sends an upload token', async () => {
  // The sink is ready throughout, as a page with a token restored from storage would be.
  const { reports, observer } = collector();
  const socket = fakeSocket();
  observer.observe(socket);
  // The first users-updated arrives before the upload token client events need.
  socket.receive('users-updated', { players: {} });
  await microtasks();
  assert.equal(reports.length, 0);
  // A malformed token message is not a token.
  socket.receive('upload-token', {});
  await microtasks();
  assert.equal(reports.length, 0);
  socket.receive('upload-token', token);
  // Socket.IO runs onAny listeners first; the page's handler stores the token after.
  assert.equal(reports.length, 0);
  await microtasks();
  assert.deepEqual(
    reports.map((report) => report.message),
    ['users-updated', 'upload-token'],
  );
});

test('reports also wait for a sink that cannot take them yet', () => {
  let ready = false;
  const { reports, observer } = collector(() => ready);
  assert.equal(observer.check('game-ended', {}), false);
  assert.equal(reports.length, 0);
  ready = true;
  observer.flush();
  assert.equal(reports.length, 1);
});

test('a page sends a bounded number of reports', () => {
  const { reports, observer } = collector();
  for (let i = 0; i < REPORT_LIMIT * 3; i += 1)
    observer.check('rom-sharing-updated', { romSharing: `no-${i}`, [`k${i}`]: i });
  // Each of those is the same issue (wrong type at the same path): one report.
  assert.equal(reports.length, 1);
  const many = collector();
  const wrongPayloads: WirePayload[] = [
    null,
    1,
    'x',
    [],
    {},
    { matchId: 1 },
    { matchId: true },
    { matchId: [] },
    { matchId: {} },
  ];
  for (const event of ['game-ended', 'upload-token', 'reconnect-token', 'rom-sharing-updated', 'game-started']) {
    for (const payload of wrongPayloads) many.observer.check(event, payload);
  }
  assert.ok(many.reports.length <= REPORT_LIMIT);
  assert.ok(many.reports.length > 5);
});

test('KNCore exposes the observer to play.js', () => {
  assert.equal(KNCore.protocol.createObserver, createProtocolObserver);
  assert.equal(KNCore.protocol.checkServerMessage, checkServerMessage);
});

// ── deciding: handlers sit behind the boundary ───────────────────────────────

const ROM_HASH = `S${'ab'.repeat(32)}`;
const hostRom = {
  hash: ROM_HASH,
  name: 'Smash.z64',
  size: 16777216,
  gameId: 'ssb64',
  game_id: 'ssb64',
};
const room = {
  players: {
    'pid-host': {
      socketId: 'sid-host',
      playerName: 'Host',
      slot: 0,
      romReady: true,
      inputType: 'gamepad',
      deviceType: 'desktop',
    },
  },
  spectators: { 'pid-spec': { socketId: 'sid-spec', playerName: 'Watcher' } },
  owner: 'sid-host',
  romSharing: true,
  romHash: ROM_HASH,
  romName: 'Smash.z64',
  rom_name: 'Smash.z64',
  romSize: 16777216,
  rom_size: 16777216,
  hostRom,
  gameId: 'ssb64',
  game_id: 'ssb64',
  mode: null,
  status: 'playing',
  listed: false,
};

/** One payload of each server-authored event, as the server builds it (its models forbid other keys). */
const SENT = [
  ['users-updated', room],
  [
    'game-started',
    {
      mode: 'streaming',
      resyncEnabled: false,
      romHash: null,
      romName: null,
      rom_name: null,
      romSize: null,
      rom_size: null,
      hostRom: {
        hash: null,
        name: null,
        size: null,
        gameId: 'ssb64',
        game_id: 'ssb64',
      },
      gameId: 'ssb64',
      matchId: '5b0c9a4e-7f1d-4c55-9a53-0e6f1f2f7a10',
    },
  ],
  ['game-ended', { matchId: null }],
  ['rom-sharing-updated', { romSharing: false }],
  ['upload-token', token],
  ['reconnect-token', token],
] as const;

const logging = () => {
  const lines: string[] = [];
  return { lines, boundary: createBoundary((line) => lines.push(line)) };
};

test('every server message as the server sends it reaches its handler as sent', () => {
  const { lines, boundary } = logging();
  for (const [event, payload] of SENT) {
    const got: WirePayload[] = [];
    boundary.server(event, (value) => got.push(value))(payload);
    // The handler used to get the raw payload; it now gets the decoded one, which is the same.
    assert.deepEqual(got, [payload], event);
    assert.ok(takeServerMessage(event, payload).ok, event);
  }
  assert.deepEqual(lines, []);
});

test('a server message off its schema is dropped: its handler does not run, and it is logged once per reason', () => {
  const { lines, boundary } = logging();
  let ran = 0;
  const handler = boundary.server('rom-sharing-updated', () => {
    ran++;
  });
  handler({ unexpected: true });
  handler({ unexpected: true });
  handler({ romSharing: 'yes' });
  boundary.server('users-updated', () => ran++)({ ...room, owner: 7 });
  assert.equal(ran, 0);
  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? '', /^\[protocol\] dropped rom-sharing-updated: .*romSharing/);
  assert.match(lines[2] ?? '', /^\[protocol\] dropped users-updated: .*owner/);
  // The handler still runs on the next message that decodes.
  handler({ romSharing: true });
  assert.equal(ran, 1);
});

test('a relay a peer may send is handed on as sent; anything else is dropped', () => {
  const { lines, boundary } = logging();
  const got: WirePayload[] = [];
  const onData = boundary.relay('data-message', (data) => got.push(data));
  const stamped = {
    type: 'mode-select',
    mode: 'streaming',
    knFrom: { sid: 'sid-host', slot: 0, owner: true },
  };
  onData(stamped);
  onData({ type: 'rom-accepted', sender: 'sid-guest' });
  onData({ type: 'mode-select', mode: 'lockstep-ish' });
  onData({ type: 'no-such-message' });
  onData('not an object');
  assert.deepEqual(got, [stamped, { type: 'rom-accepted', sender: 'sid-guest' }]);
  assert.equal(lines.length, 3);
  const signals: WirePayload[] = [];
  const onSignal = boundary.relay('rom-signal', (data) => signals.push(data));
  onSignal({
    sender: 'sid-host',
    target: 'sid-guest',
    candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
  });
  onSignal({ candidate: 7 });
  assert.equal(signals.length, 1);
});

test('a join-room ack: decoded when it matches, null when absent or off its schema', () => {
  const { lines, boundary } = logging();
  const ack = { ...room, rom_hash: ROM_HASH, rom_sharing: true, matchId: 'm1' };
  assert.deepEqual(boundary.ack('join-room', ack), ack);
  assert.equal(boundary.ack('join-room', null), null);
  assert.equal(boundary.ack('join-room', undefined), null);
  assert.deepEqual(lines, []);
  assert.equal(boundary.ack('join-room', { ...ack, matchId: 3 }), null);
  assert.match(lines[0] ?? '', /^\[protocol\] dropped join-room ack: .*matchId/);
  assert.ok(takeAck('session-log', { lastSeq: 3, auditLastSeq: -1 }).ok);
});

// A page loaded before a deploy runs against the new server until version-guard reloads it.
test('a newer server: a field this page does not know is left out, and the message still reaches its handler', () => {
  const { lines, boundary } = logging();
  for (const [event, payload] of SENT) {
    const got: WirePayload[] = [];
    boundary.server(event, (value) => got.push(value))({ ...payload, addedByANewerServer: { any: 'thing' } });
    assert.deepEqual(got, [payload], event);
  }
  const ack = { ...room, rom_hash: ROM_HASH, rom_sharing: true, matchId: 'm1' };
  assert.deepEqual(boundary.ack('join-room', { ...ack, addedByANewerServer: 1 }), ack);
  const roster = { ...room, players: { 'pid-host': { ...room.players['pid-host'], addedByANewerServer: 1 } } };
  const rosters: WirePayload[] = [];
  boundary.server('users-updated', (value) => rosters.push(value))(roster);
  assert.deepEqual(rosters, [room]);
  assert.deepEqual(lines, []);
});

test('a newer server: a room status or mode this page does not know still updates the roster', () => {
  const { lines, boundary } = logging();
  const newer = { ...room, status: 'paused', mode: 'spectate-only' };
  const rosters: WirePayload[] = [];
  boundary.server('users-updated', (value) => rosters.push(value))(newer);
  assert.deepEqual(rosters, [newer]);
  const ack = { ...newer, rom_hash: ROM_HASH, rom_sharing: true, matchId: null };
  assert.deepEqual(boundary.ack('join-room', ack), ack);
  assert.deepEqual(lines, []);
});

test('a newer server: a game started in a mode this page does not know is dropped', () => {
  const { lines, boundary } = logging();
  const started = SENT.find(([event]) => event === 'game-started')?.[1];
  let ran = 0;
  boundary.server('game-started', () => ran++)({ ...started, mode: 'spectate-only' });
  assert.equal(ran, 0);
  assert.match(lines[0] ?? '', /^\[protocol\] dropped game-started: .*mode/);
});

test('a ROM transfer channel string: what the channel carries is taken, anything else dropped', () => {
  const { lines, boundary } = logging();
  assert.equal(boundary.peerText('rom-transfer', JSON.stringify({ type: 'rom-resume', offset: 65536 })), true);
  assert.equal(boundary.peerText('rom-transfer', JSON.stringify({ type: 'rom-complete' })), true);
  assert.equal(boundary.peerText('rom-transfer', JSON.stringify({ type: 'rom-resume', offset: 'start' })), false);
  assert.equal(boundary.peerText('rom-transfer', 'not json'), false);
  assert.equal(lines.length, 2);
});

test('a page logs a bounded number of dropped messages', () => {
  const { lines, boundary } = logging();
  for (let i = 0; i < 100; i++) boundary.ack('join-room', { players: i });
  for (let i = 0; i < 100; i++) boundary.server('game-ended', () => undefined)({ matchId: i });
  assert.ok(lines.length <= DROP_LOG_LIMIT);
});

test('KNCore gives play.js the boundary', () => {
  assert.equal(KNCore.protocol.createBoundary, createBoundary);
  assert.equal(KNCore.protocol.takeServerMessage, takeServerMessage);
});
