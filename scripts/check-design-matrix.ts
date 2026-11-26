import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Pair = { fr: string; dp: string };
type Entry = Pair & { kind: 'necessary' | 'accidental'; mechanism: string; evidence: string[] };
type Evidence = { path: string; anchor: string; line: number; coverage: string[] };
type Matrix = {
  requirements: { id: string; counterpart: string }[];
  parameters: string[];
  evidence: Record<string, Evidence>;
  baseline: { revision: string; entries: Entry[] };
  changes: { add: Entry[]; remove: Pair[] };
};

const path = 'docs/architecture/design-matrix.json';
const root = fileURLToPath(new URL('../', import.meta.url));
const key = ({ fr, dp }: Pair) => `${fr}/${dp}`;

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function unique(values: string[], label: string) {
  requireValid(
    values.every((value) => typeof value === 'string' && value.length > 0),
    `Invalid ${label}`,
  );
  requireValid(new Set(values).size === values.length, `Duplicate ${label}`);
}

function finalEntries(matrix: Matrix) {
  const entries = new Map(matrix.baseline.entries.map((entry) => [key(entry), entry]));
  for (const pair of matrix.changes.remove) {
    requireValid(entries.delete(key(pair)), `Cannot remove missing entry ${key(pair)}`);
  }
  for (const entry of matrix.changes.add) {
    requireValid(!entries.has(key(entry)), `Cannot add existing entry ${key(entry)}`);
    entries.set(key(entry), entry);
  }
  return [...entries.values()];
}

function trackedPath(path: string) {
  requireValid(
    typeof path === 'string' &&
      /^(web|server|build|tests|specs|docs)\/[\w./-]+$/.test(path) &&
      path.split('/').every((part) => part !== '.' && part !== '..' && part !== ''),
    `Invalid evidence path ${path}`,
  );
  return resolve(root, path);
}

