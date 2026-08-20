import { DatabaseSync } from 'node:sqlite';
import { matrixHeight, matrixWidth } from './coordinates.mts';

/** `GPKG` in ASCII, the application id every GeoPackage must carry. */
export const GEOPACKAGE_APPLICATION_ID = 0x47504b47;

/**
 * GeoPackage 1.3. Chosen over 1.4 because GDAL 3.4.1 -- the version this
 * experiment validates against -- warns that 1.4 "may only be partially
 * supported", which would make every validation run ambiguous. Both are
 * ratified OGC versions.
 */
export const GEOPACKAGE_USER_VERSION = 10300;

export const TILE_SIZE_PIXELS = 256;

/** Degrees of longitude covered by one pixel of a zoom level 0 tile. */
const ZOOM_ZERO_PIXEL_SIZE = 360 / (matrixWidth(0) * TILE_SIZE_PIXELS);

export const REQUIRED_GEOPACKAGE_TABLES = ['gpkg_spatial_ref_sys', 'gpkg_contents', 'gpkg_tile_matrix_set', 'gpkg_tile_matrix'] as const;

export interface CreateGeoPackageOptions {
  databasePath: string;
  tileTable: string;
  maxZoomLevel: number;
}

export interface SchemaEntry {
  type: string;
  name: string;
  tableName: string;
  sql: string;
}

/**
 * The metadata tables, verbatim from the OGC GeoPackage specification, so the
 * fixture is a standards-compliant file rather than something shaped to suit
 * whatever Turso happens to accept.
 */
const METADATA_DDL = [
  `CREATE TABLE gpkg_spatial_ref_sys (
    srs_name TEXT NOT NULL,
    srs_id INTEGER NOT NULL PRIMARY KEY,
    organization TEXT NOT NULL,
    organization_coordsys_id INTEGER NOT NULL,
    definition TEXT NOT NULL,
    description TEXT
  )`,
  `CREATE TABLE gpkg_contents (
    table_name TEXT NOT NULL PRIMARY KEY,
    data_type TEXT NOT NULL,
    identifier TEXT UNIQUE,
    description TEXT DEFAULT '',
    last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    min_x DOUBLE,
    min_y DOUBLE,
    max_x DOUBLE,
    max_y DOUBLE,
    srs_id INTEGER,
    CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
  )`,
  `CREATE TABLE gpkg_tile_matrix_set (
    table_name TEXT NOT NULL PRIMARY KEY,
    srs_id INTEGER NOT NULL,
    min_x DOUBLE NOT NULL,
    min_y DOUBLE NOT NULL,
    max_x DOUBLE NOT NULL,
    max_y DOUBLE NOT NULL,
    CONSTRAINT fk_gtms_table_name FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
    CONSTRAINT fk_gtms_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
  )`,
  `CREATE TABLE gpkg_tile_matrix (
    table_name TEXT NOT NULL,
    zoom_level INTEGER NOT NULL,
    matrix_width INTEGER NOT NULL,
    matrix_height INTEGER NOT NULL,
    tile_width INTEGER NOT NULL,
    tile_height INTEGER NOT NULL,
    pixel_x_size DOUBLE NOT NULL,
    pixel_y_size DOUBLE NOT NULL,
    CONSTRAINT pk_ttm PRIMARY KEY (table_name, zoom_level),
    CONSTRAINT fk_tmm_table_name FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name)
  )`,
];

const SPATIAL_REF_SYS_ROWS = [
  ['Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system'],
  ['Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system'],
  [
    'WGS 84 geodetic',
    4326,
    'EPSG',
    4326,
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]',
    'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid',
  ],
] as const;

/**
 * The tile pyramid user table. The unique tile coordinate constraint is the
 * part of the profile most at risk from an engine with index limitations, so
 * it is declared explicitly rather than left implicit.
 */
export const tileTableDdl = (tileTable: string): string =>
  `CREATE TABLE "${tileTable}" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zoom_level INTEGER NOT NULL,
    tile_column INTEGER NOT NULL,
    tile_row INTEGER NOT NULL,
    tile_data BLOB NOT NULL,
    CONSTRAINT uq_tile_coordinate UNIQUE (zoom_level, tile_column, tile_row)
  )`;

/**
 * Writes a minimal but standards-compliant WorldCRS84Quad raster tiles
 * GeoPackage using ordinary SQLite. Turso never takes part in creating it, so
 * gate 3 can tell whether Turso merely *opens* a conformant file or quietly
 * rewrites it.
 */
export const createGeoPackage = (options: CreateGeoPackageOptions): void => {
  const { databasePath, tileTable, maxZoomLevel } = options;
  const db = new DatabaseSync(databasePath);

  try {
    db.exec(`PRAGMA application_id = ${GEOPACKAGE_APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${GEOPACKAGE_USER_VERSION}`);

    for (const ddl of METADATA_DDL) {
      db.exec(ddl);
    }
    db.exec(tileTableDdl(tileTable));

    const insertSrs = db.prepare(
      'INSERT INTO gpkg_spatial_ref_sys (srs_name, srs_id, organization, organization_coordsys_id, definition, description) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const row of SPATIAL_REF_SYS_ROWS) {
      insertSrs.run(...row);
    }

    db.prepare(
      'INSERT INTO gpkg_contents (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(tileTable, 'tiles', tileTable, 'Retiler tiles', -180, -90, 180, 90, 4326);

    db.prepare('INSERT INTO gpkg_tile_matrix_set (table_name, srs_id, min_x, min_y, max_x, max_y) VALUES (?, ?, ?, ?, ?, ?)').run(
      tileTable,
      4326,
      -180,
      -90,
      180,
      90
    );

    const insertMatrix = db.prepare(
      'INSERT INTO gpkg_tile_matrix (table_name, zoom_level, matrix_width, matrix_height, tile_width, tile_height, pixel_x_size, pixel_y_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (let zoomLevel = 0; zoomLevel <= maxZoomLevel; zoomLevel++) {
      const pixelSize = ZOOM_ZERO_PIXEL_SIZE / 2 ** zoomLevel;
      insertMatrix.run(
        tileTable,
        zoomLevel,
        matrixWidth(zoomLevel),
        matrixHeight(zoomLevel),
        TILE_SIZE_PIXELS,
        TILE_SIZE_PIXELS,
        pixelSize,
        pixelSize
      );
    }
  } finally {
    db.close();
  }
};

/**
 * The complete `sqlite_master` schema, used to prove that a round trip through
 * Turso leaves the declared schema byte for byte identical.
 */
export const readSchemaSnapshot = (databasePath: string): SchemaEntry[] => {
  const db = new DatabaseSync(databasePath, { readOnly: true });

  try {
    return (
      db
        .prepare("SELECT type, name, tbl_name AS tableName, COALESCE(sql, '') AS sql FROM sqlite_master ORDER BY type, name")
        .all() as unknown as SchemaEntry[]
    ).map((entry) => ({ ...entry }));
  } finally {
    db.close();
  }
};
