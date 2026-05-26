import { Tile } from '@map-colonies/tile-calc';

export interface TileMetadata {
  parent: string;
  state?: number;
  force?: boolean;
}

export type TileWithMetadata = Required<Tile> & Partial<TileMetadata>;

export type TileWithBuffer = TileWithMetadata & { buffer: Buffer };

export interface MapSplitResult {
  splittedTiles: TileWithBuffer[];
  blankTiles: TileWithMetadata[];
  outOfBoundsCount: number;
  isMetatileBlank: boolean;
}

export type MapProviderType = 'wms' | 'arcgis';

export type WmsVersion = '1.1.1' | '1.3.0';
