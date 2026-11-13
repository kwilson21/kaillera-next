import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  instanceConstants,
  mbtLabels,
  runScenarios,
  sequenceDiagram,
  show,
  type ItfTrace,
} from '../../scripts/quint-trace.mts';

const SPEC = `
module room {
  const FIXED: bool

  // The host opens a room
  // and a friend joins.
  run joinTest =
    init
      .then(openRoom("host"))
      .then(join("guest", true)).then(startGame)
      .expect(page.get("guest") == Lobby)
      .then(if (FIXED) admit("guest").then(beginSync) else endGame)
      .then(if (not(FIXED)) stutter else leave("guest"))
      .expect(if (FIXED) status == "lobby" else true)

  run undecidableTest =
    init
      .then(if (status == "lobby") startGame else endGame)
}

module room_fixed {
  import room(FIXED = true,
         OTHER = false).*
}

module room_before {
  import room(FIXED = false, OTHER = false).*
}
`;

/** The spec without the run whose branch cannot be decided. */
const DECIDABLE = SPEC.replace(/ {2}run undecidableTest[\s\S]*?\n\}/, '}');

const page = (...entries: [string, string][]) => ({
  '#map': entries.map(([who, tag]) => [who, { tag, value: { '#tup': [] } }]),
});
type State = ItfTrace['states'][number];
const trace = (...states: State[]): ItfTrace => ({
  vars: ['m::room::page', 'm::room::status', 'mbt::actionTaken', 'mbt::nondetPicks'],
  states,
});

test('values are written the way the spec writes them', () => {
  assert.equal(show({ '#bigint': '3' }), '3');
  assert.equal(show({ '#set': ['a', 'b'] }), '{a, b}');
  assert.equal(show({ tag: 'Lobby', value: { '#tup': [] } }), 'Lobby');
  assert.equal(show({ tag: 'Running', value: { '#bigint': '1' } }), 'Running(1)');
  assert.equal(show({ open: true, link: { '#bigint': '2' } }), '{open: true, link: 2}');
  assert.equal(show(''), '""');
});

test('the constants of a module instance are read from its import', () => {
  assert.deepEqual(
    [...instanceConstants(SPEC, 'room_fixed')],
    [
      ['FIXED', true],
      ['OTHER', false],
    ],
  );
});

test("a run's steps are its .then() actions; .expect() is not a step", () => {
  const [join] = runScenarios(DECIDABLE, 'room_fixed');
  assert.equal(join?.name, 'joinTest');
  assert.equal(join?.comment, 'The host opens a room and a friend joins.');
  assert.deepEqual(join?.steps, [
    'openRoom("host")',
    'join("guest", true)',
    'startGame',
    'admit("guest")',
    'beginSync',
    'leave("guest")',
  ]);
});

test('an if on a constant takes the branch the module instance takes', () => {
  const before = runScenarios(DECIDABLE, 'room_before');
  assert.deepEqual(before[0]?.steps, ['openRoom("host")', 'join("guest", true)', 'startGame', 'endGame', 'stutter']);
});

test('a branch that cannot be decided is an error, not a guess', () => {
  assert.throws(() => runScenarios(SPEC, 'room_fixed'), /cannot tell which branch/);
});

test('a step is an arrow to the hub, with what it changed for whom', () => {
  const diagram = sequenceDiagram(
    trace(
      { 'm::room::page': page(['guest', 'Closed'], ['host', 'Lobby'], ['idle', 'Closed']), 'm::room::status': 'lobby' },
      { 'm::room::page': page(['guest', 'Lobby'], ['host', 'Lobby'], ['idle', 'Closed']), 'm::room::status': 'lobby' },
      {
        'm::room::page': page(['guest', 'Loading'], ['host', 'Loading'], ['idle', 'Closed']),
        'm::room::status': 'playing',
      },
    ),
    ['join("guest", true)', 'startGame'],
    { hub: 'Server' },
  );
  assert.deepEqual(diagram.trimEnd().split('\n'), [
    'sequenceDiagram',
    '  participant Server',
    '  participant guest',
    '  participant host',
    '  guest->>Server: join("guest", true)',
    '  Note over guest: Lobby',
    '  Server->>Server: startGame',
    '  Note over Server: status = playing',
    '  Server-->>guest: Loading',
    '  Server-->>host: Loading',
  ]);
});

test('for a record kept per player, only the fields that changed are shown', () => {
  const side = (open: boolean, link: number) => ({ '#map': [['lo', { open, link: { '#bigint': String(link) } }]] });
  const diagram = sequenceDiagram(
    { vars: ['side'], states: [{ side: side(false, 2) }, { side: side(true, 2) }] },
    ['channelOpens("lo")'],
    { hub: 'Signaling' },
  );
  assert.match(diagram, /Note over lo: open: true\n/);
});

test('the labels must match the trace, step for step', () => {
  assert.throws(() => sequenceDiagram(trace({}, {}), [], { hub: 'Server' }), /0 step labels for 1 steps/);
});

test('a trace from --mbt is labelled with the action and what it picked', () => {
  const some = (value: string | boolean) => ({ tag: 'Some', value });
  const none = { tag: 'None', value: { '#tup': [] } };
  const states = [
    { 'm::room::page': page(['guest', 'Lobby'], ['host', 'Lobby']), 'm::room::status': 'lobby' },
    {
      'm::room::page': page(['guest', 'Closed'], ['host', 'Lobby']),
      'm::room::status': 'lobby',
      'mbt::actionTaken': 'leave',
      'mbt::nondetPicks': { hasRom: some(false), o: some('host'), p: some('guest'), unused: none },
    },
  ];
  const labels = mbtLabels(trace(...states));
  assert.deepEqual(labels, ['leave(hasRom: false, o: "host", p: "guest")']);
  // Two players are named; the one the step changed is the one who acted.
  assert.match(sequenceDiagram(trace(...states), labels, { hub: 'Server' }), /guest->>Server: leave/);
});

test('characters Mermaid would read as syntax are escaped', () => {
  const diagram = sequenceDiagram({ vars: ['status'], states: [{ status: 'a' }, { status: 'b;#' }] }, ['step 1'], {
    hub: 'Server',
  });
  assert.match(diagram, /status = b#59;#35;/);
});
