import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUSY_TIMEOUT_MS } from './retry.mts';
import type { CrashPoint, WriterMode, WriterPlan, WriterReport } from './types.mts';
import type { TransactionMode } from './turso.mts';

const WORKERS_DIRECTORY = fileURLToPath(new URL('../workers/', import.meta.url));

const WORKER_SCRIPTS: Record<WriterMode, string> = {
  turso: join(WORKERS_DIRECTORY, 'tursoWriter.mts'),
  'sqlite-control': join(WORKERS_DIRECTORY, 'sqliteControlWriter.mts'),
};

export interface WriterCrash {
  writerId: number;
  point: CrashPoint;
  atBatchIndex: number;
}

export interface FleetOptions {
  mode: WriterMode;
  databasePath: string;
  tileTable: string;
  plans: WriterPlan[];
  workDirectory: string;
  /** Turso only. */
  multiProcess?: boolean;
  mvcc?: boolean;
  transactionMode?: TransactionMode;
  /** Turso's lock wait; defaults to DEFAULT_BUSY_TIMEOUT_MS. */
  timeoutMs?: number;
  checkpointOnClose?: boolean;
  /** The control's equivalent lock wait; defaults to the same value. */
  busyTimeoutMs?: number;
  crashes?: WriterCrash[];
}

export interface WriterExit {
  writerId: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** Set when the process could not be spawned at all. */
  spawnError?: string;
}

/** A writer killed before it flushed leaves no report; that is data, not an error. */
const readReport = (reportPath: string): WriterReport | undefined => {
  if (!existsSync(reportPath)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(reportPath, 'utf8')) as WriterReport;
  } catch {
    return undefined;
  }
};

export interface FleetOutcome {
  reports: WriterReport[];
  exits: WriterExit[];
  wallClockMs: number;
}

/**
 * Runs one writer per plan as a separate OS process and waits for all of them.
 *
 * A writer that is killed mid-run still contributes whatever report it managed
 * to flush, which is what the recovery gate inspects.
 */
export const runFleet = async (options: FleetOptions): Promise<FleetOutcome> => {
  const { mode, databasePath, tileTable, plans, workDirectory } = options;
  mkdirSync(workDirectory, { recursive: true });

  const startedAt = performance.now();

  const runs = plans.map(async (plan) => {
    const crash = options.crashes?.find((candidate) => candidate.writerId === plan.writerId);
    const configPath = join(workDirectory, `writer-${plan.writerId}.config.json`);
    const reportPath = join(workDirectory, `writer-${plan.writerId}.report.json`);

    writeFileSync(
      configPath,
      JSON.stringify({
        writerId: plan.writerId,
        mode,
        databasePath,
        tileTable,
        plan: plan.batches,
        multiProcess: options.multiProcess ?? true,
        mvcc: options.mvcc ?? false,
        transactionMode: options.transactionMode ?? 'immediate',
        timeoutMs: options.timeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
        checkpointOnClose: options.checkpointOnClose ?? true,
        busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
        ...(crash !== undefined ? { crash: { point: crash.point, atBatchIndex: crash.atBatchIndex } } : {}),
      })
    );

    const exit = await new Promise<WriterExit>((resolve) => {
      const child = spawn(process.execPath, [WORKER_SCRIPTS[mode], configPath, reportPath], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      let spawnError: string | undefined;

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Without this the process failing to start -- EAGAIN when the machine is
      // out of process slots, say -- would surface later as a confusing missing
      // table rather than as the spawn failure it is.
      child.on('error', (error) => {
        spawnError = error.message;
      });

      child.on('close', (code, signal) => {
        resolve({ writerId: plan.writerId, code, signal, stderr: stderr.slice(0, 2000), ...(spawnError === undefined ? {} : { spawnError }) });
      });
    });

    return { exit, report: readReport(reportPath) };
  });

  const results = await Promise.all(runs);

  return {
    reports: results.flatMap((result) => (result.report === undefined ? [] : [result.report])),
    exits: results.map((result) => result.exit),
    wallClockMs: performance.now() - startedAt,
  };
};
