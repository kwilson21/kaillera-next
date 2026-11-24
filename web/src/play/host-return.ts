import type { SafeStorage } from '../kn-state.ts';
import { tokenClaims } from './token-claims.ts';

/** The room's server verifies this credential before changing any membership. */
export const hostReturnKey = (room: string): string => `kn-host-return:${room}`;

export type HostReturn = { readonly persistentId: string; readonly token: string };

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

  savedHost(): HostReturn | null {
    return readHostReturn(this.room, this.storage.get('localStorage', hostReturnKey(this.room)));
  }

  hasRoomToken(): boolean {
    return readHostReturn(this.room, this.reconnectToken)?.persistentId === this.persistentId;
  }

  forgetHost(): void {
    if (this.savedHost()?.persistentId === this.persistentId)
      this.storage.remove('localStorage', hostReturnKey(this.room));
  }

  discardRefused(token: string): void {
    const key = hostReturnKey(this.room);
    if (this.storage.get('localStorage', key) === token) this.storage.remove('localStorage', key);
  }

  joinSeparately(host: HostReturn): void {
    if (this.persistentId !== host.persistentId) return;
    this.persistentId = this.newPlayerId();
    this.reconnectToken = '';
    this.storage.set('sessionStorage', 'kn-player-id', this.persistentId);
    this.storage.remove('sessionStorage', this.tokenKey);
    this.storage.remove('sessionStorage', 'kn-reconnect-token');
  }

  rememberHost(persistentId: string): void {
    const proof = readHostReturn(this.room, this.reconnectToken);
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

/** The buttons choose who joins. Dismissing the dialog returns to the lobby. */
export function chooseHostReturn(error: string, choose: (returning: boolean) => void): void {
  const dialog = document.querySelector<HTMLDialogElement>('#host-return-dialog');
  if (!dialog) return;
  const message = dialog.querySelector<HTMLElement>('[role="status"]')!;
  const retry = dialog.querySelector<HTMLButtonElement>('[value="host"]')!;
  retry.hidden = error === 'Host seat is no longer available';
  message.textContent =
    error === 'Host tab is still connected'
      ? 'The original host tab is still connected. Use that tab, or close it and try again here.'
      : error === 'Host seat is no longer available'
        ? 'Your host seat is no longer available. You can still join if the room is open.'
        : error;
  if (dialog.open) return;
  dialog.returnValue = '';
  dialog.addEventListener(
    'close',
    () => {
      if (!dialog.returnValue) window.location.assign('/');
      else choose(dialog.returnValue === 'host');
    },
    { once: true },
  );
  dialog.showModal();
}
