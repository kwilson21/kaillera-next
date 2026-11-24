import { tokenClaims } from './token-claims.ts';
const LEGACY_RELAY_AGE_MS = 30 * 60 * 1000;
const MAX_RELAY_TTL_SECONDS = 24 * 60 * 60;
const EXPIRY_MARGIN_MS = 10_000;
const READINESS_TIMEOUT_MS = 8000;
const RETRY_BACKOFF_MS = 15_000;
const MAX_PROVIDER_RETRY_SECONDS = 60;

const hasTurnUrl = (server: RTCIceServer): boolean => {
  const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
  return urls.some((url) => typeof url === 'string' && /^turns?:/i.test(url));
};

interface SavedRelay {
  servers: RTCIceServer[];
  expiresAt: number;
  requestId: number;
}

interface RoomIceWait {
  result: Promise<RTCIceServer[]>;
  resolve: (servers: RTCIceServer[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RoomIceResponse {
  servers: RTCIceServer[];
  relayTtlSeconds: number;
  retryAfterSeconds?: number;
}

interface RoomIceRetry {
  load: () => Promise<RoomIceResponse> | null;
  publish: (servers: RTCIceServer[]) => void;
}

/** Read expiry for scheduling only. The HTTP endpoint still verifies the signature. */
export const canRetryRoomIce = (room: string, token: string, now = Date.now()): boolean => {
  const claims = tokenClaims(token);
  return (
    claims?.k === 'upload' && claims.room === room && claims.exp * 1000 > now + READINESS_TIMEOUT_MS + EXPIRY_MARGIN_MS
  );
};

interface RoomIce {
  room: string;
  relay: SavedRelay | null;
  awaitingRefresh: boolean;
  pending: number;
  requestId: number;
  wait: RoomIceWait | null;
  timedOut: boolean;
  retryable: boolean;
  retryAfter: number;
}

const relayExpiry = (servers: RTCIceServer[], startedAt: number, relayTtlSeconds = 0): number => {
  // A relative TTL measured from request start accounts for delivery time
  // without relying on the client and server clocks being synchronized.
  if (Number.isInteger(relayTtlSeconds) && relayTtlSeconds > 0 && relayTtlSeconds <= MAX_RELAY_TTL_SECONDS) {
    return startedAt + relayTtlSeconds * 1000 - EXPIRY_MARGIN_MS;
  }
  let expiresAt = startedAt + LEGACY_RELAY_AGE_MS;
  for (const server of servers) {
    if (!hasTurnUrl(server) || typeof server.username !== 'string') continue;
    const expiry = /^([0-9]{10}):/.exec(server.username);
    if (expiry) expiresAt = Math.min(expiresAt, Number(expiry[1]) * 1000 - EXPIRY_MARGIN_MS);
  }
  return expiresAt;
};

export const createRoomIceCache = (now: () => number = Date.now, waitMs = READINESS_TIMEOUT_MS) => {
  let active: RoomIce | null = null;

  const usable = (scope: RoomIce): SavedRelay | null =>
    scope.relay && scope.relay.expiresAt > now() ? scope.relay : null;

  const finish = (scope: RoomIce, servers: RTCIceServer[]): void => {
    const wait = scope.wait;
    if (!wait) return;
    scope.wait = null;
    clearTimeout(wait.timer);
    wait.resolve(servers);
  };

  const clear = (): void => {
    const previous = active;
    active = null;
    if (previous) finish(previous, []);
  };

  const scopeFor = (room: string): RoomIce => {
    if (active?.room === room) return active;
    clear();
    active = {
      room,
      relay: null,
      awaitingRefresh: true,
      pending: 0,
      requestId: 0,
      wait: null,
      timedOut: false,
      retryable: false,
      retryAfter: 0,
    };
    return active;
  };

  const begin = (room: string): void => {
    const scope = scopeFor(room);
    scope.awaitingRefresh = true;
    scope.timedOut = false;
  };

  const refresh = (
    room: string,
    request: Promise<RoomIceResponse>,
    publish: (servers: RTCIceServer[]) => void,
  ): Promise<void> => {
    const scope = scopeFor(room);
    scope.awaitingRefresh = false;
    scope.timedOut = false;
    scope.pending++;
    const requestId = ++scope.requestId;
    const startedAt = now();
    return request
      .catch(() => null)
      .then((result) => {
        if (active !== scope) return;
        scope.pending--;
        const servers = Array.isArray(result?.servers) ? result.servers : [];
        let selected = usable(scope);
        let accepted = false;
        if (servers.some(hasTurnUrl)) {
          const expiresAt = relayExpiry(servers, startedAt, result?.relayTtlSeconds);
          if (expiresAt > now() && (!selected || requestId >= selected.requestId)) {
            selected = { servers, expiresAt, requestId };
            scope.relay = selected;
            accepted = true;
          }
        }
        // A valid older request may rescue a failed newer one, but cannot
        // replace a newer valid relay or publish the older request's STUN list.
        if (requestId === scope.requestId) {
          const delay = result?.retryAfterSeconds;
          const providerUnavailable =
            delay !== undefined && Number.isInteger(delay) && delay > 0 && delay <= MAX_PROVIDER_RETRY_SECONDS;
          scope.retryable = result === null || providerUnavailable;
          if (providerUnavailable) scope.retryAfter = Math.max(scope.retryAfter, now() + delay * 1000);
        }
        if (accepted || requestId === scope.requestId) {
          const latest = selected?.servers ?? servers;
          if (latest.length > 0) publish(latest);
        }
        if (selected || (scope.pending === 0 && !scope.awaitingRefresh)) {
          finish(scope, selected?.servers ?? []);
        }
      });
  };

  const ready = (room: string, retry?: RoomIceRetry): Promise<RTCIceServer[]> => {
    if (active && active.room !== room) return Promise.resolve([]);
    const scope = scopeFor(room);
    const selected = usable(scope);
    if (selected) return Promise.resolve(selected.servers);
    if (retry && scope.retryable && !scope.awaitingRefresh && scope.pending === 0 && scope.retryAfter <= now()) {
      const request = retry.load();
      if (request) {
        scope.retryAfter = now() + RETRY_BACKOFF_MS;
        void refresh(room, request, retry.publish);
      }
    }
    if (scope.timedOut || (!scope.awaitingRefresh && scope.pending === 0)) return Promise.resolve([]);
    if (scope.wait) return scope.wait.result;

    let resolve!: (servers: RTCIceServer[]) => void;
    const result = new Promise<RTCIceServer[]>((done) => {
      resolve = done;
    });
    const timer = setTimeout(() => {
      scope.timedOut = true;
      finish(scope, []);
    }, waitMs);
    scope.wait = { result, resolve, timer };
    return result;
  };

  return { begin, refresh, ready, clear };
};
