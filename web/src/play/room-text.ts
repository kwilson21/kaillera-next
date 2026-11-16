/**
 * Words the room shows: escaped names, the closed-room message, invite links
 * and who-joined toasts. Moved from web/static/play.js unchanged in behaviour.
 */

const ESCAPES = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
]);

/** Text made safe to place in HTML. */
export const escapeHtml = (text: string | number | null | undefined): string =>
  String(text).replaceAll(/[&<>"']/g, (c) => ESCAPES.get(c) ?? c);

/** What a guest reads when the room they were in, or were invited to, is gone. */
export const roomClosedMessage = (hostName: string | null | undefined): string => {
  const host = (hostName || '').trim();
  return host
    ? `${host}'s room has closed. Rooms live only while someone's in them. Ask ${host} for a new link, or open your own.`
    : "This room has closed. Rooms live only while someone's in them. Ask for a new link, or open your own.";
};

/**
 * The link to hand someone: the invite page, which wakes the server if needed
 * and says what Join and Watch need before handing off to the play page.
 */
export const inviteUrl = (origin: string, roomCode: string, spectate: boolean): string =>
  `${origin}/join?room=${encodeURIComponent(roomCode)}${spectate ? '&spectate=1' : ''}`;

/** The people in a room, by persistent id. */
export type Roster = Readonly<Record<string, { readonly playerName: string }>>;

/**
 * The toasts for one roster change: who joined, who left, who started
 * watching. Someone who moved between playing and watching is not announced.
 * The very first roster a page sees announces nobody.
 */
export const rosterToasts = (
  previousPlayers: Roster,
  previousSpectators: Roster,
  players: Roster,
  spectators: Roster,
): string[] => {
  if (Object.keys(previousPlayers).length === 0 && Object.keys(previousSpectators).length === 0) return [];
  const toasts: string[] = [];
  for (const [pid, player] of Object.entries(players)) {
    if (!previousPlayers[pid] && !previousSpectators[pid]) toasts.push(`${escapeHtml(player.playerName)} joined`);
  }
  for (const [pid, player] of Object.entries(previousPlayers)) {
    if (!players[pid] && !spectators[pid]) toasts.push(`${escapeHtml(player.playerName)} left`);
  }
  for (const [pid, spectator] of Object.entries(spectators)) {
    if (!previousSpectators[pid] && !previousPlayers[pid]) {
      toasts.push(`${escapeHtml(spectator.playerName)} is watching`);
    }
  }
  for (const [pid, spectator] of Object.entries(previousSpectators)) {
    if (!spectators[pid] && !players[pid]) toasts.push(`${escapeHtml(spectator.playerName)} left`);
  }
  return toasts;
};
