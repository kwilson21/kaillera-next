/**
 * What the demo page is doing, as a state machine: whether its engine has
 * started, whether the emulator's loader is on the page, whether the game is
 * in a match, whether the Pause button has the engine's tick stopped, what
 * auto-compare is doing, which mode is on, and whether the player has touched
 * the controls this match. Stop and Reset end it: the page reloads.
 *
 * web/static/demo.js keeps no flags of its own for these. It sends the
 * machine what happened and reads its state from here (`createRunState`).
 * What the page should do about a change, the machine issues as a
 * `RunCommand`, which the runner hands to the page's handler for it, in
 * order: the page does the work (timers, the DOM, the engine's calls), the
 * machine decides when.
 *
 * The regions of `open`, and the flags of demo.js each one replaced:
 *
 *   engine        idle | running            _engineStarted, _engineRunning
 *   loader        none | loading | done     _loaderInjected, _emulatorBootInFlight
 *   match         menus | playing |         _wasInMatch (not menus),
 *                 gamePaused                _lastFakePeerMatchActive (playing)
 *   tick          running | paused          _emuPaused
 *   autoCompare   off | running | paused    _autoCompareTimer, _autoComparePausedAt
 *                                           (still kept, as the interval and the
 *                                           time it was paused, never as state)
 *   mode          rollback | lockstep       _rollbackEnabled
 *   interaction   untouched | touched       _userInteractedThisMatch
 *
 * The engine starts when a ROM is loaded, before the emulator: the loader is
 * put on the page by the "Tap to start" button, after. `gamePaused` is the
 * game's own pause menu (`isInMatchOrPaused` but not `isInMatch`), not the
 * page's Pause button, which is `tick`. Auto-compare paused by the Pause
 * button is still on: its button reads "Stop auto-compare", and a click
 * stops it, as leaving the match and the rollback button do.
 *
 * The invariants it keeps (tests/ts/demo-run-state.test.ts walks every
 * reachable state):
 *  - the engine starts at most once and never stops;
 *  - the loader goes on the page at most once, and is loading only between
 *    going on and settling;
 *  - leaving a match turns rollback on and auto-compare off;
 *  - entering a match forgets that the controls were touched;
 *  - auto-compare is paused only while the tick is;
 *  - after Stop or Reset nothing changes;
 *  - the commands say exactly what changed: auto-compare starting,
 *    stopping, pausing and resuming, the mode changing, the match edges.
 * Pause and Stop being clickable only in a match is not among them: the
 * page disables the buttons, from the engine's own reading of the match.
 */
import { Effect, Option, Result, Schema } from 'effect';
import { setupEffect } from '@xstate/effect';
import { initialTransition, transition, type EventFrom, type SnapshotFrom, type StateValue } from 'xstate';

const Empty = Schema.Struct({});

/** What the machine asks of the page. */
export const RunCommand = Schema.Union([
  /** The game left or entered actual play (`isInMatch`): the fake peer sends random input only then. */
  Schema.Struct({ type: Schema.Literal('fakePeerActive'), active: Schema.Boolean }),
  /** The game entered a match (its pause menu included). */
  Schema.Struct({ type: Schema.Literal('matchEntered') }),
  /** The game left the match. `stopAutoCompare`: it was on; `rollbackChanged`: the mode was lockstep. */
  Schema.Struct({
    type: Schema.Literal('matchLeft'),
    stopAutoCompare: Schema.Boolean,
    rollbackChanged: Schema.Boolean,
  }),
  /** Start auto-compare's cycle, in rollback; `rollbackChanged`: the mode was lockstep. */
  Schema.Struct({ type: Schema.Literal('startAutoCompare'), rollbackChanged: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal('stopAutoCompare') }),
  /** Switch to this mode (now, or once a replay ends); the switch comes back as `modeSwitched`. */
  Schema.Struct({ type: Schema.Literal('switchMode'), rollback: Schema.Boolean }),
  /** Hand the mode to the engine and the button; `changed`: it is not the mode it was. */
  Schema.Struct({ type: Schema.Literal('applyMode'), changed: Schema.Boolean }),
  /** Stop the engine's tick; `pauseAutoCompare`: auto-compare is running and pauses with it. */
  Schema.Struct({ type: Schema.Literal('pauseTick'), pauseAutoCompare: Schema.Boolean }),
  /** Restart the engine's tick; `resumeAutoCompare`: auto-compare was paused with it. */
  Schema.Struct({ type: Schema.Literal('resumeTick'), resumeAutoCompare: Schema.Boolean }),
  /** Stop the emulator, forget the ROM and reload. */
  Schema.Struct({ type: Schema.Literal('stop') }),
]);
export type RunCommand = typeof RunCommand.Type;

