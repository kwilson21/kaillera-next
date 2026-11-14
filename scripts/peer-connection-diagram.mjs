/**
 * Draws the per-peer connection machine (web/src/peer-connection.ts) as a
 * Mermaid flowchart in docs/peer-connection-machine.md.
 *
 * Like scripts/session-diagram.mjs, the diagram is found by walking the
 * machine with XState's pure `transition`: from the initial state, as the
 * lower slot and as the higher slot, over one sample of every kind of event
 * and every deadline the state arms. `--check` fails when the committed file
 * is out of date.
 *
 *   node scripts/peer-connection-diagram.mjs [--check]
 */
import fs from 'node:fs';
import { initialTransition, transition } from 'xstate';
import { PEER_TIMING, peerConnectionMachine, peerFacts, peerStateName } from '../web/src/peer-connection.ts';

const OUT = new URL('../docs/peer-connection-machine.md', import.meta.url);

// The deadlines each state arms, and the model's action each one is.
const DEADLINES = {
  startupAfter: { model: '`startupTimeout`', ms: PEER_TIMING.startupAfterMs, states: ['offering'] },
  attemptAfter: { model: '`attemptTimeout`', ms: PEER_TIMING.attemptAfterMs, states: ['reconnecting.offering'] },
  giveUpAfter: { model: '`giveUpTimeout`', ms: PEER_TIMING.giveUpAfterMs, states: ['reconnecting'] },
  answerAfter: {
    model: '`answerTimeout`',
    ms: PEER_TIMING.answerAfterMs,
    states: ['answering', 'reconnecting.answering'],
  },
  healAfter: {
    model: '`heal`',
    ms: PEER_TIMING.healAfterMs,
    states: ['absent', 'awaitingOffer', 'offering', 'stalled', 'answering', 'healing'],
  },
};

// What each state is in the model (`Side` in specs/peer_connection.qnt).
const MODEL = {
  absent: '`has` is false',
  awaitingOffer: '`has`; nothing offered or answered',
  offering: '`made` (then `link`) is its own offer, `attempt` >= 1: the roster offer or a startup retry',
  stalled: 'the same after the last startup retry: `attempt` = 0, `stalled`',
  answering: '`link` is their offer, not `open`, not `recon`',
  healing: '`made` (then `link`) is the offer the health check made: `attempt` = 0, not `recon`',
  open: '`open`',
  'reconnecting.awaitingOffer': '`recon` and `giveUp`; no connection',
  'reconnecting.offering': '`recon` and `giveUp`; `made` (then `link`) is its own offer, `attempt` >= 1',
  'reconnecting.answering': '`recon` and `giveUp`; `link` is their offer, `ansTimer`',
};

const offer = (mode, underEarlierId = false) => ({ type: 'offer', attempt: 90, mode, underEarlierId });
// One sample of each event, for the connection the entry has now.
const eventsFor = (snapshot) => {
  const name = peerStateName(snapshot.value);
  const attempt = snapshot.context.connection;
  const armed = Object.entries(DEADLINES).flatMap(([delay, { states }]) =>
    states
      .filter((state) => name === state || name.startsWith(`${state}.`))
      .map((state) => [delay, { type: 'xstate.after', delay, stateId: `peer.${state}` }]),
  );
  return [
    ['roster', { type: 'roster' }],
    ['left', { type: 'left' }],
    ['matchStarted', { type: 'matchStarted' }],
    ['matchEnded', { type: 'matchEnded' }],
    ['offer: first', offer('first')],
    ['offer: first, from a new page', offer('first', true)],
    ['offer: startup', offer('startup')],
    ['offer: reconnect', offer('reconnect')],
    ['answer', { type: 'answer', attempt }],
    ['opened', { type: 'opened', attempt }],
    ['lost', { type: 'lost', attempt }],
    ...armed,
  ];
};

const ROLES = [
  ['lower slot', { mySlot: 0, theirSlot: 1, timing: PEER_TIMING }],
  ['higher slot', { mySlot: 1, theirSlot: 0, timing: PEER_TIMING }],
];
const PHASES = ['before the match', 'in a match'];

// Attempt ids and counters are left out of what makes two states the same, so the walk ends.
const keyOf = (snapshot) => {
  const { running, listed, connection, awaitingAnswer, mine, tries, answerDeadline } = snapshot.context;
  return JSON.stringify([
    snapshot.value,
    running,
    listed,
    connection !== 0,
    awaitingAnswer,
    mine,
    tries,
    answerDeadline,
  ]);
};

const met = new Set(); // the states the walk got to
const where = new Map(); // state -> the "role|phase" it was seen in
const edges = new Map(); // "from to label commands" -> { from, to, label, commands, seen }
let initial = '';
for (const [role, input] of ROLES) {
  const [first] = initialTransition(peerConnectionMachine, input);
  initial = peerStateName(first.value);
  const seen = new Map([[keyOf(first), first]]);
  const queue = [first];
  while (queue.length) {
    const from = queue.shift();
    const fromName = peerStateName(from.value);
    const at = `${role}|${PHASES[Number(from.context.running)]}`;
    met.add(fromName);
    where.set(fromName, (where.get(fromName) ?? new Set()).add(at));
    for (const [label, event] of eventsFor(from)) {
      const [to, effects] = transition(peerConnectionMachine, from, event);
      const toName = peerStateName(to.value);
      const commands = effects.filter((effect) => effect.type === 'issue').map((effect) => effect.args[0].command.type);
      // An event that leaves the state where it was is drawn only when it makes a new offer.
      if (toName !== fromName || commands.includes('offer')) {
        const key = `${fromName} ${toName} ${label} ${commands}`;
        const edge = edges.get(key) ?? { from: fromName, to: toName, label, commands: new Set(), seen: new Set() };
        for (const command of commands) edge.commands.add(command);
        edge.seen.add(at);
        edges.set(key, edge);
      }
      if (!seen.has(keyOf(to))) {
        seen.set(keyOf(to), to);
        queue.push(to);
      }
    }
  }
}