function validate(matrix: Matrix) {
  const frs = matrix.requirements.map(({ id }) => id);
  const dps = matrix.parameters;
  requireValid(frs.length > 0 && frs.length === dps.length, 'Expected a nonempty square matrix');
  unique(frs, 'FR IDs');
  unique(dps, 'DP IDs');
  requireValid(
    frs.every((id) => /^FR-[a-z0-9-]+$/.test(id)),
    'Invalid FR ID',
  );
  requireValid(
    dps.every((id) => /^DP-[a-z0-9-]+$/.test(id)),
    'Invalid DP ID',
  );
  unique(
    matrix.requirements.map(({ counterpart }) => counterpart),
    'counterpart assignments',
  );
  for (const { counterpart } of matrix.requirements) {
    requireValid(dps.includes(counterpart), `Unknown counterpart ${counterpart}`);
  }
  requireValid(/^[a-f0-9]{40}$/.test(matrix.baseline.revision), 'Expected a full baseline revision');
  unique(matrix.baseline.entries.map(key), 'baseline entries');
  const entries = finalEntries(matrix);
  const live = new Set(entries.flatMap((entry) => entry.evidence));
  for (const entry of [...matrix.baseline.entries, ...matrix.changes.add]) {
    const label = key(entry);
    requireValid(frs.includes(entry.fr) && dps.includes(entry.dp), `Unknown FR or DP in ${label}`);
    requireValid(entry.kind === 'necessary' || entry.kind === 'accidental', `Invalid kind for ${label}`);
    requireValid(
      typeof entry.mechanism === 'string' && entry.mechanism.trim().length > 0,
      `Missing mechanism for ${label}`,
    );
    requireValid(Array.isArray(entry.evidence) && entry.evidence.length > 0, `Missing evidence for ${label}`);
    unique(entry.evidence, `evidence references for ${label}`);
    for (const id of entry.evidence) {
      requireValid(Object.hasOwn(matrix.evidence, id), `Unknown evidence ${id} for ${label}`);
    }
  }
  const lines: Record<string, number> = Object.create(null);
  const files = new Map<string, string>();
  for (const [id, evidence] of Object.entries(matrix.evidence)) {
    const source = trackedPath(evidence.path);
    requireValid(Number.isSafeInteger(evidence.line) && evidence.line > 0, `Invalid recorded line for ${id}`);
    requireValid(typeof evidence.anchor === 'string' && evidence.anchor.trim().length > 0, `Missing anchor for ${id}`);
    requireValid(Array.isArray(evidence.coverage) && evidence.coverage.length > 0, `Missing coverage for ${id}`);
    unique(evidence.coverage, `coverage paths for ${id}`);
    for (const coverage of evidence.coverage) {
      requireValid(/^(tests|specs)\//.test(coverage), `Expected a test or spec for ${id}`);
      if (live.has(id)) readFileSync(trackedPath(coverage));
    }
    if (!live.has(id)) continue;
    const sourceText = files.get(source) ?? readFileSync(source, 'utf8');
    files.set(source, sourceText);
    const offset = sourceText.indexOf(evidence.anchor);
    requireValid(offset >= 0, `Missing anchor for ${id} in ${evidence.path}`);
    requireValid(sourceText.indexOf(evidence.anchor, offset + 1) === -1, `Ambiguous anchor for ${id}`);
    lines[id] = sourceText.slice(0, offset).split('\n').length;
  }
  return { entries, lines };
}

export function analyze(frs: string[], dps: string[], entries: Pair[]) {
  const columns = new Map(frs.map((fr) => [fr, entries.filter((entry) => entry.fr === fr).map(({ dp }) => dp)]));
  const owner = new Map<string, string>();
  // Augment the matching by rerouting previously assigned rows as needed.
  const assign = (fr: string, seen: Set<string>): boolean => {
    for (const dp of columns.get(fr) ?? []) {
      if (seen.has(dp)) continue;
      seen.add(dp);
      const previous = owner.get(dp);
      if (previous === undefined || assign(previous, seen)) {
        owner.set(dp, fr);
        return true;
      }
    }
    return false;
  };
  // Prefer the declared order when it already offers a valid assignment.
  for (const [index, fr] of frs.entries()) {
    const dp = dps[index];
    if (dp !== undefined && columns.get(fr)?.includes(dp)) owner.set(dp, fr);
  }
  const initialOwners = new Set(owner.values());
  for (const fr of frs) {
    if (!initialOwners.has(fr)) assign(fr, new Set());
  }
  const matching = Object.fromEntries([...owner].map(([dp, fr]) => [fr, dp]));
  const graph = new Map(frs.map((fr) => [fr, new Set<string>()]));
  const incoming = new Map(frs.map((fr) => [fr, new Set<string>()]));
  const matrix = frs.map((fr) => dps.map((dp) => Number(columns.get(fr)?.includes(dp) ?? false)));
  if (owner.size !== frs.length) {
    return { classification: 'no perfect matching', matching, matrix, graph: {}, components: [], order: [] };
  }
  for (const { fr, dp } of entries) {
    const from = owner.get(dp)!;
    if (from === fr) continue;
    graph.get(from)!.add(fr);
    incoming.get(fr)!.add(from);
  }

  // Kosaraju's two DFS passes also give a topological order for the SCCs.
  function visit(edges: Map<string, Set<string>>, node: string, seen: Set<string>, result: string[]) {
    if (seen.has(node)) return;
    seen.add(node);
    for (const next of edges.get(node)!) visit(edges, next, seen, result);
    result.push(node);
  }
  const finish: string[] = [];
  const visited = new Set<string>();
  for (const fr of frs) visit(graph, fr, visited, finish);
  visited.clear();
  const components: string[][] = [];
  for (const fr of finish.reverse()) {
    if (visited.has(fr)) continue;
    const component: string[] = [];
    visit(incoming, fr, visited, component);
    components.push(component.sort());
  }
  const coupled = components.some((component) => component.length > 1);
  return {
    classification: coupled ? 'coupled' : entries.length === frs.length ? 'uncoupled' : 'decoupled',
    matching,
    matrix,
    graph: Object.fromEntries([...graph].map(([fr, edges]) => [fr, [...edges].sort()])),
    components,
    order: coupled ? [] : components.flat(),
  };
}

function summarize(matrix: Matrix, entries: Entry[]) {
  const frs = matrix.requirements.map(({ id }) => id);
  const counterpart = new Map(matrix.requirements.map(({ id, counterpart }) => [id, counterpart]));
  const offDiagonal = entries.filter(({ fr, dp }) => counterpart.get(fr) !== dp);
  return {
    ...analyze(frs, matrix.parameters, entries),
    nonzero: entries.length,
    offDiagonal: offDiagonal.length,
    accidental: entries.filter(({ kind }) => kind === 'accidental').length,
  };
}

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function newCoupling(matrix: Matrix, previous: Entry[], current: Entry[]) {
  const old = new Map(previous.map((entry) => [key(entry), entry.kind]));
  const counterparts = new Map(matrix.requirements.map(({ id, counterpart }) => [id, counterpart]));
  return current.filter(
    ({ fr, dp, kind }) =>
      counterparts.get(fr) !== dp &&
      (old.get(key({ fr, dp })) === undefined || (kind === 'accidental' && old.get(key({ fr, dp })) !== kind)),
  );
}

function main(args: string[]) {
  const revision = args[0] === '--base' ? args[1] : undefined;
  const flags = revision === undefined ? args : args.slice(2);
  requireValid(
    flags.length === 0 || (flags.length === 1 && flags[0] === '--json'),
    'Usage: node scripts/check-design-matrix.ts [--base REV] [--json]',
  );
  const matrix: Matrix = JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const { entries, lines } = validate(matrix);
  let previous = matrix.baseline.entries;
  if (revision) {
    requireValid(/^[a-zA-Z0-9_/.-]+$/.test(revision) && !revision.startsWith('-'), 'Invalid base revision');
    const commit = git('rev-parse', '--verify', `${revision}^{commit}`);
    if (git('ls-tree', commit, '--', path)) {
      const base: Matrix = JSON.parse(git('show', `${commit}:${path}`));
      requireValid(
        JSON.stringify(base.baseline) === JSON.stringify(matrix.baseline),
        'The original baseline snapshot is immutable',
      );
      previous = finalEntries(base);
    }
  }
  const baseline = summarize(matrix, matrix.baseline.entries);
  const current = summarize(matrix, entries);
  const introduced = newCoupling(matrix, previous, entries);
  if (flags.includes('--json')) {
    console.log(JSON.stringify({ baseline, current, introduced, lines }, null, 2));
  } else {
    for (const [name, result] of Object.entries({ baseline, current })) {
      console.log(
        `${name}: ${result.classification}; ${result.nonzero} entries, ${result.offDiagonal} off-diagonal, ${result.accidental} accidental`,
      );
      for (const component of result.components.filter((group) => group.length > 1)) {
        console.log(`  cycle component: ${component.join(', ')}`);
      }
    }
    for (const entry of introduced) console.log(`New ${entry.kind} coupling: ${key(entry)}`);
  }
  requireValid(current.classification !== 'no perfect matching', 'Current FRs lack an independent set of assigned DPs');
  requireValid(!introduced.some(({ kind }) => kind === 'accidental'), 'New accidental coupling');
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