export const demoRunMachine = setupEffect({
  schemas: {
    context: Schema.Struct({ autoCompareDisabled: Schema.Boolean }),
    input: Schema.Struct({
      /** `?autoCompare=0`: entering a match does not start auto-compare. */
      autoCompareDisabled: Schema.Boolean,
    }),
    events: {
      /** The engine was initialised. */
      engineStarted: Empty,
      /** The emulator's loader script was put on the page. */
      loaderInjected: Empty,
      /** The loader finished, failed, or ran out of time. */
      loaderSettled: Empty,
      /** One HUD frame: the engine's strict (`isInMatch`) and inclusive (`isInMatchOrPaused`) readings. */
      frame: Schema.Struct({ strict: Schema.Boolean, inclusive: Schema.Boolean }),
      /** The latency slider moved, or the controls panel was opened. */
      interacted: Empty,
      /** The rollback button was clicked. */
      rollbackToggleClicked: Empty,
      /** The page set the mode: a switch (now, or once a replay ends), `KNDemo.setRollbackEnabled`, the engine's start. */
      modeSwitched: Schema.Struct({ rollback: Schema.Boolean }),
      /** The Pause button was clicked; `tickControl` is whether the engine can stop its tick. */
      pauseClicked: Schema.Struct({ tickControl: Schema.Boolean }),
      autoCompareClicked: Empty,
      /** 600 ms after entering a match: start auto-compare if nothing says not to. */
      autoStartDue: Empty,
      /** The Stop button was clicked; `emulator` is whether EmulatorJS is on the page. */
      stopClicked: Schema.Struct({ emulator: Schema.Boolean }),
      /** The page is reloading itself: the Reset button, or the autopilot's one retry. */
      reset: Empty,
    },
    actions: {
      issue: { params: Schema.Struct({ command: RunCommand }) },
    },
  },
  actions: {
    // The runner takes the commands from the transition and hands them to the page itself.
    issue: () => Effect.void,
  },
}).createMachine({
  id: 'demo',
  context: ({ input }) => ({ autoCompareDisabled: input.autoCompareDisabled }),
  initial: 'open',
  states: {
    open: {
      type: 'parallel',
      on: {
        reset: { target: 'leaving' },
      },
      states: {
        engine: {
          initial: 'idle',
          states: {
            idle: { on: { engineStarted: { target: 'running' } } },
            running: {},
          },
        },
        loader: {
          initial: 'none',
          states: {
            none: { on: { loaderInjected: { target: 'loading' } } },
            loading: { on: { loaderSettled: { target: 'done' } } },
            done: {},
          },
        },
        match: {
          initial: 'menus',
          on: {
            frame: ({ event, value, actions, self }, enq) => {
              const issue = (command: RunCommand): void => enq(actions.issue, { command, self });
              const before = region(value, 'match');
              const after = matchFrom(event);
              if ((before === 'playing') !== (after === 'playing')) {
                issue({ type: 'fakePeerActive', active: after === 'playing' });
              }
              if (before === 'menus' && after !== 'menus') issue({ type: 'matchEntered' });
              if (before !== 'menus' && after === 'menus') {
                issue({
                  type: 'matchLeft',
                  stopAutoCompare: region(value, 'autoCompare') !== 'off',
                  rollbackChanged: region(value, 'mode') === 'lockstep',
                });
              }
              return { target: MATCH_TARGET[after] };
            },
          },
          states: { menus: {}, playing: {}, gamePaused: {} },
        },
        tick: {
          initial: 'running',
          states: {
            running: {
              on: {
                pauseClicked: ({ event, value, actions, self }, enq) => {
                  if (!event.tickControl) return;
                  const pauseAutoCompare = region(value, 'autoCompare') === 'running';
                  enq(actions.issue, { command: { type: 'pauseTick', pauseAutoCompare }, self });
                  return { target: 'paused' };
                },
              },
            },
            paused: {
              on: {
                pauseClicked: ({ event, value, actions, self }, enq) => {
                  if (!event.tickControl) return;
                  const resumeAutoCompare = region(value, 'autoCompare') === 'paused';
                  enq(actions.issue, { command: { type: 'resumeTick', resumeAutoCompare }, self });
                  return { target: 'running' };
                },
              },
            },
          },
        },
        autoCompare: {
          initial: 'off',
          states: {
            off: {
              on: {
                autoCompareClicked: ({ value, actions, self }, enq) => {
                  enq(actions.issue, { command: startAutoCompare(value), self });
                  return { target: 'running' };
                },
                autoStartDue: ({ context, value, actions, self }, enq) => {
                  if (!autoStarts(context, value)) return;
                  enq(actions.issue, { command: startAutoCompare(value), self });
                  return { target: 'running' };
                },
              },
            },
            running: {
              on: {
                autoCompareClicked: ({ actions, self }, enq) => {
                  enq(actions.issue, { command: { type: 'stopAutoCompare' }, self });
                  return { target: 'off' };
                },
                // The rollback button's commands, the stop among them, are the mode's.
                rollbackToggleClicked: { target: 'off' },
                // Leaving the match stops it as part of `matchLeft`.
                frame: ({ event, value }) => (leavesMatch(value, event.inclusive) ? { target: 'off' } : undefined),
                // The tick's `pauseTick` pauses it.
                pauseClicked: ({ event, value }) =>
                  event.tickControl && region(value, 'tick') === 'running' ? { target: 'paused' } : undefined,
              },
            },
            // Its timer is cleared and the time it was paused kept; it is still on.
            paused: {
              on: {
                autoCompareClicked: ({ actions, self }, enq) => {
                  enq(actions.issue, { command: { type: 'stopAutoCompare' }, self });
                  return { target: 'off' };
                },
                rollbackToggleClicked: { target: 'off' },
                frame: ({ event, value }) => (leavesMatch(value, event.inclusive) ? { target: 'off' } : undefined),
                // The tick's `resumeTick` resumes it.
                pauseClicked: ({ event, value }) =>
                  event.tickControl && region(value, 'tick') === 'paused' ? { target: 'running' } : undefined,
              },
            },
          },
        },
        mode: {
          initial: 'rollback',
          on: {
            modeSwitched: ({ event, value, actions, self }, enq) => {
              const changed = (region(value, 'mode') === 'rollback') !== event.rollback;
              enq(actions.issue, { command: { type: 'applyMode', changed }, self });
              return { target: event.rollback ? '.rollback' : '.lockstep' };
            },
            // The button stops auto-compare, then switches to the other mode.
            rollbackToggleClicked: ({ value, actions, self }, enq) => {
              if (region(value, 'autoCompare') !== 'off') {
                enq(actions.issue, { command: { type: 'stopAutoCompare' }, self });
              }
              const rollback = region(value, 'mode') !== 'rollback';
              enq(actions.issue, { command: { type: 'switchMode', rollback }, self });
            },
            // Auto-compare starts in rollback; `startAutoCompare` says whether that is a change.
            autoCompareClicked: ({ value }) => (startsOnClick(value) ? { target: '.rollback' } : undefined),
            autoStartDue: ({ context, value }) => (autoStarts(context, value) ? { target: '.rollback' } : undefined),
            // `matchLeft` says whether that is a change.
            frame: ({ event, value }) => (leavesMatch(value, event.inclusive) ? { target: '.rollback' } : undefined),
          },
          states: { rollback: {}, lockstep: {} },
        },
        interaction: {
          initial: 'untouched',
          on: {
            interacted: { target: '.touched' },
            rollbackToggleClicked: { target: '.touched' },
            pauseClicked: { target: '.touched' },
            autoCompareClicked: { target: '.touched' },
            // Stop leaves once the emulator's loader is on the page; before that it only counts as a touch.
            stopClicked: ({ event, value, actions, self }, enq) => {
              if (!event.emulator && region(value, 'loader') === 'none') return { target: '.touched' };
              enq(actions.issue, { command: { type: 'stop' }, self });
              return { target: '#demo.leaving' };
            },
            frame: ({ event, value }) => (entersMatch(value, event.inclusive) ? { target: '.untouched' } : undefined),
          },
          states: { untouched: {}, touched: {} },
        },
      },
    },
    leaving: { type: 'final' },
  },
});

