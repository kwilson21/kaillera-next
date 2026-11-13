/**
 * The ROM sender's side of `rom-resume`.
 *
 * The sender opens a `rom-transfer` channel and waits for the receiver to
 * say which offset to send from (which also stops a double send when the
 * receiver signals twice). That message can be delivered before the sender's
 * own channel reports open. Sending then throws, so a request that arrives
 * early is kept and answered when the channel opens; dropping it left the
 * receiver waiting for a ROM for ever.
 */

import { Option, Schema } from 'effect';

/** What a DataChannel delivers: text, or binary in either of its forms. */
export type ChannelData = string | ArrayBuffer | Blob;

const RomResume = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal('rom-resume'),
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);
const decodeRomResume = Schema.decodeUnknownOption(RomResume);

/** The offset a `rom-resume` message asks for, or null for anything else. */
export function romResumeOffset(data: ChannelData): number | null {
  if (typeof data !== 'string') return null;
  return Option.match(decodeRomResume(data), { onNone: () => null, onSome: (message) => message.offset });
}

export interface RomResumeAnswerer {
  /** The sender's channel reported open. */
  readonly channelOpened: () => void;
  /** A message arrived on the channel; `channelOpen` is its state right now. */
  readonly received: (data: ChannelData, channelOpen: boolean) => void;
}

/** `send(offset)` is called once per request, and never while the channel is not open. */
export function createRomResumeAnswerer(send: (offset: number) => void): RomResumeAnswerer {
  let askedBeforeOpen: number | null = null;
  return {
    channelOpened: () => {
      if (askedBeforeOpen === null) return;
      const offset = askedBeforeOpen;
      askedBeforeOpen = null;
      send(offset);
    },
    received: (data, channelOpen) => {
      const offset = romResumeOffset(data);
      if (offset === null) return;
      if (channelOpen) send(offset);
      else askedBeforeOpen = offset;
    },
  };
}
