import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialTransition, transition, type SnapshotFrom } from 'xstate';
import {
  RUN_REGIONS,
  createRunState,
  demoRunMachine,
  issuedCommands,
  region,
  runStateName,
  type RunCommand,
  type RunEvent,
  type RunHandlers,
} from '../../web/src/demo/run-state.ts';

// The demo page's run-state machine (web/src/demo/run-state.ts). Its
// invariants are checked on every state it can reach and every event it can
// take there: the state space is small enough to walk whole, with and without
// ?autoCompare=0, over every event and every value an event can carry.

type Snapshot = SnapshotFrom<typeof demoRunMachine>;

const EVENTS: readonly RunEvent[] = [
  { type: 'engineStarted' },
  { type: 'loaderInjected' },
  { type: 'loaderSettled' },
  // The engine's strict reading implies its inclusive one: both read the same scene status.
  { type: 'frame', strict: false, inclusive: false },
  { type: 'frame', strict: true, inclusive: true },
  { type: 'frame', strict: false, inclusive: true },
  { type: 'interacted' },
  { type: 'rollbackToggleClicked' },
  { type: 'modeSwitched', rollback: true },
  { type: 'modeSwitched', rollback: false },
  { type: 'pauseClicked', tickControl: true },
  { type: 'pauseClicked', tickControl: false },
  { type: 'autoCompareClicked' },
  { type: 'autoStartDue' },
  { type: 'stopClicked', emulator: false },
  { type: 'stopClicked', emulator: true },
  { type: 'reset' },
];

type Step = {
  readonly from: Snapshot;
  readonly event: RunEvent;
  readonly to: Snapshot;
  readonly commands: readonly RunCommand[];
  readonly disabled: boolean;
};

/** Every transition from every reachable state, for one setting of ?autoCompare=0. */
const walk = (autoCompareDisabled: boolean) => {
  const [first] = initialTransition(demoRunMachine, { autoCompareDisabled });
  const seen = new Map([[runStateName(first.value), first]]);
  const queue = [first];
  const steps: Step[] = [];
  while (queue.length > 0) {
    const from = queue.shift();
    if (!from) break;
    for (const event of EVENTS) {
      const [to, effects] = transition(demoRunMachine, from, event);
      steps.push({ from, event, to, commands: issuedCommands(effects), disabled: autoCompareDisabled });
      const name = runStateName(to.value);
      if (!seen.has(name)) {
        seen.set(name, to);
        queue.push(to);
      }
    }
  }
  return { states: [...seen.values()], steps };
};

const both = [walk(false), walk(true)];
const states = both.flatMap((one) => one.states);
const steps = both.flatMap((one) => one.steps);

const at = (snapshot: Snapshot, name: (typeof RUN_REGIONS)[number]): string => region(snapshot.value, name);
const leaving = (snapshot: Snapshot): boolean => runStateName(snapshot.value) === 'leaving';
const inMatch = (snapshot: Snapshot): boolean => at(snapshot, 'match') !== 'menus';
const autoCompareRuns = (snapshot: Snapshot): boolean => at(snapshot, 'autoCompare') === 'running';
const describe = (step: Step): string =>
  `${runStateName(step.from.value)} --${JSON.stringify(step.event)}--> ${runStateName(step.to.value)}`;

test('the walk reaches every state of every region, and leaving', () => {
  const expected: Record<(typeof RUN_REGIONS)[number], string[]> = {
    engine: ['idle', 'running'],
    loader: ['none', 'loading', 'done'],
    match: ['menus', 'playing', 'gamePaused'],
    tick: ['running', 'paused'],
    autoCompare: ['off', 'running', 'paused'],
    mode: ['rollback', 'lockstep'],
    interaction: ['untouched', 'touched'],
  };
  const open = states.filter((snapshot) => !leaving(snapshot));
  for (const name of RUN_REGIONS) {
    assert.deepEqual(new Set(open.map((snapshot) => at(snapshot, name))), new Set(expected[name]), name);
  }
  assert.ok(states.some(leaving));
});

test('the engine starts at most once and never stops', () => {
  for (const step of steps) {
    if (leaving(step.to)) continue;
    const before = at(step.from, 'engine');
    const after = at(step.to, 'engine');
    if (before === 'running') assert.equal(after, 'running', describe(step));
    if (before === 'idle' && after === 'running') {
      assert.equal(step.event.type, 'engineStarted', describe(step));
    }
  }
});

test('the loader goes on the page at most once, and is loading only between going on and settling', () => {
  const order = ['none', 'loading', 'done'];
  for (const step of steps) {
    if (leaving(step.to)) continue;
    const before = order.indexOf(at(step.from, 'loader'));
    const after = order.indexOf(at(step.to, 'loader'));
    assert.ok(after === before || after === before + 1, describe(step));
    if (after === 1 && before === 0) assert.equal(step.event.type, 'loaderInjected', describe(step));
    if (after === 2 && before === 1) assert.equal(step.event.type, 'loaderSettled', describe(step));
  }
});

