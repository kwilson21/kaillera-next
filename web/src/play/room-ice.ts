const MAX_RELAY_AGE_MS = 30 * 60 * 1000;
const EXPIRY_MARGIN_MS = 10_000;

const hasTurnUrl = (server: RTCIceServer): boolean => {
  const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
  return urls.some((url) => typeof url === 'string' && /^turns?:/i.test(url));
};

interface SavedRelay {
  servers: RTCIceServer[];
  expiresAt: number;
}

interface RoomIce {
  room: string;
  relay: SavedRelay | null;
  pending: Promise<void> | null;
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

export const createRoomIceCache = (now: () => number = Date.now) => {
  let active: RoomIce | null = null;

  const usable = (scope: RoomIce): RTCIceServer[] | null =>
    scope.relay && scope.relay.expiresAt > now() ? scope.relay.servers : null;

  const refresh = (
    room: string,
    request: Promise<RTCIceServer[]>,
    publish: (servers: RTCIceServer[]) => void,
  ): Promise<void> => {
    const scope = active?.room === room ? active : { room, relay: null, pending: null };
    active = scope;
    const startedAt = now();
    const pending = request
      .catch(() => [])
      .then((servers) => {
        if (active !== scope || scope.pending !== pending || !Array.isArray(servers)) return;
        if (servers.some(hasTurnUrl)) {
          const expiresAt = relayExpiry(servers, startedAt);
          if (expiresAt > now()) scope.relay = { servers, expiresAt };
        }
        const latest = usable(scope) ?? servers;
        if (latest.length > 0) publish(latest);
      });
    scope.pending = pending;
    return pending;
  };

  const ready = async (room: string): Promise<RTCIceServer[]> => {
    const scope = active;
    if (scope?.room !== room) return [];
    while (active === scope) {
      const relay = usable(scope);
      if (relay) return relay;
      const pending = scope.pending;
      if (!pending) return [];
      await pending;
      if (scope.pending === pending) break;
    }
    return active === scope ? (usable(scope) ?? []) : [];
  };

  return {
    refresh,
    ready,
    clear: () => {
      active = null;
    },
  };
};
