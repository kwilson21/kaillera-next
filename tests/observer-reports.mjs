/**
 * What the two observers beside the rollback engine reported during a run.
 *
 * The per-peer connection machine (web/src/peer-observe.ts) and the proved
 * resync request rules (web/src/resync-request.ts) run beside the engine and
 * report any difference from what it did as a client event (`peer-disagree`,
 * `resync-disagree`) and a sync-log line (`PEER-DISAGREE`,
 * `RESYNC-DISAGREE`). Both are written only once the page has an upload
 * token. The end-to-end tests count them in three places: the page's sync
 * log, the client events the page sent (recorded by the test's KNEvent
 * wrapper), and, when KN_DB names the server's database (its DB_PATH), the
 * server's client_events table for the run's rooms. Any of them above zero
 * fails the run: a disagreement is what the fault-injection modes exist to
 * find.
 */

export const OBSERVER_EVENTS = ['peer-disagree', 'resync-disagree'];
const LINES = { 'peer-disagree': /PEER-DISAGREE/g, 'resync-disagree': /RESYNC-DISAGREE/g };

const zero = () => Object.fromEntries(OBSERVER_EVENTS.map((type) => [type, 0]));

/** The observers' lines in one sync log, by event type. */
export const observerLinesIn = (log) =>
  Object.fromEntries(OBSERVER_EVENTS.map((type) => [type, (log.match(LINES[type]) || []).length]));

/** The observers' client events among those a page sent ({type, meta}), by type. */
export const observerEventsIn = (events) => {
  const counts = zero();
  for (const event of events || []) if (event.type in counts) counts[event.type]++;
  return counts;
};

/**
 * The observers' rows in the server's client_events table for these rooms,
 * by type, or null when no database was named. node:sqlite is loaded only
 * then.
 */
export const observerEventsInDb = async (dbPath, rooms) => {
  if (!dbPath) return null;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const counts = zero();
    const marks = (list) => list.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT type, COUNT(*) AS n FROM client_events WHERE room IN (${marks(rooms)}) ` +
          `AND type IN (${marks(OBSERVER_EVENTS)}) GROUP BY type`,
      )
      .all(...rooms, ...OBSERVER_EVENTS);
    for (const row of rows) counts[row.type] = Number(row.n);
    return counts;
  } finally {
    db.close();
  }
};

/** The total of any number of count objects from the functions above (null ones are skipped). */
export const observerTotal = (...counts) =>
  counts.filter(Boolean).reduce((sum, c) => sum + OBSERVER_EVENTS.reduce((s, type) => s + (c[type] || 0), 0), 0);

/** What to print when the database could not be read, so it can be checked by hand. */
export const observerDbNote = (dbPath, rooms) =>
  dbPath
    ? null
    : `KN_DB unset: client_events not read. To check by hand, against the server's DB_PATH: ` +
      `SELECT type, COUNT(*) FROM client_events WHERE room IN (${rooms.map((r) => `'${r}'`).join(', ')}) ` +
      `AND type IN ('peer-disagree', 'resync-disagree') GROUP BY type`;
