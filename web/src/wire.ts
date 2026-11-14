/**
 * What a message off the wire is before anything has decoded it, and how a
 * decode failure is described without repeating what the message held.
 */
import { Result, Schema, type SchemaAST } from 'effect';

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

/** A schema node with unions opened up: the nodes a value at this point may be. */
const alternatives = (node: SchemaAST.AST): readonly SchemaAST.AST[] =>
  node._tag === 'Union' ? node.types.flatMap(alternatives) : [node];

/**
 * One step down a failure path. A key that names a struct field is ours and
 * is kept. Anything else at that position is a record key, which is payload
 * data (a player id, a socket id, whatever a client chose to call itself),
 * and is starred out whatever it looks like.
 */
const stepInto = (nodes: readonly SchemaAST.AST[], key: string | number) => {
  const next: SchemaAST.AST[] = [];
  let isField = false;
  for (const node of nodes.flatMap(alternatives)) {
    if (node._tag === 'Objects') {
      const field = node.propertySignatures.find((signature) => signature.name === key);
      if (field !== undefined) {
        isField = true;
        next.push(field.type);
      } else {
        for (const index of node.indexSignatures) next.push(index.type);
      }
    } else if (node._tag === 'Arrays' && typeof key === 'number') {
      next.push(...node.elements, ...node.rest);
    }
  }
  return { isField, next };
};

/** A path segment as Effect prints it: `["key"]` (JSON-quoted) or `[3]`. */
const SEGMENT = /\[(?:"((?:[^"\\]|\\.)*)"|(\d+))\]/g;

/**
 * Effect's failure message is `Expected X at ["players"]["<key>"]["slot"]`.
 * The path is walked down the schema, so that only the names of the schema's
 * own fields survive: `["players"]["*"]["slot"]`.
 */
export const redactPath = (message: string, schema: SchemaAST.AST): string => {
  let nodes: readonly SchemaAST.AST[] = [schema];
  return message.replaceAll(SEGMENT, (segment, quoted: string | undefined, index: string | undefined) => {
    if (index !== undefined) {
      nodes = stepInto(nodes, Number(index)).next;
      return '[*]';
    }
    let key = quoted ?? '';
    try {
      key = JSON.parse(`"${key}"`);
    } catch {
      // Not valid JSON escaping: cannot be one of our field names.
    }
    const { isField, next } = stepInto(nodes, key);
    nodes = next;
    return isField ? segment : '["*"]';
  });
};

/** For one schema: what is wrong with a payload, or null. Names a path, never a value. */
export const issueFinder = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownResult(schema);
  return (data: WirePayload): string | null => {
    const result = decode(data);
    return Result.isFailure(result) ? redactPath(result.failure.message, schema.ast).slice(0, ISSUE_MAX) : null;
  };
};
