import type { SafeStorage } from '../kn-state.ts';
import {
  HOST_RETURN_PREFIX,
  PLAYER_RETURN_PREFIX,
  clearHostReturn,
  hostReturnClock,
  hostReturnDuration,
  hostReturnKey,
  hostReturnSeconds,
  playerReturnKey,
  readHostReturn,
} from '../play/host-return.ts';
import { getJSONIfThere, isSeatAnswer, type NetHost, type SeatAnswer } from './wire.ts';
import { hostReturnUrl, playUrl } from './wake.ts';

interface ReturnHost extends NetHost {
  readonly location: Location;
  readonly document: Document;
  readonly KNStorage?: SafeStorage;
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number): void;
  addEventListener(type: 'storage', listener: (event: StorageEvent) => void): void;
}

interface ReturnRow {
  readonly row: HTMLElement;
  readonly label: HTMLElement;
  readonly timer: HTMLElement;
  readonly code: string;
  readonly token: string;
  room: SeatAnswer;
  clock: number;
}

/** Name only what distinguishes the available choices on this browser. */
function captionFor(entry: ReturnRow, visible: readonly ReturnRow[]): string {
  if (visible.length < 2) return '';
  const sameRoom = visible.filter((o) => o !== entry && o.code === entry.code);
  const name = entry.room.room_name?.trim();
  const duplicate = visible.some((o) => o.code !== entry.code && o.room.room_name?.trim() === name);
  const room = name && !duplicate ? name : entry.code;
  if (!sameRoom.length) return room;
  const seat = entry.room.player_name || (entry.room.role === 'host' ? 'Host' : 'Player');
  const sameName = sameRoom.some((o) => o.room.player_name === entry.room.player_name);
  const player = sameName && entry.room.slot !== null ? seat + ' (P' + (entry.room.slot + 1) + ')' : seat;
  return sameRoom.length === visible.length - 1 ? player : room + ' · ' + player;
}

/** The homepage checks all saved seats. An invite checks only seats in that room. */
export function roomReturnLinks(
  host: ReturnHost,
  api: string,
  container: HTMLElement,
  roomCode?: string,
  onChange?: () => void,
): () => void {
  const storage = host.KNStorage;
  if (!storage?.keys || (api && new URL(api, host.location.href).origin !== host.location.origin)) return () => {};

  const rows = new Map<string, ReturnRow>();
  const pending = new Map<string, string>();
  const doc = host.document;
  let ticking = 0;
  let nextLabel = 0;

  const hide = (key: string) => {
    rows.get(key)?.row.remove();
    rows.delete(key);
  };
  const render = () => {
    for (const [key, entry] of rows) {
      const seconds = hostReturnSeconds(entry.clock);
      if (!seconds) {
        hide(key);
        continue;
      }
      const text = entry.room.role === 'host' ? 'Room closes in ' : 'Seat reserved for ';
      entry.timer.textContent = text + hostReturnDuration(seconds);
    }
    const visible = [...rows.values()];
    for (const entry of visible) {
      const caption = captionFor(entry, visible);
      if (entry.label.textContent !== caption) entry.label.textContent = caption;
      entry.label.hidden = !caption;
    }
    if (container.hidden !== (rows.size === 0)) {
      container.hidden = rows.size === 0;
      onChange?.();
    }
    if (container.hidden && ticking) {
      host.clearInterval(ticking);
      ticking = 0;
    } else if (!container.hidden && !ticking) {
      ticking = host.setInterval(render, 1000);
    }
  };
  const update = async (code: string, key: string, token: string, pid: string) => {
    pending.set(key, token);
    try {
      const room = await getJSONIfThere(host, api + '/room/' + encodeURIComponent(code), 8000, isSeatAnswer, token);
      if (storage.get('localStorage', key) !== token) return;
      if (!room || !readHostReturn(code, token, room.serverTime)) {
        if (key === hostReturnKey(code)) clearHostReturn(storage, code, token);
        else storage.remove('localStorage', key);
        hide(key);
        return;
      }
      const currentKey = room.role === 'host' ? hostReturnKey(code) : playerReturnKey(code, pid);
      if (currentKey !== key) {
        // Ownership can transfer while a former guest is between tabs.
        const current = readHostReturn(code, storage.get('localStorage', currentKey), room.serverTime);
        if (current?.persistentId !== pid) storage.set('localStorage', currentKey, token);
        storage.remove('localStorage', key);
        hide(key);
        check();
        return;
      }
      const clock = hostReturnClock({ hostReturnDeadline: room.returnDeadline, serverTime: room.serverTime });
      if (clock === null || !hostReturnSeconds(clock)) {
        hide(key);
        return;
      }
      const existing = rows.get(key);
      if (existing) {
        existing.clock = clock;
        existing.room = room;
        return;
      }
      const row = doc.createElement('div');
      row.className = 'host-return';
      const label = doc.createElement('span');
      label.id = 'return-seat-' + ++nextLabel;
      const link = doc.createElement('a');
      link.className = 'btn primary big';
      link.textContent = 'Return to room';
      link.setAttribute('aria-describedby', label.id);
      link.href =
        room.role === 'host'
          ? hostReturnUrl(api, code)
          : playUrl(api, code, false) + '#returnPlayer=' + encodeURIComponent(pid);
      const timer = doc.createElement('span');
      timer.setAttribute('role', 'timer');
      row.append(label, link, timer);
      container.append(row);
      rows.set(key, { row, label, timer, code, token, room, clock });
    } catch {
      // An unanswered lookup preserves the credential and any previously confirmed deadline.
    } finally {
      if (pending.get(key) === token) pending.delete(key);
      render();
    }
  };
  const check = () => {
    const keys = new Set<string>();
    for (const prefix of [HOST_RETURN_PREFIX, PLAYER_RETURN_PREFIX]) {
      for (const key of storage.keys!('localStorage', prefix + (roomCode || ''))) {
        const code = key.slice(prefix.length).split(':', 1)[0]!;
        if (roomCode && code !== roomCode) continue;
        const token = storage.get('localStorage', key);
        const seat = readHostReturn(code, token, 0);
        if (
          !token ||
          !seat ||
          !/^[A-Za-z0-9]{3,16}$/.test(code) ||
          (prefix === PLAYER_RETURN_PREFIX && key !== playerReturnKey(code, seat.persistentId))
        ) {
          if (storage.get('localStorage', key) === token) storage.remove('localStorage', key);
          continue;
        }
        keys.add(key);
        if (rows.has(key) && rows.get(key)?.token !== token) hide(key);
        if (pending.get(key) === token) continue;
        void update(code, key, token, seat.persistentId);
      }
    }
    for (const key of rows.keys()) if (!keys.has(key)) hide(key);
    render();
  };
  host.addEventListener('storage', (event) => {
    if (event.key === null || event.key.startsWith(HOST_RETURN_PREFIX) || event.key.startsWith(PLAYER_RETURN_PREFIX))
      check();
  });
  return check;
}
