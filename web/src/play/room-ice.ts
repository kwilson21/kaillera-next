const MAX_RELAY_AGE_MS = 30 * 60 * 1000;
const EXPIRY_MARGIN_MS = 10_000;
const READINESS_TIMEOUT_MS = 8000;

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

interface RoomIce {
  room: string;
  relay: SavedRelay | null;
  awaitingRefresh: boolean;
  pending: number;
  requestId: number;
  wait: RoomIceWait | null;
  timedOut: boolean;
}

const relayExpiry = (servers: RTCIceServer[], startedAt: number): number => {
  // Our 24-hour generated credentials are served only in the first half of
  // their lifetime. Admin-configured static lists also stay bounded in memory.
  let expiresAt = startedAt + MAX_RELAY_AGE_MS;
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
    active = { room, relay: null, awaitingRefresh: true, pending: 0, requestId: 0, wait: null, timedOut: false };
    return active;
  };

  const begin = (room: string): void => {
    const scope = scopeFor(room);
    scope.awaitingRefresh = true;
    scope.timedOut = false;
  };

  const refresh = (
    room: string,
    request: Promise<RTCIceServer[]>,
    publish: (servers: RTCIceServer[]) => void,
  ): Promise<void> => {
    const scope = scopeFor(room);
    scope.awaitingRefresh = false;
    scope.timedOut = false;
    scope.pending++;
    const requestId = ++scope.requestId;
    const startedAt = now();
    return request
      .catch(() => [])
      .then((result) => {
        if (active !== scope) return;
        scope.pending--;
        const servers = Array.isArray(result) ? result : [];
        let selected = usable(scope);
        let accepted = false;
        if (servers.some(hasTurnUrl)) {
          const expiresAt = relayExpiry(servers, startedAt);
          if (expiresAt > now() && (!selected || requestId >= selected.requestId)) {
            selected = { servers, expiresAt, requestId };
            scope.relay = selected;
            accepted = true;
          }
        }
        // A valid older request may rescue a failed newer one, but cannot
        // replace a newer valid relay or publish the older request's STUN list.
        if (accepted || requestId === scope.requestId) {
          const latest = selected?.servers ?? servers;
          if (latest.length > 0) publish(latest);
        }
        if (selected || (scope.pending === 0 && !scope.awaitingRefresh)) {
          finish(scope, selected?.servers ?? []);
        }
      });
  };

  const ready = (room: string): Promise<RTCIceServer[]> => {
    if (active && active.room !== room) return Promise.resolve([]);
    const scope = scopeFor(room);
    const selected = usable(scope);
    if (selected) return Promise.resolve(selected.servers);
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
