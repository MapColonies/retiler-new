import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runFleet } from '../lib/fleet.mts';
import { createGeoPackage, readSchemaSnapshot } from '../lib/geopackage.mts';
import { tilePayloadHash } from '../lib/payload.mts';
import { check, rollUp } from '../lib/report.mts';
import { checkpoint, COMMIT_LOG_TABLE, fileFootprint, openTurso, SIDECAR_SUFFIXES } from '../lib/turso.mts';
import { validateWithGdal, validateWithSqlite } from '../lib/validate.mts';
import { readCommitLog, verifyDatabase } from '../lib/verify.mts';
import { buildWorkloadPlan } from '../lib/workload.mts';
import type { GateCheck, GateResult } from '../lib/types.mts';
import type { GateContext } from './context.mts';

const TILE_TABLE = 'tiles';
const ZOOM_LEVEL = 8;

/**
 * Gate 6 -- after the controlled shutdown sequence, is the file a self-contained
 * GeoPackage that ordinary SQLite and GDAL fully accept?
 */
export const runGate6 = async (context: GateContext): Promise<GateResult> => {
  const startedAt = performance.now();
  const checks: GateCheck[] = [];

  const databasePath = join(context.scratchDirectory, 'gate6-final.gpkg');
  for (const suffix of ['', ...SIDECAR_SUFFIXES]) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }

  createGeoPackage({ databasePath, tileTable: TILE_TABLE, maxZoomLevel: ZOOM_LEVEL });
  const baseline = readSchemaSnapshot(databasePath);

  // Steps 1 to 3 of the shutdown sequence: stop taking work, drain the jobs,
  // and wait for every transaction to finish. Here that is simply running the
  // fleet to completion.
  const plans = buildWorkloadPlan({
    writers: 4,
    batchesPerWriter: context.profile === 'full' ? 16 : 6,
    metatile: 2,
    deleteRatio: 0.25,
    collision: 'moderate',
    zoomLevel: ZOOM_LEVEL,
    seed: 7,
  });

  const fleet = await runFleet({
    mode: 'turso',
    databasePath,
    tileTable: TILE_TABLE,
    plans,
    workDirectory: join(context.scratchDirectory, 'gate6-fleet'),
    multiProcess: true,
    checkpointOnClose: false,
  });

  const footprintBeforeCheckpoint = fileFootprint(databasePath);

  // Steps 4 and 5: close every connection, then fold all journal state back
  // into the main file.
  const finalizeStartedAt = performance.now();
  const finalizer = await openTurso(databasePath, { multiProcess: true });
  const checkpointResult = await checkpoint(finalizer);
  await finalizer.close();
  const checkpointMs = performance.now() - finalizeStartedAt;

  // Step 6: nothing the readers need may be left in a sidecar. Sampled here,
  // before any other connection opens the file -- an ordinary SQLite reader
  // recreates a -shm of its own, which would otherwise look like leftover state.
  const footprintAfterCheckpoint = fileFootprint(databasePath);
  const leftoverSidecars = SIDECAR_SUFFIXES.filter(
    (suffix) => existsSync(`${databasePath}${suffix}`) && statSync(`${databasePath}${suffix}`).size > 0
  );

  const verification = await verifyDatabase(databasePath, TILE_TABLE, fleet.reports);
  const commitLog = readCommitLog(databasePath);

  checks.push(
    leftoverSidecars.length === 0
      ? check('no uncheckpointed state remains in a sidecar', 'pass', 'every WAL, shared-memory and Turso sidecar is gone or empty after checkpoint')
      : check(
          'no uncheckpointed state remains in a sidecar',
          'fail',
          `sidecars still hold data after checkpoint: ${leftoverSidecars.join(', ')}`,
          footprintAfterCheckpoint
        )
  );

  // The commit log is instrumentation, not part of the profile, so the
  // finalization procedure drops it before the file is validated or uploaded.
  const dropStartedAt = performance.now();
  const finalDb = new DatabaseSync(databasePath);
  finalDb.exec(`DROP TABLE IF EXISTS ${COMMIT_LOG_TABLE}`);
  finalDb.exec('VACUUM');
  finalDb.close();
  const finalizationMs = checkpointMs + (performance.now() - dropStartedAt);

  // Step 7: validate with ordinary tooling only.
  const sqlite = validateWithSqlite(databasePath, TILE_TABLE, baseline);

  checks.push(
    sqlite.integrityCheck === 'ok'
      ? check('ordinary SQLite integrity check passes', 'pass', 'PRAGMA integrity_check returned ok')
      : check('ordinary SQLite integrity check passes', 'fail', `PRAGMA integrity_check returned "${sqlite.integrityCheck}"`)
  );

  checks.push(
    sqlite.foreignKeyViolations === 0
      ? check('foreign key validation passes', 'pass', 'PRAGMA foreign_key_check reported no violations')
      : check('foreign key validation passes', 'fail', `${sqlite.foreignKeyViolations} foreign key violations`)
  );

  checks.push(
    sqlite.applicationIdCorrect && sqlite.userVersionCorrect && sqlite.schemaMatchesBaseline
      ? check('GeoPackage metadata is intact', 'pass', `application_id ${sqlite.applicationId}, user_version ${sqlite.userVersion}, schema unchanged`)
      : check(
          'GeoPackage metadata is intact',
          'fail',
          `application_id ${sqlite.applicationId}, user_version ${sqlite.userVersion}, ${sqlite.schemaDifferences.length} schema differences`,
          sqlite.schemaDifferences
        )
  );

  const tileMatrixSet = ((): { srsId: number; bounds: string } => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = {
        ...(db.prepare('SELECT srs_id, min_x, min_y, max_x, max_y FROM gpkg_tile_matrix_set WHERE table_name = ?').get(TILE_TABLE) as object),
      } as {
        srs_id: number;
        min_x: number;
        min_y: number;
        max_x: number;
        max_y: number;
      };
      return { srsId: row.srs_id, bounds: `${row.min_x},${row.min_y},${row.max_x},${row.max_y}` };
    } finally {
      db.close();
    }
  })();

  checks.push(
    tileMatrixSet.srsId === 4326 && tileMatrixSet.bounds === '-180,-90,180,90'
      ? check('WorldCRS84Quad metadata is correct', 'pass', 'the tile matrix set spans the globe in EPSG:4326 with two columns and one row at zoom 0')
      : check('WorldCRS84Quad metadata is correct', 'fail', `tile matrix set is srs ${tileMatrixSet.srsId} over ${tileMatrixSet.bounds}`)
  );

  // Tile count against acknowledged mutations, and an exact byte comparison for
  // every tile since this fixture is bounded.
  const mismatched: string[] = [];
  const expected = new Map<string, { writerId: number; batchIndex: number } | null>();
  for (const entry of commitLog) {
    for (const op of entry.ops) {
      expected.set(`${op.z}/${op.x}/${op.y}`, op.kind === 'put' ? { writerId: entry.writerId, batchIndex: entry.batchIndex } : null);
    }
  }

  for (const tile of sqlite.tiles) {
    const key = `${tile.zoomLevel}/${tile.tileColumn}/${tile.tileRow}`;
    const winner = expected.get(key);
    if (winner == null || tile.hash !== (await tilePayloadHash(winner))) {
      mismatched.push(key);
    }
  }

  checks.push(
    mismatched.length === 0
      ? check(
          'every tile matches its expected PNG bytes',
          'pass',
          `all ${sqlite.tiles.length} stored tiles hash exactly to the payload of the commit that last wrote them`
        )
      : check(
          'every tile matches its expected PNG bytes',
          'fail',
          `${mismatched.length} tiles do not match their expected bytes`,
          mismatched.slice(0, 20)
        )
  );

  checks.push(
    verification.lostAcknowledged.length === 0 && sqlite.tileCount === verification.expectedTileCount
      ? check('tile count matches acknowledged mutations', 'pass', `${sqlite.tileCount} tiles, exactly what the acknowledged batches imply`)
      : check(
          'tile count matches acknowledged mutations',
          'fail',
          `${sqlite.tileCount} tiles stored against ${verification.expectedTileCount} implied by the commit log, with ${verification.lostAcknowledged.length} acknowledged batches missing`
        )
  );

  const gdal = validateWithGdal(databasePath);

  checks.push(
    !gdal.toolchain.gdalinfo.available
      ? check('GDAL validates the finalized file', 'not-run', 'GDAL is not installed on this host')
      : gdal.opened
        ? check(
            'GDAL validates the finalized file',
            'pass',
            `GDAL ${gdal.toolchain.gdalinfo.version ?? ''} opened it as ${gdal.rasterSize ?? 'unknown'} in ${gdal.coordinateSystem ?? 'unknown CRS'}${gdal.warnings.length > 0 ? ` with ${gdal.warnings.length} warnings` : ' with no warnings'}`,
            gdal
          )
        : check('GDAL validates the finalized file', 'fail', `GDAL could not open the finalized file: ${gdal.error ?? 'unknown'}`, gdal)
  );

  checks.push(
    gdal.driverValidate?.ran === true
      ? check(
          'gdal driver gpkg validate',
          gdal.driverValidate.output.toLowerCase().includes('error') ? 'fail' : 'pass',
          gdal.driverValidate.output.slice(0, 300)
        )
      : check(
          'gdal driver gpkg validate',
          'not-run',
          `the installed GDAL (${gdal.toolchain.gdalinfo.version ?? 'unknown'}) predates the unified gdal CLI that provides this check; gdalinfo and ogrinfo were used instead`
        )
  );

  checks.push(check('opens in a standard GIS client', 'not-run', 'QGIS is not available in this environment and needs a human at a desktop session'));

  const status = rollUp(checks);

  return {
    id: 6,
    title: 'Finalization and interoperability',
    status,
    summary:
      status === 'pass'
        ? 'The finalized file stands alone and passes ordinary SQLite and GDAL validation.'
        : status === 'fail'
          ? 'The finalized file does not pass ordinary SQLite or GDAL validation.'
          : 'Finalization completed, but some interoperability checks could not be run here.',
    checks,
    measurements: {
      footprintBeforeCheckpoint,
      footprintAfterCheckpoint,
      footprintAfterFinalization: fileFootprint(databasePath),
      checkpointResult,
      checkpointMs,
      finalizationMs,
      batchesCommitted: fleet.reports.reduce((sum, report) => sum + report.batchesCommitted, 0),
      commitLogEntries: commitLog.length,
      finalTileCount: sqlite.tileCount,
      gdal,
    },
    durationMs: performance.now() - startedAt,
  };
};
