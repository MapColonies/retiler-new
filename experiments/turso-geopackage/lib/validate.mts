import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { GEOPACKAGE_APPLICATION_ID, GEOPACKAGE_USER_VERSION, readSchemaSnapshot, type SchemaEntry } from './geopackage.mts';
import { sha256 } from './payload.mts';

export interface StoredTile {
  zoomLevel: number;
  tileColumn: number;
  tileRow: number;
  hash: string;
  bytes: number;
}

export interface SqliteValidation {
  /** `ok` when the file is structurally sound. */
  integrityCheck: string;
  foreignKeyViolations: number;
  applicationId: number;
  userVersion: number;
  applicationIdCorrect: boolean;
  userVersionCorrect: boolean;
  tileCount: number;
  schemaMatchesBaseline: boolean;
  schemaDifferences: string[];
  tiles: StoredTile[];
}

const plain = <T,>(row: unknown): T => ({ ...(row as object) }) as T;

/**
 * Reads and checks a GeoPackage with the SQLite build bundled in Node -- no
 * Turso involved. If this cannot make sense of the file, no ordinary GIS tool
 * will either.
 */
export const validateWithSqlite = (databasePath: string, tileTable: string, baseline?: SchemaEntry[]): SqliteValidation => {
  const db = new DatabaseSync(databasePath, { readOnly: true });

  try {
    const integrityCheck = plain<{ integrity_check: string }>(db.prepare('PRAGMA integrity_check').get()).integrity_check;
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
    const applicationId = plain<{ application_id: number }>(db.prepare('PRAGMA application_id').get()).application_id;
    const userVersion = plain<{ user_version: number }>(db.prepare('PRAGMA user_version').get()).user_version;

    const tiles = (
      db.prepare(`SELECT zoom_level, tile_column, tile_row, tile_data FROM "${tileTable}" ORDER BY zoom_level, tile_column, tile_row`).all() as {
        zoom_level: number;
        tile_column: number;
        tile_row: number;
        tile_data: Uint8Array;
      }[]
    ).map((row) => ({
      zoomLevel: row.zoom_level,
      tileColumn: row.tile_column,
      tileRow: row.tile_row,
      hash: sha256(row.tile_data),
      bytes: row.tile_data.byteLength,
    }));

    const current = readSchemaSnapshot(databasePath);
    const schemaDifferences = baseline === undefined ? [] : diffSchema(baseline, current);

    return {
      integrityCheck,
      foreignKeyViolations,
      applicationId,
      userVersion,
      applicationIdCorrect: applicationId === GEOPACKAGE_APPLICATION_ID,
      userVersionCorrect: userVersion === GEOPACKAGE_USER_VERSION,
      tileCount: tiles.length,
      schemaMatchesBaseline: schemaDifferences.length === 0,
      schemaDifferences,
      tiles,
    };
  } finally {
    db.close();
  }
};

/**
 * Compares two `sqlite_master` snapshots. The experiment's own commit-log table
 * is ignored, since it is instrumentation rather than part of the profile.
 */
export const diffSchema = (baseline: SchemaEntry[], current: SchemaEntry[]): string[] => {
  // Objects belonging to the experiment's own commit-log table, including any
  // engine-internal sequence table named after it, are instrumentation.
  const isInstrumentation = (entry: SchemaEntry): boolean => entry.name.includes('_experiment');
  const index = (entries: SchemaEntry[]): Map<string, SchemaEntry> =>
    new Map(entries.filter((entry) => !isInstrumentation(entry)).map((entry) => [`${entry.type}:${entry.name}`, entry]));

  const before = index(baseline);
  const after = index(current);
  const differences: string[] = [];

  for (const [key, entry] of before) {
    const other = after.get(key);
    if (other === undefined) {
      differences.push(`missing after round trip: ${key}`);
    } else if (other.sql !== entry.sql) {
      differences.push(`rewritten by the engine: ${key}`);
    }
  }

  for (const key of after.keys()) {
    if (!before.has(key)) {
      differences.push(`added by the engine: ${key}`);
    }
  }

  return differences;
};

export interface CommandProbe {
  available: boolean;
  version?: string;
  error?: string;
}

const probe = (command: string, args: string[]): CommandProbe => {
  try {
    return {
      available: true,
      version: execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .trim()
        .split('\n')[0],
    };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
};

export interface GdalToolchain {
  gdalinfo: CommandProbe;
  ogrinfo: CommandProbe;
  /** The GDAL 3.11+ unified CLI, which is what provides `gdal driver gpkg validate`. */
  gdalCli: CommandProbe;
}

export const probeGdal = (): GdalToolchain => ({
  gdalinfo: probe('gdalinfo', ['--version']),
  ogrinfo: probe('ogrinfo', ['--version']),
  gdalCli: probe('gdal', ['--version']),
});

export interface GdalValidation {
  toolchain: GdalToolchain;
  opened: boolean;
  /** Raster size GDAL derives from the tile matrix, e.g. `1024x512`. */
  rasterSize?: string;
  coordinateSystem?: string;
  driverValidate?: { ran: boolean; output: string };
  warnings: string[];
  error?: string;
}

const run = (command: string, args: string[]): { stdout: string; ok: boolean; error?: string } => {
  try {
    return { stdout: execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), ok: true };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return { stdout: failure.stdout ?? '', ok: false, error: failure.stderr ?? failure.message ?? 'unknown failure' };
  }
};

/**
 * Opens the finalized file with the installed GDAL. GDAL 3.11 added
 * `gdal driver gpkg validate`; on older builds that check is unavailable and is
 * reported as not run rather than silently skipped.
 */
export const validateWithGdal = (databasePath: string): GdalValidation => {
  const toolchain = probeGdal();

  if (!toolchain.gdalinfo.available) {
    return { toolchain, opened: false, warnings: [], error: 'gdalinfo is not installed' };
  }

  const info = run('gdalinfo', [databasePath]);
  const warnings = info.stdout
    .split('\n')
    .concat((info.error ?? '').split('\n'))
    .filter((line) => line.startsWith('Warning'))
    .map((line) => line.trim());

  const driverValidate = toolchain.gdalCli.available
    ? ((): { ran: boolean; output: string } => {
        const result = run('gdal', ['driver', 'gpkg', 'validate', databasePath]);
        return { ran: true, output: result.ok ? result.stdout.trim() : (result.error ?? '').trim() };
      })()
    : { ran: false, output: 'requires the unified `gdal` CLI from GDAL 3.11 or newer' };

  return {
    toolchain,
    opened: info.ok,
    rasterSize: /Size is (\d+, \d+)/u.exec(info.stdout)?.[1]?.replace(', ', 'x'),
    coordinateSystem: /GEOGCRS\["([^"]+)"/u.exec(info.stdout)?.[1],
    driverValidate,
    warnings,
    ...(info.ok ? {} : { error: info.error }),
  };
};
