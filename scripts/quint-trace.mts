/**
 * Turns a Quint trace into a Mermaid sequence diagram, so an ordering the
 * model found (a scenario, or the counterexample to a property) can be read
 * as a picture.
 *
 * A trace is a list of states in the Informal Trace Format, which is what
 * `quint test --out-itf` and `quint run --out-itf` write. Nothing here knows
 * a particular spec. The lifelines are found in the trace itself: every
 * state variable that is a map keyed by strings (`page` in
 * specs/room_lifecycle.qnt) has one lifeline per key, and everything else
 * belongs to one more lifeline, the hub (the server).
 *
 * Each step of the trace is drawn as:
 *   - an arrow from whoever acted to the hub, labelled with the action
 *   - a note on the hub with the hub variables the step changed
 *   - a note on the actor, and a dashed arrow from the hub to anyone else,
 *     with what the step changed for them
 *
 * Used by scripts/trace-diagram.mjs.
 */

export interface ItfTrace {
  readonly vars: readonly string[];
  readonly states: readonly Readonly<Record<string, unknown>>[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A value of the trace, written the way the spec writes it. */
export const show = (value: unknown): string => {
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`;
  if (!isObject(value)) return String(value);
  if (typeof value['#bigint'] === 'string') return value['#bigint'];
  if (Array.isArray(value['#set'])) return `{${value['#set'].map(show).join(', ')}}`;
  if (Array.isArray(value['#tup'])) return `(${value['#tup'].map(show).join(', ')})`;
  if (Array.isArray(value['#map'])) {
    const entries = value['#map'] as [unknown, unknown][];
    return `{${entries.map(([key, entry]) => `${show(key)}: ${show(entry)}`).join(', ')}}`;
  }
  if (typeof value['tag'] === 'string') {
    const inner = show(value['value']);
    return inner === '()' ? value['tag'] : `${value['tag']}(${inner})`;
  }
  return `{${Object.entries(value)
    .map(([key, entry]) => `${key}: ${show(entry)}`)
    .join(', ')}}`;
};

/** `room_current::room::page` is `page` to a reader. */
const shortName = (name: string): string => {
  const at = name.lastIndexOf('::');
  return at < 0 ? name : name.slice(at + 2);
};

/** The entries of a map keyed by strings, or undefined for anything else. */
const stringKeyedMap = (value: unknown): Map<string, unknown> | undefined => {
  if (!isObject(value) || !Array.isArray(value['#map'])) return undefined;
  const entries = value['#map'] as [unknown, unknown][];
  if (entries.length === 0 || !entries.every(([key]) => typeof key === 'string')) return undefined;
  return new Map(entries as [string, unknown][]);
};

/** A plain record of the spec, as opposed to a set, map, tuple or variant. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  isObject(value) && !Object.keys(value).some((key) => key.startsWith('#')) && typeof value['tag'] !== 'string';

/** What changed from `before` to `after`: the fields of a record, or the whole value. */
const change = (before: unknown, after: unknown): string => {
  if (isRecord(before) && isRecord(after)) {
    return Object.keys(after)
      .filter((key) => show(before[key]) !== show(after[key]))
      .map((key) => `${key}: ${show(after[key])}`)
      .join(', ');
  }
  return show(after);
};

/** Mermaid ends a message at `;` and reads `#` as the start of an entity. */
const text = (raw: string): string => raw.replace(/[#;]/g, (char) => (char === '#' ? '#35;' : '#59;'));

export interface DiagramOptions {
  /** The lifeline for every variable that is not kept per player. */
  readonly hub: string;
}

/**
 * The diagram for a trace. `labels[i]` names the step from state i to state
 * i + 1, so there is one label fewer than there are states.
 */
export const sequenceDiagram = (trace: ItfTrace, labels: readonly string[], options: DiagramOptions): string => {
  const { states } = trace;
  const first = states[0];
  if (first === undefined) throw new Error('the trace has no states');
  if (labels.length !== states.length - 1) {
    throw new Error(`${labels.length} step labels for ${states.length - 1} steps`);
  }
  const names = trace.vars.filter((name) => !name.startsWith('mbt::'));
  const perActor = names.filter((name) => stringKeyedMap(first[name]) !== undefined);
  const hubVars = names.filter((name) => !perActor.includes(name));
  const everyone = new Set<string>();
  for (const name of perActor) for (const key of stringKeyedMap(first[name])?.keys() ?? []) everyone.add(key);

  const perActorState = (state: Readonly<Record<string, unknown>>, who: string): string =>
    perActor.map((name) => show(stringKeyedMap(state[name])?.get(who))).join(' ');
  // Lifelines in the order they first act, then anyone a step changes
  // without their acting. Someone the trace never touches is left out.
  const touched = [...everyone].filter((who) =>
    states.some((state) => perActorState(state, who) !== perActorState(first, who)),
  );
  // Who acted: a player the label names. When it names several (a trace
  // from `--mbt` lists every value the step picked), the one the step changed.
  const actorOf = (label: string, index: number): string => {
    const named = [...label.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? '').filter((name) => everyone.has(name));
    const before = states[index] ?? {};
    const after = states[index + 1] ?? {};
    const changed = named.find((who) => perActorState(before, who) !== perActorState(after, who));
    return changed ?? named[0] ?? options.hub;
  };
  const order = [options.hub];
  for (const actor of [...labels.map(actorOf), ...touched]) if (!order.includes(actor)) order.push(actor);

  const lines = ['sequenceDiagram', ...order.map((name) => `  participant ${name}`)];
  labels.forEach((label, index) => {
    const before = states[index] ?? {};
    const after = states[index + 1] ?? {};
    const actor = actorOf(label, index);
    lines.push(`  ${actor}->>${options.hub}: ${text(label)}`);

    const hubChanges = hubVars
      .filter((name) => show(before[name]) !== show(after[name]))
      .map((name) => `${shortName(name)} = ${show(after[name])}`);
    if (hubChanges.length > 0) lines.push(`  Note over ${options.hub}: ${text(hubChanges.join('<br/>'))}`);

    for (const who of order) {
      const changes: string[] = [];
      for (const name of perActor) {
        const was = stringKeyedMap(before[name])?.get(who);
        const now = stringKeyedMap(after[name])?.get(who);
        if (show(was) === show(now)) continue;
        const what = change(was, now);
        changes.push(perActor.length > 1 ? `${shortName(name)}: ${what}` : what);
      }
      if (changes.length === 0) continue;
      const said = text(changes.join('<br/>'));
      lines.push(who === actor ? `  Note over ${who}: ${said}` : `  ${options.hub}-->>${who}: ${said}`);
    }
  });
  return `${lines.join('\n')}\n`;
};

// ── step labels for a `run` scenario ────────────────────────────────────

/** The index just past the parenthesis that closes the one opened before `from`. */
const closing = (source: string, from: number): number => {
  let depth = 1;
  let i = from;
  while (i < source.length && depth > 0) {
    const char = source[i];
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    i += 1;
  }
  if (depth !== 0) throw new Error('unbalanced parentheses in a run');
  return i;
};

/** The arguments of each `.then(...)` at the top level of `chain`, and what comes before the first. */
const thens = (chain: string): { head: string; args: string[] } => {
  const args: string[] = [];
  let head: string | undefined;
  let depth = 0;
  let i = 0;
  while (i < chain.length) {
    const char = chain[i];
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0 && chain.startsWith('.then(', i)) {
      head ??= chain.slice(0, i);
      const end = closing(chain, i + 6);
      args.push(chain.slice(i + 6, end - 1).trim());
      i = end;
    } else if (depth === 0 && chain.startsWith('.expect(', i)) {
      head ??= chain.slice(0, i);
      i = closing(chain, i + 8);
    } else {
      i += 1;
    }
  }
  return { head: (head ?? chain).trim(), args };
};

/**
 * The actions one `.then(...)` argument stands for. An `if` picks a branch on
 * a constant of the module instance, which `constants` gives; any other
 * condition cannot be decided here and is an error, never a guess.
 */
const actionsOf = (expression: string, constants: ReadonlyMap<string, boolean>): string[] => {
  if (!expression.startsWith('if (')) {
    const { head, args } = thens(expression);
    return [head, ...args.flatMap((arg) => actionsOf(arg, constants))];
  }
  const conditionEnd = closing(expression, 4);
  const condition = expression.slice(4, conditionEnd - 1).trim();
  const negated = /^not\((\w+)\)$/.exec(condition);
  const name = negated?.[1] ?? condition;
  const value = constants.get(name);
  if (value === undefined) throw new Error(`cannot tell which branch a run takes on: ${condition}`);
  const rest = expression.slice(conditionEnd);
  let depth = 0;
  let split = -1;
  for (let i = 0; i < rest.length && split < 0; i += 1) {
    if (rest[i] === '(') depth += 1;
    if (rest[i] === ')') depth -= 1;
    if (depth === 0 && rest.startsWith(' else ', i)) split = i;
  }
  if (split < 0) throw new Error(`an if without an else in a run: ${expression}`);
  const taken = value !== (negated !== null) ? rest.slice(0, split) : rest.slice(split + 6);
  return actionsOf(taken.trim(), constants);
};

/** The constants `module main { import base(A = true, B = false).* }` sets. */
export const instanceConstants = (source: string, main: string): Map<string, boolean> => {
  const constants = new Map<string, boolean>();
  const instance = new RegExp(`module ${main} \\{\\s*import \\w+\\(([^)]*)\\)`).exec(source);
  for (const pair of (instance?.[1] ?? '').split(',')) {
    const [name, value] = pair.split('=').map((part) => part.trim());
    if (name !== undefined && (value === 'true' || value === 'false')) constants.set(name, value === 'true');
  }
  return constants;
};

export interface RunScenario {
  readonly name: string;
  /** The comment above the run in the spec. */
  readonly comment: string;
  /** One label per step, in order. */
  readonly steps: string[];
}

/** Every `run` of a spec, with the action each of its steps takes in module `main`. */
export const runScenarios = (source: string, main: string): RunScenario[] => {
  const constants = instanceConstants(source, main);
  const lines = source.split('\n');
  const scenarios: RunScenario[] = [];
  lines.forEach((line, at) => {
    const name = /^\s*run (\w+) =\s*$/.exec(line)?.[1];
    if (name === undefined) return;
    const body: string[] = [];
    for (let i = at + 1; i < lines.length && /^\s+(init\b|\.)/.test(lines[i] ?? ''); i += 1) body.push(lines[i] ?? '');
    const comment: string[] = [];
    for (let i = at - 1; i >= 0 && /^\s*\/\//.test(lines[i] ?? ''); i -= 1) {
      comment.unshift((lines[i] ?? '').replace(/^\s*\/\/ ?/, ''));
    }
    const { args } = thens(body.map((part) => part.trim()).join(''));
    scenarios.push({
      name,
      comment: comment.join(' '),
      steps: args.flatMap((arg) => actionsOf(arg, constants)),
    });
  });
  return scenarios;
};

/**
 * Step labels for a trace written with `quint run --mbt`, which records the
 * action taken and the values it picked in every state.
 */
export const mbtLabels = (trace: ItfTrace): string[] =>
  trace.states.slice(1).map((state, index) => {
    const action = state['mbt::actionTaken'];
    if (typeof action !== 'string') return `step ${index + 1}`;
    const picks = state['mbt::nondetPicks'];
    const picked = isRecord(picks)
      ? Object.entries(picks).flatMap(([name, pick]) => {
          if (!isObject(pick) || pick['tag'] !== 'Some') return [];
          const value = pick['value'];
          return [`${name}: ${typeof value === 'string' ? `"${value}"` : show(value)}`];
        })
      : [];
    return picked.length > 0 ? `${action}(${picked.join(', ')})` : action;
  });
