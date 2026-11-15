/**
 * Draws the demo page's run-state machine (web/src/demo/run-state.ts) as a
 * Mermaid flowchart in docs/demo-run-machine.md.
 *
 * Like scripts/session-diagram.mjs, the diagram is found by walking the
 * machine with XState's pure `transition`: from the initial state, with and
 * without `?autoCompare=0`, over one sample of every kind of event. Each
 * region is drawn on its own. An arrow taken only when another region is in
 * some of its states says which. `--check` fails when the committed file is
 * out of date.
 *
 *   node scripts/demo-run-diagram.mjs [--check]
 */
import fs from 'node:fs';
import { initialTransition, transition } from 'xstate';
import { RUN_REGIONS, demoRunMachine, issuedCommands, region, runStateName } from '../web/src/demo/run-state.ts';

const OUT = new URL('../docs/demo-run-machine.md', import.meta.url);

// One sample of each event demo.js sends, labelled the way a reader would say it.
const EVENTS = [
  ['engineStarted', { type: 'engineStarted' }],
  ['loaderInjected', { type: 'loaderInjected' }],
  ['loaderSettled', { type: 'loaderSettled' }],
  ['frame: menus', { type: 'frame', strict: false, inclusive: false }],
  ['frame: playing', { type: 'frame', strict: true, inclusive: true }],
  ["frame: game's pause menu", { type: 'frame', strict: false, inclusive: true }],
  ['interacted', { type: 'interacted' }],
  ['rollback button', { type: 'rollbackToggleClicked' }],
  ['modeSwitched: rollback', { type: 'modeSwitched', rollback: true }],
  ['modeSwitched: lockstep', { type: 'modeSwitched', rollback: false }],
  ['Pause', { type: 'pauseClicked', tickControl: true }],
  ['Pause, engine without pauseTick', { type: 'pauseClicked', tickControl: false }],
  ['auto-compare button', { type: 'autoCompareClicked' }],
  ['autoStartDue', { type: 'autoStartDue' }],
  ['Stop', { type: 'stopClicked', emulator: false }],
  ['Stop, EmulatorJS on the page', { type: 'stopClicked', emulator: true }],
  ['reset', { type: 'reset' }],
];

// What each event is, where demo.js sends it, and what it reads.
const SENT = {
  engineStarted: '`_startEngine`, once `NetplayRollback.init` has returned',
  loaderInjected: "`ensureEmulatorBooted`'s `injectLoader`, as it puts the loader script on the page",
  loaderSettled: '`markBootDone`: the loader finished, failed, or 30 s passed',
  frame: "every HUD frame, after the autopilot's check; the engine's `isInMatch()` and `isInMatchOrPaused()`",
  interacted: 'the latency slider, the controls button',
  rollbackToggleClicked: 'the rollback button',
  modeSwitched:
    '`_setRollbackEnabled`: `_switchMode` (at once, or once a replay ends), the engine start, `KNDemo.setRollbackEnabled`',
  pauseClicked: 'the Pause button; whether the engine has `pauseTick`',
  autoCompareClicked: 'the auto-compare button',
  autoStartDue: 'the timer set on entering a match, 600 ms later',
  stopClicked: 'the Stop button; whether `window.EJS_emulator` is there',
  reset: '`_resetDemo`: the Reset button, or the autopilot restarting the demo once',
};

/** A command as the page's handler gets it: `matchLeft(stopAutoCompare, rollbackChanged)`. */
const showCommand = (command) => {
  const { type, ...parts } = command;
  const named = Object.entries(parts)
    .filter(([, value]) => value === true)
    .map(([name]) => name);
  return Object.keys(parts).length === 0 ? type : `${type}(${named.join(', ')})`;
};

const INPUTS = [
  ['', { autoCompareDisabled: false }],
  ['?autoCompare=0', { autoCompareDisabled: true }],
];

const met = new Map(); // region -> Set of states the walk got to
const edges = new Map(); // "region from to label" -> { region, from, to, label, seen: Set of full-state keys }
const tried = new Map(); // "region from label" -> Set of full-state keys where it was tried
const fullStates = new Map(); // key -> { value, input }
const leavingBy = new Map(); // label -> { label, seen: Set of full-state keys }
const issued = new Map(); // "label commands" -> { label, commands, seen: Set of full-state keys }
const triedEverywhere = new Map(); // label -> Set of full-state keys
for (const [inputName, input] of INPUTS) {
  const [first] = initialTransition(demoRunMachine, input);
  const seen = new Map([[runStateName(first.value), first]]);
  const queue = [first];
  while (queue.length) {
    const from = queue.shift();
    const fromName = runStateName(from.value);
    if (fromName === 'leaving') continue;
    const key = `${inputName}|${fromName}`;
    fullStates.set(key, { value: from.value, input: inputName });
    for (const name of RUN_REGIONS) {
      const set = met.get(name) ?? new Set();
      met.set(name, set.add(region(from.value, name)));
    }
    for (const [label, event] of EVENTS) {
      const [to, effects] = transition(demoRunMachine, from, event);
      const toName = runStateName(to.value);
      const commands = issuedCommands(effects).map(showCommand).join(', ');
      if (commands) {
        const entry = issued.get(`${label} ${commands}`) ?? { region: '', label, commands, seen: new Set() };
        entry.seen.add(key);
        issued.set(`${label} ${commands}`, entry);
      }
      triedEverywhere.set(label, (triedEverywhere.get(label) ?? new Set()).add(key));
      for (const name of RUN_REGIONS) {
        const triedKey = `${name} ${region(from.value, name)} ${label}`;
        tried.set(triedKey, (tried.get(triedKey) ?? new Set()).add(key));
      }
      if (toName === 'leaving') {
        const edge = leavingBy.get(label) ?? { region: '', label, seen: new Set() };
        edge.seen.add(key);
        leavingBy.set(label, edge);
      } else {
        for (const name of RUN_REGIONS) {
          const a = region(from.value, name);
          const b = region(to.value, name);
          if (a === b) continue;
          const edgeKey = `${name} ${a} ${b} ${label}`;
          const edge = edges.get(edgeKey) ?? { region: name, from: a, to: b, label, seen: new Set() };
          edge.seen.add(key);
          edges.set(edgeKey, edge);
        }
      }
      if (!seen.has(toName)) {
        seen.set(toName, to);
        queue.push(to);
      }
    }
  }
}

