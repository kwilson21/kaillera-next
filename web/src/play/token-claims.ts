interface TokenClaims {
  readonly k: string;
  readonly room: string;
  readonly exp: number;
  readonly pid?: string;
}

/** Unverified claims for display and expiry checks. Only the server authenticates the token. */
export function tokenClaims(token: string | null): TokenClaims | null {
  const body = token && /^([A-Za-z0-9_-]+)\.[a-f0-9]{64}$/.exec(token)?.[1];
  if (!body) return null;
  try {
    const payload: unknown = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('k' in payload) ||
      typeof payload.k !== 'string' ||
      !('room' in payload) ||
      typeof payload.room !== 'string' ||
      !('exp' in payload) ||
      typeof payload.exp !== 'number' ||
      !Number.isSafeInteger(payload.exp)
    )
      return null;
    const claims = { k: payload.k, room: payload.room, exp: payload.exp };
    return 'pid' in payload && typeof payload.pid === 'string' ? { ...claims, pid: payload.pid } : claims;
  } catch {
    return null;
  }
}
