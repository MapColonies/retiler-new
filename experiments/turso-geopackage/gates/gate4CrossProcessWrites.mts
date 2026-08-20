import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runFleet } from '../lib/fleet.mts';
import { createGeoPackage } from '../lib/geopackage.mts';
import { aggregate } from '../lib/metrics.mts';
import { check, rollUp } from '../lib/report.mts';
import { fileFootprint, SIDECAR_SUFFIXES } from '../lib/turso.mts';
import { validateWithSqlite } from '../lib/validate.mts';
import { verifyDatabase } from '../lib/verify.mts';
import { buildWorkloadPlan } from '../lib/workload.mts';
import type { CollisionMode, GateCheck, GateResult, RunTotals, WriterMode } from '../lib/types.mts';
import type { GateContext } from './context.mts';

const TILE_TABLE = 'tiles';
const ZOOM_LEVEL = 10;

/**
 * Repetitions of each throughput comparison.
 *
 * A single sample is worthless here: across three earlier full runs the same
 * comparison produced ratios between 0.53x and 1.84x purely from machine noise.
 * The verdict uses the median of the repetitions, and every sample is recorded
 * so the spread is visible rather than hidden behind one number.
 */
const THROUGHPUT_REPEATS = 3;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2 : (sorted[middle] as number);
};

interface Scenario {
  writers: number;
  collision: CollisionMode;
  metatile: number;
  batchesPerWriter: number;
}

export interface ScenarioOutcome {
  scenario: Scenario;
  mode: WriterMode;
  /** Writers that produced a report, against the number started. */
  writersReported: number;
  /** Per-writer resource use, which fleet totals would otherwise hide. */
  perWriter: { writerId: number; cpuUserMs: number; cpuSystemMs: number; maxRssBytes: number; batchesCommitted: number; openAttempts: number }[];
  exits: { writerId: number; code: number | null; signal: string | null; spawnError?: string; stderr?: string }[];
  totals: RunTotals;
  verification: Awaited<ReturnType<typeof verifyDatabase>>;
  integrityCheck: string;
  footprint: Record<string, number>;
  fleetWallClockMs: number;
}

const scenarios = (profile: GateContext['profile']): Scenario[] => {
  const writerCounts = [2, 4, 8];
  const collisions: CollisionMode[] = profile === 'full' ? ['disjoint', 'moderate', 'full'] : ['disjoint', 'full'];
  const metatiles = profile === 'full' ? [2, 4] : [2];
  const batchesPerWriter = profile === 'full' ? 24 : 8;

  return writerCounts.flatMap((writers) =>
    collisions.flatMap((collision) => metatiles.map((metatile) => ({ writers, collision, metatile, batchesPerWriter })))
  );
};

const runScenario = async (context: GateContext, scenario: Scenario, mode: WriterMode, repetition = 0): Promise<ScenarioOutcome> => {
  const name = `g4-${mode}-w${scenario.writers}-${scenario.collision}-m${scenario.metatile}-r${repetition}`;
  const databasePath = join(context.scratchDirectory, `${name}.gpkg`);

  for (const suffix of ['', ...SIDECAR_SUFFIXES]) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
  createGeoPackage({ databasePath, tileTable: TILE_TABLE, maxZoomLevel: ZOOM_LEVEL });

  const plans = buildWorkloadPlan({
    writers: scenario.writers,
    batchesPerWriter: scenario.batchesPerWriter,
    metatile: scenario.metatile,
    deleteRatio: 0.25,
    collision: scenario.collision,
    zoomLevel: ZOOM_LEVEL,
    seed: 4,
  });

  const outcome = await runFleet({
    mode,
    databasePath,
    tileTable: TILE_TABLE,
    plans,
    workDirectory: join(context.scratchDirectory, name),
    multiProcess: true,
    transactionMode: 'immediate',
  });

  return {
    scenario,
    mode,
    writersReported: outcome.reports.length,
    perWriter: outcome.reports.map((report) => ({
      writerId: report.writerId,
      cpuUserMs: report.cpuUserMs,
      cpuSystemMs: report.cpuSystemMs,
      maxRssBytes: report.maxRssBytes,
      batchesCommitted: report.batchesCommitted,
      openAttempts: report.openAttempts ?? 1,
    })),
    exits: outcome.exits
      .filter((exit) => exit.code !== 0 || exit.spawnError !== undefined)
      .map((exit) => ({
        writerId: exit.writerId,
        code: exit.code,
        signal: exit.signal,
        ...(exit.spawnError === undefined ? {} : { spawnError: exit.spawnError }),
        stderr: exit.stderr.slice(-400),
      })),
    totals: aggregate(outcome.reports),
    verification: await verifyDatabase(databasePath, TILE_TABLE, outcome.reports),
    integrityCheck: validateWithSqlite(databasePath, TILE_TABLE).integrityCheck,
    footprint: fileFootprint(databasePath),
    fleetWallClockMs: outcome.wallClockMs,
  };
};