export type RunEvent = EventFrom<typeof demoRunMachine>;
type RunSnapshot = SnapshotFrom<typeof demoRunMachine>;

/** The regions of `open`. */
export const RUN_REGIONS = ['engine', 'loader', 'match', 'tick', 'autoCompare', 'mode', 'interaction'] as const;
export type RunRegion = (typeof RUN_REGIONS)[number];

const OpenValue = Schema.Struct({ open: Schema.Record(Schema.String, Schema.String) });
const decodeOpen = Schema.decodeUnknownResult(OpenValue);

/** The state of one region of `open`, or `leaving` once the page is reloading. */
export const region = (value: StateValue, name: RunRegion): string => {
  const decoded = decodeOpen(value);
  return Result.isSuccess(decoded) ? (decoded.success.open[name] ?? '') : 'leaving';
};

type MatchState = 'menus' | 'playing' | 'gamePaused';
const MATCH_TARGET = { menus: '.menus', playing: '.playing', gamePaused: '.gamePaused' } as const;

/** Where a frame's readings put the match. The strict reading implies the inclusive one: both read the same scene status. */
const matchFrom = (frame: { readonly strict: boolean; readonly inclusive: boolean }): MatchState => {
  if (!frame.inclusive) return 'menus';
  return frame.strict ? 'playing' : 'gamePaused';
};

