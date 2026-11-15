// Run: node --test tests/bundle-check.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { localBundleProblem, servedBundleProblem } from './bundle-check.mjs';

/** A tree with one source file and, if `bundle` is given, a built bundle; times in seconds. */
const tree = ({ sourceAt, bundle, bundleAt }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-check-'));
  const src = path.join(root, 'web', 'src', 'play');
  fs.mkdirSync(src, { recursive: true });
  const source = path.join(src, 'a.ts');
  fs.writeFileSync(source, 'export {};\n');
  fs.utimesSync(source, sourceAt, sourceAt);
  if (bundle !== undefined) {
    const dist = path.join(root, 'web', 'static', 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'kn-core.js'), bundle);
    fs.utimesSync(path.join(dist, 'kn-core.js'), bundleAt, bundleAt);
  }
  return root;
};

/** A server answering /static/dist/kn-core.js with `body` (or `status`). */
const serve = async (body, status = 200) => {
  const server = http.createServer((req, res) => {
    if (req.url !== '/static/dist/kn-core.js' || status !== 200) {
      res.writeHead(status === 200 ? 404 : status);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
};

test('a missing bundle is refused', () => {
  assert.match(localBundleProblem(tree({ sourceAt: 1000 })), /kn-core\.js is missing/);
});

test('a bundle older than a file under web/src is refused, naming the file', () => {
  const problem = localBundleProblem(tree({ sourceAt: 2000, bundle: 'x', bundleAt: 1000 }));
  assert.match(problem, /web\/src\/play\/a\.ts is newer than/);
});

test('a bundle built after every source passes', () => {
  assert.equal(localBundleProblem(tree({ sourceAt: 1000, bundle: 'x', bundleAt: 2000 })), null);
});

test('the server must serve the same bytes', async () => {
  const root = tree({ sourceAt: 1000, bundle: 'this tree', bundleAt: 2000 });
  const same = await serve('this tree');
  const other = await serve('another tree');
  try {
    assert.equal(await servedBundleProblem(root, same.url), null);
    assert.match(await servedBundleProblem(root, other.url), /serves a different kn-core\.js/);
  } finally {
    same.close();
    other.close();
  }
});

test('a server that answers with an error, or not at all, is refused', async () => {
  const root = tree({ sourceAt: 1000, bundle: 'this tree', bundleAt: 2000 });
  const missing = await serve('', 404);
  try {
    assert.match(await servedBundleProblem(root, missing.url), /answered 404/);
  } finally {
    missing.close();
  }
  assert.match(await servedBundleProblem(root, 'http://127.0.0.1:1'), /could not be fetched/);
});
