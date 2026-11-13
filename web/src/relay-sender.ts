/**
 * Is a message that came through the server's relay allowed, given who the
 * server says sent it?
 *
 * `data-message` (also `snapshot` and `input`) is relayed from any member of
 * a room, spectators included, and everything in it is the sender's own
 * words. Before the server stamped the true sender on it, a spectator could
 * push an emulator state into a player, or change the mode every guest saw,
 * by sending the message the host would have sent. The contract below is
 * that made impossible: with a stamp, a message that installs emulator state
 * is allowed only from slot 0 (the engine's host is always slot 0), and
 * `mode-select` only from the room's owner.
 *
 * A message with no stamp at all comes from a server older than the stamp.
 * It is allowed as before: the server and the pages deploy together, and a
 * member cannot remove a stamp the server adds, so "no stamp" is never
 * something an attacker can choose once the server stamps.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/** The message installs an emulator state into the player who receives it. */
//@ ensures \result === (type === "save-state" || type === "late-join-state" || type === "sync-state-socket")
export function installsState(type: string): boolean {
  return type === 'save-state' || type === 'late-join-state' || type === 'sync-state-socket';
}

/**
 * @param type     the message's `type`
 * @param stamped  the server put its sender stamp on the message
 * @param slot     the sender's player slot as the server knows it; -1 for none (a spectator)
 * @param owner    the sender owns the room
 */
//@ ensures !stamped ==> \result === true
//@ ensures stamped && installsState(type) ==> \result === (slot === 0)
//@ ensures stamped && type === "mode-select" ==> \result === owner
//@ ensures stamped && !installsState(type) && type !== "mode-select" ==> \result === true
export function relayAllowed(type: string, stamped: boolean, slot: number, owner: boolean): boolean {
  if (!stamped) return true;
  if (installsState(type)) return slot === 0;
  if (type === 'mode-select') return owner;
  return true;
}
