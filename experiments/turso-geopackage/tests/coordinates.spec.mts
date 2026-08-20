import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { matrixHeight, matrixWidth, toGeoPackageCoordinate } from '../lib/coordinates.mts';

describe('matrix dimensions (WorldCRS84Quad)', () => {
  it('has two columns and one row at zoom 0', () => {
    assert.equal(matrixWidth(0), 2);
    assert.equal(matrixHeight(0), 1);
  });

  it('doubles on each axis per zoom level', () => {
    assert.deepEqual([matrixWidth(1), matrixHeight(1)], [4, 2]);
    assert.deepEqual([matrixWidth(4), matrixHeight(4)], [32, 16]);
  });
});

describe('toGeoPackageCoordinate', () => {
  it('maps a retiler tile straight through without flipping y', () => {
    // tile-calc's WorldCRS84Quad puts y=0 at north, which is already the
    // GeoPackage top-left tile_row origin. See the README for the evidence.
    assert.deepEqual(toGeoPackageCoordinate({ z: 1, x: 0, y: 0, metatile: 1 }), { zoomLevel: 1, tileColumn: 0, tileRow: 0 });
    assert.deepEqual(toGeoPackageCoordinate({ z: 1, x: 3, y: 1, metatile: 1 }), { zoomLevel: 1, tileColumn: 3, tileRow: 1 });
  });

  it('accepts the full extent of a zoom level', () => {
    assert.deepEqual(toGeoPackageCoordinate({ z: 2, x: 7, y: 3, metatile: 1 }), { zoomLevel: 2, tileColumn: 7, tileRow: 3 });
  });

  it('rejects a tile column beyond the matrix width', () => {
    assert.throws(() => toGeoPackageCoordinate({ z: 1, x: 4, y: 0, metatile: 1 }), /tile column 4 out of range/u);
  });

  it('rejects a tile row beyond the matrix height', () => {
    assert.throws(() => toGeoPackageCoordinate({ z: 1, x: 0, y: 2, metatile: 1 }), /tile row 2 out of range/u);
  });

  it('rejects negative coordinates', () => {
    assert.throws(() => toGeoPackageCoordinate({ z: 1, x: -1, y: 0, metatile: 1 }), /tile column -1 out of range/u);
  });

  it('rejects a negative zoom level', () => {
    assert.throws(() => toGeoPackageCoordinate({ z: -1, x: 0, y: 0, metatile: 1 }), /zoom level -1 out of range/u);
  });

  it('rejects an unsplit metatile, since only leaf tiles are stored', () => {
    assert.throws(() => toGeoPackageCoordinate({ z: 1, x: 0, y: 0, metatile: 2 }), /metatile 2/u);
  });

  it('rejects non integer coordinates', () => {
    assert.throws(() => toGeoPackageCoordinate({ z: 1, x: 0.5, y: 0, metatile: 1 }), /tile column 0.5 out of range/u);
  });
});
