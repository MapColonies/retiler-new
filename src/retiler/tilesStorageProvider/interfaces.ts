import { vectorRetilerV2Type } from '@map-colonies/schemas';

export interface TileStoragLayout {
  format: string;
  shouldFlipY: boolean;
}

export type StorageProviderConfig = vectorRetilerV2Type['app']['tilesStorage']['providers'][number];