const states = Object.keys(MODEL).filter((state) => met.has(state));

// An arrow one page or one phase alone takes says so, unless the state is only ever that page's or phase's.
const only = (edge, part, names) => {
  const pick = (set) => new Set([...set].map((at) => at.split('|')[part]));
  const taken = pick(edge.seen);
  return taken.size < pick(where.get(edge.from)).size ? names.filter((name) => taken.has(name)) : [];
};
const text = (edge) => {
  const notes = [...only(edge, 0, ['lower slot', 'higher slot']), ...only(edge, 1, PHASES)];
  const issued = edge.commands.size ? ` / ${[...edge.commands].join(', ')}` : '';
  return `${edge.label}${notes.length ? ` (${notes.join(', ')})` : ''}${issued}`;
};

// An event that takes every other state to the same place is said once in words, not drawn.
const everywhere = new Map(); // label -> target
for (const label of new Set([...edges.values()].map((edge) => edge.label))) {
  const taking = [...edges.values()].filter((edge) => edge.label === label);
  const same = new Set(taking.map((edge) => `${edge.to} ${[...edge.commands]}`));
  if (same.size === 1 && taking.length >= states.length / 2) everywhere.set(label, taking[0].to);
}

const node = (state) => state.replace('.', '_');
const inner = states.filter((state) => state.startsWith('reconnecting.'));
// Arrows, grouped by where they go from and to. One that every state of
// `reconnecting` takes to the same place is drawn once, from the box.
const arrows = new Map(); // "from to" -> labels
const draw = (from, to, label) => arrows.set(`${from} ${to}`, [...(arrows.get(`${from} ${to}`) ?? []), label]);
const fromBox = new Set();
for (const edge of edges.values()) {
  if (everywhere.has(edge.label)) continue;
  const label = text(edge);
  const shared = inner.every((state) =>
    [...edges.values()].some((twin) => twin.from === state && twin.to === edge.to && text(twin) === label),
  );
  if (inner.includes(edge.from) && !inner.includes(edge.to) && shared) {
    if (!fromBox.has(`${edge.to} ${label}`)) draw('reconnecting', node(edge.to), label);
    fromBox.add(`${edge.to} ${label}`);
  } else {
    draw(node(edge.from), node(edge.to), label);
  }
}

const yesNo = (value) => (value ? 'yes' : 'no');
const seconds = (ms) => `${ms / 1000} s`;
const lines = [
  '# Peer connection machine',
  '',
  'Generated from `web/src/peer-connection.ts` by `node scripts/peer-connection-diagram.mjs`. Do not edit',
  'by hand; `npm run check` fails when it is out of date.',
  '',
  'One machine per other player, as one page sees the WebRTC connection to them. It is one side of',
  '`specs/peer_connection.qnt`, built to the variant `peer_connection_fixed`. Nothing uses it yet: the',
  'engine keeps its own flags and timers.',
  '',
  '```mermaid',
  'flowchart LR',
  `  start(( )) --> ${node(initial)}`,
  '  subgraph reconnecting',
  ...inner.map((state) => `    ${node(state)}["${state.split('.')[1]}"]`),
  '  end',
  ...[...arrows.entries()].map(([key, labels]) => {
    const [from, to] = key.split(' ');
    return `  ${from} -->|"${labels.join('<br/>')}"| ${to}`;
  }),
  '```',
  '',
  'An arrow reads `event (who, when) / commands`: the event or deadline, the page and phase it is taken',
  'in when the state can be met in more than one, and what the machine wants done (it does none of it',
  'itself). The walk is made as the lower slot and as the higher slot of a pair, before and in a match.',
  'The pair walked is the host (slot 0, the lower slot) and one guest. The `reset` on a reconnect goes by',
  'the page, not the pair: every page but the host issues it, so between two guests the lower slot does too.',
  '',
  ...[...everywhere.entries()].map(
    ([label, target]) => `Not drawn, because every state it moves goes to \`${target}\` on it: \`${label}\`.`,
  ),
  'Events that leave a state unchanged are not drawn either, unless they make a new offer. Among them:',
  'an answer, a candidate or a channel event for an attempt other than the entry’s, which is ignored',
  'everywhere, and a roster update while the channel is open.',
  '',
  'Each state, what it is in the model, and what the engine keeps as flags for it (`peerFacts`):',
  '',
  '| State | In the model (`Side`) | Entry | Channel open | Reconnecting |',
  '|---|---|---|---|---|',
  ...states.map((state) => {
    const facts = peerFacts(state);
    return `| \`${state}\` | ${MODEL[state]} | ${yesNo(facts.entry)} | ${yesNo(facts.open)} | ${yesNo(facts.reconnecting)} |`;
  }),
  '',
  'The deadlines (`PEER_TIMING`, the engine’s numbers today):',
  '',
  '| Deadline | In the model | After | Armed in |',
  '|---|---|---|---|',
  ...Object.entries(DEADLINES).map(
    ([delay, { model, ms, states }]) =>
      `| \`${delay}\` | ${model} | ${seconds(ms)} | ${states.map((state) => `\`${state}\``).join(', ')} |`,
  ),
  '',
  '`startupAfter` acts only before the match, `healAfter` only in one; `giveUpAfter` runs across the',
  'states of `reconnecting`.',
  '',
];
const out = lines.join('\n');

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== out) {
    console.log('docs/peer-connection-machine.md is out of date; run: node scripts/peer-connection-diagram.mjs');
    process.exit(1);
  }
} else {
  fs.writeFileSync(OUT, out);
}
