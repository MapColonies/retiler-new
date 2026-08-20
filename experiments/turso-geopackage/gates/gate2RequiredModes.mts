import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, rollUp } from '../lib/report.mts';
import { buildWorkloadPlan } from '../lib/workload.mts';
import { createGeoPackage } from '../lib/geopackage.mts';
import { runFleet } from '../lib/fleet.mts';
import { DEFAULT_BUSY_TIMEOUT_MS } from '../lib/retry.mts';
import { journalMode, openTurso, SIDECAR_SUFFIXES } from '../lib/turso.mts';
import type { GateCheck, GateResult } from '../lib/types.mts';
import type { GateContext } from './context.mts';

interface ModeProbe {
  options: string;
  opened: boolean;
  journalMode?: string;
  beginConcurrent: 'accepted' | 'rejected' | 'not attempted';
  error?: string;
}

const freshPath = (directory: string, name: string): string => {
  const path = join(directory, name);
  for (const suffix of ['', ...SIDECAR_SUFFIXES]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
  return path;
};

/**
 * Opens a database with a given combination of experimental options and reports
 * whether `BEGIN CONCURRENT` -- the transaction mode concurrent writes need --
 * is accepted alongside it.
 */
const probeMode = async (directory: string, name: string, options: { multiProcess: boolean; mvcc: boolean }): Promise<ModeProbe> => {
  const label = `multiProcess=${String(options.multiProcess)} mvcc=${String(options.mvcc)}`;

  try {
    const db = await openTurso(freshPath(directory, name), options);

    try {
      await db.exec('CREATE TABLE IF NOT EXISTS probe (a INTEGER PRIMARY KEY, b BLOB)');
      const mode = await journalMode(db);

      try {
        await db.exec('BEGIN CONCURRENT');
        await db.exec('COMMIT');
        return { options: label, opened: true, journalMode: mode, beginConcurrent: 'accepted' };
      } catch (error) {
        return {
          options: label,
          opened: true,
          journalMode: mode,
          beginConcurrent: 'rejected',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } finally {
      await db.close();
    }
  } catch (error) {
    return { options: label, opened: false, beginConcurrent: 'not attempted', error: error instanceof Error ? error.message : String(error) };
  }
};

const OPEN_PROBE = fileURLToPath(new URL('../workers/openProbe.mts', import.meta.url));

interface OpenRace {
  writers: number;
  trials: number;
  attempted: number;
  failed: number;
  messages: string[];
}

/**
 * Starts `writers` processes at the same instant, several times over, and counts
 * how many are refused at the open. Each trial gets its own file, so nothing
 * carries over between them.
 */
const measureOpenRace = async (context: GateContext, writers: number, trials: number): Promise<OpenRace> => {
  const messages = new Set<string>();
  let failed = 0;

  for (let trial = 0; trial < trials; trial++) {
    const databasePath = freshPath(context.scratchDirectory, `gate2-openrace-${writers}-${trial}.gpkg`);
    createGeoPackage({ databasePath, tileTable: 'tiles', maxZoomLevel: 2 });

    const codes = await Promise.all(
      Array.from(
        { length: writers },
        async () =>
          new Promise<number>((resolve) => {
            const child = spawn(process.execPath, [OPEN_PROBE, databasePath, String(DEFAULT_BUSY_TIMEOUT_MS)], {
              stdio: ['ignore', 'ignore', 'pipe'],
            });
            let stderr = '';
            child.stderr.on('data', (chunk: Buffer) => {
              stderr += chunk.toString();
            });
            child.on('close', (code) => {
              if (code !== 0) {
                messages.add((/Locking error: ([^\n\]]+)/u.exec(stderr)?.[1] ?? stderr).slice(0, 200));
              }
              resolve(code ?? 0);
            });
          })
      )
    );

    failed += codes.filter((code) => code !== 0).length;
  }

  return { writers, trials, attempted: writers * trials, failed, messages: [...messages] };
};

/**
 * Gate 2 -- can the published JavaScript interface alone put two independent
 * processes on one file *and* give each of them concurrent transactions?
 */
export const runGate2 = async (context: GateContext): Promise<GateResult> => {
  const startedAt = performance.now();
  const checks: GateCheck[] = [];

  const probes = {
    plain: await probeMode(context.scratchDirectory, 'gate2-plain.db', { multiProcess: false, mvcc: false }),
    multiProcess: await probeMode(context.scratchDirectory, 'gate2-mp.db', { multiProcess: true, mvcc: false }),
    mvcc: await probeMode(context.scratchDirectory, 'gate2-mvcc.db', { multiProcess: false, mvcc: true }),
    both: await probeMode(context.scratchDirectory, 'gate2-both.db', { multiProcess: true, mvcc: true }),
  };

  checks.push(
    probes.multiProcess.opened
      ? check(
          'multi-process mode is reachable from the published JS API',
          'pass',
          "opened with experimental: ['multiprocess_wal'], so no Turso CLI flag or custom binding is required",
          probes.multiProcess
        )
      : check(
          'multi-process mode is reachable from the published JS API',
          'fail',
          'the published API could not open the file in multi-process mode',
          probes.multiProcess
        )
  );

  checks.push(
    probes.mvcc.beginConcurrent === 'accepted'
      ? check('concurrent transactions are reachable', 'pass', 'BEGIN CONCURRENT is accepted once the journal is switched to MVCC', probes.mvcc)
      : check('concurrent transactions are reachable', 'fail', 'BEGIN CONCURRENT was rejected even with MVCC enabled', probes.mvcc)
  );

  // This is the composition the whole design depends on.
  checks.push(
    probes.both.opened && probes.both.beginConcurrent === 'accepted'
      ? check(
          'multi-process and concurrent modes compose',
          'pass',
          'a single connection had both multi-process WAL and BEGIN CONCURRENT',
          probes.both
        )
      : check(
          'multi-process and concurrent modes compose',
          'fail',
          probes.both.opened
            ? `multi-process WAL and MVCC are mutually exclusive: ${probes.both.error ?? 'BEGIN CONCURRENT rejected'}`
            : `enabling both at once failed: ${probes.both.error ?? 'unknown'}`,
          probes.both
        )
  );

  // Opening is its own hazard: several pods starting together can have one
  // refused outright, and DatabaseOpts.timeout does not cover that window.
  const openRaces = context.profile === 'full' ? [2, 4, 8] : [8];
  const raceResults: OpenRace[] = [];
  for (const writers of openRaces) {
    raceResults.push(await measureOpenRace(context, writers, 10));
  }
  const racedOpens = raceResults.reduce((sum, race) => sum + race.failed, 0);

  checks.push(
    racedOpens === 0
      ? check(
          'simultaneous opens all succeed',
          'pass',
          `no open was refused across ${raceResults.reduce((sum, race) => sum + race.attempted, 0)} simultaneous opens`,
          raceResults
        )
      : check(
          'simultaneous opens all succeed',
          'fail',
          `${racedOpens} of ${raceResults.reduce((sum, race) => sum + race.attempted, 0)} simultaneous opens were refused outright, so a pod can fail to attach to the shared file at startup and must retry the open itself`,
          raceResults
        )
  );

  // Two genuinely independent OS processes on one file. Concurrency inside a
  // single process would prove nothing about separate pods.
  const databasePath = freshPath(context.scratchDirectory, 'gate2-crossprocess.gpkg');
  createGeoPackage({ databasePath, tileTable: 'tiles', maxZoomLevel: 4 });

  const plans = buildWorkloadPlan({
    writers: 2,
    batchesPerWriter: 4,
    metatile: 2,
    deleteRatio: 0,
    collision: 'disjoint',
    zoomLevel: 4,
    seed: 2,
  });

  const outcome = await runFleet({
    mode: 'turso',
    databasePath,
    tileTable: 'tiles',
    plans,
    workDirectory: join(context.scratchDirectory, 'gate2-fleet'),
    multiProcess: true,
    transactionMode: 'immediate',
  });

  const committed = outcome.reports.reduce((sum, report) => sum + report.batchesCommitted, 0);
  const writersThatCommitted = outcome.reports.filter((report) => report.batchesCommitted > 0).length;
  const openAttempts = outcome.reports.map((report) => report.openAttempts ?? 1);

  checks.push(
    writersThatCommitted === 2 && committed === 8
      ? check(
          'two independent processes write to one file',
          'pass',
          `both processes committed, ${committed} of 8 batches in total (opens needed ${openAttempts.join(' and ')} attempts)`,
          outcome.exits
        )
      : check(
          'two independent processes write to one file',
          committed > 0 ? 'fail' : 'fail',
          `${writersThatCommitted} of 2 processes committed anything and ${committed} of 8 batches landed`,
          {
            exits: outcome.exits,
            reports: outcome.reports.map((report) => ({
              writerId: report.writerId,
              committed: report.batchesCommitted,
              failed: report.batchesFailed,
              errors: report.errorSamples,
            })),
          }
        )
  );

  const status = rollUp(checks);

  return {
    id: 2,
    title: 'Required modes are exposed',
    status,
    summary:
      status === 'pass'
        ? 'Multi-process and concurrent transaction modes are both reachable and compose.'
        : 'Multi-process WAL and MVCC are exposed but mutually exclusive, so independent processes cannot hold concurrent transactions.',
    checks,
    measurements: {
      probes,
      openRaces: raceResults,
      crossProcess: { committed, writersThatCommitted, openAttempts, wallClockMs: outcome.wallClockMs },
    },
    durationMs: performance.now() - startedAt,
  };
};
