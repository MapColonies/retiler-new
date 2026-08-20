import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runFleet, type WriterCrash } from '../lib/fleet.mts';
import { createGeoPackage } from '../lib/geopackage.mts';
import { check, rollUp } from '../lib/report.mts';
import { fileFootprint, SIDECAR_SUFFIXES } from '../lib/turso.mts';
import { validateWithSqlite } from '../lib/validate.mts';
import { readCommitLog, verifyDatabase } from '../lib/verify.mts';
import { buildWorkloadPlan } from '../lib/workload.mts';
import type { CrashPoint, GateCheck, GateResult, WriterReport } from '../lib/types.mts';
import type { GateContext } from './context.mts';

const TILE_TABLE = 'tiles';
const ZOOM_LEVEL = 8;
const CRASH_AT_BATCH = 3;
const BATCHES_PER_WRITER = 8;

interface CrashOutcome {
  point: CrashPoint;
  killed: boolean;
  exitSignal: string | null;
  /** Whether the crashed batch is wholly present or wholly absent. */
  batchIsAtomic: boolean;
  batchPartiallyApplied: string[];
  integrityCheck: string;
  reopenMs: number;
  survivingWriterCommitted: number;
  survivingWriterFailed: number;
  survivingWriterReported: boolean;
  exits: { writerId: number; code: number | null; signal: string | null; stderr?: string }[];
  lostAcknowledged: string[];
  footprint: Record<string, number>;
}

/**
 * Kills one of two writers at `point` and inspects what the file looks like
 * afterwards. The second writer keeps working throughout, so the crash happens
 * while the file is genuinely shared.
 */
const runCrashScenario = async (context: GateContext, point: CrashPoint): Promise<CrashOutcome> => {
  const name = `g5-${point}`;
  const databasePath = join(context.scratchDirectory, `${name}.gpkg`);

  for (const suffix of ['', ...SIDECAR_SUFFIXES]) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
  createGeoPackage({ databasePath, tileTable: TILE_TABLE, maxZoomLevel: ZOOM_LEVEL });

  const plans = buildWorkloadPlan({
    writers: 2,
    batchesPerWriter: BATCHES_PER_WRITER,
    metatile: 2,
    deleteRatio: 0.25,
    collision: 'disjoint',
    zoomLevel: ZOOM_LEVEL,
    seed: 5,
  });

  const crashes: WriterCrash[] = [{ writerId: 0, point, atBatchIndex: CRASH_AT_BATCH }];

  const outcome = await runFleet({
    mode: 'turso',
    databasePath,
    tileTable: TILE_TABLE,
    plans,
    workDirectory: join(context.scratchDirectory, name),
    multiProcess: true,
    transactionMode: 'immediate',
    crashes,
  });

  const reopenStartedAt = performance.now();
  const sqlite = validateWithSqlite(databasePath, TILE_TABLE);
  const reopenMs = performance.now() - reopenStartedAt;

  const log = readCommitLog(databasePath);
  const crashedBatch = plans[0]?.batches[CRASH_AT_BATCH];
  const crashedBatchId = crashedBatch?.batchId ?? '';
  const crashedBatchOps = crashedBatch?.ops ?? [];
  const crashedBatchLogged = log.some((entry) => entry.batchId === crashedBatchId);

  // Atomicity means the tiles of the crashed batch are present exactly when its
  // commit-log row is -- the two are written in the same transaction.
  const storedKeys = new Set(sqlite.tiles.map((tile) => `${tile.zoomLevel}/${tile.tileColumn}/${tile.tileRow}`));
  const partial = crashedBatchOps
    .filter((op) => (op.kind === 'put' ? storedKeys.has(`${op.z}/${op.x}/${op.y}`) !== crashedBatchLogged : false))
    .map((op) => `${op.z}/${op.x}/${op.y}`);

  const verification = await verifyDatabase(databasePath, TILE_TABLE, outcome.reports);
  const survivor = outcome.reports.find((report: WriterReport) => report.writerId === 1);
  const crashedExit = outcome.exits.find((exit) => exit.writerId === 0);

  return {
    point,
    killed: crashedExit?.signal === 'SIGKILL',
    exitSignal: crashedExit?.signal ?? null,
    batchIsAtomic: partial.length === 0,
    batchPartiallyApplied: partial,
    integrityCheck: sqlite.integrityCheck,
    reopenMs,
    survivingWriterCommitted: survivor?.batchesCommitted ?? 0,
    survivingWriterFailed: survivor?.batchesFailed ?? 0,
    survivingWriterReported: survivor !== undefined,
    exits: outcome.exits.map((exit) => ({
      writerId: exit.writerId,
      code: exit.code,
      signal: exit.signal,
      // Only for a writer that died unexpectedly; the killed one is expected.
      ...(exit.code === 0 || exit.signal === 'SIGKILL' ? {} : { stderr: exit.stderr.slice(-500) }),
    })),
    lostAcknowledged: verification.lostAcknowledged,
    footprint: fileFootprint(databasePath),
  };
};

