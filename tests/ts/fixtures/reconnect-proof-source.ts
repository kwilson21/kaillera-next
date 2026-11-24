import assert from 'node:assert/strict';

/** Install the production proof dependencies when a test extracts an engine slice.
 * Older scenarios start with no active protected request; they still run the real fences.
 */
export function reconnectProofSource(source: string): string {
  const start = source.indexOf('  // Exact protected answer, independent of generic resync bookkeeping.');
  const end = source.indexOf('  const _requestIdFrom =', start);
  assert.ok(start >= 0 && end > start, 'missing reconnect proof dependencies');
  return source.slice(start, end);
}
