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

test('a record with a field called tag is a record, not a variant', () => {
  assert.equal(show({ tag: 'ready', count: { '#bigint': '2' } }), '{tag: ready, count: 2}');
  const job = (count: string) => ({ job: { tag: 'ready', count: { '#bigint': count } } });
  const diagram = sequenceDiagram({ vars: ['job'], states: [job('1'), job('2')] }, ['step 1'], { hub: 'Server' });
  assert.match(diagram, /Note over Server: job = \{tag: ready, count: 2\}/);
});

test('a set or map listed in another order is the same value', () => {
  assert.equal(show({ '#set': ['b', 'a'] }), show({ '#set': ['a', 'b'] }));
  const one = { '#bigint': '1' };
  const two = { '#bigint': '2' };
  const diagram = sequenceDiagram(
    {
      vars: ['online', 'names'],
      states: [
        {
          online: { '#set': ['a', 'b'] },
          names: {
            '#map': [
              [one, 'x'],
              [two, 'y'],
            ],
          },
        },
        {
          online: { '#set': ['b', 'a'] },
          names: {
            '#map': [
              [two, 'y'],
              [one, 'x'],
            ],
          },
        },
      ],
    },
    ['step 1'],
    { hub: 'Server' },
  );
  assert.doesNotMatch(diagram, /Note over/);
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

test('a .then() may spread its argument over several lines', () => {
  const spec = `
module room {
  run spreadTest =
    init
      .then(openRoom("host"))
      .then(
        if (FIXED)
          admit("guest")
            .then(beginSync)
        else
          endGame
            .then(leave("guest"))
      )
      .expect(status == "lobby")

  val unrelated = true
}
module room_fixed { import room(FIXED = true).* }
module room_before { import room(FIXED = false).* }
`;
  assert.deepEqual(runScenarios(spec, 'room_fixed')[0]?.steps, ['openRoom("host")', 'admit("guest")', 'beginSync']);
  assert.deepEqual(runScenarios(spec, 'room_before')[0]?.steps, ['openRoom("host")', 'endGame', 'leave("guest")']);
});

test('a run may begin on the line that declares it', () => {
  const spec = `
module room {
  run smokeTest = init.then(openRoom("host"))
  run longerTest = init
      .then(openRoom("host"))
      .then(startGame)
}
`;
  assert.deepEqual(
    runScenarios(spec, 'room').map((scenario) => [scenario.name, scenario.steps]),
    [
      ['smokeTest', ['openRoom("host")']],
      ['longerTest', ['openRoom("host")', 'startGame']],
    ],
  );
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

test('a player who appears after the first state still gets a lifeline', () => {
  const diagram = sequenceDiagram(
    trace(
      { 'm::room::page': page(['host', 'Lobby']), 'm::room::status': 'lobby' },
      { 'm::room::page': page(['guest', 'Lobby'], ['host', 'Lobby']), 'm::room::status': 'lobby' },
      { 'm::room::page': page(['host', 'Lobby']), 'm::room::status': 'lobby' },
    ),
    ['join("guest")', 'leave("guest")'],
    { hub: 'Server' },
  );
  assert.deepEqual(diagram.trimEnd().split('\n'), [
    'sequenceDiagram',
    '  participant Server',
    '  participant guest',
    '  guest->>Server: join("guest")',
    '  Note over guest: Lobby',
    '  guest->>Server: leave("guest")',
    '  Note over guest: removed',
  ]);
});

test('a map that starts empty is still kept per player', () => {
  const diagram = sequenceDiagram(
    trace(
      { 'm::room::page': { '#map': [] }, 'm::room::status': 'lobby' },
      { 'm::room::page': page(['host', 'Lobby']), 'm::room::status': 'lobby' },
    ),
    ['openRoom("host")'],
    { hub: 'Server' },
  );
  assert.match(diagram, /host->>Server: openRoom\("host"\)\n {2}Note over host: Lobby\n/);
  assert.doesNotMatch(diagram, /Note over Server/);
});

test('a name that is not a plain word gets an id of its own and is shown as the label', () => {
  const diagram = sequenceDiagram(
    trace(
      { 'm::room::page': page(['a->>b', 'Closed'], ['lifeline1', 'Closed']), 'm::room::status': 'lobby' },
      { 'm::room::page': page(['a->>b', 'Lobby'], ['lifeline1', 'Lobby']), 'm::room::status': 'lobby' },
    ),
    ['join("a->>b")'],
    { hub: 'The server' },
  );
  assert.deepEqual(diagram.trimEnd().split('\n'), [
    'sequenceDiagram',
    '  participant lifeline2 as The server',
    '  participant lifeline3 as a->>b',
    '  participant lifeline1',
    '  lifeline3->>lifeline2: join("a->>b")',
    '  Note over lifeline3: Lobby',
    '  lifeline2-->>lifeline1: Lobby',
  ]);
});

test('a line break in a value does not end the note', () => {
  const diagram = sequenceDiagram(
    { vars: ['status'], states: [{ status: 'a' }, { status: 'two\nlines' }] },
    ['step 1'],
    { hub: 'Server' },
  );
  assert.match(diagram, /Note over Server: status = two lines\n$/);
});

test("an action that is the hub's own stays on the hub though it names a player", () => {
  const states = [
    { 'm::room::page': page(['guest', 'Syncing']), 'm::room::status': 'playing' },
    { 'm::room::page': page(['guest', 'Running']), 'm::room::status': 'playing' },
  ];
  const mine = sequenceDiagram(trace(...states), ['serveLateJoin("guest")'], { hub: 'Server' });
  assert.match(mine, /guest->>Server: serveLateJoin\("guest"\)\n {2}Note over guest: Running/);
  const hubs = sequenceDiagram(trace(...states), ['serveLateJoin("guest")'], {
    hub: 'Server',
    hubActions: ['serveLateJoin'],
  });
  assert.match(hubs, /Server->>Server: serveLateJoin\("guest"\)\n {2}Server-->>guest: Running/);
});

test('a player called the same as the hub is a lifeline of its own', () => {
  const diagram = sequenceDiagram(
    trace(
      { 'm::room::page': page(['Server', 'Closed']), 'm::room::status': 'lobby' },
      { 'm::room::page': page(['Server', 'Lobby']), 'm::room::status': 'playing' },
    ),
    ['join("Server")'],
    { hub: 'Server' },
  );
  assert.deepEqual(diagram.trimEnd().split('\n'), [
    'sequenceDiagram',
    '  participant Server',
    '  participant lifeline1 as Server',
    '  lifeline1->>Server: join("Server")',
    '  Note over Server: status = playing',
    '  Note over lifeline1: Lobby',
  ]);
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