/**
 * Gate 4 -- do independent writer processes sharing one file stay correct, and
 * is there any throughput benefit over a serialized SQLite writer?
 */
export const runGate4 = async (context: GateContext): Promise<GateResult> => {
  const startedAt = performance.now();
  const checks: GateCheck[] = [];

  const matrix = scenarios(context.profile);
  const tursoOutcomes: ScenarioOutcome[] = [];
  const controlOutcomes: ScenarioOutcome[] = [];

  for (const scenario of matrix) {
    tursoOutcomes.push(await runScenario(context, scenario, 'turso'));
  }

  // The comparison only needs the writer counts, not every collision shape, to
  // answer "is Turso actually faster than serialized SQLite" -- but it does need
  // repetition, because one sample of it is noise.
  const comparisonScenarios = matrix.filter((candidate) => candidate.collision === 'disjoint' && candidate.metatile === matrix[0]?.metatile);

  const samples: { writers: number; turso: number[]; control: number[] }[] = [];

  for (const scenario of comparisonScenarios) {
    const turso: number[] = [];
    const control: number[] = [];

    for (let repetition = 0; repetition < THROUGHPUT_REPEATS; repetition++) {
      const tursoRun = await runScenario(context, scenario, 'turso', repetition + 1);
      const controlRun = await runScenario(context, scenario, 'sqlite-control', repetition + 1);
      turso.push(tursoRun.totals.tilesPerSecond);
      control.push(controlRun.totals.tilesPerSecond);
      controlOutcomes.push(controlRun);
    }

    samples.push({ writers: scenario.writers, turso, control });
  }

  const incomplete = tursoOutcomes.filter((outcome) => outcome.writersReported < outcome.scenario.writers);

  // A writer can lose the race to initialise the shared WAL coordination file
  // and be told the database is corrupt. The state is transient, but the error
  // is indistinguishable from real corruption, so it cannot be safely retried --
  // the process just dies, and in a cluster it would crash-loop.
  const coordinationRace = incomplete.filter((outcome) => outcome.exits.some((exit) => (exit.stderr ?? '').includes('shared WAL coordination file')));

  checks.push(
    incomplete.length === 0
      ? check('every writer process ran to completion', 'pass', `all writers in all ${tursoOutcomes.length} scenarios started and reported`)
      : check(
          'every writer process ran to completion',
          'fail',
          coordinationRace.length > 0
            ? `${incomplete.length} scenarios lost a writer, ${coordinationRace.length} of them to a startup race on the shared WAL coordination file that Turso reports as "Corrupt database" -- a transient condition wearing a fatal error's name, which no adapter can safely retry`
            : `${incomplete.length} scenarios had writers that never reported, so their results are incomplete`,
          incomplete.map((outcome) => ({ scenario: outcome.scenario, reported: outcome.writersReported, exits: outcome.exits }))
        )
  );

  const lostWork = tursoOutcomes.filter((outcome) => outcome.verification.lostAcknowledged.length > 0);
  checks.push(
    lostWork.length === 0
      ? check('no acknowledged mutation disappears', 'pass', 'every batch a writer was told had committed is present in the commit log after reopen')
      : check(
          'no acknowledged mutation disappears',
          'fail',
          `${lostWork.length} scenarios lost acknowledged batches`,
          lostWork.map((outcome) => ({ scenario: outcome.scenario, lost: outcome.verification.lostAcknowledged.slice(0, 10) }))
        )
  );

  const wrongWinner = tursoOutcomes.filter((outcome) => !outcome.verification.lastWinsHolds);
  checks.push(
    wrongWinner.length === 0
      ? check(
          'latest successful commit wins at every coordinate',
          'pass',
          'the stored bytes at every coordinate match the last commit for it in commit order'
        )
      : check(
          'latest successful commit wins at every coordinate',
          'fail',
          `${wrongWinner.length} scenarios ended with tiles that do not match the last commit`,
          wrongWinner.map((outcome) => ({
            scenario: outcome.scenario,
            stale: outcome.verification.staleTiles.slice(0, 5),
            missing: outcome.verification.missingTiles.slice(0, 5),
            undeleted: outcome.verification.undeletedTiles.slice(0, 5),
          }))
        )
  );

  const corrupted = tursoOutcomes.filter((outcome) => outcome.integrityCheck !== 'ok');
  checks.push(
    corrupted.length === 0
      ? check('the shared file stays valid', 'pass', 'ordinary SQLite reports integrity_check ok after every scenario')
      : check(
          'the shared file stays valid',
          'fail',
          `${corrupted.length} scenarios left a file ordinary SQLite rejects`,
          corrupted.map((outcome) => ({ scenario: outcome.scenario, integrityCheck: outcome.integrityCheck }))
        )
  );

  const failedBatches = tursoOutcomes.filter((outcome) => outcome.totals.batchesFailed > 0);
  checks.push(
    failedBatches.length === 0
      ? check('conflicts are retryable rather than fatal', 'pass', 'bounded jittered backoff absorbed all contention; no batch exhausted its retries')
      : check(
          'conflicts are retryable rather than fatal',
          'fail',
          `${failedBatches.length} scenarios had batches that never committed, so contention is not fully absorbed by retrying`,
          failedBatches.map((outcome) => ({
            scenario: outcome.scenario,
            failed: outcome.totals.batchesFailed,
            conflicts: outcome.totals.conflicts,
            samples: outcome.totals.fatalErrors,
          }))
        )
  );

  // The plan is explicit that overlapping transactions are not the point:
  // Turso has to beat a serialized SQLite writer end to end.
  const comparison = samples.map((sample) => {
    const tursoMedian = median(sample.turso);
    const controlMedian = median(sample.control);
    const ratios = sample.turso.map((value, index) => ((sample.control[index] as number) > 0 ? value / (sample.control[index] as number) : 0));

    return {
      writers: sample.writers,
      repeats: THROUGHPUT_REPEATS,
      tursoTilesPerSecond: sample.turso,
      controlTilesPerSecond: sample.control,
      medianSpeedup: controlMedian > 0 ? tursoMedian / controlMedian : 0,
      perRunSpeedup: ratios,
      speedupRange: [Math.min(...ratios), Math.max(...ratios)],
    };
  });

  const beatsControl = comparison.filter((entry) => entry.medianSpeedup > 1);
  // A writer count only counts as decided when every repetition agrees; a set
  // of samples that straddles 1.0 says the machine is too noisy to call it.
  const inconclusive = comparison.filter((entry) => (entry.speedupRange[0] as number) < 1 && (entry.speedupRange[1] as number) > 1);

  checks.push(
    comparison.length === 0
      ? check('throughput beats a serialized SQLite writer', 'not-run', 'no control run to compare against')
      : inconclusive.length > 0
        ? check(
            'throughput beats a serialized SQLite writer',
            'not-run',
            `inconclusive on this host: ${inconclusive.length} of ${comparison.length} writer counts had repetitions on both sides of parity (${comparison
              .map(
                (entry) =>
                  `${entry.writers} writers: median ${entry.medianSpeedup.toFixed(2)}x, range ${(entry.speedupRange[0] as number).toFixed(2)}-${(entry.speedupRange[1] as number).toFixed(2)}x`
              )
              .join('; ')}). Re-run on a quiet machine before drawing a conclusion.`,
            comparison
          )
        : check(
            'throughput beats a serialized SQLite writer',
            beatsControl.length === comparison.length ? 'pass' : 'fail',
            `Turso's median throughput beat serialized SQLite at ${beatsControl.length} of ${comparison.length} writer counts (${comparison
              .map((entry) => `${entry.writers} writers: ${entry.medianSpeedup.toFixed(2)}x`)
              .join(', ')})`,
            comparison
          )
  );

  const status = rollUp(checks);

  return {
    id: 4,
    title: 'Cross-process concurrent writes',
    status,
    summary:
      status === 'pass'
        ? 'Independent processes write the shared file correctly and faster than serialized SQLite.'
        : 'Independent processes share the file, but the concurrency and throughput criteria are not met.',
    checks,
    measurements: {
      note: 'Local filesystem only. The OpenShift RWX StorageClass has not been exercised; see gate 4 notes in the README.',
      turso: tursoOutcomes.map((outcome) => ({
        scenario: outcome.scenario,
        writersReported: outcome.writersReported,
        perWriter: outcome.perWriter,
        exits: outcome.exits,
        totals: outcome.totals,
        verification: {
          ...outcome.verification,
          staleTiles: outcome.verification.staleTiles.length,
          missingTiles: outcome.verification.missingTiles.length,
          undeletedTiles: outcome.verification.undeletedTiles.length,
          orphanTiles: outcome.verification.orphanTiles.length,
          lostAcknowledged: outcome.verification.lostAcknowledged.length,
          unacknowledgedCommits: outcome.verification.unacknowledgedCommits.length,
        },
        footprint: outcome.footprint,
      })),
      control: controlOutcomes.map((outcome) => ({ scenario: outcome.scenario, totals: outcome.totals })),
      throughputSamples: samples,
      comparison,
    },
    durationMs: performance.now() - startedAt,
  };
};
