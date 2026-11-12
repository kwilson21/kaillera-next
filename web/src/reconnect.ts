/**
 * What a page does when its signaling socket comes back.
 *
 * Socket.IO v4 emits `reconnect` on the Manager, not on the Socket, and the
 * Manager's also fires for a first connection that needed retries. So a
 * reconnect is counted here as any `connect` after the first one.
 */

export interface ConnectResult {
  /** This `connect` follows an earlier one on the same socket. */
  readonly isReconnect: boolean;
  /** Attempts the Manager made before this connect; 0 on a clean first connect. */
  readonly attempts: number;
}

export const createConnectTracker = () => {
  let hasConnected = false;
  let attempts = 0;
  return {
    /** The Manager's `reconnect_attempt`. */
    attempt: (n: number): void => {
      attempts = n;
    },
    /** The Socket's `connect`. */
    connected: (): ConnectResult => {
      const result = { isReconnect: hasConnected, attempts };
      hasConnected = true;
      attempts = 0;
      return result;
    },
  };
};

export type RomTransferState = 'idle' | 'receiving' | 'paused' | 'resuming' | 'complete';

export interface RomResumeInput {
  readonly isHost: boolean;
  readonly sharingDecision: 'accepted' | 'declined' | null;
  readonly hasRom: boolean;
  readonly transferState: RomTransferState;
  /**
   * Mid-game: the page is still waiting to ask over the engine DataChannel.
   * That poll sends the request itself, or falls back to Socket.IO.
   */
  readonly askingOverEngine: boolean;
}

/**
 * Should a guest that has just rejoined its room ask the host for the ROM
 * again? A request or retry sent over Socket.IO while the socket was down is
 * flushed before the rejoin, so the server drops it and the transfer waits
 * for an answer that never comes.
 */
export const shouldResumeRomTransfer = (input: RomResumeInput): boolean => {
  if (input.isHost || input.sharingDecision !== 'accepted' || input.hasRom) return false;
  if (input.askingOverEngine) return false;
  return input.transferState === 'resuming' || input.transferState === 'paused';
};
