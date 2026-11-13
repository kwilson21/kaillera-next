/**
 * Reads the server's sender stamp off a relayed message and applies the rule
 * in relay-sender.ts. The pages call this first in every handler of a relayed
 * event and use `sid` wherever they used a socket id the message declared
 * about itself (`requesterSid`, `senderSid`, `sender`).
 */
import { Result } from 'effect';
import { decodeRelaySender } from './protocol.ts';
import { relayAllowed } from './relay-sender.ts';

/** The key the server stamps under (RELAY_SENDER_KEY in server/src/api/payloads.py). */
export const RELAY_SENDER_KEY = 'knFrom';

export interface RelayVerdict {
  /** Act on the message. */
  allowed: boolean;
  /** The server stamped it. False only for a server older than the stamp. */
  stamped: boolean;
  /** The sender's socket id as the server knows it; null when not stamped. */
  sid: string | null;
  /** The sender's player slot; null for a spectator, and when not stamped. */
  slot: number | null;
  owner: boolean;
}

const verdict = (allowed: boolean, stamped: boolean): RelayVerdict => ({
  allowed,
  stamped,
  sid: null,
  slot: null,
  owner: false,
});

/** A relayed message as it arrives: the sender's own fields, plus the server's stamp. */
export interface Relayed {
  readonly type?: unknown;
  readonly knFrom?: unknown;
}

export const checkRelayed = (msg: Relayed): RelayVerdict => {
  // No stamp: a server older than this check. Accepted as before, since the
  // server and the pages deploy together and a member cannot remove a stamp
  // the server adds.
  if (!Object.hasOwn(msg, RELAY_SENDER_KEY)) return verdict(true, false);
  const stamp = decodeRelaySender(msg.knFrom);
  // A stamp this page cannot read says nothing about the sender: refused.
  if (Result.isFailure(stamp)) return verdict(false, true);
  const { sid, slot, owner } = stamp.success;
  const type = typeof msg.type === 'string' ? msg.type : '';
  return { allowed: relayAllowed(type, true, slot ?? -1, owner), stamped: true, sid, slot, owner };
};
