import { Duration, Effect, Fiber } from 'effect';
import { getJSONIfThere, isRoomAnswer, isSeatAnswer, type RoomAnswer } from '../landing/wire.ts';
import { startEvery } from '../poll.ts';
import {
  hostReturnClock,
  hostReturnDuration,
  hostReturnSeconds,
  readHostReturn,
  type HostReturn,
  type RoomIdentity,
} from './host-return.ts';

const lookupRoom = <T>(room: string, accepts: (body: unknown) => body is T, token?: string) =>
  Effect.tryPromise((signal) =>
    getJSONIfThere(window, '/room/' + encodeURIComponent(room), signal, accepts, token),
  ).pipe(Effect.timeout(Duration.seconds(8)));

export const roomForJoin = (room: string, signal: AbortSignal) =>
  Effect.runPromise(lookupRoom(room, isRoomAnswer), { signal });

export const seatForJoin = (room: string, token: string, signal: AbortSignal) =>
  Effect.runPromise(lookupRoom(room, isSeatAnswer, token), { signal });

/** A connected guest keeps its game while the room waits for the host's socket. */
export function hostWaitNotice(
  hostGameConnected: () => boolean,
): (room: Pick<RoomAnswer, 'status' | 'hostReturnDeadline' | 'serverTime'> | null) => void {
  let stop: (() => void) | undefined;
  return (room) => {
    stop?.();
    stop = undefined;
    const banner = document.getElementById('host-wait-banner');
    if (!banner) return;
    const clock = hostReturnClock(room);
    banner.hidden = clock === null;
    // The connection countdown owns the status while the room holds the host.
    const toolbarStatus = document.getElementById('toolbar-status');
    if (toolbarStatus) toolbarStatus.hidden = !banner.hidden;
    if (clock === null) return;
    const status = banner.querySelector<HTMLElement>('[role="status"]')!;
    const timer = banner.querySelector<HTMLElement>('[role="timer"]')!;
    const render = () => {
      const message =
        room?.status === 'playing' && hostGameConnected()
          ? 'The host is reconnecting to the room. Your game connection is still active.'
          : 'The host disconnected. Waiting for them to return.';
      if (status.textContent !== message) status.textContent = message;
      const seconds = hostReturnSeconds(clock);
      timer.textContent = hostReturnDuration(seconds);
      if (!seconds) stop?.();
    };
    stop = startEvery(render, 500);
    render();
  };
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
  const tick = () => {
    const seconds = hostReturnSeconds(clock);
    const released = !currentProof();
    retry.hidden = released || refused || seconds === 0;
    timer.hidden = retry.hidden;
    timer.textContent = timer.hidden ? '' : 'Time left to return: ' + hostReturnDuration(seconds);
    if (clock !== null && !seconds) message.textContent = 'The time to return has ended.';
    if (released) message.textContent = 'This browser no longer has that host seat.';
  };
  const check = lookupRoom(room, isRoomAnswer).pipe(
    Effect.match({
      onFailure: () => {
        if (dialog.open) message.textContent = 'Could not check the room. Trying again…';
      },
      onSuccess: (record) => {
        if (!dialog.open) return;
        if (!record) {
          dialog.close('gone');
          return;
        }
        clock = hostReturnClock(record);
        const latest = currentProof();
        if (latest && record.serverTime != null && !readHostReturn(room, latest.token, record.serverTime))
          refused = true;
        guest.hidden = clock !== null;
        message.textContent = refused
          ? 'Your host seat is no longer available.'
          : clock !== null
            ? 'Your host seat is reserved until the timer ends.'
            : 'The room is active. If your host tab just closed, keep this page open while it disconnects.';
        if (!refused && clock === null && error === 'Host tab is still connected')
          message.textContent = 'Your host tab is still connected. This page will check again.';
      },
    }),
    Effect.andThen(Effect.sync(tick)),
    Effect.andThen(Effect.sleep(Duration.seconds(3))),
  );
  retry.hidden = guest.hidden = timer.hidden = true;
  message.textContent = 'Checking your room…';
  dialog.returnValue = '';
  dialog.showModal();
  const poll = Effect.runFork(Effect.forever(check));
  const stopClock = startEvery(tick, 500);
  dialog.addEventListener(
    'close',
    () => {
      Effect.runFork(Fiber.interrupt(poll));
      stopClock();
      const selected = currentProof();
      if (dialog.returnValue === 'gone') gone();
      else if (dialog.returnValue === 'guest') choose(null);
      else if (dialog.returnValue === 'host' && !refused && hostReturnSeconds(clock) && selected) choose(selected);
      else window.location.assign('/');
    },
    { once: true },
  );
}
