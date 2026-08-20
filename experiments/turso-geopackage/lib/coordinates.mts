import { SCALE_FACTOR, TILEGRID_WORLD_CRS84 } from '@map-colonies/tile-calc';

/**
 * A tile as Retiler models it, on the WorldCRS84Quad grid of `@map-colonies/tile-calc`.
 */
export interface RetilerTile {
  z: number;
  x: number;
  y: number;
  metatile: number;
}

/**
 * The identity of a tile row in a GeoPackage tile pyramid user table.
 */
export interface GeoPackageCoordinate {
  zoomLevel: number;
  tileColumn: number;
  tileRow: number;
}

/** Highest zoom level the fixtures and the range checks accept. */
export const MAX_ZOOM_LEVEL = 24;

/** Number of tile columns of the WorldCRS84Quad matrix at `zoomLevel`. */
export const matrixWidth = (zoomLevel: number): number => TILEGRID_WORLD_CRS84.numberOfMinLevelTilesX * SCALE_FACTOR ** zoomLevel;

/** Number of tile rows of the WorldCRS84Quad matrix at `zoomLevel`. */
export const matrixHeight = (zoomLevel: number): number => TILEGRID_WORLD_CRS84.numberOfMinLevelTilesY * SCALE_FACTOR ** zoomLevel;

const isIntegerInRange = (value: number, upperBoundExclusive: number): boolean =>
  Number.isInteger(value) && value >= 0 && value < upperBoundExclusive;

/**
 * Converts a Retiler tile into the GeoPackage tile row that stores it.
 *
 * `tile-calc`'s WorldCRS84Quad grid already numbers y from the north edge
 * downwards -- `{ z: 1, x: 0, y: 0 }` covers north 90 to south 0 -- which is
 * exactly the top-left `tile_row` origin GeoPackage requires. So y passes
 * through unchanged.
 *
 * This deliberately ignores the global `app.tilesStorage.layout.shouldFlipY`
 * setting: that flag flips y for the S3 and filesystem *key layout*, and
 * applying it here would write every tile into the vertically mirrored row.
 */
export const toGeoPackageCoordinate = (tile: RetilerTile): GeoPackageCoordinate => {
  const { z, x, y, metatile } = tile;

  if (!isIntegerInRange(z, MAX_ZOOM_LEVEL + 1)) {
    throw new RangeError(`zoom level ${z} out of range, expected an integer between 0 and ${MAX_ZOOM_LEVEL}`);
  }

  // Only leaf tiles reach storage; the splitter emits sub tiles with metatile 1.
  if (metatile !== 1) {
    throw new RangeError(`metatile ${metatile} cannot be stored, only split leaf tiles with metatile 1 are storable`);
  }

  const width = matrixWidth(z);
  const height = matrixHeight(z);

  if (!isIntegerInRange(x, width)) {
    throw new RangeError(`tile column ${x} out of range, expected an integer between 0 and ${width - 1} at zoom level ${z}`);
  }

  if (!isIntegerInRange(y, height)) {
    throw new RangeError(`tile row ${y} out of range, expected an integer between 0 and ${height - 1} at zoom level ${z}`);
  }

  return { zoomLevel: z, tileColumn: x, tileRow: y };
};
