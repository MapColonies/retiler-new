import { statSync } from 'node:fs';
import { connect, type Database } from '@tursodatabase/database';
import { toGeoPackageCoordinate } from './coordinates.mts';
import { tilePayload } from './payload.mts';
import { classifyError, DEFAULT_RETRY_POLICY, withRetry, type RetryPolicy } from './retry.mts';
import type { BatchPlan, CrashPoint } from './types.mts';

/**
 * Sidecar files an embedded engine may leave beside the main database. A
 * finalized GeoPackage must not depend on any of them.
 */
export const SIDECAR_SUFFIXES = ['-wal', '-shm', '.tshm', '-info', '-journal'] as const;

export const COMMIT_LOG_TABLE = '_experiment_commit_log';

/**
 * Records, inside each mutation transaction, which batch committed and in what
 * order. Written atomically with the tiles, so its presence is the marker that
 * proves a batch landed whole. `commit_seq` is a global autoincrement, which is
 * only a valid commit order because writers serialize -- revisit it if Turso
 * ever admits genuinely concurrent commits.
 */
export const COMMIT_LOG_DDL = `CREATE TABLE IF NOT EXISTS ${COMMIT_LOG_TABLE} (
  commit_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  writer_id INTEGER NOT NULL,
  batch_index INTEGER NOT NULL,
  ops_json TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL
)`;

/** How a batch transaction is opened. */
export type TransactionMode = 'immediate' | 'concurrent' | 'exclusive' | 'deferred';

export interface OpenOptions {
  /** Enables the experimental multi-process WAL required for RWX sharing. */
  multiProcess?: boolean;
  /** Switches the journal to MVCC, which is what `BEGIN CONCURRENT` needs. */
  mvcc?: boolean;
  timeoutMs?: number;
}