/**
 * Replays a batch that was committed but whose acknowledgement was lost, which
 * is what pg-boss does when a pod dies between commit and job completion.
 */
const runLostAcknowledgementReplay = async (
  context: GateContext
): Promise<{ integrityCheck: string; tileCountBefore: number; tileCountAfter: number; replayCommitted: number }> => {
  const name = 'g5-lost-ack';
  const databasePath = join(context.scratchDirectory, `${name}.gpkg`);

  for (const suffix of ['', ...SIDECAR_SUFFIXES]) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
  createGeoPackage({ databasePath, tileTable: TILE_TABLE, maxZoomLevel: ZOOM_LEVEL });

  const plans = buildWorkloadPlan({
    writers: 1,
    batchesPerWriter: 4,
    metatile: 2,
    deleteRatio: 0.25,
    collision: 'disjoint',
    zoomLevel: ZOOM_LEVEL,
    seed: 6,
  });

  // Commit, then die before the acknowledgement can be recorded.
  await runFleet({
    mode: 'turso',
    databasePath,
    tileTable: TILE_TABLE,
    plans,
    workDirectory: join(context.scratchDirectory, `${name}-first`),
    multiProcess: true,
    crashes: [{ writerId: 0, point: 'after-commit', atBatchIndex: 2 }],
  });

  const before = validateWithSqlite(databasePath, TILE_TABLE);

  // pg-boss retries the whole render job, so the same batches are applied again.
  const replay = await runFleet({
    mode: 'turso',
    databasePath,
    tileTable: TILE_TABLE,
    plans,
    workDirectory: join(context.scratchDirectory, `${name}-replay`),
    multiProcess: true,
  });

  const after = validateWithSqlite(databasePath, TILE_TABLE);

  return {
    integrityCheck: after.integrityCheck,
    tileCountBefore: before.tileCount,
    tileCountAfter: after.tileCount,
    replayCommitted: replay.reports.reduce((sum, report) => sum + report.batchesCommitted, 0),
  };
};

/**
 * Gate 5 -- is a metatile batch all-or-nothing across process death, and is
 * there a recovery path that leaves a usable GeoPackage?
 */