const inMatch = (value: StateValue): boolean => region(value, 'match') !== 'menus';
const leavesMatch = (value: StateValue, inclusive: boolean): boolean => inMatch(value) && !inclusive;
const entersMatch = (value: StateValue, inclusive: boolean): boolean => !inMatch(value) && inclusive;

/** Whether a click on the auto-compare button starts it (it is off, not running or paused) rather than stops it. */
const startsOnClick = (value: StateValue): boolean => region(value, 'autoCompare') === 'off';

/** Whether auto-compare starts on its own, 600 ms into a match. */
const autoStarts = (context: { readonly autoCompareDisabled: boolean }, value: StateValue): boolean =>
  inMatch(value) &&
  region(value, 'interaction') === 'untouched' &&
  !context.autoCompareDisabled &&
  startsOnClick(value);

const startAutoCompare = (value: StateValue): RunCommand => ({
  type: 'startAutoCompare',
  rollbackChanged: region(value, 'mode') === 'lockstep',
});

/** What the page reads of the run state. */
export interface RunFlags {
  readonly engineStarted: boolean;
  readonly loaderInjected: boolean;
  readonly bootInFlight: boolean;
  /** In a match, the game's pause menu included. */
  readonly inMatch: boolean;
  /** In a match and playing: the fake peer sends random input. */
  readonly fakePeerActive: boolean;
  /** The Pause button has the engine's tick stopped. */
  readonly tickPaused: boolean;
  /** Auto-compare is on, running or paused. */
  readonly autoCompareOn: boolean;
  readonly rollbackEnabled: boolean;
  /** The player touched the controls this match. */
  readonly userInteracted: boolean;
}

