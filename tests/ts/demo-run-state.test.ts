import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialTransition, transition, type SnapshotFrom } from 'xstate';
import {
  RUN_FLAGS,
  RUN_REGIONS,
  createRunState,
  demoRunMachine,
  region,
  runFlags,
  runStateName,
  type RunEvent,
  type RunFlags,
} from '../../web/src/demo/run-state.ts';

// The demo page's run-state machine (web/src/demo/run-state.ts). Its
// invariants are checked on every state it can reach and every event it can
// take there: the state space is small enough to walk whole, with and without
// ?autoCompare=0, over every event and every value an event can carry.

type Snapshot = SnapshotFrom<typeof demoRunMachine>;

const EVENTS: readonly RunEvent[] = [
  { type: 'romLoaded', engineAvailable: true },
  { type: 'romLoaded', engineAvailable: false },
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

type Step = { readonly from: Snapshot; readonly event: RunEvent; readonly to: Snapshot; readonly disabled: boolean };

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
      const [to] = transition(demoRunMachine, from, event);
      steps.push({ from, event, to, disabled: autoCompareDisabled });
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

test('the engine starts at most once, only on a ROM with the engine there, and never stops', () => {
  for (const step of steps) {
    if (leaving(step.to)) continue;
    const before = at(step.from, 'engine');
    const after = at(step.to, 'engine');
    if (before === 'running') assert.equal(after, 'running', describe(step));
    if (before === 'idle' && after === 'running') {
      assert.deepEqual(step.event, { type: 'romLoaded', engineAvailable: true }, describe(step));
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

test('the flags tell every state apart, so a comparison can see any difference', () => {
  const byFlags = new Map<string, string>();
  for (const snapshot of states) {
    if (leaving(snapshot)) continue;
    const flags = JSON.stringify(runFlags(snapshot.value));
    const name = runStateName(snapshot.value);
    const other = byFlags.get(flags);
    assert.ok(other === undefined || other === name, `${name} and ${other} have the same flags`);
    byFlags.set(flags, name);
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
    { type: 'romLoaded', engineAvailable: true },
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

test('the observer compares after each event, reports a difference once, and stops at leaving', () => {
  const lines: string[] = [];
  let flags: RunFlags = runFlags(initialTransition(demoRunMachine, { autoCompareDisabled: false })[0].value);
  const observer = createRunState({ autoCompareDisabled: false, read: () => flags, warn: (line) => lines.push(line) });
  observer.send({ type: 'interacted' });
  assert.equal(observer.disagreements().length, 1, 'the page forgot the touch');
  flags = { ...flags, userInteracted: true };
  observer.send({ type: 'interacted' });
  assert.equal(observer.disagreements().length, 1);
  observer.send({ type: 'romLoaded', engineAvailable: true });
  observer.send({ type: 'romLoaded', engineAvailable: true });
  // The same difference after the same event is reported once.
  assert.equal(observer.disagreements().length, 2);
  assert.equal(lines.length, 2);
  assert.match(lines[1] ?? '', /demo-run:romLoaded/);
  // Flags in another order compare the same.
  flags = {
    userInteracted: true,
    rollbackEnabled: true,
    autoComparePaused: false,
    autoCompareRunning: false,
    tickPaused: false,
    fakePeerActive: false,
    inMatch: false,
    bootInFlight: false,
    loaderInjected: false,
    engineRunning: true,
    engineStarted: true,
  };
  assert.deepEqual(Object.keys(flags), [...RUN_FLAGS].reverse());
  observer.send({ type: 'interacted' });
  assert.equal(observer.disagreements().length, 2);
  observer.send({ type: 'reset' });
  assert.equal(observer.state(), 'leaving');
  flags = { ...flags, engineStarted: false };
  observer.send({ type: 'interacted' });
  assert.equal(observer.disagreements().length, 2, 'nothing is compared once the page is leaving');
});

test('the observer never throws into the page', () => {
  const observer = createRunState({
    autoCompareDisabled: false,
    read: () => {
      throw new Error('flag read failed');
    },
    warn: () => undefined,
  });
  assert.doesNotThrow(() => observer.send({ type: 'interacted' }));
  assert.equal(observer.disagreements()[0]?.next, '"Error: flag read failed"');
});
