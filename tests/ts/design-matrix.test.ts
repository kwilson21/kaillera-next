import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, newCoupling } from '../../scripts/check-design-matrix.ts';

const rows = ['a', 'b', 'c'];
const columns = ['x', 'y', 'z'];
const pairs = (...entries: string[]) =>
  entries.map((entry) => ({
    fr: entry.charAt(0),
    dp: entry.charAt(1),
  }));

test('recognizes a diagonal matrix after reassigning the columns', () => {
  const result = analyze(rows, columns, pairs('ay', 'bz', 'cx'));
  assert.equal(result.classification, 'uncoupled');
  assert.deepEqual(result.matching, { a: 'y', b: 'z', c: 'x' });
});

test('reroutes a provisional match and emits a legal order for a permutable triangular matrix', () => {
  const result = analyze(rows, columns, pairs('ax', 'az', 'bx', 'cy'));
  assert.equal(result.classification, 'decoupled');
  assert.deepEqual(result.matching, { a: 'z', b: 'x', c: 'y' });
  assert.ok(result.order.indexOf('b') < result.order.indexOf('a'));
  assert.deepEqual(result.graph.b, ['a']);
});

test('reports a cycle even when a perfect assignment exists', () => {
  const result = analyze(rows, columns, pairs('ax', 'ay', 'by', 'bx', 'cz', 'cx'));
  assert.equal(result.classification, 'coupled');
  assert.deepEqual(
    result.components.filter((component) => component.length > 1),
    [['a', 'b']],
  );
  assert.deepEqual(result.order, []);
});

test('reports a matching deficit', () => {
  const result = analyze(rows, columns, pairs('ax', 'bx', 'cy'));
  assert.equal(result.classification, 'no perfect matching');
});

test('reports new cross-dependencies and edges reclassified as accidental', () => {
  const fixture = {
    requirements: rows.map((id, index) => ({ id, counterpart: columns[index]! })),
    parameters: columns,
    evidence: {},
    baseline: { revision: '', entries: [] },
    changes: { add: [], remove: [] },
  };
  const entry = (fr: string, dp: string, kind: 'necessary' | 'accidental') => ({
    fr,
    dp,
    kind,
    mechanism: '',
    evidence: [],
  });
  const first = entry('b', 'x', 'necessary');
  const accidental = entry('b', 'x', 'accidental');
  const added = entry('c', 'x', 'necessary');
  assert.deepEqual(newCoupling(fixture, [first], [accidental, added, entry('a', 'x', 'necessary')]), [
    accidental,
    added,
  ]);
});
