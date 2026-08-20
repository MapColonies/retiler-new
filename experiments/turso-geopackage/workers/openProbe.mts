/**
 * Opens the database once, with no open-retry, and exits non-zero if the open
 * itself was rejected. Used to measure the contended-open race that
 * multi-process WAL exposes when several pods start at the same moment.
 */
import { openTurso } from '../lib/turso.mts';

const [, , databasePath, timeoutMs] = process.argv;

if (databasePath === undefined) {
  throw new Error('usage: openProbe.mts <databasePath> [timeoutMs]');
}

const db = await openTurso(databasePath, {
  multiProcess: true,
  ...(timeoutMs === undefined ? {} : { timeoutMs: Number(timeoutMs) }),
});

await db.get('SELECT count(*) AS c FROM gpkg_contents');
await db.close();