test('leaving a match turns rollback on and auto-compare off, paused or not', () => {
  let seen = 0;
  for (const step of steps) {
    if (leaving(step.from) || step.event.type !== 'frame' || step.event.inclusive || !inMatch(step.from)) continue;
    seen++;
    assert.equal(at(step.to, 'mode'), 'rollback', describe(step));
    assert.equal(at(step.to, 'autoCompare'), 'off', describe(step));
  }
  assert.ok(seen > 0);
});

test('entering a match forgets that the controls were touched', () => {
  for (const step of steps) {
    if (leaving(step.from) || step.event.type !== 'frame' || !step.event.inclusive || inMatch(step.from)) continue;
    assert.equal(at(step.to, 'interaction'), 'untouched', describe(step));
  }
});

test('auto-compare is paused only while the tick is', () => {
  for (const snapshot of states) {
    if (at(snapshot, 'autoCompare') === 'paused')
      assert.equal(at(snapshot, 'tick'), 'paused', runStateName(snapshot.value));
  }
});

test('auto-compare starts in rollback, and starts on its own only in an untouched match without ?autoCompare=0', () => {
  for (const step of steps) {
    if (leaving(step.to) || autoCompareRuns(step.from) || !autoCompareRuns(step.to)) continue;
    // Resuming the tick resumes a paused auto-compare where it was, in whatever mode.
    if (step.event.type === 'pauseClicked' && at(step.from, 'autoCompare') === 'paused') continue;
    assert.equal(at(step.to, 'mode'), 'rollback', describe(step));
    if (step.event.type === 'autoStartDue') {
      assert.ok(inMatch(step.from), describe(step));
      assert.equal(at(step.from, 'interaction'), 'untouched', describe(step));
      assert.equal(step.disabled, false, describe(step));
    } else {
      assert.equal(step.event.type, 'autoCompareClicked', describe(step));
    }
  }
});

test('Stop leaves once the loader or EmulatorJS is on the page; Reset always leaves; nothing changes after', () => {
  for (const step of steps) {
    if (leaving(step.from)) {
      assert.ok(leaving(step.to), describe(step));
      continue;
    }
    if (step.event.type === 'stopClicked') {
      assert.equal(leaving(step.to), step.event.emulator || at(step.from, 'loader') !== 'none', describe(step));
    } else if (step.event.type === 'reset') {
      assert.ok(leaving(step.to), describe(step));
    } else {
      assert.ok(!leaving(step.to), describe(step));
    }
  }
});

// The two orderings that used to strand a paused auto-compare: it outlived
// the match and ran in the menus once the tick resumed, and a click on its
// button ("Stop auto-compare") restarted it with the pause mark left set.
test('a paused auto-compare stops on leaving the match, the rollback button and its own button', () => {
  const run = (events: readonly RunEvent[]): Snapshot =>
    events.reduce(
      (snapshot, event) => transition(demoRunMachine, snapshot, event)[0],
      initialTransition(demoRunMachine, { autoCompareDisabled: false })[0],
    );
  const pausedInMatch: RunEvent[] = [
    { type: 'engineStarted' },
    { type: 'frame', strict: true, inclusive: true },
    { type: 'autoStartDue' },
    { type: 'pauseClicked', tickControl: true },
  ];
  assert.equal(at(run(pausedInMatch), 'autoCompare'), 'paused');
  const resume: RunEvent = { type: 'pauseClicked', tickControl: true };
  for (const stop of [
    { type: 'frame', strict: false, inclusive: false },
    { type: 'rollbackToggleClicked' },
    { type: 'autoCompareClicked' },
  ] satisfies RunEvent[]) {
    const stopped = run([...pausedInMatch, stop]);
    assert.equal(at(stopped, 'autoCompare'), 'off', stop.type);
    const resumed = run([...pausedInMatch, stop, resume]);
    assert.equal(at(resumed, 'tick'), 'running', stop.type);
    assert.equal(at(resumed, 'autoCompare'), 'off', `${stop.type}, then the tick resumes`);
  }
  // Nor does the timer set on entering a match start it over its pause mark.
  assert.equal(at(run([...pausedInMatch, { type: 'autoStartDue' }]), 'autoCompare'), 'paused');
});

/**
 * The commands a step should issue, from what changed: what the page has to
 * do about it, and nothing else.
 */
