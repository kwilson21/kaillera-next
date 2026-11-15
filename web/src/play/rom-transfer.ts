/**
 * A guest receiving the host's ROM: where the transfer stands after each
 * thing that happens to it, as one pure function. web/static/play.js's
 * receiver (onExtraDataChannel and the functions around it) keeps its
 * transfer in this state and moves it only through `receiverStep`; it owns
 * the channel, the timers, the bytes and the page, and does what each step
 * says next. The model is specs/rom_transfer.qnt; the decisions are
 * rom-transfer-step.ts.
 */
import type { RomTransferState } from '../reconnect.ts';
import {
  afterChannelClosed,
  afterResumeTimedOut,
  chunkVerdict,
  headerVerdict,
  MAX_RETRIES,
  type RetryVerdict,
} from './rom-transfer-step.ts';

/** The largest ROM a guest accepts from a host. */
export const ROM_MAX_SIZE = 128 * 1024 * 1024;

/** What the host said it is sending. `name` is the file's, for the guest's library. */
export type RomHeader = {
  readonly size: number;
  readonly hash: string | undefined;
  readonly name?: string | undefined;
};

/** Where a guest's transfer stands. */
export type Receiver = {
  readonly phase: RomTransferState;
  /** Automatic retries since the guest last acted. */
  readonly retries: number;
  /** Bytes of the file held so far; where a resumed transfer starts from. */
  readonly received: number;
  readonly header: RomHeader | null;
};

export const IDLE: Receiver = { phase: 'idle', retries: 0, received: 0, header: null };

/** Something that happened to the transfer. */
export type ReceiverEvent =
  /** The guest accepted the host's offer. */
  | { readonly kind: 'accept' }
  /** A game started while the guest, having accepted, still has no ROM. */
  | { readonly kind: 'game-started' }
  /** The host turned ROM sharing off, or on again for a guest still without a ROM. */
  | { readonly kind: 'sharing-off' }
  | { readonly kind: 'sharing-on' }
  /** The guest pressed Retry. */
  | { readonly kind: 'retry' }
  /** The guest's signaling came back and it asks again from where it stopped. */
  | { readonly kind: 'reconnected' }
  /** The guest cancelled, the game ended, or the host changed ROM. */
  | { readonly kind: 'reset' }
  /** The host opened a rom-transfer channel. */
  | { readonly kind: 'channel' }
  | {
      readonly kind: 'header';
      readonly size: number;
      readonly hash: string | undefined;
      readonly name?: string | undefined;
    }
  | { readonly kind: 'chunk'; readonly bytes: number }
  /** The host said the file is complete. */
  | { readonly kind: 'complete' }
  /** The channel closed. */
  | { readonly kind: 'closed' }
  /** The pause before an automatic retry ended. */
  | { readonly kind: 'backoff-elapsed' }
  /** No channel came within the deadline after asking. */
  | { readonly kind: 'resume-timed-out' };

/** What the guest does next, beside the new state. */
export type ReceiverNext =
  /** Nothing of its own. */
  | 'none'
  /** Ask the host for a channel now. */
  | 'ask'
  /** Ask again after the pause. */
  | 'ask-after-pause'
  /** The host stopped sharing: close the channel and cancel any ask on its way. */
  | 'stop'
  /** Out of automatic retries: the guest decides. */
  | 'stalled'
  /** The transfer was refused or abandoned; everything received is dropped. */
  | 'abandoned'
  /** The file is whole. */
  | 'finished';

/**
 * Why a transfer was abandoned. `tooLarge`: past the largest ROM a guest
 * accepts, by header or by bytes. `overHeader`: more bytes than the header
 * announced, by over a tenth. `sizeMismatch`: complete, but not as many bytes
 * as the header announced.
 */
export type AbandonedFor = 'tooLarge' | 'overHeader' | 'sizeMismatch';

export type ReceiverStep =
  | { readonly state: Receiver; readonly next: Exclude<ReceiverNext, 'abandoned'> }
  | { readonly state: Receiver; readonly next: 'abandoned'; readonly reason: AbandonedFor };

const stay = (state: Receiver): ReceiverStep => ({ state, next: 'none' });

const nextFor = (verdict: RetryVerdict): Exclude<ReceiverNext, 'abandoned'> =>
  verdict === 'retry' ? 'ask-after-pause' : 'stalled';

const onHeader = (state: Receiver, size: number, hash: string | undefined, name: string | undefined): ReceiverStep => {
  const sameFile = state.header !== null && state.header.hash === hash && state.header.size === size;
  const verdict = headerVerdict(size, ROM_MAX_SIZE, state.header !== null, sameFile);
  if (verdict === 'tooLarge') return { state: IDLE, next: 'abandoned', reason: 'tooLarge' };
  const header = { size, hash, name };
  return stay(verdict === 'restart' ? { ...state, received: 0, header } : { ...state, header });
};

