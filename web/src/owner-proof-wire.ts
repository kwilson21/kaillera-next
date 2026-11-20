import { Result, Schema } from 'effect';
import type { WirePayload } from './wire.ts';

export const OWNER_PROOF_REQUEST = 'recovery-input-proof-request';
export const OWNER_PROOF_REPLY = 'recovery-input-proof-reply';
export const MAX_PROOF_IDS = 8;

const Id = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0x7fffffff }));
const Buttons = Schema.Int.check(Schema.isBetween({ minimum: -0x80000000, maximum: 0x7fffffff }));
const Axis = Schema.Int.check(Schema.isBetween({ minimum: -128, maximum: 127 }));
const Input = Schema.Tuple([Buttons, Axis, Axis, Axis, Axis]);
const Sample = Schema.Tuple([Id, Input]);
export const TargetSid = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,96}$/));
const Token = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22,64}$/));
const boundedIds = (ids: readonly number[]) =>
  new Set(ids).size === ids.length && Math.max(...ids) - Math.min(...ids) < MAX_PROOF_IDS;
const Ids = Schema.Array(Id).check(Schema.isBetweenLength(1, MAX_PROOF_IDS), Schema.makeFilter(boundedIds));
const Samples = Schema.Array(Sample).check(
  Schema.isBetweenLength(1, MAX_PROOF_IDS),
  Schema.makeFilter((samples: ReadonlyArray<typeof Sample.Type>) => boundedIds(samples.map(([id]) => id))),
);
export const OwnerProofRequestSchema = Schema.Struct({
  type: Schema.Literal(OWNER_PROOF_REQUEST),
  targetSid: TargetSid,
  token: Token,
  ids: Ids,
});
export const OwnerProofReplySchema = Schema.Struct({
  type: Schema.Literal(OWNER_PROOF_REPLY),
  targetSid: TargetSid,
  token: Token,
  samples: Samples,
});
type Wire = typeof OwnerProofRequestSchema.Type | typeof OwnerProofReplySchema.Type;
const decode = Schema.decodeUnknownResult(Schema.Union([OwnerProofRequestSchema, OwnerProofReplySchema]));
export function decodeOwnerProof(message: WirePayload): Wire | null {
  // Preflight the collection limit before traversing any untrusted entries.
  if (message === null || typeof message !== 'object' || !('type' in message)) return null;
  const values =
    message.type === OWNER_PROOF_REQUEST && 'ids' in message
      ? message.ids
      : message.type === OWNER_PROOF_REPLY && 'samples' in message
        ? message.samples
        : null;
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_PROOF_IDS) return null;
  const result = decode(message);
  return Result.isSuccess(result) ? result.success : null;
}
export type OwnerProofWire = Wire;