const expectedCommands = (step: Step): RunCommand[] => {
  const { from, event, to } = step;
  if (leaving(from)) return [];
  if (leaving(to)) return event.type === 'stopClicked' ? [{ type: 'stop' }] : [];
  const was = (name: (typeof RUN_REGIONS)[number]): string => at(from, name);
  const now = (name: (typeof RUN_REGIONS)[number]): string => at(to, name);
  switch (event.type) {
    case 'frame': {
      const commands: RunCommand[] = [];
      if ((was('match') === 'playing') !== (now('match') === 'playing')) {
        commands.push({ type: 'fakePeerActive', active: now('match') === 'playing' });
      }
      if (was('match') === 'menus' && now('match') !== 'menus') commands.push({ type: 'matchEntered' });
      if (was('match') !== 'menus' && now('match') === 'menus') {
        commands.push({
          type: 'matchLeft',
          stopAutoCompare: was('autoCompare') !== 'off',
          rollbackChanged: was('mode') === 'lockstep',
        });
      }
      return commands;
    }
    case 'autoCompareClicked':
    case 'autoStartDue':
      if (was('autoCompare') === 'off' && now('autoCompare') === 'running') {
        return [{ type: 'startAutoCompare', rollbackChanged: was('mode') === 'lockstep' }];
      }
      return was('autoCompare') !== 'off' && now('autoCompare') === 'off' ? [{ type: 'stopAutoCompare' }] : [];
    case 'rollbackToggleClicked':
      return [
        ...(was('autoCompare') !== 'off' ? [{ type: 'stopAutoCompare' } as const] : []),
        { type: 'switchMode', rollback: was('mode') !== 'rollback' },
      ];
    case 'modeSwitched':
      return [{ type: 'applyMode', changed: was('mode') !== now('mode') }];
    case 'pauseClicked':
      if (was('tick') === now('tick')) return [];
      return now('tick') === 'paused'
        ? [{ type: 'pauseTick', pauseAutoCompare: was('autoCompare') === 'running' }]
        : [{ type: 'resumeTick', resumeAutoCompare: was('autoCompare') === 'paused' }];
    default:
      return [];
  }
};

test('every step issues exactly the commands its changes call for, in the order the page does them', () => {
  for (const step of steps) assert.deepEqual(step.commands, expectedCommands(step), describe(step));
});

test("the commands' parts match the state they leave: auto-compare pauses and resumes with the tick, and starts in rollback", () => {
  for (const step of steps) {
    if (leaving(step.to)) continue;
    for (const command of step.commands) {
      if (command.type === 'pauseTick') {
        assert.equal(command.pauseAutoCompare, at(step.to, 'autoCompare') === 'paused', describe(step));
      } else if (command.type === 'resumeTick') {
        assert.equal(command.resumeAutoCompare, at(step.from, 'autoCompare') === 'paused', describe(step));
        if (command.resumeAutoCompare) assert.equal(at(step.to, 'autoCompare'), 'running', describe(step));
      } else if (command.type === 'startAutoCompare' || command.type === 'matchLeft') {
        assert.equal(at(step.to, 'mode'), 'rollback', describe(step));
      }
    }
  }
});

/** Handlers that note each command, as the page's would run it. */
const noting = (calls: string[], also: Partial<RunHandlers> = {}): RunHandlers => ({
  fakePeerActive: (active) => calls.push(`fakePeerActive ${active}`),
  matchEntered: () => calls.push('matchEntered'),
  matchLeft: (stop, changed) => calls.push(`matchLeft ${stop} ${changed}`),
  startAutoCompare: (changed) => calls.push(`startAutoCompare ${changed}`),
  stopAutoCompare: () => calls.push('stopAutoCompare'),
  switchMode: (rollback) => calls.push(`switchMode ${rollback}`),
  applyMode: (changed) => calls.push(`applyMode ${changed}`),
  pauseTick: (pause) => calls.push(`pauseTick ${pause}`),
  resumeTick: (resume) => calls.push(`resumeTick ${resume}`),
  stop: () => calls.push('stop'),
  ...also,
});

test('the runner hands each command to its handler, in order, and takes an event a handler sends at once', () => {
  const calls: string[] = [];
  const run: ReturnType<typeof createRunState> = createRunState({
    autoCompareDisabled: false,
    handlers: noting(calls, {
      // As the page does: a switch sets the mode, which comes back as `applyMode`.
      switchMode: (rollback) => {
        calls.push(`switchMode ${rollback}`);
        run.send({ type: 'modeSwitched', rollback });
      },
    }),
  });
  run.send({ type: 'engineStarted' });
  run.send({ type: 'frame', strict: true, inclusive: true });
  run.send({ type: 'autoStartDue' });
  run.send({ type: 'rollbackToggleClicked' });
  assert.deepEqual(calls, [
    'fakePeerActive true',
    'matchEntered',
    'startAutoCompare false',
    'stopAutoCompare',
    'switchMode false',
    'applyMode true',
  ]);
  assert.equal(run.flags().rollbackEnabled, false);
  assert.equal(run.flags().autoCompareOn, false);
  assert.equal(run.flags().userInteracted, true);
  calls.length = 0;
  run.send({ type: 'frame', strict: false, inclusive: false });
  assert.deepEqual(calls, ['fakePeerActive false', 'matchLeft false true']);
  assert.equal(run.flags().rollbackEnabled, true);
});

test('Stop runs its handler once the loader is on the page, and after it the runner takes nothing', () => {
  const calls: string[] = [];
  const run = createRunState({ autoCompareDisabled: false, handlers: noting(calls) });
  run.send({ type: 'stopClicked', emulator: false });
  assert.deepEqual(calls, []);
  assert.equal(run.flags().userInteracted, true);
  run.send({ type: 'loaderInjected' });
  run.send({ type: 'stopClicked', emulator: false });
  assert.deepEqual(calls, ['stop']);
  assert.equal(run.state(), 'leaving');
  run.send({ type: 'frame', strict: true, inclusive: true });
  run.send({ type: 'autoCompareClicked' });
  assert.deepEqual(calls, ['stop']);
});
