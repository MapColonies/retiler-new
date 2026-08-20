/**
 * The control writer: the same workload against ordinary SQLite in WAL mode,
 * where cross-process writes serialize on the write lock and a busy timeout.
 *
 * The plan requires Turso to show a meaningful end-to-end benefit over a
 * serialized SQLite writer, not merely overlapping transaction execution, so
 * every Turso number needs this baseline beside it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { toGeoPackageCoordinate } from '../lib/coordinates.mts';
import { tilePayload } from '../lib/payload.mts';
import { backoffDelayMs, classifyError, DEFAULT_RETRY_POLICY } from '../lib/retry.mts';
import { COMMIT_LOG_DDL, COMMIT_LOG_TABLE } from '../lib/turso.mts';
import type { AcknowledgedBatch, WriterConfig, WriterReport } from '../lib/types.mts';

interface ControlWriterConfig extends WriterConfig {
  busyTimeoutMs: number;
}

const [, , configPath, reportPath] = process.argv;

if (configPath === undefined || reportPath === undefined) {
  throw new Error('usage: sqliteControlWriter.mts <configPath> <reportPath>');
}

const config = JSON.parse(readFileSync(configPath, 'utf8')) as ControlWriterConfig;

const report: WriterReport = {
  writerId: config.writerId,
  mode: 'sqlite-control',
  batchesCommitted: 0,
  batchesFailed: 0,
  tilesPut: 0,
  tilesDeleted: 0,
  attempts: 0,
  retries: 0,
  conflicts: 0,
  busyErrors: 0,
  fatalErrors: 0,
  batchLatenciesMs: [],
  startedAtMs: Date.now(),
  finishedAtMs: Date.now(),
  cpuUserMs: 0,
  cpuSystemMs: 0,
  maxRssBytes: 0,
  errorSamples: [],
};

const acknowledged: AcknowledgedBatch[] = [];
let maxRssBytes = 0;

const db = new DatabaseSync(config.databasePath);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`PRAGMA busy_timeout = ${config.busyTimeoutMs}`);
db.exec(COMMIT_LOG_DDL);

const upsert = db.prepare(
  `INSERT INTO "${config.tileTable}" (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)
   ON CONFLICT (zoom_level, tile_column, tile_row) DO UPDATE SET tile_data = excluded.tile_data`
);
const remove = db.prepare(`DELETE FROM "${config.tileTable}" WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?`);
const logCommit = db.prepare(`INSERT INTO ${COMMIT_LOG_TABLE} (batch_id, writer_id, batch_index, ops_json, committed_at_ms) VALUES (?, ?, ?, ?, ?)`);

for (const batch of config.plan) {
  maxRssBytes = Math.max(maxRssBytes, process.memoryUsage.rss());

  const payload = await tilePayload({ writerId: batch.writerId, batchIndex: batch.index });
  const startedAt = performance.now();
  let attempt = 0;

  for (;;) {
    attempt++;
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const op of batch.ops) {
          const { zoomLevel, tileColumn, tileRow } = toGeoPackageCoordinate({ ...op, metatile: 1 });
          if (op.kind === 'put') {
            upsert.run(zoomLevel, tileColumn, tileRow, payload);
          } else {
            remove.run(zoomLevel, tileColumn, tileRow);
          }
        }
        logCommit.run(batch.batchId, batch.writerId, batch.index, JSON.stringify(batch.ops), Date.now());
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Keep the original failure; the rollback error would only mask it.
        }
        throw error;
      }

      report.batchesCommitted++;
      report.attempts += attempt;
      report.retries += attempt - 1;
      report.batchLatenciesMs.push(performance.now() - startedAt);
      report.tilesPut += batch.ops.filter((op) => op.kind === 'put').length;
      report.tilesDeleted += batch.ops.filter((op) => op.kind === 'delete').length;
      acknowledged.push({ batchId: batch.batchId, writerId: batch.writerId, index: batch.index, ops: batch.ops });
      break;
    } catch (error) {
      const retryable = classifyError(error) === 'retryable';
      if (retryable) {
        report.conflicts++;
        report.busyErrors++;
      }

      if (!retryable || attempt >= DEFAULT_RETRY_POLICY.maxAttempts) {
        report.batchesFailed++;
        report.fatalErrors++;
        report.attempts += attempt;
        if ((report.errorSamples?.length ?? 0) < 5) {
          report.errorSamples?.push(error instanceof Error ? error.message : String(error));
        }
        break;
      }

      await delay(backoffDelayMs(attempt, DEFAULT_RETRY_POLICY, Math.random));
    }
  }
}

db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();

const cpu = process.cpuUsage();
report.cpuUserMs = cpu.user / 1000;
report.cpuSystemMs = cpu.system / 1000;
report.maxRssBytes = Math.max(maxRssBytes, process.memoryUsage.rss());
report.finishedAtMs = Date.now();
report.acknowledged = acknowledged;

writeFileSync(reportPath, JSON.stringify(report));
