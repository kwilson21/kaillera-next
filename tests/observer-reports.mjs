/**
 * What the observers beside the rollback engine reported during a run.
 *
 * Observers ran beside the engine and reported any difference from what it
 * did as a client event and a sync-log line, written only once the page had
 * an upload token. None is left: the resync request rules
 * (web/src/resync-request.ts) decide, so their `resync-disagree` is gone,
 * and the per-peer machine (web/src/peer-driver.ts) is driven, so its
 * `peer-disagree` is gone. This file goes once the other observers decide
 * (docs/roadmap.md). Until then the end-to-end tests count the types listed
 * below in three places: the page's sync log, the client events the page
 * sent (recorded by the test's KNEvent wrapper), and, when KN_DB names the
 * server's database (its DB_PATH), the
 * server's client_events table for the run's rooms. Any of them above zero
 * fails the run: a disagreement is what the fault-injection modes exist to
 * find.
 */

/** No observer beside the engine reports now: nothing is counted. */
export const OBSERVER_EVENTS = [];
const LINES = {};

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

// node:sqlite, which reads the database, ships unflagged from Node 22.13.
const SQLITE_MIN_NODE = [22, 13];
export const SQLITE_NODE_ERROR = 'observer reports need Node >= 22.13 (node:sqlite)';

/** Does this Node version (process.versions.node, e.g. "22.12.0") have node:sqlite? */
export const nodeHasSqlite = (version) => {
  const [major, minor] = String(version).split('.').map(Number);
  return major > SQLITE_MIN_NODE[0] || (major === SQLITE_MIN_NODE[0] && minor >= SQLITE_MIN_NODE[1]);
};

/**
 * The observers' rows in the server's client_events table for these rooms,
 * by type, or null when no database was named. node:sqlite is loaded only
 * then. Throws when the database cannot be read, or this Node has no
 * node:sqlite (`nodeVersion` stands in for process.versions.node in tests);
 * callers count either as a failure.
 */
export const observerEventsInDb = async (dbPath, rooms, { nodeVersion = process.versions.node } = {}) => {
  if (!dbPath) return null;
  if (!nodeHasSqlite(nodeVersion)) throw new Error(`${SQLITE_NODE_ERROR}; this is Node ${nodeVersion}`);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const counts = zero();
    const marks = (list) => list.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT type, COUNT(*) AS n FROM client_events WHERE room IN (${marks(rooms)}) ` +
          // SQLite refuses `IN ()`: with no type to count, the query still reads the table and matches nothing.
          `AND ${OBSERVER_EVENTS.length > 0 ? `type IN (${marks(OBSERVER_EVENTS)})` : '0'} GROUP BY type`,
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
  dbPath || OBSERVER_EVENTS.length === 0
    ? null
    : `KN_DB unset: client_events not read. To check by hand, against the server's DB_PATH: ` +
      `SELECT type, COUNT(*) FROM client_events WHERE room IN (${rooms.map((r) => `'${r}'`).join(', ')}) ` +
      `AND type IN (${OBSERVER_EVENTS.map((t) => `'${t}'`).join(', ')}) GROUP BY type`;