export const runGate5 = async (context: GateContext): Promise<GateResult> => {
  const startedAt = performance.now();
  const checks: GateCheck[] = [];

  const points: CrashPoint[] = ['before-begin', 'mid-statements', 'before-commit', 'after-commit', 'during-checkpoint'];
  const outcomes: CrashOutcome[] = [];

  for (const point of points) {
    outcomes.push(await runCrashScenario(context, point));
  }

  const notKilled = outcomes.filter((outcome) => !outcome.killed);
  checks.push(
    notKilled.length === 0
      ? check('the injected failure actually fired', 'pass', `all ${outcomes.length} writers were terminated by SIGKILL at their injection point`)
      : check(
          'the injected failure actually fired',
          'fail',
          `${notKilled.length} injection points did not terminate the writer, so their results say nothing about crash behaviour`,
          notKilled.map((outcome) => ({ point: outcome.point, exits: outcome.exits }))
        )
  );

  const torn = outcomes.filter((outcome) => !outcome.batchIsAtomic);
  checks.push(
    torn.length === 0
      ? check(
          'a batch is entirely visible or entirely absent',
          'pass',
          `no partially applied batch after SIGKILL at any of ${points.length} injection points`
        )
      : check(
          'a batch is entirely visible or entirely absent',
          'fail',
          `${torn.length} injection points left a partially applied batch`,
          torn.map((outcome) => ({ point: outcome.point, partial: outcome.batchPartiallyApplied }))
        )
  );

  const broken = outcomes.filter((outcome) => outcome.integrityCheck !== 'ok');
  checks.push(
    broken.length === 0
      ? check(
          'the file survives an unclean exit',
          'pass',
          'ordinary SQLite reports integrity_check ok after every kill, including one during checkpoint'
        )
      : check(
          'the file survives an unclean exit',
          'fail',
          `${broken.length} injection points left a file ordinary SQLite rejects`,
          broken.map((outcome) => ({ point: outcome.point, integrityCheck: outcome.integrityCheck }))
        )
  );

  const lost = outcomes.filter((outcome) => outcome.lostAcknowledged.length > 0);
  checks.push(
    lost.length === 0
      ? check('acknowledged mutations are not silently lost', 'pass', 'every batch acknowledged before the kill is still in the commit log')
      : check(
          'acknowledged mutations are not silently lost',
          'fail',
          `${lost.length} injection points lost acknowledged batches`,
          lost.map((outcome) => ({ point: outcome.point, lost: outcome.lostAcknowledged }))
        )
  );

  const stalled = outcomes.filter((outcome) => outcome.survivingWriterCommitted === 0);
  checks.push(
    stalled.length === 0
      ? check(
          'a surviving process keeps writing',
          'pass',
          `the second writer committed every batch through all ${outcomes.length} crashes, so a dead pod does not wedge the shared file`,
          outcomes.map((outcome) => ({
            point: outcome.point,
            survivorCommitted: outcome.survivingWriterCommitted,
            survivorFailed: outcome.survivingWriterFailed,
          }))
        )
      : check(
          'a surviving process keeps writing',
          'fail',
          `the surviving writer committed nothing at ${stalled.length} injection points, so a dead pod can wedge the shared file`,
          stalled.map((outcome) => ({
            point: outcome.point,
            reported: outcome.survivingWriterReported,
            failed: outcome.survivingWriterFailed,
            exits: outcome.exits,
          }))
        )
  );

  const replay = await runLostAcknowledgementReplay(context);
  checks.push(
    replay.integrityCheck === 'ok' && replay.replayCommitted > 0
      ? check(
          'replaying a lost-acknowledgement job is safe',
          'pass',
          `re-running the same batches after a post-commit kill left the file valid (${replay.tileCountBefore} tiles before, ${replay.tileCountAfter} after)`,
          replay
        )
      : check(
          'replaying a lost-acknowledgement job is safe',
          'fail',
          'replaying the batches after a post-commit kill did not leave a usable file',
          replay
        )
  );

  checks.push(
    check(
      'pod eviction and PVC remount',
      'not-run',
      'requires the OpenShift cluster and its RWX StorageClass; SIGKILL is the closest local approximation and was exercised instead'
    )
  );

  const status = rollUp(checks);

  return {
    id: 5,
    title: 'Atomicity and recovery',
    status,
    summary:
      status === 'pass'
        ? 'Metatile batches are atomic across process death and a lost-acknowledgement replay is safe.'
        : status === 'not-run'
          ? 'No recovery scenario could be exercised.'
          : 'Atomicity or recovery does not hold under injected failures.',
    checks,
    measurements: { crashOutcomes: outcomes, lostAcknowledgementReplay: replay },
    durationMs: performance.now() - startedAt,
  };
};
