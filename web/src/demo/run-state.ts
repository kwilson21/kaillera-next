/**
 * What the demo page is doing, as a state machine: whether its engine has
 * started, whether the emulator's loader is on the page, whether the game is
 * in a match, whether the Pause button has the engine's tick stopped, what
 * auto-compare is doing, which mode is on, and whether the player has touched
 * the controls this match. Stop and Reset end it: the page reloads.
 *
 * It decides nothing yet. web/static/demo.js keeps its own flags and sends
 * the machine what happened at the end of each handler; after each event the
 * flags are compared with what the machine says they should be
 * (`createRunState`). The demo page has no upload token, so a disagreement
 * cannot reach the server: it is logged and kept on the page, where the
 * old-against-new test (tests/ts/demo-page.test.ts) fails on any. Once that
 * test's visits have shown none for long enough, demo.js reads its run state
 * from here and the flags go, as session.ts did for play.js.
 *
 * The regions of `open`, and the flags of demo.js each one stands for:
 *
 *   engine        idle | running            _engineStarted, _engineRunning
 *   loader        none | loading | done     _loaderInjected, _emulatorBootInFlight
 *   match         menus | playing |         _wasInMatch (not menus),
 *                 gamePaused                _lastFakePeerMatchActive (playing)
 *   tick          running | paused          _emuPaused
 *   autoCompare   off | running | paused |  _autoCompareTimer, _autoComparePausedAt
 *                 runningUnpausable
 *   mode          rollback | lockstep       _rollbackEnabled
 *   interaction   untouched | touched       _userInteractedThisMatch
 *
 * The engine starts when a ROM is loaded, before the emulator: the loader is
 * put on the page by the "Tap to start" button, after. `gamePaused` is the
 * game's own pause menu (`isInMatchOrPaused` but not `isInMatch`), not the
 * page's Pause button, which is `tick`.
 *
 * Two things today's code does that it should not, both from auto-compare's
 * stop looking only at its timer, which the Pause button clears:
 *  - `paused` cannot be stopped. Leaving the match or clicking the rollback
 *    button leaves it paused, and resuming the tick then runs it in the menus.
 *  - `runningUnpausable`: with auto-compare paused, its button still reads
 *    "Stop auto-compare", and a click starts it again without clearing the
 *    pause mark. From then on Pause no longer pauses it, until it is stopped.
 *
 * The invariants it keeps (tests/ts/demo-run-state.test.ts walks every
 * reachable state):
 *  - the engine starts at most once and never stops;
 *  - the loader goes on the page at most once, and is loading only between
 *    going on and settling;
 *  - leaving a match turns rollback on, and auto-compare off unless the
 *    Pause button has it paused;
 *  - entering a match forgets that the controls were touched;
 *  - auto-compare is paused only while the tick is;
 *  - after Stop or Reset nothing changes.
 * Pause and Stop being clickable only in a match is not among them: the
 * page disables the buttons, from the engine's own reading of the match.
 */
import { Result, Schema } from 'effect';
import { setupEffect } from '@xstate/effect';
import { initialTransition, transition, type EventFrom, type SnapshotFrom, type StateValue } from 'xstate';
import { createComparer, type DisagreeReport } from '../play/observe.ts';

const Empty = Schema.Struct({});