export const openTurso = async (databasePath: string, options: OpenOptions = {}): Promise<Database> => {
  const db = await connect(databasePath, {
    ...(options.multiProcess === true ? { experimental: ['multiprocess_wal' as const] } : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  });

  if (options.mvcc === true) {
    await db.pragma('journal_mode=mvcc', {});
  }

  return db;
};

export interface OpenOutcome {
  db: Database;
  attempts: number;
}

/**
 * Opens the database, retrying the contended-open race that multi-process WAL
 * exposes. Gate 2 measures that race with a bare `openTurso`; everything that
 * merely needs a connection goes through here, as a real adapter would.
 */
export const openTursoWithRetry = async (
  databasePath: string,
  options: OpenOptions = {},
  policy: RetryPolicy = DEFAULT_RETRY_POLICY
): Promise<OpenOutcome> => {
  const outcome = await withRetry(async () => openTurso(databasePath, options), policy, {
    sleep: async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    random: Math.random,
  });

  return { db: outcome.value, attempts: outcome.attempts };
};

/**
 * Creates the commit-log table, retrying contention.
 *
 * Every writer runs this at startup, so they all race for the write lock on the
 * very same statement. Without a retry the loser dies uncaught before its first
 * batch -- and if every writer loses, the table never appears at all and the
 * whole scenario fails later with a baffling "no such table".
 */
export const ensureCommitLog = async (db: Database, policy: RetryPolicy = DEFAULT_RETRY_POLICY): Promise<number> => {
  const outcome = await withRetry(async () => db.exec(COMMIT_LOG_DDL), policy, {
    sleep: async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    random: Math.random,
  });

  return outcome.attempts;
};

export const journalMode = async (db: Database): Promise<string> => {
  const rows = (await db.pragma('journal_mode', {})) as { journal_mode?: string }[];
  return rows[0]?.journal_mode ?? 'unknown';
};

/** Sizes of the main database and every sidecar that exists, in bytes. */
export const fileFootprint = (databasePath: string): Record<string, number> => {
  const footprint: Record<string, number> = {};

  for (const suffix of ['', ...SIDECAR_SUFFIXES]) {
    try {
      footprint[suffix === '' ? 'main' : suffix] = statSync(`${databasePath}${suffix}`).size;
    } catch {
      // A sidecar that does not exist is the expected outcome after checkpoint.
    }
  }

  return footprint;
};

export interface ApplyBatchDeps {
  retryPolicy: RetryPolicy;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => number;
  transactionMode: TransactionMode;
  /** Kills the process at the given point, for the recovery gate. */
  crashAt?: CrashPoint;
}

export interface ApplyBatchResult {
  attempts: number;
  retries: number;
  conflicts: number;
  busyErrors: number;
  durationMs: number;
}

const isBusy = (error: unknown): boolean => error instanceof Error && /locked|busy/iu.test(error.message);

/**
 * Terminates the process the way a killed pod would be, with no unwinding and
 * no chance to flush.
 *
 * `process.kill` on self is delivered asynchronously, so execution can continue
 * past it -- often far enough for the throw below to win the race and exit the
 * process normally with code 1, which would silently turn a crash test into a
 * no-op. Blocking the thread until the signal lands makes the kill certain.
 */
export const killSelf = (reason: string): never => {
  process.kill(process.pid, 'SIGKILL');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  throw new Error(`SIGKILL at ${reason} was not delivered`);
};

const die = (point: CrashPoint): never => killSelf(point);

/**
 * Applies one metatile's puts and deletes in a single transaction, retrying
 * retryable contention with bounded jittered backoff.
 *
 * The whole batch -- tiles and the commit-log row -- is all-or-nothing, which
 * is the atomicity guarantee the Retiler integration would depend on.
 */
export const applyMutationBatch = async (db: Database, tileTable: string, batch: BatchPlan, deps: ApplyBatchDeps): Promise<ApplyBatchResult> => {
  const puts = batch.ops.filter((op) => op.kind === 'put');
  const deletes = batch.ops.filter((op) => op.kind === 'delete');
  const payload = await tilePayload({ writerId: batch.writerId, batchIndex: batch.index });

  let conflicts = 0;
  let busyErrors = 0;

  const startedAt = deps.now();

  const runBatch = async (): Promise<void> => {
    if (deps.crashAt === 'before-begin') {
      die('before-begin');
    }

    const transaction = db.transactionAsync(async (tx) => {
      for (const op of puts) {
        const { zoomLevel, tileColumn, tileRow } = toGeoPackageCoordinate({ ...op, metatile: 1 });
        await tx.run(
          `INSERT INTO "${tileTable}" (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)
           ON CONFLICT (zoom_level, tile_column, tile_row) DO UPDATE SET tile_data = excluded.tile_data`,
          zoomLevel,
          tileColumn,
          tileRow,
          payload
        );

        if (deps.crashAt === 'mid-statements') {
          die('mid-statements');
        }
      }

      for (const op of deletes) {
        const { zoomLevel, tileColumn, tileRow } = toGeoPackageCoordinate({ ...op, metatile: 1 });
        await tx.run(`DELETE FROM "${tileTable}" WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?`, zoomLevel, tileColumn, tileRow);
      }

      await tx.run(
        `INSERT INTO ${COMMIT_LOG_TABLE} (batch_id, writer_id, batch_index, ops_json, committed_at_ms) VALUES (?, ?, ?, ?, ?)`,
        batch.batchId,
        batch.writerId,
        batch.index,
        JSON.stringify(batch.ops),
        deps.now()
      );

      if (deps.crashAt === 'before-commit') {
        die('before-commit');
      }
    });

    const modes = {
      immediate: transaction.immediate,
      concurrent: transaction.concurrent,
      exclusive: transaction.exclusive,
      deferred: transaction.deferred,
    } as const;

    await modes[deps.transactionMode]();

    if (deps.crashAt === 'after-commit') {
      die('after-commit');
    }
  };

  const outcome = await withRetry(
    async () => {
      try {
        await runBatch();
      } catch (error) {
        if (classifyError(error) === 'retryable') {
          conflicts++;
          if (isBusy(error)) {
            busyErrors++;
          }
        }
        throw error;
      }
    },
    deps.retryPolicy,
    { sleep: deps.sleep, random: deps.random }
  );

  return { attempts: outcome.attempts, retries: outcome.retries, conflicts, busyErrors, durationMs: deps.now() - startedAt };
};

/** Folds WAL or MVCC state back into the main file so it can stand alone. */
export const checkpoint = async (db: Database): Promise<unknown> => db.pragma('wal_checkpoint(TRUNCATE)', {});
