import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newPageId, readAttemptId } from '../../web/src/attempt-id.ts';

test('attempt ids are read only when well formed; a page id is new each time', () => {
  assert.deepEqual(readAttemptId({ page: 'abc', attempt: 3 }), { page: 'abc', attempt: 3 });
  assert.equal(readAttemptId(undefined), null);
  assert.equal(readAttemptId({ page: '', attempt: 1 }), null);
  assert.equal(readAttemptId({ page: 'abc', attempt: 0 }), null);
  assert.equal(readAttemptId({ page: 'abc', attempt: 1.5 }), null);
  assert.equal(readAttemptId({ page: 'x'.repeat(65), attempt: 1 }), null);
  assert.equal(readAttemptId({ page: 'abc' }), null);
  assert.notEqual(newPageId(), newPageId());
  assert.match(newPageId(), /^[0-9a-f]{18}$/);
});