// When an arrow is taken in only some of the states it was tried in, say what the others had.
const when = (edge) => {
  const triedKeys = edge.region
    ? tried.get(`${edge.region} ${edge.from} ${edge.label}`)
    : triedEverywhere.get(edge.label);
  const triedIn = [...triedKeys].map((key) => fullStates.get(key));
  const takenIn = [...edge.seen].map((key) => fullStates.get(key));
  const notes = [];
  for (const other of RUN_REGIONS) {
    if (other === edge.region) continue;
    const all = new Set(triedIn.map((state) => region(state.value, other)));
    const taken = new Set(takenIn.map((state) => region(state.value, other)));
    if (taken.size < all.size) notes.push(`${other} ${[...taken].join(' or ')}`);
  }
  const inputs = new Set(takenIn.map((state) => state.input));
  if (inputs.size < new Set(triedIn.map((state) => state.input)).size) {
    notes.push(inputs.has('') ? 'not ?autoCompare=0' : 'only ?autoCompare=0');
  }
  return notes.length ? `${edge.label} (${notes.join(', ')})` : edge.label;
};

const eventIndex = (label) => EVENTS.findIndex(([name]) => name === label);

const node = (name, state) => `${name}_${state}`;
const arrows = new Map(); // "from to" -> labels
for (const edge of edges.values()) {
  const key = `${node(edge.region, edge.from)} ${node(edge.region, edge.to)}`;
  arrows.set(key, [...(arrows.get(key) ?? []), when(edge)]);
}

const ORDER = {
  engine: ['idle', 'running'],
  loader: ['none', 'loading', 'done'],
  match: ['menus', 'playing', 'gamePaused'],
  tick: ['running', 'paused'],
  autoCompare: ['off', 'running', 'paused'],
  mode: ['rollback', 'lockstep'],
  interaction: ['untouched', 'touched'],
};
const [initial] = initialTransition(demoRunMachine, INPUTS[0][1]);
const lines = [
  '# Demo run-state machine',
  '',
  'Generated from `web/src/demo/run-state.ts` by `node scripts/demo-run-diagram.mjs`. Do not edit by',
  'hand; `npm run check` fails when it is out of date.',
  '',
  'What the demo page (`demo.html`) is doing, one region per part of it. `web/static/demo.js` keeps no',
  'flags for these: it sends the machine what happened and reads its state from it, and does what',
  'the machine issues (the commands below) when it issues it.',
  '',
  '```mermaid',
  'flowchart LR',
  '  subgraph open',
  ...RUN_REGIONS.flatMap((name) => {
    const states = ORDER[name].filter((state) => met.get(name)?.has(state));
    return [
      `    subgraph ${name}`,
      `      ${name}_start(( )) --> ${node(name, region(initial.value, name))}`,
      ...states.map((state) => `      ${node(name, state)}["${state}"]`),
      '    end',
    ];
  }),
  '  end',
  ...[...arrows.entries()].map(([key, labels]) => {
    const [from, to] = key.split(' ');
    return `  ${from} -->|"${labels.join('<br/>')}"| ${to}`;
  }),
  `  open -->|"${[...leavingBy.values()].map(when).join('<br/>')}"| leaving(((leaving)))`,
  '```',
  '',
  'An arrow reads `event (when)`: the event, and, if it is taken in only some of the states it can',
  'meet, the states of the other regions it is taken in. `leaving` is final: the page has asked to',
  'reload, and no event changes anything after it. Stop leaves only once the loader is on the page',
  '(or EmulatorJS is); before that it counts as a touch.',
  '',
  'The commands each event issues, in the order the page runs them (a part named in brackets is',
  'true; the others are false):',
  '',
  '| Event | Commands |',
  '|---|---|',
  ...[...issued.values()]
    .sort((a, b) => eventIndex(a.label) - eventIndex(b.label) || a.commands.localeCompare(b.commands))
    .map((entry) => `| ${when(entry)} | \`${entry.commands}\` |`),
  '',
  '`switchMode` comes back as `modeSwitched` once the page has switched (at once, or once a replay',
  'ends); its `applyMode` hands the mode to the engine and the button.',
  '',
  'Events and where `demo.js` sends them:',
  '',
  '| Event | Sent from |',
  '|---|---|',
  ...Object.entries(SENT).map(([event, from]) => `| \`${event}\` | ${from} |`),
  '',
  '`autoCompare.paused` is auto-compare with the Pause button down: still on, so its button, the',
  'rollback button and leaving the match stop it as they stop it running.',
  '',
];
const out = lines.join('\n');

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== out) {
    console.log('docs/demo-run-machine.md is out of date; run: node scripts/demo-run-diagram.mjs');
    process.exit(1);
  }
} else {
  fs.writeFileSync(OUT, out);
}
