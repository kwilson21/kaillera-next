/**
 * Draws the page lifecycle machine (web/src/session.ts) as a Mermaid state
 * diagram in docs/session-machine.md.
 *
 * The diagram is not written by hand: it is found by walking the machine
 * itself with XState's pure `transition`, from the initial state, over one
 * sample of every kind of event. So it cannot say something the code does
 * not do. `--check` fails when the committed file is out of date.
 *
 *   node scripts/session-diagram.mjs [--check]
 */
import fs from 'node:fs';
import { initialTransition, transition } from 'xstate';
import { sessionFlag, sessionMachine } from '../web/src/session.ts';

const OUT = new URL('../docs/session-machine.md', import.meta.url);

const joined = (over) => ({
  type: 'joined',
  status: 'playing',
  matchId: 'm',
  spectator: false,
  streaming: false,
  ...over,
});
// One sample of each event the page sends, labelled the way a reader would say it.
const EVENTS = [
  ['joined (room in lobby)', joined({ status: 'lobby', matchId: null })],
  ['joined mid-game', joined({})],
  ['joined mid-game (streamed)', joined({ streaming: true })],
  ['joined mid-game as spectator', joined({ spectator: true })],
  ['joined mid-game as spectator (streamed)', joined({ spectator: true, streaming: true })],
  ['gameStarted', { type: 'gameStarted', matchId: 'm' }],
  ['gameEnded', { type: 'gameEnded' }],
  ['roomClosed', { type: 'roomClosed' }],
  ['lateJoinRomNeeded', { type: 'lateJoinRomNeeded' }],
  ['lateJoinRomReady', { type: 'lateJoinRomReady' }],
  ['engineStarted (connect only)', { type: 'engineStarted', connectOnly: true, waitsForState: true }],
  ['engineStarted (needs state)', { type: 'engineStarted', connectOnly: false, waitsForState: true }],
  ['engineStarted (no state needed)', { type: 'engineStarted', connectOnly: false, waitsForState: false }],
  ['lateJoinSynced', { type: 'lateJoinSynced' }],
  ['socketDown', { type: 'socketDown' }],
  ['socketUp', { type: 'socketUp' }],
];

const [initial] = initialTransition(sessionMachine, { lateJoinReportAfterMs: 20000 });
const snapshots = new Map([[initial.value, initial]]);
const edges = new Map(); // "from to" -> labels
const queue = [initial];
while (queue.length) {
  const from = queue.shift();
  for (const [label, event] of EVENTS) {
    const [to] = transition(sessionMachine, from, event);
    if (to.value === from.value) continue;
    const key = `${from.value} ${to.value}`;
    edges.set(key, [...(edges.get(key) ?? []), label]);
    if (!snapshots.has(to.value)) {
      snapshots.set(to.value, to);
      queue.push(to);
    }
  }
}

const states = [...snapshots.keys()];
const yesNo = (value) => (value ? 'yes' : 'no');
const lines = [
  '# Page lifecycle machine',
  '',
  'Generated from `web/src/session.ts` by `node scripts/session-diagram.mjs`. Do not edit by hand;',
  '`npm run check` fails when it is out of date.',
  '',
  'Events that leave the state unchanged are not drawn. `gameEnded` and `roomClosed` return every',
  'state to the lobby.',
  '',
  '```mermaid',
  'stateDiagram-v2',
  `  [*] --> ${initial.value}`,
  ...[...edges.entries()].map(([key, labels]) => {
    const [from, to] = key.split(' ');
    return `  ${from} --> ${to}: ${labels.join(' / ')}`;
  }),
  '```',
  '',
  'What `play.js` reads from each state (`sessionFlag`):',
  '',
  '| State | A game is on | Waiting for a ROM | Next engine start is the late join |',
  '|---|---|---|---|',
  ...states.map(
    (state) =>
      `| \`${state}\` | ${yesNo(sessionFlag(state, 'gameRunning'))} | ${yesNo(sessionFlag(state, 'pendingLateJoin'))} | ${yesNo(sessionFlag(state, 'lateJoin'))} |`,
  ),
  '',
  'The Quint model of the same states, with the server beside them, is `specs/room_lifecycle.qnt`.',
  '',
];
const text = lines.join('\n');

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== text) {
    console.log('docs/session-machine.md is out of date; run: node scripts/session-diagram.mjs');
    process.exit(1);
  }
} else {
  fs.writeFileSync(OUT, text);
}
