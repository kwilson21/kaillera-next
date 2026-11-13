/**
 * Shapes of the Socket.IO messages, both directions. The schemas are generated
 * from the server's Pydantic models (server/src/api/payloads.py) into
 * protocol.gen.ts, so the two sides cannot drift: change the model, run
 * `npm run protocol`, and CI fails if the generated file is stale.
 *
 * Decoding at the socket boundary turns a server/client disagreement into one
 * logged event instead of an undefined property read somewhere downstream.
 */
export * from './protocol.gen.ts';
