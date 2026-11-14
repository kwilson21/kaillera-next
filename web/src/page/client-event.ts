/**
 * The client event beacon, `window.KNEvent`: fire-and-forget error and event
 * reporting via navigator.sendBeacon(). Events land in the server's
 * /api/client-event endpoint.
 */
import type { PageState } from '../kn-state.ts';
import type { WirePayload } from '../wire.ts';

/** What a caller attaches to an event. */
export type EventMeta = Readonly<Record<string, WirePayload | undefined>>;

export type ClientEvent = (type: string, msg: string, meta?: EventMeta) => void;

/**
 * The page state every call reads afresh: the room, slot and token change
 * while the page is open. A page without the state has a script missing.
 */
export const pageState = (): PageState => {
  const state = window.KNState;
  if (!state) throw new ReferenceError('KNState is not defined');
  return state;
};

export const clientEvent: ClientEvent = (type, msg, meta = {}) => {
  const state = pageState();
  if (!state.uploadToken) return;
  // Auto-include match_id so funnel telemetry and existing diagnostic events
  // can correlate by match. Pre-game events (KNState.matchId === null) just
  // omit the field; in-game events get it for free without each call site
  // having to pass it explicitly.
  const enrichedMeta = state.matchId ? { ...meta, match_id: state.matchId } : meta;
  const body = JSON.stringify({
    type,
    msg,
    meta: enrichedMeta,
    room: state.room || '',
    slot: state.slot ?? -1,
    ua: navigator.userAgent,
    ts: Date.now(),
  });
  try {
    navigator.sendBeacon(
      `/api/client-event?token=${state.uploadToken}&room=${encodeURIComponent(state.room || '')}`,
      new Blob([body], { type: 'application/json' }),
    );
  } catch {}
};