export const demoRunMachine = setupEffect({
  schemas: {
    context: Schema.Struct({ autoCompareDisabled: Schema.Boolean }),
    input: Schema.Struct({
      /** `?autoCompare=0`: entering a match does not start auto-compare. */
      autoCompareDisabled: Schema.Boolean,
    }),
    events: {
      /** A ROM was read and the page tried to start the engine; `engineAvailable` is whether the engine script is there. */
      romLoaded: Schema.Struct({ engineAvailable: Schema.Boolean }),
      /** The emulator's loader script was put on the page. */
      loaderInjected: Empty,
      /** The loader finished, failed, or ran out of time. */
      loaderSettled: Empty,
      /** One HUD frame: the engine's strict (`isInMatch`) and inclusive (`isInMatchOrPaused`) readings. */
      frame: Schema.Struct({ strict: Schema.Boolean, inclusive: Schema.Boolean }),
      /** The latency slider moved, or the controls panel was opened. */
      interacted: Empty,
      /** The rollback button was clicked; the mode switch follows as `modeSwitched`. */
      rollbackToggleClicked: Empty,
      /** The mode changed: a switch (now or after a replay ends), or `KNDemo.setRollbackEnabled`. */
      modeSwitched: Schema.Struct({ rollback: Schema.Boolean }),
      /** The Pause button was clicked; `tickControl` is whether the engine can stop its tick. */
      pauseClicked: Schema.Struct({ tickControl: Schema.Boolean }),
      autoCompareClicked: Empty,
      /** 600 ms after entering a match: start auto-compare if nothing says not to. */
      autoStartDue: Empty,
      /** The Stop button was clicked; `emulator` is whether EmulatorJS is on the page. */
      stopClicked: Schema.Struct({ emulator: Schema.Boolean }),
      /** The page asked to reload itself: the Reset button, or the autopilot's one retry. */
      reset: Empty,
    },
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
            idle: {
              on: {
                romLoaded: ({ event }) => (event.engineAvailable ? { target: 'running' } : undefined),
              },
            },
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
            frame: ({ event }) => {
              if (!event.inclusive) return { target: '.menus' };
              return { target: event.strict ? '.playing' : '.gamePaused' };
            },
          },
          states: { menus: {}, playing: {}, gamePaused: {} },
        },
        tick: {
          initial: 'running',
          states: {
            running: { on: { pauseClicked: ({ event }) => (event.tickControl ? { target: 'paused' } : undefined) } },
            paused: { on: { pauseClicked: ({ event }) => (event.tickControl ? { target: 'running' } : undefined) } },
          },
        },
        autoCompare: {
          initial: 'off',
          states: {
            off: {
              on: {
                autoCompareClicked: { target: 'running' },
                autoStartDue: ({ context, value }) => (autoStarts(context, value) ? { target: 'running' } : undefined),
              },
            },
            running: {
              on: {
                autoCompareClicked: { target: 'off' },
                rollbackToggleClicked: { target: 'off' },
                frame: ({ event, value }) => (leavesMatch(value, event.inclusive) ? { target: 'off' } : undefined),
                pauseClicked: ({ event, value }) =>
                  event.tickControl && region(value, 'tick') === 'running' ? { target: 'paused' } : undefined,
              },
            },
            // Its timer is cleared and the time it was paused kept. Stopping it looks
            // only at the timer, so nothing stops it here: not the rollback button,
            // not leaving the match. A start from here keeps the mark.
            paused: {
              on: {
                autoCompareClicked: { target: 'runningUnpausable' },
                autoStartDue: ({ context, value }) =>
                  autoStarts(context, value) ? { target: 'runningUnpausable' } : undefined,
                pauseClicked: ({ event, value }) =>
                  event.tickControl && region(value, 'tick') === 'paused' ? { target: 'running' } : undefined,
              },
            },
            // Running with the pause mark left set: pausing and resuming both see it and do nothing.
            runningUnpausable: {
              on: {
                autoCompareClicked: { target: 'off' },
                rollbackToggleClicked: { target: 'off' },
                frame: ({ event, value }) => (leavesMatch(value, event.inclusive) ? { target: 'off' } : undefined),
              },
            },
          },
        },
        mode: {
          initial: 'rollback',
          on: {
            modeSwitched: ({ event }) => ({ target: event.rollback ? '.rollback' : '.lockstep' }),
            // Starting auto-compare starts it in rollback.
            autoCompareClicked: ({ value }) => (startsOnClick(value) ? { target: '.rollback' } : undefined),
            autoStartDue: ({ context, value }) => (autoStarts(context, value) ? { target: '.rollback' } : undefined),
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
            stopClicked: ({ event, value }) =>
              event.emulator || region(value, 'loader') !== 'none'
                ? { target: '#demo.leaving' }
                : { target: '.touched' },
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

const inMatch = (value: StateValue): boolean => region(value, 'match') !== 'menus';
const leavesMatch = (value: StateValue, inclusive: boolean): boolean => inMatch(value) && !inclusive;
const entersMatch = (value: StateValue, inclusive: boolean): boolean => !inMatch(value) && inclusive;

/** Whether a click on the auto-compare button starts it (its timer is not running) rather than stops it. */
const startsOnClick = (value: StateValue): boolean => {
  const state = region(value, 'autoCompare');
  return state === 'off' || state === 'paused';
};

/** Whether auto-compare starts on its own, 600 ms into a match. */
const autoStarts = (context: { readonly autoCompareDisabled: boolean }, value: StateValue): boolean =>
  inMatch(value) &&
  region(value, 'interaction') === 'untouched' &&
  !context.autoCompareDisabled &&
  startsOnClick(value);

/** The flags demo.js keeps for its run state, by their meaning. */
export interface RunFlags {
  readonly engineStarted: boolean;
  /** The engine half of the Pause, Stop and Reset buttons' availability. */
  readonly engineRunning: boolean;
  readonly loaderInjected: boolean;
  readonly bootInFlight: boolean;
  /** In a match, the game's pause menu included. */
  readonly inMatch: boolean;
  /** In a match and playing: the fake peer sends random input. */
  readonly fakePeerActive: boolean;
  /** The Pause button has the engine's tick stopped. */
  readonly tickPaused: boolean;
  /** Auto-compare's timer is running. */
  readonly autoCompareRunning: boolean;
  /** Auto-compare has a pause mark set. */
  readonly autoComparePaused: boolean;
  readonly rollbackEnabled: boolean;
  /** The player touched the controls this match. */
  readonly userInteracted: boolean;
}

/** The flags in the order they are compared and reported. */
export const RUN_FLAGS = [
  'engineStarted',
  'engineRunning',
  'loaderInjected',
  'bootInFlight',
  'inMatch',
  'fakePeerActive',
  'tickPaused',
  'autoCompareRunning',
  'autoComparePaused',
  'rollbackEnabled',
  'userInteracted',
] as const satisfies readonly (keyof RunFlags)[];

/** The flags as a plain record in `RUN_FLAGS` order, so two readings compare whatever order they were written in. */
const inOrder = (flags: RunFlags): Readonly<Record<string, boolean>> =>
  Object.fromEntries(RUN_FLAGS.map((name) => [name, flags[name]]));

/** What the flags should be in a state of `open`. */
export const runFlags = (value: StateValue): RunFlags => {
  const engine = region(value, 'engine') === 'running';
  const loader = region(value, 'loader');
  const match = region(value, 'match');
  const autoCompare = region(value, 'autoCompare');
  return {
    engineStarted: engine,
    engineRunning: engine,
    loaderInjected: loader !== 'none',
    bootInFlight: loader === 'loading',
    inMatch: match !== 'menus',
    fakePeerActive: match === 'playing',
    tickPaused: region(value, 'tick') === 'paused',
    autoCompareRunning: autoCompare === 'running' || autoCompare === 'runningUnpausable',
    autoComparePaused: autoCompare === 'paused' || autoCompare === 'runningUnpausable',
    rollbackEnabled: region(value, 'mode') === 'rollback',
    userInteracted: region(value, 'interaction') === 'touched',
  };
};

/** A state as one line: `leaving`, or each region's state in `RUN_REGIONS` order. */
export const runStateName = (value: StateValue): string => {
  if (region(value, 'engine') === 'leaving') return 'leaving';
  return RUN_REGIONS.map((name) => `${name}:${region(value, name)}`).join(' ');
};

export interface RunStateOptions {
  readonly autoCompareDisabled: boolean;
  /** demo.js's flags as they are now. */
  readonly read: () => RunFlags;
  /** Where a disagreement is logged. */
  readonly warn: (line: string) => void;
}

/**
 * The machine beside demo.js's flags. `send` takes what happened, moves the
 * machine and compares; it never throws into the page, and a throw is
 * reported as a disagreement. Once Stop or Reset has asked for a reload,
 * nothing more is compared.
 */
export const createRunState = (options: RunStateOptions) => {
  const reports: DisagreeReport[] = [];
  const comparer = createComparer((report) => {
    reports.push(report);
    options.warn(`[demo] run state disagrees after ${report.message}: page ${report.old}, machine ${report.next}`);
    return true;
  });
  let snapshot: RunSnapshot = initialTransition(demoRunMachine, {
    autoCompareDisabled: options.autoCompareDisabled,
  })[0];

  const send = (event: RunEvent): void => {
    try {
      if (snapshot.status === 'done') return;
      snapshot = transition(demoRunMachine, snapshot, event)[0];
      if (snapshot.status === 'done') return;
      comparer.compare(`demo-run:${event.type}`, inOrder(options.read()), inOrder(runFlags(snapshot.value)));
    } catch (error) {
      comparer.compare(`demo-run:${event.type}`, 'no error', String(error));
    }
  };

  return {
    send,
    /** The machine's state as one line. */
    state: (): string => runStateName(snapshot.value),
    /** Every disagreement so far (at most `DISAGREE_LIMIT`). */
    disagreements: (): readonly DisagreeReport[] => [...reports],
  };
};
