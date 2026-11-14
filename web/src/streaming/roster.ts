/**
 * The streaming engine's roster rules: who connects to whom when the room's
 * roster changes, and which controller ports the host's core sees plugged in.
 * Each is the rule web/static/netplay-streaming.js applies today
 * (onUsersUpdated, _controllerPresentMask), written as a function of its
 * inputs. The engine still decides; observe.ts compares.
 *
 * Streaming is a star, and its rule for who offers is not the rollback
 * mesh's (`shouldInitiate` in peer-signaling.ts: the lower slot offers, a
 * late joiner offers to everyone). Here only the host offers, to players and
 * spectators alike, and a page joining a stream in play never offers: it
 * tells the host it is listening (`streaming-late-join-ready`, signal.ts)
 * and the host offers then.
 */

/** A slot as the engine holds it: 0-3 for a player, null for a spectator, undefined when the roster did not say. */
export type Slot = number | null | undefined;

/** The slot of the one page that runs the emulator. */
export const HOST_SLOT = 0;

/** A controller port: a whole number from 0 to 3. */
export const isPlayerSlot = (slot: Slot): slot is number =>
  typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot < 4;

/**
 * The controller ports the core is told are plugged in: this page's own, and
 * every player's it knows from the roster or holds a connection for. Bit n
 * is port n. Zero means nobody has a port yet, and the engine then leaves
 * the core's mask alone.
 */
export const controllerPresentMask = (mySlot: Slot, others: readonly Slot[]): number => {
  let mask = 0;
  for (const slot of [mySlot, ...others]) if (isPlayerSlot(slot)) mask |= 1 << slot;
  return mask & 0x0f;
};

/** Does this page send the offers? Only the host does, whoever the other page is. */
export const offersConnections = (mySlot: Slot): boolean => mySlot === HOST_SLOT;

/** One connection the engine holds, by the socket id it is filed under. */
export interface Connection {
  readonly sid: string;
  readonly slot: Slot;
}

export interface RosterInput {
  /** This page's socket id; undefined while its signaling socket is down. */
  readonly mySid: string | undefined;
  /** This page's slot before this roster arrived. */
  readonly mySlot: Slot;
  readonly players: readonly { readonly socketId: string; readonly slot?: Slot }[];
  readonly spectators: readonly { readonly socketId: string }[];
  /** The connections held before this roster arrived, oldest first. */
  readonly connections: readonly Connection[];
  /** The host is already streaming: the match runs and the video is captured. */
  readonly live: boolean;
}

/**
 * `kept`: a connection that was already there. `offer`: a new one, offered
 * at once. `awaitReady`: a new one for a page joining a stream in play; the
 * offer waits until that page says its listener is up, because an offer it
 * is not listening for yet is lost.
 */
export type RosterStep = 'kept' | 'offer' | 'awaitReady';

export type RosterPlan = {
  /** This page's slot after the roster: the roster's, when it lists this page. */
  readonly mySlot: number | null;
  /** Every connection held afterwards, in the order the engine files them. */
  readonly connections: readonly { readonly sid: string; readonly slot: number | null; readonly step: RosterStep }[];
};

/**
 * What a roster does to the connection table.
 *
 * A page that is not the host changes nothing: it waits to be offered to.
 * The host takes a kept player's slot from the roster, and opens a
 * connection to every player and spectator it has none for. Nothing here
 * removes a connection: a page that left the roster is dropped only when its
 * connection fails (signal.ts, `connectionLost`).
 */
export const hostRosterPlan = (input: RosterInput): RosterPlan => {
  const mine = input.players.find((player) => player.socketId === input.mySid);
  const mySlot = mine ? mine.slot : input.mySlot;
  const table = new Map<string, { slot: Slot; step: RosterStep }>();
  for (const held of input.connections) table.set(held.sid, { slot: held.slot, step: 'kept' });

  if (offersConnections(mySlot)) {
    const fresh: RosterStep = input.live ? 'awaitReady' : 'offer';
    for (const player of input.players) {
      if (player.socketId === input.mySid) continue;
      const held = table.get(player.socketId);
      if (held) held.slot = player.slot;
      else table.set(player.socketId, { slot: player.slot, step: fresh });
    }
    for (const spectator of input.spectators) {
      if (spectator.socketId === input.mySid || table.has(spectator.socketId)) continue;
      table.set(spectator.socketId, { slot: null, step: fresh });
    }
  }

  return {
    mySlot: mySlot ?? null,
    connections: [...table].map(([sid, { slot, step }]) => ({ sid, slot: slot ?? null, step })),
  };
};
