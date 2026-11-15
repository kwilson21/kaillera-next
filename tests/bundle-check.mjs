/**
 * Refuses an end-to-end run against a TypeScript bundle that is not this
 * tree's.
 *
 * The play page loads web/static/dist/kn-core.js, which `npm run build`
 * makes from web/src and nothing rebuilds on its own (the directory is not
 * committed). A run after a merge, a rebase or an edit under web/src without
 * a build tests the old rules while reporting the new tree's commit. So
 * before a run: the bundle must exist and be newer than every file under
 * web/src and than the build script and the dependency manifests, and the
 * server under test must serve these same bytes (it may be
 * serving another checkout). The server has no build id for the bundle, so
 * the bytes are compared.
 */
import fs from 'node:fs';
import path from 'node:path';

const BUNDLE = path.join('web', 'static', 'dist', 'kn-core.js');
const SOURCES = path.join('web', 'src');
// What else makes the bundle's bytes: the build script and the dependencies.
const BUILD_INPUTS = [path.join('scripts', 'build-web.mjs'), 'package.json', 'package-lock.json'];
const SERVED_PATH = '/static/dist/kn-core.js';
// A server that takes the connection and never answers fails the check, not the run.
const FETCH_TIMEOUT_MS = 10000;

/** The newest modification time (ms) of any file under `dir`, and that file. */
export const newestUnder = (dir) => {
  let newest = { file: null, mtimeMs: 0 };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const candidate = entry.isDirectory() ? newestUnder(full) : { file: full, mtimeMs: fs.statSync(full).mtimeMs };
    if (candidate.mtimeMs > newest.mtimeMs) newest = candidate;
  }
  return newest;
};

/** Why the local bundle cannot be used, or null. */
export const localBundleProblem = (root) => {
  const bundle = path.join(root, BUNDLE);
  if (!fs.existsSync(bundle)) return `${BUNDLE} is missing`;
  const built = fs.statSync(bundle).mtimeMs;
  const inputs = [
    newestUnder(path.join(root, SOURCES)),
    ...BUILD_INPUTS.map((p) => path.join(root, p))
      .filter((file) => fs.existsSync(file))
      .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs })),
  ];
  const newer = inputs.find((input) => input.mtimeMs > built);
  if (newer) return `${path.relative(root, newer.file)} is newer than ${BUNDLE}`;
  return null;
};

/** Why the server at `baseUrl` is not serving this tree's bundle, or null. */
export const servedBundleProblem = async (root, baseUrl, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) => {
  const local = fs.readFileSync(path.join(root, BUNDLE));
  let served;
  try {
    const res = await fetchImpl(new globalThis.URL(SERVED_PATH, baseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return `${baseUrl}${SERVED_PATH} answered ${res.status}`;
    served = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    return `${baseUrl}${SERVED_PATH} could not be fetched (${error instanceof Error ? error.message : error})`;
  }
  if (!served.equals(local)) {
    return `the server at ${baseUrl} serves a different kn-core.js (${served.length} bytes) from this tree's (${local.length} bytes): is it running from another checkout?`;
  }
  return null;
};

/** Checks both; on a problem, prints what to do and exits. */
export const requireCurrentBundle = async (root, baseUrl) => {
  const problem = localBundleProblem(root) ?? (await servedBundleProblem(root, baseUrl));
  if (problem === null) return;
  console.log(`stale bundle: ${problem}. Run \`npm run build\` in ${root} (and serve that tree) before this test.`);
  process.exit(1);
};
