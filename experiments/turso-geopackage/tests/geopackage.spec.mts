import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import {
  createGeoPackage,
  GEOPACKAGE_APPLICATION_ID,
  GEOPACKAGE_USER_VERSION,
  readSchemaSnapshot,
  REQUIRED_GEOPACKAGE_TABLES,
} from '../lib/geopackage.mts';

const TILE_TABLE = 'tiles';

/** `node:sqlite` returns null-prototype rows, which deepStrictEqual rejects. */
const plain = <T,>(row: unknown): T => ({ ...(row as object) }) as T;
const plainAll = <T,>(rows: unknown[]): T[] => rows.map((row) => plain<T>(row));
const MAX_ZOOM = 3;

describe('createGeoPackage', () => {
  let directory: string;
  let databasePath: string;
  let db: DatabaseSync;

  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'gpkg-spec-'));
    databasePath = join(directory, 'fixture.gpkg');
    createGeoPackage({ databasePath, tileTable: TILE_TABLE, maxZoomLevel: MAX_ZOOM });
    db = new DatabaseSync(databasePath, { readOnly: true });
  });

  after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('stamps the GeoPackage application id and user version', () => {
    assert.equal(plain<{ application_id: number }>(db.prepare('PRAGMA application_id').get()).application_id, GEOPACKAGE_APPLICATION_ID);
    assert.equal(plain<{ user_version: number }>(db.prepare('PRAGMA user_version').get()).user_version, GEOPACKAGE_USER_VERSION);
  });

  it('creates every required metadata table plus the tile pyramid table', () => {
    const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
    for (const table of REQUIRED_GEOPACKAGE_TABLES) {
      assert.ok(names.has(table), `missing ${table}`);
    }
    assert.ok(names.has(TILE_TABLE));
  });

  it('registers the tile table in gpkg_contents as a tiles layer in EPSG:4326', () => {
    const row = db.prepare('SELECT data_type, srs_id, min_x, min_y, max_x, max_y FROM gpkg_contents WHERE table_name = ?').get(TILE_TABLE);
    assert.deepEqual(plain(row), { data_type: 'tiles', srs_id: 4326, min_x: -180, min_y: -90, max_x: 180, max_y: 90 });
  });

  it('declares the WorldCRS84Quad tile matrix set over the whole globe', () => {
    const row = db.prepare('SELECT srs_id, min_x, min_y, max_x, max_y FROM gpkg_tile_matrix_set WHERE table_name = ?').get(TILE_TABLE);
    assert.deepEqual(plain(row), { srs_id: 4326, min_x: -180, min_y: -90, max_x: 180, max_y: 90 });
  });

  it('describes two columns and one row of 256 pixel tiles at zoom level 0', () => {
    const row = db
      .prepare(
        'SELECT matrix_width, matrix_height, tile_width, tile_height, pixel_x_size, pixel_y_size FROM gpkg_tile_matrix WHERE table_name = ? AND zoom_level = 0'
      )
      .get(TILE_TABLE);
    assert.deepEqual(plain(row), {
      matrix_width: 2,
      matrix_height: 1,
      tile_width: 256,
      tile_height: 256,
      pixel_x_size: 0.703125,
      pixel_y_size: 0.703125,
    });
  });

  it('describes one tile matrix row per zoom level, doubling on each axis', () => {
    const rows = db
      .prepare('SELECT zoom_level, matrix_width, matrix_height FROM gpkg_tile_matrix WHERE table_name = ? ORDER BY zoom_level')
      .all(TILE_TABLE);
    assert.deepEqual(plainAll(rows), [
      { zoom_level: 0, matrix_width: 2, matrix_height: 1 },
      { zoom_level: 1, matrix_width: 4, matrix_height: 2 },
      { zoom_level: 2, matrix_width: 8, matrix_height: 4 },
      { zoom_level: 3, matrix_width: 16, matrix_height: 8 },
    ]);
  });

  it('seeds the three spatial reference systems the specification requires', () => {
    const ids = (db.prepare('SELECT srs_id FROM gpkg_spatial_ref_sys ORDER BY srs_id').all() as { srs_id: number }[]).map((row) => row.srs_id);
    assert.deepEqual(ids, [-1, 0, 4326]);
  });

  it('passes an ordinary SQLite integrity and foreign key check', () => {
    assert.deepEqual(plainAll(db.prepare('PRAGMA integrity_check').all()), [{ integrity_check: 'ok' }]);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

describe('tile table constraints', () => {
  let directory: string;
  let databasePath: string;

  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'gpkg-spec-'));
    databasePath = join(directory, 'constraints.gpkg');
    createGeoPackage({ databasePath, tileTable: TILE_TABLE, maxZoomLevel: MAX_ZOOM });
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects a duplicate tile coordinate', () => {
    const db = new DatabaseSync(databasePath);
    const insert = db.prepare(`INSERT INTO ${TILE_TABLE} (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)`);
    insert.run(1, 0, 0, new Uint8Array([1, 2, 3]));
    assert.throws(() => insert.run(1, 0, 0, new Uint8Array([4, 5, 6])), /UNIQUE constraint failed/u);
    db.close();
  });
});

describe('readSchemaSnapshot', () => {
  let directory: string;

  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'gpkg-spec-'));
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('is stable across two identically built GeoPackages', () => {
    const first = join(directory, 'a.gpkg');
    const second = join(directory, 'b.gpkg');
    createGeoPackage({ databasePath: first, tileTable: TILE_TABLE, maxZoomLevel: MAX_ZOOM });
    createGeoPackage({ databasePath: second, tileTable: TILE_TABLE, maxZoomLevel: MAX_ZOOM });
    assert.deepEqual(readSchemaSnapshot(first), readSchemaSnapshot(second));
  });

  it('captures the tile table and its unique index', () => {
    const path = join(directory, 'c.gpkg');
    createGeoPackage({ databasePath: path, tileTable: TILE_TABLE, maxZoomLevel: MAX_ZOOM });
    const snapshot = readSchemaSnapshot(path);
    const tileTableEntry = snapshot.find((entry) => entry.name === TILE_TABLE);
    assert.ok(tileTableEntry);
    assert.ok(tileTableEntry.sql.includes('tile_data'));
    assert.ok(snapshot.some((entry) => entry.type === 'index' && entry.tableName === TILE_TABLE));
  });
});
