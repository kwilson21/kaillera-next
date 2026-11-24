import { Result, Schema } from 'effect';
import { TargetSid } from './owner-proof-wire.ts';
import type { WirePayload } from './wire.ts';

export const CHECKPOINT_CAP = 'checkpointRecoveryV1';
export const CHECKPOINT_MESSAGE = 'checkpoint-recovery';
export const JOURNAL_FRAMES = 2048;
export const BATCH_SIZE = 128;
const frame = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0x7fffffff }));
const digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const token = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,96}$/));
const axis = Schema.Int.check(Schema.isBetween({ minimum: -128, maximum: 127 }));
const input = Schema.Tuple([
  Schema.Int.check(Schema.isBetween({ minimum: -2147483648, maximum: 2147483647 })),
  axis,
  axis,
  axis,
  axis,
]);
const common = {
  type: Schema.Literal(CHECKPOINT_MESSAGE),
  targetSid: TargetSid,
  match: token,
  epoch: frame,
  roster: digest,
};
const request = {
  id: token,
  request: frame,
  returning: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  c: frame,
  r: frame,
  anchor: digest,
};
const body = Schema.Union([
  Schema.Struct({ ...common, op: Schema.Literal('vote'), c: frame, parent: frame, seal: digest }),
  Schema.Struct({ ...common, ...request, op: Schema.Literals(['freeze', 'frozen', 'abort', 'decision']) }),
  Schema.Struct({
    ...common,
    ...request,
    op: Schema.Literal('journal'),
    owner: frame,
    start: frame,
    values: Schema.Array(input).check(Schema.isBetweenLength(1, BATCH_SIZE)),
  }),
  Schema.Struct({
    ...common,
    ...request,
    op: Schema.Literals(['installed', 'release']),
    state: digest,
    history: digest,
  }),
  Schema.Struct({ ...common, ...request, op: Schema.Literal('ready'), state: digest, history: digest, value: input }),
]);
export type CheckpointWire = typeof body.Type;
const decode = Schema.decodeUnknownResult(body);
export function decodeCheckpoint(raw: WirePayload): CheckpointWire | null {
  if (!raw || typeof raw !== 'object' || !('type' in raw) || raw.type !== CHECKPOINT_MESSAGE) return null;
  if ('values' in raw && (!Array.isArray(raw.values) || raw.values.length > BATCH_SIZE)) return null;
  const result = decode(raw);
  return Result.isSuccess(result) ? result.success : null;
}
