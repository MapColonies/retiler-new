import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { toGeoPackageCoordinate } from '../lib/coordinates.mts';
import { createGeoPackage, readSchemaSnapshot } from '../lib/geopackage.mts';
import { tilePayload } from '../lib/payload.mts';
import { check, rollUp } from '../lib/report.mts';
import { checkpoint, fileFootprint, openTurso, SIDECAR_SUFFIXES } from '../lib/turso.mts';
import { validateWithGdal, validateWithSqlite } from '../lib/validate.mts';
import type { GateCheck, GateResult } from '../lib/types.mts';
import type { GateContext } from './context.mts';

const TILE_TABLE = 'tiles';
const ZOOM = 3;

/**
 * Gate 3 -- does Turso work against a standards-compliant GeoPackage without
 * needing the schema bent to suit it, and can ordinary tooling reopen the file
 * afterwards?
 */
export const runGate3 = async (context: GateContext): Promise<GateResult> => {
  const startedAt = performance.now();
  const checks: GateCheck[] = [];

  const databasePath = join(context.scratchDirectory, 'gate3.gpkg');
  for (const suffix of ['', ...SIDECAR_SUFFIXES]) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }

  // Built by ordinary SQLite so that any deviation afterwards is Turso's doing.
  createGeoPackage({ databasePath, tileTable: TILE_TABLE, maxZoomLevel: ZOOM });
  const baseline = readSchemaSnapshot(databasePath);

  const payload = await tilePayload({ writerId: 0, batchIndex: 0 });
  const replacement = await tilePayload({ writerId: 0, batchIndex: 1 });
  const target = toGeoPackageCoordinate({ z: ZOOM, x: 5, y: 2, metatile: 1 });
  const doomed = toGeoPackageCoordinate({ z: ZOOM, x: 6, y: 2, metatile: 1 });

  let opened = false;
  let constraintEnforced: GateCheck | undefined;

  try {
    const db = await openTurso(databasePath, { multiProcess: true });
    opened = true;

    try {
      await db.exec('PRAGMA foreign_keys = ON');

      const insert = `INSERT INTO "${TILE_TABLE}" (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)`;

      await db.run(insert, target.zoomLevel, target.tileColumn, target.tileRow, payload);
      await db.run(insert, doomed.zoomLevel, doomed.tileColumn, doomed.tileRow, payload);

      // The unique tile coordinate constraint is the thing most at risk from an
      // engine with index limitations, so it is probed directly.
      try {
        await db.run(insert, target.zoomLevel, target.tileColumn, target.tileRow, replacement);
        constraintEnforced = check(
          'unique tile coordinate constraint is enforced',
          'fail',
          'a duplicate (zoom_level, tile_column, tile_row) was accepted, so the GeoPackage uniqueness rule is not being enforced'
        );
      } catch (error) {
        constraintEnforced = check(
          'unique tile coordinate constraint is enforced',
          /UNIQUE constraint failed/iu.test(String(error)) ? 'pass' : 'fail',
          `a duplicate coordinate was rejected: ${String(error).slice(0, 200)}`
        );
      }

      await db.run(
        `${insert} ON CONFLICT (zoom_level, tile_column, tile_row) DO UPDATE SET tile_data = excluded.tile_data`,
        target.zoomLevel,
        target.tileColumn,
        target.tileRow,
        replacement
      );

      await db.run(
        `DELETE FROM "${TILE_TABLE}" WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?`,
        doomed.zoomLevel,
        doomed.tileColumn,
        doomed.tileRow
      );

      checks.push(
        check(
          'put, upsert and delete work with constraints enabled',
          'pass',
          'insert, ON CONFLICT upsert and delete all succeeded against the conformant schema'
        )
      );
    } finally {
      await checkpoint(db);
      await db.close();
    }
  } catch (error) {
    checks.push(
      check(
        opened ? 'put, upsert and delete work with constraints enabled' : 'Turso opens a conformant GeoPackage',
        'fail',
        `Turso failed against the conformant schema: ${String(error).slice(0, 300)}`,
        String(error)
      )
    );
  }

  if (constraintEnforced !== undefined) {
    checks.push(constraintEnforced);
  }

  checks.unshift(
    opened
      ? check('Turso opens a conformant GeoPackage', 'pass', 'the file created by ordinary SQLite opened without complaint')
      : check('Turso opens a conformant GeoPackage', 'fail', 'Turso could not open the conformant fixture')
  );

  const sqlite = validateWithSqlite(databasePath, TILE_TABLE, baseline);

  checks.push(
    sqlite.schemaMatchesBaseline
      ? check('schema survives the round trip unchanged', 'pass', 'every table, index and constraint is byte for byte what ordinary SQLite declared')
      : check(
          'schema survives the round trip unchanged',
          'fail',
          `Turso altered ${sqlite.schemaDifferences.length} schema objects`,
          sqlite.schemaDifferences
        )
  );

  checks.push(
    sqlite.integrityCheck === 'ok' && sqlite.foreignKeyViolations === 0
      ? check('ordinary SQLite reopens the file cleanly', 'pass', 'integrity_check returned ok with no foreign key violations')
      : check(
          'ordinary SQLite reopens the file cleanly',
          'fail',
          `integrity_check returned "${sqlite.integrityCheck}" with ${sqlite.foreignKeyViolations} foreign key violations`
        )
  );

  checks.push(
    sqlite.applicationIdCorrect && sqlite.userVersionCorrect
      ? check('GeoPackage identity is preserved', 'pass', `application_id and user_version are still ${sqlite.applicationId} / ${sqlite.userVersion}`)
      : check(
          'GeoPackage identity is preserved',
          'fail',
          `application_id ${sqlite.applicationId}, user_version ${sqlite.userVersion} after the round trip`
        )
  );

  checks.push(
    sqlite.tileCount === 1
      ? check('mutations produced the expected rows', 'pass', 'the upserted tile remains and the deleted tile is gone')
      : check('mutations produced the expected rows', 'fail', `expected exactly 1 tile after an upsert and a delete but found ${sqlite.tileCount}`)
  );

  const gdal = validateWithGdal(databasePath);

  checks.push(
    !gdal.toolchain.gdalinfo.available
      ? check('GDAL reopens the file', 'not-run', 'GDAL is not installed on this host')
      : gdal.opened
        ? check(
            'GDAL reopens the file',
            'pass',
            `GDAL opened it as a ${gdal.rasterSize ?? 'unknown size'} ${gdal.coordinateSystem ?? 'unknown CRS'} raster`,
            gdal
          )
        : check('GDAL reopens the file', 'fail', `GDAL could not open the file: ${gdal.error ?? 'unknown'}`, gdal)
  );

  const status = rollUp(checks);

  return {
    id: 3,
    title: 'GeoPackage schema compatibility',
    status,
    summary:
      status === 'pass'
        ? 'Turso mutates a standards-compliant WorldCRS84Quad GeoPackage and leaves it readable by SQLite and GDAL.'
        : 'Turso could not work against the conformant GeoPackage schema without deviation.',
    checks,
    measurements: { sqlite: { ...sqlite, tiles: sqlite.tiles.length }, gdal, footprint: fileFootprint(databasePath) },
    durationMs: performance.now() - startedAt,
  };
};
