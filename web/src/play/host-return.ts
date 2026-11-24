import type { SafeStorage } from '../kn-state.ts';
import { getJSONIfThere, isRoomAnswer, type RoomAnswer } from '../landing/wire.ts';
import { tokenClaims } from './token-claims.ts';

/** The room's server verifies this credential before changing any membership. */
export const HOST_RETURN_PREFIX = 'kn-host-return:';
export const hostReturnKey = (room: string): string => HOST_RETURN_PREFIX + room;
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

/** A connected guest keeps its game while the room waits for the host's socket. */
export function hostWaitNotice(): (room: Pick<RoomAnswer, 'hostReturnDeadline' | 'serverTime'> | null) => void {
  let ticking = 0;
  return (room) => {
    window.clearInterval(ticking);
    const banner = document.getElementById('host-wait-banner');
    if (!banner) return;
    const clock = hostReturnClock(room);
    banner.hidden = clock === null;
    if (clock === null) return;
    const timer = banner.querySelector<HTMLElement>('[role="timer"]')!;
    const render = () => {
      const seconds = hostReturnSeconds(clock);
      timer.textContent = hostReturnDuration(seconds);
      if (!seconds) window.clearInterval(ticking);
    };
    ticking = window.setInterval(render, 500);
    render();
  };
}

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

/** Keep ordinary credentials in the tab. Only a confirmed host saves a return credential for other tabs. */
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

  joinSeparately(host: HostReturn): void {
    if (this.persistentId !== host.persistentId) return;
    this.resetTabIdentity();
  }

  leaveRoom(): void {
    this.forgetHost();
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
    if (proof?.persistentId === persistentId) this.storage.set('localStorage', hostReturnKey(this.room), proof.token);
  }

  receiveToken(token: string, returning: HostReturn | null, owner: boolean): void {
    this.reconnectToken = token;
    if (!returning) this.storage.set('sessionStorage', this.tokenKey, token);
    if (owner) this.rememberHost(returning?.persistentId ?? this.persistentId);
  }

  acceptReturn(host: HostReturn): void {
    this.persistentId = host.persistentId;
    if (!this.hasRoomToken()) this.reconnectToken = host.token;
    this.storage.set('sessionStorage', 'kn-player-id', this.persistentId);
    this.storage.set('sessionStorage', this.tokenKey, this.reconnectToken);
  }
}

/** A saved seat may still be open in another tab. Only the server can start its return window. */
export function chooseHostReturn(
  identity: RoomIdentity,
  proof: HostReturn,
  error: string,
  choose: (returning: HostReturn | null) => void,
  gone: () => void,
): void {
  const dialog = document.querySelector<HTMLDialogElement>('#host-return-dialog');
  if (!dialog || dialog.open) return;
  const message = dialog.querySelector<HTMLElement>('[role="status"]')!;
  const timer = dialog.querySelector<HTMLElement>('[role="timer"]')!;
  const retry = dialog.querySelector<HTMLButtonElement>('[value="host"]')!;
  const guest = dialog.querySelector<HTMLButtonElement>('[value="guest"]')!;
  const room = identity.room;
  const remembered = identity.savedHost(0)?.persistentId === proof.persistentId;
  // A second tab can renew the credential or deliberately give up the seat while this dialog is open.
  const currentProof = () => {
    if (!remembered) return proof;
    const saved = identity.savedHost(0);
    return saved?.persistentId === proof.persistentId ? saved : null;
  };
  let refused = error === 'Host seat is no longer available';
  let clock: number | null = null;
  let poll = 0;
  let closed = false;
  const tick = () => {
    const seconds = hostReturnSeconds(clock);
    const released = !currentProof();
    retry.hidden = released || refused || seconds === 0;
    timer.hidden = retry.hidden;
    timer.textContent = timer.hidden ? '' : 'Time left to return: ' + hostReturnDuration(seconds);
    if (clock !== null && !seconds) message.textContent = 'The time to return has ended.';
    if (released) message.textContent = 'This browser no longer has that host seat.';
  };
  const check = async () => {
    try {
      const record = await getJSONIfThere(window, '/room/' + encodeURIComponent(room), 8000, isRoomAnswer);
      if (closed || !dialog.open) return;
      if (!record) {
        dialog.close('gone');
        return;
      }
      clock = hostReturnClock(record);
      const latest = currentProof();
      if (latest && record.serverTime != null && !readHostReturn(room, latest.token, record.serverTime)) refused = true;
      guest.hidden = clock !== null;
      message.textContent = refused
        ? 'Your host seat is no longer available.'
        : clock !== null
          ? 'The host disconnected. Returning here opens the room for a new match.'
          : 'The room is active. If your host tab just closed, keep this page open while it disconnects.';
      if (!refused && clock === null && error === 'Host tab is still connected')
        message.textContent = 'Your host tab is still connected. This page will check again.';
    } catch {
      if (closed || !dialog.open) return;
      message.textContent = 'Could not check the room. Trying again…';
    }
    tick();
    poll = window.setTimeout(check, 3000);
  };
  retry.hidden = guest.hidden = timer.hidden = true;
  message.textContent = 'Checking your room…';
  dialog.returnValue = '';
  const ticking = window.setInterval(tick, 500);
  dialog.addEventListener(
    'close',
    () => {
      closed = true;
      window.clearTimeout(poll);
      window.clearInterval(ticking);
      const selected = currentProof();
      if (dialog.returnValue === 'gone') gone();
      else if (dialog.returnValue === 'guest') choose(null);
      else if (dialog.returnValue === 'host' && !refused && hostReturnSeconds(clock) && selected) choose(selected);
      else window.location.assign('/');
    },
    { once: true },
  );
  dialog.showModal();
  void check();
}
