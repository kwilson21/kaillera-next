/**
 * What a message off the wire is before anything has decoded it, and how a
 * decode failure is described without repeating what the message held.
 */
import { Result, Schema } from 'effect';

/** Anything a Socket.IO message can carry: it arrives as parsed JSON. */
export type WirePayload =
  | null
  | undefined
  | boolean
  | number
  | string
  | readonly WirePayload[]
  | { readonly [key: string]: WirePayload };

const ISSUE_MAX = 240;

/**
 * Effect's failure message is `Expected X at ["players"]["<key>"]["slot"]`.
 * Field names are ours; a record's key is payload data (a player id, a socket
 * id), so anything that does not look like a field name is starred out.
 */
export const redactPath = (message: string): string =>
  message.replaceAll(/\["([^"\]]*)"\]/g, (segment, key: string) => (/^[A-Za-z_]{1,19}$/.test(key) ? segment : '["*"]'));

/** For one schema: what is wrong with a payload, or null. Names a path, never a value. */
export const issueFinder = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownResult(schema);
  return (data: WirePayload): string | null => {
    const result = decode(data);
    return Result.isFailure(result) ? redactPath(result.failure.message).slice(0, ISSUE_MAX) : null;
  };
};