/** The transfer after one event. */
export const receiverStep = (state: Receiver, event: ReceiverEvent): ReceiverStep => {
  switch (event.kind) {
    case 'accept':
      return { state: { ...IDLE, phase: 'resuming' }, next: 'ask' };
    case 'game-started':
      return stay(state.phase === 'idle' ? { ...state, phase: 'resuming' } : state);
    case 'sharing-off':
      // Also when already paused: the host closes its channel as it stops
      // sharing, and the guest can see that close, and schedule a retry,
      // before it hears that sharing is off (`noRetryWhileHostStopped` in
      // specs/rom_transfer.qnt).
      return state.phase === 'receiving' || state.phase === 'resuming' || state.phase === 'paused'
        ? { state: { ...state, phase: 'paused' }, next: 'stop' }
        : stay(state);
    case 'sharing-on':
      // Resume what was paused, with or without bytes, or start a transfer
      // that never began (`retriesBeforeAsking` in specs/rom_transfer.qnt).
      return state.phase === 'paused' || state.phase === 'idle'
        ? { state: { ...state, phase: 'resuming' }, next: 'ask' }
        : stay(state);
    case 'retry':
      return state.phase === 'paused' || state.phase === 'idle'
        ? { state: { ...state, phase: 'resuming', retries: 0 }, next: 'ask' }
        : stay(state);
    case 'reconnected':
      return { state: { ...state, phase: 'resuming', retries: 0 }, next: 'ask' };
    case 'reset':
      return stay(IDLE);
    case 'channel':
      // A channel that arrives while waiting to resume keeps what it has;
      // any other starts the file again.
      return stay(
        state.phase === 'resuming' || state.phase === 'paused'
          ? { ...state, phase: 'receiving' }
          : { ...IDLE, phase: 'receiving' },
      );
    case 'header':
      return onHeader(state, event.size, event.hash, event.name);
    case 'chunk': {
      const verdict = chunkVerdict(state.received, event.bytes, state.header?.size ?? -1, ROM_MAX_SIZE);
      return verdict === 'accept'
        ? stay({ ...state, received: state.received + event.bytes })
        : { state: IDLE, next: 'abandoned', reason: verdict };
    }
    case 'complete':
      // Short or long of what the host announced: not the file. The page
      // drops the bytes, so the count and header go too: a later request
      // starts the file again rather than resuming from bytes no longer held
      // (`countIsHeld` in specs/rom_transfer.qnt).
      return state.header !== null && state.header.size !== state.received
        ? { state: IDLE, next: 'abandoned', reason: 'sizeMismatch' }
        : { state: { ...state, phase: 'complete' }, next: 'finished' };
    case 'closed': {
      if (state.phase !== 'receiving') return stay(state);
      const retries = state.retries + 1;
      return {
        state: { ...state, phase: 'paused', retries },
        next: nextFor(afterChannelClosed(retries)),
      };
    }
    case 'backoff-elapsed':
      return state.phase === 'paused' ? { state: { ...state, phase: 'resuming' }, next: 'ask' } : stay(state);
    case 'resume-timed-out': {
      if (state.phase !== 'resuming') return stay(state);
      const retries = state.retries + 1;
      return { state: { ...state, phase: 'paused', retries }, next: nextFor(afterResumeTimedOut(retries)) };
    }
  }
};

/**
 * What the progress line says while the transfer is paused. Paused with the
 * host still sharing and retries left, a retry is already on its way (a close
 * or an unanswered request leads to `ask-after-pause`); otherwise the guest
 * is asked, by the Retry button the page shows.
 */
export const pausedText = (state: Receiver, sharing: boolean): string => {
  if (sharing && state.retries <= MAX_RETRIES) {
    return `ROM transfer interrupted — retrying (${state.retries}/${MAX_RETRIES})`;
  }
  if (state.header !== null && state.header.size > 0) {
    return `ROM transfer paused — ${Math.round((state.received / state.header.size) * 100)}% received`;
  }
  return 'ROM transfer failed';
};

/** How far a transfer has got, as the progress bar shows it. */
export const romProgress = (received: number, total: number) => {
  const percent = total > 0 ? Math.round((received / total) * 100) : 0;
  const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  return {
    percent,
    text: `Receiving ROM... ${percent}% (${megabytes(received)} / ${megabytes(total)} MB)`,
  };
};
