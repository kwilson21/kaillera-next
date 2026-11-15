// Run: node --test tests/observer-reports.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  SQLITE_NODE_ERROR,
  nodeHasSqlite,
  observerEventsIn,
  observerEventsInDb,
  observerLinesIn,
  observerTotal,
} from './observer-reports.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'observer-reports-'));

// A client_events table holding the observers' rows for two rooms, and
// other events beside them.
const makeDb = async (file) => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE client_events (id INTEGER PRIMARY KEY, room TEXT, type TEXT)');
  const insert = db.prepare('INSERT INTO client_events (room, type) VALUES (?, ?)');
  for (const [room, type] of [
    ['TPAAA', 'peer-disagree'],
    ['TPAAA', 'peer-disagree'],
    ['TPAAA', 'resync-disagree'],
    ['TPAAA', 'reconnect'],
    ['TPBBB', 'peer-disagree'],
  ])
    insert.run(room, type);
  db.close();
};

test('sync-log lines and client events are counted by type', () => {
  const log = 'x\tPEER-DISAGREE a\ny\tRESYNC-DISAGREE b\nz\tPEER-DISAGREE c\n';
  // Neither is counted: the resync request rules decide and the per-peer machine is driven.
  assert.deepEqual(observerLinesIn(log), {});
  assert.deepEqual(
    observerEventsIn([{ type: 'peer-disagree' }, { type: 'reconnect' }, { type: 'resync-disagree' }]),
    {},
  );
  assert.equal(observerTotal({ 'peer-disagree': 1 }, null, { 'resync-disagree': 3 }), 0);
});

test('no database named: nothing read', async () => {
  assert.equal(await observerEventsInDb('', ['TPAAA']), null);
});

test("the database's rows are counted for the run's rooms only", async () => {
  const file = path.join(tmp(), 'kn.db');
  await makeDb(file);
  // Rows from pages loaded before the observers went are not counted, and no query is built from an empty list.
  assert.deepEqual(await observerEventsInDb(file, ['TPAAA']), {});
  assert.deepEqual(await observerEventsInDb(file, ['TPAAA', 'TPBBB']), {});
  assert.deepEqual(await observerEventsInDb(file, ['TPCCC']), {});
});

test('a database that cannot be read throws, for the caller to count as a failure', async () => {
  const dir = tmp();
  await assert.rejects(observerEventsInDb(path.join(dir, 'missing.db'), ['TPAAA']));
  const noTable = path.join(dir, 'empty.db');
  const { DatabaseSync } = await import('node:sqlite');
  new DatabaseSync(noTable).close();
  await assert.rejects(observerEventsInDb(noTable, ['TPAAA']), /client_events/);
});

test('a Node without node:sqlite is refused before the import', async () => {
  for (const version of ['20.18.0', '22.12.0', '21.99.1']) assert.equal(nodeHasSqlite(version), false, version);
  for (const version of ['22.13.0', '22.23.4', '24.0.0']) assert.equal(nodeHasSqlite(version), true, version);
  await assert.rejects(observerEventsInDb('/does/not/matter.db', ['TPAAA'], { nodeVersion: '20.18.0' }), (error) =>
    error.message.startsWith(SQLITE_NODE_ERROR),
  );
  // No database named: there is nothing to read, so an old Node is no failure.
  assert.equal(await observerEventsInDb('', ['TPAAA'], { nodeVersion: '20.18.0' }), null);
});
