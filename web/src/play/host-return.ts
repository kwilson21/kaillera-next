import type { SafeStorage } from '../kn-state.ts';
import type { UsersUpdated } from '../protocol.ts';
import type { RoomAnswer } from '../landing/wire.ts';
import { tokenClaims } from './token-claims.ts';

/** The room's server verifies this credential before changing any membership. */
export const HOST_RETURN_PREFIX = 'kn-host-return:';
export const PLAYER_RETURN_PREFIX = 'kn-player-return:';
export const hostReturnKey = (room: string): string => HOST_RETURN_PREFIX + room;
export const playerReturnKey = (room: string, pid: string): string => PLAYER_RETURN_PREFIX + room + ':' + pid;
const PAST_HOST_PREFIX = 'kn-past-host:';
const MAX_PAST_ROOMS = 32;

/** After a host seat is cleared, an old creation bookmark should still open that room as a visitor. */
export function clearHostReturn(storage: SafeStorage, room: string, token: string): void {
  const key = hostReturnKey(room);
  if (storage.get('localStorage', key) !== token) return;
  storage.remove('localStorage', key);
  // Separate keys preserve independent room closures from different tabs.
  if (!storage.keys) return;
  const past = PAST_HOST_PREFIX + room;
  try {
    storage.set('localStorage', past, String(Date.now()));
    const keys = storage.keys('localStorage', PAST_HOST_PREFIX);
    if (keys.length <= MAX_PAST_ROOMS) return;
    const older = keys.filter((entry) => entry !== past);
    older.sort((a, b) => Number(storage.get('localStorage', a)) - Number(storage.get('localStorage', b)));
    for (const entry of older.slice(0, keys.length - MAX_PAST_ROOMS)) storage.remove('localStorage', entry);
  } catch {
    // The credential is already gone even if the browser cannot store the history.
  }
}

export type HostReturn = { readonly persistentId: string; readonly token: string };

/** Use the server's clock for the initial duration and elapsed local time thereafter. */
export function hostReturnClock(
  room: Pick<RoomAnswer, 'hostReturnDeadline' | 'serverTime'> | null,
  now = performance.now(),
): number | null {
  const end = room?.hostReturnDeadline;
  const sent = room?.serverTime;
  return typeof end === 'number' && Number.isFinite(end) && typeof sent === 'number' && Number.isFinite(sent)
    ? now + end - sent
    : null;
}

export const hostReturnSeconds = (clock: number | null, now = performance.now()): number =>
  clock === null ? 0 : Math.max(0, Math.ceil((clock - now) / 1000));

export const hostReturnDuration = (seconds: number): string =>
  Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');

export function readHostReturn(room: string, token: string | null, now = Date.now()): HostReturn | null {
  if (!token || !room) return null;
  const data = tokenClaims(token);
  if (
    data?.k === 'reconnect' &&
    data.room === room &&
    typeof data.pid === 'string' &&
    data.pid.length > 0 &&
    data.exp * 1000 > now
  ) {
    return { persistentId: data.pid, token };
  }
  return null;
}

/** Each seated player can return from a fresh tab. Spectators keep only their tab credential. */
export class RoomIdentity {
  readonly room: string;
  readonly storage: SafeStorage;
  readonly tokenKey: string;
  persistentId: string;
  reconnectToken: string;

  constructor(room: string, storage: SafeStorage) {
    this.room = room;
    this.storage = storage;
    this.tokenKey = `kn-reconnect-token:${room}`;
    this.persistentId = storage.get('sessionStorage', 'kn-player-id') || this.newPlayerId();
    storage.set('sessionStorage', 'kn-player-id', this.persistentId);
    this.reconnectToken =
      storage.get('sessionStorage', this.tokenKey) || storage.get('sessionStorage', 'kn-reconnect-token') || '';
  }

  private newPlayerId(): string {
    return typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  savedHost(now = Date.now()): HostReturn | null {
    return readHostReturn(this.room, this.storage.get('localStorage', hostReturnKey(this.room)), now);
  }

  savedPlayer(pid: string, now = Date.now()): HostReturn | null {
    const seat = readHostReturn(this.room, this.storage.get('localStorage', playerReturnKey(this.room, pid)), now);
    return seat?.persistentId === pid ? seat : null;
  }

  hasRoomToken(): boolean {
    return readHostReturn(this.room, this.reconnectToken, 0)?.persistentId === this.persistentId;
  }

  /** A restored host URL still means to return after its credential expires. */
  wasInRoom(): boolean {
    return !!(
      this.storage.get('sessionStorage', this.tokenKey) ||
      this.storage.get('localStorage', hostReturnKey(this.room)) ||
      this.storage.get('localStorage', PAST_HOST_PREFIX + this.room)
    );
  }

  forgetHost(): void {
    const host = this.savedHost(0);
    if (host?.persistentId === this.persistentId) this.discardRefused(host.token);
  }

  discardRefused(token: string): void {
    clearHostReturn(this.storage, this.room, token);
  }

  discardPlayer(token: string): void {
    const proof = readHostReturn(this.room, token, 0);
    if (!proof) return;
    const key = playerReturnKey(this.room, proof.persistentId);
    if (this.storage.get('localStorage', key) === token) this.storage.remove('localStorage', key);
  }

  joinSeparately(host: HostReturn): void {
    if (this.persistentId !== host.persistentId) return;
    this.resetTabIdentity();
  }

  leaveRoom(): void {
    this.forgetHost();
    this.storage.remove('localStorage', playerReturnKey(this.room, this.persistentId));
    this.resetTabIdentity();
  }

  private resetTabIdentity(): void {
    this.persistentId = this.newPlayerId();
    this.reconnectToken = '';
    this.storage.set('sessionStorage', 'kn-player-id', this.persistentId);
    this.storage.remove('sessionStorage', this.tokenKey);
    this.storage.remove('sessionStorage', 'kn-reconnect-token');
  }

  rememberHost(persistentId: string): void {
    const proof = readHostReturn(this.room, this.reconnectToken, 0);
    if (proof?.persistentId !== persistentId) return;
    this.storage.set('localStorage', hostReturnKey(this.room), proof.token);
    this.storage.remove('localStorage', playerReturnKey(this.room, persistentId));
  }

  rememberPlayer(persistentId: string): void {
    const proof = readHostReturn(this.room, this.reconnectToken, 0);
    if (proof?.persistentId === persistentId)
      this.storage.set('localStorage', playerReturnKey(this.room, persistentId), proof.token);
  }

  receiveToken(token: string, returning: HostReturn | null, owner: boolean, player = false): void {
    this.reconnectToken = token;
    if (!returning) this.storage.set('sessionStorage', this.tokenKey, token);
    if (owner) this.rememberHost(returning?.persistentId ?? this.persistentId);
    else if (player) this.rememberPlayer(returning?.persistentId ?? this.persistentId);
  }

  acceptReturnFromRoster(
    seat: HostReturn & { role: 'host' | 'player' },
    roster: Pick<UsersUpdated, 'players' | 'owner'> | null | undefined,
    socketId: string | undefined,
  ): boolean {
    if (
      !socketId ||
      roster?.players?.[seat.persistentId]?.socketId !== socketId ||
      (seat.role === 'host') !== (roster.owner === socketId)
    )
      return false;
    this.persistentId = seat.persistentId;
    if (!this.hasRoomToken()) this.reconnectToken = seat.token;
    this.storage.set('sessionStorage', 'kn-player-id', this.persistentId);
    this.storage.set('sessionStorage', this.tokenKey, this.reconnectToken);
    return true;
  }
}
