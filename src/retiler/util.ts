import { Tile, validateTile, TILEGRID_WORLD_CRS84, SCALE_FACTOR } from '@map-colonies/tile-calc';

export const isTileInBounds = (tile: Tile): boolean => {
  try {
    validateTile(tile, TILEGRID_WORLD_CRS84);
    return true;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (err) {
    return false;
  }
};

export const getFlippedY = (tile: Required<Tile>): number => {
  return (TILEGRID_WORLD_CRS84.numberOfMinLevelTilesY / tile.metatile) * SCALE_FACTOR ** tile.z - tile.y - 1;
};