/** The run state of a state of `open`, as the page reads it. */
export const runFlags = (value: StateValue): RunFlags => {
  const loader = region(value, 'loader');
  const match = region(value, 'match');
  return {
    engineStarted: region(value, 'engine') === 'running',
    loaderInjected: loader !== 'none',
    bootInFlight: loader === 'loading',
    inMatch: match !== 'menus',
    fakePeerActive: match === 'playing',
    tickPaused: region(value, 'tick') === 'paused',
    autoCompareOn: region(value, 'autoCompare') !== 'off',
    rollbackEnabled: region(value, 'mode') === 'rollback',
    userInteracted: region(value, 'interaction') === 'touched',
  };
};

/** A state as one line: `leaving`, or each region's state in `RUN_REGIONS` order. */
export const runStateName = (value: StateValue): string => {
  if (region(value, 'engine') === 'leaving') return 'leaving';
  return RUN_REGIONS.map((name) => `${name}:${region(value, name)}`).join(' ');
};

/** What a transition asks of the page: its `issue` actions' commands. */
const decodeIssue = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal('issue'), args: Schema.Tuple([Schema.Struct({ command: RunCommand })]) }),
);

/** The commands a transition issued, in order. */
export const issuedCommands = (effects: readonly unknown[]): RunCommand[] =>
  effects.flatMap((raw) =>
    Option.match(decodeIssue(raw), { onNone: () => [], onSome: (issue) => [issue.args[0].command] }),
  );

/** The page's handler for each command. */
export interface RunHandlers {
  readonly fakePeerActive: (active: boolean) => void;
  readonly matchEntered: () => void;
  readonly matchLeft: (stopAutoCompare: boolean, rollbackChanged: boolean) => void;
  readonly startAutoCompare: (rollbackChanged: boolean) => void;
  readonly stopAutoCompare: () => void;
  readonly switchMode: (rollback: boolean) => void;
  readonly applyMode: (changed: boolean) => void;
  readonly pauseTick: (pauseAutoCompare: boolean) => void;
  readonly resumeTick: (resumeAutoCompare: boolean) => void;
  readonly stop: () => void;
}

const handle = (handlers: RunHandlers, command: RunCommand): void => {
  switch (command.type) {
    case 'fakePeerActive':
      handlers.fakePeerActive(command.active);
      break;
    case 'matchEntered':
      handlers.matchEntered();
      break;
    case 'matchLeft':
      handlers.matchLeft(command.stopAutoCompare, command.rollbackChanged);
      break;
    case 'startAutoCompare':
      handlers.startAutoCompare(command.rollbackChanged);
      break;
    case 'stopAutoCompare':
      handlers.stopAutoCompare();
      break;
    case 'switchMode':
      handlers.switchMode(command.rollback);
      break;
    case 'applyMode':
      handlers.applyMode(command.changed);
      break;
    case 'pauseTick':
      handlers.pauseTick(command.pauseAutoCompare);
      break;
    case 'resumeTick':
      handlers.resumeTick(command.resumeAutoCompare);
      break;
    case 'stop':
      handlers.stop();
      break;
  }
};

export interface RunStateOptions {
  readonly autoCompareDisabled: boolean;
  readonly handlers: RunHandlers;
}

/**
 * The page's run state. `send` takes what happened, moves the machine, then
 * runs the page's handler for each command the move issued, in order. A
 * handler may send again; that event is taken at once. Once Stop or Reset
 * has left, every event is ignored.
 */
export const createRunState = (options: RunStateOptions) => {
  let snapshot: RunSnapshot = initialTransition(demoRunMachine, {
    autoCompareDisabled: options.autoCompareDisabled,
  })[0];

  const send = (event: RunEvent): void => {
    if (snapshot.status === 'done') return;
    const [next, effects] = transition(demoRunMachine, snapshot, event);
    snapshot = next;
    for (const command of issuedCommands(effects)) handle(options.handlers, command);
  };

  return {
    send,
    /** The run state as the page reads it. */
    flags: (): RunFlags => runFlags(snapshot.value),
    /** The machine's state as one line. */
    state: (): string => runStateName(snapshot.value),
  };
};
