/**
 * One independent Turso writer process, standing in for a single Retiler pod.
 *
 * Reads its configuration from a JSON file named on argv, applies every batch
 * in its plan as one transaction, and writes a report to the path given as the
 * second argument. Run as a separate OS process on purpose: concurrency within
 * one process proves nothing about pods sharing an RWX volume.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_RETRY_POLICY } from '../lib/retry.mts';
import { applyMutationBatch, checkpoint, ensureCommitLog, killSelf, openTursoWithRetry, type TransactionMode } from '../lib/turso.mts';
import type { AcknowledgedBatch, WriterConfig, WriterReport } from '../lib/types.mts';

interface TursoWriterConfig extends WriterConfig {
  multiProcess: boolean;
  mvcc: boolean;
  transactionMode: TransactionMode;
  timeoutMs?: number;
  checkpointOnClose: boolean;
}

const [, , configPath, reportPath] = process.argv;

if (configPath === undefined || reportPath === undefined) {
  throw new Error('usage: tursoWriter.mts <configPath> <reportPath>');
}

const config = JSON.parse(readFileSync(configPath, 'utf8')) as TursoWriterConfig;

const report: WriterReport = {
  writerId: config.writerId,
  mode: 'turso',
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
  acknowledged: [],
  errorSamples: [],
};

const acknowledged: AcknowledgedBatch[] = [];
let maxRssBytes = 0;

const sampleMemory = (): void => {
  maxRssBytes = Math.max(maxRssBytes, process.memoryUsage.rss());
};

/**
 * Writes the report through a temporary file and renames it into place. The
 * rename is atomic, so a SIGKILL landing mid-write leaves either the previous
 * report or the new one -- never a half-written file the parent cannot parse.
 */
const flushReport = (): void => {
  const cpu = process.cpuUsage();
  report.cpuUserMs = cpu.user / 1000;
  report.cpuSystemMs = cpu.system / 1000;
  report.maxRssBytes = maxRssBytes;
  report.finishedAtMs = Date.now();
  report.acknowledged = acknowledged;

  const temporaryPath = `${reportPath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(report));
  renameSync(temporaryPath, reportPath);
};

const { db, attempts: openAttempts } = await openTursoWithRetry(config.databasePath, {
  multiProcess: config.multiProcess,
  mvcc: config.mvcc,
  ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
});

report.openAttempts = openAttempts;

await ensureCommitLog(db);

for (const batch of config.plan) {
  sampleMemory();

  const crashAt = config.crash?.atBatchIndex === batch.index ? config.crash.point : undefined;

  // The report has to be on disk before an injected crash fires, otherwise a
  // SIGKILL would take the record of everything committed so far with it.
  if (crashAt !== undefined) {
    flushReport();
  }

  try {
    const result = await applyMutationBatch(db, config.tileTable, batch, {
      retryPolicy: DEFAULT_RETRY_POLICY,
      sleep: async (ms) => {
        await delay(ms);
      },
      random: Math.random,
      now: () => performance.now(),
      transactionMode: config.transactionMode,
      ...(crashAt !== undefined ? { crashAt } : {}),
    });

    report.batchesCommitted++;
    report.attempts += result.attempts;
    report.retries += result.retries;
    report.conflicts += result.conflicts;
    report.busyErrors += result.busyErrors;
    report.batchLatenciesMs.push(result.durationMs);
    report.tilesPut += batch.ops.filter((op) => op.kind === 'put').length;
    report.tilesDeleted += batch.ops.filter((op) => op.kind === 'delete').length;
    acknowledged.push({ batchId: batch.batchId, writerId: batch.writerId, index: batch.index, ops: batch.ops });
  } catch (error) {
    report.batchesFailed++;
    report.fatalErrors++;
    if ((report.errorSamples?.length ?? 0) < 5) {
      report.errorSamples?.push(error instanceof Error ? error.message : String(error));
    }
  }
}

sampleMemory();

if (config.checkpointOnClose) {
  if (config.crash?.point === 'during-checkpoint') {
    flushReport();
    void checkpoint(db);
    killSelf('during-checkpoint');
  }
  await checkpoint(db);
}

await db.close();
flushReport();
